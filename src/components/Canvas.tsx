import {
  useRef,
  useEffect,
  useLayoutEffect,
  useState,
  useCallback,
  useMemo,
} from "react";
import type {
  TimelineObject,
  InteractionMode,
  ProjectAction,
  ArrowData,
  FreehandData,
  CameraZoom,
  TextData,
  VideoEffect,
} from "../types";
import { useCanvasRenderer } from "../hooks/useCanvasRenderer";
import type { EditorOptions } from "../lib/renderer";
import { resolveEffects } from "../lib/effects";
import { segmentControlPoint, fitText } from "../lib/annotations";
import {
  resolvePose,
  editPose,
  activeKeyframeIndex,
  keyframeColor,
} from "../lib/keyframes";
import {
  resolveCamera,
  cameraFrameRect,
  isIdentityCamera,
  governingZoomAt,
  zoomTargetPoseAt,
  editZoomPose,
  activeZoomKeyframeIndex,
  zoomHoldTime,
} from "../lib/camera";
import {
  IconViewfinder,
  IconPlayerPlay,
  IconMinus,
  IconPlus,
} from "@tabler/icons-react";
import { ContextToolbar, ZoomContextToolbar } from "./ContextToolbar";

const ARROW_MAX_POINTS = 10;
const ZOOM_ACCENT = "#f59e0b"; // amber — matches the zoom panel header

// Editor viewport zoom/pan (spec 16 C). Editor-only magnification of the canvas viewer —
// NOT the camera zoom (spec 13, exported), NOT object resize. 100% (scale 1) = fit-to-window.
type ViewportState = { scale: number; panX: number; panY: number };
const IDENTITY_VIEWPORT: ViewportState = { scale: 1, panX: 0, panY: 0 };
const MIN_ZOOM = 0.25;
const MAX_ZOOM = 4;
// Wheel-zoom sensitivity: factor = exp(-deltaY_px * this). Proportional to actual scroll distance so
// laptop trackpads (many tiny deltas) aren't unusably fast; a mouse notch (~100px) ≈ a ~13% step.
const WHEEL_ZOOM_SENSITIVITY = 0.0012;
const BUTTON_ZOOM_FACTOR = 1.2;

// Clamp a pan offset (px, top-left origin) so the transformed canvas keeps covering the fit box
// when zoomed in, and stays inside it when zoomed out — no runaway empty margins.
function clampPan(pan: number, layerSize: number, boxSize: number): number {
  if (layerSize >= boxSize)
    return Math.max(boxSize - layerSize, Math.min(0, pan));
  return Math.max(0, Math.min(boxSize - layerSize, pan));
}

// === Types ===

type HandleId = "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w";
type ZoomCorner = "nw" | "ne" | "se" | "sw";

type DragState =
  | null
  | {
      kind: "move";
      objectId: string;
      startNx: number;
      startNy: number;
      origX: number;
      origY: number;
    }
  | {
      kind: "resize";
      objectId: string;
      handle: HandleId;
      startNx: number;
      startNy: number;
      origX: number;
      origY: number;
      origW: number;
      origH: number;
      rotation: number;
    }
  | {
      kind: "rotate";
      objectId: string;
      centerNx: number;
      centerNy: number;
      startAngle: number;
      origRotation: number;
    }
  | {
      kind: "draw-freehand";
      objectId: string;
    }
  | {
      // Camera-zoom framing rectangle move: shifts the focal point (spec 13).
      kind: "zoom-move";
      zoomId: string;
      startNx: number;
      startNy: number;
      origX: number;
      origY: number;
      scale: number;
    }
  | {
      // Camera-zoom framing rectangle resize: changes scale about the fixed focal point.
      kind: "zoom-resize";
      zoomId: string;
      cx: number;
      cy: number;
    };

type CanvasProps = {
  objects: TimelineObject[];
  globalTime: number;
  isPlaying: boolean;
  width: number;
  height: number;
  selectedObjectId: string | null;
  interactionMode: InteractionMode;
  dispatch: React.Dispatch<ProjectAction>;
  onFinishArrow?: () => void;
  // Camera zooms (spec 13)
  zooms?: CameraZoom[];
  selectedZoomId: string | null;
  onSelectZoom: (id: string | null) => void;
  cameraView: "frame" | "live";
  onToggleCameraView: () => void;
  // Video effects (spec 23) — colour/overlay post-process; applied in BOTH Frame and Live view.
  effects?: VideoEffect[];
  // Floating context toolbar (spec 17 P): "Edit points" for arrow/freehand routes through this.
  onToggleDraw?: () => void;
  // Duplicate routes through App (not a raw dispatch) so the copy lands at the playhead + is selected.
  onDuplicate?: (objectId: string) => void;
};

// === Constants ===

const HANDLE_SIZE = 10; // canvas pixels
const ROTATION_HANDLE_DISTANCE = 30; // canvas pixels
const HANDLE_HIT_RADIUS = 14; // canvas pixels, generous for easy clicking
const MIN_SIZE = 0.01; // minimum object size in normalized coords
const MIN_ZOOM_SCALE = 1; // full frame (spec 13: scale >= 1 only)
const MAX_ZOOM_SCALE = 20; // sanity cap for on-canvas resize

// Overlay bleed & move clamp (spec 18-qol): objects can be dragged anywhere in the surrounding grey
// viewport (e.g. to "start off screen") but not past it. Both the overlay's paint area and the drag
// clamp are DYNAMIC — measured each layout from the real grey extent on each side of the frame (see
// EditorBounds / the measuring layout effect) — so they always agree: the border/handles paint right
// up to the grey edge, and that same edge is where the clamp stops the box.
//
// Extra padding (px) baked into the overlay bleed beyond the raw grey extent so the handles/rotation
// handle — which sit a few px *outside* the bbox — still paint fully when a clip is parked against the
// grey edge. Only the overlay grows by this; the clamp uses the raw grey extent.
const HANDLE_BLEED_PX = 44;
// A small floor so a frame that fully fills its axis (no grey) still gives a little off-frame room.
const MIN_MARGIN = 0.06;

// Per-side normalized margins the object bbox may extend past the frame (= the measured grey extent),
// plus the symmetric overlay bleed per axis (max side + handle pad) that must cover them.
type EditorBounds = {
  marginL: number;
  marginR: number;
  marginT: number;
  marginB: number;
  bleedX: number;
  bleedY: number;
};
const INITIAL_BOUNDS: EditorBounds = {
  marginL: 0.4,
  marginR: 0.4,
  marginT: 0.4,
  marginB: 0.4,
  bleedX: 0.45,
  bleedY: 0.45,
};

// Clamp an object's top-left (normalized) so its bbox stays within the grey viewport (frame ± the
// per-side margins). Boxes larger than the region can't fit — for those the min/max invert and the
// clamp instead keeps the box fully covering the region (pan, no gap beyond the grey).
function clampObjectPos(
  x: number,
  y: number,
  w: number,
  h: number,
  b: EditorBounds,
): { x: number; y: number } {
  const minX = -b.marginL,
    maxX = 1 + b.marginR - w;
  const minY = -b.marginT,
    maxY = 1 + b.marginB - h;
  const loX = Math.min(minX, maxX),
    hiX = Math.max(minX, maxX);
  const loY = Math.min(minY, maxY),
    hiY = Math.max(minY, maxY);
  return {
    x: Math.min(Math.max(x, loX), hiX),
    y: Math.min(Math.max(y, loY), hiY),
  };
}

// === Coordinate Helpers ===

function clientToNorm(
  e: MouseEvent | React.MouseEvent,
  canvas: HTMLCanvasElement,
): { nx: number; ny: number } {
  const rect = canvas.getBoundingClientRect();
  return {
    nx: (e.clientX - rect.left) / rect.width,
    ny: (e.clientY - rect.top) / rect.height,
  };
}

/**
 * Rotate a normalized point about a normalized center, performing the rotation
 * in *pixel* space. Objects are drawn with a pixel-space rotation (see
 * renderer.ts / drawOverlay), and rotation does not commute with the non-uniform
 * normalized→pixel scaling on a non-square canvas — so hit-testing must rotate
 * in pixel space too, otherwise the hit-regions drift from the drawn shape.
 */
function rotatePointAspect(
  px: number,
  py: number,
  cx: number,
  cy: number,
  angle: number,
  canvasW: number,
  canvasH: number,
): { x: number; y: number } {
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const dxPx = (px - cx) * canvasW;
  const dyPx = (py - cy) * canvasH;
  const rxPx = dxPx * cos - dyPx * sin;
  const ryPx = dxPx * sin + dyPx * cos;
  return { x: cx + rxPx / canvasW, y: cy + ryPx / canvasH };
}

/** Transform a point into object-local space (undo rotation around object center) */
function normToObjectLocal(
  nx: number,
  ny: number,
  obj: TimelineObject,
  canvasW: number,
  canvasH: number,
): { lx: number; ly: number } {
  const cx = obj.x + obj.width / 2;
  const cy = obj.y + obj.height / 2;
  const p = rotatePointAspect(nx, ny, cx, cy, -obj.rotation, canvasW, canvasH);
  return { lx: p.x, ly: p.y };
}

/** Convert normalized canvas coords to object-local 0–1 coords (within the bbox) */
function normToObjectBbox(
  nx: number,
  ny: number,
  obj: TimelineObject,
  canvasW: number,
  canvasH: number,
): { bx: number; by: number } {
  const { lx, ly } = normToObjectLocal(nx, ny, obj, canvasW, canvasH);
  return {
    bx: obj.width !== 0 ? (lx - obj.x) / obj.width : 0,
    by: obj.height !== 0 ? (ly - obj.y) / obj.height : 0,
  };
}

// === Hit Testing ===

function hitTestObject(
  nx: number,
  ny: number,
  obj: TimelineObject,
  canvasW: number,
  canvasH: number,
): boolean {
  const { lx, ly } = normToObjectLocal(nx, ny, obj, canvasW, canvasH);
  return (
    lx >= obj.x &&
    lx <= obj.x + obj.width &&
    ly >= obj.y &&
    ly <= obj.y + obj.height
  );
}

function hitTestHandles(
  nx: number,
  ny: number,
  obj: TimelineObject,
  canvasW: number,
  canvasH: number,
): HandleId | "rotate" | null {
  const { lx, ly } = normToObjectLocal(nx, ny, obj, canvasW, canvasH);

  // Hit radius in normalized coords
  const hrx = HANDLE_HIT_RADIUS / canvasW;
  const hry = HANDLE_HIT_RADIUS / canvasH;

  // Check rotation handle first (above top-center)
  const rotX = obj.x + obj.width / 2;
  const rotY = obj.y - ROTATION_HANDLE_DISTANCE / canvasH;
  if (Math.abs(lx - rotX) < hrx && Math.abs(ly - rotY) < hry) {
    return "rotate";
  }

  // Resize handles
  const handles: [HandleId, number, number][] = [
    ["nw", obj.x, obj.y],
    ["n", obj.x + obj.width / 2, obj.y],
    ["ne", obj.x + obj.width, obj.y],
    ["e", obj.x + obj.width, obj.y + obj.height / 2],
    ["se", obj.x + obj.width, obj.y + obj.height],
    ["s", obj.x + obj.width / 2, obj.y + obj.height],
    ["sw", obj.x, obj.y + obj.height],
    ["w", obj.x, obj.y + obj.height / 2],
  ];

  for (const [id, hx, hy] of handles) {
    if (Math.abs(lx - hx) < hrx && Math.abs(ly - hy) < hry) {
      return id;
    }
  }

  return null;
}

// === Resize Math ===

function computeResize(
  handle: HandleId,
  mouseNx: number,
  mouseNy: number,
  startNx: number,
  startNy: number,
  orig: { x: number; y: number; w: number; h: number; rotation: number },
  canvasW: number,
  canvasH: number,
): { x: number; y: number; width: number; height: number } {
  const cos = Math.cos(orig.rotation);
  const sin = Math.sin(orig.rotation);

  // Project mouse delta onto the object's local axes, in *pixel* space (the
  // object is rotated in pixel space), then convert the local deltas back to
  // normalized width/height changes. On a non-square canvas this differs from a
  // plain normalized-space projection by the aspect factors below.
  const dxPx = (mouseNx - startNx) * canvasW;
  const dyPx = (mouseNy - startNy) * canvasH;
  const localDx = (dxPx * cos + dyPx * sin) / canvasW;
  const localDy = (-dxPx * sin + dyPx * cos) / canvasH;

  let nx = orig.x,
    ny = orig.y,
    nw = orig.w,
    nh = orig.h;

  const hasW = handle === "w" || handle === "nw" || handle === "sw";
  const hasE = handle === "e" || handle === "ne" || handle === "se";
  const hasN = handle === "n" || handle === "nw" || handle === "ne";
  const hasS = handle === "s" || handle === "sw" || handle === "se";

  if (hasW) {
    nx += localDx;
    nw -= localDx;
  }
  if (hasE) {
    nw += localDx;
  }
  if (hasN) {
    ny += localDy;
    nh -= localDy;
  }
  if (hasS) {
    nh += localDy;
  }

  // Enforce minimum size
  if (nw < MIN_SIZE) {
    if (hasW) nx -= MIN_SIZE - nw;
    nw = MIN_SIZE;
  }
  if (nh < MIN_SIZE) {
    if (hasN) ny -= MIN_SIZE - nh;
    nh = MIN_SIZE;
  }

  // Fix anchor point: rotation is around center, so changing the box
  // shifts the center, which moves the anchor corner in world space.
  // Compute correction to keep the anchor's world position fixed.
  const oldCx = orig.x + orig.w / 2;
  const oldCy = orig.y + orig.h / 2;
  const newCx = nx + nw / 2;
  const newCy = ny + nh / 2;

  // Anchor corner position (same in both old and new local frame)
  let anchorX: number, anchorY: number;
  if (handle === "se") {
    anchorX = nx;
    anchorY = ny;
  } else if (handle === "nw") {
    anchorX = nx + nw;
    anchorY = ny + nh;
  } else if (handle === "ne") {
    anchorX = nx;
    anchorY = ny + nh;
  } else if (handle === "sw") {
    anchorX = nx + nw;
    anchorY = ny;
  } else if (handle === "n") {
    anchorX = nx + nw / 2;
    anchorY = ny + nh;
  } else if (handle === "s") {
    anchorX = nx + nw / 2;
    anchorY = ny;
  } else if (handle === "e") {
    anchorX = nx;
    anchorY = ny + nh / 2;
  } else {
    // 'w'
    anchorX = nx + nw;
    anchorY = ny + nh / 2;
  }

  const anchorOldWorld = rotatePointAspect(
    anchorX,
    anchorY,
    oldCx,
    oldCy,
    orig.rotation,
    canvasW,
    canvasH,
  );
  const anchorNewWorld = rotatePointAspect(
    anchorX,
    anchorY,
    newCx,
    newCy,
    orig.rotation,
    canvasW,
    canvasH,
  );

  nx += anchorOldWorld.x - anchorNewWorld.x;
  ny += anchorOldWorld.y - anchorNewWorld.y;

  return { x: nx, y: ny, width: nw, height: nh };
}

// === Cursor Helpers ===

function getHandleCursor(
  handle: HandleId | "rotate",
  rotation: number,
): string {
  if (handle === "rotate") return "crosshair";

  const baseAngles: Record<HandleId, number> = {
    n: 0,
    ne: 45,
    e: 90,
    se: 135,
    s: 180,
    sw: 225,
    w: 270,
    nw: 315,
  };

  const adjusted =
    (((baseAngles[handle] + (rotation * 180) / Math.PI) % 360) + 360) % 360;

  if (adjusted < 22.5 || adjusted >= 337.5) return "ns-resize";
  if (adjusted < 67.5) return "nesw-resize";
  if (adjusted < 112.5) return "ew-resize";
  if (adjusted < 157.5) return "nwse-resize";
  if (adjusted < 202.5) return "ns-resize";
  if (adjusted < 247.5) return "nesw-resize";
  if (adjusted < 292.5) return "ew-resize";
  return "nwse-resize";
}

// === Camera-zoom framing rect (spec 13) ===
// The framing rect is axis-aligned (no rotation) and always keeps the canvas aspect ratio
// (w = h = 1/scale in normalized coords), so its editing math is much simpler than an object's.

/** Clamp a focal point so the framing rect stays fully inside the canvas [0,1]. */
function clampFocal(
  x: number,
  y: number,
  scale: number,
): { x: number; y: number } {
  const half = 0.5 / scale;
  return {
    x: Math.min(Math.max(x, half), 1 - half),
    y: Math.min(Math.max(y, half), 1 - half),
  };
}

/** Which corner handle (if any) of a normalized framing rect is under the cursor. */
function hitTestZoomHandle(
  nx: number,
  ny: number,
  rect: { x: number; y: number; w: number; h: number },
  canvasW: number,
  canvasH: number,
): ZoomCorner | null {
  const hrx = HANDLE_HIT_RADIUS / canvasW;
  const hry = HANDLE_HIT_RADIUS / canvasH;
  const corners: [ZoomCorner, number, number][] = [
    ["nw", rect.x, rect.y],
    ["ne", rect.x + rect.w, rect.y],
    ["se", rect.x + rect.w, rect.y + rect.h],
    ["sw", rect.x, rect.y + rect.h],
  ];
  for (const [id, hx, hy] of corners) {
    if (Math.abs(nx - hx) < hrx && Math.abs(ny - hy) < hry) return id;
  }
  return null;
}

/** Is the cursor inside the framing rect body (normalized coords)? */
function hitTestZoomBody(
  nx: number,
  ny: number,
  rect: { x: number; y: number; w: number; h: number },
): boolean {
  return (
    nx >= rect.x &&
    nx <= rect.x + rect.w &&
    ny >= rect.y &&
    ny <= rect.y + rect.h
  );
}

/** New scale from a corner drag, keeping the focal point (center) fixed. */
function scaleFromCornerDrag(
  nx: number,
  ny: number,
  cx: number,
  cy: number,
): number {
  const half = Math.max(Math.abs(nx - cx), Math.abs(ny - cy));
  const scale = half > 1e-4 ? 0.5 / half : MAX_ZOOM_SCALE;
  return Math.min(Math.max(scale, MIN_ZOOM_SCALE), MAX_ZOOM_SCALE);
}

// === Component ===

export default function Canvas({
  objects,
  globalTime,
  isPlaying,
  width,
  height,
  selectedObjectId,
  interactionMode,
  dispatch,
  onFinishArrow,
  zooms,
  selectedZoomId,
  onSelectZoom,
  cameraView,
  onToggleCameraView,
  effects,
  onToggleDraw,
  onDuplicate,
}: CanvasProps) {
  const renderCanvasRef = useRef<HTMLCanvasElement>(null);
  const overlayCanvasRef = useRef<HTMLCanvasElement>(null);
  const [dragState, setDragState] = useState<DragState>(null);
  const [cursor, setCursor] = useState("default");
  const dragStateRef = useRef<DragState>(null);
  const mouseNormRef = useRef<{ nx: number; ny: number } | null>(null);
  const [tooltipPos, setTooltipPos] = useState<{ x: number; y: number } | null>(
    null,
  );

  // Dynamic overlay bleed + move clamp (spec 18-qol): measured from the real grey viewport each layout
  // so objects can be staged anywhere in the grey but not past it, with handles always painted. A ref
  // mirror lets the window-level drag listener read the latest bounds without re-subscribing.
  const [bounds, setBounds] = useState<EditorBounds>(INITIAL_BOUNDS);
  const boundsRef = useRef(bounds);
  boundsRef.current = bounds;

  // In-place text editing (spec 18-qol R6): double-click a selected text object to edit its content
  // on the canvas. Ephemeral view state. `editValue` is the live text; the edited object is hidden
  // from the render (renderObjects) so the textarea is the only visible copy (no double image).
  const [editingTextId, setEditingTextId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");
  const [editRect, setEditRect] = useState<{
    left: number;
    top: number;
    width: number;
    height: number;
  } | null>(null);
  const editOriginalRef = useRef("");
  const measureCtxRef = useRef<CanvasRenderingContext2D | null>(null); // offscreen 2D ctx for auto-size fit

  // Editor viewport zoom/pan (spec 16 C). Ephemeral view state — resets to Fit on aspect change.
  const [viewport, setViewport] = useState<ViewportState>(IDENTITY_VIEWPORT);
  const viewportRef = useRef(viewport);
  viewportRef.current = viewport;
  const fitBoxRef = useRef<HTMLDivElement>(null); // the letterboxed fit box (stable under transform)
  const renderAreaRef = useRef<HTMLDivElement>(null); // the whole render area (wheel target)
  const panRef = useRef<{
    startX: number;
    startY: number;
    panX0: number;
    panY0: number;
  } | null>(null);

  // Zoom by `factor` about a fit-box-local point (cx,cy); defaults to the fit box center.
  const zoomAt = useCallback((factor: number, cx?: number, cy?: number) => {
    const fit = fitBoxRef.current?.getBoundingClientRect();
    if (!fit) return;
    const fx = cx ?? fit.width / 2;
    const fy = cy ?? fit.height / 2;
    setViewport((v) => {
      const sNew = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, v.scale * factor));
      const k = sNew / v.scale;
      const panX = clampPan(
        fx - (fx - v.panX) * k,
        fit.width * sNew,
        fit.width,
      );
      const panY = clampPan(
        fy - (fy - v.panY) * k,
        fit.height * sNew,
        fit.height,
      );
      return { scale: sNew, panX, panY };
    });
  }, []);

  const resetViewport = useCallback(() => setViewport(IDENTITY_VIEWPORT), []);

  // Reset to Fit when the project aspect ratio changes (spec 16 C8) — stale offsets otherwise.
  useEffect(() => {
    setViewport(IDENTITY_VIEWPORT);
  }, [width, height]);

  // Plain mouse-wheel over the render area = zoom to cursor (spec 16 C2). Native non-passive
  // listener so preventDefault reliably stops page/scroll; React onWheel can be passive.
  useEffect(() => {
    const el = renderAreaRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const fit = fitBoxRef.current?.getBoundingClientRect();
      if (!fit) return;
      const unit =
        e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? el.clientHeight : 1;
      const factor = Math.min(
        1.25,
        Math.max(0.8, Math.exp(-e.deltaY * unit * WHEEL_ZOOM_SENSITIVITY)),
      );
      zoomAt(factor, e.clientX - fit.left, e.clientY - fit.top);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [zoomAt]);

  // Pan via middle-mouse drag (spec 16 C3). Started in handleMouseDown; tracked on window.
  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      const p = panRef.current;
      if (!p) return;
      const fit = fitBoxRef.current?.getBoundingClientRect();
      if (!fit) return;
      setViewport((v) => ({
        scale: v.scale,
        panX: clampPan(
          p.panX0 + (e.clientX - p.startX),
          fit.width * v.scale,
          fit.width,
        ),
        panY: clampPan(
          p.panY0 + (e.clientY - p.startY),
          fit.height * v.scale,
          fit.height,
        ),
      }));
    };
    const onUp = () => {
      if (panRef.current) {
        panRef.current = null;
        setCursor("default");
      }
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, []);

  const isLive = cameraView === "live";
  const selectedZoom = zooms?.find((z) => z.id === selectedZoomId) ?? null;

  // Live view applies the real camera transform (WYSIWYG == export); Frame view renders un-zoomed
  // (identity) so the whole scene stays visible + editable. Recomputed each render so it tracks the
  // playhead while playing (spec 13 R6).
  const liveCamera = useMemo(
    () => (isLive ? resolveCamera(zooms, globalTime) : undefined),
    [isLive, zooms, globalTime],
  );

  const activeDrawingObjectId =
    dragState?.kind === "draw-freehand" ? dragState.objectId : null;
  // Video effects (spec 23): resolved in BOTH views (unlike the camera) — they don't move geometry,
  // so they can't block object editing, and you want to see the colour/vignette look while authoring.
  const resolvedEffects = useMemo(
    () => resolveEffects(effects, globalTime),
    [effects, globalTime],
  );
  const editorOpts = useMemo<EditorOptions>(
    () => ({
      editorMode: !isLive, // Live view = WYSIWYG, no editor ghosts
      activeDrawingObjectId,
      camera: liveCamera,
      effects: resolvedEffects,
    }),
    [isLive, activeDrawingObjectId, liveCamera, resolvedEffects],
  );
  // Hide the text object being edited so only the textarea shows it (spec 18-qol R6 — no double image).
  const renderObjects = useMemo(
    () =>
      editingTextId ? objects.filter((o) => o.id !== editingTextId) : objects,
    [objects, editingTextId],
  );
  useCanvasRenderer(
    renderCanvasRef,
    renderObjects,
    globalTime,
    isPlaying,
    width,
    height,
    editorOpts,
  );

  // Keep dragStateRef in sync for use in event handlers
  dragStateRef.current = dragState;

  // Size the overlay canvas's backing store. The render canvas is sized by useCanvasRenderer
  // (which also redraws on resize), so we only own the overlay here.
  useEffect(() => {
    const oc = overlayCanvasRef.current;
    if (!oc) return;
    // Enlarged by the per-axis bleed so out-of-frame chrome anywhere in the grey has somewhere to
    // paint (R1) — the bleed tracks the measured grey extent (see the measuring layout effect).
    oc.width = Math.round(width * (1 + 2 * bounds.bleedX));
    oc.height = Math.round(height * (1 + 2 * bounds.bleedY));
  }, [width, height, bounds.bleedX, bounds.bleedY]);

  const selectedObjectRaw =
    objects.find((o) => o.id === selectedObjectId) ?? null;
  // Overlay, hit-testing and drag operate on the keyframe-resolved pose, so the selection box
  // follows a keyframed object and dragging edits the rendered position (not a hidden static
  // base). Enter/exit transitions are intentionally NOT applied here, so the object stays
  // grabbable at its home position while its entrance/exit plays.
  const selectedObject = selectedObjectRaw
    ? resolvePose(selectedObjectRaw, globalTime)
    : null;

  // When the playhead is parked on a keyframe of the selected object, tint the whole selection
  // overlay with that keyframe's color (and thicken it) so it's unmistakable that edits/drags now
  // land on that keyframe. Off a keyframe (or un-keyframed), fall back to the default blue.
  const activeKfIdx = selectedObjectRaw
    ? activeKeyframeIndex(selectedObjectRaw, globalTime)
    : -1;
  const selColor = activeKfIdx >= 0 ? keyframeColor(activeKfIdx) : "#4f8ef7";
  const selWidth = activeKfIdx >= 0 ? 3 : 2;

  // In-place text editing target (spec 18-qol R6): raw object + keyframe-resolved pose for positioning.
  const editingObjectRaw = editingTextId
    ? (objects.find((o) => o.id === editingTextId) ?? null)
    : null;
  const editingObject = editingObjectRaw
    ? resolvePose(editingObjectRaw, globalTime)
    : null;

  // Commit the in-place edit as ONE undo entry (only when the content actually changed), then exit
  // edit mode. Called on blur / Escape / ⌘|Ctrl+Enter.
  const commitTextEdit = useCallback(() => {
    const id = editingTextId;
    if (id) {
      const obj = objects.find((o) => o.id === id);
      if (obj && obj.type === "text" && editValue !== editOriginalRef.current) {
        dispatch({
          type: "UPDATE_OBJECT",
          objectId: id,
          updates: { data: { ...(obj.data as TextData), content: editValue } },
        });
      }
    }
    setEditingTextId(null);
  }, [editingTextId, objects, editValue, dispatch]);

  // --- Draw overlay ---
  const drawOverlay = useCallback(() => {
    const canvas = overlayCanvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    // The overlay backing store extends BLEED×frame beyond each edge (R1). Clear the whole store,
    // then translate the drawing origin to the frame's top-left so every frame-px drawing below
    // (border, scrim, selection box, handles) is byte-for-byte unchanged and simply lands in the
    // right place — with out-of-frame handles now inside the enlarged store instead of clipped.
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.setTransform(1, 0, 0, 1, bounds.bleedX * width, bounds.bleedY * height);

    // Canvas border
    ctx.strokeStyle = "rgba(255, 255, 255, 0.15)";
    ctx.lineWidth = 2;
    ctx.strokeRect(1, 1, width - 2, height - 2);

    // Live view is playback/confirmation only (R6): the render canvas already shows the real
    // transform, and editing handles are hidden. So draw no authoring chrome.
    if (isLive) return;

    // --- Camera framing overlay (spec 13, Frame view) ---
    // A selected zoom shows its editable target rect (with handles); otherwise the resolved
    // camera at the playhead is shown read-only and animates as the playhead moves.
    {
      const framedPose = selectedZoom
        ? zoomTargetPoseAt(selectedZoom, globalTime)
        : resolveCamera(zooms, globalTime);
      // When parked on one of the selected zoom's keyframes, tint the whole framing overlay with
      // that keyframe's color (matching the panel pips + timeline diamonds), else amber.
      const zkfIdx = selectedZoom
        ? activeZoomKeyframeIndex(selectedZoom, globalTime)
        : -1;
      const zoomAccent = zkfIdx >= 0 ? keyframeColor(zkfIdx) : ZOOM_ACCENT;
      if (selectedZoom != null || !isIdentityCamera(framedPose)) {
        const r = cameraFrameRect(framedPose);
        const rx = r.x * width,
          ry = r.y * height,
          rw = r.w * width,
          rh = r.h * height;

        // Grey scrim over everything, punched out at the framed region.
        ctx.save();
        ctx.fillStyle = "rgba(0, 0, 0, 0.5)";
        ctx.fillRect(0, 0, width, height);
        ctx.clearRect(rx, ry, rw, rh);
        ctx.restore();

        // Framing rectangle border (solid + handles when selected, dashed preview otherwise).
        ctx.strokeStyle = zoomAccent;
        ctx.lineWidth = selectedZoom ? 3 : 2;
        ctx.setLineDash(selectedZoom ? [] : [8, 5]);
        ctx.strokeRect(rx, ry, rw, rh);
        ctx.setLineDash([]);

        if (selectedZoom) {
          const hs = HANDLE_SIZE;
          const corners: [number, number][] = [
            [rx, ry],
            [rx + rw, ry],
            [rx + rw, ry + rh],
            [rx, ry + rh],
          ];
          for (const [hx, hy] of corners) {
            ctx.fillStyle = "#ffffff";
            ctx.strokeStyle = zoomAccent;
            ctx.lineWidth = 1.5;
            ctx.fillRect(hx - hs / 2, hy - hs / 2, hs, hs);
            ctx.strokeRect(hx - hs / 2, hy - hs / 2, hs, hs);
          }
          // Amount label tab — shows the keyframe number when on one, plus the live scale.
          const label =
            (zkfIdx >= 0 ? `◆ ${zkfIdx + 1}   ` : "") +
            `⛶ ${framedPose.scale.toFixed(1)}×`;
          ctx.font = "bold 13px sans-serif";
          const tabW = ctx.measureText(label).width + 12;
          const tabH = 18;
          ctx.fillStyle = zoomAccent;
          ctx.fillRect(rx, ry - tabH, tabW, tabH);
          ctx.fillStyle = "#ffffff";
          ctx.textBaseline = "middle";
          ctx.textAlign = "left";
          ctx.fillText(label, rx + 6, ry - tabH / 2 + 1);
        }
      }
    }

    if (!selectedObject) return;

    // --- Arrow draw mode overlay: vertex dots + rubber band ---
    if (interactionMode === "draw" && selectedObject.type === "arrow") {
      const obj = selectedObject;
      const data = obj.data as ArrowData;
      const bx = obj.x * width;
      const by = obj.y * height;
      const bw = obj.width * width;
      const bh = obj.height * height;

      ctx.save();
      if (obj.rotation !== 0) {
        const ccx = bx + bw / 2;
        const ccy = by + bh / 2;
        ctx.translate(ccx, ccy);
        ctx.rotate(obj.rotation);
        ctx.translate(-ccx, -ccy);
      }

      const pixelPoints = data.points.map((p) => ({
        x: bx + p.x * bw,
        y: by + p.y * bh,
      }));

      // Draw vertex dots
      for (const pt of pixelPoints) {
        ctx.beginPath();
        ctx.arc(pt.x, pt.y, 5, 0, Math.PI * 2);
        ctx.fillStyle = obj.style.color;
        ctx.fill();
        ctx.strokeStyle = "#ffffff";
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }

      // Rubber band preview line from last point to cursor
      const mouse = mouseNormRef.current;
      if (pixelPoints.length > 0 && mouse) {
        const last = pixelPoints[pixelPoints.length - 1];
        const cursorX = mouse.nx * width;
        const cursorY = mouse.ny * height;

        ctx.setLineDash([6, 4]);
        ctx.strokeStyle = obj.style.color;
        ctx.lineWidth = 2;
        ctx.globalAlpha = 0.7;

        const curvature = data.curvature ?? 0;
        ctx.beginPath();
        ctx.moveTo(last.x, last.y);
        if (curvature !== 0) {
          const cp = segmentControlPoint(
            last.x,
            last.y,
            cursorX,
            cursorY,
            curvature,
          );
          ctx.quadraticCurveTo(cp.x, cp.y, cursorX, cursorY);
        } else {
          ctx.lineTo(cursorX, cursorY);
        }
        ctx.stroke();

        ctx.setLineDash([]);
        ctx.globalAlpha = 1;
      }

      ctx.restore();
      return;
    }

    if (interactionMode !== "move") return;

    const obj = selectedObject;
    const bx = obj.x * width;
    const by = obj.y * height;
    const bw = obj.width * width;
    const bh = obj.height * height;
    const cx = bx + bw / 2;
    const cy = by + bh / 2;

    ctx.save();

    if (obj.rotation !== 0) {
      ctx.translate(cx, cy);
      ctx.rotate(obj.rotation);
      ctx.translate(-cx, -cy);
    }

    // Bounding box
    ctx.strokeStyle = selColor;
    ctx.lineWidth = selWidth;
    ctx.setLineDash([]);
    ctx.strokeRect(bx, by, bw, bh);

    // Keyframe badge: when parked on a keyframe, draw a filled tab in that keyframe's color so
    // it's unmistakable which keyframe is being edited.
    if (activeKfIdx >= 0) {
      const label = `◆ ${activeKfIdx + 1}`;
      ctx.font = "bold 13px sans-serif";
      const tabW = ctx.measureText(label).width + 12;
      const tabH = 18;
      ctx.fillStyle = selColor;
      ctx.fillRect(bx, by - tabH, tabW, tabH);
      ctx.fillStyle = "#ffffff";
      ctx.textBaseline = "middle";
      ctx.textAlign = "left";
      ctx.fillText(label, bx + 6, by - tabH / 2 + 1);
    }

    // Resize handles
    const hs = HANDLE_SIZE;
    const handlePositions = [
      { x: bx, y: by },
      { x: bx + bw / 2, y: by },
      { x: bx + bw, y: by },
      { x: bx + bw, y: by + bh / 2 },
      { x: bx + bw, y: by + bh },
      { x: bx + bw / 2, y: by + bh },
      { x: bx, y: by + bh },
      { x: bx, y: by + bh / 2 },
    ];

    for (const h of handlePositions) {
      ctx.fillStyle = "#ffffff";
      ctx.strokeStyle = selColor;
      ctx.lineWidth = 1.5;
      ctx.fillRect(h.x - hs / 2, h.y - hs / 2, hs, hs);
      ctx.strokeRect(h.x - hs / 2, h.y - hs / 2, hs, hs);
    }

    // Rotation handle: line from top-center to handle circle
    const rotY = by - ROTATION_HANDLE_DISTANCE;
    ctx.beginPath();
    ctx.moveTo(bx + bw / 2, by);
    ctx.lineTo(bx + bw / 2, rotY);
    ctx.strokeStyle = selColor;
    ctx.lineWidth = 1.5;
    ctx.stroke();

    ctx.beginPath();
    ctx.arc(bx + bw / 2, rotY, 6, 0, Math.PI * 2);
    ctx.fillStyle = "#ffffff";
    ctx.fill();
    ctx.strokeStyle = selColor;
    ctx.lineWidth = 1.5;
    ctx.stroke();

    // Small rotation icon inside the circle
    ctx.beginPath();
    ctx.arc(bx + bw / 2, rotY, 3, -Math.PI * 0.7, Math.PI * 0.5);
    ctx.strokeStyle = selColor;
    ctx.lineWidth = 1;
    ctx.stroke();

    ctx.restore();
  }, [
    selectedObject,
    interactionMode,
    width,
    height,
    selColor,
    selWidth,
    activeKfIdx,
    isLive,
    zooms,
    selectedZoom,
    globalTime,
    bounds.bleedX,
    bounds.bleedY,
  ]);

  useEffect(() => {
    drawOverlay();
  }, [drawOverlay]);

  // --- Mouse handlers ---

  // Helper to add a point to the current arrow
  const addArrowPoint = useCallback(
    (nx: number, ny: number) => {
      if (!selectedObject || selectedObject.type !== "arrow") return false;
      const data = selectedObject.data as ArrowData;
      if (data.points.length >= ARROW_MAX_POINTS) return false;
      const { bx, by } = normToObjectBbox(
        nx,
        ny,
        selectedObject,
        width,
        height,
      );
      const newPoints = [...data.points, { x: bx, y: by }];
      dispatch({
        type: "UPDATE_OBJECT",
        objectId: selectedObject.id,
        updates: { data: { ...data, points: newPoints } },
      });
      // Auto-finish at max points
      if (newPoints.length >= ARROW_MAX_POINTS) {
        onFinishArrow?.();
      }
      return true;
    },
    [selectedObject, dispatch, onFinishArrow, width, height],
  );

  // Apply an in-progress zoom framing-rect drag (move or resize) as a transient update. Routes
  // through editZoomPose so the edit lands correctly: on a keyframe → reshape it; keyframed and
  // mid-hold → drop a keyframe at the playhead; at hold-start / un-keyframed → move the base pose.
  // Reads the LIVE zoom (from props) so a keyframe created on the first move is updated in place on
  // subsequent moves (the same trick object drags use with the live `objects`).
  const applyZoomDrag = useCallback(
    (ds: DragState, nx: number, ny: number) => {
      if (!ds || (ds.kind !== "zoom-move" && ds.kind !== "zoom-resize")) return;
      const z = zooms?.find((zz) => zz.id === ds.zoomId);
      if (!z) return;
      const tHold = Math.max(0, Math.min(z.hold, zoomHoldTime(z, globalTime)));
      if (ds.kind === "zoom-move") {
        const focal = clampFocal(
          ds.origX + (nx - ds.startNx),
          ds.origY + (ny - ds.startNy),
          ds.scale,
        );
        dispatch({
          type: "UPDATE_ZOOM_TRANSIENT",
          zoomId: ds.zoomId,
          updates: editZoomPose(z, { x: focal.x, y: focal.y }, tHold),
        });
      } else {
        const scale = scaleFromCornerDrag(nx, ny, ds.cx, ds.cy);
        const focal = clampFocal(ds.cx, ds.cy, scale);
        dispatch({
          type: "UPDATE_ZOOM_TRANSIENT",
          zoomId: ds.zoomId,
          updates: editZoomPose(z, { scale, x: focal.x, y: focal.y }, tHold),
        });
      }
    },
    [dispatch, zooms, globalTime],
  );

  const handleMouseDown = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      const canvas = overlayCanvasRef.current;
      if (!canvas) return;

      // While editing text in place, the textarea owns input; a click elsewhere commits via its blur.
      if (editingTextId) return;

      // Middle-mouse drag = pan the editor viewport (spec 16 C3). Works in any mode/view.
      if (e.button === 1) {
        e.preventDefault();
        const v = viewportRef.current;
        panRef.current = {
          startX: e.clientX,
          startY: e.clientY,
          panX0: v.panX,
          panY0: v.panY,
        };
        setCursor("grabbing");
        return;
      }

      const { nx, ny } = clientToNorm(e, renderCanvasRef.current ?? canvas);

      // --- Camera zoom editing (Frame view only; Live view is playback-only, R6) ---
      if (!isLive && e.button === 0) {
        if (selectedZoom) {
          // The editable rect is the target pose at the playhead (follows the keyframe path).
          const pose = zoomTargetPoseAt(selectedZoom, globalTime);
          const rect = cameraFrameRect(pose);
          const corner = hitTestZoomHandle(nx, ny, rect, width, height);
          if (corner) {
            setDragState({
              kind: "zoom-resize",
              zoomId: selectedZoom.id,
              cx: pose.x,
              cy: pose.y,
            });
            return;
          }
          if (hitTestZoomBody(nx, ny, rect)) {
            setDragState({
              kind: "zoom-move",
              zoomId: selectedZoom.id,
              startNx: nx,
              startNy: ny,
              origX: pose.x,
              origY: pose.y,
              scale: pose.scale,
            });
            return;
          }
          // Clicked outside the selected zoom's rect — keep selection (deselect via Esc/timeline).
          return;
        }
        // Nothing selected: clicking an active resolved framing rect selects its zoom. Guarded on
        // !selectedObject so this never steals a click meant for a selected object.
        if (!selectedObject) {
          const cam = resolveCamera(zooms, globalTime);
          if (
            !isIdentityCamera(cam) &&
            hitTestZoomBody(nx, ny, cameraFrameRect(cam))
          ) {
            const gz = governingZoomAt(zooms, globalTime);
            if (gz) {
              onSelectZoom(gz.id);
              return;
            }
          }
        }
      }

      if (!selectedObject) return;

      // --- Draw mode ---
      if (interactionMode === "draw") {
        const isDrawable =
          selectedObject.type === "arrow" || selectedObject.type === "freehand";
        if (!isDrawable) return;

        if (selectedObject.type === "arrow") {
          // Left click only — right-click handled by onContextMenu
          if (e.button === 0) {
            addArrowPoint(nx, ny);
          }
        } else {
          const { bx, by } = normToObjectBbox(
            nx,
            ny,
            selectedObject,
            width,
            height,
          );
          // Freehand: mousedown starts a new stroke
          const data = selectedObject.data as FreehandData;
          const newStrokes = [...data.strokes, [{ x: bx, y: by }]];
          dispatch({
            type: "UPDATE_OBJECT_TRANSIENT",
            objectId: selectedObject.id,
            updates: { data: { strokes: newStrokes } },
          });
          setDragState({ kind: "draw-freehand", objectId: selectedObject.id });
        }
        return;
      }

      if (interactionMode !== "move") return;

      // Check handles on the selected object (rotate, resize)
      const handle = hitTestHandles(nx, ny, selectedObject, width, height);

      if (handle === "rotate") {
        const centerNx = selectedObject.x + selectedObject.width / 2;
        const centerNy = selectedObject.y + selectedObject.height / 2;
        const startAngle = Math.atan2(ny - centerNy, nx - centerNx);
        setDragState({
          kind: "rotate",
          objectId: selectedObject.id,
          centerNx,
          centerNy,
          startAngle,
          origRotation: selectedObject.rotation,
        });
        return;
      }

      if (handle) {
        setDragState({
          kind: "resize",
          objectId: selectedObject.id,
          handle,
          startNx: nx,
          startNy: ny,
          origX: selectedObject.x,
          origY: selectedObject.y,
          origW: selectedObject.width,
          origH: selectedObject.height,
          rotation: selectedObject.rotation,
        });
        return;
      }

      // Hit test on the selected object body for move
      if (hitTestObject(nx, ny, selectedObject, width, height)) {
        setDragState({
          kind: "move",
          objectId: selectedObject.id,
          startNx: nx,
          startNy: ny,
          origX: selectedObject.x,
          origY: selectedObject.y,
        });
      }

      // Clicking empty space does nothing — deselect via Escape or timeline
    },
    [
      interactionMode,
      selectedObject,
      width,
      height,
      dispatch,
      isLive,
      selectedZoom,
      zooms,
      globalTime,
      onSelectZoom,
      editingTextId,
    ],
  );

  const handleMouseMove = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      const canvas = overlayCanvasRef.current;
      if (!canvas) return;
      if (panRef.current) return; // middle-mouse viewport pan owns the cursor while active

      const { nx, ny } = clientToNorm(e, renderCanvasRef.current ?? canvas);
      mouseNormRef.current = { nx, ny };

      // Update tooltip position (relative to the frame / render canvas, not the bleed-enlarged overlay).
      const rect = (renderCanvasRef.current ?? canvas).getBoundingClientRect();
      setTooltipPos({
        x: e.clientX - rect.left + 15,
        y: e.clientY - rect.top + 15,
      });

      const ds = dragStateRef.current;

      if (ds && (ds.kind === "zoom-move" || ds.kind === "zoom-resize")) {
        applyZoomDrag(ds, nx, ny);
        return;
      }

      if (ds) {
        // --- Active drag --- keyframe-aware: editPose cements a keyframe for a keyframed
        // property, otherwise edits the static base (see keyframes.ts).
        const dragObj = selectedObjectRaw;
        const t = dragObj ? globalTime - dragObj.startTime : 0;
        if (dragObj && ds.kind === "move") {
          const p = clampObjectPos(
            ds.origX + (nx - ds.startNx),
            ds.origY + (ny - ds.startNy),
            dragObj.width,
            dragObj.height,
            boundsRef.current,
          );
          dispatch({
            type: "UPDATE_OBJECT_TRANSIENT",
            objectId: ds.objectId,
            updates: editPose(dragObj, { x: p.x, y: p.y }, t),
          });
        } else if (dragObj && ds.kind === "resize") {
          const result = computeResize(
            ds.handle,
            nx,
            ny,
            ds.startNx,
            ds.startNy,
            {
              x: ds.origX,
              y: ds.origY,
              w: ds.origW,
              h: ds.origH,
              rotation: ds.rotation,
            },
            width,
            height,
          );
          dispatch({
            type: "UPDATE_OBJECT_TRANSIENT",
            objectId: ds.objectId,
            updates: editPose(dragObj, result, t),
          });
        } else if (dragObj && ds.kind === "rotate") {
          const currentAngle = Math.atan2(ny - ds.centerNy, nx - ds.centerNx);
          const newRotation = ds.origRotation + (currentAngle - ds.startAngle);
          dispatch({
            type: "UPDATE_OBJECT_TRANSIENT",
            objectId: ds.objectId,
            updates: editPose(dragObj, { rotation: newRotation }, t),
          });
        }
        // Redraw overlay for rubber band during drag in arrow draw mode
        if (interactionMode === "draw" && selectedObject?.type === "arrow") {
          drawOverlay();
        }
        return;
      }

      // --- Hover cursor feedback ---
      if (isLive) {
        setCursor("default");
        return;
      }

      // Zoom framing rect hover (Frame view, zoom selected)
      if (selectedZoom) {
        const rect = cameraFrameRect(
          zoomTargetPoseAt(selectedZoom, globalTime),
        );
        const corner = hitTestZoomHandle(nx, ny, rect, width, height);
        if (corner) {
          setCursor(
            corner === "nw" || corner === "se" ? "nwse-resize" : "nesw-resize",
          );
          return;
        }
        setCursor(hitTestZoomBody(nx, ny, rect) ? "move" : "default");
        return;
      }

      if (interactionMode === "draw") {
        setCursor("crosshair");
        // Redraw overlay for rubber band preview
        if (selectedObject?.type === "arrow") {
          drawOverlay();
        }
        return;
      }

      if (interactionMode === "move" && selectedObject) {
        const handle = hitTestHandles(nx, ny, selectedObject, width, height);
        if (handle) {
          setCursor(getHandleCursor(handle, selectedObject.rotation));
          return;
        }
        if (hitTestObject(nx, ny, selectedObject, width, height)) {
          setCursor("move");
          return;
        }
      }

      setCursor("default");
    },
    [
      interactionMode,
      selectedObject,
      selectedObjectRaw,
      width,
      height,
      dispatch,
      drawOverlay,
      globalTime,
      applyZoomDrag,
      isLive,
      selectedZoom,
    ],
  );

  const handleMouseUp = useCallback(() => {
    if (dragStateRef.current) {
      dispatch({ type: "COMMIT_TRANSIENT" });
      setDragState(null);
    }
  }, [dispatch]);

  // Listen for mouseup/mousemove on window so dragging outside canvas works
  useEffect(() => {
    if (!dragState) return;

    const onMove = (e: MouseEvent) => {
      const canvas = overlayCanvasRef.current;
      if (!canvas) return;

      const { nx, ny } = clientToNorm(e, renderCanvasRef.current ?? canvas);
      const ds = dragStateRef.current;
      if (!ds) return;

      if (ds.kind === "zoom-move" || ds.kind === "zoom-resize") {
        applyZoomDrag(ds, nx, ny);
        return;
      }

      const dragObj = objects.find((o) => o.id === ds.objectId);
      const t = dragObj ? globalTime - dragObj.startTime : 0;

      if (dragObj && ds.kind === "move") {
        const p = clampObjectPos(
          ds.origX + (nx - ds.startNx),
          ds.origY + (ny - ds.startNy),
          dragObj.width,
          dragObj.height,
          boundsRef.current,
        );
        dispatch({
          type: "UPDATE_OBJECT_TRANSIENT",
          objectId: ds.objectId,
          updates: editPose(dragObj, { x: p.x, y: p.y }, t),
        });
      } else if (dragObj && ds.kind === "resize") {
        const result = computeResize(
          ds.handle,
          nx,
          ny,
          ds.startNx,
          ds.startNy,
          {
            x: ds.origX,
            y: ds.origY,
            w: ds.origW,
            h: ds.origH,
            rotation: ds.rotation,
          },
          width,
          height,
        );
        dispatch({
          type: "UPDATE_OBJECT_TRANSIENT",
          objectId: ds.objectId,
          updates: editPose(dragObj, result, t),
        });
      } else if (dragObj && ds.kind === "rotate") {
        const currentAngle = Math.atan2(ny - ds.centerNy, nx - ds.centerNx);
        dispatch({
          type: "UPDATE_OBJECT_TRANSIENT",
          objectId: ds.objectId,
          updates: editPose(
            dragObj,
            {
              rotation: ds.origRotation + (currentAngle - ds.startAngle),
            },
            t,
          ),
        });
      } else if (ds.kind === "draw-freehand") {
        const obj = objects.find((o) => o.id === ds.objectId);
        if (obj) {
          const { bx, by } = normToObjectBbox(nx, ny, obj, width, height);
          const data = obj.data as FreehandData;
          const lastStroke = data.strokes[data.strokes.length - 1];
          const newStrokes = [
            ...data.strokes.slice(0, -1),
            [...lastStroke, { x: bx, y: by }],
          ];
          dispatch({
            type: "UPDATE_OBJECT_TRANSIENT",
            objectId: ds.objectId,
            updates: { data: { strokes: newStrokes } },
          });
        }
      }
    };

    const onUp = () => {
      dispatch({ type: "COMMIT_TRANSIENT" });
      setDragState(null);
    };

    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [dragState, dispatch, objects, width, height, globalTime, applyZoomDrag]);

  // --- Right-click: finish arrow drawing ---
  const handleContextMenu = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      if (interactionMode === "draw" && selectedObject?.type === "arrow") {
        e.preventDefault();
        const data = selectedObject.data as ArrowData;
        if (data.points.length >= 2) {
          onFinishArrow?.();
        }
      }
    },
    [interactionMode, selectedObject, onFinishArrow],
  );

  // --- Double-click: place final point and finish ---
  const handleDoubleClick = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      if (interactionMode === "draw" && selectedObject?.type === "arrow") {
        // The two mousedown events already added two points — remove the extra one
        const data = selectedObject.data as ArrowData;
        if (data.points.length >= 2) {
          const trimmed = data.points.slice(0, -1);
          dispatch({
            type: "UPDATE_OBJECT",
            objectId: selectedObject.id,
            updates: { data: { ...data, points: trimmed } },
          });
        }
        onFinishArrow?.();
        return;
      }
      // R6: double-click a selected text object (Frame view, move mode) → edit its content in place.
      if (
        !isLive &&
        interactionMode === "move" &&
        selectedObject?.type === "text"
      ) {
        const canvas = overlayCanvasRef.current;
        if (!canvas) return;
        const { nx, ny } = clientToNorm(e, renderCanvasRef.current ?? canvas);
        if (hitTestObject(nx, ny, selectedObject, width, height)) {
          const content = (selectedObject.data as TextData).content ?? "";
          editOriginalRef.current = content;
          setEditValue(content);
          setEditingTextId(selectedObject.id);
        }
      }
    },
    [
      interactionMode,
      selectedObject,
      isLive,
      width,
      height,
      dispatch,
      onFinishArrow,
    ],
  );

  // --- Mouse leave: hide tooltip ---
  const handleMouseLeave = useCallback(() => {
    setTooltipPos(null);
    mouseNormRef.current = null;
  }, []);

  // --- Tooltip text ---
  const tooltipText = useMemo(() => {
    if (interactionMode !== "draw") return null;
    // Freehand: a persistent cursor hint so "how do I stop?" is always answered in the render space,
    // not just on the side panel (matches the arrow's cursor tooltip).
    if (selectedObject?.type === "freehand")
      return "Drag to draw \u00b7 press Esc to finish";
    if (selectedObject?.type !== "arrow") return null;
    const data = selectedObject.data as ArrowData;
    const count = data.points.length;
    const segments = Math.max(0, count - 1);
    if (count >= ARROW_MAX_POINTS - 1)
      return "Click to place last point (max reached)";
    if (count === 0) return "Click to place first point";
    if (count === 1) return "Click to add points \u00b7 Esc to finish";
    return `Click to add points \u00b7 Right-click or Esc to finish with ${segments} segment${segments !== 1 ? "s" : ""}`;
  }, [interactionMode, selectedObject]);

  const viewportTransform = `translate(${viewport.panX}px, ${viewport.panY}px) scale(${viewport.scale})`;
  const zoomPct = Math.round(viewport.scale * 100);

  // === Floating context toolbar anchoring (spec 17 P1) ===
  // Hosted here as a NON-transformed sibling of the canvases in the fit box (like the Frame/Live
  // button), so it isn't scaled by the viewport transform. It anchors to the selected object's
  // on-screen box, flips below when near the top edge, and clamps within the frame.
  const toolbarRef = useRef<HTMLDivElement>(null);
  const [toolbarPos, setToolbarPos] = useState<{
    left: number;
    top: number;
    side: "above" | "below";
  } | null>(null);
  // Layout changes (panel/timeline/window resize) don't flow through React deps — a ResizeObserver
  // on the render area bumps this tick so the anchor recomputes.
  const [layoutTick, setLayoutTick] = useState(0);
  useEffect(() => {
    const el = renderAreaRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setLayoutTick((t) => t + 1));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Measure the grey viewport (spec 18-qol): the fit box is the letterboxed frame (untransformed, so
  // stable under editor zoom/pan); the render area is the whole grey working area. The grey extent on
  // each side / the frame size = how far past the frame the object bbox may travel, and how far the
  // overlay must bleed to keep painting handles out there. Recomputed on any layout change.
  useLayoutEffect(() => {
    const fit = fitBoxRef.current;
    const ra = renderAreaRef.current;
    if (!fit || !ra) return;
    const f = fit.getBoundingClientRect();
    const r = ra.getBoundingClientRect();
    if (f.width < 1 || f.height < 1) return;
    const marginL = Math.max(MIN_MARGIN, (f.left - r.left) / f.width);
    const marginR = Math.max(MIN_MARGIN, (r.right - f.right) / f.width);
    const marginT = Math.max(MIN_MARGIN, (f.top - r.top) / f.height);
    const marginB = Math.max(MIN_MARGIN, (r.bottom - f.bottom) / f.height);
    // Symmetric overlay bleed per axis = the larger side + handle pad, so handles paint at any edge.
    const bleedX = Math.max(marginL, marginR) + HANDLE_BLEED_PX / f.width;
    const bleedY = Math.max(marginT, marginB) + HANDLE_BLEED_PX / f.height;
    setBounds((prev) =>
      prev.marginL === marginL &&
      prev.marginR === marginR &&
      prev.marginT === marginT &&
      prev.marginB === marginB &&
      prev.bleedX === bleedX &&
      prev.bleedY === bleedY
        ? prev
        : { marginL, marginR, marginT, marginB, bleedX, bleedY },
    );
  }, [width, height, layoutTick]);

  // Audio has no canvas box (P4 → its props stay in the inspector). Hide during drag / playback /
  // Live view / point-drawing (OQ-6) to avoid jitter and occluding the interaction.
  const toolbarObject =
    selectedObjectRaw && selectedObjectRaw.type !== "audio"
      ? selectedObject
      : null;
  const showObjectToolbar =
    !!toolbarObject &&
    !isPlaying &&
    !isLive &&
    dragState == null &&
    interactionMode !== "draw";
  // Resolved-pose primitives (not object identity) keep the effect from self-triggering each render.
  const tbX = toolbarObject?.x,
    tbY = toolbarObject?.y;
  const tbW = toolbarObject?.width,
    tbH = toolbarObject?.height,
    tbR = toolbarObject?.rotation;

  // Camera zoom (P5): anchor to the selected zoom's framing rect (Frame view only), same hide rules.
  const zoomRect =
    selectedZoom && !isLive
      ? cameraFrameRect(zoomTargetPoseAt(selectedZoom, globalTime))
      : null;
  const showZoomToolbar = !!zoomRect && !isPlaying && dragState == null;
  const zrX = zoomRect?.x,
    zrY = zoomRect?.y,
    zrW = zoomRect?.w,
    zrH = zoomRect?.h;

  useLayoutEffect(() => {
    const fit = fitBoxRef.current;
    const renderCanvas = renderCanvasRef.current;
    if (!fit || !renderCanvas) {
      setToolbarPos(null);
      return;
    }

    // The selection's bounds in project px — an object's (possibly rotated) bbox + its rotate-handle
    // tip + resize-handle pad, OR the selected zoom's framing rect + the scale/keyframe label tab it
    // draws above. Whichever is active; object/zoom selection are mutually exclusive.
    const HANDLE_PAD = HANDLE_SIZE / 2;
    let bounds: {
      minX: number;
      minY: number;
      maxX: number;
      maxY: number;
    } | null = null;
    if (
      showObjectToolbar &&
      tbX != null &&
      tbY != null &&
      tbW != null &&
      tbH != null &&
      tbR != null
    ) {
      const bx = tbX * width,
        by = tbY * height;
      const bw = tbW * width,
        bh = tbH * height;
      const ccx = bx + bw / 2,
        ccy = by + bh / 2;
      const cos = Math.cos(tbR),
        sin = Math.sin(tbR);
      const rotTipY = by - ROTATION_HANDLE_DISTANCE - 8; // rotation handle circle above top-center
      let minX = Infinity,
        minY = Infinity,
        maxX = -Infinity,
        maxY = -Infinity;
      for (const [px, py] of [
        [bx, by],
        [bx + bw, by],
        [bx + bw, by + bh],
        [bx, by + bh],
        [ccx, rotTipY],
      ] as const) {
        const dx = px - ccx,
          dy = py - ccy;
        const rx = ccx + dx * cos - dy * sin;
        const ry = ccy + dx * sin + dy * cos;
        minX = Math.min(minX, rx);
        maxX = Math.max(maxX, rx);
        minY = Math.min(minY, ry);
        maxY = Math.max(maxY, ry);
      }
      bounds = {
        minX: minX - HANDLE_PAD,
        minY: minY - HANDLE_PAD,
        maxX: maxX + HANDLE_PAD,
        maxY: maxY + HANDLE_PAD,
      };
    } else if (
      showZoomToolbar &&
      zrX != null &&
      zrY != null &&
      zrW != null &&
      zrH != null
    ) {
      const rx = zrX * width,
        ry = zrY * height,
        rw = zrW * width,
        rh = zrH * height;
      const ZOOM_TAB = 22; // scale/keyframe label tab drawn above the framing rect (~18px + gap)
      bounds = {
        minX: rx - HANDLE_PAD,
        minY: ry - ZOOM_TAB - HANDLE_PAD,
        maxX: rx + rw + HANDLE_PAD,
        maxY: ry + rh + HANDLE_PAD,
      };
    }
    if (!bounds) {
      setToolbarPos(null);
      return;
    }

    // Use the RENDER canvas rect (the frame) — the overlay is now bleed-enlarged (R1), so its rect no
    // longer equals the frame and would skew this mapping.
    const rcRect = renderCanvas.getBoundingClientRect(); // the frame; reflects the viewport transform (spec 16 C)
    const fitRect = fit.getBoundingClientRect(); // stable under the transform (it's on the canvases)
    // project px → client (via the render-canvas rect) → fit-box-local px.
    const sx = rcRect.width / width,
      sy = rcRect.height / height;
    const cxLocal =
      rcRect.left + ((bounds.minX + bounds.maxX) / 2) * sx - fitRect.left;
    const topLocal = rcRect.top + bounds.minY * sy - fitRect.top;
    const bottomLocal = rcRect.top + bounds.maxY * sy - fitRect.top;

    const barW = toolbarRef.current?.offsetWidth ?? 0;
    const barH = toolbarRef.current?.offsetHeight ?? 0;
    const MARGIN = 10,
      PAD = 6;

    // The visible range = the render area (viewport) in fit-box-local px. The fit box sits inside the
    // render area's p-4/pb-20 padding, so visTop < 0 and visBottom > fit height — this is the extra
    // margin the bar may use to stay on-screen (R2). Clamp on BOTH axes to this range.
    const raRect = renderAreaRef.current?.getBoundingClientRect();
    const visTop = raRect ? raRect.top - fitRect.top : 0;
    const visBottom = raRect ? raRect.bottom - fitRect.top : fitRect.height;
    const visLeft = raRect ? raRect.left - fitRect.left : 0;
    const visRight = raRect ? raRect.right - fitRect.left : fitRect.width;
    // The floating transport pill (App.tsx: `absolute bottom-5`, ~44px pill) lives in the bottom
    // gutter, so treat that band as off-limits: the toolbar clamps above it and a selection too tall
    // to fit above OR in the remaining space pins to the top instead of landing on the transport.
    const TRANSPORT_RESERVE = 72;
    const bottomLimit = visBottom - TRANSPORT_RESERVE;

    // Decide by whether the bar FITS inside the visible range above vs below; if neither fits (a
    // selection taller than the viewport) pin to the TOP edge, overlapping the selection — keeps it
    // clear of the transport/timeline at the bottom (R2.2). Pin reuses 'below' anchoring (styled top =
    // bar's top edge).
    const roomAbove = topLocal - MARGIN - barH >= visTop + PAD;
    const roomBelow = bottomLocal + MARGIN + barH <= bottomLimit - PAD;
    const side: "above" | "below" = roomAbove ? "above" : "below";
    const pinned = !roomAbove && !roomBelow;

    // Bar TOP edge, then clamp into the visible vertical range as a final safety net (R2.3).
    let barTop = pinned
      ? visTop + PAD
      : side === "above"
        ? topLocal - MARGIN - barH
        : bottomLocal + MARGIN;
    barTop = Math.max(visTop + PAD, Math.min(bottomLimit - barH - PAD, barTop));
    // Convert back to the styled `top` the JSX expects: 'above' uses translateY(-100%) so its styled
    // top is the bar's BOTTOM edge; 'below' (and pin) styled top is the bar's TOP edge.
    const top = side === "above" ? barTop + barH : barTop;

    // Horizontal: center on the selection, clamped to the visible area on both edges.
    const half = barW / 2;
    const minLeft = visLeft + half + PAD,
      maxLeft = visRight - half - PAD;
    const left =
      maxLeft >= minLeft
        ? Math.max(minLeft, Math.min(maxLeft, cxLocal))
        : (visLeft + visRight) / 2;

    setToolbarPos((prev) =>
      prev && prev.left === left && prev.top === top && prev.side === side
        ? prev
        : { left, top, side },
    );
  }, [
    showObjectToolbar,
    tbX,
    tbY,
    tbW,
    tbH,
    tbR,
    showZoomToolbar,
    zrX,
    zrY,
    zrW,
    zrH,
    width,
    height,
    viewport.scale,
    viewport.panX,
    viewport.panY,
    layoutTick,
    selectedObjectRaw?.id,
    selectedObjectRaw?.type,
    selectedZoomId,
  ]);

  // Position the in-place text edit field over the object (spec 18-qol R6). Mirrors the toolbar-anchor
  // mapping: project px → client (render-canvas rect = the frame) → fit-box-local px, so it tracks the
  // editor viewport zoom/pan.
  useLayoutEffect(() => {
    if (!editingObject) {
      setEditRect(null);
      return;
    }
    const rc = renderCanvasRef.current;
    const fit = fitBoxRef.current;
    if (!rc || !fit) {
      setEditRect(null);
      return;
    }
    const rcRect = rc.getBoundingClientRect();
    const fitRect = fit.getBoundingClientRect();
    const sx = rcRect.width / width,
      sy = rcRect.height / height;
    setEditRect({
      left: rcRect.left + editingObject.x * width * sx - fitRect.left,
      top: rcRect.top + editingObject.y * height * sy - fitRect.top,
      width: editingObject.width * width * sx,
      height: editingObject.height * height * sy,
    });
  }, [
    editingObject?.id,
    editingObject?.x,
    editingObject?.y,
    editingObject?.width,
    editingObject?.height,
    width,
    height,
    viewport.scale,
    viewport.panX,
    viewport.panY,
    layoutTick,
  ]);

  // On-screen font size for the edit field so it matches the rendered text (spec 18-qol R6). Both
  // cases compute the font in project px exactly as drawText does, then scale to screen (× syScreen).
  // Auto-size runs the SAME `fitText` fit (font fitted to the box with wrapping) on the live text, so
  // the edit field tracks the real size instead of ballooning.
  const editFontPx = (() => {
    if (!editingObject || !editRect) return 16;
    const style = editingObject.style;
    const data = editingObject.data as TextData;
    const syScreen =
      editingObject.height > 0
        ? editRect.height / (editingObject.height * height)
        : 1;
    const scaleFactor = Math.sqrt((width * height) / (1920 * 1080));
    let fontProjectPx: number;
    if (data.autoSize !== false) {
      if (!measureCtxRef.current)
        measureCtxRef.current = document
          .createElement("canvas")
          .getContext("2d");
      const ctx = measureCtxRef.current;
      const padding = (data.padding ?? 8) * scaleFactor;
      const availW = Math.max(1, editingObject.width * width - padding * 2);
      const availH = Math.max(1, editingObject.height * height - padding * 2);
      const fontStyle = style.fontStyle ?? "normal";
      const fontWeight = style.fontWeight ?? "bold";
      const fontFamily = style.fontFamily ?? "sans-serif";
      const fontOf = (size: number) =>
        `${fontStyle} ${fontWeight} ${size}px ${fontFamily}`;
      fontProjectPx = ctx
        ? fitText(ctx, editValue, fontOf, availW, availH).fontSize
        : 32 * scaleFactor;
    } else {
      fontProjectPx = (style.fontSize ?? 32) * scaleFactor;
    }
    return fontProjectPx * syScreen;
  })();

  return (
    <div
      ref={renderAreaRef}
      className="flex-1 flex items-center justify-center bg-bg p-4 pb-20 overflow-hidden"
    >
      <div
        ref={fitBoxRef}
        className="relative max-w-full max-h-full"
        style={{ aspectRatio: `${width}/${height}` }}
      >
        {/* Both canvases share the SAME editor viewport transform (spec 16 C). CSS transforms don't
            affect layout, so the fit box keeps its size and getBoundingClientRect reflects the
            transform — hit-testing / overlay math stay correct with zero changes. */}
        <canvas
          ref={renderCanvasRef}
          className="block w-full h-full rounded shadow-lg"
          style={{
            aspectRatio: `${width}/${height}`,
            transform: viewportTransform,
            transformOrigin: "0 0",
          }}
        />
        <canvas
          ref={overlayCanvasRef}
          // Grown + offset by the bleed margin (R1) so out-of-frame handles paint & receive mouse
          // events. transform-origin sits on the frame's top-left (in overlay-local space) so it
          // scales/pans in lockstep with the render canvas (whose origin is 0 0). Its inner frame
          // region therefore stays pixel-aligned with the render canvas at every zoom/pan.
          className="absolute"
          style={{
            left: `${-bounds.bleedX * 100}%`,
            top: `${-bounds.bleedY * 100}%`,
            width: `${(1 + 2 * bounds.bleedX) * 100}%`,
            height: `${(1 + 2 * bounds.bleedY) * 100}%`,
            cursor,
            transform: viewportTransform,
            transformOrigin: `${(bounds.bleedX / (1 + 2 * bounds.bleedX)) * 100}% ${(bounds.bleedY / (1 + 2 * bounds.bleedY)) * 100}%`,
          }}
          onMouseDown={handleMouseDown}
          onMouseMove={handleMouseMove}
          onMouseUp={handleMouseUp}
          onContextMenu={handleContextMenu}
          onDoubleClick={handleDoubleClick}
          onMouseLeave={handleMouseLeave}
        />
        {tooltipText && tooltipPos && (
          <div
            className="absolute bg-black/80 text-white text-xs px-2 py-1 rounded pointer-events-none whitespace-nowrap"
            style={{ left: tooltipPos.x, top: tooltipPos.y }}
          >
            {tooltipText}
          </div>
        )}

        {/* In-place text editor (spec 18-qol R6). Positioned over the object; the object itself is
            hidden from the render while editing so this is the only visible copy. App's key handler
            ignores textarea targets, so Delete/arrows/space/Esc don't mutate the object while typing. */}
        {editingObject && editRect && (
          <textarea
            value={editValue}
            autoFocus
            spellCheck={false}
            onChange={(e) => setEditValue(e.target.value)}
            onBlur={commitTextEdit}
            onFocus={(e) => e.currentTarget.select()}
            onKeyDown={(e) => {
              e.stopPropagation();
              // Esc / ⌘|Ctrl+Enter commit; plain Enter inserts a newline (multi-line text boxes).
              if (
                e.key === "Escape" ||
                (e.key === "Enter" && (e.metaKey || e.ctrlKey))
              ) {
                e.preventDefault();
                commitTextEdit();
              }
            }}
            className="absolute z-40 m-0 resize-none overflow-hidden outline-none ring-2 ring-accent rounded-[3px]"
            style={{
              left: editRect.left,
              top: editRect.top,
              width: editRect.width,
              height: editRect.height,
              transform: `rotate(${editingObject.rotation}rad)`,
              transformOrigin: "center",
              background:
                (editingObject.data as TextData).background ?? "transparent",
              color: editingObject.style.color,
              fontFamily: editingObject.style.fontFamily ?? "sans-serif",
              fontWeight: editingObject.style.fontWeight ?? "bold",
              fontStyle: editingObject.style.fontStyle ?? "normal",
              fontSize: editFontPx,
              lineHeight: 1.25,
              textAlign: ((editingObject.data as TextData).align ??
                "center") as React.CSSProperties["textAlign"],
              padding:
                ((editingObject.data as TextData).padding ?? 8) *
                (editingObject.height > 0
                  ? editRect.height / (editingObject.height * height)
                  : 1),
            }}
          />
        )}

        {/* Frame / Live camera view toggle (spec 13, R7). Frame = author un-zoomed with a framing
            rectangle; Live = the real push-in (WYSIWYG, matches export). Shortcut: V. */}
        <button
          onClick={onToggleCameraView}
          title={
            isLive
              ? "Live preview - what you see is what will be exported. Click to toggle to Editor view (V)"
              : "Editor view - click to toggle to Live preview (V)"
          }
          className={`absolute top-2 right-2 flex items-center gap-1 px-2.5 py-1 text-xs font-semibold rounded shadow cursor-pointer transition-colors ${
            isLive
              ? "bg-camera text-black hover:bg-camera/90"
              : "bg-surface-muted/90 text-fg hover:bg-surface-hover"
          }`}
        >
          {isLive ? (
            <>
              <IconPlayerPlay size={13} stroke={2} /> Live
            </>
          ) : (
            <>
              <IconViewfinder size={13} stroke={2} /> Editor
            </>
          )}
        </button>

        {/* Editor viewport zoom controls (spec 16 D). Editor-only magnification — never exported.
            Wheel over the canvas zooms to the cursor; middle-drag pans. 100% = fit-to-window. */}
        <div className="absolute top-2 left-2 flex items-center bg-surface-muted/90 rounded shadow text-xs text-fg select-none">
          <button
            onClick={() => zoomAt(1 / BUTTON_ZOOM_FACTOR)}
            className="px-2 py-1 inline-flex items-center hover:bg-surface-hover rounded-l cursor-pointer"
            title="Zoom out"
          >
            <IconMinus size={14} stroke={2} />
          </button>
          <button
            onClick={resetViewport}
            className="px-1.5 py-1 min-w-[3.25rem] text-center tabular-nums hover:bg-surface-hover cursor-pointer"
            title="Reset to Fit (100%)"
          >
            {zoomPct}%
          </button>
          <button
            onClick={() => zoomAt(BUTTON_ZOOM_FACTOR)}
            className="px-2 py-1 inline-flex items-center hover:bg-surface-hover cursor-pointer"
            title="Zoom in"
          >
            <IconPlus size={14} stroke={2} />
          </button>
          <span className="w-px h-4 bg-border-strong" />
          <button
            onClick={resetViewport}
            className="px-2 py-1 hover:bg-surface-hover rounded-r cursor-pointer"
            title="Fit to window"
          >
            Fit
          </button>
        </div>

        {/* Floating context toolbar (spec 17 P) — anchored over the selected object OR camera zoom;
            centered via translateX(-50%), lifted fully above with translateY(-100%) when placed above.
            Kept hidden for the first paint until the anchor is measured (avoids a wrong-position flash). */}
        {(showObjectToolbar || showZoomToolbar) && (
          <div
            ref={toolbarRef}
            className="absolute z-30 pointer-events-auto"
            style={{
              left: toolbarPos?.left ?? 0,
              top: toolbarPos?.top ?? 0,
              transform: `translate(-50%, ${toolbarPos?.side === "below" ? "0" : "-100%"})`,
              visibility: toolbarPos ? "visible" : "hidden",
            }}
          >
            {showObjectToolbar && toolbarObject ? (
              <ContextToolbar
                object={selectedObjectRaw!}
                dispatch={dispatch}
                globalTime={globalTime}
                onToggleDraw={onToggleDraw}
                onDuplicate={onDuplicate}
              />
            ) : selectedZoom ? (
              <ZoomContextToolbar
                zoom={selectedZoom}
                dispatch={dispatch}
                globalTime={globalTime}
                onSelectZoom={onSelectZoom}
              />
            ) : null}
          </div>
        )}
      </div>
    </div>
  );
}

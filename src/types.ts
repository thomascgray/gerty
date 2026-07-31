// === Timeline Object Types ===

export type TimelineObjectType = 'photo' | 'arrow' | 'text' | 'rectangle' | 'circle' | 'freehand' | 'audio' | 'video'

export type TimelineObject = {
  id: string
  type: TimelineObjectType
  name: string
  startTime: number       // global seconds
  duration: number        // seconds visible
  lane: number            // higher = renders on top (foreground)

  // Canvas positioning (normalised 0–1)
  x: number
  y: number
  width: number
  height: number
  rotation: number        // radians, rotation around center of bounding box

  // Animation
  animateIn: number       // seconds for draw-on animation (0 = instant)
  keyframes?: Keyframe[]  // optional whole-pose animation waypoints; created only via the button
  enter?: Transition      // entrance animation (fade/slide/pop) played as the object appears
  exit?: Transition       // exit animation played as the object disappears

  // Visual style
  style: ObjectStyle

  // Non-destructive visibility (spec 14 R11). When true, the object stays in the
  // project/timeline but is skipped in every render/audio/export path. Default false.
  hidden?: boolean

  // When true, the object renders at its normalized position over the FULL frame and is NOT
  // affected by the camera/zoom transform — a "pinned" overlay that stays put at any zoom.
  // Handled per-object inside renderFrame; default false.
  ignoreCamera?: boolean

  // Type-specific payload
  data: PhotoData | ArrowData | TextData | ShapeData | FreehandData | AudioData | VideoData
}

export type ObjectStyle = {
  color: string
  lineWidth: number
  opacity: number
  fontSize?: number
  fontFamily?: string
  fontWeight?: string
  fontStyle?: string   // 'normal' | 'italic'
}

// === Animation / Keyframes ===

export type EasingKind =
  | 'instant'                                          // step / hard-cut (spec 21)
  | 'linear'
  | 'easeInCubic' | 'easeOutCubic' | 'easeInOutCubic'
  | 'easeOutBack'
  | 'spring'

// The object's POSE properties. `opacity` maps to style.opacity; the rest are top-level.
export type AnimatableProperty = 'x' | 'y' | 'width' | 'height' | 'rotation' | 'opacity'

// A full pose snapshot. LEGACY shape: pre-spec-29 keyframes stored exactly this and nothing else.
export type KeyframePose = Record<AnimatableProperty, number>

// === Animatable channels (spec 29) ===
// The full key space of keyframable properties, addressed by a flat dotted key so ONE sparse map
// covers pose + style + type-specific data. (Nesting would force three parallel merge paths in the
// resolver and three badge maps in the panel.) Each key's label, owning panel section, interpolation
// rule, object types, and read/write accessors live in ONE table: `CHANNELS` in lib/keyframes.ts.
export type AnimatableChannel =
  // pose — the legacy six
  | AnimatableProperty
  // style
  | 'style.color' | 'style.lineWidth' | 'style.fontSize'
  | 'style.fontFamily' | 'style.fontWeight' | 'style.fontStyle'
  // text data
  | 'text.content' | 'text.background' | 'text.cornerRadius' | 'text.align' | 'text.effect'
  // arrow data
  | 'arrow.curvature' | 'arrow.headSize'

// A channel's stored value. Only TextEffect is non-scalar (see the `effect` interpolation rule).
// An ABSENT optional value (no text background, no text effect) is meaningful and must survive a
// save: it is STORED as `null` (JSON.stringify drops undefined-valued keys, which would silently
// un-declare the channel) and normalised back to `undefined` on read by `channelOf`.
export type ChannelValue = number | string | boolean | TextEffect | null | undefined

// A keyframe is a SPARSE declaration (spec 29): it governs only the properties listed in `props`,
// and each property resolves as an INDEPENDENT track. A property animates iff at least one keyframe
// declares it; otherwise it reads its static base value off the object for the whole clip.
//
// Back-compat: pre-spec-29 keyframes stored a whole-pose `pose` and no `props`. Those are read as
// "declares all six pose channels", so old projects/.gerty imports animate exactly as before with no
// migration step. New keyframes only ever write `props`; `pose` is never written again.
export type Keyframe = {
  time: number         // clip-relative seconds (relative to startTime) when these values are reached
  pose?: KeyframePose  // LEGACY whole-pose snapshot; read-only fallback, never written by new code
  props?: Partial<Record<AnimatableChannel, ChannelValue>>  // the sparse declaration set
  easing: EasingKind   // curve for the segment ARRIVING at this keyframe (from the previous one)
  leadIn?: number      // spec 21: seconds the arriving move takes, ending at `time`. Holds the
                       // previous value before (time - leadIn). Undefined = fill the whole gap.
}

// === Enter / Exit transitions ===
// Menu-driven entrance/exit animations, distinct from keyframes: they animate the object
// as it appears (near startTime) or disappears (near endTime), and do NOT create keyframes.

export type TransitionKind = 'none' | 'fade' | 'slide' | 'pop'
export type SlideDirection = 'left' | 'right' | 'top' | 'bottom'

export type Transition = {
  kind: TransitionKind
  duration: number          // seconds
  direction?: SlideDirection // slide only
  easing?: EasingKind        // optional; a kind-specific default is used when omitted
}

// Animated images (GIF / animated WebP / APNG) are still `photo` objects — only three
// scalars are added (spec 28 B). The per-frame timing array deliberately lives ONCE on
// AssetMeta, not here: DUPLICATE_OBJECT deep-clones `data`, so an array here would be
// copied per clip. All the loop maths stays object-local; only the index lookup needs
// the asset's timings. Absent fields ⇒ a plain still image, exactly as before.
export type PhotoData = {
  assetId: string         // reference to asset in asset store
  animated?: boolean      // set at import when the asset decodes to >1 frame
  animationDuration?: number  // seconds, one full loop (animated only)
  loop?: boolean          // absent = true. false = play once, then hold the last frame
}

export type ArrowData = {
  points: { x: number; y: number }[]  // 0–1 relative to object's bounding box
  headSize: number
  curvature: number  // -1 to 1. 0 = straight, positive = curve right, negative = curve left
  progressiveHead: boolean  // when true, arrowhead follows the animated tip; when false, only shows at end
}

export type TextAlign = 'left' | 'center' | 'right' | 'justify'

// Tier 1 (static) + Tier 2 (animated) text effects (spec 19). Absent = plain fill (today).
// Every variant is a deterministic pure fn of (data, clip-relative time) rendered in Canvas 2D, so
// preview and export stay pixel-identical (R-DET). Animated kinds use clip-relative time.
export type TextEffect =
  // Tier 1 — static
  | { kind: 'glow';     color: string; blur: number }                 // px blur (project-space, * scaleFactor)
  | { kind: 'outline';  color: string; width: number }                // px stroke width (project-space)
  | { kind: 'shadow';   color: string; dx: number; dy: number; blur: number } // px offsets/blur (project-space)
  | { kind: 'gradient'; from: string; to: string; angle: number }     // linear gradient fill; angle in degrees
  // Tier 2 — animated (time-driven; pure fn of clip time)
  | { kind: 'pulse';    speed: number; amount: number }               // scale + opacity oscillation
  | { kind: 'rainbow';  speed: number }                               // fill hue cycle
  | { kind: 'wave';     speed: number; amplitude: number }            // per-glyph vertical travel (px, project-space)
  | { kind: 'shimmer';  speed: number; color: string }                // sweeping highlight band
  | { kind: 'warble';   speed: number; amount: number }               // faux-3D axis wobble (near edge precesses L→T→R→B)
  | { kind: 'glitch';   speed: number; amount: number }               // RGB-split + horizontal slice tearing + dropouts

export type TextEffectKind = TextEffect['kind']

export type TextData = {
  content: string
  background?: string
  padding?: number
  align?: TextAlign     // horizontal alignment of wrapped lines; default 'center'
  autoSize?: boolean    // when true (default), font size is auto-fit to fill the box; when
                        // false, style.fontSize is used verbatim (lines still wrap to width)
  cornerRadius?: number // px (project-space, pre-scaleFactor) radius for the background panel corners;
                        // default 0/undefined = square (fillRect). Clamped to half the box in drawText.
  effect?: TextEffect   // spec 19: optional visual effect beyond plain fill. Absent = rendered as today.
}

export type ShapeData = Record<string, never>

export type FreehandData = {
  strokes: { x: number; y: number }[][]  // array of strokes, each stroke is points 0–1 relative to bbox
}

export type AudioData = {
  assetId: string           // reference to asset in asset store
  volume: number            // 0–1
  muted?: boolean           // when true, this clip's audio is silenced in preview AND export
  originalDuration: number  // seconds — the source file's actual duration
  waveform?: number[]       // ~200 peak values for visualization
  sourceIn?: number         // trim: source seconds where playback begins; default 0 (spec 14)
  sourceOut?: number        // trim: source seconds where playback ends; default originalDuration
  sourceMin?: number        // recoverable-source window floor: sourceIn can't trim below this; default 0. A split narrows it so the halves read as untrimmed clips (no ghosts).
  sourceMax?: number        // recoverable-source window ceil: sourceOut can't trim past this; default originalDuration
}

export type VideoData = {
  assetId: string           // reference to asset in asset store
  volume: number            // 0–1
  muted?: boolean           // when true, the video's audio track is silenced (preview + export); video still shows
  originalDuration: number  // seconds — the source file's actual duration
  waveform?: number[]       // ~200 peak values of the video's audio track, for the timeline bar
  sourceIn?: number         // trim: source seconds where playback begins; default 0 (spec 14)
  sourceOut?: number        // trim: source seconds where playback ends; default originalDuration
  sourceMin?: number        // recoverable-source window floor: sourceIn can't trim below this; default 0. A split narrows it so the halves read as untrimmed clips (no ghosts).
  sourceMax?: number        // recoverable-source window ceil: sourceOut can't trim past this; default originalDuration
}

// === Camera (spec 13) ===

// The resolved camera pose at an instant (what renderFrame consumes).
export type CameraState = {
  x: number      // normalized 0–1 focal point, held at canvas center
  y: number      // normalized 0–1
  scale: number  // >= 1 (1 = full frame, 2 = 2x punch-in)
}

// A camera pose waypoint WITHIN a zoom — lets one zoom pan/scale through several poses over its
// hold, instead of holding a single static pose. `time` is relative to the zoom's HOLD-segment
// start (startTime + transitionIn), so the ease-in/ease-out ramps stay pure. The zoom's own
// x/y/scale is the t=0 waypoint (its "home" pose). Mirrors the object Keyframe model.
export type CameraKeyframe = {
  time: number         // seconds relative to hold start; when this pose is reached
  pose: CameraState    // { x, y, scale }
  easing: EasingKind   // curve for the segment ARRIVING at this keyframe (from the previous one)
  leadIn?: number      // spec 21: seconds the arriving move takes, ending at `time` (as Keyframe.leadIn)
}

// One authored "zoom" — a punch-in envelope. resolveCamera compiles a list of these
// into a CameraState at each global time. Reuses spec-12 EasingKind.
export type CameraZoom = {
  id: string
  x: number              // focal point (normalized 0–1) — the home/base pose, reached at hold start
  y: number
  scale: number          // >= 1, the "amount"
  startTime: number      // global seconds — when the ease-in begins
  transitionIn: number   // seconds to ease from the CURRENT camera pose into this target
  hold: number           // seconds held (or, when keyframed, the window the pose path plays over)
  transitionOut: number  // seconds to ease back to full frame IF no next zoom takes over first
  easing: EasingKind     // spec-12 curve applied to both in and out ramps
  keyframes?: CameraKeyframe[] // optional pose path over the hold; created only via "+ Keyframe"
  hidden?: boolean       // spec 14 R11: filtered out of resolveCamera when true; default false
}
// Chaining (A->B) is expressed by TIMING: if zoom B's startTime lands while zoom A is still
// active (holding, or mid ease-out), B's transitionIn eases from A's current pose straight to B's
// target — the camera never returns to full frame between them. Leave a gap and the camera pulls
// back to full frame (via A's transitionOut) before B begins.

export const IDENTITY_CAMERA: CameraState = { x: 0.5, y: 0.5, scale: 1 }

// === Video effects (spec 23) ===

// A render-wide, timeline-scheduled full-frame effect. Two render styles share this one type:
//   - colour-grade kinds ('grayscale'|'sepia'|'invert') → a ctx.filter string over the whole frame
//   - overlay kinds ('vignette') → a custom shape drawn on top of the graded frame
// NOT a TimelineObject and NOT a CameraZoom — a third project-level entity (like Marker/CameraZoom).
// It shares the zoom ENVELOPE shape (startTime/transitionIn/hold/transitionOut/easing) so the
// timeline lengthen/shorten drag code and the ease-in/hold/ease-out mental model transfer directly.
// Extensible: future kinds (underwater/heat) add to the union + a renderer branch.
//   - 'grain' is the first TIME-ANIMATED effect (moving film grain) — an overlay whose noise shifts
//     each frame (deterministically from the time), so preview and export animate identically.
//   - 'oldfilm' layers vintage-projector damage (scratches, dust, gate-weave jitter, exposure
//     flicker) on top of grain — compose it with a vignette + sepia for an "old cowboy film" look.
export type VideoEffectKind =
  | 'grayscale' | 'sepia' | 'invert' | 'vignette' | 'grain' | 'oldfilm'
  // spec 24 (first slice):
  // Tier 1 — CSS ctx.filter colour grades (no overlay/per-pixel work):
  | 'hue' | 'contrast' | 'bleach'
  // Tier 2 — blend/overlay:
  | 'lightleak' | 'chromatic' | 'pixelate'
  // Per-pixel effects run as WebGL fragment-shader passes (spec 25) — NOT Canvas 2D (a getImageData
  // readback per frame is too slow, spec 24 D3). See src/lib/glEffects.ts + SPECS/25-webgl-effects.md.
  | 'gradientmap' | 'posterize' | 'threshold' | 'channelswap' | 'colorisolate' | 'dither'
  | 'crt' | 'vhs' | 'halftone' | 'comic'

// Per-kind params. Absent for the colour kinds; present for vignette. (The `kind + optional payload`
// shape mirrors TimelineObject { type, data }.)
export type VignetteShape = 'rectangle' | 'circle' // rectangle = "screen size" (matches the frame)
export type VignetteParams = {
  shape: VignetteShape
  size: number     // 0–1: extent of the fully-clear central region (relative to the frame)
  feather: number  // 0–1: softness / "blur distance" of the fade from clear to black
}

// Old-film params. `wobble` is the gate-weave (frame jitter) amplitude, DECOUPLED from `intensity`
// (which drives scratches/dust/flicker) so you can have heavy grain with a steady frame, or vice
// versa. Defaults to 0 (no weave) on a new effect.
export type OldFilmParams = {
  wobble: number   // 0–1: how much the whole frame hops/jitters per frame (0 = rock steady)
}

// === spec 24 per-kind params ===
// Additive optional payloads (same shape decision as vignette/oldfilm — spec 24 D1). Only the kinds
// that need more than `intensity` carry one; contrast/bleach/pixelate map intensity directly.

// Hue rotation. Static: rotate by `angle`·intensity. Animated: continuously cycle at `speed` deg/sec
// (a psychedelic loop), derived from globalTime so preview/export match. Animated mode is a hard
// on/off at the envelope edges (CSS hue-rotate has no alpha) — set ease in/out to 0 or accept the pop.
export type HueParams = {
  animate: boolean
  angle: number    // degrees (static mode); 0–360
  speed: number    // degrees/sec (animated mode)
}

// Light leak: a drifting coloured gradient composited in `screen` blend. `angle` orients the streak,
// `speed` drives its drift across the frame (from globalTime). `color` is the leak tint.
export type LightLeakParams = {
  color: string    // hex, e.g. '#ff7a18'
  angle: number    // degrees — orientation of the leak streak
  speed: number    // drift units/sec
}

// RGB channel split (chromatic aberration). `offset` = peak channel separation in px at intensity 1;
// `angle` = direction the red/blue channels pull apart. Rendered via 3 tinted composites (no per-pixel).
export type ChromaticParams = {
  offset: number   // px at intensity 1
  angle: number    // degrees
}

// Gradient map / false colour (spec 25, WebGL shader): map per-pixel luminance through a named ramp.
export type GradientMapPreset = 'thermal' | 'nightvision' | 'infrared' | 'risograph' | 'cinematic' | 'cinemacool'
export type GradientMapParams = {
  preset: GradientMapPreset
}

// More WebGL per-pixel effects (spec 25). All blended toward the original by the eased `intensity`.
export type PosterizeParams = { levels: number }              // 2–16 quantization bands per channel
export type ThresholdParams = { dark: string; light: string; threshold: number } // duotone, threshold 0–1
export type ChannelSwapMapping = 'rbg' | 'grb' | 'brg' | 'bgr' | 'gbr'  // RGB permutation (rgb = identity, omitted)
export type ChannelSwapParams = { mapping: ChannelSwapMapping }
export type ColorIsolateParams = { hue: number; tolerance: number }  // hue 0–360°, tolerance 0–180°
export type DitherParams = { levels: number; scale: number }  // levels 2–6, scale = px per dither cell (1–8)

// Composite "look" shaders (spec 25 batch 2). CRT/VHS are TIME-ANIMATED (flicker/noise/wobble driven
// by a uTime uniform derived from globalTime → deterministic, preview==export).
// curvature 0–1 barrel (auto-fitted to the frame, so it never opens a bezel), scanline 0–1 darkness
export type CrtParams = { curvature: number; scanline: number }
export type VhsParams = { bleed: number; noise: number }        // bleed 0–1 chroma split, noise 0–1 tracking
export type HalftoneParams = { cell: number; angle: number }    // cell px (2–16), screen angle degrees
export type ComicParams = { levels: number; thickness: number } // posterized base levels (2–8) + ink line thickness (0.5–3)


export type VideoEffect = {
  id: string
  kind: VideoEffectKind
  intensity: number      // 0–1 peak strength: the filter amount (colour) / the darkness (vignette)
  startTime: number      // global seconds — when the ease-in begins
  transitionIn: number   // seconds to ramp intensity 0 -> intensity
  hold: number           // seconds held at full intensity
  transitionOut: number  // seconds to ramp intensity -> 0
  easing: EasingKind     // reused spec-12 curve, applied to both ramps (mirrors CameraZoom.easing)
  vignette?: VignetteParams // present only when kind === 'vignette'
  oldfilm?: OldFilmParams   // present only when kind === 'oldfilm'
  // spec 24 per-kind payloads (present only for their kind):
  hue?: HueParams
  lightleak?: LightLeakParams
  chromatic?: ChromaticParams
  gradientmap?: GradientMapParams
  posterize?: PosterizeParams
  threshold?: ThresholdParams
  channelswap?: ChannelSwapParams
  colorisolate?: ColorIsolateParams
  dither?: DitherParams
  crt?: CrtParams
  vhs?: VhsParams
  halftone?: HalftoneParams
  comic?: ComicParams
  hidden?: boolean        // spec 14 R11 parity: skipped in resolveEffects when true
}

// The resolved effect stack at an instant — what renderFrame consumes (mirrors CameraState).
// `intensity` is already eased; per-kind params carried through for the overlay / per-pixel branches.
export type ResolvedEffect = {
  kind: VideoEffectKind
  intensity: number
  vignette?: VignetteParams
  oldfilm?: OldFilmParams
  hue?: HueParams
  lightleak?: LightLeakParams
  chromatic?: ChromaticParams
  gradientmap?: GradientMapParams
  posterize?: PosterizeParams
  threshold?: ThresholdParams
  channelswap?: ChannelSwapParams
  colorisolate?: ColorIsolateParams
  dither?: DitherParams
  crt?: CrtParams
  vhs?: VhsParams
  halftone?: HalftoneParams
  comic?: ComicParams
}

// === Markers (spec 22) ===

// A user-placed timeline marker ("bookmark"). NOT a TimelineObject — a lightweight, project-level
// reference point, mirroring how CameraZoom is a non-object entity. Authoring aid only: never
// rendered on the canvas or in the export (renderFrame has no knowledge of it). A single
// global-seconds scalar (no pose/lane/data). Clips snap to marker times (see lib/snapping.ts).
export type Marker = {
  id: string
  time: number      // global seconds
  label?: string    // optional user label ("Beat 1", "Chorus"); default unlabeled
  color?: string    // optional accent hex; default MARKER_COLOR in Timeline
}

// === Assets ===

export type AssetType = 'image' | 'audio' | 'video'

export type AssetMeta = {
  id: string
  type: AssetType
  filename: string
  mimeType: string
  size: number              // bytes
  duration?: number         // seconds — audio/video length, AND an animated image's loop
                            // length (reused so App.handleAddExistingAsset's `duration ?? 5`
                            // sizes an animated clip correctly with no special-casing)
  animated?: boolean        // image assets only: decodes to >1 frame (spec 28 B)
  frameDelaysMs?: number[]  // animated images only: per-frame delay in INTEGER milliseconds,
                            // length = frameCount. Not cumulative float seconds — those
                            // accumulate FP noise (0.30000000000000004) and serialise ~6x
                            // larger for no precision gain. ONE copy per asset, so
                            // duplicating a clip costs nothing. Persisted, so reopening a
                            // project never re-runs the probe.
}

// === Project ===

export type Project = {
  id: string
  name: string
  fps: number
  width: number
  height: number
  objects: TimelineObject[]
  assets: AssetMeta[]
  zooms?: CameraZoom[]      // camera punch-ins (spec 13); optional/additive for back-compat
  markers?: Marker[]        // timeline markers (spec 22); optional/additive for back-compat
  effects?: VideoEffect[]   // render-wide colour/overlay effects (spec 23); optional/additive
}

// === Interaction Modes ===

export type InteractionMode = 'move' | 'draw'

// === Actions ===

export type ProjectAction =
  | { type: 'SET_PROJECT'; project: Project }
  | { type: 'SET_NAME'; name: string }
  | { type: 'SET_DIMENSIONS'; width: number; height: number }
  | { type: 'ADD_OBJECTS'; objects: TimelineObject[] }
  | { type: 'REMOVE_OBJECT'; objectId: string }
  | { type: 'UPDATE_OBJECT'; objectId: string; updates: Partial<Omit<TimelineObject, 'id' | 'type'>> }
  | { type: 'UPDATE_OBJECT_TRANSIENT'; objectId: string; updates: Partial<Omit<TimelineObject, 'id' | 'type'>> }
  | { type: 'COMMIT_TRANSIENT' }
  | { type: 'DUPLICATE_OBJECT'; objectId: string; newId?: string; startTime?: number }
  | { type: 'SPLIT_OBJECT'; objectId: string; globalTime: number }  // spec 14 R10: atomic slice-at-playhead (one undo entry)
  | { type: 'CONVERT_TO_AUDIO'; objectId: string }  // drop a video's picture, keep it as an audio-only clip
  | { type: 'REMOVE_LANE'; lane: number }
  | { type: 'ADD_ASSETS'; assets: AssetMeta[] }
  | { type: 'ADD_ZOOM'; zoom: CameraZoom }
  | { type: 'UPDATE_ZOOM'; zoomId: string; updates: Partial<Omit<CameraZoom, 'id'>> }
  | { type: 'UPDATE_ZOOM_TRANSIENT'; zoomId: string; updates: Partial<Omit<CameraZoom, 'id'>> }
  | { type: 'REMOVE_ZOOM'; zoomId: string }
  | { type: 'ADD_EFFECT'; effect: VideoEffect }
  | { type: 'ADD_EFFECTS'; effects: VideoEffect[] }  // spec 26: apply a preset stack as one undo entry
  | { type: 'UPDATE_EFFECT'; effectId: string; updates: Partial<Omit<VideoEffect, 'id'>> }
  | { type: 'UPDATE_EFFECT_TRANSIENT'; effectId: string; updates: Partial<Omit<VideoEffect, 'id'>> }
  | { type: 'REMOVE_EFFECT'; effectId: string }
  | { type: 'ADD_MARKER'; marker: Marker }
  | { type: 'UPDATE_MARKER'; markerId: string; updates: Partial<Omit<Marker, 'id'>> }
  | { type: 'UPDATE_MARKER_TRANSIENT'; markerId: string; updates: Partial<Omit<Marker, 'id'>> }
  | { type: 'REMOVE_MARKER'; markerId: string }
  | { type: 'CLEAR_MARKERS' }
  | { type: 'UNDO' }
  | { type: 'REDO' }
  | { type: 'MARK_SAVED' }  // clears the unsaved-changes flag after a .gerty export (no history change)

// === Factory Functions ===

export function createDefaultProject(size?: { width: number; height: number }): Project {
  return {
    id: crypto.randomUUID(),
    name: 'Untitled Project',
    fps: 30,
    width: size?.width ?? 1920,
    height: size?.height ?? 1080,
    objects: [],
    assets: [],
  }
}

// Default parameters for a freshly-created zoom (spec 13 Open Q1 recommendations).
export function createCameraZoom(options?: Partial<Omit<CameraZoom, 'id'>>): CameraZoom {
  return {
    id: crypto.randomUUID(),
    x: options?.x ?? 0.5,
    y: options?.y ?? 0.5,
    scale: options?.scale ?? 2,
    startTime: options?.startTime ?? 0,
    transitionIn: options?.transitionIn ?? 0.6,
    hold: options?.hold ?? 2,
    transitionOut: options?.transitionOut ?? 0.6,
    easing: options?.easing ?? 'easeInOutCubic',
  }
}

// Default parameters for a freshly-created effect (spec 23). Mirrors createCameraZoom's envelope
// defaults; vignette kinds additionally seed a sensible VignetteParams.
export function createVideoEffect(kind: VideoEffectKind, options?: Partial<Omit<VideoEffect, 'id' | 'kind'>>): VideoEffect {
  const effect: VideoEffect = {
    id: crypto.randomUUID(),
    kind,
    // Grain / old-film / light-leak / chromatic read best subtle — seed them lower than the
    // full-strength colour/vignette default. Pixelate at 1 would be extremely chunky → seed mid.
    intensity: options?.intensity ??
      (kind === 'grain' || kind === 'oldfilm' || kind === 'lightleak' || kind === 'chromatic'
        ? 0.5
        : kind === 'pixelate'
          ? 0.4
          : 1),
    startTime: options?.startTime ?? 0,
    // Default to no in/out ramp so a freshly-added effect shows at full strength immediately;
    // the user can dial in a fade from the panel. Presets can still pass their own transitions.
    transitionIn: options?.transitionIn ?? 0,
    hold: options?.hold ?? 2,
    transitionOut: options?.transitionOut ?? 0,
    easing: options?.easing ?? 'easeInOutCubic',
  }
  if (kind === 'vignette') {
    effect.vignette = options?.vignette ?? { shape: 'rectangle', size: 0.6, feather: 0.4 }
  }
  if (kind === 'oldfilm') {
    effect.oldfilm = options?.oldfilm ?? { wobble: 0 } // steady frame by default; opt into weave
  }
  // spec 24 per-kind defaults
  if (kind === 'hue') {
    effect.hue = options?.hue ?? { animate: false, angle: 90, speed: 60 }
  }
  if (kind === 'lightleak') {
    effect.lightleak = options?.lightleak ?? { color: '#ff7a18', angle: 30, speed: 0.15 }
  }
  if (kind === 'chromatic') {
    effect.chromatic = options?.chromatic ?? { offset: 8, angle: 0 }
  }
  if (kind === 'gradientmap') {
    effect.gradientmap = options?.gradientmap ?? { preset: 'thermal' }
  }
  if (kind === 'posterize') {
    effect.posterize = options?.posterize ?? { levels: 5 }
  }
  if (kind === 'threshold') {
    effect.threshold = options?.threshold ?? { dark: '#1a1a2e', light: '#e8e8e8', threshold: 0.5 }
  }
  if (kind === 'channelswap') {
    effect.channelswap = options?.channelswap ?? { mapping: 'brg' }
  }
  if (kind === 'colorisolate') {
    effect.colorisolate = options?.colorisolate ?? { hue: 0, tolerance: 30 }
  }
  if (kind === 'dither') {
    effect.dither = options?.dither ?? { levels: 3, scale: 2 }
  }
  if (kind === 'crt') {
    effect.crt = options?.crt ?? { curvature: 0.3, scanline: 0.5 }
  }
  if (kind === 'vhs') {
    effect.vhs = options?.vhs ?? { bleed: 0.5, noise: 0.4 }
  }
  if (kind === 'halftone') {
    effect.halftone = options?.halftone ?? { cell: 6, angle: 45 }
  }
  if (kind === 'comic') {
    effect.comic = options?.comic ?? { levels: 4, thickness: 1 }
  }
  return effect
}

// A freshly-created marker at the given time (defaults to 0). label/color left unset so the
// timeline uses its default MARKER_COLOR and shows just the flag until the user labels it.
export function createMarker(options?: Partial<Omit<Marker, 'id'>>): Marker {
  return {
    id: crypto.randomUUID(),
    time: options?.time ?? 0,
    ...(options?.label !== undefined && { label: options.label }),
    ...(options?.color !== undefined && { color: options.color }),
  }
}

const objectCounters: Record<string, number> = {}

export function createTimelineObject(
  type: TimelineObjectType,
  data: TimelineObject['data'],
  options?: {
    startTime?: number
    duration?: number
    lane?: number
    x?: number
    y?: number
    width?: number
    height?: number
    rotation?: number
    animateIn?: number
    style?: Partial<ObjectStyle>
    name?: string
  },
): TimelineObject {
  const count = (objectCounters[type] = (objectCounters[type] ?? 0) + 1)
  const defaultName = `${type.charAt(0).toUpperCase() + type.slice(1)} ${count}`

  return {
    id: crypto.randomUUID(),
    type,
    name: options?.name ?? defaultName,
    startTime: options?.startTime ?? 0,
    duration: options?.duration ?? 5,
    lane: options?.lane ?? 0,
    x: options?.x ?? 0,
    y: options?.y ?? 0,
    width: options?.width ?? 1,
    height: options?.height ?? 1,
    rotation: options?.rotation ?? 0,
    animateIn: options?.animateIn ?? (type === 'photo' || type === 'audio' || type === 'video' || type === 'text' ? 0 : 1),
    style: {
      color: '#FF0000',
      lineWidth: 8,
      opacity: 1,
      fontSize: 32,
      fontFamily: 'sans-serif',
      fontWeight: 'bold',
      fontStyle: 'normal',
      ...options?.style,
    },
    data,
  }
}

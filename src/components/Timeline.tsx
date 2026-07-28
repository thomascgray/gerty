import { useRef, useCallback, useState, useEffect } from 'react'
import { createPortal } from 'react-dom'
import type { TimelineObject, ProjectAction, AudioData, VideoData, TextData, PhotoData, CameraZoom, VideoEffect, Marker } from '../types'
import { keyframeColor } from '../lib/keyframes'
import { zoomEnvelope } from '../lib/camera'
import { effectEnvelope } from '../lib/effects'
import { sourceSpan, srcIn, srcOut, srcMin, srcMax } from '../lib/mediaTiming'
import { snapTime, snapClipMove, SNAP_THRESHOLD_PX } from '../lib/snapping'
import { IconChevronDown, IconPlus, IconX, IconViewfinder, IconSparkles, IconEye, IconEyeOff, IconTrash } from '@tabler/icons-react'

type TimelineProps = {
  objects: TimelineObject[]
  globalTime: number
  totalDuration: number
  // Full multi-selection set (spans lanes); every member is highlighted and moves together.
  selectedObjectIds: string[]
  // `additive` (shift-click) toggles the id in the multi-selection instead of replacing it.
  onSelectObject: (id: string | null, additive?: boolean) => void
  onSeek: (time: number) => void
  dispatch: React.Dispatch<ProjectAction>
  // Camera zooms (spec 13)
  zooms?: CameraZoom[]
  selectedZoomId: string | null
  onSelectZoom: (id: string | null) => void
  // Video effects (spec 23) — own pinned track, mirrors the Camera track affordances.
  effects?: VideoEffect[]
  selectedEffectId: string | null
  onSelectEffect: (id: string | null) => void
  // Timeline markers (spec 22). Retime/edit/delete are dispatched directly (like zooms).
  markers?: Marker[]
  // Collapse the timeline to a slim bar (spec 16 B3). App owns the collapsed state + height.
  onCollapse?: () => void
}

const LANE_HEIGHT = 40
const LANE_GAP = 2
const RULER_HEIGHT = 24
const CAMERA_TRACK_HEIGHT = 32
const EFFECT_ROW_HEIGHT = 26 // one stacked row of effect bars; the track grows to fit N rows
const GUTTER_WIDTH = 32
const MIN_PIXELS_PER_SECOND = 2
const MAX_PIXELS_PER_SECOND = 400
const DEFAULT_PIXELS_PER_SECOND = 80
// Wheel-zoom sensitivity: zoom factor = exp(-deltaY_px * this). ~0.0012 makes a mouse notch (~100px)
// a gentle ~11% step while a trackpad's tiny deltas stay proportional (was a fixed ±10% per event).
const ZOOM_WHEEL_SENSITIVITY = 0.0012
const TIMELINE_PADDING_SECONDS = 5
const ZOOM_COLOR = '#f59e0b' // amber — matches the canvas framing rect + zoom panel
const EFFECT_COLOR = '#d946ef' // fuchsia — matches the effect panel header; distinct from violet video bars
const MARKER_COLOR = '#06b6d4' // cyan — distinct from amber zooms, the type colors, and the playhead
const SNAP_LINE_COLOR = '#ffffff' // the bright guide shown while a drag is actively snapped
// Swatches offered in the marker edit popover (spec 22 R17).
const MARKER_SWATCHES = ['#06b6d4', '#ef4444', '#22c55e', '#f59e0b', '#a855f7', '#ec4899']

// Short labels shown on the effect timeline bars (spec 23).
const EFFECT_BAR_LABEL: Record<VideoEffect['kind'], string> = {
  grayscale: 'B&W',
  sepia: 'Sepia',
  invert: 'Invert',
  vignette: 'Vignette',
  grain: 'Grain',
  oldfilm: 'Old Film',
  hue: 'Hue',
  contrast: 'Contrast',
  bleach: 'Bleach',
  lightleak: 'Light Leak',
  chromatic: 'Chromatic',
  pixelate: 'Pixelate',
  gradientmap: 'Gradient Map',
  posterize: 'Posterize',
  threshold: 'Duotone',
  channelswap: 'Channel Swap',
  colorisolate: 'Colour Isolate',
  dither: 'Dither',
  crt: 'CRT',
  vhs: 'VHS',
  halftone: 'Halftone',
  comic: 'Comic Ink',
}

/**
 * Assign each effect a display ROW so overlapping effects (e.g. a Sepia + a Vignette at the same
 * time) stack on separate lines in the Effects track instead of hiding each other (spec 23). Greedy
 * interval layout: each effect takes the first row free at its start. Display-only — the renderer
 * still stacks all active effects regardless of row.
 */
function layoutEffectRows(effects: VideoEffect[]): { rows: Map<string, number>; count: number } {
  // Pack in CREATION order (array order), NOT sorted by startTime. First-fit still guarantees no two
  // bars share a row while overlapping (a bar only takes a row whose last placement ended before it
  // starts). Sorting by start would re-rank rows when you drag one bar past another in time — the bar
  // would jump lanes on release, which reads as "the effect moved to a different track". Creation
  // order makes an effect's row depend only on effects created before it, so dragging is stable.
  const rowEnds: number[] = [] // end time of the last bar placed in each row
  const rows = new Map<string, number>()
  for (const e of effects) {
    const start = e.startTime
    const end = e.startTime + effectEnvelope(e)
    let r = rowEnds.findIndex((endT) => endT <= start + 1e-6)
    if (r === -1) { r = rowEnds.length; rowEnds.push(end) }
    else rowEnds[r] = end
    rows.set(e.id, r)
  }
  return { rows, count: Math.max(1, rowEnds.length) }
}

/** Bar label: text clips preview their actual content (newlines/runs collapsed to a single line, the
 *  bar's `truncate` clips overflow) rather than the generic object name; everything else uses `name`. */
function barLabel(obj: TimelineObject): string {
  if (obj.type === 'text') {
    const content = (obj.data as TextData).content?.replace(/\s+/g, ' ').trim()
    if (content) return content
  }
  return obj.name
}

const formatTime = (seconds: number): string => {
  const m = Math.floor(seconds / 60)
  const s = seconds % 60
  return `${m.toString().padStart(2, '0')}:${s.toFixed(1).padStart(4, '0')}`
}

const TYPE_COLORS: Record<string, string> = {
  photo: '#3b82f6',     // blue
  arrow: '#ef4444',     // red
  text: '#22c55e',      // green
  rectangle: '#f59e0b', // amber
  circle: '#a855f7',    // purple
  audio: '#14b8a6',     // teal
  video: '#8b5cf6',     // violet
  freehand: '#ec4899',  // pink
}

type DragState =
  | null
  // Move drags one clip OR a whole multi-selection together. `objectId` is the grabbed (primary)
  // clip that drives snapping; `group` holds every moving clip's original start/lane. Time + lane
  // deltas are computed once from the primary and applied to all, clamped so no member goes out of
  // bounds (dt floored so the earliest can't cross 0; laneDelta bounded by the group's lane extent).
  | { kind: 'move'; objectId: string; startMouseX: number; startMouseY: number; originalStartTime: number; group: { objectId: string; originalStartTime: number; originalLane: number }[]; minGroupStart: number; clampMinLaneDelta: number; clampMaxLaneDelta: number }
  | { kind: 'resize-left'; objectId: string; startMouseX: number; originalStartTime: number; originalDuration: number }
  | { kind: 'resize-right'; objectId: string; startMouseX: number; originalDuration: number }
  // Trim (spec 14 R8): rate-constant edge-drag on audio/video. Adjusts the source span + duration
  // (and startTime on the left edge, keeping the right timeline edge fixed) so playback speed is
  // preserved — the bottom half of the split edge handle.
  | { kind: 'trim-left'; objectId: string; startMouseX: number; originalStartTime: number; originalDuration: number; originalSourceIn: number; originalSourceOut: number; sourceMin: number }
  | { kind: 'trim-right'; objectId: string; startMouseX: number; originalDuration: number; originalSourceIn: number; originalSourceOut: number; sourceMax: number }
  | { kind: 'move-keyframe'; objectId: string; kfIndex: number; startMouseX: number; originalTime: number; minTime: number; maxTime: number }
  | { kind: 'playhead'; startMouseX: number; startTime: number }
  // Camera-zoom bars on the pinned Camera track (spec 13). Move shifts startTime; resizing
  // adjusts the zoom's `hold` (the flexible middle of the envelope), anchored at the opposite edge.
  | { kind: 'zoom-move'; zoomId: string; startMouseX: number; originalStartTime: number }
  | { kind: 'zoom-resize-right'; zoomId: string; startMouseX: number; originalHold: number }
  | { kind: 'zoom-resize-left'; zoomId: string; startMouseX: number; originalStartTime: number; originalHold: number }
  // Retime a single pan/scale keyframe within a zoom's hold (clamped between neighbors, [0, hold]).
  | { kind: 'zoom-move-keyframe'; zoomId: string; kfIndex: number; startMouseX: number; originalTime: number; minTime: number; maxTime: number }
  // Effect bars on the pinned Effects track (spec 23) — mirror the zoom bar drags.
  | { kind: 'effect-move'; effectId: string; startMouseX: number; originalStartTime: number }
  | { kind: 'effect-resize-right'; effectId: string; startMouseX: number; originalHold: number }
  | { kind: 'effect-resize-left'; effectId: string; startMouseX: number; originalStartTime: number; originalHold: number }
  // Drag a marker flag along the ruler to retime it (spec 22). A no-movement press is treated as a
  // click on mouse-up (seek + open the edit popover); a real drag retimes with snapping.
  | { kind: 'marker-move'; markerId: string; startMouseX: number; startClientY: number; originalTime: number }

/** Eye / eye-off glyph for the hide toggle (spec 14 R11). */
function EyeIcon({ off }: { off: boolean }) {
  return off ? <IconEyeOff size={12} stroke={2.2} /> : <IconEye size={12} stroke={2.2} />
}

export default function Timeline({
  objects,
  globalTime,
  totalDuration,
  selectedObjectIds,
  onSelectObject,
  onSeek,
  dispatch,
  zooms,
  selectedZoomId,
  onSelectZoom,
  effects,
  selectedEffectId,
  onSelectEffect,
  markers,
  onCollapse,
}: TimelineProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const [pixelsPerSecond, setPixelsPerSecond] = useState(DEFAULT_PIXELS_PER_SECOND)
  const [dragState, setDragState] = useState<DragState>(null)
  // Marker snapping (spec 22): the candidate time a live drag is currently locked onto (drives the
  // bright snap guide line); null when the drag isn't snapped. Cleared on mouse-up.
  const [snapLineTime, setSnapLineTime] = useState<number | null>(null)
  // The marker whose edit popover is open (label/color/delete), with a viewport anchor. Local to the
  // timeline — markers have no global selection state (spec 22 R17).
  const [editingMarker, setEditingMarker] = useState<{ id: string; left: number; top: number } | null>(null)
  // Track explicitly added lane boundaries (absolute lane numbers, not offsets)
  // null = no extra lanes beyond object range
  const [addedTopLane, setAddedTopLane] = useState<number | null>(null)
  const [addedBottomLane, setAddedBottomLane] = useState<number | null>(null)

  // Compute lane range from objects
  const objMinLane = objects.length > 0
    ? objects.reduce((min, obj) => Math.min(min, obj.lane), Infinity)
    : 0
  const objMaxLane = objects.length > 0
    ? objects.reduce((max, obj) => Math.max(max, obj.lane), -Infinity)
    : 0
  // Combine object range with explicitly added lanes
  const minLane = addedBottomLane !== null ? Math.min(objMinLane, addedBottomLane) : objMinLane
  const maxLane = addedTopLane !== null ? Math.max(objMaxLane, addedTopLane) : objMaxLane
  const laneCount = Math.max(maxLane - minLane + 1, 1)

  // Build array of lane numbers from bottom to top
  const lanes: number[] = []
  for (let l = minLane; l <= maxLane; l++) lanes.push(l)

  // Extend the view to reveal a marker placed past the end of all content (spec 22 R11). Markers
  // do NOT extend totalDuration/export length — only how far the timeline scrolls.
  const maxMarkerTime = (markers ?? []).reduce((mx, m) => Math.max(mx, m.time), 0)
  const viewDuration = Math.max(Math.max(totalDuration, maxMarkerTime) + TIMELINE_PADDING_SECONDS, 10)
  const timelineWidth = viewDuration * pixelsPerSecond

  const timeToX = useCallback((time: number) => time * pixelsPerSecond, [pixelsPerSecond])
  const xToTime = useCallback(
    (x: number) => Math.max(0, x / pixelsPerSecond),
    [pixelsPerSecond],
  )
  // Map a viewport clientX to a timeline time. The lane gutter now lives INSIDE the horizontal
  // scroll container (frozen via sticky-left, spec 16 A3), so content x=0 (time 0) sits
  // GUTTER_WIDTH past the container's left edge — subtract it (and add scrollLeft) before converting.
  const clientXToTime = useCallback((clientX: number) => {
    const el = containerRef.current
    if (!el) return 0
    const x = clientX - el.getBoundingClientRect().left + el.scrollLeft - GUTTER_WIDTH
    return xToTime(x)
  }, [xToTime])

  // Build the snap-target times for a drag (spec 22): t=0, the playhead, every marker time, and
  // every visible clip's start/end edge. Excludes the dragged item's own edges/time (so it never
  // sticks to itself) and hidden clips (you can't see them to align to).
  const buildSnapCandidates = useCallback(
    (opts: { excludeObjectId?: string; excludeObjectIds?: Set<string>; excludeMarkerId?: string; includePlayhead?: boolean }) => {
      const cands: number[] = [0]
      if (opts.includePlayhead !== false) cands.push(globalTime)
      for (const m of markers ?? []) {
        if (m.id !== opts.excludeMarkerId) cands.push(m.time)
      }
      for (const o of objects) {
        if (o.id === opts.excludeObjectId || opts.excludeObjectIds?.has(o.id) || o.hidden) continue
        cands.push(o.startTime, o.startTime + o.duration)
      }
      return cands
    },
    [objects, markers, globalTime],
  )

  // Time-zoom with Ctrl/Cmd + wheel (spec 16 A2). MUST be a native, non-passive listener: React's
  // onWheel is passive, so its preventDefault is ignored and the browser page-zooms instead (the
  // bug this replaces). Plain wheel falls through to the container's native horizontal + vertical
  // lane scroll. A ref keeps the once-attached listener reading the live pixelsPerSecond.
  const pixelsPerSecondRef = useRef(pixelsPerSecond)
  pixelsPerSecondRef.current = pixelsPerSecond
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return // let plain wheel scroll the lanes natively
      e.preventDefault()
      const prev = pixelsPerSecondRef.current
      // Zoom proportional to the actual scroll distance so trackpads (which fire many tiny deltas /
      // pinch events) aren't unusably fast. Normalize deltaMode to px, then clamp the per-event step.
      const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? el.clientHeight : 1
      const factor = Math.min(1.25, Math.max(0.8, Math.exp(-e.deltaY * unit * ZOOM_WHEEL_SENSITIVITY)))
      const next = Math.min(MAX_PIXELS_PER_SECOND, Math.max(MIN_PIXELS_PER_SECOND, prev * factor))
      if (next === prev) return
      // Keep the time under the cursor fixed: remember its content-x, restore scrollLeft after the
      // timeline width re-renders (browser clamps scrollLeft to valid range for us).
      const cursorX = e.clientX - el.getBoundingClientRect().left
      const t = (cursorX + el.scrollLeft - GUTTER_WIDTH) / prev
      setPixelsPerSecond(next)
      requestAnimationFrame(() => { el.scrollLeft = t * next - cursorX + GUTTER_WIDTH })
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [])

  // Click on ruler or empty area to seek
  const handleRulerClick = useCallback(
    (e: React.MouseEvent) => { onSeek(clientXToTime(e.clientX)) },
    [clientXToTime, onSeek],
  )

  // Lane management
  const handleAddLaneAbove = useCallback(() => {
    const currentMax = addedTopLane !== null ? Math.max(objMaxLane, addedTopLane) : objMaxLane
    setAddedTopLane(currentMax + 1)
  }, [objMaxLane, addedTopLane])

  const handleAddLaneBelow = useCallback(() => {
    const currentMin = addedBottomLane !== null ? Math.min(objMinLane, addedBottomLane) : objMinLane
    setAddedBottomLane(currentMin - 1)
  }, [objMinLane, addedBottomLane])

  const handleRemoveLane = useCallback((lane: number) => {
    const objectsOnLane = objects.filter((o) => o.lane === lane)
    if (objectsOnLane.length > 0) {
      dispatch({ type: 'REMOVE_LANE', lane })
    }
    // Shrink explicitly added lane boundaries
    if (addedTopLane !== null && lane >= objMaxLane) {
      const newTop = addedTopLane - 1
      setAddedTopLane(newTop > objMaxLane ? newTop : null)
    } else if (addedBottomLane !== null && lane <= objMinLane) {
      const newBottom = addedBottomLane + 1
      setAddedBottomLane(newBottom < objMinLane ? newBottom : null)
    }
  }, [objects, dispatch, objMaxLane, objMinLane, addedTopLane, addedBottomLane])

  // Mouse drag handling
  useEffect(() => {
    if (!dragState) return

    const handleMouseMove = (e: MouseEvent) => {
      const dx = e.clientX - dragState.startMouseX
      const dt = dx / pixelsPerSecond
      const alt = e.altKey // hold Alt to bypass snapping for this drag (spec 22 R14)

      if (dragState.kind === 'playhead') {
        const raw = Math.max(0, dragState.startTime + dt)
        const snap = snapTime(raw, buildSnapCandidates({ includePlayhead: false }), pixelsPerSecond, SNAP_THRESHOLD_PX, alt)
        setSnapLineTime(snap.snappedTo)
        onSeek(snap.time)
      } else if (dragState.kind === 'move') {
        const rawStart = Math.max(0, dragState.originalStartTime + dt)
        const obj = objects.find((o) => o.id === dragState.objectId)
        // Snapping is driven by the grabbed (primary) clip only; exclude the whole moving group so
        // members don't snap to each other.
        const groupIds = new Set(dragState.group.map((g) => g.objectId))
        const snap = snapClipMove(rawStart, obj?.duration ?? 0, buildSnapCandidates({ excludeObjectIds: groupIds }), pixelsPerSecond, SNAP_THRESHOLD_PX, alt)
        setSnapLineTime(snap.snappedTo)
        // Snapped → land exactly on the target; otherwise keep the gentle 0.1s quantize.
        const primaryStart = snap.snappedTo !== null ? snap.time : Math.round(rawStart * 10) / 10
        // The shared time delta the group moves by, derived from the primary and floored so the
        // earliest member can't slide past 0 (preserving relative spacing).
        let dtApplied = primaryStart - dragState.originalStartTime
        if (dragState.minGroupStart + dtApplied < 0) dtApplied = -dragState.minGroupStart
        // Shared lane delta, clamped to the group's collective lane extent.
        const dy = e.clientY - dragState.startMouseY
        const rawLaneDelta = Math.round(-dy / (LANE_HEIGHT + LANE_GAP))
        const laneDelta = Math.max(dragState.clampMinLaneDelta, Math.min(dragState.clampMaxLaneDelta, rawLaneDelta))
        // One transient dispatch per member — they collapse into a single undo entry on commit.
        for (const g of dragState.group) {
          dispatch({
            type: 'UPDATE_OBJECT_TRANSIENT',
            objectId: g.objectId,
            updates: { startTime: Math.round((g.originalStartTime + dtApplied) * 100) / 100, lane: g.originalLane + laneDelta },
          })
        }
      } else if (dragState.kind === 'resize-left') {
        const origEnd = dragState.originalStartTime + dragState.originalDuration
        // Only non-media objects reach resize-left now (media edges trim instead), so no rate clamp.
        const rawStart = Math.max(0, Math.min(origEnd - 0.1, dragState.originalStartTime + dt))
        const snap = snapTime(rawStart, buildSnapCandidates({ excludeObjectId: dragState.objectId }), pixelsPerSecond, SNAP_THRESHOLD_PX, alt)
        setSnapLineTime(snap.snappedTo)
        // Right edge stays fixed: derive duration exactly from the (snapped) left edge.
        const newStart = snap.snappedTo !== null
          ? Math.max(0, Math.min(origEnd - 0.1, snap.time))
          : Math.round(rawStart * 10) / 10
        const newDuration = snap.snappedTo !== null
          ? origEnd - newStart
          : Math.round((origEnd - newStart) * 10) / 10
        const obj = objects.find((o) => o.id === dragState.objectId)
        const clampedAnimateIn = obj ? Math.min(obj.animateIn, newDuration) : undefined
        dispatch({
          type: 'UPDATE_OBJECT',
          objectId: dragState.objectId,
          updates: { startTime: newStart, duration: newDuration, ...(clampedAnimateIn !== undefined && { animateIn: clampedAnimateIn }) },
        })
      } else if (dragState.kind === 'resize-right') {
        // Only non-media objects reach resize-right now (media edges trim instead), so no rate clamp.
        const obj = objects.find((o) => o.id === dragState.objectId)
        const startT = obj?.startTime ?? 0 // left edge is fixed during a right-resize
        const rawRight = startT + Math.max(0.1, dragState.originalDuration + dt)
        const snap = snapTime(rawRight, buildSnapCandidates({ excludeObjectId: dragState.objectId }), pixelsPerSecond, SNAP_THRESHOLD_PX, alt)
        setSnapLineTime(snap.snappedTo)
        const newDuration = snap.snappedTo !== null
          ? Math.max(0.1, snap.time - startT)
          : Math.round(Math.max(0.1, dragState.originalDuration + dt) * 10) / 10
        const clampedAnimateIn = obj ? Math.min(obj.animateIn, newDuration) : undefined
        dispatch({
          type: 'UPDATE_OBJECT',
          objectId: dragState.objectId,
          updates: { duration: newDuration, ...(clampedAnimateIn !== undefined && { animateIn: clampedAnimateIn }) },
        })
      } else if (dragState.kind === 'trim-left') {
        // Left-trim: rate constant, right timeline edge fixed. Shorten/lengthen from the left by
        // shifting startTime + duration and revealing a different sourceIn. Bounded sourceIn ≥ 0.
        const origSpan = dragState.originalSourceOut - dragState.originalSourceIn
        const rate = origSpan / dragState.originalDuration
        const rightEdge = dragState.originalStartTime + dragState.originalDuration
        // duration ≤ (originalSourceOut-sourceMin)/rate keeps sourceIn ≥ sourceMin (window floor);
        // duration ≤ rightEdge keeps startTime ≥ 0.
        const maxDur = Math.min((dragState.originalSourceOut - dragState.sourceMin) / rate, rightEdge)
        // Snap the moving LEFT edge to nearby targets ("trim to the beat", spec 22 R13).
        const rawStart = dragState.originalStartTime + dt
        const snap = snapTime(rawStart, buildSnapCandidates({ excludeObjectId: dragState.objectId }), pixelsPerSecond, SNAP_THRESHOLD_PX, alt)
        setSnapLineTime(snap.snappedTo)
        const rawDur = rightEdge - (snap.snappedTo !== null ? snap.time : rawStart)
        const newDuration = snap.snappedTo !== null
          ? Math.max(0.1, Math.min(maxDur, rawDur))
          : Math.round(Math.max(0.1, Math.min(maxDur, rawDur)) * 100) / 100
        const newSourceIn = Math.max(dragState.sourceMin, dragState.originalSourceOut - rate * newDuration)
        const newStart = snap.snappedTo !== null ? rightEdge - newDuration : Math.round((rightEdge - newDuration) * 100) / 100
        const obj = objects.find((o) => o.id === dragState.objectId)
        if (obj) {
          dispatch({
            type: 'UPDATE_OBJECT_TRANSIENT',
            objectId: dragState.objectId,
            updates: {
              startTime: newStart,
              duration: newDuration,
              animateIn: Math.min(obj.animateIn, newDuration),
              data: { ...(obj.data as AudioData | VideoData), sourceIn: newSourceIn, sourceOut: dragState.originalSourceOut },
            },
          })
        }
      } else if (dragState.kind === 'trim-right') {
        // Right-trim: rate constant, startTime fixed. Reveal a different sourceOut. Bounded by the
        // clip's window ceil (sourceOut ≤ sourceMax; = the asset length for un-split clips).
        const origSpan = dragState.originalSourceOut - dragState.originalSourceIn
        const rate = origSpan / dragState.originalDuration
        const maxDur = (dragState.sourceMax - dragState.originalSourceIn) / rate
        const obj = objects.find((o) => o.id === dragState.objectId)
        const startT = obj?.startTime ?? 0 // startTime is fixed during a right-trim
        // Snap the moving RIGHT edge to nearby targets ("trim to the beat", spec 22 R13).
        const rawRight = startT + (dragState.originalDuration + dt)
        const snap = snapTime(rawRight, buildSnapCandidates({ excludeObjectId: dragState.objectId }), pixelsPerSecond, SNAP_THRESHOLD_PX, alt)
        setSnapLineTime(snap.snappedTo)
        const rawDur = (snap.snappedTo !== null ? snap.time : rawRight) - startT
        const newDuration = snap.snappedTo !== null
          ? Math.max(0.1, Math.min(maxDur, rawDur))
          : Math.round(Math.max(0.1, Math.min(maxDur, rawDur)) * 100) / 100
        const newSourceOut = Math.min(dragState.sourceMax, dragState.originalSourceIn + rate * newDuration)
        if (obj) {
          dispatch({
            type: 'UPDATE_OBJECT_TRANSIENT',
            objectId: dragState.objectId,
            updates: {
              duration: newDuration,
              animateIn: Math.min(obj.animateIn, newDuration),
              data: { ...(obj.data as AudioData | VideoData), sourceIn: dragState.originalSourceIn, sourceOut: newSourceOut },
            },
          })
        }
      } else if (dragState.kind === 'move-keyframe') {
        // Below the click threshold, dispatch nothing — a pure click stays a click (seeks on mouse-up).
        if (Math.abs(e.clientX - dragState.startMouseX) < 3) return
        // Retime a single keyframe; clamped between its neighbors so the order never flips.
        const raw = dragState.originalTime + dt
        const t = Math.round(Math.max(dragState.minTime, Math.min(dragState.maxTime, raw)) * 100) / 100
        const obj = objects.find((o) => o.id === dragState.objectId)
        if (obj?.keyframes) {
          dispatch({
            type: 'UPDATE_OBJECT_TRANSIENT',
            objectId: dragState.objectId,
            updates: { keyframes: obj.keyframes.map((k, j) => (j === dragState.kfIndex ? { ...k, time: t } : k)) },
          })
        }
      } else if (dragState.kind === 'zoom-move') {
        const raw = Math.max(0, dragState.originalStartTime + dt)
        const snap = snapTime(raw, buildSnapCandidates({}), pixelsPerSecond, SNAP_THRESHOLD_PX, alt)
        setSnapLineTime(snap.snappedTo)
        const newStart = snap.snappedTo !== null ? snap.time : Math.round(raw * 10) / 10
        dispatch({ type: 'UPDATE_ZOOM_TRANSIENT', zoomId: dragState.zoomId, updates: { startTime: newStart } })
      } else if (dragState.kind === 'zoom-resize-right') {
        // Grow/shrink the hold; start + transitions stay put.
        const newHold = Math.round(Math.max(0, dragState.originalHold + dt) * 10) / 10
        dispatch({ type: 'UPDATE_ZOOM_TRANSIENT', zoomId: dragState.zoomId, updates: { hold: newHold } })
      } else if (dragState.kind === 'zoom-resize-left') {
        // Move the start while keeping the right edge fixed → hold shrinks by the same amount.
        // Clamp so hold never goes negative (start can't cross the fixed end).
        const clampedDt = Math.max(-dragState.originalStartTime, Math.min(dragState.originalHold, dt))
        const newStart = Math.round((dragState.originalStartTime + clampedDt) * 10) / 10
        const newHold = Math.round((dragState.originalHold - clampedDt) * 10) / 10
        dispatch({ type: 'UPDATE_ZOOM_TRANSIENT', zoomId: dragState.zoomId, updates: { startTime: newStart, hold: newHold } })
      } else if (dragState.kind === 'zoom-move-keyframe') {
        // Below the click threshold, dispatch nothing — a pure click stays a click (seeks on mouse-up).
        if (Math.abs(e.clientX - dragState.startMouseX) < 3) return
        // Retime one pan/scale keyframe; clamped between neighbors so the order never flips.
        const raw = dragState.originalTime + dt
        const t = Math.round(Math.max(dragState.minTime, Math.min(dragState.maxTime, raw)) * 100) / 100
        const zoom = (zooms ?? []).find((z) => z.id === dragState.zoomId)
        if (zoom?.keyframes) {
          dispatch({
            type: 'UPDATE_ZOOM_TRANSIENT',
            zoomId: dragState.zoomId,
            updates: { keyframes: zoom.keyframes.map((k, j) => (j === dragState.kfIndex ? { ...k, time: t } : k)) },
          })
        }
      } else if (dragState.kind === 'effect-move') {
        const raw = Math.max(0, dragState.originalStartTime + dt)
        const snap = snapTime(raw, buildSnapCandidates({}), pixelsPerSecond, SNAP_THRESHOLD_PX, alt)
        setSnapLineTime(snap.snappedTo)
        const newStart = snap.snappedTo !== null ? snap.time : Math.round(raw * 10) / 10
        dispatch({ type: 'UPDATE_EFFECT_TRANSIENT', effectId: dragState.effectId, updates: { startTime: newStart } })
      } else if (dragState.kind === 'effect-resize-right') {
        const newHold = Math.round(Math.max(0, dragState.originalHold + dt) * 10) / 10
        dispatch({ type: 'UPDATE_EFFECT_TRANSIENT', effectId: dragState.effectId, updates: { hold: newHold } })
      } else if (dragState.kind === 'effect-resize-left') {
        const clampedDt = Math.max(-dragState.originalStartTime, Math.min(dragState.originalHold, dt))
        const newStart = Math.round((dragState.originalStartTime + clampedDt) * 10) / 10
        const newHold = Math.round((dragState.originalHold - clampedDt) * 10) / 10
        dispatch({ type: 'UPDATE_EFFECT_TRANSIENT', effectId: dragState.effectId, updates: { startTime: newStart, hold: newHold } })
      } else if (dragState.kind === 'marker-move') {
        // Below the click threshold, dispatch nothing — a pure click stays a click (no stray
        // transient to commit). Past it, retime with snapping (same targets clips use, minus self).
        if (Math.abs(e.clientX - dragState.startMouseX) < 3) return
        const raw = Math.max(0, dragState.originalTime + dt)
        const snap = snapTime(raw, buildSnapCandidates({ excludeMarkerId: dragState.markerId }), pixelsPerSecond, SNAP_THRESHOLD_PX, alt)
        setSnapLineTime(snap.snappedTo)
        const newTime = snap.snappedTo !== null ? snap.time : Math.round(raw * 10) / 10
        dispatch({ type: 'UPDATE_MARKER_TRANSIENT', markerId: dragState.markerId, updates: { time: newTime } })
      }
    }

    const handleMouseUp = (e: MouseEvent) => {
      if (dragState.kind === 'marker-move') {
        // Commit any retime (safe no-op for a pure click, where no transient ever fired). A press
        // with no real movement is a click: seek to the marker + open its edit popover (R9/R17).
        dispatch({ type: 'COMMIT_TRANSIENT' })
        if (Math.abs(e.clientX - dragState.startMouseX) < 3) {
          const m = (markers ?? []).find((mk) => mk.id === dragState.markerId)
          if (m) {
            onSeek(m.time)
            setEditingMarker({ id: m.id, left: e.clientX, top: dragState.startClientY + 12 })
          }
        }
      } else if (dragState.kind === 'move-keyframe') {
        dispatch({ type: 'COMMIT_TRANSIENT' })
        // A press with no real movement is a click: jump the playhead to the keyframe.
        if (Math.abs(e.clientX - dragState.startMouseX) < 3) {
          const obj = objects.find((o) => o.id === dragState.objectId)
          if (obj) onSeek(obj.startTime + dragState.originalTime)
        }
      } else if (dragState.kind === 'zoom-move-keyframe') {
        dispatch({ type: 'COMMIT_TRANSIENT' })
        // Click (no real movement): jump the playhead to the keyframe (hold-relative → absolute).
        if (Math.abs(e.clientX - dragState.startMouseX) < 3) {
          const zoom = (zooms ?? []).find((z) => z.id === dragState.zoomId)
          if (zoom) onSeek(zoom.startTime + zoom.transitionIn + dragState.originalTime)
        }
      } else if (dragState.kind === 'move') {
        dispatch({ type: 'COMMIT_TRANSIENT' })
        // A press with no real movement is a click, not a drag: collapse a multi-selection down to
        // just the grabbed clip (pick one out of the group). A real drag keeps the whole selection.
        const moved = Math.abs(e.clientX - dragState.startMouseX) >= 3 || Math.abs(e.clientY - dragState.startMouseY) >= 3
        if (!moved) onSelectObject(dragState.objectId)
      } else if (
        dragState.kind === 'trim-left' || dragState.kind === 'trim-right' ||
        dragState.kind === 'zoom-move' || dragState.kind === 'zoom-resize-right' || dragState.kind === 'zoom-resize-left' ||
        dragState.kind === 'effect-move' || dragState.kind === 'effect-resize-right' || dragState.kind === 'effect-resize-left'
      ) {
        dispatch({ type: 'COMMIT_TRANSIENT' })
      }
      setSnapLineTime(null)
      frozenEffectLayoutRef.current = null // release the pinned effect layout so rows re-pack to final
      setDragState(null)
    }

    window.addEventListener('mousemove', handleMouseMove)
    window.addEventListener('mouseup', handleMouseUp)
    return () => {
      window.removeEventListener('mousemove', handleMouseMove)
      window.removeEventListener('mouseup', handleMouseUp)
    }
  }, [dragState, pixelsPerSecond, dispatch, onSeek, onSelectObject, minLane, maxLane, objects, zooms, effects, markers, buildSnapCandidates])

  // Render ruler ticks
  const ticks: { time: number; label: string; major: boolean }[] = []
  // Keep labels from crowding as you zoom out: widen the tick interval at lower px/s.
  const tickInterval =
    pixelsPerSecond >= 100 ? 1 :
    pixelsPerSecond >= 40 ? 2 :
    pixelsPerSecond >= 20 ? 5 :
    pixelsPerSecond >= 10 ? 10 :
    pixelsPerSecond >= 5 ? 30 :
    60
  for (let t = 0; t <= viewDuration; t += tickInterval) {
    ticks.push({ time: t, label: `${t}s`, major: t % (tickInterval * 2) === 0 })
  }

  const trackHeight = laneCount * (LANE_HEIGHT + LANE_GAP) + LANE_GAP

  // Effect display rows (spec 23): overlapping effects stack so both stay visible + grabbable. The
  // Effects track grows to fit the row count; its gutter label matches so the columns stay aligned.
  // The layout is greedy over startTime, so it would RESHUFFLE mid-drag as a bar's start changes —
  // making the grabbed bar jump rows (reads as "the selection jumped to another effect"). While an
  // effect drag is active we hold the pre-drag layout frozen, then recompute on release.
  const frozenEffectLayoutRef = useRef<{ rows: Map<string, number>; count: number } | null>(null)
  const { rows: effectRowMap, count: effectRowCount } = frozenEffectLayoutRef.current ?? layoutEffectRows(effects ?? [])
  const effectsTrackHeight = effectRowCount * EFFECT_ROW_HEIGHT

  // Helper: visual Y position for a lane number
  const laneToY = (lane: number) => {
    const laneIndex = lane - minLane
    return (laneCount - 1 - laneIndex) * (LANE_HEIGHT + LANE_GAP) + LANE_GAP
  }

  return (
    <div className="h-full bg-surface border-t border-border select-none flex flex-col isolate">
      {/* Single scroll container drives BOTH axes (spec 16 A): horizontal time-scroll + vertical
          lane-scroll. Ruler + Camera track are pinned via sticky-top (frozen header) and the lane
          gutter via sticky-left (frozen column), so adding lanes scrolls instead of squishing the render. */}
      <div
        ref={containerRef}
        className="flex-1 min-h-0 overflow-auto"
      >
        <div className="flex" style={{ width: GUTTER_WIDTH + timelineWidth }}>
          {/* Lane gutter — frozen to the left (sticky). Its top two cells (collapse + Camera label)
              are also sticky-top so they stay aligned with the pinned ruler/Camera track. z-[70] keeps
              it above every scrolling bar child (bars use up to z-50) so nothing bleeds over it. */}
          <div className="sticky left-0 z-[70] flex-shrink-0 flex flex-col bg-surface" style={{ width: GUTTER_WIDTH }}>
            {/* Collapse chevron — pinned (sticky top) with the ruler (spec 16 B3) */}
            <button
              onClick={onCollapse}
              className="sticky top-0 z-10 w-full flex items-center justify-center bg-surface-muted border-b border-r border-border text-subtle hover:text-fg transition-colors cursor-pointer"
              style={{ height: RULER_HEIGHT }}
              title="Collapse timeline"
            >
              <IconChevronDown size={14} stroke={2} />
            </button>

            {/* Camera track label — pinned (sticky) below the ruler (spec 13) */}
            <div
              className="sticky z-10 w-full flex items-center justify-center border-b border-r border-border text-camera bg-surface"
              style={{ height: CAMERA_TRACK_HEIGHT, top: RULER_HEIGHT }}
              title="Camera zooms"
            >
              <IconViewfinder size={15} stroke={2} />
            </div>

            {/* Effects track label — pinned (sticky) below the Camera track (spec 23) */}
            <div
              className="sticky z-10 w-full flex items-center justify-center border-b border-r border-border bg-surface"
              style={{ height: effectsTrackHeight, top: RULER_HEIGHT + CAMERA_TRACK_HEIGHT, color: EFFECT_COLOR }}
              title="Video effects"
            >
              <IconSparkles size={15} stroke={2} />
            </div>

            {/* Add lane above CTA (dedicated blank lane row) */}
            <button
              onClick={handleAddLaneAbove}
              className="w-full flex items-center justify-center border-r border-border text-subtle hover:text-accent hover:bg-accent-soft transition-colors cursor-pointer"
              style={{ height: LANE_HEIGHT }}
              title="Add lane above"
            >
              <IconPlus size={15} stroke={2.5} />
            </button>

            {/* Lane controls */}
            <div className="relative border-r border-border" style={{ height: trackHeight }}>
              {/* Per-lane remove buttons */}
              {lanes.map((lane) => {
                const y = laneToY(lane)
                const hasObjects = objects.some((o) => o.lane === lane)
                return (
                  <button
                    key={lane}
                    onClick={() => handleRemoveLane(lane)}
                    disabled={laneCount <= 1}
                    className="absolute left-0 w-full flex items-center justify-center text-subtle hover:text-danger hover:bg-danger-soft disabled:opacity-0 disabled:pointer-events-none transition-colors cursor-pointer"
                    style={{ top: y, height: LANE_HEIGHT }}
                    title={hasObjects ? 'Remove lane (objects move up)' : 'Remove empty lane'}
                  >
                    <IconX size={14} stroke={2} />
                  </button>
                )
              })}
            </div>

            {/* Add lane below CTA (dedicated blank lane row) */}
            <button
              onClick={handleAddLaneBelow}
              className="w-full flex items-center justify-center border-r border-border text-subtle hover:text-accent hover:bg-accent-soft transition-colors cursor-pointer"
              style={{ height: LANE_HEIGHT }}
              title="Add lane below"
            >
              <IconPlus size={15} stroke={2.5} />
            </button>
          </div>

          {/* Content column: ruler + Camera track + lanes. Scrolls (both axes) under the frozen gutter. */}
          <div style={{ width: timelineWidth, position: 'relative' }}>
            {/* Ruler (pinned top) — z-[60] sits above scrolling bar children (≤ z-50) so lanes
                scrolling underneath are hidden by the opaque ruler. */}
            <div
              className="sticky top-0 z-[60] bg-surface-muted border-b border-border cursor-pointer"
              style={{ height: RULER_HEIGHT }}
              onMouseDown={(e) => {
                handleRulerClick(e)
                setDragState({ kind: 'playhead', startMouseX: e.clientX, startTime: clientXToTime(e.clientX) })
              }}
            >
              {ticks.map((tick) => (
                <div
                  key={tick.time}
                  className="absolute top-0"
                  style={{ left: timeToX(tick.time) }}
                >
                  <div
                    className={`w-px ${tick.major ? 'h-3 bg-subtle' : 'h-2 bg-border-strong'}`}
                    style={{ marginTop: tick.major ? 0 : 4 }}
                  />
                  {tick.major && (
                    <span className="absolute text-[10px] text-subtle -translate-x-1/2" style={{ top: 12 }}>
                      {tick.label}
                    </span>
                  )}
                </div>
              ))}

              {/* Marker flags (spec 22) — live in the ruler so they stay pinned during vertical lane
                  scroll. Left edge sits exactly on the marker time (the guide line renders separately
                  down through the lanes). Drag to retime; a click (no move) seeks + opens the popover. */}
              {(markers ?? []).map((m) => {
                const color = m.color ?? MARKER_COLOR
                const isActive = dragState?.kind === 'marker-move' && dragState.markerId === m.id
                return (
                  <div
                    key={m.id}
                    className="absolute top-0 z-10 cursor-grab active:cursor-grabbing"
                    style={{ left: timeToX(m.time), height: RULER_HEIGHT }}
                    title={m.label || 'Marker — click to edit, drag to move'}
                    onMouseDown={(e) => {
                      e.stopPropagation()
                      setDragState({ kind: 'marker-move', markerId: m.id, startMouseX: e.clientX, startClientY: e.clientY, originalTime: m.time })
                    }}
                  >
                    <div
                      className="absolute top-1 left-0 flex items-center h-3.5 rounded-r-sm rounded-bl-sm px-1"
                      style={{ background: color, minWidth: 8, boxShadow: isActive ? '0 0 0 2px #fff' : '0 1px 2px rgba(0,0,0,0.4)' }}
                    >
                      {m.label && (
                        <span className="text-[9px] font-semibold text-black/90 leading-none whitespace-nowrap max-w-[110px] truncate">
                          {m.label}
                        </span>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>

            {/* Camera track (pinned top, spec 13): zoom envelope bars — not an object lane. Opaque
                background (amber wash over gray-900) so lanes scrolling under it are hidden; z-[60]
                like the ruler. Zoom-bar children (z-50) are confined inside this stacking context. */}
            <div
              className="sticky z-[60] border-b border-border"
              style={{ height: CAMERA_TRACK_HEIGHT, top: RULER_HEIGHT, background: 'linear-gradient(rgba(245,158,11,0.08), rgba(245,158,11,0.08)), var(--surface-muted)' }}
              onMouseDown={(e) => {
                // Click empty camera track: deselect any zoom + seek
                if (e.target === e.currentTarget) {
                  onSelectZoom(null)
                  onSeek(clientXToTime(e.clientX))
                }
              }}
            >
              {(zooms ?? []).map((zoom) => {
                const env = zoomEnvelope(zoom)
                const left = timeToX(zoom.startTime)
                const width = Math.max(timeToX(env), 8)
                const inW = timeToX(zoom.transitionIn)
                const outW = timeToX(zoom.transitionOut)
                const isSelected = zoom.id === selectedZoomId
                return (
                  <div
                    key={zoom.id}
                    className="absolute top-0 group"
                    style={{ left, top: 2, width, height: CAMERA_TRACK_HEIGHT - 4 }}
                  >
                    {/* Left resize handle (adjusts hold, right edge fixed) */}
                    <div
                      className="absolute left-0 top-0 w-1.5 h-full cursor-col-resize z-40 hover:bg-white/40"
                      onMouseDown={(e) => {
                        e.stopPropagation()
                        onSelectZoom(zoom.id)
                        setDragState({ kind: 'zoom-resize-left', zoomId: zoom.id, startMouseX: e.clientX, originalStartTime: zoom.startTime, originalHold: zoom.hold })
                      }}
                    />

                    {/* Bar body (drag to retime) */}
                    <div
                      className="absolute inset-0 rounded-sm overflow-hidden cursor-grab active:cursor-grabbing"
                      style={{
                        backgroundColor: ZOOM_COLOR,
                        // Hidden zooms (spec 14 R11.3) render dimmed + dashed on the Camera track.
                        opacity: zoom.hidden ? 0.35 : isSelected ? 1 : 0.72,
                        outline: isSelected ? '2px solid white' : zoom.hidden ? '1px dashed rgba(255,255,255,0.7)' : 'none',
                        outlineOffset: -1,
                      }}
                      onMouseDown={(e) => {
                        e.stopPropagation()
                        onSelectZoom(zoom.id)
                        setDragState({ kind: 'zoom-move', zoomId: zoom.id, startMouseX: e.clientX, originalStartTime: zoom.startTime })
                      }}
                    >
                      {/* transition-in ramp (left) */}
                      {zoom.transitionIn > 0 && (
                        <div
                          className="absolute top-0 left-0 h-full pointer-events-none"
                          style={{ width: Math.min(inW, width), background: 'linear-gradient(90deg, rgba(0,0,0,0.4), transparent)' }}
                        />
                      )}
                      {/* transition-out ramp (right) */}
                      {zoom.transitionOut > 0 && (
                        <div
                          className="absolute top-0 right-0 h-full pointer-events-none"
                          style={{ width: Math.min(outW, width), background: 'linear-gradient(270deg, rgba(0,0,0,0.4), transparent)' }}
                        />
                      )}
                      <span className="relative text-[10px] text-black/90 px-1.5 truncate leading-7 pointer-events-none font-semibold">
                        ⛶ {zoom.scale.toFixed(1)}×
                      </span>
                    </div>

                    {/* Right resize handle (adjusts hold, left edge fixed) */}
                    <div
                      className="absolute right-0 top-0 w-2 h-full cursor-col-resize z-40"
                      style={{ background: 'rgba(255,255,255,0.25)' }}
                      onMouseEnter={(e) => { if (!dragState) (e.currentTarget.style.background = 'rgba(255,255,255,0.5)') }}
                      onMouseLeave={(e) => { (e.currentTarget.style.background = 'rgba(255,255,255,0.25)') }}
                      onMouseDown={(e) => {
                        e.stopPropagation()
                        onSelectZoom(zoom.id)
                        setDragState({ kind: 'zoom-resize-right', zoomId: zoom.id, startMouseX: e.clientX, originalHold: zoom.hold })
                      }}
                    />

                    {/* Hide toggle for the zoom (spec 14 R11.3) — revealed on hover; always shown when hidden. */}
                    <button
                      className={`absolute top-0.5 z-50 flex items-center justify-center rounded text-black hover:bg-white/40 ${zoom.hidden ? 'opacity-100 bg-white/40' : 'opacity-0 group-hover:opacity-100'}`}
                      style={{ right: 11, width: 16, height: 16 }}
                      title={zoom.hidden ? 'Show zoom (H)' : 'Hide zoom (H)'}
                      onMouseDown={(e) => {
                        e.stopPropagation()
                        dispatch({ type: 'UPDATE_ZOOM', zoomId: zoom.id, updates: { hidden: !zoom.hidden } })
                      }}
                    >
                      <EyeIcon off={!!zoom.hidden} />
                    </button>

                    {/* Lead-in ramps (spec 21): the moving window [time - leadIn, time] before each
                        diamond, so a hold-then-move keyframe reads distinct from a fill-the-gap one. */}
                    {(zoom.keyframes ?? []).map((k, i) => {
                      const zkfs = zoom.keyframes!
                      const prev = i > 0 ? zkfs[i - 1].time : 0
                      const gap = k.time - prev
                      const lead = k.leadIn == null ? gap : Math.min(k.leadIn, gap)
                      if (lead <= 0.001) return null
                      return (
                        <div
                          key={`zlead-${i}`}
                          className="absolute top-1/2 -translate-y-1/2 h-1.5 z-20 pointer-events-none rounded-sm"
                          style={{
                            left: timeToX(zoom.transitionIn + (k.time - lead)),
                            width: Math.max(timeToX(lead), 1),
                            background: `linear-gradient(90deg, transparent, ${keyframeColor(i)})`,
                            opacity: 0.5,
                          }}
                        />
                      )
                    })}

                    {/* Pan/scale keyframe diamonds over the hold — drag to retime (clamped to
                        neighbors and [0, hold]). Positioned from the bar's left edge by
                        transitionIn + the keyframe's hold-relative time. */}
                    {(zoom.keyframes ?? []).map((k, i) => {
                      const zkfs = zoom.keyframes!
                      let minTime = i > 0 ? zkfs[i - 1].time + 0.05 : 0
                      let maxTime = i < zkfs.length - 1 ? zkfs[i + 1].time - 0.05 : zoom.hold
                      if (minTime > maxTime) { const m = (minTime + maxTime) / 2; minTime = m; maxTime = m }
                      const isActive = dragState?.kind === 'zoom-move-keyframe' && dragState.zoomId === zoom.id && dragState.kfIndex === i
                      return (
                        <div
                          key={i}
                          className="absolute top-1/2 w-2.5 h-2.5 border border-black/60 z-30 cursor-ew-resize"
                          style={{
                            left: timeToX(zoom.transitionIn + k.time),
                            background: keyframeColor(i),
                            transform: 'translate(-50%, -50%) rotate(45deg)',
                            boxShadow: isActive ? '0 0 0 2px #fff' : 'none',
                          }}
                          title={`Keyframe ${i + 1} @ ${k.time.toFixed(2)}s into the hold — drag to retime`}
                          onMouseDown={(e) => {
                            e.stopPropagation()
                            onSelectZoom(zoom.id)
                            setDragState({
                              kind: 'zoom-move-keyframe',
                              zoomId: zoom.id,
                              kfIndex: i,
                              startMouseX: e.clientX,
                              originalTime: k.time,
                              minTime,
                              maxTime,
                            })
                          }}
                        />
                      )
                    })}
                  </div>
                )
              })}
            </div>

            {/* Effects track (pinned top, spec 23): colour/overlay effect envelope bars. Mirrors the
                Camera track (violet wash), sitting directly below it at top = ruler + camera height. */}
            <div
              className="sticky z-[60] border-b border-border"
              style={{ height: effectsTrackHeight, top: RULER_HEIGHT + CAMERA_TRACK_HEIGHT, background: 'linear-gradient(rgba(217,70,239,0.08), rgba(217,70,239,0.08)), var(--surface-muted)' }}
              onMouseDown={(e) => {
                // Click empty effects track: deselect any effect + seek
                if (e.target === e.currentTarget) {
                  onSelectEffect(null)
                  onSeek(clientXToTime(e.clientX))
                }
              }}
            >
              {(effects ?? []).map((effect) => {
                const env = effectEnvelope(effect)
                const left = timeToX(effect.startTime)
                const width = Math.max(timeToX(env), 8)
                const inW = timeToX(effect.transitionIn)
                const outW = timeToX(effect.transitionOut)
                const isSelected = effect.id === selectedEffectId
                const row = effectRowMap.get(effect.id) ?? 0
                return (
                  <div
                    key={effect.id}
                    className="absolute top-0 group"
                    style={{ left, top: 2 + row * EFFECT_ROW_HEIGHT, width, height: EFFECT_ROW_HEIGHT - 4 }}
                  >
                    {/* Left resize handle (adjusts hold, right edge fixed) */}
                    <div
                      className="absolute left-0 top-0 w-1.5 h-full cursor-col-resize z-40 hover:bg-white/40"
                      onMouseDown={(e) => {
                        e.stopPropagation()
                        onSelectEffect(effect.id)
                        frozenEffectLayoutRef.current = layoutEffectRows(effects ?? [])
                        setDragState({ kind: 'effect-resize-left', effectId: effect.id, startMouseX: e.clientX, originalStartTime: effect.startTime, originalHold: effect.hold })
                      }}
                    />

                    {/* Bar body (drag to retime) */}
                    <div
                      className="absolute inset-0 rounded-sm overflow-hidden cursor-grab active:cursor-grabbing"
                      style={{
                        backgroundColor: EFFECT_COLOR,
                        opacity: effect.hidden ? 0.35 : isSelected ? 1 : 0.72,
                        outline: isSelected ? '2px solid #fff' : effect.hidden ? '1px dashed rgba(255,255,255,0.7)' : 'none',
                        outlineOffset: -1,
                        boxShadow: isSelected ? '0 0 0 2px #0ea5e9, 0 0 12px 2px rgba(14,165,233,0.6)' : undefined,
                        zIndex: isSelected ? 30 : undefined,
                      }}
                      onMouseDown={(e) => {
                        e.stopPropagation()
                        onSelectEffect(effect.id)
                        frozenEffectLayoutRef.current = layoutEffectRows(effects ?? [])
                        setDragState({ kind: 'effect-move', effectId: effect.id, startMouseX: e.clientX, originalStartTime: effect.startTime })
                      }}
                    >
                      {effect.transitionIn > 0 && (
                        <div
                          className="absolute top-0 left-0 h-full pointer-events-none"
                          style={{ width: Math.min(inW, width), background: 'linear-gradient(90deg, rgba(0,0,0,0.4), transparent)' }}
                        />
                      )}
                      {effect.transitionOut > 0 && (
                        <div
                          className="absolute top-0 right-0 h-full pointer-events-none"
                          style={{ width: Math.min(outW, width), background: 'linear-gradient(270deg, rgba(0,0,0,0.4), transparent)' }}
                        />
                      )}
                      <span className="relative text-[10px] text-white px-1.5 truncate pointer-events-none font-semibold" style={{ lineHeight: `${EFFECT_ROW_HEIGHT - 4}px` }}>
                        {EFFECT_BAR_LABEL[effect.kind]}
                      </span>
                    </div>

                    {/* Right resize handle (adjusts hold, left edge fixed) */}
                    <div
                      className="absolute right-0 top-0 w-2 h-full cursor-col-resize z-40"
                      style={{ background: 'rgba(255,255,255,0.25)' }}
                      onMouseEnter={(e) => { if (!dragState) (e.currentTarget.style.background = 'rgba(255,255,255,0.5)') }}
                      onMouseLeave={(e) => { (e.currentTarget.style.background = 'rgba(255,255,255,0.25)') }}
                      onMouseDown={(e) => {
                        e.stopPropagation()
                        onSelectEffect(effect.id)
                        frozenEffectLayoutRef.current = layoutEffectRows(effects ?? [])
                        setDragState({ kind: 'effect-resize-right', effectId: effect.id, startMouseX: e.clientX, originalHold: effect.hold })
                      }}
                    />

                    {/* Hide toggle — revealed on hover; always shown when hidden (parity with zooms). */}
                    <button
                      className={`absolute top-0.5 z-50 flex items-center justify-center rounded text-white hover:bg-white/40 ${effect.hidden ? 'opacity-100 bg-white/40' : 'opacity-0 group-hover:opacity-100'}`}
                      style={{ right: 11, width: 16, height: 16 }}
                      title={effect.hidden ? 'Show effect' : 'Hide effect'}
                      onMouseDown={(e) => {
                        e.stopPropagation()
                        dispatch({ type: 'UPDATE_EFFECT', effectId: effect.id, updates: { hidden: !effect.hidden } })
                      }}
                    >
                      <EyeIcon off={!!effect.hidden} />
                    </button>
                  </div>
                )
              })}
            </div>

            {/* Blank lane spacer for "add above" CTA alignment */}
            <div style={{ height: LANE_HEIGHT }} />

            {/* Lanes */}
            <div
              className="relative"
              style={{ height: trackHeight }}
              onMouseDown={(e) => {
                // Click empty area to deselect
                if (e.target === e.currentTarget) {
                  onSelectObject(null)
                  onSelectZoom(null)
                  onSelectEffect(null)
                  onSeek(clientXToTime(e.clientX))
                }
              }}
            >
              {/* Lane backgrounds */}
              {lanes.map((lane, i) => (
                <div
                  key={lane}
                  className="absolute w-full"
                  style={{
                    top: laneToY(lane),
                    height: LANE_HEIGHT,
                    background: i % 2 === 0 ? 'rgba(0,0,0,0.03)' : 'transparent',
                  }}
                />
              ))}

              {/* Object bars */}
              {objects.map((obj) => {
                const left = timeToX(obj.startTime)
                const width = Math.max(timeToX(obj.duration), 4)
                const top = laneToY(obj.lane)
                const color = TYPE_COLORS[obj.type] ?? '#666'
                // Highlight every member of the multi-selection (not just the single primary).
                const isSelected = selectedObjectIds.includes(obj.id)
                // Media clips (audio/video) trim on both edges; speed is set from the panel slider.
                const md = obj.type === 'audio' || obj.type === 'video' ? (obj.data as AudioData | VideoData) : null
                // Trim "ghosts": the played bar (= duration) is solid; the trimmed-off source is drawn
                // dimmed on each end so the bar keeps its ORIGINAL full length and the trimmed media
                // stays visible/recoverable — drag a ghost (or the trim handle) back out to restore.
                const rate = md && obj.duration > 0 ? sourceSpan(md) / obj.duration : 1
                // Ghosts show only recoverable source WITHIN the clip's window [srcMin, srcMax]. A
                // split collapses that window to the played span, so its halves show no ghosts.
                const leftGhostPx = md ? timeToX((srcIn(md) - srcMin(md)) / rate) : 0
                const rightGhostPx = md ? timeToX((srcMax(md) - srcOut(md)) / rate) : 0

                return (
                  <div
                    key={obj.id}
                    className="absolute flex items-center group"
                    style={{
                      left,
                      top,
                      width,
                      height: LANE_HEIGHT,
                      // Lift the WHOLE selected clip above neighbors here (not on the bar body), so the
                      // bar doesn't stack over its own keyframe diamonds and hide them.
                      zIndex: isSelected ? 30 : undefined,
                    }}
                  >
                    {/* Trim ghosts (spec 14 R8 feedback): dimmed, draggable stubs of trimmed-off
                        source on each end so the bar keeps its original length and stays restorable.
                        Dragging a ghost runs the same rate-constant trim as the bottom edge handle. */}
                    {md && leftGhostPx > 1.5 && (
                      <div
                        className="absolute top-0 cursor-ew-resize rounded-l-sm opacity-25 hover:opacity-45 transition-opacity"
                        style={{
                          right: '100%',
                          width: leftGhostPx,
                          height: LANE_HEIGHT,
                          background: `repeating-linear-gradient(45deg, ${color} 0, ${color} 3px, transparent 3px, transparent 7px)`,
                          border: `1px dashed ${color}`,
                          borderRight: 'none',
                        }}
                        title="Trimmed source — drag to restore"
                        onMouseDown={(e) => {
                          e.stopPropagation()
                          onSelectObject(obj.id)
                          setDragState({ kind: 'trim-left', objectId: obj.id, startMouseX: e.clientX, originalStartTime: obj.startTime, originalDuration: obj.duration, originalSourceIn: srcIn(md), originalSourceOut: srcOut(md), sourceMin: srcMin(md) })
                        }}
                      />
                    )}
                    {md && rightGhostPx > 1.5 && (
                      <div
                        className="absolute top-0 cursor-ew-resize rounded-r-sm opacity-25 hover:opacity-45 transition-opacity"
                        style={{
                          left: '100%',
                          width: rightGhostPx,
                          height: LANE_HEIGHT,
                          background: `repeating-linear-gradient(45deg, ${color} 0, ${color} 3px, transparent 3px, transparent 7px)`,
                          border: `1px dashed ${color}`,
                          borderLeft: 'none',
                        }}
                        title="Trimmed source — drag to restore"
                        onMouseDown={(e) => {
                          e.stopPropagation()
                          onSelectObject(obj.id)
                          setDragState({ kind: 'trim-right', objectId: obj.id, startMouseX: e.clientX, originalDuration: obj.duration, originalSourceIn: srcIn(md), originalSourceOut: srcOut(md), sourceMax: srcMax(md) })
                        }}
                      />
                    )}

                    {/* Left edge handle. Media clips (audio/video) trim the in-point at constant
                        speed; non-media clips resize their duration. */}
                    {md ? (
                      <div
                        className="absolute left-0 top-0 w-2 h-full cursor-ew-resize z-40 flex items-center justify-center transition-colors bg-amber-400/25 group-hover:bg-amber-400/60"
                        style={dragState?.kind === 'trim-left' && dragState.objectId === obj.id ? { background: 'rgba(251,191,36,0.9)' } : undefined}
                        title="Drag to trim in-point"
                        onMouseDown={(e) => {
                          e.stopPropagation()
                          onSelectObject(obj.id)
                          setDragState({ kind: 'trim-left', objectId: obj.id, startMouseX: e.clientX, originalStartTime: obj.startTime, originalDuration: obj.duration, originalSourceIn: srcIn(md), originalSourceOut: srcOut(md), sourceMin: srcMin(md) })
                        }}
                      >
                        <span className="text-[9px] text-black font-bold leading-none pointer-events-none opacity-0 group-hover:opacity-100">[</span>
                      </div>
                    ) : (
                      <div
                        className="absolute left-0 top-0 w-1.5 h-full cursor-col-resize z-40 hover:bg-white/30"
                        onMouseDown={(e) => {
                          e.stopPropagation()
                          onSelectObject(obj.id)
                          setDragState({ kind: 'resize-left', objectId: obj.id, startMouseX: e.clientX, originalStartTime: obj.startTime, originalDuration: obj.duration })
                        }}
                      />
                    )}

                    {/* Main bar body */}
                    <div
                      className="absolute inset-0 rounded-sm overflow-hidden cursor-grab active:cursor-grabbing"
                      style={{
                        backgroundColor: color,
                        // Hidden clips (spec 14 R11) render dimmed + dashed so the state reads at a glance.
                        opacity: obj.hidden ? 0.4 : isSelected ? 1 : 0.75,
                        outline: isSelected ? '2px solid #fff' : obj.hidden ? '1px dashed rgba(255,255,255,0.6)' : 'none',
                        outlineOffset: -1,
                        // Selected bars get a bright sky ring + glow so a multi-selection is
                        // unmistakable across lanes. (The lift above neighbors lives on the outer
                        // container so the bar never stacks over its own keyframe diamonds.)
                        boxShadow: isSelected ? '0 0 0 2px #0ea5e9, 0 0 12px 2px rgba(14,165,233,0.6)' : undefined,
                      }}
                      onMouseDown={(e) => {
                        e.stopPropagation()
                        // Shift-click toggles this clip in the multi-selection — no drag starts, so
                        // you can gather clips across lanes before moving them.
                        if (e.shiftKey) {
                          onSelectObject(obj.id, true)
                          return
                        }
                        // Grabbing a clip already in a multi-selection moves the WHOLE group and keeps
                        // the selection; grabbing any other clip collapses to just it.
                        const inGroup = selectedObjectIds.length > 1 && selectedObjectIds.includes(obj.id)
                        if (!inGroup) onSelectObject(obj.id)
                        const groupIds = inGroup ? selectedObjectIds : [obj.id]
                        const group = groupIds
                          .map((id) => objects.find((o) => o.id === id))
                          .filter((o): o is TimelineObject => !!o)
                          .map((o) => ({ objectId: o.id, originalStartTime: o.startTime, originalLane: o.lane }))
                        const groupLanes = group.map((g) => g.originalLane)
                        // You can always drag onto ONE new lane just past the objects you're NOT
                        // dragging (top or bottom), so a fresh top/bottom layer is always reachable —
                        // even after the previous top object moved down. Union with the current visible
                        // extent [minLane, maxLane] so explicitly-added lanes stay reachable too.
                        const groupSet = new Set(groupIds)
                        const otherLanes = objects.filter((o) => !groupSet.has(o.id)).map((o) => o.lane)
                        const laneFloor = otherLanes.length ? Math.min(minLane, Math.min(...otherLanes) - 1) : minLane
                        const laneCeil = otherLanes.length ? Math.max(maxLane, Math.max(...otherLanes) + 1) : maxLane
                        setDragState({
                          kind: 'move',
                          objectId: obj.id,
                          startMouseX: e.clientX,
                          startMouseY: e.clientY,
                          originalStartTime: obj.startTime,
                          group,
                          minGroupStart: Math.min(...group.map((g) => g.originalStartTime)),
                          // Bound the shared lane delta so no member leaves [laneFloor, laneCeil].
                          clampMinLaneDelta: laneFloor - Math.min(...groupLanes),
                          clampMaxLaneDelta: laneCeil - Math.max(...groupLanes),
                        })
                      }}
                    >
                      {/* Enter/exit transition ramps (behind the label) — bright so they read clearly. */}
                      {obj.enter && obj.enter.kind !== 'none' && (
                        <div
                          className="absolute top-0 left-0 h-full pointer-events-none"
                          style={{ width: Math.min(timeToX(obj.enter.duration), width), background: 'linear-gradient(90deg, rgba(255,255,255,0.85), rgba(255,255,255,0.15))' }}
                        />
                      )}
                      {obj.exit && obj.exit.kind !== 'none' && (
                        <div
                          className="absolute top-0 right-0 h-full pointer-events-none"
                          style={{ width: Math.min(timeToX(obj.exit.duration), width), background: 'linear-gradient(270deg, rgba(255,255,255,0.85), rgba(255,255,255,0.15))' }}
                        />
                      )}
                      {/* Waveform background for audio clips + video (audio track). */}
                      {(() => {
                        const wf = obj.type === 'audio' || obj.type === 'video'
                          ? (obj.data as AudioData | VideoData).waveform
                          : undefined
                        return wf ? (
                          <div className="absolute inset-0 flex items-end pointer-events-none opacity-30">
                            {wf.map((peak, wi) => (
                              <div
                                key={wi}
                                className="flex-1 bg-white"
                                style={{ height: `${peak * 100}%`, minWidth: 0 }}
                              />
                            ))}
                          </div>
                        ) : null
                      })()}

                      <span className="relative text-[10px] text-white px-1 truncate leading-10 pointer-events-none">
                        {/* Animated image marker (spec 28 B12): ⟳ loops for the whole clip,
                            → plays once and then holds the last frame. Absent for stills. */}
                        {obj.type === 'photo' && (obj.data as PhotoData).animated ? (
                          <span className="opacity-80">
                            {(obj.data as PhotoData).loop === false ? '→' : '⟳'}{' '}
                          </span>
                        ) : null}
                        <span className="font-bold">{barLabel(obj)}</span>
                        {' '}
                        <span className="opacity-70">[{formatTime(obj.startTime)} - {formatTime(obj.startTime + obj.duration)}]</span>
                      </span>

                      {/* AnimateIn sub-bar: display-only stripe showing the type-on / draw-on
                          region. Its length is edited from the Properties panel (Type-on bar),
                          not by dragging here. */}
                      {obj.animateIn > 0 && obj.type !== 'photo' && obj.type !== 'audio' && obj.type !== 'video' ? (() => {
                        // Cap sub-bar so it never covers the parent's resize handles (6px reserved each side)
                        const pct = (obj.animateIn / obj.duration) * 100
                        const maxPx = width - 6
                        return (
                          <div
                            className="absolute top-0 left-0 h-full pointer-events-none rounded-sm"
                            style={{
                              width: maxPx > 0 ? `min(${pct}%, ${maxPx}px)` : `${pct}%`,
                              background: 'repeating-linear-gradient(90deg, rgba(255,255,255,0.15) 0px, rgba(255,255,255,0.15) 3px, transparent 3px, transparent 6px)',
                            }}
                          />
                        )
                      })() : null}
                    </div>

                    {/* Hide toggle (spec 14 R11) — revealed on hover; always shown when hidden.
                        Sits just left of the right resize handle. */}
                    <button
                      className={`absolute top-0.5 z-40 flex items-center justify-center rounded text-white hover:bg-black/50 ${obj.hidden ? 'opacity-100 bg-black/30' : 'opacity-0 group-hover:opacity-100'}`}
                      style={{ right: 11, width: 16, height: 16 }}
                      title={obj.hidden ? 'Show (H)' : 'Hide (H)'}
                      onMouseDown={(e) => {
                        e.stopPropagation()
                        dispatch({ type: 'UPDATE_OBJECT', objectId: obj.id, updates: { hidden: !obj.hidden } })
                      }}
                    >
                      <EyeIcon off={!!obj.hidden} />
                    </button>

                    {/* Lead-in ramps (spec 21): the moving window before each diamond, so a
                        hold-then-move keyframe reads distinct from a fill-the-gap one. */}
                    {(obj.keyframes ?? []).map((k, i) => {
                      const okfs = obj.keyframes!
                      const prev = i > 0 ? okfs[i - 1].time : 0
                      const gap = k.time - prev
                      const lead = k.leadIn == null ? gap : Math.min(k.leadIn, gap)
                      if (lead <= 0.001) return null
                      return (
                        <div
                          key={`lead-${i}`}
                          className="absolute top-1/2 -translate-y-1/2 h-2 z-10 pointer-events-none rounded-sm"
                          style={{
                            left: timeToX(k.time - lead),
                            width: Math.max(timeToX(lead), 1),
                            background: `linear-gradient(90deg, transparent, ${keyframeColor(i)})`,
                            opacity: 0.5,
                          }}
                        />
                      )
                    })}

                    {/* Keyframe markers (diamonds on top of the bar), colored to match the
                        panel pips. Drag one horizontally to retime that keyframe. */}
                    {(obj.keyframes ?? []).map((k, i) => {
                      const kfs = obj.keyframes!
                      // Clamp between neighbors (with a small gap) so dragging can't reorder them.
                      let minTime = i > 0 ? kfs[i - 1].time + 0.05 : 0
                      let maxTime = i < kfs.length - 1 ? kfs[i + 1].time - 0.05 : obj.duration
                      if (minTime > maxTime) { const m = (minTime + maxTime) / 2; minTime = m; maxTime = m }
                      const isActive = dragState?.kind === 'move-keyframe' && dragState.objectId === obj.id && dragState.kfIndex === i
                      return (
                        <div
                          key={i}
                          className="absolute top-1/2 w-3 h-3 border border-black/60 z-20 cursor-ew-resize pointer-events-auto"
                          style={{
                            left: timeToX(k.time),
                            background: keyframeColor(i),
                            transform: 'translate(-50%, -50%) rotate(45deg)',
                            boxShadow: isActive ? '0 0 0 2px #fff' : 'none',
                          }}
                          title={`Keyframe ${i + 1} @ ${k.time.toFixed(2)}s — drag to retime`}
                          onMouseDown={(e) => {
                            e.stopPropagation()
                            onSelectObject(obj.id)
                            setDragState({
                              kind: 'move-keyframe',
                              objectId: obj.id,
                              kfIndex: i,
                              startMouseX: e.clientX,
                              originalTime: k.time,
                              minTime,
                              maxTime,
                            })
                          }}
                        />
                      )
                    })}

                    {/* Right edge handle. Media clips trim the out-point at constant speed; non-media
                        clips resize their duration. */}
                    {md ? (
                      (() => {
                        const isActive = dragState?.kind === 'trim-right' && dragState.objectId === obj.id
                        return (
                          <div
                            className="absolute right-0 top-0 w-2 h-full cursor-ew-resize z-40 flex items-center justify-center transition-colors bg-amber-400/25 group-hover:bg-amber-400/60"
                            style={isActive ? { background: 'rgba(251,191,36,0.9)' } : undefined}
                            title="Drag to trim out-point"
                            onMouseDown={(e) => {
                              e.stopPropagation()
                              onSelectObject(obj.id)
                              setDragState({ kind: 'trim-right', objectId: obj.id, startMouseX: e.clientX, originalDuration: obj.duration, originalSourceIn: srcIn(md), originalSourceOut: srcOut(md), sourceMax: srcMax(md) })
                            }}
                          >
                            <span className="text-[9px] text-black font-bold leading-none pointer-events-none opacity-0 group-hover:opacity-100">]</span>
                          </div>
                        )
                      })()
                    ) : (
                      (() => {
                        const isActive = dragState?.kind === 'resize-right' && dragState.objectId === obj.id
                        return (
                          <div
                            className="absolute right-0 top-0 w-2 h-full cursor-col-resize z-40 transition-colors"
                            style={{ background: isActive ? 'rgba(96,165,250,0.9)' : 'rgba(96,165,250,0.25)' }}
                            onMouseEnter={(e) => { if (!dragState) (e.currentTarget.style.background = 'rgba(96,165,250,0.6)') }}
                            onMouseLeave={(e) => { if (!isActive) (e.currentTarget.style.background = 'rgba(96,165,250,0.25)') }}
                            onMouseDown={(e) => {
                              e.stopPropagation()
                              onSelectObject(obj.id)
                              setDragState({ kind: 'resize-right', objectId: obj.id, startMouseX: e.clientX, originalDuration: obj.duration })
                            }}
                          />
                        )
                      })()
                    )}
                  </div>
                )
              })}

            </div>

            {/* Blank lane spacer for "add below" CTA alignment */}
            <div style={{ height: LANE_HEIGHT }} />

            {/* Marker guide lines (spec 22) — full-height, through the lanes. zIndex 55 keeps them
                above the lane bars (≤ 50) but behind the opaque ruler/Camera track (60), so only the
                flag shows in the ruler band and the line runs down through the tracks. */}
            {(markers ?? []).map((m) => (
              <div
                key={m.id}
                className="absolute top-0 w-px pointer-events-none"
                style={{ left: timeToX(m.time), height: '100%', background: m.color ?? MARKER_COLOR, opacity: 0.45, zIndex: 55 }}
              />
            ))}

            {/* Active snap guide (spec 22 R15) — the bright line a live drag is currently locked onto.
                Drawn above the playhead so the lock is unmistakable. */}
            {snapLineTime !== null && (
              <div
                className="absolute top-0 w-px pointer-events-none"
                style={{ left: timeToX(snapLineTime), height: '100%', background: SNAP_LINE_COLOR, opacity: 0.9, zIndex: 66 }}
              />
            )}

            {/* Playhead — spans the full content height; drawn over the pinned ruler/Camera track
                (zIndex 65 > their 60) but under the frozen lane gutter (z-[70]) so it hides under it. */}
            <div
              className="absolute top-0 w-0.5 bg-playhead pointer-events-none"
              style={{
                left: timeToX(globalTime),
                height: '100%',
                zIndex: 65,
              }}
            />
          </div>
        </div>
      </div>

      {/* Marker edit popover (spec 22 R17) — opened by clicking a flag; label / color / delete. */}
      {editingMarker && (() => {
        const m = (markers ?? []).find((mk) => mk.id === editingMarker.id)
        return m ? (
          <MarkerPopover
            marker={m}
            left={editingMarker.left}
            top={editingMarker.top}
            dispatch={dispatch}
            onClose={() => setEditingMarker(null)}
          />
        ) : null
      })()}
    </div>
  )
}

/**
 * Lightweight marker editor (spec 22 R17) — a viewport-clamped popover portalled to document.body,
 * mirroring Popover.tsx's outside-click / Escape dismissal. Markers have no global selection state,
 * so this owns the whole edit surface: label, color swatches, delete. Escape's stopPropagation keeps
 * App's window-level handler from also firing (which would deselect the current object/zoom).
 */
function MarkerPopover({
  marker,
  left,
  top,
  dispatch,
  onClose,
}: {
  marker: Marker
  left: number
  top: number
  dispatch: React.Dispatch<ProjectAction>
  onClose: () => void
}) {
  const panelRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (!panelRef.current?.contains(e.target as Node)) onClose()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.stopPropagation(); onClose() }
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [onClose])

  const PW = 220
  const clampedLeft = Math.max(8, Math.min(left - PW / 2, window.innerWidth - PW - 8))
  const clampedTop = Math.max(8, Math.min(top, window.innerHeight - 170))

  return createPortal(
    <div
      ref={panelRef}
      className="fixed z-[90] rounded-lg border border-border bg-surface shadow-xl p-3"
      style={{ left: clampedLeft, top: clampedTop, width: PW }}
    >
      <div className="text-[11px] font-semibold text-subtle mb-1.5">Marker</div>
      <input
        autoFocus
        type="text"
        value={marker.label ?? ''}
        placeholder="Label (optional)"
        onChange={(e) => dispatch({ type: 'UPDATE_MARKER', markerId: marker.id, updates: { label: e.target.value || undefined } })}
        className="w-full bg-surface-muted border border-border rounded px-2 py-1 text-xs text-fg outline-none focus:border-accent mb-2"
      />
      <div className="flex items-center gap-1.5 mb-2.5">
        {MARKER_SWATCHES.map((c) => {
          const active = (marker.color ?? MARKER_COLOR) === c
          return (
            <button
              key={c}
              onClick={() => dispatch({ type: 'UPDATE_MARKER', markerId: marker.id, updates: { color: c } })}
              className="w-5 h-5 rounded-full cursor-pointer transition-transform hover:scale-110"
              style={{ background: c, outline: active ? '2px solid var(--fg)' : 'none', outlineOffset: 1 }}
              title={c}
            />
          )
        })}
      </div>
      <button
        onClick={() => { dispatch({ type: 'REMOVE_MARKER', markerId: marker.id }); onClose() }}
        className="w-full flex items-center justify-center gap-1 px-2 py-1 text-xs text-danger hover:bg-danger-soft rounded transition-colors cursor-pointer"
      >
        <IconTrash size={13} stroke={2} /> Delete marker
      </button>
    </div>,
    document.body,
  )
}

import type { ReactNode } from 'react'
import type { TimelineObject, ProjectAction, ArrowData, TextData, VideoData, TextAlign, CameraZoom } from '../types'
import { effVal as kfEffVal, editPose, editPatch, resolvePose } from '../lib/keyframes'
import { zoomHoldTime, zoomTargetPoseAt, editZoomPose } from '../lib/camera'
import { clamp01 } from '../lib/easing'
import { rememberObjectStyle, rememberObjectData } from '../lib/objectDefaults'
import {
  IconCopy, IconTrash, IconVector, IconSparkles, IconBold, IconItalic, IconTypography, IconHighlight,
  IconAlignLeft, IconAlignCenter, IconAlignRight, IconAlignJustified,
  IconArrowNarrowRight, IconAdjustments, IconDroplet, IconVolume, IconVolumeOff,
  IconFocusCentered, IconClock, IconArrowsMaximize,
} from '@tabler/icons-react'
import { Popover } from './Popover'
import { Field, NumberInput, TransitionSection, SELECT_CLS, MotionPicker } from './propertyControls'

/**
 * Floating context toolbar (spec 17 P) — the fast-path property surface anchored over the selected
 * object. Canvas.tsx owns the *anchoring* (screen box, flip, clamp, hide-during-drag); this owns the
 * *content*. High-frequency controls sit inline (colour, B/I, moving-head, edit-points); deeper
 * groups open portalled popovers that reuse the inspector's shared components (`propertyControls`),
 * so the bar and the inspector stay one design. Keyframes / timing / position stay in the inspector
 * (the depth surface) — see OQ-8. Audio has no bbox, so it has no toolbar (P4).
 */
export function ContextToolbar({
  object,
  dispatch,
  globalTime,
  onToggleDraw,
  onDuplicate,
}: {
  object: TimelineObject
  dispatch: React.Dispatch<ProjectAction>
  globalTime: number
  onToggleDraw?: () => void
  onDuplicate?: (objectId: string) => void
}) {
  const obj = object
  const update = (updates: Partial<Omit<TimelineObject, 'id' | 'type'>>) =>
    dispatch({ type: 'UPDATE_OBJECT', objectId: obj.id, updates })
  // Spec 29: routed through `editPatch` so the toolbar obeys the SAME base-vs-keyframe rule as the
  // inspector — editing the colour of a colour-animated object lands on the keyframe rather than
  // writing a base value the keyframes would immediately override. Remembering the last-used
  // setting only applies when the edit actually landed on the base (a keyframe write returns
  // `keyframes` alone).
  const clipTime = Math.max(0, Math.min(globalTime - obj.startTime, obj.duration))
  const updateStyle = (s: Partial<TimelineObject['style']>) => {
    const updates = editPatch(obj, { style: s as Record<string, unknown> }, clipTime)
    update(updates)
    if (updates.style) rememberObjectStyle(obj.type, updates.style)
  }
  const updateData = (d: Partial<TextData & ArrowData>, remember: Record<string, unknown>) => {
    const updates = editPatch(obj, { data: d as Record<string, unknown> }, clipTime)
    update(updates)
    if (updates.data) rememberObjectData(obj.type, remember)
  }

  // Controls READ from the channel-resolved object so a swatch/toggle shows what's actually on
  // screen at the playhead (identical reference when nothing animates). They WRITE through the
  // closures above, which are bound to the raw object.
  const view = resolvePose(obj, globalTime)

  return (
    <div className="flex items-center gap-0.5 rounded-lg border border-border bg-surface p-1 shadow-lg">
      {obj.type === 'text' && <TextControls obj={view} updateStyle={updateStyle} updateData={updateData} />}
      {obj.type === 'arrow' && (
        <ArrowControls obj={view} updateStyle={updateStyle} updateData={updateData} onToggleDraw={onToggleDraw} />
      )}
      {obj.type === 'freehand' && (
        <FreehandControls obj={view} updateStyle={updateStyle} onToggleDraw={onToggleDraw} />
      )}
      {(obj.type === 'photo' || obj.type === 'video') && (
        <MediaControls obj={obj} dispatch={dispatch} globalTime={globalTime} update={update} />
      )}

      {/* Animate (all visual) — entrance/exit; keyframes stay in the inspector */}
      <Divider />
      <Popover icon={<IconSparkles size={16} stroke={2} />} label="Animate" title="Entrance & exit animations">
        <div className="w-60 p-3">
          <TransitionSection title="On Appear" phase="in" value={obj.enter} objDuration={obj.duration} onChange={(t) => update({ enter: t })} />
          <TransitionSection title="On Exit" phase="out" value={obj.exit} objDuration={obj.duration} onChange={(t) => update({ exit: t })} />
          <p className="text-[10px] text-subtle">Keyframes, timing &amp; position live in the inspector.</p>
        </div>
      </Popover>

      {/* Universal actions */}
      <Divider />
      <ToolbarButton title="Duplicate" onClick={() => onDuplicate ? onDuplicate(obj.id) : dispatch({ type: 'DUPLICATE_OBJECT', objectId: obj.id })}>
        <IconCopy size={16} stroke={2} />
      </ToolbarButton>
      <ToolbarButton title="Delete" danger onClick={() => dispatch({ type: 'REMOVE_OBJECT', objectId: obj.id })}>
        <IconTrash size={16} stroke={2} />
      </ToolbarButton>
    </div>
  )
}

/**
 * Floating context toolbar for a selected camera zoom (spec 17 P5). Anchored (by Canvas) to the
 * zoom's framing rect. Fast-path quick controls (focus/scale, timing) mirror the `ZoomEditor`;
 * keyframes stay in the inspector + on-canvas reframe (same depth split as objects, OQ-8).
 */
export function ZoomContextToolbar({
  zoom,
  dispatch,
  globalTime,
  onSelectZoom,
}: {
  zoom: CameraZoom
  dispatch: React.Dispatch<ProjectAction>
  globalTime: number
  onSelectZoom: (id: string | null) => void
}) {
  const update = (updates: Partial<Omit<CameraZoom, 'id'>>) =>
    dispatch({ type: 'UPDATE_ZOOM', zoomId: zoom.id, updates })
  // Keyframe-aware focus/scale edit at the playhead (mirrors ZoomEditor). The target pose is what
  // the framing rect shows, so numeric edits and the on-canvas drag agree.
  const holdTime = Math.max(0, Math.min(zoom.hold, zoomHoldTime(zoom, globalTime)))
  const pose = zoomTargetPoseAt(zoom, globalTime)
  const editZoom = (overrides: Partial<{ x: number; y: number; scale: number }>) =>
    update(editZoomPose(zoom, overrides, holdTime))

  return (
    <div className="flex items-center gap-0.5 rounded-lg border border-border bg-surface p-1 shadow-lg">
      <Popover icon={<IconFocusCentered size={16} stroke={2} />} label="Zoom" title="Focus & scale">
        <div className="w-60 space-y-2 p-3">
          <p className="text-[10px] font-semibold uppercase tracking-wider text-subtle">Focus</p>
          <div className="grid grid-cols-2 gap-2">
            <Field label="X">
              <NumberInput value={pose.x} min={0} max={1} step={0.01} onChange={(v) => editZoom({ x: clamp01(v) })} />
            </Field>
            <Field label="Y">
              <NumberInput value={pose.y} min={0} max={1} step={0.01} onChange={(v) => editZoom({ y: clamp01(v) })} />
            </Field>
          </div>
          <Field label="Zoom (×)">
            <NumberInput value={pose.scale} min={1} step={0.1} onChange={(v) => editZoom({ scale: Math.max(1, v) })} />
          </Field>
          <p className="text-[10px] text-subtle">Or drag the framing rectangle on the canvas.</p>
        </div>
      </Popover>
      <Popover icon={<IconClock size={16} stroke={2} />} label="Timing" title="Timing envelope">
        <div className="w-60 space-y-2 p-3">
          <Field label="Start (s)">
            <NumberInput value={zoom.startTime} min={0} step={0.1} onChange={(v) => update({ startTime: Math.max(0, v) })} />
          </Field>
          <Field label="Ease in (s)">
            <NumberInput value={zoom.transitionIn} min={0} step={0.1} onChange={(v) => update({ transitionIn: Math.max(0, v) })} />
          </Field>
          <Field label="Hold (s)">
            <NumberInput value={zoom.hold} min={0} step={0.1} onChange={(v) => update({ hold: Math.max(0, v) })} />
          </Field>
          <Field label="Ease out (s)">
            <NumberInput value={zoom.transitionOut} min={0} step={0.1} onChange={(v) => update({ transitionOut: Math.max(0, v) })} />
          </Field>
          <div>
            <label className="mb-1 block text-xs text-muted">Motion</label>
            <MotionPicker value={zoom.easing} onChange={(k) => update({ easing: k })} />
          </div>
        </div>
      </Popover>
      <Divider />
      <ToolbarButton
        title="Delete zoom"
        danger
        onClick={() => { dispatch({ type: 'REMOVE_ZOOM', zoomId: zoom.id }); onSelectZoom(null) }}
      >
        <IconTrash size={16} stroke={2} />
      </ToolbarButton>
    </div>
  )
}

// === Per-type control clusters ===

function TextControls({
  obj, updateStyle, updateData,
}: {
  obj: TimelineObject
  updateStyle: (s: Partial<TimelineObject['style']>) => void
  updateData: (d: Partial<TextData & ArrowData>, remember: Record<string, unknown>) => void
}) {
  const data = obj.data as TextData
  const align = data.align ?? 'center'
  const bold = (obj.style.fontWeight ?? 'bold') === 'bold'
  const italic = (obj.style.fontStyle ?? 'normal') === 'italic'
  const autoSize = data.autoSize !== false
  return (
    <>
      <ColorSwatch color={obj.style.color} onChange={(c) => updateStyle({ color: c })} title="Text colour" />
      {/* Background: an inline toggle + swatch right next to the text colour (not buried in Font). */}
      <ToolbarToggle
        title={data.background != null ? 'Remove background' : 'Add background'}
        on={data.background != null}
        onClick={() => {
          const next = data.background != null ? undefined : '#000000'
          updateData({ background: next }, { background: next })
        }}
      >
        <IconHighlight size={16} stroke={2} />
      </ToolbarToggle>
      {data.background != null && (
        <ColorSwatch
          color={data.background}
          onChange={(c) => updateData({ background: c }, { background: c })}
          title="Background colour"
        />
      )}
      <Divider />
      <ToolbarToggle title="Bold" on={bold} onClick={() => updateStyle({ fontWeight: bold ? 'normal' : 'bold' })}>
        <IconBold size={16} stroke={2} />
      </ToolbarToggle>
      <ToolbarToggle title="Italic" on={italic} onClick={() => updateStyle({ fontStyle: italic ? 'normal' : 'italic' })}>
        <IconItalic size={16} stroke={2} />
      </ToolbarToggle>
      <Popover icon={<AlignIcon align={align} />} title="Alignment">
        {(close) => (
          <div className="flex gap-0.5 p-1">
            {(['left', 'center', 'right', 'justify'] as TextAlign[]).map((a) => (
              <button
                key={a}
                title={a}
                onClick={() => { updateData({ align: a }, { align: a }); close() }}
                className={`flex h-8 w-8 items-center justify-center rounded cursor-pointer transition-colors ${
                  a === align ? 'bg-accent-soft text-accent' : 'text-muted hover:bg-surface-hover hover:text-fg'
                }`}
              >
                <AlignIcon align={a} />
              </button>
            ))}
          </div>
        )}
      </Popover>
      <Popover icon={<IconTypography size={16} stroke={2} />} title="Font">
        <div className="w-56 space-y-2 p-3">
          <Field label="Font">
            <select
              value={obj.style.fontFamily ?? 'sans-serif'}
              onChange={(e) => updateStyle({ fontFamily: e.target.value })}
              className={SELECT_CLS}
            >
              <option value="sans-serif">Sans</option>
              <option value="serif">Serif</option>
              <option value="monospace">Mono</option>
            </select>
          </Field>
          <Field label="Auto-size">
            <input
              type="checkbox"
              checked={autoSize}
              onChange={(e) => updateData({ autoSize: e.target.checked }, { autoSize: e.target.checked })}
              className="accent-accent cursor-pointer"
            />
          </Field>
          {!autoSize && (
            <Field label="Font size">
              <NumberInput value={obj.style.fontSize ?? 32} min={8} max={200} step={1} onChange={(v) => updateStyle({ fontSize: v })} />
            </Field>
          )}
        </div>
      </Popover>
    </>
  )
}

function ArrowControls({
  obj, updateStyle, updateData, onToggleDraw,
}: {
  obj: TimelineObject
  updateStyle: (s: Partial<TimelineObject['style']>) => void
  updateData: (d: Partial<TextData & ArrowData>, remember: Record<string, unknown>) => void
  onToggleDraw?: () => void
}) {
  const data = obj.data as ArrowData
  const movingHead = data.progressiveHead ?? true
  const curvature = data.curvature ?? 0
  return (
    <>
      <ColorSwatch color={obj.style.color} onChange={(c) => updateStyle({ color: c })} title="Arrow colour" />
      <ToolbarToggle
        title="Moving head (head follows the draw-on)"
        on={movingHead}
        onClick={() => updateData({ progressiveHead: !movingHead }, { progressiveHead: !movingHead })}
      >
        <IconArrowNarrowRight size={16} stroke={2} />
      </ToolbarToggle>
      <Popover icon={<IconAdjustments size={16} stroke={2} />} title="Arrow style">
        <div className="w-56 space-y-2 p-3">
          <Field label="Line width">
            <NumberInput value={obj.style.lineWidth} min={1} max={20} step={1} onChange={(v) => updateStyle({ lineWidth: v })} />
          </Field>
          <div>
            <div className="mb-1 flex items-center justify-between">
              <label className="text-muted text-xs">Curvature</label>
              <span className="w-8 text-right text-[10px] text-subtle tabular-nums">{curvature.toFixed(1)}</span>
            </div>
            <input
              type="range"
              min={-100} max={100} step={1}
              value={Math.round(curvature * 100)}
              onChange={(e) => { const c = Number(e.target.value) / 100; updateData({ curvature: c }, { curvature: c }) }}
              onDoubleClick={() => updateData({ curvature: 0 }, { curvature: 0 })}
              className="w-full"
            />
          </div>
        </div>
      </Popover>
      {onToggleDraw && (
        <ToolbarButton title="Edit points on the canvas" onClick={onToggleDraw}>
          <IconVector size={16} stroke={2} />
        </ToolbarButton>
      )}
    </>
  )
}

function FreehandControls({
  obj, updateStyle, onToggleDraw,
}: {
  obj: TimelineObject
  updateStyle: (s: Partial<TimelineObject['style']>) => void
  onToggleDraw?: () => void
}) {
  return (
    <>
      <ColorSwatch color={obj.style.color} onChange={(c) => updateStyle({ color: c })} title="Pen colour" />
      <Popover icon={<IconAdjustments size={16} stroke={2} />} title="Pen style">
        <div className="w-56 space-y-2 p-3">
          <Field label="Line width">
            <NumberInput value={obj.style.lineWidth} min={1} max={20} step={1} onChange={(v) => updateStyle({ lineWidth: v })} />
          </Field>
        </div>
      </Popover>
      {onToggleDraw && (
        <ToolbarButton title="Edit points on the canvas" onClick={onToggleDraw}>
          <IconVector size={16} stroke={2} />
        </ToolbarButton>
      )}
    </>
  )
}

function MediaControls({
  obj, dispatch, globalTime, update,
}: {
  obj: TimelineObject
  dispatch: React.Dispatch<ProjectAction>
  globalTime: number
  update: (updates: Partial<Omit<TimelineObject, 'id' | 'type'>>) => void
}) {
  // Opacity is keyframe-aware (same path as the inspector): transient while dragging → one undo entry.
  const clipTime = Math.max(0, Math.min(globalTime - obj.startTime, obj.duration))
  const opacity = kfEffVal(obj, 'opacity', clipTime)
  const setOpacity = (v: number, transient: boolean) =>
    dispatch({
      type: transient ? 'UPDATE_OBJECT_TRANSIENT' : 'UPDATE_OBJECT',
      objectId: obj.id,
      updates: editPose(obj, { opacity: v }, clipTime),
    })
  const commit = () => dispatch({ type: 'COMMIT_TRANSIENT' })
  // Fill the frame (object-fit: cover). The box spans the whole frame; drawImageCover crops overflow.
  // Routed through editPose (like canvas drag/resize) so it lands on the right pose for keyframed clips
  // and just sets the home pose for a plain asset. Rotation is reset so the fill is axis-aligned.
  const fillFrame = () =>
    dispatch({
      type: 'UPDATE_OBJECT',
      objectId: obj.id,
      updates: editPose(obj, { x: 0, y: 0, width: 1, height: 1, rotation: 0 }, clipTime),
    })
  return (
    <>
      <ToolbarButton title="Fill frame" onClick={fillFrame}>
        <IconArrowsMaximize size={16} stroke={2} />
      </ToolbarButton>
      <Popover icon={<IconDroplet size={16} stroke={2} />} title="Opacity">
        <div className="w-52 p-3">
          <div className="mb-1 flex items-center justify-between">
            <label className="text-muted text-xs">Opacity</label>
            <span className="text-[10px] text-subtle tabular-nums">{Math.round(opacity * 100)}%</span>
          </div>
          <input
            type="range"
            min={0} max={100} step={1}
            value={Math.round(opacity * 100)}
            onChange={(e) => setOpacity(Number(e.target.value) / 100, true)}
            onPointerUp={commit}
            onKeyUp={commit}
            className="w-full"
          />
        </div>
      </Popover>
      {obj.type === 'video' && <VideoVolume obj={obj} update={update} />}
    </>
  )
}

function VideoVolume({
  obj, update,
}: {
  obj: TimelineObject
  update: (updates: Partial<Omit<TimelineObject, 'id' | 'type'>>) => void
}) {
  const md = obj.data as VideoData
  const muted = md.muted ?? false
  return (
    <Popover
      icon={muted ? <IconVolumeOff size={16} stroke={2} /> : <IconVolume size={16} stroke={2} />}
      title="Volume"
    >
      <div className="w-52 space-y-2 p-3">
        <Field label="Mute">
          <input
            type="checkbox"
            checked={muted}
            onChange={(e) => update({ data: { ...md, muted: e.target.checked } })}
            className="accent-accent cursor-pointer"
          />
        </Field>
        <div className={muted ? 'opacity-40' : ''}>
          <div className="mb-1 flex items-center justify-between">
            <label className="text-muted text-xs">Volume</label>
            <span className="text-[10px] text-subtle tabular-nums">{Math.round(md.volume * 100)}%</span>
          </div>
          <input
            type="range"
            min={0} max={100} step={1}
            value={Math.round(md.volume * 100)}
            disabled={muted}
            onChange={(e) => update({ data: { ...md, volume: Number(e.target.value) / 100 } })}
            className="w-full"
          />
        </div>
      </div>
    </Popover>
  )
}

// === Shared bits ===

function AlignIcon({ align }: { align: TextAlign }) {
  if (align === 'left') return <IconAlignLeft size={16} stroke={2} />
  if (align === 'right') return <IconAlignRight size={16} stroke={2} />
  if (align === 'justify') return <IconAlignJustified size={16} stroke={2} />
  return <IconAlignCenter size={16} stroke={2} />
}

function ToolbarButton({
  title, onClick, danger, children,
}: {
  title: string
  onClick: () => void
  danger?: boolean
  children: ReactNode
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      aria-label={title}
      className={`flex h-8 w-8 items-center justify-center rounded transition-colors cursor-pointer ${
        danger ? 'text-muted hover:bg-danger-soft hover:text-danger' : 'text-muted hover:bg-surface-hover hover:text-fg'
      }`}
    >
      {children}
    </button>
  )
}

function ToolbarToggle({
  title, on, onClick, children,
}: {
  title: string
  on: boolean
  onClick: () => void
  children: ReactNode
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      aria-label={title}
      aria-pressed={on}
      className={`flex h-8 w-8 items-center justify-center rounded transition-colors cursor-pointer ${
        on ? 'bg-accent-soft text-accent' : 'text-muted hover:bg-surface-hover hover:text-fg'
      }`}
    >
      {children}
    </button>
  )
}

function ColorSwatch({
  color, onChange, title,
}: {
  color: string
  onChange: (c: string) => void
  title: string
}) {
  return (
    <label
      title={title}
      className="relative flex h-8 w-8 items-center justify-center rounded hover:bg-surface-hover cursor-pointer"
    >
      <span className="h-4 w-4 rounded-full border border-border-strong" style={{ background: color }} />
      <input
        type="color"
        value={color}
        onChange={(e) => onChange(e.target.value)}
        className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
        aria-label={title}
      />
    </label>
  )
}

function Divider() {
  return <span className="mx-0.5 h-5 w-px bg-border" />
}

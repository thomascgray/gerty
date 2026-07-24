import { useState } from 'react'
import {
  IconClock, IconArrowsMove, IconVector, IconLogin, IconLogout, IconDiamond,
  IconVolume, IconPalette, IconTypography, IconArrowUpRight, IconFocusCentered, IconChevronDown,
  IconSparkles,
} from '@tabler/icons-react'
import type {
  TimelineObject, ProjectAction, ArrowData, AudioData, VideoData, TextData, TextAlign,
  AnimatableProperty, EasingKind, CameraZoom, VideoEffect, VideoEffectKind, VignetteShape,
} from '../types'
import {
  KF_EPS, effVal as kfEffVal, editPose, addKeyframeAt, keyframeColor,
} from '../lib/keyframes'
import {
  zoomHoldTime, zoomTargetPoseAt, editZoomPose, addZoomKeyframeAt, activeZoomKeyframeIndex,
} from '../lib/camera'
import { clamp01 } from '../lib/easing'
import { srcIn, srcOut, sourceSpan, srcMin, srcMax, RATE_MIN, RATE_MAX } from '../lib/mediaTiming'
import { rememberObjectStyle, rememberObjectData } from '../lib/objectDefaults'
import {
  Field, NumberInput, TransitionFields, TypeOnBar, EffectFields,
  KeyframeTrack, KeyframeStatus, ZoomKeyframeTrack, MotionPicker, LeadInField, SELECT_CLS,
} from './propertyControls'

type PropertiesPanelProps = {
  object: TimelineObject | null
  zoom?: CameraZoom | null
  effect?: VideoEffect | null
  dispatch: React.Dispatch<ProjectAction>
  globalTime: number
  onSeek: (t: number) => void
  // Arrow/freehand point editing ("Edit points", spec 17 M). onToggleDraw enters/exits drawing.
  isDrawing?: boolean
  onToggleDraw?: () => void
}

export default function PropertiesPanel({ object: obj, zoom, effect, dispatch, globalTime, onSeek, isDrawing, onToggleDraw }: PropertiesPanelProps) {
  // A selected zoom or effect takes over the panel (all three selections are mutually exclusive).
  if (zoom) {
    return <ZoomEditor zoom={zoom} dispatch={dispatch} globalTime={globalTime} onSeek={onSeek} />
  }
  if (effect) {
    return <EffectEditor effect={effect} dispatch={dispatch} globalTime={globalTime} onSeek={onSeek} />
  }

  if (!obj) {
    return (
      <div className="w-64 bg-surface border-l border-border p-4 overflow-y-auto text-sm">
        <p className="text-subtle text-xs">No object selected</p>
      </div>
    )
  }

  const update = (updates: Partial<Omit<TimelineObject, 'id' | 'type'>>) => {
    dispatch({ type: 'UPDATE_OBJECT', objectId: obj.id, updates })
  }

  const updateStyle = (styleUpdates: Partial<TimelineObject['style']>) => {
    const nextStyle = { ...obj.style, ...styleUpdates }
    update({ style: nextStyle })
    // Remember these settings as the default for the next object of this type (feature: last-used).
    rememberObjectStyle(obj.type, nextStyle)
  }

  // Update type-specific data AND remember the given fields as new-object defaults. Only pass
  // fields that are safe to carry forward (never content/points/strokes/assetId).
  const updateData = (dataUpdates: Partial<TextData & ArrowData>, remember: Record<string, unknown>) => {
    update({ data: { ...obj.data, ...dataUpdates } as TimelineObject['data'] })
    rememberObjectData(obj.type, remember)
  }

  // --- Pose / keyframe helpers ---
  const clipTime = globalTime - obj.startTime
  const clampTime = (t: number) => Math.max(0, Math.min(t, obj.duration))

  // Value shown in the position/style inputs: interpolated pose at the playhead.
  const effVal = (p: AnimatableProperty) => kfEffVal(obj, p, clipTime)

  // Editing a property: per-property keyframe-aware (cements a keyframe iff that property is
  // already keyframed; otherwise edits the static base — so un-keyframed objects stay draggable).
  const dispatchPose = (prop: AnimatableProperty, value: number, transient: boolean) => {
    const overrides: Partial<Record<AnimatableProperty, number>> = { [prop]: value }
    dispatch({
      type: transient ? 'UPDATE_OBJECT_TRANSIENT' : 'UPDATE_OBJECT',
      objectId: obj.id,
      updates: editPose(obj, overrides, clampTime(clipTime)),
    })
  }
  const commitPose = () => dispatch({ type: 'COMMIT_TRANSIENT' })

  const kfs = obj.keyframes ?? []
  const activeIdx = kfs.findIndex((k) => Math.abs(k.time - clipTime) < KF_EPS)
  // When parked on a keyframe, this accent color threads through the whole panel (ring, banner,
  // pips) so it's unmistakable that edits land on that keyframe — matching the canvas selection box.
  const activeColor = activeIdx >= 0 ? keyframeColor(activeIdx) : null

  // Keyframes are created ONLY here — never from editing/dragging.
  const addKeyframe = () => update({ keyframes: addKeyframeAt(obj, clampTime(clipTime)) })

  const setKeyframeEasing = (idx: number, easing: EasingKind) =>
    update({ keyframes: kfs.map((k, j) => (j === idx ? { ...k, easing } : k)) })
  const applyEasingToAllKeyframes = (easing: EasingKind) =>
    update({ keyframes: kfs.map((k) => ({ ...k, easing })) })
  const setKeyframeLeadIn = (idx: number, leadIn: number) =>
    update({ keyframes: kfs.map((k, j) => (j === idx ? { ...k, leadIn } : k)) })
  // Gap from the previous waypoint (base pose at 0 for the first keyframe) — the lead-in max.
  const kfGap = (idx: number) => kfs[idx].time - (idx > 0 ? kfs[idx - 1].time : 0)
  const deleteKeyframe = (idx: number) => {
    const next = kfs.filter((_, j) => j !== idx)
    update({ keyframes: next.length ? next : undefined })
  }

  const isVisual = obj.type !== 'audio'

  return (
    <div
      className="w-64 bg-surface border-l border-border p-4 overflow-y-auto text-sm"
      style={activeColor ? { boxShadow: `inset 0 0 0 3px ${activeColor}` } : undefined}
    >
      {/* Editing-a-keyframe banner: loud, colored, and matches the canvas selection box + pip */}
      {activeColor && (
        <div
          className="mb-4 -mt-1 flex items-center gap-2 px-2 py-1.5 rounded text-white text-xs font-semibold"
          style={{ background: activeColor }}
        >
          <span className="text-sm leading-none">◆</span>
          <span>Editing Keyframe {activeIdx + 1}</span>
          <span className="ml-auto font-normal opacity-80">changes land here</span>
        </div>
      )}
      {/* Name */}
      <div className="mb-4">
        <input
          type="text"
          value={obj.name}
          onChange={(e) => update({ name: e.target.value })}
          className="w-full bg-surface-muted text-fg text-sm px-2 py-1 rounded border border-border focus:border-accent outline-none"
        />
        <span className="text-[10px] text-subtle mt-1 block capitalize">{obj.type}</span>
      </div>

      {/* Timing */}
      <Accordion title="Timing">
        <Field label="Start (s)">
          <NumberInput value={obj.startTime} min={0} step={0.1} onChange={(v) => update({ startTime: v })} />
        </Field>
        <Field label="Duration (s)">
          <NumberInput value={obj.duration} min={0.1} step={0.1} onChange={(v) => update({ duration: v })} />
        </Field>
        {obj.type !== 'audio' && obj.type !== 'video' && (
          <TypeOnBar
            animateIn={obj.animateIn}
            duration={obj.duration}
            onChange={(v) => dispatch({ type: 'UPDATE_OBJECT_TRANSIENT', objectId: obj.id, updates: { animateIn: v } })}
            onCommit={() => dispatch({ type: 'COMMIT_TRANSIENT' })}
          />
        )}
        <Field label="Lane">
          <NumberInput value={obj.lane} min={0} step={1} onChange={(v) => update({ lane: v })} />
        </Field>
        {(obj.type === 'audio' || obj.type === 'video') && (() => {
          // Speed and trim are orthogonal (spec 14 R3): Speed writes `duration` (span fixed → rate
          // changes) — set here via the slider, since the timeline edges are trim-only now. In/Out
          // write the source span AND recompute `duration` to keep the current speed constant.
          const md = obj.data as AudioData | VideoData
          const inVal = srcIn(md)
          const outVal = srcOut(md)
          const span = Math.max(0.01, sourceSpan(md))
          const rate = span / obj.duration
          const sliderRate = Math.max(RATE_MIN, Math.min(RATE_MAX, rate))
          const r2 = (n: number) => Math.round(n * 100) / 100
          const setSpeed = (s: number) => {
            const clamped = Math.max(RATE_MIN, Math.min(RATE_MAX, s))
            update({ duration: r2(span / clamped) })
          }
          // In/Out are bounded by the clip's recoverable window [srcMin, srcMax] (= [0, originalDuration]
          // for un-split clips; collapsed to the played span after a split so it reads as untrimmed).
          const lo = srcMin(md)
          const hi = srcMax(md)
          const setIn = (v: number) => {
            const nin = Math.max(lo, Math.min(v, outVal - 0.05))
            update({ duration: r2((outVal - nin) / rate), data: { ...md, sourceIn: r2(nin), sourceOut: r2(outVal) } })
          }
          const setOut = (v: number) => {
            const nout = Math.max(inVal + 0.05, Math.min(v, hi))
            update({ duration: r2((nout - inVal) / rate), data: { ...md, sourceIn: r2(inVal), sourceOut: r2(nout) } })
          }
          return (
            <>
              <Field label="Speed">
                <div className="flex items-center gap-2 w-full">
                  <input
                    type="range"
                    min={RATE_MIN} max={RATE_MAX} step={0.1}
                    value={sliderRate}
                    onChange={(e) => setSpeed(Number(e.target.value))}
                    onDoubleClick={() => setSpeed(1)}
                    title="Playback speed — drag to slow down / speed up the clip (double-click for 1×). Changes the clip's length on the timeline."
                    className="w-full"
                  />
                  <span className="text-[10px] text-subtle tabular-nums w-9 text-right">{sliderRate.toFixed(1)}×</span>
                </div>
              </Field>
              <div className="grid grid-cols-2 gap-2">
                <Field label="In (s)">
                  <NumberInput value={r2(inVal)} min={lo} max={outVal} step={0.1} onChange={setIn} />
                </Field>
                <Field label="Out (s)">
                  <NumberInput value={r2(outVal)} min={inVal} max={hi} step={0.1} onChange={setOut} />
                </Field>
              </div>
            </>
          )
        })()}
      </Accordion>

      {/* Position (not for audio — audio has no visual) */}
      {isVisual && (
      <Accordion title="Position">
        <div className="grid grid-cols-2 gap-2">
          <Field label="X">
            <NumberInput value={effVal('x')} step={0.01} onChange={(v) => dispatchPose('x', v, false)} />
          </Field>
          <Field label="Y">
            <NumberInput value={effVal('y')} step={0.01} onChange={(v) => dispatchPose('y', v, false)} />
          </Field>
          <Field label="W">
            <NumberInput value={effVal('width')} step={0.01} min={0.01} onChange={(v) => dispatchPose('width', v, false)} />
          </Field>
          <Field label="H">
            <NumberInput value={effVal('height')} step={0.01} min={0.01} onChange={(v) => dispatchPose('height', v, false)} />
          </Field>
        </div>
        <Field label="Rotation">
          <NumberInput
            value={Math.round(effVal('rotation') * 180 / Math.PI * 10) / 10}
            step={1}
            onChange={(v) => dispatchPose('rotation', v * Math.PI / 180, false)}
          />
        </Field>
        {/* Pin: keep this object at the full frame regardless of any camera zoom. */}
        <Field label="Ignore zoom">
          <input
            type="checkbox"
            checked={obj.ignoreCamera ?? false}
            onChange={(e) => update({ ignoreCamera: e.target.checked })}
            title="When on, this object stays fixed at the full frame and is not affected by camera zooms"
            className="accent-accent cursor-pointer"
          />
        </Field>
      </Accordion>
      )}

      {/* Edit points (arrow/freehand) — spec 17 M. Enter/exit per-object point drawing. */}
      {(obj.type === 'arrow' || obj.type === 'freehand') && onToggleDraw && (
        <Accordion title="Points">
          <button
            onClick={onToggleDraw}
            className={`w-full px-3 py-1.5 text-xs rounded cursor-pointer transition-colors ${
              isDrawing ? 'bg-accent text-accent-contrast hover:bg-accent-hover' : 'bg-surface-muted text-fg hover:bg-surface-hover'
            }`}
          >
            {isDrawing ? 'Done editing points' : 'Edit points'}
          </button>
          <p className="text-[10px] text-subtle">
            {isDrawing
              ? (obj.type === 'arrow'
                  ? 'Click the canvas to add points · right-click, double-click, or Enter to finish.'
                  : 'Draw on the canvas · press Esc or Done when finished.')
              : 'Edit this shape’s points directly on the canvas.'}
          </p>
        </Accordion>
      )}

      {/* Enter / exit animations (visual objects) */}
      {isVisual && (
        <>
          <Accordion title="On Appear">
            <TransitionFields phase="in" value={obj.enter} objDuration={obj.duration} onChange={(t) => update({ enter: t })} />
          </Accordion>
          <Accordion title="On Exit">
            <TransitionFields phase="out" value={obj.exit} objDuration={obj.duration} onChange={(t) => update({ exit: t })} />
          </Accordion>
        </>
      )}

      {/* Keyframes — whole-pose waypoints, created only via the button */}
      {isVisual && (
        <Accordion title="Keyframes">
          {/* Position indicator: playhead vs this object's keyframes (req 6) */}
          {kfs.length > 0 && (
            <>
              <KeyframeTrack obj={obj} kfs={kfs} clipTime={clipTime} activeIdx={activeIdx} onSeek={onSeek} />
              <KeyframeStatus kfs={kfs} clipTime={clipTime} activeIdx={activeIdx} />
            </>
          )}

          {/* Numbered pips (click to jump) — each keeps the keyframe's own accent color */}
          <div className="flex flex-wrap items-center gap-1">
            {kfs.map((k, i) => {
              const color = keyframeColor(i)
              const active = i === activeIdx
              return (
                <button
                  key={i}
                  onClick={() => onSeek(obj.startTime + k.time)}
                  title={`Keyframe ${i + 1} @ ${k.time.toFixed(2)}s — click to jump`}
                  className="px-2 py-0.5 text-[10px] tabular-nums rounded border cursor-pointer transition-colors"
                  style={active
                    ? { background: color, borderColor: '#fff', color: '#fff', fontWeight: 700, boxShadow: `0 0 0 1px ${color}` }
                    : { background: 'transparent', borderColor: color, color }}
                >◆ {i + 1}</button>
              )
            })}
            <button
              onClick={addKeyframe}
              title="Capture the object's current pose as a keyframe at the playhead"
              className="px-1.5 py-0.5 text-[10px] rounded border border-dashed border-border-strong text-muted hover:text-fg hover:border-border-strong cursor-pointer transition-colors"
            >+ Keyframe</button>
          </div>

          {activeIdx >= 0 ? (
            <div className="mt-2 space-y-2">
              <div>
                <label className="text-muted text-xs block mb-1">Motion</label>
                <MotionPicker
                  value={kfs[activeIdx].easing}
                  onChange={(k) => setKeyframeEasing(activeIdx, k)}
                  color={activeColor ?? undefined}
                />
                {/* Clarify: the easing shapes the segment ARRIVING at this keyframe (req 7) */}
                <p className="text-[10px] text-subtle mt-1">
                  Plays as the object animates{' '}
                  <span className="text-muted">
                    {activeIdx === 0 ? 'from its start → Keyframe 1' : `from Keyframe ${activeIdx} → Keyframe ${activeIdx + 1}`}
                  </span>.
                </p>
              </div>
              {/* Lead-in: how long the arriving move takes (spec 21). The rest of the gap holds. */}
              <LeadInField
                value={kfs[activeIdx].leadIn}
                gap={kfGap(activeIdx)}
                color={activeColor ?? undefined}
                onChange={(v) => setKeyframeLeadIn(activeIdx, v)}
              />
              {kfs.length > 1 && (
                <button
                  onClick={() => applyEasingToAllKeyframes(kfs[activeIdx].easing)}
                  title="Give every keyframe on this object the same motion curve as this one"
                  className="w-full px-2 py-1 text-[11px] text-muted bg-surface-muted hover:bg-surface-hover rounded cursor-pointer transition-colors"
                >Apply this motion to all keyframes</button>
              )}
              <button
                onClick={() => deleteKeyframe(activeIdx)}
                className="w-full px-2 py-1 text-[11px] text-danger bg-danger-soft hover:bg-danger/20 rounded cursor-pointer transition-colors"
              >Delete keyframe {activeIdx + 1}</button>
            </div>
          ) : (
            <p className="text-[10px] text-subtle mt-1">
              {kfs.length > 0
                ? 'Jump to a ◆ keyframe to edit it. Moving the object at any other time drops a keyframe there so it passes through that pose; at the very start it moves the home pose instead.'
                : 'Press + Keyframe to start animating from the current pose. Once animating, moving the object at other times adds keyframes automatically.'}
            </p>
          )}
        </Accordion>
      )}

      {/* Volume (audio/video) */}
      {(obj.type === 'audio' || obj.type === 'video') && (() => {
        const md = obj.data as AudioData | VideoData
        const muted = md.muted ?? false
        return (
          <Accordion title="Audio">
            <Field label="Mute">
              <input
                type="checkbox"
                checked={muted}
                onChange={(e) => update({ data: { ...md, muted: e.target.checked } })}
                title={obj.type === 'video'
                  ? "Silence this video's audio track in preview and export (the video still shows)"
                  : "Silence this clip in preview and export"}
                className="accent-accent cursor-pointer"
              />
            </Field>
            <Field label="Volume">
              <div className={`flex items-center gap-2 w-full ${muted ? 'opacity-40' : ''}`}>
                <input
                  type="range"
                  min={0} max={100} step={1}
                  value={Math.round(md.volume * 100)}
                  disabled={muted}
                  onChange={(e) => update({ data: { ...md, volume: Number(e.target.value) / 100 } })}
                  className="w-full"
                />
                <span className="text-[10px] text-subtle tabular-nums w-8 text-right">
                  {Math.round(md.volume * 100)}%
                </span>
              </div>
            </Field>
          </Accordion>
        )
      })()}

      {/* Style (for non-photo, non-audio, non-video objects) */}
      {obj.type !== 'photo' && obj.type !== 'audio' && obj.type !== 'video' && (
        <Accordion title="Style">
          <Field label="Color">
            <input
              type="color"
              value={obj.style.color}
              onChange={(e) => updateStyle({ color: e.target.value })}
              className="w-8 h-6 bg-transparent border-none cursor-pointer"
            />
          </Field>
          <Field label="Opacity">
            <input
              type="range"
              min={0} max={100} step={1}
              value={Math.round(effVal('opacity') * 100)}
              onChange={(e) => dispatchPose('opacity', Number(e.target.value) / 100, true)}
              onPointerUp={commitPose}
              onKeyUp={commitPose}
              className="w-full"
            />
          </Field>
          <Field label="Line width">
            <NumberInput value={obj.style.lineWidth} min={1} max={20} step={1} onChange={(v) => updateStyle({ lineWidth: v })} />
          </Field>
          {obj.type === 'text' && (obj.data as TextData).autoSize === false && (
            <Field label="Font size">
              <NumberInput value={obj.style.fontSize ?? 32} min={8} max={200} step={1} onChange={(v) => updateStyle({ fontSize: v })} />
            </Field>
          )}
          {obj.type === 'text' && (
            <Field label="Background">
              <div className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={(obj.data as TextData).background != null}
                  onChange={(e) => {
                    const data = obj.data as TextData
                    const next = e.target.checked ? (data.background ?? '#000000') : undefined
                    updateData({ background: next }, { background: next })
                  }}
                  className="accent-accent cursor-pointer"
                />
                {(obj.data as TextData).background != null && (
                  <input
                    type="color"
                    value={(obj.data as TextData).background ?? '#000000'}
                    onChange={(e) => updateData({ background: e.target.value }, { background: e.target.value })}
                    className="w-8 h-6 bg-transparent border-none cursor-pointer"
                  />
                )}
              </div>
            </Field>
          )}
          {/* Corner radius rounds the background panel; only meaningful when a background is set. */}
          {obj.type === 'text' && (obj.data as TextData).background != null && (
            <Field label="Corner radius">
              <div className="flex items-center gap-2 w-full">
                <input
                  type="range"
                  min={0} max={200} step={1}
                  value={(obj.data as TextData).cornerRadius ?? 0}
                  onChange={(e) => {
                    const cornerRadius = Number(e.target.value)
                    updateData({ cornerRadius }, { cornerRadius })
                  }}
                  onDoubleClick={() => updateData({ cornerRadius: 0 }, { cornerRadius: 0 })}
                  className="w-full"
                />
                <span className="text-[10px] text-subtle tabular-nums w-8 text-right">
                  {(obj.data as TextData).cornerRadius ?? 0}
                </span>
              </div>
            </Field>
          )}
        </Accordion>
      )}

      {/* Text-specific */}
      {obj.type === 'text' && (
        <Accordion title="Text">
          <textarea
            value={(obj.data as TextData).content}
            onChange={(e) => update({ data: { ...(obj.data as TextData), content: e.target.value } })}
            rows={3}
            placeholder="Enter text…"
            className="w-full bg-surface-muted text-fg text-xs px-2 py-1 rounded border border-border focus:border-accent outline-none resize-y"
          />
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
          {/* Auto-size: fill the box (default). When off, the manual Font size field appears above. */}
          <Field label="Auto-size">
            <input
              type="checkbox"
              checked={(obj.data as TextData).autoSize !== false}
              onChange={(e) => updateData({ autoSize: e.target.checked }, { autoSize: e.target.checked })}
              title="When on, the text is sized to fill its box. When off, use the Font size field."
              className="accent-accent cursor-pointer"
            />
          </Field>
          <Field label="Align">
            <select
              value={(obj.data as TextData).align ?? 'center'}
              onChange={(e) => updateData({ align: e.target.value as TextAlign }, { align: e.target.value })}
              className={SELECT_CLS}
            >
              <option value="left">Left</option>
              <option value="center">Centre</option>
              <option value="right">Right</option>
              <option value="justify">Justify</option>
            </select>
          </Field>
          <Field label="Bold">
            <input
              type="checkbox"
              checked={(obj.style.fontWeight ?? 'bold') === 'bold'}
              onChange={(e) => updateStyle({ fontWeight: e.target.checked ? 'bold' : 'normal' })}
              className="accent-accent cursor-pointer"
            />
          </Field>
          <Field label="Italic">
            <input
              type="checkbox"
              checked={(obj.style.fontStyle ?? 'normal') === 'italic'}
              onChange={(e) => updateStyle({ fontStyle: e.target.checked ? 'italic' : 'normal' })}
              className="accent-accent cursor-pointer"
            />
          </Field>
        </Accordion>
      )}

      {/* Text effects (spec 19): one effect per text object; "None" removes it. */}
      {obj.type === 'text' && (
        <Accordion title="Effects">
          <EffectFields
            value={(obj.data as TextData).effect}
            onChange={(effect) => updateData({ effect }, { effect })}
          />
        </Accordion>
      )}

      {/* Arrow-specific */}
      {obj.type === 'arrow' && (
        <Accordion title="Arrow">
          <Field label="Moving head">
            <input
              type="checkbox"
              checked={(obj.data as ArrowData).progressiveHead ?? true}
              onChange={(e) => updateData({ progressiveHead: e.target.checked }, { progressiveHead: e.target.checked })}
              className="accent-accent cursor-pointer"
            />
          </Field>
          <Field label="Curvature">
            <div className="flex items-center gap-2 w-full">
              <input
                type="range"
                min={-100} max={100} step={1}
                value={Math.round(((obj.data as ArrowData).curvature ?? 0) * 100)}
                onChange={(e) => {
                  const curvature = Number(e.target.value) / 100
                  updateData({ curvature }, { curvature })
                }}
                onDoubleClick={() => updateData({ curvature: 0 }, { curvature: 0 })}
                className="w-full"
              />
              <span className="text-[10px] text-subtle tabular-nums w-8 text-right">
                {((obj.data as ArrowData).curvature ?? 0).toFixed(1)}
              </span>
            </div>
          </Field>
        </Accordion>
      )}

      {/* Photo/video opacity */}
      {(obj.type === 'photo' || obj.type === 'video') && (
        <Accordion title="Style">
          <Field label="Opacity">
            <input
              type="range"
              min={0} max={100} step={1}
              value={Math.round(effVal('opacity') * 100)}
              onChange={(e) => dispatchPose('opacity', Number(e.target.value) / 100, true)}
              onPointerUp={commitPose}
              onKeyUp={commitPose}
              className="w-full"
            />
          </Field>
        </Accordion>
      )}

      {/* Actions */}
      <div className="mt-4 space-y-2">
        <button
          onClick={() => dispatch({ type: 'DUPLICATE_OBJECT', objectId: obj.id })}
          className="w-full px-3 py-1.5 text-xs bg-surface-muted hover:bg-surface-hover rounded transition-colors cursor-pointer"
        >
          Duplicate
        </button>
        <button
          onClick={() => dispatch({ type: 'REMOVE_OBJECT', objectId: obj.id })}
          className="w-full px-3 py-1.5 text-xs bg-danger-soft hover:bg-danger/20 text-danger rounded transition-colors cursor-pointer"
        >
          Delete
        </button>
      </div>
    </div>
  )
}

// --- Camera zoom editor (spec 13) ---
// Rendered in the panel slot when a zoom is selected instead of the object editor.
function ZoomEditor({
  zoom, dispatch, globalTime, onSeek,
}: {
  zoom: CameraZoom
  dispatch: React.Dispatch<ProjectAction>
  globalTime: number
  onSeek: (t: number) => void
}) {
  const update = (updates: Partial<Omit<CameraZoom, 'id'>>) =>
    dispatch({ type: 'UPDATE_ZOOM', zoomId: zoom.id, updates })

  const envelope = zoom.transitionIn + zoom.hold + zoom.transitionOut
  const end = zoom.startTime + envelope
  const withinSpan = globalTime >= zoom.startTime && globalTime <= end

  // Keyframe (pan/scale path) state. Hold-relative playhead time is where edits land.
  const holdTime = Math.max(0, Math.min(zoom.hold, zoomHoldTime(zoom, globalTime)))
  const pose = zoomTargetPoseAt(zoom, globalTime)
  const kfs = zoom.keyframes ?? []
  const activeIdx = activeZoomKeyframeIndex(zoom, globalTime)
  const activeColor = activeIdx >= 0 ? keyframeColor(activeIdx) : null

  // Edit a pose component keyframe-aware: reshapes the active keyframe, drops one mid-hold on a
  // keyframed zoom, or moves the home/base pose otherwise.
  const editZoom = (overrides: Partial<{ x: number; y: number; scale: number }>) =>
    update(editZoomPose(zoom, overrides, holdTime))
  const addZoomKeyframe = () => update({ keyframes: addZoomKeyframeAt(zoom, holdTime) })
  const setZoomKeyframeEasing = (idx: number, easing: EasingKind) =>
    update({ keyframes: kfs.map((k, j) => (j === idx ? { ...k, easing } : k)) })
  const applyZoomEasingToAllKeyframes = (easing: EasingKind) =>
    update({ keyframes: kfs.map((k) => ({ ...k, easing })) })
  const setZoomKeyframeLeadIn = (idx: number, leadIn: number) =>
    update({ keyframes: kfs.map((k, j) => (j === idx ? { ...k, leadIn } : k)) })
  // Gap from the previous waypoint (home pose at hold-relative 0 for the first keyframe).
  const zkfGap = (idx: number) => kfs[idx].time - (idx > 0 ? kfs[idx - 1].time : 0)
  const deleteZoomKeyframe = (idx: number) => {
    const next = kfs.filter((_, j) => j !== idx)
    update({ keyframes: next.length ? next : undefined })
  }

  return (
    <div
      className="w-64 bg-surface border-l border-border p-4 overflow-y-auto text-sm"
      style={activeColor ? { boxShadow: `inset 0 0 0 3px ${activeColor}` } : undefined}
    >
      {/* Header — turns into the keyframe's color when the playhead is parked on one. */}
      <div
        className="mb-4 flex items-center gap-2 px-2 py-1.5 rounded text-white text-xs font-semibold"
        style={{ background: activeColor ?? 'rgba(217,119,6,0.8)' }}
      >
        <span className="text-sm leading-none">{activeColor ? '◆' : '⛶'}</span>
        <span>{activeColor ? `Camera Zoom · Keyframe ${activeIdx + 1}` : 'Camera Zoom'}</span>
      </div>
      <p className="text-[10px] text-subtle mb-4 -mt-2">
        Frame a region to punch into. Edit the framing rectangle on the canvas, or the numbers below.
        Add keyframes to pan / scale across the hold. Toggle <span className="text-muted">Live</span> to preview.
      </p>

      {/* Focus target — keyframe-aware (shows + edits the pose at the playhead) */}
      <Accordion title="Focus">
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
      </Accordion>

      {/* Timing envelope */}
      <Accordion title="Timing">
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
          <label className="text-muted text-xs block mb-1">Motion</label>
          <MotionPicker value={zoom.easing} onChange={(k) => update({ easing: k })} />
          <p className="text-[10px] text-subtle mt-1">Shapes both the push-in and the pull-out ramps.</p>
        </div>
        <div className="flex items-center justify-between text-[10px] text-subtle tabular-nums pt-1">
          <span>Span: {zoom.startTime.toFixed(1)}s → {end.toFixed(1)}s</span>
          <span>({envelope.toFixed(1)}s)</span>
        </div>
        <button
          onClick={() => onSeek(zoom.startTime)}
          className={`w-full px-2 py-1 text-[11px] rounded cursor-pointer transition-colors ${
            withinSpan ? 'bg-surface-muted text-muted hover:bg-surface-hover' : 'bg-accent-soft text-accent hover:bg-accent/20'
          }`}
          title="Move the playhead to this zoom's start"
        >
          {withinSpan ? 'Playhead is on this zoom' : 'Jump to zoom start'}
        </button>
      </Accordion>

      {/* Keyframes — a pan/scale path over the hold (parity with object keyframes) */}
      <Accordion title="Keyframes">
        {kfs.length > 0 && (
          <ZoomKeyframeTrack zoom={zoom} kfs={kfs} holdTime={holdTime} activeIdx={activeIdx} onSeek={onSeek} />
        )}

        {/* Numbered pips (click to jump) — each keeps the keyframe's own accent color */}
        <div className="flex flex-wrap items-center gap-1">
          {kfs.map((k, i) => {
            const color = keyframeColor(i)
            const active = i === activeIdx
            return (
              <button
                key={i}
                onClick={() => onSeek(zoom.startTime + zoom.transitionIn + k.time)}
                title={`Keyframe ${i + 1} @ ${k.time.toFixed(2)}s into the hold — click to jump`}
                className="px-2 py-0.5 text-[10px] tabular-nums rounded border cursor-pointer transition-colors"
                style={active
                  ? { background: color, borderColor: '#fff', color: '#fff', fontWeight: 700, boxShadow: `0 0 0 1px ${color}` }
                  : { background: 'transparent', borderColor: color, color }}
              >◆ {i + 1}</button>
            )
          })}
          <button
            onClick={addZoomKeyframe}
            title="Capture the current framing as a keyframe at the playhead"
            className="px-1.5 py-0.5 text-[10px] rounded border border-dashed border-border-strong text-muted hover:text-fg hover:border-border-strong cursor-pointer transition-colors"
          >+ Keyframe</button>
        </div>

        {activeIdx >= 0 ? (
          <div className="mt-2 space-y-2">
            <div>
              <label className="text-muted text-xs block mb-1">Motion</label>
              <MotionPicker
                value={kfs[activeIdx].easing}
                onChange={(k) => setZoomKeyframeEasing(activeIdx, k)}
                color={activeColor ?? undefined}
              />
              <p className="text-[10px] text-subtle mt-1">Shapes the pan / scale arriving at this keyframe.</p>
            </div>
            {/* Lead-in: how long the pan/scale into this keyframe takes; the rest of the gap holds. */}
            <LeadInField
              value={kfs[activeIdx].leadIn}
              gap={zkfGap(activeIdx)}
              color={activeColor ?? undefined}
              onChange={(v) => setZoomKeyframeLeadIn(activeIdx, v)}
            />
            {kfs.length > 1 && (
              <button
                onClick={() => applyZoomEasingToAllKeyframes(kfs[activeIdx].easing)}
                title="Give every keyframe on this zoom the same motion curve as this one"
                className="w-full px-2 py-1 text-[11px] text-muted bg-surface-muted hover:bg-surface-hover rounded cursor-pointer transition-colors"
              >Apply this motion to all keyframes</button>
            )}
            <button
              onClick={() => deleteZoomKeyframe(activeIdx)}
              className="w-full px-2 py-1 text-[11px] text-danger bg-danger-soft hover:bg-danger/20 rounded cursor-pointer transition-colors"
            >Delete keyframe {activeIdx + 1}</button>
          </div>
        ) : (
          <p className="text-[10px] text-subtle mt-1">
            {kfs.length > 0
              ? 'Jump to a ◆ keyframe to edit it. Reframe elsewhere in the hold to drop a keyframe there; at the hold start it moves the home pose.'
              : 'Add keyframes to pan / scale the camera across the hold. Press + Keyframe, then move the playhead and reframe to build a path.'}
          </p>
        )}
      </Accordion>

      {/* Actions */}
      <div className="mt-4">
        <button
          onClick={() => dispatch({ type: 'REMOVE_ZOOM', zoomId: zoom.id })}
          className="w-full px-3 py-1.5 text-xs bg-danger-soft hover:bg-danger/20 text-danger rounded transition-colors cursor-pointer"
        >
          Delete zoom
        </button>
      </div>
    </div>
  )
}

// Human labels for the effect kinds (spec 23). Kind is fixed at creation — no switcher.
const EFFECT_LABEL: Record<VideoEffectKind, string> = {
  grayscale: 'Black & White',
  sepia: 'Sepia',
  invert: 'Invert',
  vignette: 'Vignette',
  grain: 'Film Grain',
  oldfilm: 'Old Film',
}

const EFFECT_COLOR = '#d946ef' // fuchsia — distinct from the violet video bars + amber camera zoom

/**
 * Editor for a selected video effect (spec 23) — mirrors ZoomEditor. Shared controls (intensity +
 * timing envelope + motion) plus a vignette-only Shape/Size/Feather block. Kind is fixed at creation.
 */
function EffectEditor({
  effect, dispatch, globalTime, onSeek,
}: {
  effect: VideoEffect
  dispatch: React.Dispatch<ProjectAction>
  globalTime: number
  onSeek: (t: number) => void
}) {
  const update = (updates: Partial<Omit<VideoEffect, 'id'>>) =>
    dispatch({ type: 'UPDATE_EFFECT', effectId: effect.id, updates })
  const updateTransient = (updates: Partial<Omit<VideoEffect, 'id'>>) =>
    dispatch({ type: 'UPDATE_EFFECT_TRANSIENT', effectId: effect.id, updates })
  const commit = () => dispatch({ type: 'COMMIT_TRANSIENT' })

  const envelope = effect.transitionIn + effect.hold + effect.transitionOut
  const end = effect.startTime + envelope
  const withinSpan = globalTime >= effect.startTime && globalTime <= end
  const vig = effect.vignette
  const old = effect.oldfilm

  // Update one vignette param (dispatched whole — UPDATE_EFFECT shallow-merges the top level only).
  const updateVignette = (patch: Partial<NonNullable<VideoEffect['vignette']>>) => {
    if (!vig) return
    update({ vignette: { ...vig, ...patch } })
  }

  return (
    <div className="w-64 bg-surface border-l border-border p-4 overflow-y-auto text-sm">
      <div
        className="mb-4 flex items-center gap-2 px-2 py-1.5 rounded text-white text-xs font-semibold"
        style={{ background: EFFECT_COLOR }}
      >
        <IconSparkles size={15} stroke={2} />
        <span>{EFFECT_LABEL[effect.kind]}</span>
      </div>
      <p className="text-[10px] text-subtle mb-4 -mt-2">
        A render-wide effect. Drag its bar on the timeline to move or lengthen it; it fades in / out
        over the ease in / out. Applies in both Frame and Live view.
      </p>

      {/* Intensity — peak strength; fades in/out via the envelope */}
      <Accordion title="Style" defaultOpen>
        <Field label="Intensity">
          <div className="flex items-center gap-2 w-full">
            <input
              type="range"
              min={0} max={100} step={1}
              value={Math.round(effect.intensity * 100)}
              onChange={(e) => updateTransient({ intensity: Number(e.target.value) / 100 })}
              onPointerUp={commit}
              onKeyUp={commit}
              className="w-full"
            />
            <span className="text-[10px] text-subtle tabular-nums w-8 text-right">
              {Math.round(effect.intensity * 100)}%
            </span>
          </div>
        </Field>
      </Accordion>

      {/* Vignette-only shape controls */}
      {effect.kind === 'vignette' && vig && (
        <Accordion title="Vignette" defaultOpen>
          <Field label="Shape">
            <select
              value={vig.shape}
              onChange={(e) => updateVignette({ shape: e.target.value as VignetteShape })}
              className={SELECT_CLS}
            >
              <option value="rectangle">Rectangle (screen)</option>
              <option value="circle">Circle</option>
            </select>
          </Field>
          <Field label="Size">
            <div className="flex items-center gap-2 w-full">
              <input
                type="range"
                min={0} max={100} step={1}
                value={Math.round(vig.size * 100)}
                onChange={(e) => updateTransient({ vignette: { ...vig, size: Number(e.target.value) / 100 } })}
                onPointerUp={commit}
                onKeyUp={commit}
                className="w-full"
              />
              <span className="text-[10px] text-subtle tabular-nums w-8 text-right">{Math.round(vig.size * 100)}%</span>
            </div>
          </Field>
          <Field label="Feather">
            <div className="flex items-center gap-2 w-full">
              <input
                type="range"
                min={0} max={100} step={1}
                value={Math.round(vig.feather * 100)}
                onChange={(e) => updateTransient({ vignette: { ...vig, feather: Number(e.target.value) / 100 } })}
                onPointerUp={commit}
                onKeyUp={commit}
                className="w-full"
              />
              <span className="text-[10px] text-subtle tabular-nums w-8 text-right">{Math.round(vig.feather * 100)}%</span>
            </div>
          </Field>
        </Accordion>
      )}

      {/* Old-film-only wobble (gate weave) — decoupled from intensity, defaults to 0 */}
      {effect.kind === 'oldfilm' && old && (
        <Accordion title="Old Film" defaultOpen>
          <Field label="Wobble">
            <div className="flex items-center gap-2 w-full">
              <input
                type="range"
                min={0} max={100} step={1}
                value={Math.round(old.wobble * 100)}
                onChange={(e) => updateTransient({ oldfilm: { ...old, wobble: Number(e.target.value) / 100 } })}
                onPointerUp={commit}
                onKeyUp={commit}
                className="w-full"
              />
              <span className="text-[10px] text-subtle tabular-nums w-8 text-right">{Math.round(old.wobble * 100)}%</span>
            </div>
          </Field>
          <p className="text-[10px] text-subtle">Frame jitter / gate weave — independent of Intensity (which drives scratches, dust &amp; flicker).</p>
        </Accordion>
      )}

      {/* Timing envelope — identical shape to the zoom's */}
      <Accordion title="Timing">
        <Field label="Start (s)">
          <NumberInput value={effect.startTime} min={0} step={0.1} onChange={(v) => update({ startTime: Math.max(0, v) })} />
        </Field>
        <Field label="Ease in (s)">
          <NumberInput value={effect.transitionIn} min={0} step={0.1} onChange={(v) => update({ transitionIn: Math.max(0, v) })} />
        </Field>
        <Field label="Hold (s)">
          <NumberInput value={effect.hold} min={0} step={0.1} onChange={(v) => update({ hold: Math.max(0, v) })} />
        </Field>
        <Field label="Ease out (s)">
          <NumberInput value={effect.transitionOut} min={0} step={0.1} onChange={(v) => update({ transitionOut: Math.max(0, v) })} />
        </Field>
        <div>
          <label className="text-muted text-xs block mb-1">Motion</label>
          <MotionPicker value={effect.easing} onChange={(k) => update({ easing: k })} />
          <p className="text-[10px] text-subtle mt-1">Shapes both the fade-in and fade-out ramps.</p>
        </div>
        <div className="flex items-center justify-between text-[10px] text-subtle tabular-nums pt-1">
          <span>Span: {effect.startTime.toFixed(1)}s → {end.toFixed(1)}s</span>
          <span>({envelope.toFixed(1)}s)</span>
        </div>
        <button
          onClick={() => onSeek(effect.startTime)}
          className={`w-full px-2 py-1 text-[11px] rounded cursor-pointer transition-colors ${
            withinSpan ? 'bg-surface-muted text-muted hover:bg-surface-hover' : 'bg-accent-soft text-accent hover:bg-accent/20'
          }`}
          title="Move the playhead to this effect's start"
        >
          {withinSpan ? 'Playhead is on this effect' : 'Jump to effect start'}
        </button>
      </Accordion>

      <div className="mt-4">
        <button
          onClick={() => dispatch({ type: 'REMOVE_EFFECT', effectId: effect.id })}
          className="w-full px-3 py-1.5 text-xs bg-danger-soft hover:bg-danger/20 text-danger rounded transition-colors cursor-pointer"
        >
          Delete effect
        </button>
      </div>
    </div>
  )
}

// --- Inspector section (spec 17 P3) ---
// Distinct, iconed, collapsible cards — the fix for the "sections aren't distinct" complaint. This
// is inspector-only chrome; the toolbar popovers keep the plain `Section` from propertyControls.
const SECTION_ICONS: Record<string, React.ReactNode> = {
  Timing: <IconClock size={15} stroke={2} />,
  Position: <IconArrowsMove size={15} stroke={2} />,
  Points: <IconVector size={15} stroke={2} />,
  'On Appear': <IconLogin size={15} stroke={2} />,
  'On Exit': <IconLogout size={15} stroke={2} />,
  Keyframes: <IconDiamond size={15} stroke={2} />,
  Audio: <IconVolume size={15} stroke={2} />,
  Style: <IconPalette size={15} stroke={2} />,
  Text: <IconTypography size={15} stroke={2} />,
  Arrow: <IconArrowUpRight size={15} stroke={2} />,
  Focus: <IconFocusCentered size={15} stroke={2} />,
  Effects: <IconSparkles size={15} stroke={2} />,
  Vignette: <IconSparkles size={15} stroke={2} />,
  'Old Film': <IconSparkles size={15} stroke={2} />,
}

function Accordion({ title, children, defaultOpen = false }: { title: string; children: React.ReactNode; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <div className="mb-2 overflow-hidden rounded-lg border border-border bg-surface-muted/40">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-2 px-2.5 py-2 text-left transition-colors hover:bg-surface-hover cursor-pointer"
      >
        <span className="text-subtle">{SECTION_ICONS[title]}</span>
        <span className="flex-1 text-[11px] font-semibold uppercase tracking-wider text-fg">{title}</span>
        <IconChevronDown size={14} stroke={2} className={`text-subtle transition-transform ${open ? '' : '-rotate-90'}`} />
      </button>
      {open && <div className="space-y-2 px-2.5 pb-2.5 pt-0.5">{children}</div>}
    </div>
  )
}

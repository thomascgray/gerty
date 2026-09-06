import { useState } from 'react'
import {
  IconClock, IconArrowsMove, IconVector, IconLogin, IconLogout, IconDiamond,
  IconVolume, IconPalette, IconTypography, IconArrowUpRight, IconFocusCentered, IconChevronDown,
  IconFilters, IconMusic, IconWaveSine, IconBadgeCc, IconTrash,
  IconArrowUp, IconArrowDown, IconEye, IconEyeOff, IconPlus,
} from '@tabler/icons-react'
import { createCaptionCue, createEffectLayer, loopEffectsOf, textEffectsOf } from '../types'
import { EFFECT_ICON } from './effectIcons'
import type {
  TimelineObject, ProjectAction, ArrowData, AudioData, VideoData, TextData, TextAlign, PhotoData,
  AnimatableProperty, AnimatableChannel, ChannelValue, EasingKind, CameraZoom,
  VideoEffect, EffectLayer, VideoEffectKind, VignetteShape, GradientMapPreset, ChannelSwapMapping, AssetMeta,
  CaptionTrack, AutoLevelMode,
} from '../types'
import { getDownloadOptions } from '../lib/objectDownload'
import { analyzeAssetLoudness } from '../lib/assetStore'
import { DEFAULT_AUTO_LEVEL_MODE, DEFAULT_AUTO_LEVEL_AMOUNT } from '../lib/loudness'
import {
  KF_EPS, effVal as kfEffVal, editPose, editChannel, toggleChannel, addKeyframeAt, keyframeColor,
  channelValueAt, animatedChannels, declares, declaredChannels, channelsFor, CHANNELS_BY_KEY,
} from '../lib/keyframes'
import type { PanelSection } from '../lib/keyframes'
import {
  zoomHoldTime, zoomTargetPoseAt, editZoomPose, addZoomKeyframeAt, activeZoomKeyframeIndex,
} from '../lib/camera'
import { clamp01 } from '../lib/easing'
import { toHexColor as hexOf } from '../lib/color'
import { srcIn, srcOut, sourceSpan, srcMin, srcMax, RATE_MIN, RATE_MAX } from '../lib/mediaTiming'
import { rememberObjectStyle, rememberObjectData } from '../lib/objectDefaults'
import {
  Field, NumberInput, TransitionFields, TypeOnBar, EffectFieldsStack, LoopFieldsStack, KeyframeDot,
  KeyframeTrack, KeyframeStatus, ZoomKeyframeTrack, MotionPicker, LeadInField, SELECT_CLS,
} from './propertyControls'

type PropertiesPanelProps = {
  object: TimelineObject | null
  zoom?: CameraZoom | null
  effect?: VideoEffect | null
  caption?: CaptionTrack | null
  // Re-open the auto-captions modal to regenerate the track (spec 35).
  onRegenerateCaptions?: () => void
  dispatch: React.Dispatch<ProjectAction>
  globalTime: number
  onSeek: (t: number) => void
  // Arrow/freehand point editing ("Edit points", spec 17 M). onToggleDraw enters/exits drawing.
  isDrawing?: boolean
  onToggleDraw?: () => void
  // Duplicate routes through App so the copy lands at the playhead on a new lane + gets selected.
  onDuplicate?: (objectId: string) => void
  // Download the media object to disk — 'original' source blob, or a 'processed' re-encode
  // (trimmed clip / extracted audio). Routes through App, which owns the project + toasts.
  onDownload?: (objectId: string, mode: 'original' | 'processed') => void
  // Re-open the TTS modal to re-generate a narration clip's audio (spec 32). Only shown for audio
  // clips carrying `data.tts`.
  onEditNarration?: (objectId: string) => void
  assets?: AssetMeta[]
}

/**
 * Audio accordion for an audio/video clip (spec 38): mute, volume (0-200%), auto-level (dynamic
 * loudness balancing with switchable modes + amount), and skip-captions. Its own component so it can
 * hold the one-shot "analyzing" state without adding a hook to the early-returning main panel.
 */
function AudioControls({ obj, dispatch }: { obj: TimelineObject; dispatch: (action: ProjectAction) => void }) {
  const md = obj.data as AudioData | VideoData
  const muted = md.muted ?? false
  const autoLevel = md.autoLevel ?? false
  const mode = md.autoLevelMode ?? DEFAULT_AUTO_LEVEL_MODE
  const amount = md.autoLevelAmount ?? DEFAULT_AUTO_LEVEL_AMOUNT
  const [analyzing, setAnalyzing] = useState(false)

  const update = (updates: Partial<Omit<TimelineObject, 'id' | 'type'>>) =>
    dispatch({ type: 'UPDATE_OBJECT', objectId: obj.id, updates })

  // Enable auto-level: analyze the source ONCE (lazily), cache it on the clip, then flip on. Re-enabling
  // an already-analyzed clip is instant. Disabling keeps the cache (and mode/amount) for next time.
  const toggleAutoLevel = async (on: boolean) => {
    if (!on) {
      update({ data: { ...md, autoLevel: false } })
      return
    }
    const enable = (loudness: number[]) =>
      update({ data: { ...md, autoLevel: true, autoLevelMode: mode, autoLevelAmount: amount, loudness } })
    if (md.loudness && md.loudness.length > 0) {
      enable(md.loudness)
      return
    }
    setAnalyzing(true)
    const loudness = await analyzeAssetLoudness(md.assetId)
    setAnalyzing(false)
    if (loudness) enable(loudness)
  }

  const MODES: { key: AutoLevelMode; label: string; title: string }[] = [
    { key: 'smooth', label: 'Smooth', title: 'Gentle, slow drift correction - most natural, best for loud-start/quiet-end clips' },
    { key: 'balanced', label: 'Balanced', title: 'Moderate leveling - a good general default' },
    { key: 'aggressive', label: 'Aggressive', title: 'Fast, near-flat leveling - for very uneven or very quiet sources' },
  ]

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
            min={0} max={200} step={1}
            value={Math.round(md.volume * 100)}
            disabled={muted}
            onChange={(e) => update({ data: { ...md, volume: Number(e.target.value) / 100 } })}
            title="Clip volume (up to 200% to boost a quietly-recorded source)"
            className="w-full"
          />
          <span className="text-[10px] text-subtle tabular-nums w-8 text-right">
            {Math.round(md.volume * 100)}%
          </span>
        </div>
      </Field>
      {/* Auto-level (spec 38): dynamic loudness balancing across the clip. */}
      <Field label="Auto level">
        <input
          type="checkbox"
          checked={autoLevel}
          disabled={analyzing}
          onChange={(e) => toggleAutoLevel(e.target.checked)}
          title="Even out loudness across this clip (boosts quiet stretches, tames loud ones). Applies in preview and export."
          className="accent-accent cursor-pointer"
        />
      </Field>
      {analyzing && (
        <div className="text-[10px] text-subtle mb-2 pl-1">Analyzing...</div>
      )}
      {autoLevel && !analyzing && (
        <>
          <Field label="Mode">
            <div className="flex gap-1 w-full">
              {MODES.map((m) => (
                <button
                  key={m.key}
                  onClick={() => update({ data: { ...md, autoLevelMode: m.key } })}
                  title={m.title}
                  className={`flex-1 px-1 py-0.5 text-[10px] rounded cursor-pointer transition-colors ${
                    mode === m.key ? 'bg-accent text-accent-contrast' : 'bg-surface-muted text-muted hover:bg-surface-hover'
                  }`}
                >
                  {m.label}
                </button>
              ))}
            </div>
          </Field>
          <Field label="Amount">
            <div className="flex items-center gap-2 w-full">
              <input
                type="range"
                min={0} max={100} step={1}
                value={Math.round(amount * 100)}
                onChange={(e) => update({ data: { ...md, autoLevelAmount: Number(e.target.value) / 100 } })}
                title="How strongly to level: 0% = off, 100% = fully even"
                className="w-full"
              />
              <span className="text-[10px] text-subtle tabular-nums w-8 text-right">
                {Math.round(amount * 100)}%
              </span>
            </div>
          </Field>
        </>
      )}
      {/* Auto-captions (spec 35): exclude this clip from the speech-recognition mix, so music /
          singing / sfx don't confuse the transcriber. Doesn't affect playback or export. */}
      <Field label="Skip captions">
        <input
          type="checkbox"
          checked={obj.excludeFromCaptions ?? false}
          onChange={(e) => update({ excludeFromCaptions: e.target.checked })}
          title="Exclude this clip from auto-captions (e.g. music or background audio). Regenerate captions to apply."
          className="accent-accent cursor-pointer"
        />
      </Field>
    </Accordion>
  )
}

export default function PropertiesPanel({ object: obj, zoom, effect, caption, onRegenerateCaptions, dispatch, globalTime, onSeek, isDrawing, onToggleDraw, onDuplicate, onDownload, onEditNarration, assets }: PropertiesPanelProps) {
  // A selected zoom, effect, or caption track takes over the panel (all mutually exclusive).
  if (zoom) {
    return <ZoomEditor zoom={zoom} dispatch={dispatch} globalTime={globalTime} onSeek={onSeek} />
  }
  if (effect) {
    // key by id so the add-layer picker's open state resets when a different effect is selected.
    return <EffectEditor key={effect.id} effect={effect} dispatch={dispatch} globalTime={globalTime} onSeek={onSeek} />
  }
  if (caption) {
    return <CaptionEditor caption={caption} dispatch={dispatch} globalTime={globalTime} onSeek={onSeek} onRegenerate={onRegenerateCaptions} />
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
  // When parked on a keyframe this accent color marks the banner + the sections that keyframe
  // actually governs — matching the canvas selection box and the timeline diamond.
  const activeColor = activeIdx >= 0 ? keyframeColor(activeIdx) : null
  const activeKf = activeIdx >= 0 ? kfs[activeIdx] : null

  // --- Channels (spec 29) ---
  // Any property in the registry can animate. Fields read their value at the playhead and write
  // through `editChannel`, which decides whether the edit lands on the base value (the whole clip)
  // or on a keyframe — see the rule in keyframes.ts.
  const animated = animatedChannels(obj)
  const chan = (c: AnimatableChannel) => channelValueAt(obj, c, clipTime)
  const chanNum = (c: AnimatableChannel) => (chan(c) as number) ?? 0
  const chanStr = (c: AnimatableChannel) => chan(c) as string | undefined

  const setChan = (c: AnimatableChannel, v: ChannelValue, opts?: { transient?: boolean }) => {
    const updates = editChannel(obj, { [c]: v }, clampTime(clipTime))
    dispatch({
      type: opts?.transient ? 'UPDATE_OBJECT_TRANSIENT' : 'UPDATE_OBJECT',
      objectId: obj.id,
      updates,
    })
    // Remember as the next-object default — but ONLY when the edit landed on the object's base
    // value (a keyframe write produces `keyframes` alone), and never for one-off content.
    if (updates.style) rememberObjectStyle(obj.type, updates.style)
    const field = c.split('.')[1]
    if (updates.data && field && c !== 'text.content') rememberObjectData(obj.type, { [field]: v })
  }

  // The ◆ next to a field: its state, and the click that opts the property in/out of animation.
  const dotFor = (c: AnimatableChannel) => {
    const spec = CHANNELS_BY_KEY[c]
    const state = activeKf && declares(activeKf, c) ? 'active' : animated.has(c) ? 'animated' : 'off'
    return (
      <KeyframeDot
        state={state}
        color={activeColor ?? undefined}
        label={spec?.label ?? c}
        onClick={() => update(toggleChannel(obj, c, clampTime(clipTime)))}
      />
    )
  }

  // Section-level roll-up: a card is tinted when the ACTIVE keyframe governs something inside it,
  // and shows a neutral ◇ when it merely contains something that animates. This is the fix for
  // "the entire right-hand panel goes red" — only the sections a keyframe keeps light up.
  const sectionState: Partial<Record<PanelSection, 'active' | 'animated'>> = {}
  for (const spec of channelsFor(obj.type)) {
    if (!animated.has(spec.key)) continue
    if (activeKf && declares(activeKf, spec.key)) sectionState[spec.section] = 'active'
    else if (!sectionState[spec.section]) sectionState[spec.section] = 'animated'
  }
  const secProps = (s: PanelSection) => ({
    accent: sectionState[s] === 'active' ? activeColor : null,
    marked: sectionState[s] === 'animated',
  })
  // What the active keyframe governs, for the banner ("Keyframe 2 — Position, Text").
  const activeSections = activeKf
    ? [...new Set(declaredChannels(activeKf).map((c) => CHANNELS_BY_KEY[c]?.section).filter(Boolean))]
    : []

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
    <div className="w-64 bg-surface border-l border-border p-4 overflow-y-auto text-sm">
      {/* Editing-a-keyframe banner. It names what the keyframe actually governs — the whole-panel
          colour ring is gone (spec 29 R17); only those sections are tinted below. */}
      {activeColor && (
        <div
          className="mb-4 -mt-1 flex items-center gap-2 px-2 py-1.5 rounded text-white text-xs font-semibold"
          style={{ background: activeColor }}
        >
          <span className="text-sm leading-none">◆</span>
          <span>Keyframe {activeIdx + 1}</span>
          <span className="ml-auto font-normal opacity-80 truncate">
            {activeSections.length ? activeSections.join(', ') : 'nothing set'}
          </span>
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

      {/* Convert a video clip to audio-only (drops the picture, keeps the sound). Sits above the
          sections as a top-level object action. Keyed by id so the confirm state resets per clip. */}
      {obj.type === 'video' && (
        <ConvertToAudioControl
          key={obj.id}
          onConvert={() => dispatch({ type: 'CONVERT_TO_AUDIO', objectId: obj.id })}
        />
      )}

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
      <Accordion title="Position" {...secProps('Position')}>
        <div className="grid grid-cols-2 gap-2">
          <Field label="X" dot={dotFor('x')}>
            <NumberInput value={effVal('x')} step={0.01} onChange={(v) => dispatchPose('x', v, false)} />
          </Field>
          <Field label="Y" dot={dotFor('y')}>
            <NumberInput value={effVal('y')} step={0.01} onChange={(v) => dispatchPose('y', v, false)} />
          </Field>
          <Field label="W" dot={dotFor('width')}>
            <NumberInput value={effVal('width')} step={0.01} min={0.01} onChange={(v) => dispatchPose('width', v, false)} />
          </Field>
          <Field label="H" dot={dotFor('height')}>
            <NumberInput value={effVal('height')} step={0.01} min={0.01} onChange={(v) => dispatchPose('height', v, false)} />
          </Field>
        </div>
        <Field label="Rotation" dot={dotFor('rotation')}>
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
              <p className="text-[10px] text-subtle">
                Anything you change while parked here is set on this keyframe — the ◆ next to a
                field shows what it holds.
              </p>
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
                ? 'Jump to a ◆ keyframe and anything you change there — position, colour, the words — is set on that keyframe. At other times, moving the object drops a keyframe so it passes through that pose, while other properties change for the whole clip unless you ◆ them first.'
                : 'Press + Keyframe to start animating from the current pose. Once animating, moving the object at other times adds keyframes automatically.'}
            </p>
          )}
        </Accordion>
      )}

      {/* Narration (TTS clips only, spec 32): edit the script/voice and re-generate the audio. */}
      {obj.type === 'audio' && (obj.data as AudioData).tts && onEditNarration && (() => {
        const tts = (obj.data as AudioData).tts!
        return (
          <Accordion title="Narration">
            <p className="text-[11px] text-subtle leading-relaxed line-clamp-3 mb-2 italic">"{tts.text}"</p>
            <button
              onClick={() => onEditNarration(obj.id)}
              className="flex items-center justify-center gap-1.5 w-full py-2 text-sm font-medium bg-accent text-accent-contrast rounded-lg hover:bg-accent-hover cursor-pointer transition-colors"
            >
              <IconWaveSine size={15} stroke={2} /> Edit narration
            </button>
          </Accordion>
        )
      })()}

      {/* Volume / mute / auto-level (audio/video) */}
      {(obj.type === 'audio' || obj.type === 'video') && (
        <AudioControls obj={obj} dispatch={dispatch} />
      )}

      {/* Style (for non-photo, non-audio, non-video objects) */}
      {obj.type !== 'photo' && obj.type !== 'audio' && obj.type !== 'video' && (
        <Accordion title="Style" {...secProps('Style')}>
          <Field label="Color" dot={dotFor('style.color')}>
            <input
              type="color"
              value={hexOf(chanStr('style.color'), obj.style.color)}
              onChange={(e) => setChan('style.color', e.target.value)}
              className="w-8 h-6 bg-transparent border-none cursor-pointer"
            />
          </Field>
          <Field label="Opacity" dot={dotFor('opacity')}>
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
          <Field label="Line width" dot={dotFor('style.lineWidth')}>
            <NumberInput value={chanNum('style.lineWidth')} min={1} max={20} step={1} onChange={(v) => setChan('style.lineWidth', v)} />
          </Field>
          {obj.type === 'text' && (obj.data as TextData).autoSize === false && (
            <Field label="Font size" dot={dotFor('style.fontSize')}>
              <NumberInput value={chanNum('style.fontSize')} min={8} max={200} step={1} onChange={(v) => setChan('style.fontSize', v)} />
            </Field>
          )}
          {obj.type === 'text' && (() => {
            const bg = chanStr('text.background')
            return (
              <Field label="Background" dot={dotFor('text.background')}>
                <div className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={bg != null}
                    onChange={(e) => setChan('text.background', e.target.checked ? (bg ?? '#000000') : undefined)}
                    className="accent-accent cursor-pointer"
                  />
                  {bg != null && (
                    <input
                      type="color"
                      value={hexOf(bg, '#000000')}
                      onChange={(e) => setChan('text.background', e.target.value)}
                      className="w-8 h-6 bg-transparent border-none cursor-pointer"
                    />
                  )}
                </div>
              </Field>
            )
          })()}
          {/* Corner radius rounds the background panel; only meaningful when a background is set. */}
          {obj.type === 'text' && chanStr('text.background') != null && (
            <Field label="Corner radius" dot={dotFor('text.cornerRadius')}>
              <div className="flex items-center gap-2 w-full">
                <input
                  type="range"
                  min={0} max={200} step={1}
                  value={Math.round(chanNum('text.cornerRadius'))}
                  onChange={(e) => setChan('text.cornerRadius', Number(e.target.value))}
                  onDoubleClick={() => setChan('text.cornerRadius', 0)}
                  className="w-full"
                />
                <span className="text-[10px] text-subtle tabular-nums w-8 text-right">
                  {Math.round(chanNum('text.cornerRadius'))}
                </span>
              </div>
            </Field>
          )}
        </Accordion>
      )}

      {/* Text-specific */}
      {obj.type === 'text' && (
        <Accordion title="Text" {...secProps('Text')}>
          <div className="flex items-center gap-1 mb-1">
            {dotFor('text.content')}
            <span className="text-muted text-xs">
              {animated.has('text.content')
                ? (activeKf && declares(activeKf, 'text.content') ? 'Words on this keyframe' : 'Words here')
                : 'Words'}
            </span>
          </div>
          <textarea
            value={String(chan('text.content') ?? '')}
            onChange={(e) => setChan('text.content', e.target.value)}
            rows={3}
            placeholder="Enter text…"
            className="w-full bg-surface-muted text-fg text-xs px-2 py-1 rounded border border-border focus:border-accent outline-none resize-y"
          />
          {animated.has('text.content') && (
            <p className="text-[10px] text-subtle">
              The words change over this clip — they wipe from the old text to the new one. Set a
              keyframe's motion to <span className="text-muted">Instant</span> for a hard cut.
            </p>
          )}
          <Field label="Font" dot={dotFor('style.fontFamily')}>
            <select
              value={chanStr('style.fontFamily') ?? 'sans-serif'}
              onChange={(e) => setChan('style.fontFamily', e.target.value)}
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
          <Field label="Align" dot={dotFor('text.align')}>
            <select
              value={(chanStr('text.align') ?? 'center') as TextAlign}
              onChange={(e) => setChan('text.align', e.target.value as TextAlign)}
              className={SELECT_CLS}
            >
              <option value="left">Left</option>
              <option value="center">Centre</option>
              <option value="right">Right</option>
              <option value="justify">Justify</option>
            </select>
          </Field>
          <Field label="Bold" dot={dotFor('style.fontWeight')}>
            <input
              type="checkbox"
              checked={(chanStr('style.fontWeight') ?? 'bold') === 'bold'}
              onChange={(e) => setChan('style.fontWeight', e.target.checked ? 'bold' : 'normal')}
              className="accent-accent cursor-pointer"
            />
          </Field>
          <Field label="Italic" dot={dotFor('style.fontStyle')}>
            <input
              type="checkbox"
              checked={(chanStr('style.fontStyle') ?? 'normal') === 'italic'}
              onChange={(e) => setChan('style.fontStyle', e.target.checked ? 'italic' : 'normal')}
              className="accent-accent cursor-pointer"
            />
          </Field>
        </Accordion>
      )}

      {/* Loop / motion effects (spec 36/37): a STACK of continuous ambient animations on any visual
          object. Edits the `loopEffects` TimelineObject field directly (not a keyframe channel) via
          UPDATE_OBJECT; reads via loopEffectsOf so a legacy single loopEffect still shows. */}
      {obj.type !== 'audio' && (
        <Accordion title="Motion" icon={<IconArrowsMove size={14} />}>
          <LoopFieldsStack
            value={loopEffectsOf(obj)}
            onChange={(loopEffects) => update({ loopEffects, loopEffect: undefined })}
          />
        </Accordion>
      )}

      {/* Text effects (spec 19 / 37 stack): a STACK of glyph effects per text object; combine by
          grouped last-wins (see drawText). Edits data.effects via UPDATE_OBJECT (reads via
          textEffectsOf so a legacy single effect still shows). Only the first layer is keyframable
          (OQ2), resolved in the renderer via the text.effect channel — not surfaced here in v1. */}
      {obj.type === 'text' && (
        <Accordion title="Effects" {...secProps('Effects')}>
          <EffectFieldsStack
            value={textEffectsOf(obj.data as TextData)}
            onChange={(effects) => update({ data: { ...(obj.data as TextData), effects, effect: undefined } })}
          />
        </Accordion>
      )}

      {/* Arrow-specific */}
      {obj.type === 'arrow' && (
        <Accordion title="Arrow" {...secProps('Arrow')}>
          <Field label="Moving head">
            <input
              type="checkbox"
              checked={(obj.data as ArrowData).progressiveHead ?? true}
              onChange={(e) => updateData({ progressiveHead: e.target.checked }, { progressiveHead: e.target.checked })}
              className="accent-accent cursor-pointer"
            />
          </Field>
          <Field label="Curvature" dot={dotFor('arrow.curvature')}>
            <div className="flex items-center gap-2 w-full">
              <input
                type="range"
                min={-100} max={100} step={1}
                value={Math.round(chanNum('arrow.curvature') * 100)}
                onChange={(e) => setChan('arrow.curvature', Number(e.target.value) / 100)}
                onDoubleClick={() => setChan('arrow.curvature', 0)}
                className="w-full"
              />
              <span className="text-[10px] text-subtle tabular-nums w-8 text-right">
                {chanNum('arrow.curvature').toFixed(1)}
              </span>
            </div>
          </Field>
          <Field label="Head size" dot={dotFor('arrow.headSize')}>
            <NumberInput
              value={chanNum('arrow.headSize')}
              min={0} max={200} step={1}
              onChange={(v) => setChan('arrow.headSize', v)}
            />
          </Field>
        </Accordion>
      )}

      {/* Photo/video opacity */}
      {(obj.type === 'photo' || obj.type === 'video') && (
        <Accordion title="Style" {...secProps('Style')}>
          <Field label="Opacity" dot={dotFor('opacity')}>
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
          {/* Animated images only (spec 28 B3/B12): the one playback control. Off = play
              through once, then hold the last frame for the rest of the clip. `data` is
              written WHOLE because UPDATE_OBJECT shallow-merges (a partial would drop assetId). */}
          {obj.type === 'photo' && (obj.data as PhotoData).animated && (() => {
            const pd = obj.data as PhotoData
            return (
              <Field label="Loop">
                <input
                  type="checkbox"
                  checked={pd.loop !== false}
                  onChange={(e) => update({ data: { ...pd, loop: e.target.checked } })}
                  title="Repeat the animation for the whole clip. When off, it plays once and holds the last frame."
                  className="accent-accent cursor-pointer"
                />
              </Field>
            )
          })()}
        </Accordion>
      )}

      {/* Download (media objects only) — original source, plus a re-encode reflecting the edit
          (trimmed clip / extracted audio) when that differs from the original. */}
      {onDownload && (() => {
        const dl = getDownloadOptions(obj, assets ?? [])
        if (!dl.canOriginal) return null
        return (
          <div className="mt-4 space-y-2">
            <button
              onClick={() => onDownload(obj.id, 'original')}
              className="w-full px-3 py-1.5 text-xs bg-surface-muted hover:bg-surface-hover rounded transition-colors cursor-pointer"
            >
              {dl.processed ? 'Download original' : 'Download'}
            </button>
            {dl.processed && (
              <button
                onClick={() => onDownload(obj.id, 'processed')}
                className="w-full px-3 py-1.5 text-xs bg-surface-muted hover:bg-surface-hover rounded transition-colors cursor-pointer"
              >
                {dl.processed.label}
              </button>
            )}
          </div>
        )
      })()}

      {/* Actions */}
      <div className="mt-4 space-y-2">
        <button
          onClick={() => onDuplicate ? onDuplicate(obj.id) : dispatch({ type: 'DUPLICATE_OBJECT', objectId: obj.id })}
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

// Top-level "Convert to audio" action for video clips — a two-step inline confirm (no modal) that
// drops the picture and keeps the sound. Local confirm state; the parent keys it by object id so
// switching selection resets it.
function ConvertToAudioControl({ onConvert }: { onConvert: () => void }) {
  const [confirming, setConfirming] = useState(false)
  if (confirming) {
    return (
      <div className="mb-4 flex items-center gap-1.5">
        <span className="flex-1 text-[11px] text-muted leading-tight">Drop the video, keep audio?</span>
        <button
          onClick={onConvert}
          className="px-2.5 py-1 text-xs font-medium rounded bg-accent text-accent-contrast hover:bg-accent-hover cursor-pointer transition-colors"
        >
          Convert
        </button>
        <button
          onClick={() => setConfirming(false)}
          className="px-2 py-1 text-xs rounded bg-surface-muted hover:bg-surface-hover cursor-pointer transition-colors"
        >
          Cancel
        </button>
      </div>
    )
  }
  return (
    <button
      onClick={() => setConfirming(true)}
      title="Drop the picture and keep this clip as audio only"
      className="mb-4 w-full flex items-center justify-center gap-1.5 px-3 py-1.5 text-xs bg-surface-muted hover:bg-surface-hover rounded transition-colors cursor-pointer"
    >
      <IconMusic size={14} stroke={2} /> Convert to audio
    </button>
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
  hue: 'Hue Shift',
  contrast: 'Contrast Crush',
  bleach: 'Bleach Bypass',
  lightleak: 'Light Leak',
  chromatic: 'Chromatic Split',
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

const EFFECT_COLOR = '#d946ef' // fuchsia — distinct from the violet video bars + amber camera zoom

// Colour Isolate stores a hue (0–360°) but is edited as a colour swatch. These convert between a
// fully-saturated hue and a hex so the native <input type="color"> shows/sets a pure-hue colour.
function hueToHex(h: number): string {
  const hp = ((((h % 360) + 360) % 360)) / 60
  const x = 1 - Math.abs((hp % 2) - 1)
  let r = 0, g = 0, b = 0
  if (hp < 1) { r = 1; g = x } else if (hp < 2) { r = x; g = 1 }
  else if (hp < 3) { g = 1; b = x } else if (hp < 4) { g = x; b = 1 }
  else if (hp < 5) { r = x; b = 1 } else { r = 1; b = x }
  const to = (v: number) => Math.round(v * 255).toString(16).padStart(2, '0')
  return `#${to(r)}${to(g)}${to(b)}`
}
function hexToHue(hex: string): number {
  let s = hex.replace('#', '')
  if (s.length === 3) s = s[0] + s[0] + s[1] + s[1] + s[2] + s[2]
  const n = parseInt(s, 16)
  if (Number.isNaN(n)) return 0
  const r = ((n >> 16) & 255) / 255, g = ((n >> 8) & 255) / 255, b = (n & 255) / 255
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min
  if (d === 0) return 0
  let h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4
  h *= 60
  return h < 0 ? h + 360 : h
}

const CAPTION_COLOR = '#0ea5e9' // sky blue — distinct from zoom amber / effect fuchsia

/**
 * Editor for the selected caption track (spec 35). Regenerate + hide + basic subtitle style, plus an
 * editable list of cues so the user can correct anything the speech recognition got wrong (R7).
 */
function CaptionEditor({
  caption, dispatch, globalTime, onSeek, onRegenerate,
}: {
  caption: CaptionTrack
  dispatch: React.Dispatch<ProjectAction>
  globalTime: number
  onSeek: (t: number) => void
  onRegenerate?: () => void
}) {
  const style = caption.style
  const updateStyle = (patch: Partial<CaptionTrack['style']>) =>
    dispatch({ type: 'UPDATE_CAPTIONS', updates: { style: { ...style, ...patch } } })

  const fmt = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`

  return (
    <div className="w-64 bg-surface border-l border-border p-4 overflow-y-auto text-sm">
      <div
        className="mb-4 flex items-center gap-2 px-2 py-1.5 rounded text-white text-xs font-semibold"
        style={{ background: CAPTION_COLOR }}
      >
        <IconBadgeCc size={15} stroke={2} />
        <span>Captions</span>
      </div>
      <p className="text-[10px] text-subtle mb-4 -mt-2">
        Auto-generated from the timeline's speech. Edit any wording below, or regenerate after
        changing the audio. Shown in both Frame and Live view, and burned into exports.
      </p>

      <div className="flex flex-col gap-2 mb-4">
        <button
          onClick={onRegenerate}
          className="w-full py-2 text-xs font-medium rounded-lg bg-surface-muted text-fg border border-border hover:bg-surface-hover cursor-pointer transition-colors"
        >
          Regenerate captions
        </button>
        <label className="flex items-center gap-2 text-xs text-fg cursor-pointer">
          <input
            type="checkbox"
            checked={caption.hidden ?? false}
            onChange={(e) => dispatch({ type: 'UPDATE_CAPTIONS', updates: { hidden: e.target.checked } })}
          />
          Hide captions
        </label>
      </div>

      <Accordion title="Style" defaultOpen>
        <Field label="Size">
          <div className="flex items-center gap-2 w-full">
            <input
              type="range" min={16} max={120} step={1}
              value={Math.round(style.fontSize)}
              onChange={(e) => updateStyle({ fontSize: Number(e.target.value) })}
              className="w-full"
            />
            <span className="text-[10px] text-subtle tabular-nums w-8 text-right">{Math.round(style.fontSize)}</span>
          </div>
        </Field>
        <Field label="Colour">
          <input
            type="color"
            value={hexOf(style.color, '#ffffff')}
            onChange={(e) => updateStyle({ color: e.target.value })}
            className="w-8 h-6 rounded cursor-pointer bg-transparent"
          />
        </Field>
        <Field label="Position">
          <div className="flex items-center gap-2 w-full">
            <input
              type="range" min={0} max={100} step={1}
              value={Math.round(style.position * 100)}
              onChange={(e) => updateStyle({ position: Number(e.target.value) / 100 })}
              className="w-full"
            />
            <span className="text-[10px] text-subtle tabular-nums w-8 text-right">{Math.round(style.position * 100)}%</span>
          </div>
        </Field>
        <Field label="Background">
          <input
            type="checkbox"
            checked={style.background}
            onChange={(e) => updateStyle({ background: e.target.checked })}
          />
        </Field>
      </Accordion>

      <Accordion title={`Captions (${caption.cues.length})`} defaultOpen>
        <div className="flex flex-col gap-2">
          {/* Add a new empty cue at the playhead (2s long) — user then types the text. */}
          <button
            onClick={() => dispatch({ type: 'ADD_CAPTION_CUE', cue: createCaptionCue(globalTime, globalTime + 2, '') })}
            className="w-full py-1.5 text-[11px] font-medium rounded-lg bg-surface-muted text-fg border border-border hover:bg-surface-hover cursor-pointer transition-colors"
          >
            + Add caption at playhead
          </button>

          {caption.cues.map((cue) => {
            const active = globalTime >= cue.startTime && globalTime < cue.endTime
            const updateCue = (updates: Partial<Omit<typeof cue, 'id'>>) =>
              dispatch({ type: 'UPDATE_CAPTION_CUE', cueId: cue.id, updates })
            return (
              <div key={cue.id} className={`rounded-lg border p-1.5 ${active ? 'border-accent' : 'border-border'}`}>
                <div className="flex items-center justify-between mb-1">
                  <button
                    onClick={() => onSeek(cue.startTime)}
                    className="text-[10px] font-mono tabular-nums text-subtle hover:text-fg cursor-pointer"
                    title="Jump to this caption"
                  >
                    {fmt(cue.startTime)} – {fmt(cue.endTime)}
                  </button>
                  <button
                    onClick={() => dispatch({ type: 'REMOVE_CAPTION_CUE', cueId: cue.id })}
                    className="text-subtle hover:text-danger cursor-pointer"
                    title="Delete this caption"
                  >
                    <IconTrash size={13} stroke={2} />
                  </button>
                </div>
                <textarea
                  value={cue.text}
                  onChange={(e) => updateCue({ text: e.target.value })}
                  rows={2}
                  className="w-full resize-none rounded bg-surface-muted border border-border px-2 py-1 text-xs text-fg focus:outline-none focus:border-accent mb-1"
                />
                {/* Timing: start + end in seconds. End is clamped above start so a cue never inverts. */}
                <div className="flex items-center gap-1.5">
                  <label className="flex items-center gap-1 text-[10px] text-subtle">
                    Start
                    <input
                      type="number" min={0} step={0.1}
                      value={Number(cue.startTime.toFixed(2))}
                      onChange={(e) => {
                        const start = Math.max(0, Number(e.target.value))
                        updateCue({ startTime: start, endTime: Math.max(start + 0.1, cue.endTime) })
                      }}
                      className="w-14 rounded bg-surface-muted border border-border px-1 py-0.5 text-[11px] text-fg focus:outline-none focus:border-accent"
                    />
                  </label>
                  <label className="flex items-center gap-1 text-[10px] text-subtle">
                    End
                    <input
                      type="number" min={0} step={0.1}
                      value={Number(cue.endTime.toFixed(2))}
                      onChange={(e) => updateCue({ endTime: Math.max(cue.startTime + 0.1, Number(e.target.value)) })}
                      className="w-14 rounded bg-surface-muted border border-border px-1 py-0.5 text-[11px] text-fg focus:outline-none focus:border-accent"
                    />
                  </label>
                </div>
              </div>
            )
          })}
          {caption.cues.length === 0 && (
            <p className="text-[11px] text-subtle">No captions yet.</p>
          )}
        </div>
      </Accordion>
    </div>
  )
}

// Every effect kind, for the "add effect" picker (spec 37). Order = the LeftRail Effects order.
const ALL_EFFECT_KINDS = Object.keys(EFFECT_LABEL) as VideoEffectKind[]

/**
 * Per-layer parameter fields (spec 37) for one effect inside a Full screen effect stack: Intensity +
 * the per-kind param block. Extracted verbatim from the old single-effect editor; `update` /
 * `updateTransient` now patch THIS layer within the container's `layers` array (the container editor
 * wires those). Kind is fixed at add-time — no switcher.
 */
function LayerFields({ layer, update, updateTransient, commit }: {
  layer: EffectLayer
  update: (patch: Partial<Omit<EffectLayer, 'id' | 'kind'>>) => void
  updateTransient: (patch: Partial<Omit<EffectLayer, 'id' | 'kind'>>) => void
  commit: () => void
}) {
  const vig = layer.vignette
  const old = layer.oldfilm
  const hue = layer.hue
  const leak = layer.lightleak
  const chroma = layer.chromatic
  const gmap = layer.gradientmap
  const post = layer.posterize
  const duo = layer.threshold
  const swap = layer.channelswap
  const iso = layer.colorisolate
  const dith = layer.dither
  const crt = layer.crt
  const vhs = layer.vhs
  const half = layer.halftone
  const comic = layer.comic

  // Update one vignette param (dispatched whole — the container shallow-merges layer fields).
  const updateVignette = (patch: Partial<NonNullable<EffectLayer['vignette']>>) => {
    if (!vig) return
    update({ vignette: { ...vig, ...patch } })
  }

  return (
    <>
      {/* Intensity — peak strength; fades in/out via the container's shared envelope */}
      <Field label="Intensity">
        <div className="flex items-center gap-2 w-full">
          <input
            type="range"
            min={0} max={100} step={1}
            value={Math.round(layer.intensity * 100)}
            onChange={(e) => updateTransient({ intensity: Number(e.target.value) / 100 })}
            onPointerUp={commit}
            onKeyUp={commit}
            className="w-full"
          />
          <span className="text-[10px] text-subtle tabular-nums w-8 text-right">
            {Math.round(layer.intensity * 100)}%
          </span>
        </div>
      </Field>

      {/* Vignette-only shape controls */}
      {layer.kind === 'vignette' && vig && (
        <Accordion title="Vignette" icon={effectIcon(layer.kind)} defaultOpen>
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
      {layer.kind === 'oldfilm' && old && (
        <Accordion title="Old Film" icon={effectIcon(layer.kind)} defaultOpen>
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

      {/* Hue shift (spec 24): static angle, or an animated psychedelic cycle */}
      {layer.kind === 'hue' && hue && (
        <Accordion title="Hue" icon={effectIcon(layer.kind)} defaultOpen>
          <Field label="Animate">
            <input
              type="checkbox"
              checked={hue.animate}
              onChange={(e) => update({ hue: { ...hue, animate: e.target.checked } })}
              className="cursor-pointer"
            />
          </Field>
          {!hue.animate ? (
            <Field label="Angle">
              <div className="flex items-center gap-2 w-full">
                <input
                  type="range" min={0} max={360} step={1}
                  value={Math.round(hue.angle)}
                  onChange={(e) => updateTransient({ hue: { ...hue, angle: Number(e.target.value) } })}
                  onPointerUp={commit} onKeyUp={commit}
                  className="w-full"
                />
                <span className="text-[10px] text-subtle tabular-nums w-8 text-right">{Math.round(hue.angle)}°</span>
              </div>
            </Field>
          ) : (
            <Field label="Speed">
              <div className="flex items-center gap-2 w-full">
                <input
                  type="range" min={5} max={360} step={5}
                  value={Math.round(hue.speed)}
                  onChange={(e) => updateTransient({ hue: { ...hue, speed: Number(e.target.value) } })}
                  onPointerUp={commit} onKeyUp={commit}
                  className="w-full"
                />
                <span className="text-[10px] text-subtle tabular-nums w-10 text-right">{Math.round(hue.speed)}°/s</span>
              </div>
            </Field>
          )}
          {hue.animate && (
            <p className="text-[10px] text-subtle">Animated hue cycles continuously — set Ease in/out to 0 to avoid a pop at the edges.</p>
          )}
        </Accordion>
      )}

      {/* Light leak (spec 24): colour, streak angle, drift speed */}
      {layer.kind === 'lightleak' && leak && (
        <Accordion title="Light Leak" icon={effectIcon(layer.kind)} defaultOpen>
          <Field label="Colour">
            <input
              type="color"
              value={leak.color}
              onChange={(e) => updateTransient({ lightleak: { ...leak, color: e.target.value } })}
              onBlur={commit}
              className="h-7 w-full cursor-pointer rounded border border-border bg-transparent"
            />
          </Field>
          <Field label="Angle">
            <div className="flex items-center gap-2 w-full">
              <input
                type="range" min={0} max={360} step={1}
                value={Math.round(leak.angle)}
                onChange={(e) => updateTransient({ lightleak: { ...leak, angle: Number(e.target.value) } })}
                onPointerUp={commit} onKeyUp={commit}
                className="w-full"
              />
              <span className="text-[10px] text-subtle tabular-nums w-8 text-right">{Math.round(leak.angle)}°</span>
            </div>
          </Field>
          <Field label="Speed">
            <div className="flex items-center gap-2 w-full">
              <input
                type="range" min={0} max={100} step={1}
                value={Math.round(leak.speed * 100)}
                onChange={(e) => updateTransient({ lightleak: { ...leak, speed: Number(e.target.value) / 100 } })}
                onPointerUp={commit} onKeyUp={commit}
                className="w-full"
              />
              <span className="text-[10px] text-subtle tabular-nums w-8 text-right">{Math.round(leak.speed * 100)}</span>
            </div>
          </Field>
        </Accordion>
      )}

      {/* Chromatic split (spec 24): separation distance + direction */}
      {layer.kind === 'chromatic' && chroma && (
        <Accordion title="Chromatic" icon={effectIcon(layer.kind)} defaultOpen>
          <Field label="Offset">
            <div className="flex items-center gap-2 w-full">
              <input
                type="range" min={0} max={40} step={0.5}
                value={chroma.offset}
                onChange={(e) => updateTransient({ chromatic: { ...chroma, offset: Number(e.target.value) } })}
                onPointerUp={commit} onKeyUp={commit}
                className="w-full"
              />
              <span className="text-[10px] text-subtle tabular-nums w-10 text-right">{chroma.offset}px</span>
            </div>
          </Field>
          <Field label="Angle">
            <div className="flex items-center gap-2 w-full">
              <input
                type="range" min={0} max={360} step={1}
                value={Math.round(chroma.angle)}
                onChange={(e) => updateTransient({ chromatic: { ...chroma, angle: Number(e.target.value) } })}
                onPointerUp={commit} onKeyUp={commit}
                className="w-full"
              />
              <span className="text-[10px] text-subtle tabular-nums w-8 text-right">{Math.round(chroma.angle)}°</span>
            </div>
          </Field>
          <p className="text-[10px] text-subtle">Offset is the peak separation at 100% Intensity — pair a short Ease in/out for a punch on an impact.</p>
        </Accordion>
      )}

      {/* Gradient map (spec 25, WebGL): choose the false-colour ramp */}
      {layer.kind === 'gradientmap' && gmap && (
        <Accordion title="Gradient Map" icon={effectIcon(layer.kind)} defaultOpen>
          <Field label="Ramp">
            <select
              value={gmap.preset}
              onChange={(e) => update({ gradientmap: { ...gmap, preset: e.target.value as GradientMapPreset } })}
              className={SELECT_CLS}
            >
              <option value="thermal">Thermal</option>
              <option value="nightvision">Night Vision</option>
              <option value="infrared">Infrared</option>
              <option value="risograph">Risograph</option>
              <option value="cinematic">Cinematic (Teal &amp; Orange)</option>
              <option value="cinemacool">Cinematic (Cool)</option>
            </select>
          </Field>
          <p className="text-[10px] text-subtle">Maps brightness through a colour ramp (GPU shader). Intensity blends between the original and the mapped look.</p>
        </Accordion>
      )}

      {/* Posterize (spec 25, WebGL): quantize to N bands per channel */}
      {layer.kind === 'posterize' && post && (
        <Accordion title="Posterize" icon={effectIcon(layer.kind)} defaultOpen>
          <Field label="Levels">
            <div className="flex items-center gap-2 w-full">
              <input
                type="range" min={2} max={16} step={1}
                value={post.levels}
                onChange={(e) => updateTransient({ posterize: { ...post, levels: Number(e.target.value) } })}
                onPointerUp={commit} onKeyUp={commit}
                className="w-full"
              />
              <span className="text-[10px] text-subtle tabular-nums w-8 text-right">{post.levels}</span>
            </div>
          </Field>
          <p className="text-[10px] text-subtle">Fewer levels = flatter, more graphic banding.</p>
        </Accordion>
      )}

      {/* Duotone / threshold (spec 25, WebGL): two colours split by luminance */}
      {layer.kind === 'threshold' && duo && (
        <Accordion title="Duotone" icon={effectIcon(layer.kind)} defaultOpen>
          <Field label="Dark">
            <input
              type="color"
              value={duo.dark}
              onChange={(e) => updateTransient({ threshold: { ...duo, dark: e.target.value } })}
              onBlur={commit}
              className="h-7 w-full cursor-pointer rounded border border-border bg-transparent"
            />
          </Field>
          <Field label="Light">
            <input
              type="color"
              value={duo.light}
              onChange={(e) => updateTransient({ threshold: { ...duo, light: e.target.value } })}
              onBlur={commit}
              className="h-7 w-full cursor-pointer rounded border border-border bg-transparent"
            />
          </Field>
          <Field label="Split">
            <div className="flex items-center gap-2 w-full">
              <input
                type="range" min={0} max={100} step={1}
                value={Math.round(duo.threshold * 100)}
                onChange={(e) => updateTransient({ threshold: { ...duo, threshold: Number(e.target.value) / 100 } })}
                onPointerUp={commit} onKeyUp={commit}
                className="w-full"
              />
              <span className="text-[10px] text-subtle tabular-nums w-8 text-right">{Math.round(duo.threshold * 100)}%</span>
            </div>
          </Field>
          <p className="text-[10px] text-subtle">Pixels darker than the split take the Dark colour; brighter take Light.</p>
        </Accordion>
      )}

      {/* Channel swap (spec 25, WebGL): permute RGB */}
      {layer.kind === 'channelswap' && swap && (
        <Accordion title="Channel Swap" icon={effectIcon(layer.kind)} defaultOpen>
          <Field label="Mapping">
            <select
              value={swap.mapping}
              onChange={(e) => update({ channelswap: { ...swap, mapping: e.target.value as ChannelSwapMapping } })}
              className={SELECT_CLS}
            >
              <option value="rbg">R → R, G → B, B → G (rbg)</option>
              <option value="grb">grb</option>
              <option value="brg">brg</option>
              <option value="bgr">bgr (swap R/B)</option>
              <option value="gbr">gbr</option>
            </select>
          </Field>
          <p className="text-[10px] text-subtle">Reorders the red / green / blue channels for a false-colour shift.</p>
        </Accordion>
      )}

      {/* Colour isolation (spec 25, WebGL): keep one hue, desaturate the rest */}
      {layer.kind === 'colorisolate' && iso && (
        <Accordion title="Colour Isolate" icon={effectIcon(layer.kind)} defaultOpen>
          <Field label="Colour">
            <input
              type="color"
              value={hueToHex(iso.hue)}
              onChange={(e) => updateTransient({ colorisolate: { ...iso, hue: hexToHue(e.target.value) } })}
              onBlur={commit}
              className="h-7 w-full cursor-pointer rounded border border-border bg-transparent"
            />
          </Field>
          <Field label="Tolerance">
            <div className="flex items-center gap-2 w-full">
              <input
                type="range" min={5} max={120} step={1}
                value={Math.round(iso.tolerance)}
                onChange={(e) => updateTransient({ colorisolate: { ...iso, tolerance: Number(e.target.value) } })}
                onPointerUp={commit} onKeyUp={commit}
                className="w-full"
              />
              <span className="text-[10px] text-subtle tabular-nums w-8 text-right">{Math.round(iso.tolerance)}°</span>
            </div>
          </Field>
          <p className="text-[10px] text-subtle">Keeps colours near the chosen hue; everything else goes greyscale.</p>
        </Accordion>
      )}

      {/* Dither (spec 25, WebGL): ordered Bayer dithering + quantization */}
      {layer.kind === 'dither' && dith && (
        <Accordion title="Dither" icon={effectIcon(layer.kind)} defaultOpen>
          <Field label="Levels">
            <div className="flex items-center gap-2 w-full">
              <input
                type="range" min={2} max={6} step={1}
                value={dith.levels}
                onChange={(e) => updateTransient({ dither: { ...dith, levels: Number(e.target.value) } })}
                onPointerUp={commit} onKeyUp={commit}
                className="w-full"
              />
              <span className="text-[10px] text-subtle tabular-nums w-8 text-right">{dith.levels}</span>
            </div>
          </Field>
          <Field label="Cell">
            <div className="flex items-center gap-2 w-full">
              <input
                type="range" min={1} max={8} step={1}
                value={dith.scale}
                onChange={(e) => updateTransient({ dither: { ...dith, scale: Number(e.target.value) } })}
                onPointerUp={commit} onKeyUp={commit}
                className="w-full"
              />
              <span className="text-[10px] text-subtle tabular-nums w-8 text-right">{dith.scale}px</span>
            </div>
          </Field>
          <p className="text-[10px] text-subtle">Retro ordered-dithering. Fewer levels + bigger cells = chunkier, more 8-bit.</p>
        </Accordion>
      )}

      {/* CRT (spec 25, WebGL): barrel curvature + scanlines + phosphor mask */}
      {layer.kind === 'crt' && crt && (
        <Accordion title="CRT" icon={effectIcon(layer.kind)} defaultOpen>
          <Field label="Curvature">
            <div className="flex items-center gap-2 w-full">
              <input
                type="range" min={0} max={100} step={1}
                value={Math.round(crt.curvature * 100)}
                onChange={(e) => updateTransient({ crt: { ...crt, curvature: Number(e.target.value) / 100 } })}
                onPointerUp={commit} onKeyUp={commit}
                className="w-full"
              />
              <span className="text-[10px] text-subtle tabular-nums w-8 text-right">{Math.round(crt.curvature * 100)}%</span>
            </div>
          </Field>
          <Field label="Scanlines">
            <div className="flex items-center gap-2 w-full">
              <input
                type="range" min={0} max={100} step={1}
                value={Math.round(crt.scanline * 100)}
                onChange={(e) => updateTransient({ crt: { ...crt, scanline: Number(e.target.value) / 100 } })}
                onPointerUp={commit} onKeyUp={commit}
                className="w-full"
              />
              <span className="text-[10px] text-subtle tabular-nums w-8 text-right">{Math.round(crt.scanline * 100)}%</span>
            </div>
          </Field>
          <p className="text-[10px] text-subtle">Curved tube glass, scanlines &amp; an RGB phosphor mask. The picture is auto-fitted to the curve, so it always fills the frame — Intensity fades the whole look in and out.</p>
        </Accordion>
      )}

      {/* VHS (spec 25, WebGL, animated): chroma bleed + tracking noise */}
      {layer.kind === 'vhs' && vhs && (
        <Accordion title="VHS" icon={effectIcon(layer.kind)} defaultOpen>
          <Field label="Chroma bleed">
            <div className="flex items-center gap-2 w-full">
              <input
                type="range" min={0} max={100} step={1}
                value={Math.round(vhs.bleed * 100)}
                onChange={(e) => updateTransient({ vhs: { ...vhs, bleed: Number(e.target.value) / 100 } })}
                onPointerUp={commit} onKeyUp={commit}
                className="w-full"
              />
              <span className="text-[10px] text-subtle tabular-nums w-8 text-right">{Math.round(vhs.bleed * 100)}%</span>
            </div>
          </Field>
          <Field label="Tracking">
            <div className="flex items-center gap-2 w-full">
              <input
                type="range" min={0} max={100} step={1}
                value={Math.round(vhs.noise * 100)}
                onChange={(e) => updateTransient({ vhs: { ...vhs, noise: Number(e.target.value) / 100 } })}
                onPointerUp={commit} onKeyUp={commit}
                className="w-full"
              />
              <span className="text-[10px] text-subtle tabular-nums w-8 text-right">{Math.round(vhs.noise * 100)}%</span>
            </div>
          </Field>
          <p className="text-[10px] text-subtle">Chroma bleed, line wobble &amp; a scrolling tracking-noise band (animated).</p>
        </Accordion>
      )}

      {/* Halftone (spec 25, WebGL): comic dot screen */}
      {layer.kind === 'halftone' && half && (
        <Accordion title="Halftone" icon={effectIcon(layer.kind)} defaultOpen>
          <Field label="Dot size">
            <div className="flex items-center gap-2 w-full">
              <input
                type="range" min={2} max={16} step={1}
                value={half.cell}
                onChange={(e) => updateTransient({ halftone: { ...half, cell: Number(e.target.value) } })}
                onPointerUp={commit} onKeyUp={commit}
                className="w-full"
              />
              <span className="text-[10px] text-subtle tabular-nums w-8 text-right">{half.cell}px</span>
            </div>
          </Field>
          <Field label="Angle">
            <div className="flex items-center gap-2 w-full">
              <input
                type="range" min={0} max={90} step={1}
                value={Math.round(half.angle)}
                onChange={(e) => updateTransient({ halftone: { ...half, angle: Number(e.target.value) } })}
                onPointerUp={commit} onKeyUp={commit}
                className="w-full"
              />
              <span className="text-[10px] text-subtle tabular-nums w-8 text-right">{Math.round(half.angle)}°</span>
            </div>
          </Field>
          <p className="text-[10px] text-subtle">Dot size scales with brightness; rotate the screen angle for the classic print look.</p>
        </Accordion>
      )}

      {/* Comic ink (spec 25, WebGL): Sobel edges over a posterized base */}
      {layer.kind === 'comic' && comic && (
        <Accordion title="Comic Ink" icon={effectIcon(layer.kind)} defaultOpen>
          <Field label="Colours">
            <div className="flex items-center gap-2 w-full">
              <input
                type="range" min={2} max={8} step={1}
                value={comic.levels}
                onChange={(e) => updateTransient({ comic: { ...comic, levels: Number(e.target.value) } })}
                onPointerUp={commit} onKeyUp={commit}
                className="w-full"
              />
              <span className="text-[10px] text-subtle tabular-nums w-8 text-right">{comic.levels}</span>
            </div>
          </Field>
          <Field label="Ink">
            <div className="flex items-center gap-2 w-full">
              <input
                type="range" min={5} max={30} step={1}
                value={Math.round(comic.thickness * 10)}
                onChange={(e) => updateTransient({ comic: { ...comic, thickness: Number(e.target.value) / 10 } })}
                onPointerUp={commit} onKeyUp={commit}
                className="w-full"
              />
              <span className="text-[10px] text-subtle tabular-nums w-8 text-right">{comic.thickness.toFixed(1)}</span>
            </div>
          </Field>
          <p className="text-[10px] text-subtle">Sobel edge-detect ink lines over a posterized base. Ink = line thickness.</p>
        </Accordion>
      )}
    </>
  )
}

/**
 * Editor for a selected Full screen effect (spec 37) — a STACK of layers sharing one timeline
 * envelope. Renders the layer list (each with a header: reorder / hide / remove, then its LayerFields),
 * an add-effect picker, then the shared Timing envelope + delete-container. Mirrors ZoomEditor's
 * envelope controls; the per-layer params come from LayerFields.
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

  const layers = effect.layers
  // Patch layer i within the stack (dispatched whole — the reducer shallow-merges the container level).
  const patchLayer = (i: number, patch: Partial<Omit<EffectLayer, 'id' | 'kind'>>) =>
    update({ layers: layers.map((l, j) => (j === i ? { ...l, ...patch } : l)) })
  const patchLayerTransient = (i: number, patch: Partial<Omit<EffectLayer, 'id' | 'kind'>>) =>
    updateTransient({ layers: layers.map((l, j) => (j === i ? { ...l, ...patch } : l)) })
  const removeLayer = (i: number) => update({ layers: layers.filter((_, j) => j !== i) })
  const moveLayer = (i: number, dir: -1 | 1) => {
    const j = i + dir
    if (j < 0 || j >= layers.length) return
    const next = [...layers]
    ;[next[i], next[j]] = [next[j], next[i]]
    update({ layers: next })
  }
  const addLayer = (kind: VideoEffectKind) => update({ layers: [...layers, createEffectLayer(kind)] })

  // OQ7: when a fresh container has no layers, open the add-effect picker straight away.
  const [addOpen, setAddOpen] = useState(layers.length === 0)

  const envelope = effect.transitionIn + effect.hold + effect.transitionOut
  const end = effect.startTime + envelope
  const withinSpan = globalTime >= effect.startTime && globalTime <= end

  return (
    <div className="w-64 bg-surface border-l border-border p-4 overflow-y-auto text-sm">
      <div
        className="mb-4 flex items-center gap-2 px-2 py-1.5 rounded text-white text-xs font-semibold"
        style={{ background: EFFECT_COLOR }}
      >
        <IconFilters size={15} stroke={2} />
        <span>Full screen effect</span>
      </div>
      <p className="text-[10px] text-subtle mb-4 -mt-2">
        A stack of render-wide effects that fade in / out together on one envelope. Drag its bar on the
        timeline to move or lengthen it. Applies in both Frame and Live view.
      </p>

      {/* Layer stack — each effect in the container, in compose order (top applies first) */}
      {layers.map((layer, i) => (
        <div key={layer.id} className="mb-2 overflow-hidden rounded-lg border border-border bg-surface-muted/40">
          <div className="flex items-center gap-1.5 px-2 py-1.5 border-b border-border bg-surface-muted/60">
            <span className="text-subtle">{effectIcon(layer.kind)}</span>
            <span className={`flex-1 text-[11px] font-semibold truncate ${layer.hidden ? 'text-subtle line-through' : 'text-fg'}`}>
              {EFFECT_LABEL[layer.kind]}
            </span>
            <button
              onClick={() => moveLayer(i, -1)} disabled={i === 0}
              className="p-0.5 text-subtle hover:text-fg disabled:opacity-30 disabled:cursor-default cursor-pointer"
              title="Move up (applies earlier)"
            >
              <IconArrowUp size={13} stroke={2} />
            </button>
            <button
              onClick={() => moveLayer(i, 1)} disabled={i === layers.length - 1}
              className="p-0.5 text-subtle hover:text-fg disabled:opacity-30 disabled:cursor-default cursor-pointer"
              title="Move down (applies later)"
            >
              <IconArrowDown size={13} stroke={2} />
            </button>
            <button
              onClick={() => patchLayer(i, { hidden: !layer.hidden })}
              className="p-0.5 text-subtle hover:text-fg cursor-pointer"
              title={layer.hidden ? 'Show layer' : 'Hide layer'}
            >
              {layer.hidden ? <IconEyeOff size={13} stroke={2} /> : <IconEye size={13} stroke={2} />}
            </button>
            <button
              onClick={() => removeLayer(i)}
              className="p-0.5 text-subtle hover:text-danger cursor-pointer"
              title="Remove layer"
            >
              <IconTrash size={13} stroke={2} />
            </button>
          </div>
          <div className="space-y-2 px-2.5 py-2">
            <LayerFields
              layer={layer}
              update={(patch) => patchLayer(i, patch)}
              updateTransient={(patch) => patchLayerTransient(i, patch)}
              commit={commit}
            />
          </div>
        </div>
      ))}

      {/* Add-effect picker */}
      {addOpen ? (
        <div className="mb-2">
          <select
            value=""
            onChange={(e) => {
              if (!e.target.value) return
              addLayer(e.target.value as VideoEffectKind)
              setAddOpen(false)
            }}
            className={SELECT_CLS}
            autoFocus
          >
            <option value="">Choose an effect…</option>
            {ALL_EFFECT_KINDS.map((k) => (
              <option key={k} value={k}>{EFFECT_LABEL[k]}</option>
            ))}
          </select>
          {layers.length > 0 && (
            <button
              onClick={() => setAddOpen(false)}
              className="w-full mt-1 px-2 py-1 text-[11px] rounded bg-surface-muted text-muted hover:bg-surface-hover cursor-pointer transition-colors"
            >
              Cancel
            </button>
          )}
        </div>
      ) : (
        <button
          onClick={() => setAddOpen(true)}
          className="w-full mb-2 flex items-center justify-center gap-1 px-3 py-1.5 text-xs bg-surface-muted hover:bg-surface-hover text-fg border border-border rounded transition-colors cursor-pointer"
        >
          <IconPlus size={14} stroke={2} /> Add effect
        </button>
      )}
      {layers.length === 0 && !addOpen && (
        <p className="text-[10px] text-subtle mb-2">This stack is empty — add an effect above.</p>
      )}

      {/* Shared timing envelope — identical shape to the zoom's; drives the whole stack's fade */}
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
  // Generic effects card (object inspector). The 15 per-EFFECT parameter cards do NOT live here —
  // they pass their per-kind icon explicitly via Accordion's `icon` prop, sourced from EFFECT_ICON
  // (spec 31 D5/D6), so one map keeps LeftRail + the inspector in sync.
  Effects: <IconFilters size={15} stroke={2} />,
}

// Icon element for a per-effect parameter card, from the shared EFFECT_ICON map (spec 31 D5/D6).
function effectIcon(kind: VideoEffectKind): React.ReactNode {
  const Icon = EFFECT_ICON[kind]
  return <Icon size={15} stroke={2} />
}

/**
 * `accent` (spec 29 R17): the colour of the keyframe under the playhead, set only when THAT
 * keyframe governs a property in this card — so the tint tells you where your edits will land.
 * `marked`: something in this card animates, but not on the active keyframe (a neutral ◇), so a
 * collapsed card still advertises that it holds animation.
 */
function Accordion({ title, children, defaultOpen = false, accent = null, marked = false, icon }: {
  title: string
  children: React.ReactNode
  defaultOpen?: boolean
  accent?: string | null
  marked?: boolean
  icon?: React.ReactNode   // explicit icon (per-effect cards, spec 31 D7); falls back to SECTION_ICONS[title]
}) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <div
      className="mb-2 overflow-hidden rounded-lg border bg-surface-muted/40"
      style={accent ? { borderColor: accent, boxShadow: `inset 3px 0 0 0 ${accent}` } : { borderColor: 'var(--border)' }}
    >
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-2 px-2.5 py-2 text-left transition-colors hover:bg-surface-hover cursor-pointer"
      >
        <span className="text-subtle">{icon ?? SECTION_ICONS[title]}</span>
        <span className="flex-1 text-[11px] font-semibold uppercase tracking-wider text-fg">{title}</span>
        {(accent || marked) && (
          <span className="text-[10px] leading-none" style={accent ? { color: accent } : undefined}>
            {accent ? '◆' : '◇'}
          </span>
        )}
        <IconChevronDown size={14} stroke={2} className={`text-subtle transition-transform ${open ? '' : '-rotate-90'}`} />
      </button>
      {open && <div className="space-y-2 px-2.5 pb-2.5 pt-0.5">{children}</div>}
    </div>
  )
}

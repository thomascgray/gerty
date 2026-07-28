import { useEffect, useMemo, useRef, useState } from 'react'
import type {
  TimelineObject, EasingKind, Transition, TransitionKind, SlideDirection, Keyframe,
  CameraZoom, CameraKeyframe, TextEffect, TextEffectKind,
} from '../types'
import { keyframeColor, defaultTransitionEasing } from '../lib/keyframes'
import { clamp01, ease } from '../lib/easing'

/**
 * Shared property-editing UI (spec 17 P). Extracted from `PropertiesPanel` so the redesigned
 * inspector AND the floating context toolbar's popovers render the exact same controls — one
 * source of truth for sections, fields, transition editors, and the keyframe/type-on bars.
 */

// Spec 21: 7 maximally-distinct presets (was 9 near-duplicate curves). `instant` is a hard-cut.
export const EASINGS: EasingKind[] = [
  'instant',
  'linear',
  'easeInCubic',
  'easeOutCubic',
  'easeInOutCubic',
  'easeOutBack',
  'spring',
]
export const EASING_LABELS: Record<EasingKind, string> = {
  instant: 'Instant — no animation',
  linear: 'Even — steady speed',
  easeInCubic: 'Slow start, fast finish',
  easeOutCubic: 'Fast start, slow finish',
  easeInOutCubic: 'Smooth — slow at both ends',
  easeOutBack: 'Overshoot, then settle',
  spring: 'Bouncy — springs in',
}
export const SELECT_CLS = 'bg-surface-muted text-fg text-xs px-2 py-1 rounded border border-border focus:border-accent outline-none cursor-pointer'

/**
 * Live preview of an easing curve (spec 21): a static SVG glyph of `ease(kind, x)` over 0→1 plus a
 * dot travelling on a self-contained ~1.2s rAF loop, so the felt motion (accelerate / overshoot /
 * bounce / snap) confirms the current selection. UI-only — never touches renderFrame.
 *
 * The rAF is its own loop (NOT driven by globalTime), so it stays cheap even though the panel
 * re-renders at 60Hz during playback (see Gotchas). Overshoot (back/spring) is normalised into the
 * padded viewbox so the bounce is actually visible.
 */
export function MotionPreview({ kind, color }: { kind: EasingKind; color?: string }) {
  const W = 120, H = 34, PAD = 5
  // Sample the curve once per kind; find its value range (may overshoot 0..1) to normalise the plot.
  const { path, lo, hi } = useMemo(() => {
    const N = 40
    const ys: number[] = []
    for (let i = 0; i <= N; i++) ys.push(ease(kind, i / N))
    const lo = Math.min(0, ...ys)
    const hi = Math.max(1, ...ys)
    const span = hi - lo || 1
    const px = (i: number) => PAD + (i / N) * (W - 2 * PAD)
    const py = (v: number) => H - PAD - ((v - lo) / span) * (H - 2 * PAD)
    const path = ys.map((v, i) => `${i === 0 ? 'M' : 'L'}${px(i).toFixed(1)},${py(v).toFixed(1)}`).join(' ')
    return { path, lo, hi }
  }, [kind])

  const [u, setU] = useState(0)
  useEffect(() => {
    let raf = 0
    let start: number | null = null
    const DUR = 1200, GAP = 350
    const loop = (ts: number) => {
      if (start == null) start = ts
      const e = (ts - start) % (DUR + GAP)
      setU(e < DUR ? e / DUR : 1)
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
  }, [])

  const span = (hi - lo) || 1
  const eased = ease(kind, u)
  const dotX = PAD + clamp01(u) * (W - 2 * PAD)
  const dotY = H - PAD - ((eased - lo) / span) * (H - 2 * PAD)
  const c = color ?? 'var(--accent)'
  return (
    <svg width="100%" height={H} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="mt-1 block rounded bg-surface-muted/60">
      {/* baseline + top guide */}
      <line x1={PAD} y1={H - PAD} x2={W - PAD} y2={H - PAD} stroke="var(--border)" strokeWidth={0.75} />
      <path d={path} fill="none" stroke={c} strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
      <circle cx={dotX} cy={dotY} r={2.75} fill={c} />
    </svg>
  )
}

/**
 * Motion field (spec 21): a native `<select>` of the 7 presets + a `MotionPreview` of the selection.
 * Native select keeps it accessible/keyboard-native; the single preview reflects the current pick
 * (options can't host previews). `exclude` drops presets (transitions exclude `instant`). Replaces
 * every raw easing `<select>` so there's one motion vocabulary everywhere.
 */
export function MotionPicker({
  value, onChange, exclude, color,
}: {
  value: EasingKind
  onChange: (k: EasingKind) => void
  exclude?: EasingKind[]
  color?: string
}) {
  const opts = exclude?.length ? EASINGS.filter((k) => !exclude.includes(k)) : EASINGS
  return (
    <div>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value as EasingKind)}
        className="w-full bg-surface-muted text-fg text-[11px] px-1 py-1 rounded border outline-none cursor-pointer focus:border-accent"
        style={{ borderColor: color ?? 'var(--border)' }}
      >
        {opts.map((k) => <option key={k} value={k}>{EASING_LABELS[k]}</option>)}
      </select>
      <MotionPreview kind={value} color={color} />
    </div>
  )
}

/**
 * "Animate over" control (spec 21): a range slider that edits a keyframe's `leadIn` — how long the
 * arriving move takes, ending at the keyframe. The rest of the gap holds the previous pose. Modeled
 * on the transition Duration slider. `value` undefined ⇒ shows/edits as the full gap (fill-the-gap).
 */
export function LeadInField({
  value, gap, color, onChange,
}: {
  value: number | undefined
  gap: number
  color?: string
  onChange: (v: number) => void
}) {
  const max = Math.max(0, gap)
  const eff = Math.min(value ?? max, max) // undefined (legacy) reads as "fills the gap"
  return (
    <div>
      <div className="flex items-center justify-between mb-1">
        <label className="text-muted text-xs">Animate over</label>
        <span className="text-[10px] text-subtle tabular-nums">
          {eff <= 0.001 ? 'snap' : eff >= max - 0.001 ? `${eff.toFixed(2)}s (fills gap)` : `${eff.toFixed(2)}s of ${max.toFixed(2)}s`}
        </span>
      </div>
      <input
        type="range"
        min={0}
        max={max || 0.01}
        step={0.05}
        value={eff}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-full"
        title="Holds the previous pose, then moves in over this many seconds, arriving at the keyframe"
      />
      {/* Fill from the right: the last `leadIn` seconds of the gap are the moving part; the rest holds. */}
      <div className="relative h-2 w-full rounded bg-border overflow-hidden mt-1" title="Hold, then move (filled)">
        <div
          className="absolute top-0 right-0 h-full"
          style={{ width: `${max > 0 ? Math.min(100, (eff / max) * 100) : 0}%`, background: color ?? 'var(--accent)', opacity: 0.7 }}
        />
      </div>
    </div>
  )
}

export function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mb-4">
      <h3 className="text-xs font-semibold text-muted uppercase tracking-wider mb-2">{title}</h3>
      <div className="space-y-2">{children}</div>
    </div>
  )
}

export function Field({ label, children, dot }: { label: string; children: React.ReactNode; dot?: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <label className="text-muted text-xs shrink-0 flex items-center gap-1">
        {dot}
        {label}
      </label>
      {children}
    </div>
  )
}

/**
 * Per-property keyframe indicator + opt-in toggle (spec 29 R10/R18). Three states:
 *   - `off`      — this property is static for the whole clip. Click to start animating it here.
 *   - `animated` — it animates somewhere on this object, but the playhead isn't on a keyframe
 *                  that governs it (so edits here land on the base or create a keyframe).
 *   - `active`   — the keyframe under the playhead governs it; edits land on THAT keyframe, and the
 *                  dot wears the keyframe's colour so it matches the panel banner and canvas box.
 * This is what replaces "the entire inspector turns red": you can see exactly which properties a
 * keyframe keeps, and which ones animate at all.
 */
export function KeyframeDot({
  state, color, label, onClick,
}: {
  state: 'off' | 'animated' | 'active'
  color?: string
  label: string
  onClick: () => void
}) {
  const title = state === 'active'
    ? `${label} is set by this keyframe — click to remove it from the keyframe`
    : state === 'animated'
      ? `${label} animates on this object — click to pin its current value as a keyframe here`
      : `${label} is the same for the whole clip — click to start animating it from here`
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className={`shrink-0 text-[10px] leading-none cursor-pointer transition-opacity ${
        state === 'active' ? '' : state === 'animated' ? 'text-fg opacity-90 hover:opacity-100' : 'text-subtle opacity-30 hover:opacity-90'
      }`}
      style={state === 'active' ? { color } : undefined}
    >
      {state === 'active' ? '◆' : '◇'}
    </button>
  )
}

export function NumberInput({
  value,
  onChange,
  min,
  max,
  step = 0.1,
}: {
  value: number
  onChange: (v: number) => void
  min?: number
  max?: number
  step?: number
}) {
  return (
    <input
      type="number"
      value={Number(value.toFixed(2))}
      min={min}
      max={max}
      step={step}
      onChange={(e) => {
        const v = parseFloat(e.target.value)
        if (!isNaN(v)) onChange(v)
      }}
      className="w-20 bg-surface-muted text-fg text-xs px-2 py-1 rounded border border-border focus:border-accent outline-none text-right"
    />
  )
}

/** `TransitionFields` wrapped in a plain titled `Section` — used by the toolbar's Animate popover. */
export function TransitionSection({
  title, phase, value, objDuration, onChange,
}: {
  title: string
  phase: 'in' | 'out'
  value?: Transition
  objDuration: number
  onChange: (t?: Transition) => void
}) {
  return (
    <Section title={title}>
      <TransitionFields phase={phase} value={value} objDuration={objDuration} onChange={onChange} />
    </Section>
  )
}

/** The transition editor's fields (no section chrome) — so the inspector can wrap them in its
 *  accordion while the popover wraps them in a plain `Section`. */
export function TransitionFields({
  phase, value, objDuration, onChange,
}: {
  phase: 'in' | 'out'
  value?: Transition
  objDuration: number
  onChange: (t?: Transition) => void
}) {
  const kind = value?.kind ?? 'none'
  const patch = (p: Partial<Transition>) => {
    const next: Transition = {
      kind,
      duration: value?.duration ?? 0.5,
      direction: value?.direction ?? 'left',
      easing: value?.easing,
      ...p,
    }
    onChange(next.kind === 'none' ? undefined : next)
  }
  const dur = value?.duration ?? 0.5
  const maxDur = Math.max(0.1, objDuration)
  // The effective curve — falls back to the kind's sensible default when none is chosen.
  const effEasing = value?.easing ?? defaultTransitionEasing(kind === 'none' ? 'fade' : kind, phase)
  return (
    <>
      <Field label="Type">
        <select value={kind} onChange={(e) => patch({ kind: e.target.value as TransitionKind })} className={SELECT_CLS}>
          <option value="none">None</option>
          <option value="fade">Fade</option>
          <option value="slide">Slide</option>
          <option value="pop">Pop</option>
        </select>
      </Field>
      {kind !== 'none' && (
        <>
          {kind === 'slide' && (
            <Field label="From">
              <select
                value={value?.direction ?? 'left'}
                onChange={(e) => patch({ direction: e.target.value as SlideDirection })}
                className={SELECT_CLS}
              >
                <option value="left">← Left</option>
                <option value="right">→ Right</option>
                <option value="top">↑ Top</option>
                <option value="bottom">↓ Bottom</option>
              </select>
            </Field>
          )}
          <div>
            <label className="text-muted text-xs block mb-1">Motion</label>
            {/* Transitions own their own duration → no lead-in; `instant` is just "None" here (R12/Q6). */}
            <MotionPicker value={effEasing} onChange={(k) => patch({ easing: k })} exclude={['instant']} />
          </div>
          <div>
            <div className="flex items-center justify-between mb-1">
              <label className="text-muted text-xs">Duration</label>
              <span className="text-[10px] text-subtle tabular-nums">{dur.toFixed(1)}s of {objDuration.toFixed(1)}s</span>
            </div>
            <input
              type="range"
              min={0.1}
              max={maxDur}
              step={0.1}
              value={Math.min(dur, maxDur)}
              onChange={(e) => patch({ duration: Number(e.target.value) })}
              className="w-full"
            />
            {/* Lifespan bar: how much of the object's whole life on the scrubber this transition
                occupies — filled from the start (enter) or the end (exit). */}
            <LifespanBar duration={objDuration} portion={dur} align={phase === 'in' ? 'left' : 'right'} />
          </div>
        </>
      )}
    </>
  )
}

// --- Text effects (spec 19) -----------------------------------------------------------------
export const TEXT_EFFECT_KINDS: TextEffectKind[] = [
  'glow', 'outline', 'shadow', 'gradient', 'pulse', 'rainbow', 'wave', 'shimmer', 'warble', 'glitch',
]
export const TEXT_EFFECT_LABELS: Record<TextEffectKind, string> = {
  glow: 'Glow / Neon',
  outline: 'Outline',
  shadow: 'Drop shadow',
  gradient: 'Gradient fill',
  pulse: 'Pulse',
  rainbow: 'Rainbow',
  wave: 'Wave',
  shimmer: 'Shimmer',
  warble: 'Warble (3D)',
  glitch: 'Glitch',
}
// Sensible starting params per kind — picking a kind seeds these; each param stays editable.
export const DEFAULT_TEXT_EFFECT: Record<TextEffectKind, TextEffect> = {
  glow: { kind: 'glow', color: '#3b82f6', blur: 16 },
  outline: { kind: 'outline', color: '#000000', width: 3 },
  shadow: { kind: 'shadow', color: '#000000', dx: 4, dy: 4, blur: 6 },
  gradient: { kind: 'gradient', from: '#ff6ec4', to: '#7873f5', angle: 0 },
  pulse: { kind: 'pulse', speed: 1, amount: 1 },
  rainbow: { kind: 'rainbow', speed: 1 },
  wave: { kind: 'wave', speed: 1, amplitude: 12 },
  shimmer: { kind: 'shimmer', speed: 1, color: '#ffffff' },
  warble: { kind: 'warble', speed: 1, amount: 1 },
  glitch: { kind: 'glitch', speed: 1, amount: 0.5 }, // subtle by default
}

function ColorRow({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <Field label={label}>
      <input
        type="color"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-8 h-6 rounded border border-border bg-surface-muted cursor-pointer"
      />
    </Field>
  )
}

function SliderRow({
  label, value, min, max, step, onChange, fmt,
}: {
  label: string; value: number; min: number; max: number; step: number
  onChange: (v: number) => void; fmt?: (v: number) => string
}) {
  return (
    <div>
      <div className="flex items-center justify-between mb-1">
        <label className="text-muted text-xs">{label}</label>
        <span className="text-[10px] text-subtle tabular-nums">{fmt ? fmt(value) : value}</span>
      </div>
      <input
        type="range" min={min} max={max} step={step} value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-full"
      />
    </div>
  )
}

/**
 * Effect picker + per-kind params for a text object (spec 19). Modeled on `TransitionFields`:
 * a kind dropdown ("None" removes the effect) plus the params that apply to the chosen kind.
 * `value`/`onChange` carry the whole `TextEffect` (or undefined); the parent wires undo/persist.
 */
export function EffectFields({
  value, onChange,
}: {
  value?: TextEffect
  onChange: (e?: TextEffect) => void
}) {
  const kind = value?.kind ?? 'none'
  // Merge a partial into the current effect (same kind guaranteed by the UI branch).
  const patch = (p: Partial<Record<string, unknown>>) => {
    if (value) onChange({ ...value, ...p } as TextEffect)
  }
  return (
    <>
      <Field label="Effect">
        <select
          value={kind}
          onChange={(e) => {
            const k = e.target.value
            onChange(k === 'none' ? undefined : DEFAULT_TEXT_EFFECT[k as TextEffectKind])
          }}
          className={SELECT_CLS}
        >
          <option value="none">None</option>
          {TEXT_EFFECT_KINDS.map((k) => <option key={k} value={k}>{TEXT_EFFECT_LABELS[k]}</option>)}
        </select>
      </Field>

      {value?.kind === 'glow' && (
        <>
          <ColorRow label="Colour" value={value.color} onChange={(color) => patch({ color })} />
          <SliderRow label="Blur" value={value.blur} min={2} max={40} step={1} onChange={(blur) => patch({ blur })} />
        </>
      )}
      {value?.kind === 'outline' && (
        <>
          <ColorRow label="Colour" value={value.color} onChange={(color) => patch({ color })} />
          <SliderRow label="Width" value={value.width} min={0.5} max={12} step={0.5} onChange={(width) => patch({ width })}
            fmt={(v) => v.toFixed(1)} />
        </>
      )}
      {value?.kind === 'shadow' && (
        <>
          <ColorRow label="Colour" value={value.color} onChange={(color) => patch({ color })} />
          <SliderRow label="Offset X" value={value.dx} min={-30} max={30} step={1} onChange={(dx) => patch({ dx })} />
          <SliderRow label="Offset Y" value={value.dy} min={-30} max={30} step={1} onChange={(dy) => patch({ dy })} />
          <SliderRow label="Blur" value={value.blur} min={0} max={30} step={1} onChange={(blur) => patch({ blur })} />
        </>
      )}
      {value?.kind === 'gradient' && (
        <>
          <ColorRow label="From" value={value.from} onChange={(from) => patch({ from })} />
          <ColorRow label="To" value={value.to} onChange={(to) => patch({ to })} />
          <SliderRow label="Angle" value={value.angle} min={0} max={360} step={5} onChange={(angle) => patch({ angle })}
            fmt={(v) => `${v}°`} />
        </>
      )}
      {value?.kind === 'pulse' && (
        <>
          <SliderRow label="Speed" value={value.speed} min={0.1} max={4} step={0.1} onChange={(speed) => patch({ speed })}
            fmt={(v) => v.toFixed(1)} />
          <SliderRow label="Amount" value={value.amount} min={0.1} max={2} step={0.1} onChange={(amount) => patch({ amount })}
            fmt={(v) => v.toFixed(1)} />
        </>
      )}
      {value?.kind === 'rainbow' && (
        <SliderRow label="Speed" value={value.speed} min={0.1} max={4} step={0.1} onChange={(speed) => patch({ speed })}
          fmt={(v) => v.toFixed(1)} />
      )}
      {value?.kind === 'wave' && (
        <>
          <SliderRow label="Speed" value={value.speed} min={0.1} max={4} step={0.1} onChange={(speed) => patch({ speed })}
            fmt={(v) => v.toFixed(1)} />
          <SliderRow label="Amplitude" value={value.amplitude} min={1} max={40} step={1} onChange={(amplitude) => patch({ amplitude })} />
        </>
      )}
      {value?.kind === 'shimmer' && (
        <>
          <ColorRow label="Highlight" value={value.color} onChange={(color) => patch({ color })} />
          <SliderRow label="Speed" value={value.speed} min={0.1} max={4} step={0.1} onChange={(speed) => patch({ speed })}
            fmt={(v) => v.toFixed(1)} />
        </>
      )}
      {value?.kind === 'warble' && (
        <>
          <SliderRow label="Speed" value={value.speed} min={0.1} max={4} step={0.1} onChange={(speed) => patch({ speed })}
            fmt={(v) => v.toFixed(1)} />
          <SliderRow label="Amount" value={value.amount} min={0.1} max={2} step={0.1} onChange={(amount) => patch({ amount })}
            fmt={(v) => v.toFixed(1)} />
        </>
      )}
      {value?.kind === 'glitch' && (
        <>
          <SliderRow label="Speed" value={value.speed} min={0.1} max={4} step={0.1} onChange={(speed) => patch({ speed })}
            fmt={(v) => v.toFixed(1)} />
          <SliderRow label="Amount" value={value.amount} min={0.1} max={2} step={0.1} onChange={(amount) => patch({ amount })}
            fmt={(v) => v.toFixed(1)} />
        </>
      )}
    </>
  )
}

/**
 * Draggable "type-on" bar: the track is the object's full lifespan, the amber fill is how long the
 * object takes to type/draw on. Drag anywhere (fully left = instant / no reveal). Uses transient
 * dispatch while dragging so the whole gesture is a single undo entry.
 */
export function TypeOnBar({
  animateIn, duration, onChange, onCommit,
}: {
  animateIn: number
  duration: number
  onChange: (v: number) => void
  onCommit: () => void
}) {
  const dragging = useRef(false)
  const pct = duration > 0 ? clamp01(animateIn / duration) * 100 : 0

  const setFromEvent = (e: React.PointerEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect()
    const frac = rect.width > 0 ? clamp01((e.clientX - rect.left) / rect.width) : 0
    onChange(Math.round(frac * duration * 10) / 10)
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-1">
        <label className="text-muted text-xs">Reveal</label>
        <span className="text-[10px] text-subtle tabular-nums">
          {animateIn <= 0 ? 'instant' : `${animateIn.toFixed(1)}s of ${duration.toFixed(1)}s`}
        </span>
      </div>
      <div
        className="relative h-4 w-full rounded bg-border cursor-ew-resize select-none touch-none"
        title="Drag to set how long the object takes to reveal (type / draw on / grow in) — fully left = instant"
        onPointerDown={(e) => {
          e.preventDefault()
          dragging.current = true
          e.currentTarget.setPointerCapture(e.pointerId)
          setFromEvent(e)
        }}
        onPointerMove={(e) => { if (dragging.current) setFromEvent(e) }}
        onPointerUp={(e) => {
          if (!dragging.current) return
          dragging.current = false
          e.currentTarget.releasePointerCapture(e.pointerId)
          onCommit()
        }}
      >
        {/* Filled type-on portion, striped to match the timeline stripe */}
        <div className="absolute top-0 left-0 h-full rounded-l bg-amber-500/50 pointer-events-none" style={{ width: `${pct}%` }} />
        <div
          className="absolute top-0 left-0 h-full pointer-events-none"
          style={{ width: `${pct}%`, background: 'repeating-linear-gradient(90deg, rgba(255,255,255,0.18) 0px, rgba(255,255,255,0.18) 3px, transparent 3px, transparent 6px)' }}
        />
        {/* Grabber at the right edge of the fill */}
        <div
          className="absolute top-1/2 -translate-y-1/2 -translate-x-1/2 w-1.5 h-6 rounded-sm bg-amber-300 border border-amber-700 pointer-events-none"
          style={{ left: `${pct}%` }}
        />
      </div>
    </div>
  )
}

/** The object's full lifespan as a bar, with the transition's slice filled from one end. */
function LifespanBar({ duration, portion, align }: { duration: number; portion: number; align: 'left' | 'right' }) {
  const pct = duration > 0 ? Math.min(100, (portion / duration) * 100) : 0
  return (
    <div
      className="relative h-2 w-full rounded bg-border overflow-hidden mt-1"
      title="Transition length relative to the object's full lifespan"
    >
      <div
        className="absolute top-0 h-full bg-accent/70"
        style={{ width: `${pct}%`, left: align === 'left' ? 0 : undefined, right: align === 'right' ? 0 : undefined }}
      />
    </div>
  )
}

/** Mini timeline: this object's keyframes as colored diamonds + the live playhead position (req 6). */
export function KeyframeTrack({
  obj, kfs, clipTime, activeIdx, onSeek,
}: {
  obj: TimelineObject
  kfs: Keyframe[]
  clipTime: number
  activeIdx: number
  onSeek: (t: number) => void
}) {
  const dur = obj.duration > 0 ? obj.duration : 1
  const playPct = clamp01(clipTime / dur) * 100
  return (
    <div className="relative h-9 w-full mb-1 select-none">
      {/* baseline spanning the clip's lifespan */}
      <div className="absolute left-0 right-0 top-1/2 h-px -translate-y-1/2 bg-border-strong" />
      {/* playhead */}
      <div className="absolute top-1 bottom-3 w-0.5 -translate-x-1/2 bg-playhead z-10" style={{ left: `${playPct}%` }} />
      {/* keyframe diamonds, positioned by time and colored to match their pip */}
      {kfs.map((k, i) => {
        const pct = clamp01(k.time / dur) * 100
        const color = keyframeColor(i)
        const active = i === activeIdx
        return (
          <button
            key={i}
            onClick={() => onSeek(obj.startTime + k.time)}
            title={`Keyframe ${i + 1} @ ${k.time.toFixed(2)}s — click to jump`}
            className="absolute top-1/2 -translate-x-1/2 -translate-y-1/2 z-20 cursor-pointer"
            style={{ left: `${pct}%` }}
          >
            <span
              className="block w-3 h-3 rotate-45 border"
              style={{
                background: color,
                borderColor: active ? '#fff' : 'rgba(0,0,0,0.5)',
                boxShadow: active ? '0 0 0 2px #fff' : 'none',
              }}
            />
            <span className="absolute left-1/2 -translate-x-1/2 top-3 text-[9px] tabular-nums text-muted">{i + 1}</span>
          </button>
        )
      })}
    </div>
  )
}

/** Mini timeline for a zoom's pan/scale keyframes over its hold, + the live playhead. */
export function ZoomKeyframeTrack({
  zoom, kfs, holdTime, activeIdx, onSeek,
}: {
  zoom: CameraZoom
  kfs: CameraKeyframe[]
  holdTime: number
  activeIdx: number
  onSeek: (t: number) => void
}) {
  const hold = zoom.hold > 0 ? zoom.hold : 1
  const playPct = clamp01(holdTime / hold) * 100
  return (
    <div className="relative h-9 w-full mb-1 select-none">
      {/* baseline spanning the hold */}
      <div className="absolute left-0 right-0 top-1/2 h-px -translate-y-1/2 bg-border-strong" />
      {/* playhead (within the hold) */}
      <div className="absolute top-1 bottom-3 w-0.5 -translate-x-1/2 bg-playhead z-10" style={{ left: `${playPct}%` }} />
      {/* keyframe diamonds, positioned by hold-relative time */}
      {kfs.map((k, i) => {
        const pct = clamp01(k.time / hold) * 100
        const color = keyframeColor(i)
        const active = i === activeIdx
        return (
          <button
            key={i}
            onClick={() => onSeek(zoom.startTime + zoom.transitionIn + k.time)}
            title={`Keyframe ${i + 1} @ ${k.time.toFixed(2)}s into the hold — click to jump`}
            className="absolute top-1/2 -translate-x-1/2 -translate-y-1/2 z-20 cursor-pointer"
            style={{ left: `${pct}%` }}
          >
            <span
              className="block w-3 h-3 rotate-45 border"
              style={{
                background: color,
                borderColor: active ? '#fff' : 'rgba(0,0,0,0.5)',
                boxShadow: active ? '0 0 0 2px #fff' : 'none',
              }}
            />
            <span className="absolute left-1/2 -translate-x-1/2 top-3 text-[9px] tabular-nums text-muted">{i + 1}</span>
          </button>
        )
      })}
    </div>
  )
}

/** One-line status: where the playhead sits relative to the object's keyframes (req 6). */
export function KeyframeStatus({ kfs, clipTime, activeIdx }: { kfs: Keyframe[]; clipTime: number; activeIdx: number }) {
  let text: string
  let color: string | null = null
  if (activeIdx >= 0) {
    text = `On keyframe ${activeIdx + 1}`
    color = keyframeColor(activeIdx)
  } else if (clipTime <= kfs[0].time) {
    text = 'Before keyframe 1'
  } else if (clipTime >= kfs[kfs.length - 1].time) {
    text = `Past keyframe ${kfs.length}`
  } else {
    let i = 0
    while (i < kfs.length - 1 && !(clipTime >= kfs[i].time && clipTime < kfs[i + 1].time)) i++
    text = `Between keyframe ${i + 1} and ${i + 2}`
  }
  return (
    <p className="text-[10px] mb-2 flex items-center gap-1">
      <span className="text-subtle">Playhead:</span>
      <span className="font-semibold" style={{ color: color ?? '#d1d5db' }}>{text}</span>
    </p>
  )
}

import type {
  TimelineObject, TimelineObjectType, AnimatableProperty, AnimatableChannel, ChannelValue,
  Keyframe, KeyframePose, EasingKind, Transition, SlideDirection,
  TextData, ArrowData, TextAlign, TextEffect,
} from '../types'
import { textEffectsOf } from '../types'
import { ease, clamp01 } from './easing'
import { lerpColor } from './color'

/**
 * Shared value resolution + keyframe editing. Used by the renderer, canvas, and panel so they all
 * agree on what an object looks like at a given time.
 *
 * Model (spec 29 — sparse channel tracks): a keyframe DECLARES a sparse set of "channels"
 * (`k.props`) and governs only those. Each channel resolves as an INDEPENDENT track: a property
 * animates iff some keyframe declares it, otherwise it reads its static base value off the object
 * for the whole clip. `keyframe.time` (clip-relative) is when the declared values are reached; the
 * value animates from the previous declaring waypoint (or the base) into it, with the keyframe's
 * easing + leadIn (spec 21) shaping that segment.
 *
 * Back-compat: pre-spec-29 keyframes stored a whole-pose `pose` and no `props`. Those read as
 * "declares all six pose channels", so old data animates exactly as before with no migration.
 *
 * Editing (`editChannel`) always lands on something concrete, so you never edit a phantom
 * mid-animation value: on an existing keyframe it updates that keyframe; at the very start (t ≈ 0)
 * it moves the base/home value; anywhere else it CREATES a keyframe at the playhead. Crucially it
 * only ever keyframes channels that ALREADY animate on this object (spec 29 R9) — editing the
 * colour of an object that merely has position keyframes changes it for the whole clip, which is
 * what users expect. A channel is opted into animation explicitly, via `toggleChannel` (the ◆).
 *
 * Composition: base → channel tracks (resolvePose) → enter/exit transitions (applyTransitions).
 */

export const ANIMATABLE: AnimatableProperty[] = ['x', 'y', 'width', 'height', 'rotation', 'opacity']
export const DEFAULT_EASING: EasingKind = 'easeInOutCubic'
export const KF_EPS = 0.03 // seconds — "on this keyframe" tolerance (~1 frame @30fps)
// Default lead-in seeded on newly-created keyframes (spec 21): a short hold-then-move so the
// out-of-box feel is snappy (screen-recorder style). Clamped to the gap to the previous waypoint.
export const DEFAULT_LEAD_IN = 0.8

/**
 * Per-keyframe accent colors (by index). The 1st keyframe is red, 2nd blue, 3rd green, …
 * Shared by the panel, canvas selection box, and timeline diamonds so a keyframe reads as the
 * *same* color everywhere — making it obvious which keyframe the playhead is parked on.
 */
export const KEYFRAME_COLORS = [
  '#ef4444', // red
  '#3b82f6', // blue
  '#22c55e', // green
  '#f59e0b', // amber
  '#a855f7', // purple
  '#ec4899', // pink
  '#14b8a6', // teal
  '#f97316', // orange
]

export function keyframeColor(index: number): string {
  return KEYFRAME_COLORS[((index % KEYFRAME_COLORS.length) + KEYFRAME_COLORS.length) % KEYFRAME_COLORS.length]
}

// =====================================================================================
// The channel registry (spec 29 R3) — the SINGLE source of truth for what can animate.
// Resolver, edit primitive, panel badges and the timeline all derive from this table.
// =====================================================================================

export type InterpKind = 'number' | 'color' | 'step' | 'content' | 'effect'
export type PanelSection = 'Position' | 'Style' | 'Text' | 'Effects' | 'Arrow'

export type ChannelSpec = {
  key: AnimatableChannel
  label: string                 // human label, used in tooltips/badges
  section: PanelSection         // which inspector card owns it (drives the badges)
  interp: InterpKind
  types: TimelineObjectType[]   // object types that expose this channel
  read: (o: TimelineObject) => ChannelValue                                  // the BASE value
  write: (o: TimelineObject, v: ChannelValue) => Partial<Omit<TimelineObject, 'id' | 'type'>>
}

const VISUAL: TimelineObjectType[] = ['photo', 'video', 'text', 'arrow', 'rectangle', 'circle', 'freehand']
// Types whose Style card exposes colour + line width (i.e. everything drawn by annotations.ts).
const DRAWN: TimelineObjectType[] = ['text', 'arrow', 'rectangle', 'circle', 'freehand']
const TEXT: TimelineObjectType[] = ['text']
const ARROW: TimelineObjectType[] = ['arrow']

// `write` returns UPDATE OBJECTS (never mutations) because UPDATE_OBJECT shallow-merges — nested
// style/data must be passed whole. Callers thread the accumulator through so several channels
// compose into one style/data object instead of clobbering each other.
const td = (o: TimelineObject) => o.data as TextData
const ad = (o: TimelineObject) => o.data as ArrowData

const poseChannel = (key: AnimatableProperty, label: string): ChannelSpec => ({
  key, label, section: 'Position', interp: 'number', types: VISUAL,
  read: (o) => o[key as 'x' | 'y' | 'width' | 'height' | 'rotation'],
  write: (_o, v) => ({ [key]: v as number }),
})

export const CHANNELS: ChannelSpec[] = [
  // --- pose (the legacy six) ---
  poseChannel('x', 'X'),
  poseChannel('y', 'Y'),
  poseChannel('width', 'Width'),
  poseChannel('height', 'Height'),
  poseChannel('rotation', 'Rotation'),
  {
    // `opacity` is stored on style but belongs to the Style card in the UI.
    key: 'opacity', label: 'Opacity', section: 'Style', interp: 'number', types: VISUAL,
    read: (o) => o.style.opacity,
    write: (o, v) => ({ style: { ...o.style, opacity: clamp01(v as number) } }),
  },

  // --- style ---
  {
    key: 'style.color', label: 'Colour', section: 'Style', interp: 'color', types: DRAWN,
    read: (o) => o.style.color,
    write: (o, v) => ({ style: { ...o.style, color: v as string } }),
  },
  {
    key: 'style.lineWidth', label: 'Line width', section: 'Style', interp: 'number', types: DRAWN,
    read: (o) => o.style.lineWidth,
    write: (o, v) => ({ style: { ...o.style, lineWidth: v as number } }),
  },
  {
    key: 'style.fontSize', label: 'Font size', section: 'Style', interp: 'number', types: TEXT,
    read: (o) => o.style.fontSize ?? 32,
    write: (o, v) => ({ style: { ...o.style, fontSize: v as number } }),
  },
  {
    key: 'style.fontFamily', label: 'Font', section: 'Text', interp: 'step', types: TEXT,
    read: (o) => o.style.fontFamily ?? 'sans-serif',
    write: (o, v) => ({ style: { ...o.style, fontFamily: v as string } }),
  },
  {
    key: 'style.fontWeight', label: 'Bold', section: 'Text', interp: 'step', types: TEXT,
    read: (o) => o.style.fontWeight ?? 'bold',
    write: (o, v) => ({ style: { ...o.style, fontWeight: v as string } }),
  },
  {
    key: 'style.fontStyle', label: 'Italic', section: 'Text', interp: 'step', types: TEXT,
    read: (o) => o.style.fontStyle ?? 'normal',
    write: (o, v) => ({ style: { ...o.style, fontStyle: v as string } }),
  },

  // --- text data ---
  {
    key: 'text.content', label: 'Text', section: 'Text', interp: 'content', types: TEXT,
    read: (o) => td(o).content,
    write: (o, v) => ({ data: { ...td(o), content: (v as string) ?? '' } }),
  },
  {
    key: 'text.background', label: 'Background', section: 'Style', interp: 'color', types: TEXT,
    read: (o) => td(o).background,
    write: (o, v) => ({ data: { ...td(o), background: v as string | undefined } }),
  },
  {
    key: 'text.cornerRadius', label: 'Corner radius', section: 'Style', interp: 'number', types: TEXT,
    read: (o) => td(o).cornerRadius ?? 0,
    write: (o, v) => ({ data: { ...td(o), cornerRadius: v as number } }),
  },
  {
    key: 'text.align', label: 'Align', section: 'Text', interp: 'step', types: TEXT,
    read: (o) => td(o).align ?? 'center',
    write: (o, v) => ({ data: { ...td(o), align: v as TextAlign } }),
  },
  {
    // spec 37 (OQ2): only the FIRST layer of the text-effect stack is keyframable. Read/write target
    // effects[0] (via textEffectsOf, so a legacy single `effect` still animates); the rest of the
    // stack stays static. Writing normalizes to `effects` and clears the legacy `effect`.
    key: 'text.effect', label: 'Effect', section: 'Effects', interp: 'effect', types: TEXT,
    read: (o) => textEffectsOf(td(o))[0],
    write: (o, v) => {
      const rest = textEffectsOf(td(o)).slice(1)
      const first = v as TextEffect | undefined
      const effects = first ? [first, ...rest] : rest
      return { data: { ...td(o), effects, effect: undefined } }
    },
  },

  // --- arrow data ---
  {
    key: 'arrow.curvature', label: 'Curvature', section: 'Arrow', interp: 'number', types: ARROW,
    read: (o) => ad(o).curvature ?? 0,
    write: (o, v) => ({ data: { ...ad(o), curvature: v as number } }),
  },
  {
    key: 'arrow.headSize', label: 'Head size', section: 'Arrow', interp: 'number', types: ARROW,
    read: (o) => ad(o).headSize,
    write: (o, v) => ({ data: { ...ad(o), headSize: v as number } }),
  },
]

export const CHANNELS_BY_KEY = Object.fromEntries(CHANNELS.map((c) => [c.key, c])) as Record<AnimatableChannel, ChannelSpec>

/** The channels a given object type exposes (drives which fields get a ◆ in the inspector). */
export function channelsFor(type: TimelineObjectType): ChannelSpec[] {
  return CHANNELS.filter((c) => c.types.includes(type))
}

/** The six pose channels, as a set (used to tell a pose keyframe from a style/text-only one). */
export const POSE_CHANNELS: ReadonlySet<AnimatableChannel> = new Set<AnimatableChannel>(ANIMATABLE)
const isPoseChannel = (c: AnimatableChannel): c is AnimatableProperty => POSE_CHANNELS.has(c)

// =====================================================================================
// Reading keyframes
// =====================================================================================

/** Channels this keyframe governs. A legacy `pose` (no `props`) declares all six pose channels. */
export function declaredChannels(k: Keyframe): AnimatableChannel[] {
  const out: AnimatableChannel[] = k.props ? (Object.keys(k.props) as AnimatableChannel[]) : []
  if (k.pose) for (const p of ANIMATABLE) if (!k.props || !(p in k.props)) out.push(p)
  return out
}

export function declares(k: Keyframe, c: AnimatableChannel): boolean {
  if (k.props && c in k.props) return true
  return !!k.pose && isPoseChannel(c)
}

/**
 * This keyframe's value for `c` — `props` wins, legacy `pose` is the fallback.
 * `null` normalises back to `undefined`: an ABSENT optional value (no background, no text effect)
 * is stored as null because JSON.stringify drops undefined-valued keys, which would silently
 * un-declare the channel on save/reload. Storage says null; the rest of the app says undefined.
 */
export function channelOf(k: Keyframe, c: AnimatableChannel): ChannelValue {
  if (k.props && c in k.props) {
    const v = k.props[c]
    return v === null ? undefined : v
  }
  if (k.pose && isPoseChannel(c)) return k.pose[c]
  return undefined
}

/** Inverse of channelOf's normalisation — call on every value written into `props`. */
const storeValue = (v: ChannelValue): ChannelValue => (v === undefined ? null : v)

const EMPTY_CHANNELS: ReadonlySet<AnimatableChannel> = new Set()
// Cached by keyframe-ARRAY identity: the reducer replaces the array on every edit, so a stale entry
// is impossible, and playback (60Hz, every object, every channel) never rebuilds the set.
const animatedCache = new WeakMap<Keyframe[], Set<AnimatableChannel>>()

/** Every channel that animates on this object (i.e. is declared by at least one keyframe). */
export function animatedChannels(obj: TimelineObject): ReadonlySet<AnimatableChannel> {
  const kfs = obj.keyframes
  if (!kfs || kfs.length === 0) return EMPTY_CHANNELS
  let s = animatedCache.get(kfs)
  if (!s) {
    s = new Set<AnimatableChannel>()
    for (const k of kfs) for (const c of declaredChannels(k)) s.add(c)
    animatedCache.set(kfs, s)
  }
  return s
}

export function isChannelAnimated(obj: TimelineObject, c: AnimatableChannel): boolean {
  return animatedChannels(obj).has(c)
}

// =====================================================================================
// Track sampling — ONE implementation of the lead-in/easing formula, shared by every channel
// =====================================================================================

type Waypoint = { time: number; value: ChannelValue; easing: EasingKind; leadIn?: number }

/** Waypoints for one channel: the base value at t=0, then every keyframe that declares it. */
function trackFor(obj: TimelineObject, c: AnimatableChannel): Waypoint[] {
  const kfs = obj.keyframes
  if (!kfs || kfs.length === 0) return []
  const wps: Waypoint[] = []
  for (const k of kfs) {
    if (!declares(k, c)) continue
    wps.push({ time: k.time, value: channelOf(k, c), easing: k.easing, leadIn: k.leadIn })
  }
  if (wps.length === 0) return wps
  // A declaring keyframe at ~0 replaces the base as the start (the synthetic base is only ever a
  // start, so its easing/leadIn are never read).
  if (wps[0].time > KF_EPS) {
    const spec = CHANNELS_BY_KEY[c]
    wps.unshift({ time: 0, value: spec ? spec.read(obj) : undefined, easing: 'linear' })
  }
  return wps
}

/**
 * The bracketing pair around `t` plus the EASED progress into `b`, or null when `t` is clamped at
 * either end (hold the first / last value). Lead-in (spec 21): the move into `b` occupies only
 * [b.time − b.leadIn, b.time]; before that, `a` is held. leadIn == null ⇒ fills the whole gap.
 */
function segmentAt(wps: Waypoint[], t: number): { a: Waypoint; b: Waypoint; u: number } | null {
  if (wps.length < 2) return null
  if (t <= wps[0].time) return null
  if (t >= wps[wps.length - 1].time) return null
  for (let i = 0; i < wps.length - 1; i++) {
    const a = wps[i]
    const b = wps[i + 1]
    if (t >= a.time && t <= b.time) {
      const animStart = b.leadIn == null ? a.time : Math.max(a.time, b.time - b.leadIn)
      if (t < animStart) return { a, b, u: 0 }              // hold the previous value
      const span = b.time - animStart
      const raw = span > 1e-9 ? (t - animStart) / span : 1  // span≈0 (leadIn≈0) ⇒ snap at b.time
      return { a, b, u: ease(b.easing, raw) }               // easing of the ARRIVING keyframe
    }
  }
  return null
}

/** Interpolate two channel values per the channel's rule. `u` is already eased. */
function interpolate(kind: InterpKind, a: ChannelValue, b: ChannelValue, u: number): ChannelValue {
  switch (kind) {
    case 'number': {
      const x = a as number
      const y = b as number
      return x + (y - x) * u
    }
    case 'color':
      return lerpColor(a as string | undefined, b as string | undefined, u)
    case 'effect':
      return lerpEffect(a as TextEffect | undefined, b as TextEffect | undefined, u)
    case 'step':
    case 'content':
    default:
      // Hold the outgoing value, snap to the incoming one at the keyframe's own time. (For
      // `content` the visible cross-over is the per-glyph morph — see textMorphAt.)
      return u >= 1 ? b : a
  }
}

/**
 * The params that carry each effect's STRENGTH. Ramping these from 0 is what lets an effect fade
 * IN when it appears at a keyframe instead of snapping the glyphs into their offset positions.
 * Kinds absent here have no scalar magnitude (their look is a fill, not a displacement), so they
 * step instead.
 */
const EFFECT_MAGNITUDE: Partial<Record<TextEffect['kind'], string[]>> = {
  glow: ['blur'],
  outline: ['width'],
  shadow: ['dx', 'dy', 'blur'],
  pulse: ['amount'],
  wave: ['amplitude'],
  warble: ['amount'],
  glitch: ['amount'],
}

/** The effect at `k`× strength (k=0 ⇒ visually inert). Returns it unchanged if it has no magnitude. */
function scaleEffect(e: TextEffect, k: number): TextEffect {
  const fields = EFFECT_MAGNITUDE[e.kind]
  if (!fields) return e
  const r = { ...(e as unknown as Record<string, unknown>) }
  for (const f of fields) if (typeof r[f] === 'number') r[f] = (r[f] as number) * k
  return r as unknown as TextEffect
}

/**
 * Text effects interpolate when both sides are the SAME kind: every numeric param lerps and every
 * string param (they are all colours in the TextEffect union) colour-lerps.
 *
 * Otherwise the transition is a HAND-OVER: the outgoing effect's magnitude decays to 0 over the
 * first half of the segment and the incoming one grows from 0 over the second half, swapping kind
 * at the midpoint where both are (visually) nothing. That covers appearing, disappearing, AND
 * switching between two different kinds with one rule — wave → glow settles the glyphs back to the
 * baseline before the halo blooms, instead of cutting between two displaced states.
 *
 * Only one effect is ever active at a time, so this needs no double-paint in the renderer. Kinds
 * with no scalar magnitude (gradient/rainbow/shimmer — a fill, not a displacement) can't decay, so
 * they simply hand over at the midpoint; that's a colour change with no positional jump.
 */
function lerpEffect(a: TextEffect | undefined, b: TextEffect | undefined, u: number): TextEffect | undefined {
  if (!a && !b) return undefined
  if (!a && b) return scaleEffect(b, u)          // appearing: grow from nothing
  if (a && !b) return scaleEffect(a, 1 - u)      // disappearing: decay to nothing
  if (!a || !b) return u >= 1 ? b : a
  if (a.kind !== b.kind) {
    return u < 0.5 ? scaleEffect(a, 1 - u * 2) : scaleEffect(b, (u - 0.5) * 2)
  }
  const ra = a as unknown as Record<string, unknown>
  const rb = b as unknown as Record<string, unknown>
  const out: Record<string, unknown> = { ...ra }
  for (const key of Object.keys(rb)) {
    if (key === 'kind') continue
    const va = ra[key]
    const vb = rb[key]
    if (typeof va === 'number' && typeof vb === 'number') out[key] = va + (vb - va) * u
    else if (typeof va === 'string' && typeof vb === 'string') out[key] = lerpColor(va, vb, u) ?? vb
    else out[key] = u >= 1 ? vb : va
  }
  return out as unknown as TextEffect
}

/** The object's value for one channel at clip-relative time `t` (its base value when unanimated). */
export function channelValueAt(obj: TimelineObject, c: AnimatableChannel, t: number): ChannelValue {
  const spec = CHANNELS_BY_KEY[c]
  const wps = trackFor(obj, c)
  if (wps.length === 0) return spec ? spec.read(obj) : undefined
  if (t <= wps[0].time) return wps[0].value
  const last = wps[wps.length - 1]
  if (t >= last.time) return last.value
  const seg = segmentAt(wps, t)
  if (!seg) return last.value
  return interpolate(spec ? spec.interp : 'step', seg.a.value, seg.b.value, seg.u)
}

// =====================================================================================
// Pose helpers (the hot path + the public API the canvas/panel already use)
// =====================================================================================

export function basePose(obj: TimelineObject): KeyframePose {
  return { x: obj.x, y: obj.y, width: obj.width, height: obj.height, rotation: obj.rotation, opacity: obj.style.opacity }
}

/** The object's pose at clip-relative time `t`. */
export function poseAt(obj: TimelineObject, t: number): KeyframePose {
  const chans = animatedChannels(obj)
  const base = basePose(obj)
  if (chans.size === 0) return base
  for (const p of ANIMATABLE) {
    if (chans.has(p)) base[p] = channelValueAt(obj, p, t) as number
  }
  return base
}

/** Effective value of a single pose property at clip-relative time `t`. */
export function effVal(obj: TimelineObject, p: AnimatableProperty, t: number): number {
  return channelValueAt(obj, p, t) as number
}

export function isKeyframed(obj: TimelineObject): boolean {
  return (obj.keyframes?.length ?? 0) > 0
}

export function keyframeTimes(obj: TimelineObject): number[] {
  return (obj.keyframes ?? []).map((k) => Math.round(k.time * 1000) / 1000)
}

/** Index of the keyframe the playhead is currently parked on (within KF_EPS), or -1. */
export function activeKeyframeIndex(obj: TimelineObject, globalTime: number): number {
  const kfs = obj.keyframes
  if (!kfs || kfs.length === 0) return -1
  const t = globalTime - obj.startTime
  return kfs.findIndex((k) => Math.abs(k.time - t) < KF_EPS)
}

/**
 * Resolve every animated channel at `globalTime` — returns the object unchanged when nothing on it
 * animates, so an un-keyframed object renders pixel-identically to the pre-keyframe path.
 */
export function resolvePose(obj: TimelineObject, globalTime: number): TimelineObject {
  const chans = animatedChannels(obj)
  if (chans.size === 0) return obj
  const t = globalTime - obj.startTime
  let out = obj
  for (const c of chans) {
    const spec = CHANNELS_BY_KEY[c]
    if (!spec || !spec.types.includes(obj.type)) continue
    // Values are read from the ORIGINAL object (base values), written onto the accumulator so
    // several style/data channels compose instead of clobbering each other.
    out = { ...out, ...spec.write(out, channelValueAt(obj, c, t)) }
  }
  return out
}

// =====================================================================================
// Text content morph (spec 29 §C)
// =====================================================================================

/** An in-flight text change: the outgoing string, the incoming one, and the eased progress. */
export type TextMorph = { from: string; to: string; u: number }

/**
 * The text morph in flight at clip-relative `t`, or null when the content isn't mid-change. Uses
 * the arriving keyframe's easing + leadIn as the morph window, so `instant` easing pins `u` at 0
 * until the keyframe's own time and the swap reads as a hard cut with no special-casing.
 */
export function textMorphAt(obj: TimelineObject, t: number): TextMorph | null {
  if (obj.type !== 'text') return null
  if (!animatedChannels(obj).has('text.content')) return null
  const seg = segmentAt(trackFor(obj, 'text.content'), t)
  if (!seg || seg.u <= 0 || seg.u >= 1) return null
  const from = (seg.a.value as string) ?? ''
  const to = (seg.b.value as string) ?? ''
  return from === to ? null : { from, to, u: seg.u }
}

// =====================================================================================
// Enter / exit transitions (independent of keyframes)
// =====================================================================================

export function defaultTransitionEasing(kind: Transition['kind'], phase: 'in' | 'out'): EasingKind {
  if (kind === 'fade') return phase === 'in' ? 'easeOutCubic' : 'easeInCubic'
  return phase === 'in' ? 'easeOutBack' : 'easeInCubic' // slide / pop
}

function slideAway(dir: SlideDirection, o: TimelineObject): { dx: number; dy: number } {
  switch (dir) {
    case 'left':   return { dx: -(o.x + o.width + 0.05), dy: 0 }
    case 'right':  return { dx: (1.05 - o.x), dy: 0 }
    case 'top':    return { dx: 0, dy: -(o.y + o.height + 0.05) }
    case 'bottom': return { dx: 0, dy: (1.05 - o.y) }
  }
}

function applyTransition(o: TimelineObject, tr: Transition, p: number): TimelineObject {
  switch (tr.kind) {
    case 'fade':
      return { ...o, style: { ...o.style, opacity: o.style.opacity * p } }
    case 'slide': {
      const { dx, dy } = slideAway(tr.direction ?? 'left', o)
      return { ...o, x: o.x + (1 - p) * dx, y: o.y + (1 - p) * dy }
    }
    case 'pop': {
      const w = o.width * p
      const h = o.height * p
      return { ...o, x: o.x + (o.width - w) / 2, y: o.y + (o.height - h) / 2, width: w, height: h }
    }
    default:
      return o
  }
}

/** Apply enter/exit transitions on top of a (already channel-resolved) object, for rendering. */
export function applyTransitions(pose: TimelineObject, obj: TimelineObject, globalTime: number): TimelineObject {
  let out = pose
  const elapsed = globalTime - obj.startTime
  const remaining = obj.startTime + obj.duration - globalTime

  if (obj.enter && obj.enter.kind !== 'none' && elapsed >= 0 && elapsed < obj.enter.duration) {
    const p = ease(obj.enter.easing ?? defaultTransitionEasing(obj.enter.kind, 'in'), clamp01(elapsed / obj.enter.duration))
    out = applyTransition(out, obj.enter, p)
  }
  if (obj.exit && obj.exit.kind !== 'none' && remaining >= 0 && remaining < obj.exit.duration) {
    const q = ease(obj.exit.easing ?? defaultTransitionEasing(obj.exit.kind, 'out'), clamp01(remaining / obj.exit.duration))
    out = applyTransition(out, obj.exit, q)
  }
  return out
}

/** Full render state: base → channel tracks → enter/exit. Unchanged when nothing applies. */
export function resolveRenderPose(obj: TimelineObject, globalTime: number): TimelineObject {
  return applyTransitions(resolvePose(obj, globalTime), obj, globalTime)
}

// =====================================================================================
// Editing
// =====================================================================================

type PoseUpdates = Partial<Omit<TimelineObject, 'id' | 'type'>>
type ChannelOverrides = Partial<Record<AnimatableChannel, ChannelValue>>

/**
 * Edit channels at clip-relative `t`. Editing NEVER creates a keyframe — keyframes are born only from
 * the explicit `+ Keyframe` button (`addKeyframeAt`) or the ◆ toggle (`toggleChannel`). Every edit
 * lands on something concrete:
 *  - parked ON an existing keyframe (within KF_EPS) → merges into THAT keyframe's declarations;
 *  - anywhere else (including the start, and mid-clip on an already-animated channel) → edits the
 *    object's BASE value for the whole clip.
 *
 * Consequence (by design): nudging an ALREADY-animated pose channel mid-clip writes the base/home
 * value, which won't visibly move the object at a scrub point past its first keyframe — to change an
 * animated property at a given time, park on a keyframe or add one with the button. This is the
 * deliberate replacement for the old "auto-create a keyframe on any off-keyframe edit" behaviour,
 * which spawned unwanted keyframes whenever you tweaked something while scrubbed.
 */
export function editChannel(obj: TimelineObject, overrides: ChannelOverrides, t: number): PoseUpdates {
  const keys = Object.keys(overrides) as AnimatableChannel[]
  const kfs = obj.keyframes
  const idx = kfs ? kfs.findIndex((k) => Math.abs(k.time - t) < KF_EPS) : -1

  const live: AnimatableChannel[] = []
  const base: AnimatableChannel[] = []
  for (const c of keys) {
    // Parked ON a keyframe: you are explicitly editing THAT keyframe (the panel says so), so any
    // property you touch is declared there — this is how a property gets animated without hunting
    // for its ◆. Off a keyframe: edit the base value for the whole clip and NEVER auto-keyframe.
    if (idx >= 0) live.push(c)
    else base.push(c)
  }

  const updates: PoseUpdates = {}
  // Base writes threaded through an accumulator so multiple style/data channels compose.
  let acc = obj
  for (const c of base) {
    const spec = CHANNELS_BY_KEY[c]
    if (!spec) continue
    const u = spec.write(acc, overrides[c])
    acc = { ...acc, ...u } as TimelineObject
    Object.assign(updates, u)
  }

  // live is only ever populated when parked on a keyframe (idx >= 0): merge the edits into it.
  if (live.length && kfs && idx >= 0) {
    const props: ChannelOverrides = { ...(kfs[idx].props ?? {}) }
    for (const c of live) props[c] = storeValue(overrides[c])
    updates.keyframes = kfs.map((k, j) => (j === idx ? { ...k, props } : k))
  }
  return updates
}

/** Pose-only convenience wrapper (canvas drag/resize/rotate, context toolbar). */
export function editPose(obj: TimelineObject, overrides: Partial<Record<AnimatableProperty, number>>, t: number): PoseUpdates {
  return editChannel(obj, overrides as ChannelOverrides, t)
}

/** The channel that owns `style.<field>` / `<dataPrefix>.<field>` on this object type, if any. */
export function channelForField(type: TimelineObjectType, group: 'style' | 'data', field: string): AnimatableChannel | null {
  for (const spec of CHANNELS) {
    if (!spec.types.includes(type)) continue
    const dot = spec.key.indexOf('.')
    if (dot < 0) continue // pose channels are top-level, never part of a style/data patch
    const prefix = spec.key.slice(0, dot)
    const isStyle = prefix === 'style'
    if ((group === 'style') !== isStyle) continue
    if (spec.key.slice(dot + 1) === field) return spec.key
  }
  return null
}

/**
 * Edit a whole style/data patch — the shape the context toolbar (and other patch-style call sites)
 * work in. Every field that HAS a channel routes through `editChannel` so it obeys the same
 * base-vs-keyframe rule as the inspector; fields with no channel (points, strokes, autoSize,
 * progressiveHead…) merge straight onto the base as before.
 */
export function editPatch(
  obj: TimelineObject,
  patch: { style?: Record<string, unknown>; data?: Record<string, unknown> },
  t: number,
): PoseUpdates {
  const overrides: ChannelOverrides = {}
  const restStyle: Record<string, unknown> = {}
  const restData: Record<string, unknown> = {}

  for (const [f, v] of Object.entries(patch.style ?? {})) {
    const c = channelForField(obj.type, 'style', f)
    if (c) overrides[c] = v as ChannelValue
    else restStyle[f] = v
  }
  for (const [f, v] of Object.entries(patch.data ?? {})) {
    const c = channelForField(obj.type, 'data', f)
    if (c) overrides[c] = v as ChannelValue
    else restData[f] = v
  }

  const updates = editChannel(obj, overrides, t)
  if (Object.keys(restStyle).length) {
    updates.style = { ...(updates.style ?? obj.style), ...restStyle } as TimelineObject['style']
  }
  if (Object.keys(restData).length) {
    updates.data = { ...(updates.data ?? obj.data), ...restData } as TimelineObject['data']
  }
  return updates
}

/**
 * Opt a channel in or out of animation at clip-relative `t` — the ◆ affordance (spec 29 R10).
 * If the keyframe at `t` declares the channel, the declaration is dropped (and the keyframe itself
 * if it ends up declaring nothing); otherwise the channel's CURRENT resolved value is captured
 * there, creating the keyframe if needed.
 */
export function toggleChannel(obj: TimelineObject, c: AnimatableChannel, t: number): PoseUpdates {
  const time = Math.max(0, t)
  const kfs = obj.keyframes ?? []
  const idx = kfs.findIndex((k) => Math.abs(k.time - time) < KF_EPS)

  if (idx >= 0 && declares(kfs[idx], c)) {
    // Drop the declaration. A legacy `pose` keyframe is materialised into explicit `props` first,
    // so removing one pose channel doesn't silently resurrect it from the whole-pose fallback.
    const remaining = declaredChannels(kfs[idx]).filter((k) => k !== c)
    if (remaining.length === 0) {
      const next = kfs.filter((_, j) => j !== idx)
      return { keyframes: next.length ? next : undefined }
    }
    const props: ChannelOverrides = {}
    for (const k of remaining) props[k] = storeValue(channelOf(kfs[idx], k))
    return { keyframes: kfs.map((k, j) => (j === idx ? { time: k.time, props, easing: k.easing, leadIn: k.leadIn } : k)) }
  }

  const value = storeValue(channelValueAt(obj, c, time))
  if (idx >= 0) {
    const props: ChannelOverrides = { ...(kfs[idx].props ?? {}), [c]: value }
    return { keyframes: kfs.map((k, j) => (j === idx ? { ...k, props } : k)) }
  }
  const next = [...kfs, { time, props: { [c]: value } as ChannelOverrides, easing: seedEasing(kfs, time), leadIn: seedLeadIn(kfs, time) }]
  next.sort((a, b) => a.time - b.time)
  return { keyframes: next }
}

/**
 * Default lead-in for a keyframe created at `time`, clamped to the gap to the nearest EARLIER
 * waypoint (spec 21 R10). `existing` is the keyframe list before insertion.
 */
export function seedLeadIn(existing: { time: number }[], time: number): number {
  let prev = 0
  for (const k of existing) if (k.time < time - KF_EPS && k.time > prev) prev = k.time
  return Math.min(DEFAULT_LEAD_IN, Math.max(0, time - prev))
}

/**
 * Easing a newly-created keyframe should adopt: the last motion chosen for this object (the nearest
 * earlier keyframe, else the nearest later one), so new keyframes continue the object's feel instead
 * of snapping back to the default. Falls back to DEFAULT_EASING when there are no keyframes yet.
 */
export function seedEasing(existing: { time: number; easing: EasingKind }[], time: number): EasingKind {
  let prev: { time: number; easing: EasingKind } | null = null
  let next: { time: number; easing: EasingKind } | null = null
  for (const k of existing) {
    if (k.time <= time + KF_EPS) { if (!prev || k.time > prev.time) prev = k }
    else if (!next || k.time < next.time) next = k
  }
  return (prev ?? next)?.easing ?? DEFAULT_EASING
}

/**
 * Insert a keyframe at clip-relative `t` capturing the current rendered POSE (the "+ Keyframe"
 * button, spec 29 R11 — it keeps its pre-29 meaning so the position workflow is unchanged).
 */
export function addKeyframeAt(obj: TimelineObject, t: number): Keyframe[] {
  const time = Math.max(0, t)
  const pose = poseAt(obj, time)
  const props: ChannelOverrides = {}
  for (const p of ANIMATABLE) props[p] = pose[p]
  const kfs = obj.keyframes ? [...obj.keyframes] : []
  const idx = kfs.findIndex((k) => Math.abs(k.time - time) < KF_EPS)
  // Update in place → leave leadIn/easing and any non-pose declarations untouched.
  if (idx >= 0) kfs[idx] = { ...kfs[idx], props: { ...(kfs[idx].props ?? {}), ...props } }
  else kfs.push({ time, props, easing: seedEasing(kfs, time), leadIn: seedLeadIn(kfs, time) })
  kfs.sort((a, b) => a.time - b.time)
  return kfs
}

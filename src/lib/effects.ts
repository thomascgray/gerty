import type { VideoEffect, ResolvedEffect } from '../types'
import { layersOf } from '../types'
import { ease, clamp01 } from './easing'

/**
 * Video-effect resolver (spec 23).
 *
 * Compiles the authored list of `VideoEffect`s into the effect stack active at a global time. A thin
 * layer over the spec-12 easing engine, mirroring `resolveCamera` (camera.ts) but MUCH simpler:
 * effects don't chain / hand off to each other (no governing-window model) — each resolves its own
 * eased intensity from its envelope and they just stack.
 *
 * Envelope (identical shape to a zoom): ease-in ramps intensity 0 → peak, holds, ease-out ramps
 * peak → 0. An effect with transitionIn == transitionOut == 0 is a hard cut on/off. Because the
 * intensity is what's eased, the ease-in *is* the fade-in for both the colour filters (fractional
 * filter amount) and the vignette overlay (alpha).
 */

/** Total envelope length (ease-in + hold + ease-out), in seconds. Parity with `zoomEnvelope`. */
export function effectEnvelope(e: VideoEffect): number {
  return e.transitionIn + e.hold + e.transitionOut
}

/**
 * The eased envelope FACTOR (0–1) of a container at `globalTime` — 0 outside its envelope. This is the
 * shared ramp the whole layer stack fades on (spec 37); each layer's resolved intensity is its own peak
 * `intensity` multiplied by this factor.
 */
function envelopeFactorAt(e: VideoEffect, globalTime: number): number {
  const local = globalTime - e.startTime
  if (local < 0) return 0
  const inEnd = e.transitionIn
  const holdEnd = inEnd + e.hold
  const outEnd = holdEnd + e.transitionOut

  if (e.transitionIn > 0 && local < inEnd) {
    return ease(e.easing, local / e.transitionIn)
  }
  if (local < holdEnd) return 1
  if (e.transitionOut > 0 && local < outEnd) {
    return ease(e.easing, 1 - (local - holdEnd) / e.transitionOut)
  }
  return 0 // before the ease-in / after the ease-out
}

/**
 * Resolve the effect stack at `globalTime` (spec 37: containers of layers). For each non-hidden
 * container active at `globalTime`, its shared envelope factor scales each non-hidden layer's peak
 * intensity; layers at intensity ≤ 0 are dropped. Containers are ordered by startTime then id, and
 * layers keep their in-container order — a deterministic compose order (spec 23 Q4) so colour filters
 * concatenate and overlays stack the same way every render. Downstream still consumes ResolvedEffect[].
 */
export function resolveEffects(effects: VideoEffect[] | undefined, globalTime: number): ResolvedEffect[] {
  if (!effects || effects.length === 0) return []
  const ordered = [...effects].sort(
    (a, b) => (a.startTime - b.startTime) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  )
  const active: ResolvedEffect[] = []
  for (const e of ordered) {
    if (e.hidden) continue
    const factor = envelopeFactorAt(e, globalTime)
    if (factor <= 0) continue
    for (const layer of layersOf(e)) {
      if (layer.hidden) continue
      const intensity = clamp01(layer.intensity * factor)
      if (intensity <= 0) continue
      active.push({
        kind: layer.kind,
        intensity,
        vignette: layer.vignette,
        oldfilm: layer.oldfilm,
        hue: layer.hue,
        lightleak: layer.lightleak,
        chromatic: layer.chromatic,
        gradientmap: layer.gradientmap,
        posterize: layer.posterize,
        threshold: layer.threshold,
        channelswap: layer.channelswap,
        colorisolate: layer.colorisolate,
        dither: layer.dither,
        crt: layer.crt,
        vhs: layer.vhs,
        halftone: layer.halftone,
        comic: layer.comic,
      })
    }
  }
  return active
}

/**
 * Map the colour-grade effects to a CSS `filter` string (e.g. "grayscale(0.8) invert(1)").
 * Ignores overlay / per-pixel kinds. Returns '' when no colour-filter effects are active.
 * `globalTime` drives the animated-hue cycle (deterministic ⇒ preview == export).
 */
export function effectsToFilterString(fx: ResolvedEffect[], globalTime: number): string {
  const parts: string[] = []
  for (const e of fx) {
    switch (e.kind) {
      case 'grayscale': parts.push(`grayscale(${e.intensity})`); break
      case 'sepia': parts.push(`sepia(${e.intensity})`); break
      case 'invert': parts.push(`invert(${e.intensity})`); break
      // spec 24 Tier 1 colour grades:
      case 'hue': {
        const h = e.hue
        const deg = h?.animate
          ? (globalTime * (h.speed ?? 0)) % 360          // continuous cycle
          : e.intensity * (h?.angle ?? 0)                 // static, faded by intensity
        parts.push(`hue-rotate(${deg}deg)`)
        break
      }
      case 'contrast': {
        // Contrast crush: push contrast up and nudge brightness down as intensity rises.
        parts.push(`contrast(${1 + e.intensity * 1.4}) brightness(${1 - e.intensity * 0.12})`)
        break
      }
      case 'bleach': {
        // Bleach-bypass approximation: high contrast + heavy desaturation + slight lift.
        parts.push(
          `contrast(${1 + e.intensity * 0.7}) saturate(${1 - e.intensity * 0.7}) brightness(${1 + e.intensity * 0.08})`,
        )
        break
      }
      // Overlay + WebGL-shader kinds — handled elsewhere, not a CSS filter:
      case 'vignette': case 'grain': case 'oldfilm':
      case 'lightleak': case 'chromatic': case 'pixelate':
      case 'gradientmap': case 'posterize': case 'threshold':
      case 'channelswap': case 'colorisolate': case 'dither':
      case 'crt': case 'vhs': case 'halftone': case 'comic':
        break
    }
  }
  return parts.join(' ')
}

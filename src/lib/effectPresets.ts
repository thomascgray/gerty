import type { VideoEffect, VideoEffectKind, EffectLayer } from '../types'
import { createVideoEffect, createEffectLayer } from '../types'

/**
 * Effect presets (spec 26 / 37) — named, developer-authored *stacks* of effects that drop with one click.
 *
 * A preset is pure data: a list of `{ kind, options }` layer specs. Applying it builds ONE Full screen
 * effect container at the playhead whose layer stack is those specs (spec 37 — was N separate effects
 * pre-37), added in one undo entry (`ADD_EFFECT`). It's just a starting point — the container and its
 * layers are fully editable and deletable afterward, exactly like a hand-added one. Composes the
 * existing spec-23/24/25 effect kinds; adds no new render paths.
 */

type EffectSpec = {
  kind: VideoEffectKind
  options?: Partial<Omit<EffectLayer, 'id' | 'kind'>>
}

export type EffectPreset = {
  id: string
  name: string
  description: string
  effects: EffectSpec[]
}

// A longer default hold than a single effect (which defaults to 2s) so a dropped preset visibly
// covers a clip. Applied to the container's shared envelope (spec 37).
const HOLD = 5

export const EFFECT_PRESETS: EffectPreset[] = [
  {
    id: 'cinematic',
    name: 'Cinematic',
    description: 'Hollywood teal-and-orange grade: teal shadows, warm highlights, punchy contrast and a soft vignette.',
    effects: [
      { kind: 'gradientmap', options: { intensity: 0.5, gradientmap: { preset: 'cinematic' } } },
      { kind: 'contrast', options: { intensity: 0.35 } },
      { kind: 'vignette', options: { intensity: 0.45, vignette: { shape: 'rectangle', size: 0.72, feather: 0.5 } } },
    ],
  },
  {
    id: 'cinematiccool',
    name: 'Cinematic Cool',
    description: 'Moody blue night grade: deep blue shadows, cool highlights, contrast and a soft vignette.',
    effects: [
      { kind: 'gradientmap', options: { intensity: 0.5, gradientmap: { preset: 'cinemacool' } } },
      { kind: 'contrast', options: { intensity: 0.35 } },
      { kind: 'vignette', options: { intensity: 0.5, vignette: { shape: 'rectangle', size: 0.7, feather: 0.5 } } },
    ],
  },
  {
    id: 'super8',
    name: 'Super 8',
    description: 'Vintage home-movie film: gate weave, grain, vignette and a warm tint.',
    effects: [
      { kind: 'oldfilm', options: { intensity: 0.7, oldfilm: { wobble: 0.4 } } },
      { kind: 'grain', options: { intensity: 0.5 } },
      { kind: 'vignette', options: { intensity: 0.6, vignette: { shape: 'rectangle', size: 0.7, feather: 0.4 } } },
      { kind: 'sepia', options: { intensity: 0.5 } },
    ],
  },
  {
    id: 'retrotv',
    name: 'Retro TV',
    description: 'Old television set: CRT curvature and scanlines over VHS chroma bleed and tracking.',
    effects: [
      { kind: 'crt', options: { intensity: 1, crt: { curvature: 0.35, scanline: 0.5 } } },
      { kind: 'vhs', options: { intensity: 0.7, vhs: { bleed: 0.4, noise: 0.4 } } },
    ],
  },
  {
    id: 'noir',
    name: 'Film Noir',
    description: 'High-contrast black & white with a heavy vignette.',
    effects: [
      { kind: 'grayscale', options: { intensity: 1 } },
      { kind: 'contrast', options: { intensity: 0.6 } },
      { kind: 'vignette', options: { intensity: 0.75, vignette: { shape: 'circle', size: 0.5, feather: 0.5 } } },
    ],
  },
  {
    id: 'comicbook',
    name: 'Comic Book',
    description: 'Inked edges over flat posterized colour with a halftone dot screen.',
    effects: [
      { kind: 'comic', options: { intensity: 1, comic: { levels: 4, thickness: 1.2 } } },
      { kind: 'halftone', options: { intensity: 0.4, halftone: { cell: 5, angle: 45 } } },
    ],
  },
  {
    id: 'grimdark',
    name: 'Grimdark',
    description: 'Bleached, crushed and heavily vignetted for a bleak look.',
    effects: [
      { kind: 'bleach', options: { intensity: 0.7 } },
      { kind: 'contrast', options: { intensity: 0.5 } },
      { kind: 'vignette', options: { intensity: 0.8, vignette: { shape: 'rectangle', size: 0.55, feather: 0.5 } } },
    ],
  },
  {
    id: 'vaporwave',
    name: 'Vaporwave',
    description: 'Dreamy pink/blue duotone with chromatic fringing and a touch of grain.',
    effects: [
      { kind: 'gradientmap', options: { intensity: 0.6, gradientmap: { preset: 'risograph' } } },
      { kind: 'chromatic', options: { intensity: 0.5, chromatic: { offset: 6, angle: 0 } } },
      { kind: 'grain', options: { intensity: 0.3 } },
    ],
  },
  {
    id: 'nightvision',
    name: 'Night Vision',
    description: 'Green phosphor false-colour with grain and a scope vignette.',
    effects: [
      { kind: 'gradientmap', options: { intensity: 1, gradientmap: { preset: 'nightvision' } } },
      { kind: 'grain', options: { intensity: 0.4 } },
      { kind: 'vignette', options: { intensity: 0.75, vignette: { shape: 'circle', size: 0.5, feather: 0.5 } } },
    ],
  },
]

/** Build ONE Full screen effect container for a preset (spec 37): its layer stack is the preset's
 * specs, sharing an envelope that starts at `startTime` (the playhead) and holds for HOLD seconds. */
export function buildPresetEffect(preset: EffectPreset, startTime: number): VideoEffect {
  const layers: EffectLayer[] = preset.effects.map(({ kind, options }) => createEffectLayer(kind, options))
  return createVideoEffect({ startTime, hold: HOLD, layers })
}

import type { ComponentType } from 'react'
import type { VideoEffectKind } from '../types'
import {
  IconContrast, IconDroplet, IconColorSwatch, IconVignette, IconGrain, IconMovie,
  IconRainbow, IconContrast2, IconSunHigh, IconFlare, IconAperture, IconGridDots, IconGradienter,
  IconStack2, IconCircleHalf2, IconArrowsExchange, IconColorPicker, IconGridPattern,
  IconDeviceTv, IconDeviceTvOld, IconCircles, IconBrush,
  type IconProps,
} from '@tabler/icons-react'

export type TablerIcon = ComponentType<IconProps>

// One source of truth for per-effect-kind icons (spec 31 D6). Consumed by BOTH the LeftRail
// creation list and the PropertiesPanel per-effect inspector cards, so the two can never drift
// (the duplication that let the ✨ sparkles dump happen). Exhaustive over VideoEffectKind, so
// adding a kind fails to typecheck until it gets an icon here.
export const EFFECT_ICON: Record<VideoEffectKind, TablerIcon> = {
  // spec 23
  grayscale: IconContrast,
  sepia: IconDroplet,
  invert: IconColorSwatch,
  vignette: IconVignette,
  grain: IconGrain,
  oldfilm: IconMovie,
  // spec 24
  hue: IconRainbow,
  contrast: IconContrast2,
  bleach: IconSunHigh,
  lightleak: IconFlare,
  chromatic: IconAperture,
  pixelate: IconGridDots,
  // spec 25 (WebGL)
  gradientmap: IconGradienter,
  posterize: IconStack2,
  threshold: IconCircleHalf2,
  channelswap: IconArrowsExchange,
  colorisolate: IconColorPicker,
  dither: IconGridPattern,
  crt: IconDeviceTv,
  vhs: IconDeviceTvOld,
  halftone: IconCircles,
  comic: IconBrush,
}

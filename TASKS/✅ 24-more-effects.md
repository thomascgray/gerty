# 24 — More Video Effects (first slice)

**Status**: Complete

## Overview

Extend the spec-23 video-effect system (`Project.effects`) with a first slice of new effect kinds. All Canvas 2D — this app has **no WebGL**. Scope locked (spec D2):

- **Tier 1 — CSS `ctx.filter` colour grades:** `hue` (static + animated cycle), `contrast` (contrast crush), `bleach` (bleach-bypass approximation).
- **Tier 2 — blend/overlay:** `lightleak` (drifting coloured gradient, screen blend), `chromatic` (RGB channel split via 3 tinted composites — no per-pixel), `pixelate` (downscale/upscale).
- **Category C — per-pixel branch (NEW infra):** `gradientmap` (luminance → ramp LUT; presets thermal/nightvision/infrared/risograph). This builds the reusable per-pixel render branch for later kinds.

Remaining Tier 3/4 kinds (posterize, threshold, channelswap, colorisolate, dither, scanlines, halftone, projectorburn, tear, VHS, comic ink, etc.) are **deferred to a follow-up task**.

Full spec: [SPECS/24-more-effects.md](../SPECS/24-more-effects.md).

## Task Context

**The 6 touch-points to add an effect kind (all mechanical):**
1. `src/types.ts` — `VideoEffectKind` union; optional param type + field on `VideoEffect`; `ResolvedEffect` passthrough; `createVideoEffect` default seeding (~L362).
2. `src/lib/effects.ts` — `effectsToFilterString` (colour kinds); `resolveEffects` payload passthrough (~L56).
3. `src/lib/renderer.ts` — colour branch (filter) / overlay branch (`drawX`) / **new per-pixel branch**. Effect post-process block ~L91-126.
4. `src/components/PropertiesPanel.tsx` — `EFFECT_LABEL` (~L814) + per-kind param `Accordion` in `EffectEditor` (~L890).
5. `src/components/LeftRail.tsx` — Effects menu item + `@tabler/icons-react` icon (~L101).
6. `src/components/Timeline.tsx` — `EFFECT_BAR_LABEL` (~L56). Track/drag/selection are generic.

**Reference implementations to copy:**
- `drawGrain` (renderer.ts) — cached tile + `createPattern` + time-seeded offset.
- `drawOldFilm` — `mulberry32(hashInt(frame))` deterministic per-frame; `getScratchCanvas` for frame copies.
- `drawVignette` — gradient overlay.

**Hard rules (from the architecture):**
- No `Math.random` — animated effects derive from `globalTime` via `hashInt`/`mulberry32` or arithmetic (light-leak drift, animated hue). No previous-frame state.
- Worker-safe: only CSS filter functions, blend modes, gradients/patterns, `drawImage`, `ImageData`. No SVG-URL filters / `feTurbulence`.
- Additive: a project with no new effects renders pixel-identically. Verify with `npx tsc -b` (only typecheck gate).

**Decisions:** D1 — additive optional param fields (keep spec-23 `vignette?`/`oldfilm?` pattern, no `params` union). D2 — the slice above.

**Design notes:**
- Chromatic split: draw frame 3× tinted pure R/G/B (`multiply` against `#f00`/`#0f0`/`#00f`), recombine offset copies with `lighter`/`screen`. Offset+angle scaled by eased intensity. Needs a scratch canvas.
- Pixelate: `drawImage` down to `w/cell × h/cell` into scratch, back up with `imageSmoothingEnabled=false`. `cell = 1 + intensity*MAX_CELL`.
- Animated hue needs `globalTime` threaded into `effectsToFilterString` (currently timeless).
- Per-pixel transforms live in new pure module `src/lib/effectPixels.ts` (luminance helper + ramp sampler) — worker-safe, testable. Read once / write once when multiple per-pixel effects stack.
- Compose-order caveat (Open Q3, accepted for v1): colour CSS filters batch before overlays/per-pixel; a per-pixel effect authored "before" a colour filter still sees post-filter pixels. Documented, not fixed.

## Blockers/Issues

- [RESOLVED 2026-07-25] **Gradient map near-froze the app.** Root cause: the preview canvas
  (`useCanvasRenderer.ts:34`) is created without `willReadFrequently`, so `getImageData` directly on
  it forced a GPU→CPU readback stall every frame at 60fps (Chrome's readback cliff), and risked
  flipping the whole main canvas to software rendering. Fix: the per-pixel branch now routes through a
  dedicated CPU-backed `getPixelBuffer` (`getContext('2d', { willReadFrequently: true })`) — draw main→buf,
  read/transform/write on the buffer, blit buf→main. One cheap transfer/frame instead of a flagged
  readback on the GPU canvas. Chromatic/pixelate were never affected (they use `drawImage`, not `getImageData`).

## TODO

[X] **Types** (`types.ts`)
  [X] Extend `VideoEffectKind` with `hue|contrast|bleach|lightleak|chromatic|pixelate|gradientmap`
  [X] Add param types: `HueParams`, `LightLeakParams`, `ChromaticParams`, `GradientMapParams` (contrast/bleach/pixelate map intensity directly — no params)
  [X] Add optional fields to `VideoEffect` + `ResolvedEffect` passthrough
  [X] Seed defaults in `createVideoEffect` (+ subtle intensity seeds for lightleak/chromatic/pixelate)
[X] **Resolver** (`effects.ts`)
  [X] `effectsToFilterString`: `hue`/`contrast`/`bleach` cases; threaded `globalTime` for animated hue
  [X] `resolveEffects`: pass new payloads through
[X] **Renderer** (`renderer.ts`)
  [X] Overlay: `drawLightLeak`, `drawChromatic` (3 tinted composites), `drawPixelate`
  [~] Per-pixel branch + `gradientmap` — built, then REMOVED (too laggy on Canvas 2D). Deferred to WebGL. See spec D3.
[X] **UI**
  [X] LeftRail: 7 menu items + icons
  [X] PropertiesPanel: labels + param editors (hue animate/angle/speed, lightleak colour/angle/speed, chromatic offset/angle, gradientmap preset)
  [X] Timeline: `EFFECT_BAR_LABEL` entries
[X] `npx tsc -b` green
[X] User browser verification — user confirmed all 6 shipping effects look good (2026-07-25)

## Work Log

[2026-07-25] Task created; scope locked to D2 slice. Spec at SPECS/24-more-effects.md.
[2026-07-25] Implemented the full D2 slice. `npx tsc -b` green.
- **Types** (`src/types.ts`): extended `VideoEffectKind` (+7 kinds); added `HueParams`/`LightLeakParams`/`ChromaticParams`/`GradientMapParams` (+`GradientMapPreset`); added optional payload fields to `VideoEffect` + `ResolvedEffect`; seeded defaults + subtle intensity seeds in `createVideoEffect`.
- **Resolver** (`src/lib/effects.ts`): `effectsToFilterString(fx, globalTime)` now emits `hue-rotate`/`contrast`+`brightness`/`bleach` terms (animated hue cycles off `globalTime`); `resolveEffects` threads the 4 new payloads.
- **Renderer** (`src/lib/renderer.ts`): threaded `globalTime` into the filter call; added a **per-pixel branch** (read once → `applyGradientMap` → write once) between the colour-filter and overlay branches; added overlays `drawChromatic` (multiply-tint channel isolation + `lighter` recombine, dedicated snap/tint canvases), `drawPixelate` (downscale/upscale, smoothing off, shared scratch), `drawLightLeak` (drifting radial glow in `screen`, `globalTime`-driven). Added `hexToRgb`/`makeCanvas` helpers.
- **New module** `src/lib/effectPixels.ts`: pure worker-safe `applyGradientMap` with cached 256-entry ramp LUTs (thermal/nightvision/infrared/risograph), luminance→ramp, intensity-blended.
- **UI**: `LeftRail.tsx` (7 menu items + tabler icons), `PropertiesPanel.tsx` (`EFFECT_LABEL` + `SECTION_ICONS` + 4 param `Accordion` blocks), `Timeline.tsx` (`EFFECT_BAR_LABEL`).
- Export inherits everything for free — `exportWorker.ts` / `ffmpegExport.ts` already pass `resolveEffects(...)` into `renderFrame`, and all techniques (getImageData, blend modes, gradients, patterns) run in `OffscreenCanvas`.

[2026-07-25] Fixed gradient-map perf near-freeze. Rerouted the per-pixel branch through a CPU-backed `willReadFrequently` buffer (`getPixelBuffer`) so `getImageData` no longer stalls the GPU main canvas each frame. `npx tsc -b` green.
- Files modified: `src/lib/renderer.ts`.

[2026-07-25] **Removed gradient map** — even with the `willReadFrequently` buffer it was still unacceptably laggy in preview (the GPU↔CPU round trip + ~2M-px JS loop per frame just can't hold 60fps at 1080p). Per-pixel effects are the wrong fit for Canvas 2D; deferred all of Category C to a future WebGL effect pipeline. Documented in spec D3 + "Future: WebGL effect pipeline". Kept the 6 shipping effects (hue/contrast/bleach/lightleak/chromatic/pixelate), all of which are CSS-filter or blend/overlay (no readback). `npx tsc -b` green.
- Files modified: `src/types.ts`, `src/lib/renderer.ts`, `src/lib/effects.ts`, `src/components/LeftRail.tsx`, `src/components/PropertiesPanel.tsx`, `src/components/Timeline.tsx`. Deleted: `src/lib/effectPixels.ts`. Spec updated: `SPECS/24-more-effects.md`.

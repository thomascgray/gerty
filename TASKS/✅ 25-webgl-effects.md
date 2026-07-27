# 25 — WebGL Effect Pipeline

**Status**: Complete

## Overview

Build a WebGL fragment-shader post-process pipeline so per-pixel video effects (gradient map, posterize, etc.) — which were too slow on Canvas 2D (spec 24 D3) — become cheap GPU passes. Must keep combining/stacking effects, and text/video/photos rendering underneath. **Hybrid**: existing 6 Canvas-2D effects stay as-is; WebGL is added only for new shader effects, applied after the 2D effects.

Full spec: [SPECS/25-webgl-effects.md](../SPECS/25-webgl-effects.md).

## Task Context

**Locked decisions:** D1 hybrid pipeline; D2 use **regl** (declarative WebGL wrapper, ~30kb) with WebGL1-class GLSL.

**Core design (minimal blast radius):** the Canvas-2D object loop is untouched. WebGL is a post-process:
```
object loop → 2D canvas (unchanged: photos/video/text/shapes + camera)
  → existing 2D effects (ctx.filter grades + blend overlays) [unchanged]
  → upload 2D canvas → regl texture → ping-pong shader passes → drawImage(glCanvas) back onto 2D ctx
```
No getImageData/readPixels. All 4 render paths read the frame from the **same 2D canvas** after `renderFrame`, so drawing the GL result back into that canvas means ZERO downstream changes:
- Preview: `useCanvasRenderer.ts:47` (canvas displayed)
- Export WebCodecs main: `ffmpegExport.ts:367` → `new VideoFrame(canvas)` L373
- Export MediaRecorder: `ffmpegExport.ts:671` → `canvas.captureStream(0)` L673
- Export worker: `exportWorker.ts:176` → `new VideoFrame(canvas)` L182

**Where the code goes:**
- New module `src/lib/glEffects.ts` — regl processor: `applyShaderEffects(srcCanvas, shaderFx, globalTime, {w,h}) → glCanvas | null`. Module-scoped lazy init (like grain tile/scratch canvases in renderer.ts). `createREGL({ gl })` over an OffscreenCanvas so main + worker share the path. Per-kind draw commands cached in a registry.
- `src/lib/renderer.ts` — add effect branch (c) after (a) filter + (b) overlays: if any shader effects active, call `applyShaderEffects`, drawImage result back with `globalCompositeOperation='copy'`.
- `src/lib/effects.ts` — `resolveEffects` passthrough for new params (unchanged envelope model).
- `src/types.ts` — extend `VideoEffectKind` with shader kinds; re-add `GradientMapParams`/`GradientMapPreset` + others; additive optional fields on `VideoEffect`/`ResolvedEffect`.
- UI (reuse spec-24 plumbing wholesale): `LeftRail.tsx` menu, `PropertiesPanel.tsx` `EFFECT_LABEL`/`SECTION_ICONS`/`EffectEditor` param blocks, `Timeline.tsx` `EFFECT_BAR_LABEL`, `types.ts` `createVideoEffect` seeds.

**Hard rules:**
- Additive: no shader effects ⇒ WebGL block skipped ⇒ pixel-identical output. Verify `npx tsc -b` (only typecheck gate).
- No browser automation — user tests in browser; Claude does static checks + hands a checklist.
- Determinism: animated shaders derive motion from a `globalTime` uniform, never GPU randomness.
- `renderFrame` stays SYNC — regl used imperatively (no `regl.frame()`).

**Top correctness risk (R8):** colour/alpha round-trip. WebGL premultiplied-alpha + sRGB can shift colours on upload/draw-back. Frame bg is opaque black so alpha=1 everywhere (low risk), but MUST validate an identity pass is visually indistinguishable + intensity-0 = no change BEFORE building real shaders.

**Fallback (R9):** `applyShaderEffects` returns `null` if regl/WebGL unavailable or context lost → renderer skips draw-back → 2D frame still shows. Never throw from the hot path.

**Deps:** regl not yet installed. `npm i regl` (+ types — regl ships its own types). Current deps: tabler-icons, jszip, motion, mp4-muxer, mp4box, react 19, tailwind 4.

## Blockers/Issues

None yet. Two bring-up gates before real shaders: (1) regl over OffscreenCanvas WebGL context works in `exportWorker.ts`; (2) identity-pass colour round-trip validated.

## TODO

[X] Install `regl` dependency (2.1.1, bundled types)
[X] **Scaffold `glEffects.ts`** — regl context (OffscreenCanvas), fullscreen-triangle, ping-pong framebuffers, `applyShaderEffects` + null fallback + context-loss handling
[X] **Wire branch (c)** into `renderer.ts` (skip when no shader effects; drawImage back with 'copy')
[X] **Types** — `gradientmap` kind + `GradientMapParams`/`GradientMapPreset` re-added; additive fields on VideoEffect/ResolvedEffect; `createVideoEffect` seed; resolver passthrough
[X] **Port `gradientmap`** — frag shader (4 ramps) + registry entry
[X] **UI** for gradientmap (LeftRail, PropertiesPanel editor, Timeline label) — reused spec-24 plumbing
[X] `npx tsc -b` + `vite build` green (regl bundles into main + worker chunks)
[ ] **USER browser verification** (checklist handed over):
  [ ] R8 identity: gradientmap at 0% intensity = no visible change; not vertically mirrored
  [ ] gradientmap renders, all 4 ramps work, smooth at 1080p (the spec-24 perf failure now works)
  [ ] text/video/photos render underneath; camera zoom still applies
  [ ] stacking: gradientmap + a 2D effect (e.g. vignette) compose
  [ ] preview == export (main-thread export); worker export path if active
  [ ] fallback: no crash if WebGL unavailable
[X] gradientmap pipeline — **USER confirmed works perfectly incl export** (2026-07-25)
[X] Add remaining per-pixel kinds (posterize/threshold/channelswap/colorisolate/dither) — shaders + types + UI; `tsc -b` + `vite build` green
[ ] USER browser verification of the 5 new shaders
[ ] Update `no-per-pixel-canvas2d-effects` memory once shipped (per-pixel viable via shaders, still not via Canvas-2D getImageData)

## Work Log

[2026-07-25] Task created. Scope + decisions per spec 25 (hybrid, regl). regl not yet installed.

[2026-07-25] Built the WebGL pipeline + ported gradientmap as the first shader. `npx tsc -b` + `vite build` green.
- Installed `regl@2.1.1` (bundled types). 2 pre-existing high audit warnings (postcss/brace-expansion, transitive dev deps) — unrelated, left alone.
- **New module `src/lib/glEffects.ts`**: module-scoped regl over an OffscreenCanvas WebGL1 context (`premultipliedAlpha:false`, `preserveDrawingBuffer:true`); fullscreen-triangle; two ping-pong framebuffers (texA/texB) + a src texture (flipY); lazy per-kind draw-command registry; `applyShaderEffects(srcCanvas, shaderFx, globalTime, size) → glCanvas | null`; graceful fallback (returns null on init fail / context loss, `unavailable`/`contextLost` flags, `on('lost'/'restore')`). Exports `SHADER_EFFECT_KINDS`/`isShaderEffect`. First shader: gradientmap (4 ramps thermal/nightvision/infrared/risograph selected by uPreset; `mix(src, mapped, uIntensity)`).
- Verified regl is worker-safe (raf→setTimeout fallback, `typeof window` guard on devicePixelRatio, DOM paths only for selector/container input — we pass a raw gl context). regl imports the default via `import createREGL from 'regl'`; regl types derived via `ReturnType<>` to avoid `export =`/verbatimModuleSyntax friction. OffscreenCanvas cast for texture `data` (regl's types omit it; fine at runtime).
- **`renderer.ts`**: added effect branch (c) after (a) filter + (b) overlays — filters `fx` to shader kinds, `applyShaderEffects`, drawImage(glCanvas) back with `globalCompositeOperation='copy'`. Skipped entirely when no shader effects (additive/pixel-identical guarantee holds).
- **`types.ts`**: `gradientmap` kind + `GradientMapParams`/`GradientMapPreset`; additive `gradientmap?` on VideoEffect + ResolvedEffect; `createVideoEffect` seed (thermal).
- **`effects.ts`**: `resolveEffects` passthrough; `gradientmap` added to `effectsToFilterString` no-op list.
- **UI**: LeftRail menu item (IconGradienter), PropertiesPanel `EFFECT_LABEL`/`SECTION_ICONS`/`EffectEditor` ramp dropdown, Timeline `EFFECT_BAR_LABEL`.
- Files: `src/lib/glEffects.ts` (new), `src/lib/renderer.ts`, `src/lib/effects.ts`, `src/types.ts`, `src/components/LeftRail.tsx`, `src/components/PropertiesPanel.tsx`, `src/components/Timeline.tsx`, `package.json`. Awaiting user browser verification before adding the other per-pixel shaders.

[2026-07-25] User confirmed gradientmap works perfectly incl export. Added the 5 remaining per-pixel shaders on the same pipeline. `npx tsc -b` + `vite build` green.
- **`glEffects.ts`**: `SHADER_EFFECT_KINDS` now 6; new frag shaders posterize / threshold(duotone) / channelswap / colorisolate (rgb2hsv + hue-distance keep) / dither (recursive Bayer4 + N-level quantize, `gl_FragCoord`-based cells). Broadened `EffectDef.props` to `number | number[]`; added `hexToRgb01` + `CHANNELSWAP_INDEX` + `fromProp` helper; registry entries pass vec3 colour uniforms for duotone.
- **`types.ts`**: 5 kinds + `PosterizeParams`/`ThresholdParams`/`ChannelSwapParams`(+`ChannelSwapMapping`)/`ColorIsolateParams`/`DitherParams`; additive fields on VideoEffect + ResolvedEffect; `createVideoEffect` seeds.
- **`effects.ts`**: resolver passthrough + filter no-op list for the 5 kinds.
- **UI**: LeftRail 5 items (IconStack2/CircleHalf2/ArrowsExchange/ColorPicker/GridPattern), PropertiesPanel labels + section icons + 5 `EffectEditor` param blocks (posterize levels; duotone dark/light/split; channelswap mapping; colorisolate hue/tolerance; dither levels/cell), Timeline bar labels.
- Files: `src/lib/glEffects.ts`, `src/types.ts`, `src/lib/effects.ts`, `src/components/LeftRail.tsx`, `src/components/PropertiesPanel.tsx`, `src/components/Timeline.tsx`.

[2026-07-25] Colour Isolate now uses a native colour-picker swatch (hue↔hex helpers) instead of a bare 0–360° slider — matches Duotone/Light-leak colour inputs. (Channel swap has no colour; Hue-shift "Angle" is a rotation amount, both unchanged.) `tsc -b` green. File: `src/components/PropertiesPanel.tsx`.

[2026-07-25] Batch 2: **CRT, VHS, Halftone, Comic ink** — the "now feasible thanks to WebGL" looks (incl. barrel distortion, the Canvas-2D dealbreaker). `tsc -b` + `vite build` green.
- **Pipeline**: threaded `globalTime` → a `uTime` uniform (animated shaders) + a `uResolution` uniform from the regl viewport (pixel-space / neighbour sampling). Added `uTime`/`uResolution` uniform helpers; both opt-in per shader via `extraUniforms` (avoids regl unused-uniform issues). `applyShaderEffects` now passes `time: globalTime` per draw. Animation is deterministic from globalTime ⇒ preview==export.
- **Shaders** (`glEffects.ts`): CRT (barrel-distort UV + scanlines + RGB phosphor mask + flicker; out-of-frame = black bezel), VHS (chroma bleed via offset R/B samples + per-line wobble + scrolling tracking-noise band + mild desat; hash-based noise keyed on row+floor(time)), Halftone (rotatable dot screen, radius ∝ 1-luminance), Comic ink (3×3 Sobel over a posterized base → dark ink lines). All `mix(src, effect, uIntensity)`.
- **Types**: 4 kinds + `CrtParams`/`VhsParams`/`HalftoneParams`/`ComicParams`; additive fields; seeds.
- **effects.ts**: passthrough + filter no-op.
- **UI**: LeftRail (IconDeviceTv/DeviceTvOld/Circles/Brush), PropertiesPanel labels + section icons + 4 editor blocks (CRT curvature/scanlines; VHS bleed/tracking; halftone dot-size/angle; comic colours/ink), Timeline labels.
- Files: `src/lib/glEffects.ts`, `src/types.ts`, `src/lib/effects.ts`, `src/components/LeftRail.tsx`, `src/components/PropertiesPanel.tsx`, `src/components/Timeline.tsx`.

[2026-07-25] CRT + VHS tuning from user feedback. `tsc -b` + `vite build` green.
- **CRT ghosting fix**: the `mix(src, crt, intensity)` crossfade doubled a barrel-distorted image over the undistorted source at partial intensity. Replaced with **param-scaling** — intensity now scales curvature/scanline/mask/flicker/zoom so it fades to a clean identity at 0 (no ghost), full at 1. Added a **Zoom** param (`CrtParams.zoom`) scaling the image toward centre before barrel distortion to crop out the black bezel; new Zoom slider in the CRT panel.
- **VHS lines**: replaced the single scrolling band with MANY randomised flickering tracking lines (scattered row subset via hash+step, extra per-line horizontal shift + bright/dark streaks) + the wide scrolling band + subtle global grain. Reads far more organic.
- Files: `src/lib/glEffects.ts`, `src/types.ts`, `src/components/PropertiesPanel.tsx`.

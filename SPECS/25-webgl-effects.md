# 25 — WebGL Effect Pipeline

## Overview

Spec 24 established that **per-pixel video effects are not viable on Canvas 2D**: a `getImageData`/`putImageData` readback every frame (even via a `willReadFrequently` buffer) can't hold 60fps at 1080p — the GPU↔CPU round trip plus a ~2M-pixel JS loop stalls the app. `gradientmap` was built, measured, and removed for exactly this reason (see [SPECS/24-more-effects.md](24-more-effects.md) decision D3).

This spec designs the **WebGL fragment-shader effect pipeline** that is the correct home for per-pixel effects. A shader runs the per-pixel math **on the GPU with no readback**, turning gradient map, posterize, threshold/duotone, channel swap, colour isolation, dither, Sobel/comic-ink, and eventually geometric warps (barrel distortion) into ~20-line passes that compose cheaply.

**The governing design goal is minimal blast radius.** The object compositing loop (photos, video, text, shapes, camera transform) stays **100% on Canvas 2D and unchanged**. WebGL is inserted as a **post-process over the already-composited frame** — exactly where the spec-23/24 effects already live. This preserves, by construction:

> **Locked decisions (from spec discussion):**
> - **D1 — Hybrid pipeline.** Keep the 6 existing spec-23/24 effects on Canvas 2D; add WebGL only for new per-pixel shader effects. Shader effects apply *after* all 2D effects (ordering caveat accepted). Full migration of the 2D effects to shaders is explicitly out of scope for v1.
> - **D2 — Use `regl` (new dependency).** A declarative WebGL wrapper purpose-built for fullscreen-quad + framebuffer-ping-pong post-processing. It removes the hand-rolled GL boilerplate, works with an `OffscreenCanvas` context (so the export worker is covered), and we write simple WebGL1-class GLSL for the broadest support. Three.js was rejected (3D scene-graph, ~150kb, overkill); twgl is a viable thinner alternative but regl fits this exact pattern best.

- **Text / video / photos playing underneath the effects** — they're composited first; shaders operate on the finished frame as a texture.
- **Combining / stacking effects** — shader passes ping-pong through FBOs, each reading the previous result; strictly *more* composable than the current model.
- **Preview == export** — the same WebGL code runs in the preview and both export paths.

## The key architectural fact (why this is low-risk)

Every render path passes a **Canvas 2D context** to `renderFrame`, and then reads the result **from that same 2D canvas**:

| Path | File | Reads frame via |
|---|---|---|
| Preview | `useCanvasRenderer.ts:47` | canvas is displayed |
| Export (WebCodecs, main) | `ffmpegExport.ts:367` | `new VideoFrame(canvas, …)` (L373) |
| Export (MediaRecorder) | `ffmpegExport.ts:~760` | `canvas.captureStream(0)` (L673) |
| Export (worker) | `exportWorker.ts:176` | `new VideoFrame(canvas, …)` (L182) |

So if the WebGL stage **draws its result back into the same 2D canvas**, *nothing downstream changes* — no call-site edits, no export changes, no `VideoFrame` changes, the overlay canvas and hit-testing are untouched. The WebGL processor is an internal detail of `renderFrame`'s effect block.

**Per-frame flow when shader effects are active:**
```
[object loop → 2D canvas]  (unchanged: photos/video/text/shapes + camera)
      → [existing 2D effects: ctx.filter grades + blend overlays]  (unchanged, spec 23/24)
      → upload 2D canvas as a GL texture (texImage2D — GPU-side, no readback)
      → ping-pong shader passes (one FBO per active shader effect, in resolved order)
      → drawImage(glCanvas) back onto the 2D ctx with 'copy'  (GPU→GPU, no readback)
```
No `getImageData` anywhere. The only per-frame costs are one texture upload + N shader passes + one draw-back — all GPU-side.

**Additive guarantee (same as spec 23/24):** when no shader effects are active, the WebGL block is skipped entirely ⇒ output is **pixel-identical** to today.

## Requirements

1. **R1 — Objects render unchanged.** The Canvas-2D object loop (incl. camera transform) is not touched. Shaders are a post-process only. Text, video, photos, shapes, and their animations/keyframes/transitions all render exactly as now, underneath the effects.
2. **R2 — Draw back to the 2D canvas.** The WebGL result is composited back into the same 2D context `renderFrame` received, so all four render/export paths work with zero changes.
3. **R3 — No readback.** No `getImageData`/`readPixels` on the hot path. Texture upload via `texImage2D(…, canvas)` and draw-back via `drawImage(glCanvas)` only.
4. **R4 — Stacking / ordering.** Multiple shader effects compose via FBO ping-pong in `resolveEffects` order (startTime, then id). Adding N shader effects = N passes.
5. **R5 — Worker + main-thread parity.** The pipeline runs in the export **worker** (`OffscreenCanvas` + WebGL2) and on the **main thread** identically, so preview == export.
6. **R6 — Envelope/resolver reuse.** No change to the spec-23 `VideoEffect` model, CRUD actions, timeline track, or `resolveEffects`. A shader effect is still `{intensity, envelope, params}`; `intensity` and params become shader **uniforms**.
7. **R7 — Additive / back-compat.** No shader effects ⇒ WebGL untouched ⇒ pixel-identical output. Projects with only spec-23/24 effects are unaffected.
8. **R8 — Colour fidelity.** An identity shader (or intensity 0) must round-trip the frame with **no visible colour/alpha shift** (premultiplied-alpha + sRGB handling correct). This is the top correctness risk — see Technical Considerations.
9. **R9 — Graceful absence.** If WebGL2 is unavailable (or the context is lost and can't be restored), shader effects are **skipped** (frame still renders via the 2D path); the app never crashes or blanks.
10. **R10 — Use `regl`** (decision D2) for the GL boilerplate: context, programs, textures, framebuffer ping-pong. ~30kb gzip, acceptable for a client-side editor that already ships WebCodecs/mp4-muxer/motion. Rejected: Three.js (3D, too heavy); hand-rolled raw WebGL (more boilerplate for no benefit).
11. **R11 — Determinism.** Any animated shader derives motion from a `globalTime` uniform (never GPU-side randomness that varies per call), mirroring the grain/oldfilm/lightleak rule, so a given time renders identically every call.

## Technical Considerations

### Current effect application (post spec-24) — `src/lib/renderer.ts`

After the object loop, `renderFrame` runs the effect block when `editorOptions.effects` is non-empty:
- **(a) colour-grade branch:** `effectsToFilterString(fx, globalTime)` → one `ctx.filter` string → self-composited redraw (`globalCompositeOperation='copy'`).
- **(b) overlay branch:** per-kind `draw*` fns (`drawVignette`, `drawGrain`, `drawOldFilm`, `drawChromatic`, `drawPixelate`, `drawLightLeak`) using blend modes / gradients / cached tiles / deterministic time-seeded PRNGs.

The WebGL stage becomes a **third branch (c)**, running after (a)+(b) over their combined result.

### Relevant existing types — `src/types.ts`

```ts
export type VideoEffectKind =
  | 'grayscale' | 'sepia' | 'invert' | 'vignette' | 'grain' | 'oldfilm'
  | 'hue' | 'contrast' | 'bleach'          // Tier 1 CSS filter
  | 'lightleak' | 'chromatic' | 'pixelate' // Tier 2 blend/overlay

export type VideoEffect = {
  id: string; kind: VideoEffectKind; intensity: number
  startTime: number; transitionIn: number; hold: number; transitionOut: number
  easing: EasingKind
  vignette?: VignetteParams; oldfilm?: OldFilmParams
  hue?: HueParams; lightleak?: LightLeakParams; chromatic?: ChromaticParams
  hidden?: boolean
}
export type ResolvedEffect = { kind: VideoEffectKind; intensity: number; /* …payloads… */ }
```
`resolveEffects(effects, globalTime): ResolvedEffect[]` (in `effects.ts`) is unchanged by this spec — it already produces the eased `intensity` + params the shaders need as uniforms.

### New types to add

```ts
// The subset of kinds implemented as GLSL passes (re-introduces gradientmap + friends).
export type ShaderEffectKind =
  | 'gradientmap' | 'posterize' | 'threshold' | 'channelswap' | 'colorisolate' | 'dither'
// (extend VideoEffectKind with these)

// Re-added per-kind params (removed in spec 24 when gradientmap was pulled):
export type GradientMapPreset = 'thermal' | 'nightvision' | 'infrared' | 'risograph'
export type GradientMapParams = { preset: GradientMapPreset }
export type PosterizeParams   = { levels: number }
export type ThresholdParams   = { dark: string; light: string; threshold: number }
export type ChannelSwapParams = { mapping: 'rbg'|'grb'|'brg'|'bgr'|'gbr' }
export type ColorIsolateParams= { hue: number; tolerance: number }
export type DitherParams      = { scale: number }
// + optional fields on VideoEffect / ResolvedEffect (additive, per spec-24 decision D1)
```

### The WebGL processor — new module `src/lib/glEffects.ts` (regl-based)

A self-contained regl post-processor, lazily initialised and cached at module scope (like the grain tile / scratch canvases in `renderer.ts`). Public surface (sketch — no code written this session):

- `applyShaderEffects(srcCanvas, shaderFx, globalTime, {width,height}) → glCanvas | null` — uploads `srcCanvas` to a regl texture, runs each effect's draw command via framebuffer ping-pong, returns the regl canvas (or `null` if regl/WebGL is unavailable or the context is lost, so the caller skips the draw-back).
- Internals:
  - one `OffscreenCanvas`, its WebGL context handed to `createREGL({ gl })` (so the same code path works on the main thread and in the export worker);
  - a regl **texture** re-populated each frame from `srcCanvas` (`texture({ data: srcCanvas })` / `subimage`) — regl handles the `texImage2D` upload;
  - two regl **framebuffers** for ping-pong, resized with the frame;
  - a **command registry** `Record<ShaderEffectKind, regl.DrawCommand>` — each is a full-screen-triangle draw with that kind's `frag` shader and a `uniforms` block reading `uIntensity` + per-kind params from `this`/props; commands are built lazily and cached (regl compiles/caches the program).
- Called from `renderer.ts` branch (c): `const gl = applyShaderEffects(ctx.canvas, shaderFx, globalTime, {w,h}); if (gl) { ctx.save(); ctx.filter='none'; ctx.globalCompositeOperation='copy'; ctx.drawImage(gl, 0, 0); ctx.restore() }`.

Shaders are tiny: a shared full-screen-triangle vertex shader + a per-kind fragment shader sampling the source texture, using `uIntensity` + per-kind uniforms, mixing toward the original by intensity for the envelope fade (`mix(src, effect, uIntensity)`). GLSL is written to WebGL1 (`precision mediump float; varying vec2 uv; texture2D(...)`) so regl runs it on either GL version.

**regl usage mode:** imperative, not regl's RAF loop. We create the context once and invoke draw commands synchronously inside `renderFrame` (which stays sync). regl's `{ gl }` constructor form + manual command calls support this; we never call `regl.frame()`.

### Coexistence & ordering with the existing 2D effects (Open Q1)

- **Recommended v1 (hybrid):** existing 2D effects (a)+(b) run first exactly as now; the WebGL pass runs over their combined result. Consequence: **shader effects always apply after all 2D effects**, regardless of authored order — the same class of compose-order caveat already accepted in spec 24 (Open Q3). Acceptable because shader effects are per-pixel colour ops that read fine on a graded frame.
- **Future (full migration):** port the 6 existing effects to shaders too, giving one unified, fully-ordered pass pipeline. Higher risk (re-implementing working, deterministic effects incl. grain/oldfilm time-seeding) — deferred, not v1.

### Correctness risks

- **Colour/alpha round-trip (R8).** WebGL premultiplied alpha + sRGB can shift colours on upload/draw-back. The frame background is opaque black (`renderFrame` fills black first), so alpha is 1 everywhere → premultiply risk is minimal, but must still: set `UNPACK_PREMULTIPLY_ALPHA_WEBGL` correctly, render without unwanted blending, and verify an identity pass is byte-stable (or visually indistinguishable). **Must be validated before building real effects.**
- **Worker WebGL2.** WebGL2 in `OffscreenCanvas` workers is broadly supported (Chrome/Edge/Firefox); Safari lagged historically. The app targets WebCodecs-capable browsers already (spec 08), which overlaps well. Fallback R9 covers the gap.
- **Context loss.** Handle `webglcontextlost`/`restored`; on loss, rebuild programs lazily or skip shader effects until restored (R9). Never throw from the render hot path.
- **Two contexts.** Preview (main thread) and export (worker) each hold their own module-scoped GL context — expected and fine (separate threads/module instances).
- **Precision/parity.** Preview and export run the same GLSL on (almost certainly) the same GPU on the user's machine ⇒ identical output. Cross-machine float deltas are irrelevant (each render is self-consistent). Note but don't over-engineer.
- **Sync contract.** All WebGL calls used here (`texImage2D` from canvas, `drawArrays`, `drawImage` back) are synchronous, so `renderFrame` stays a sync function — no async refactor.

### Performance

- Per active shader effect: one fullscreen-quad draw (2 triangles) sampling one texture — trivially GPU-bound; dozens compose in real time.
- Fixed per-frame overhead only when ≥1 shader effect active: one `texImage2D(canvas)` upload + one `drawImage(glCanvas)` back. Both GPU-side, sub-millisecond at 1080p. This is the entire point vs the Canvas-2D readback.
- No overhead when no shader effects are active (branch skipped).

## Related Systems and Tasks

- [SPECS/24-more-effects.md](24-more-effects.md) — decision **D3** ("Category C deferred pending WebGL") and the **"Future: WebGL effect pipeline"** section this spec fulfils; the feasibility triage of every per-pixel effect.
- [SPECS/23-more-effects.md](23-more-effects.md) — the `VideoEffect` envelope/resolver/track model reused wholesale.
- [TASKS/✅ 24-more-effects.md](../TASKS/✅%2024-more-effects.md) — the build→measure→remove record for `gradientmap` (the effect to port first as the pipeline's proof).
- Memory: `no-per-pixel-canvas2d-effects` — the constraint this spec lifts.
- `src/lib/renderer.ts` (shared compositor, effect branches), `src/lib/effects.ts` (`resolveEffects`), `src/lib/exportWorker.ts` + `src/lib/ffmpegExport.ts` (the export render loops), `src/hooks/useCanvasRenderer.ts` (preview loop), `src/components/Canvas.tsx` (render + overlay canvases).

## Open Questions

- ~~**Q1 — Hybrid vs full migration.**~~ **RESOLVED → hybrid** (decision D1).
- ~~**Q2 — WebGL2 vs WebGL1 / raw vs library.**~~ **RESOLVED → `regl` with WebGL1-class GLSL** (decision D2). regl abstracts the GL version; WebGL1 shaders maximise compatibility.

Remaining:
1. **First shader effect(s).** Recommendation: port **gradientmap** first (proves the pipeline end-to-end, and it's the one users already saw removed), then posterize / threshold / channelswap / colorisolate / dither as cheap follow-ons.
2. **Should `chromatic`/`pixelate` (currently Canvas-2D) move to shaders?** They work today; leave them until/unless full migration. VHS/CRT bundles (which want chroma-bleed + barrel distortion) may later justify moving them.
3. **Identity-pass validation gate.** Byte-exact identity round-trip, or "visually indistinguishable"? Recommendation: visually indistinguishable + intensity-0 shows no change; make this an explicit acceptance test before any real shader ships.
4. **regl + OffscreenCanvas-in-worker bring-up.** Low-risk but unverified in *this* codebase's export worker — confirm `createREGL({ gl })` over an `OffscreenCanvas` WebGL context works in `exportWorker.ts` during the first implementation step (fallback R9 covers failure).

## Acceptance Criteria

- A per-pixel effect (gradient map) runs as a GLSL pass and is **smooth in preview at 1080p** (the spec-24 failure case now performs).
- **Text, video, and photos render underneath** the shader effect, animating normally; the camera zoom still applies (shader sees the post-camera frame).
- **Stacking:** two+ shader effects compose in resolved order; adding one doesn't disturb the others.
- **Preview == export:** the exported MP4 shows the identical shader result at the same time (worker WebGL path), including with 2D effects also active.
- **Additive:** a project with no shader effects is **pixel-identical** to pre-spec-25 output; a project mixing 2D + shader effects composites correctly.
- **Identity fidelity (R8):** an intensity-0 shader effect produces no visible colour/alpha change.
- **Graceful absence (R9):** with WebGL forced off / context lost, the frame still renders (shader effects skipped), no crash/blank.
- `npx tsc -b` green.

## Implementation Notes

- **Build order:** (1) `glEffects.ts` scaffold — GL2 context, fullscreen quad, FBO ping-pong, identity pass; **validate R8 colour round-trip first**. (2) Wire branch (c) into `renderer.ts` behind an "any shader effects active?" check. (3) Port `gradientmap` (re-add its types + a `gradientmap` fragment shader + `EFFECT_LABEL`/LeftRail/Timeline entries — the same 6 UI touch-points as spec 24). (4) Add the remaining per-pixel kinds as fragment shaders + param editors.
- **Reuse spec-24 UI plumbing wholesale** — `createVideoEffect` seeding, `EFFECT_LABEL`, `EFFECT_BAR_LABEL`, LeftRail menu, `EffectEditor` param blocks. Only the *apply* mechanism differs.
- **Determinism:** pass `globalTime` as a uniform; no GPU randomness. Cache compiled programs; never compile in the hot loop.
- **Worker:** `exportWorker.ts` gets its own `glEffects` module instance automatically (separate bundle/thread); confirm `OffscreenCanvas.getContext('webgl2')` there during bring-up.
- **Fallback:** `applyShaderEffects` returns `null` when GL is unavailable/lost; the renderer simply skips the draw-back, leaving the 2D-composited frame intact.
- Keep the `no-per-pixel-canvas2d-effects` memory but update it once this ships (per-pixel is viable *via shaders*, still not via Canvas-2D `getImageData`).

---
*This specification is ready for implementation. Use `/task 25-webgl-effects` to begin development.* The two load-bearing decisions are locked (D1 hybrid, D2 regl); the remaining open questions have sensible defaults and can be settled during the first implementation step (regl worker bring-up + identity-pass validation gate the real shader work).

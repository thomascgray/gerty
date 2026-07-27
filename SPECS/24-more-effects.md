# 24 — More Video Effects

## Overview

Spec 23 shipped the render-wide **video effect** system: a project-level list of `VideoEffect`s, each with an intensity envelope (ease-in → hold → ease-out), applied as a full-frame post-process inside the shared `renderFrame` so preview and export match by construction. Six kinds exist today: `grayscale | sepia | invert | vignette | grain | oldfilm`.

This spec evaluates a large wishlist of **additional** effects (analogue film, colour grades, glitch/digital, comic) and specs what it would take to add the feasible ones. The wishlist was drafted assuming a **GLSL/WebGL shader pipeline** ("build them as GLSL passes over the canvas texture"). **That premise does not hold here** — this editor renders on **Canvas 2D**, not WebGL. The whole feasibility question therefore reduces to: *what can each effect be expressed as, using only the Canvas 2D primitives this codebase already relies on?*

The good news: the spec-23 architecture is a clean extension point. Adding an effect is ~6 small, mechanical touch-points (below). The real cost per effect is the **render technique**, not the plumbing — so this spec is organised around technique categories and a build order, not a flat feature list.

> **Scope note:** This is a menu, not a mandate. The recommended build set (Tier 1–2, plus the gradient-map pass) delivers ~80% of the visual range for a fraction of the effort. Tiers 3–4 and the "Deferred" list are specced enough to decide, not necessarily to build all of.

## The one constraint that governs everything: Canvas 2D, not WebGL

`renderFrame` (`src/lib/renderer.ts`) is a **pure Canvas-2D function of `globalTime`**. Effects run as a post-process after the object loop in one of two existing branches:

- **(a) Colour-grade branch** — `effectsToFilterString(fx)` builds one CSS `ctx.filter` string (e.g. `grayscale(0.8) invert(1)`), then a self-composite redraw (`globalCompositeOperation='copy'; drawImage(ctx.canvas,0,0)`) bakes it in. One batched pass for all colour kinds.
- **(b) Overlay branch** — per-effect draw fns (`drawVignette`, `drawGrain`, `drawOldFilm`) composite gradients / noise tiles / procedural sprites on top, using blend modes (`overlay`, `source-over`) and time-seeded PRNGs.

Three hard rules fall out of this and constrain every new effect:

1. **No `Math.random`, ever.** Animated effects derive all jitter deterministically from `globalTime` (see `hashInt` / `mulberry32`, keyed on `Math.floor(time * FPS)`), so preview and export are frame-identical. Any new animated effect MUST do the same.
2. **No previous-frame feedback.** `renderFrame` is stateless per time — it can be called for any `globalTime` in any order (preview scrubbing seeks arbitrarily; export is sequential). Effects that need "the last rendered frame" (datamosh, true feedback trails) **break preview/export parity when scrubbing** and are out of scope for v1 (see Deferred).
3. **Must run in the OffscreenCanvas export worker.** SVG filters via `ctx.filter = url(#id)` and `feTurbulence` **do not work in the worker** (already documented in the grain code — that's why grain is synthesised on a canvas). So new effects may only use: CSS `filter` functions, blend modes, gradients/patterns, `drawImage` tricks, and raw `ImageData` (`get/putImageData`, which *is* available on OffscreenCanvas).

### The four technique categories (feasibility tiers)

| Cat | Technique | Cost | Perf | Examples |
|---|---|---|---|---|
| **A** | CSS `ctx.filter` colour grade — extend `effectsToFilterString` | Trivial (~1 line) | Free (GPU) | hue-rotate, contrast crush, bleach-bypass-lite, saturation |
| **B** | Overlay: gradient / blend-mode / cached pattern tile (like `drawGrain`) | Moderate | Cheap | light leak, scanlines/CRT, projector burn, halftone, tear bands |
| **C** | Per-pixel `getImageData` → transform → `putImageData` | — | **❌ Deferred (needs WebGL — see D3)** | gradient map / false colour, posterize, threshold/duotone, channel swap, colour isolation, dither |
| **D** | Geometric warp or frame-history — hard/architecturally awkward in Canvas 2D | High / blocked | — | barrel distortion, pixel sort, JPEG/DCT, **datamosh** |

**Category C introduces the one genuinely new piece of infrastructure**: a third effect branch that reads the composited frame with `getImageData`, transforms the pixel buffer, and writes it back. At 1920×1080 that's a 2.07M-pixel scan per effect per frame — fine for offline export, but a real cost for 60fps preview (see Performance). Everything in A, B, and D reuses machinery that already exists (or is impossible).

## Per-effect feasibility verdicts (the full wishlist)

### Analogue film
| Effect | Verdict | Cat | Notes |
|---|---|---|---|
| **Super 8 / 16mm** | ✅ Preset | B | Not a new primitive — it's `oldfilm` (grain + gate-weave + flicker + dust/hair already exist) + **halation** + a **tint** param. Ship as a tuned composite/preset once halation exists. |
| **Projector burn** | ✅ Feasible | B | Growing warm-edged radial "burn hole" (brown/black core, orange ring) via radial gradient with `multiply`/`screen`, radius driven by eased intensity. |
| **Light leak** | ✅✅ High value | B | Drifting orange/magenta gradient in `screen` blend. Params: colour, angle, speed (speed → time-driven drift). The single best analogue win for the effort. |
| **VHS** | ⚠️ Feasible-heavy | B(+C) | Composite: tracking-band + head-switch-hash overlays (easy), scanline **wobble** via row-slice `drawImage` (medium), chroma bleed via the RGB-split approximation (Tier 4). Build as a bundle after chromatic aberration lands. |
| **CRT** | ⚠️ Partial | B(+D) | Scanlines + RGB phosphor mask (cached pattern tile) = easy; **bloom** = medium (threshold+blur+screen); **barrel distortion** = Category D, hard in 2D. Ship "CRT-lite" (scanlines + phosphor + bloom), defer/omit barrel. |

### Colour
| Effect | Verdict | Cat | Notes |
|---|---|---|---|
| **Invert** | ✅ Exists | A | Shipped in spec 23. |
| **Hue rotation (+ animate)** | ✅✅ High value | A | `hue-rotate(Xdeg)`. Static = one filter term; animated psychedelic cycle = `deg = (time*speed) % 360`. Nearly free. |
| **Contrast crush** | ✅ Trivial | A | `contrast()` + `brightness()` terms. "Grimdark" preset = crush + slight desaturate. |
| **Bleach bypass** | ✅ Approx (A) / true (C) | A/C | Filter approximation (high `contrast` + low `saturate`) is convincing and free; true luminance-overlay bleach is a per-pixel pass if wanted. Ship the approximation. |
| **Posterize (levels)** | ✅ Feasible | C | No CSS posterize and SVG `feComponentTransfer` won't run in the worker → per-pixel channel quantise. `levels` param. |
| **Threshold / duotone** | ✅ Feasible | C | Per-pixel luminance threshold → map to two colours. Params: two colours + threshold. |
| **Channel swap** | ✅ Feasible | C | Per-pixel R/G/B permutation. `mapping` param (e.g. `'rbg'`). |
| **Colour isolation** | ✅ Feasible | C | Per-pixel: keep pixels within hue X ± tolerance, desaturate the rest. Params: hue, tolerance. |
| **Gradient map / false colour** | ✅✅ Best colour ROI | C | Per-pixel: luminance → ramp LUT. **One pass, infinite looks** — thermal / night-vision / infrared / risograph duotone are all just different ramps. Ship with a `preset` enum (+ optional custom stops later). |

### Glitch / digital
| Effect | Verdict | Cat | Notes |
|---|---|---|---|
| **RGB channel split** | ✅✅ Workhorse | B | Achievable **without** per-pixel: draw the frame 3× as pure-R/G/B tinted copies (`multiply` tint → `lighter`/`screen` recombine), each offset. Params: offset px, angle. Great for "punch on an impact" via a fast intensity envelope. |
| **Pixelate** | ✅ Trivial | B | Downscale then upscale with `imageSmoothingEnabled=false`. No per-pixel. Cell size = eased intensity (animates fine→chunky for free). |
| **Horizontal tear bands** | ✅ Feasible | B | Row-slice horizontal offsets, time-seeded band positions. Overlaps VHS scanline wobble. |
| **Block displacement** | ✅ Feasible | B | `drawImage` block-slices offset by time-seeded amounts. Medium. |
| **Dither (Bayer / Floyd-Steinberg)** | ✅ Feasible | C | Bayer (ordered) is a cheap per-pixel threshold-matrix; Floyd-Steinberg (error diffusion) is per-pixel serial (heavier). Ship Bayer. |
| **ASCII** | ⚠️ Novelty/heavy | C+B | Downsample to luminance grid → draw a glyph per cell. Feasible but niche and text-render-heavy. Low priority. |
| **Pixel sort** | ⚠️ Hard | D | Per-row threshold-span sort — heavy and fiddly. Feasible but low ROI; defer. |
| **JPEG / DCT artifacting** | ❌ Skip | D | Needs a real DCT. Fake it via pixelate + block edges if ever wanted. |
| **Datamosh / frame smear** | ❌ Blocked | D | Requires previous-frame feedback → **violates the stateless-per-time renderer** and breaks preview/export parity on scrub. Out of scope; see Deferred for a design note. |

### Comic
| Effect | Verdict | Cat | Notes |
|---|---|---|---|
| **Halftone** | ✅ High value/novelty | B | Downsample luminance → draw dots sized by local luminance on a rotatable screen angle. Params: cell size, angle, shape. |
| **Comic ink (Sobel)** | ⚠️ Feasible-heavy | C | Per-pixel 3×3 Sobel convolution over a posterized base. Heavy; combine with posterize + halftone for the full "Black Library" look. Medium-heavy. |

## Recommended build order

**Tier 1 — CSS-filter colour grades (ship first; zero new render branches).**
Extend only `effectsToFilterString` + add kinds/params/labels/menu items. Each is ~1 filter term.
- Hue rotate (static + animated cycle)
- Contrast crush
- Bleach bypass (filter approximation)
- (Optional) Saturation / vibrance

**Tier 2 — Overlay/blend effects (follow the `drawGrain`/`drawVignette` pattern).**
- **Light leak** (best value)
- **RGB channel split / chromatic aberration** (workhorse — unlocks VHS chroma bleed later)
- **Pixelate**
- Scanlines / CRT-lite (scanlines + phosphor + bloom)
- Projector burn
- Halftone

**Tier 3 — Per-pixel LUT/quantise — ❌ DEFERRED pending a WebGL pipeline (D3).** Attempted `gradientmap` on Canvas 2D; the per-frame readback is too slow for preview. Revisit all of these once shaders exist:
- **Gradient map / false colour** (best colour ROI)
- Posterize / levels
- Threshold / duotone
- Channel swap
- Colour isolation
- Bayer dither

**Tier 4 — Slice/composite glitch & bundles.**
- Horizontal tear bands, block displacement
- **VHS** bundle (tracking band + head-switch + scanline wobble + chroma bleed)
- Comic ink (Sobel)
- Super 8 / 16mm preset (oldfilm + halation + tint)

**Deferred / not v1:** barrel distortion (CRT), pixel sort, JPEG/DCT, ASCII, **datamosh** (architectural).

## Requirements

1. **R1 — Additive & back-compatible.** Every new kind is optional/additive on `Project.effects`; a project with none renders pixel-identically to today. New optional param fields on `VideoEffect` must not affect existing kinds.
2. **R2 — Deterministic animation.** Any time-varying effect derives all randomness/motion from `globalTime` (via `hashInt`/`mulberry32` or an arithmetic function of time). No `Math.random`; no previous-frame state.
3. **R3 — Worker-safe.** No SVG-URL filters, no `feTurbulence`. Only CSS filter functions, blend modes, gradients/patterns, `drawImage`, and `ImageData`. Verify each new effect runs in both the main-thread and OffscreenCanvas export paths.
4. **R4 — Envelope reuse.** Each kind maps the single eased `intensity` (0→peak→0) onto its natural quantity (filter amount / overlay alpha / pixelate cell size / chromatic offset / burn radius). Effects fade in/out for free; no per-effect keyframes in v1.
5. **R5 — Per-kind params where needed.** Effects needing more than intensity (hue speed, duotone colours, gradient-map preset, light-leak colour/angle/speed, chromatic offset/angle, halftone cell/angle) carry a typed param payload, threaded through `ResolvedEffect` to the renderer exactly as `vignette`/`oldfilm` are today.
6. **R6 — Category-C render branch.** Add a third effect branch that runs per-pixel effects in resolved (`startTime`, then `id`) order via `getImageData`/`putImageData`. Document its compose-order relationship to the batched colour-filter branch (see Open Q3).
7. **R7 — Full UI parity.** Each new kind appears in the LeftRail Effects menu (label + icon), the PropertiesPanel `EffectEditor` (kind label + any param controls), and the Timeline `EFFECT_BAR_LABEL`. Selection/CRUD/timeline-drag are already generic — no new wiring there.
8. **R8 — Performance budget.** Per-pixel (Category C) effects must stay usable in 60fps preview at 1080p, or degrade gracefully. See Performance / Open Q4.

## Technical Considerations

### Existing types (spec 23) — `src/types.ts`

```ts
export type VideoEffectKind = 'grayscale' | 'sepia' | 'invert' | 'vignette' | 'grain' | 'oldfilm'

export type VignetteShape = 'rectangle' | 'circle'
export type VignetteParams = { shape: VignetteShape; size: number; feather: number }
export type OldFilmParams  = { wobble: number }

export type VideoEffect = {
  id: string
  kind: VideoEffectKind
  intensity: number      // 0–1 peak
  startTime: number
  transitionIn: number
  hold: number
  transitionOut: number
  easing: EasingKind
  vignette?: VignetteParams // present only when kind === 'vignette'
  oldfilm?: OldFilmParams   // present only when kind === 'oldfilm'
  hidden?: boolean
}

export type ResolvedEffect = {
  kind: VideoEffectKind; intensity: number
  vignette?: VignetteParams; oldfilm?: OldFilmParams
}
```

### Type changes needed

**1. Extend the kind union** (add kinds as they're built):
```ts
export type VideoEffectKind =
  | 'grayscale' | 'sepia' | 'invert' | 'vignette' | 'grain' | 'oldfilm'
  // Tier 1 (CSS filter):
  | 'hue' | 'contrast' | 'bleach'
  // Tier 2 (overlay):
  | 'lightleak' | 'chromatic' | 'pixelate' | 'scanlines' | 'projectorburn' | 'halftone'
  // Tier 3 (per-pixel):
  | 'gradientmap' | 'posterize' | 'threshold' | 'channelswap' | 'colorisolate' | 'dither'
```

**2. New param payload types** (only for kinds that need more than intensity):
```ts
export type HueParams          = { animate: boolean; speed: number } // deg/sec when animate
export type ContrastParams     = { amount: number }                  // or fold into intensity
export type LightLeakParams    = { color: string; angle: number; speed: number }
export type ChromaticParams    = { offset: number; angle: number }   // offset in px @ intensity 1
export type ScanlineParams     = { spacing: number; phosphor: boolean; bloom: number }
export type ProjectorBurnParams= { x: number; y: number }            // burn origin (normalized)
export type HalftoneParams     = { cell: number; angle: number; shape: 'dot' | 'line' }
export type GradientMapParams  = { preset: 'thermal'|'nightvision'|'infrared'|'risograph'|'custom'; stops?: string[] }
export type PosterizeParams    = { levels: number }
export type DuotoneParams      = { dark: string; light: string; threshold: number }
export type ChannelSwapParams  = { mapping: 'rbg'|'grb'|'grb'|'brg'|'bgr'|'gbr' }
export type ColorIsolateParams = { hue: number; tolerance: number }
```

**3. Params-on-`VideoEffect` — TWO options (Open Q1):**

- **(a) Additive optional fields** (matches spec 23's `vignette?`/`oldfilm?` exactly):
  ```ts
  export type VideoEffect = { /* …existing… */
    hue?: HueParams; lightleak?: LightLeakParams; chromatic?: ChromaticParams; /* …etc */ }
  ```
  Pro: identical to the shipped pattern, zero refactor. Con: `VideoEffect` grows ~12 optional fields; the panel's `effect.kind === 'x' && effect.x` narrowing gets repetitive.

- **(b) Discriminated `params` union** (cleaner as the count grows):
  ```ts
  export type VideoEffect = { /* …shared envelope… */
    params?: VignetteParams | OldFilmParams | HueParams | LightLeakParams | /* … */ }
  ```
  Requires migrating the two existing param'd kinds. Better type-narrowing, less field sprawl.

  **Recommendation:** stay with **(a)** for consistency with spec 23 and to keep this purely additive; revisit (b) only if the field count becomes unwieldy. `ResolvedEffect` carries whichever payloads through unchanged (it already carries `vignette`/`oldfilm`).

### Renderer changes — `src/lib/renderer.ts`

- **Category A (colour):** add cases to `effectsToFilterString` (`effects.ts`), e.g.
  `case 'hue': parts.push(\`hue-rotate(\${e.hue?.animate ? (time*e.hue.speed)%360 : e.hue.speed}deg)\`)` — note this needs `globalTime` passed into `effectsToFilterString` for animated hue, a small signature change. `contrast`/`bleach` are pure intensity→filter-term, no time.
- **Category B (overlay):** add `draw*` fns next to `drawGrain`/`drawVignette`, dispatched in the existing overlay loop. Reuse `getGrainTile`-style cached patterns (phosphor mask, halftone dots) and `mulberry32(hashInt(frame))` for any jitter. Chromatic split = 3 tinted `drawImage` composites, not per-pixel.
- **Category C (per-pixel):** NEW branch. After the colour-filter batch and before/after overlays (Open Q3), for each per-pixel effect in resolved order:
  ```
  const img = ctx.getImageData(0,0,w,h)
  transformPixels(img.data, e, intensity, globalTime)  // gradientmap/posterize/…
  ctx.putImageData(img, 0, 0)
  ```
  Keep the transform fns in a new `src/lib/effectPixels.ts` (pure, worker-safe, testable) to avoid bloating `renderer.ts`. A shared luminance helper + a gradient-ramp sampler cover most kinds.

### Resolver — `src/lib/effects.ts`

- `resolveEffects` already passes payloads through; extend the `active.push({...})` to carry the new payload field(s) (or the `params` union under Option (b)).
- `effectsToFilterString`: add the Category-A cases; thread `globalTime` for animated hue.
- Consider splitting resolved effects into `{ filterKinds, pixelKinds, overlayKinds }` helpers so the renderer's three branches each get their ordered slice.

### UI surfaces (all mechanical, per new kind)

1. **`LeftRail.tsx`** (~L101) — add a `{ label, Icon, onClick: () => onCreateEffect('kind') }` row. Icons from `@tabler/icons-react` (e.g. `IconColorFilter`, `IconAperture`, `IconWaveSine`, `IconGridDots`).
2. **`PropertiesPanel.tsx`** — add to `EFFECT_LABEL` (~L814); add a per-kind param `Accordion` block in `EffectEditor` (~L890) mirroring the vignette/oldfilm blocks (`updateTransient` on drag → `commit` on pointer-up).
3. **`Timeline.tsx`** — add to `EFFECT_BAR_LABEL` (~L56). Track layout / drag / selection are generic — no other changes.
4. **`types.ts`** — `createVideoEffect` seeds sensible per-kind params/intensity defaults (like the vignette/oldfilm seeding at L374-379).
5. **`App.tsx`** — `handleCreateEffect(kind)` is already generic; no change.

### Performance

- Category A/B are GPU-cheap (filters/blends/patterns) — negligible.
- Category C scans 2.07M px/effect/frame at 1080p. Export is offline (fine). Preview at 60fps: one per-pixel effect is borderline-OK on desktop; stacking several will drop frames. Mitigations: (i) most Category-C effects can run on a **downscaled** buffer then upscale (gradient map, dither, posterize tolerate it; halftone/pixelate *are* downscale); (ii) reuse a single `getImageData` when multiple per-pixel effects stack (read once, transform in sequence, write once); (iii) this compounds the existing "60Hz re-renders `App`→`Canvas`" gotcha (spec 09). Flag preview cost in the UI copy if needed.

## Related Systems and Tasks

- **`SPECS/23-more-effects.md`** — the effect system this extends (envelope model, resolver, renderer branches, UI wiring). This spec is a direct continuation.
- **`SPECS/13-camera-zoom.md`** — the envelope/resolver architecture effects mirror.
- **`SPECS/09-in-video-perf.md`** — the preview re-render / main-thread-export perf work; Category-C effects make preview cost more relevant, and worker-safety (R3) matters more once export moves fully to the worker.
- **`src/lib/renderer.ts`** — grain/oldfilm are the reference implementations for deterministic time-seeded overlays.
- **`src/lib/easing.ts`** — `ease`, `clamp01`, `lerp` reused for intensity.

## Decisions (resolved)

- **D1 — Param storage: additive optional fields (Option a).** Keep spec 23's `vignette?`/`oldfilm?` pattern — new per-kind params are optional fields on `VideoEffect`. No `params`-union refactor. (Revisit only if field sprawl becomes a problem in a later spec.)
- **D2 — First build slice (this `/task`):** Tier 1 (`hue`, `contrast`, `bleach`) + the Tier-2 high-value set (`lightleak`, `chromatic`, `pixelate`). The remaining Tier 3/4 kinds are deferred to a follow-up task.
- **D3 — Category C (per-pixel effects) is deferred pending a WebGL pipeline.** `gradientmap` was built and tested during this task and **removed**: a full-frame `getImageData`/`putImageData` readback per frame is unacceptably laggy in preview even after routing through a `willReadFrequently` CPU buffer — the GPU↔CPU round trip plus a ~2M-pixel JS loop can't hold 60fps at 1080p. **All per-pixel effects** (gradient map / false colour, posterize, threshold/duotone, channel swap, colour isolation, dither, Sobel comic-ink) are blocked on the same wall and are **out of scope until the app grows a WebGL effect path** (see "Future: WebGL effect pipeline"). This does not affect Category A (CSS filter) or Category B (blend/overlay) effects, which stay on Canvas 2D.

## Future: WebGL effect pipeline

The right home for per-pixel effects (Category C) — and eventually geometric warps (barrel distortion) — is a **fragment-shader pass**, not Canvas 2D. A GLSL pass runs the per-pixel math on the GPU with **no readback**, turning each of these effects into ~20 lines and making stacks of them cheap. This is the architecture the original wishlist assumed.

Rough shape of the future work (its own spec when picked up):
- A WebGL (or WebGL2) render target that the composited Canvas-2D frame is uploaded to as a texture once per frame, with effect shaders applied as ping-pong passes, then drawn back. Preview uses a `<canvas webgl>`; export uses the same in an OffscreenCanvas (WebGL is available in workers).
- Keep the spec-23 envelope/resolver model — only the *apply* step changes (a shader uniform per effect instead of a `ctx.filter`/overlay draw). The `ResolvedEffect` list feeds shader selection + uniforms.
- Preserve the preview==export invariant by sharing the shader code + uniforms across both paths, exactly as `renderFrame` is shared today.
- Migrate the existing Canvas-2D overlay/filter effects opportunistically (they'd also get cheaper/composable), or run a hybrid until parity is proven.

## Open Questions
3. **Category-C compose order vs the batched colour-filter branch.** Colour filters are applied as one batched pass *before* the overlay loop; per-pixel effects read the live canvas. If a per-pixel effect is authored "before" a colour filter in resolved order, it will still see post-filter pixels. Acceptable for v1 (document it), or should per-pixel + colour-filter branches be merged into one strictly-ordered pass (more code)? Recommendation: document the caveat, keep branches separate for v1.
4. **Preview downscale for Category C?** Should per-pixel effects run at full project res always, or at a capped preview res (e.g. ≤720p) upscaled, reserving full res for export? Recommendation: full res in export; evaluate a preview cap only if it stutters.
5. **Datamosh / frame-history effects — ever?** They need a retained previous-frame buffer, which conflicts with the pure-per-time renderer and preview scrubbing. Would require an opt-in "sequential-only" render mode. Recommendation: out of scope; note as a known limitation.
6. **Presets vs primitives.** Super 8/16mm, "grimdark", CRT are *stacks* of primitives. Do we want a preset system (one click drops several pre-configured effects), or just document the recipes? Recommendation: ship primitives first; a preset layer is a separate, later spec.

## Acceptance Criteria

- Each shipped effect: (1) appears in the LeftRail Effects menu, creates at the playhead, and is selectable; (2) shows a working editor (intensity + any params) in the PropertiesPanel; (3) shows a labelled draggable bar on the Timeline Effects track; (4) fades in/out over its envelope.
- **Preview == export** for every shipped effect, including at scrubbed/seeked times for animated ones (deterministic from `globalTime`).
- Every shipped effect renders correctly in **both** the main-thread and OffscreenCanvas export paths (R3).
- A project with no new effects is **pixel-identical** to pre-spec-24 output.
- `npx tsc -b` is green.
- Category-C effects hold interactive preview framerate at 1080p for a single active effect (or the agreed preview-downscale fallback engages).

## Implementation Notes

- **Sequence the work by tier**, and land the **Category-C branch** (R6) with the gradient-map effect as its first consumer — that single effect (thermal/night-vision/infrared/riso via ramp presets) justifies the branch and makes posterize/threshold/channel-swap/isolate near-free follow-ons.
- **Reference implementations to copy:** `drawGrain` (cached tile + `createPattern` + time-seeded offset), `drawOldFilm` (`mulberry32(hashInt(frame))` deterministic per-frame sprites), `drawVignette` (gradient overlay). New overlays should look like these.
- **Chromatic split without per-pixel:** draw the frame three times into pure R/G/B channels — tint a copy with `globalCompositeOperation='multiply'` against a solid `#f00`/`#0f0`/`#00f`, then recombine the offset copies with `'lighter'`/`'screen'`. Offset & angle from `ChromaticParams`, scaled by eased intensity.
- **Pixelate:** `ctx.drawImage(ctx.canvas, 0,0,w,h, 0,0, w/cell, h/cell)` into a scratch, then draw back up with `imageSmoothingEnabled=false`. `cell = 1 + intensity * MAX_CELL`.
- **New pure module `src/lib/effectPixels.ts`** for Category-C transforms (luminance helper, ramp sampler, quantise, threshold) — keeps `renderer.ts` lean and makes the pixel math unit-testable without a canvas.
- **Thread `globalTime` into `effectsToFilterString`** (currently timeless) only if animated hue ships; otherwise leave it.
- **Icons:** `@tabler/icons-react` is already the icon set (see LeftRail imports). Pick one per kind for the menu + panel header.

---
*This specification is ready for implementation. Use `/task 24-more-effects` to begin development. Scope locked to D2 (Tier 1 + light leak + chromatic + pixelate + gradient-map); remaining kinds deferred.*

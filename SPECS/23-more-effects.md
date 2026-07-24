# 23 — More Effects (render-wide, full-video effects)

## Overview

Today the only "render-wide, full-video effect" is the **camera zoom** (spec 13): a project-level list
of `CameraZoom`s that `resolveCamera` compiles into a single global transform inside the shared
`renderFrame`, so preview (Live view) and export are identical by construction.

This spec generalizes that idea from "zooms" into **Effects** — a family of timeline-scheduled,
full-frame effects. The camera zoom stays as one member of the family. New members added here fall
into two render styles:

**Colour-grade effects** (a `ctx.filter` string over the whole frame):
- **Black & white** (grayscale / desaturate)
- **Sepia**
- **Invert colour**

**Overlay effects** (a custom shape drawn on top of the graded frame):
- **Vignette** — darkens the frame toward the edges, fading to clear through a central **shape**
  (v1: **rectangle** matching the frame, and **circle**), with modifiers for **darkness/transparency**
  (the effect's `intensity`), **feather/blur distance** of the fade, and **size** of the clear
  region. The camera does NOT move — it's purely a darkening overlay. Vignette is the **first
  custom-draw (non-filter) effect**, so it realizes the extensibility path this spec designs for.

Future, more "in your face" members are explicitly out of scope for implementation but must be
*accommodated by the data model* — and they extend the same custom-draw overlay path vignette opens:

- **Underwater** (wavy displacement + blue/green tint)
- **Heat / flames at the bottom** (animated overlay + shimmer)

The user-facing change: rename the **"Animations"** left-rail section (currently holding only "Camera
zoom") to **"Effects"**, keep camera zoom there, and add the new colour effects. Every effect
**behaves like a zoom**: it lives on the timeline, is selectable, and can be lengthened/shortened by
dragging its bar.

## The key architectural insight (read this first)

A camera zoom and a colour effect are the **same UX object** but **fundamentally different renders**:

| | Camera zoom (existing) | Colour effect (new) |
|---|---|---|
| What it is | a geometric **transform** | a **post-process** on the composited pixels |
| When it applies | **before** drawing each object (`ctx.translate/scale`) | **after** the whole object loop finishes |
| Pose model | `{x, y, scale}` + focal point + keyframe path | scalar **intensity** `0–1` (+ maybe params) |
| Authoring surface | on-canvas framing rect (Frame view) | none on-canvas — just a timeline bar + panel |
| Blocks object editing? | yes (Frame view disables the transform so you can edit) | no — colour never moves hit-test geometry |

The **vignette** is a third render style: still a **post-process** (applies after the object loop,
same pipeline stage as colour), but drawn as a **shaped overlay** rather than a `ctx.filter` string —
so it also never moves geometry and never blocks editing. It shares the `VideoEffect` envelope and
timeline behaviour with the colour effects; only its *render branch* and *extra params* differ.

Because of this, the recommended design **keeps `CameraZoom` exactly as it is** (its machinery is
mature and load-bearing) and adds a **separate `VideoEffect` type** for the post-process effects.
The two are **unified only in the UX** (same left-rail cluster, same timeline-track affordances, same
"select → edit timing in panel" flow), not in the data model. See Open Questions Q1 for the
alternative (one merged discriminated union) and why it's not recommended.

## Requirements

### Data model
- **R1.** Add a project-level `Project.effects?: VideoEffect[]` — optional/additive, mirroring how
  `zooms?` and `markers?` were added (back-compat: absent = no effects, `.brep`/localStorage
  round-trips for free since persistence is whole-project JSON).
- **R2.** A `VideoEffect` carries a **kind** (`'grayscale' | 'sepia' | 'invert' | 'vignette'` for
  v1), a **timeline envelope** identical in shape to a zoom's (`startTime`, `transitionIn`, `hold`,
  `transitionOut`, `easing`), a peak **intensity** `0–1`, an optional per-kind **params** payload
  (absent for the colour kinds; a `VignetteParams` for `vignette`), and a `hidden?` flag (parity with
  `CameraZoom.hidden`). The `type + optional params-payload` shape mirrors the codebase's
  `TimelineObject { type, data }` idiom.
- **R3.** The envelope's ease-in ramps intensity `0 → intensity`, holds, then ease-out ramps
  `intensity → 0`. A colour effect with `transitionIn = transitionOut = 0` is a hard cut on/off.
  (This reuses the zoom envelope so the Timeline drag code and the mental model transfer directly.)

### Vignette
- **R3a.** `VignetteParams` carries a **shape** (`'rectangle' | 'circle'` in v1 — rectangle matches
  the frame, i.e. "screen size"), a **size** `0–1` (extent of the fully-clear central region relative
  to the frame), and a **feather** `0–1` (softness / "blur distance" of the fade from clear to black).
  The effect's shared **intensity** is the vignette's peak **darkness/opacity** (the "overall
  transparency" modifier), so it fades in/out with the envelope like every other effect. Colour is
  black in v1 (a `color?` field is a trivial future add).
- **R3b.** Vignette shapes are extensible (the shape is a string union): rectangle + circle now,
  others (rounded-rect, ellipse, custom) later without a model change.

### Rendering
- **R4.** Effects apply as a **post-process at the end of `renderFrame`**, after the object loop and
  `ctx.restore()`, so they affect the *entire composited frame* including any camera zoom already
  baked in. Two branches: (a) **colour-grade** kinds contribute to one `ctx.filter` string applied
  via a self-composited redraw; (b) **overlay** kinds (vignette) draw their shape on top afterward
  (with `ctx.filter` reset to `'none'` so the overlay itself isn't filtered).
- **R4a.** Branch order is **colour filters first, then overlays** — grade the pixels, then darken the
  edges on top. (A vignette drawn *before* a colour filter would get graded away, which is wrong.)
- **R5.** Multiple overlapping colour effects **compose** (e.g. B&W + invert at the same time chains
  both filters); multiple overlays stack (alpha over alpha). Order within each branch is
  deterministic (Q4).
- **R6.** An effect at intensity 0 (before ease-in / after ease-out / disabled) is a **no-op** — the
  frame must be **pixel-identical** to today's output (the same "identity ⇒ untouched" guarantee the
  camera makes). This keeps every existing project bit-identical.
- **R7.** `renderFrame` is the single shared compositor, so **preview and export apply effects
  identically** — no per-path effect code. The export paths (`ffmpegExport.ts` main WebCodecs path,
  the MediaRecorder fallback, and `exportWorker.ts`) must all pass the resolved effects, exactly as
  they already pass `resolveCamera(project.zooms, t)`.

### Authoring / UI
- **R8.** Rename the left-rail **"Animations"** section (`LeftRail.tsx`, section id `'zoom'`) to
  **"Effects"**. Keep **Camera zoom** as an item; add **Black & white**, **Sepia**, **Invert**, and
  **Vignette**.
- **R9.** Adding an effect creates it at the playhead with sensible defaults, selects it
  (clearing object + zoom selection), and shows its editor — mirroring `handleCreateZoom`.
- **R10.** Effects appear as **bars on the pinned Effects timeline track** (Q3: separate from the
  Camera track) with the same affordances as zoom bars: drag body = retime `startTime`; drag edges =
  lengthen/shorten (adjust `hold` anchored at the opposite edge); click = select.
- **R11.** A selected effect shows an editor in `PropertiesPanel` (mirroring `ZoomEditor`), **kind-
  aware**: shared controls are **intensity** slider, timing fields (`transitionIn`, `hold`,
  `transitionOut`), easing dropdown, delete; kind is fixed after creation (Q5). When
  `kind === 'vignette'` it additionally shows **Shape** (Rectangle / Circle), **Size**, and
  **Feather** controls (bound to `vignette.*`, dispatched whole per the shallow-merge reducer rule).
  No on-canvas handles for any effect kind.
- **R12.** Selection is mutually exclusive with objects **and** zooms (extend the existing
  `selectedObjectId` ⊥ `selectedZoomId` invariant to include effects).

### Undo / persistence
- **R13.** Mirror the zoom CRUD reducer actions: `ADD_EFFECT`, `UPDATE_EFFECT`,
  `UPDATE_EFFECT_TRANSIENT` (→ reuse existing `COMMIT_TRANSIENT`), `REMOVE_EFFECT`. One undo entry
  per discrete edit; transient→commit collapses a drag into one entry (same pattern as zooms).

## Technical Considerations

### Types (new + touched)

New, in `src/types.ts` (alongside `CameraZoom`):

```ts
// v1 effect kinds: three colour-grade (filter) kinds + one overlay kind. Extensible: future kinds
// (underwater/heat) add here + a renderer branch.
export type VideoEffectKind = 'grayscale' | 'sepia' | 'invert' | 'vignette'

// Per-kind params. Absent for the colour kinds; present for vignette. (The `type + optional payload`
// shape mirrors TimelineObject { type, data }.)
export type VignetteShape = 'rectangle' | 'circle' // rectangle = "screen size" (matches the frame)
export type VignetteParams = {
  shape: VignetteShape
  size: number     // 0–1: extent of the fully-clear central region (relative to the frame)
  feather: number  // 0–1: softness / "blur distance" of the fade from clear to black
}

// A timeline-scheduled, full-frame post-process effect. NOT a TimelineObject and NOT a CameraZoom —
// a third project-level entity (like Marker). Shares the zoom ENVELOPE shape so the timeline
// lengthen/shorten drag code and the ease-in/hold/ease-out mental model transfer directly.
export type VideoEffect = {
  id: string
  kind: VideoEffectKind
  intensity: number      // 0–1 peak strength: the filter amount (colour) / the darkness (vignette)
  startTime: number      // global seconds — when the ease-in begins
  transitionIn: number   // seconds to ramp intensity 0 -> intensity
  hold: number           // seconds held at full intensity
  transitionOut: number  // seconds to ramp intensity -> 0
  easing: EasingKind     // reused spec-12 curve, applied to both ramps (mirrors CameraZoom.easing)
  vignette?: VignetteParams // present only when kind === 'vignette' (see R2)
  hidden?: boolean        // spec 14 R11 parity: skipped in resolveEffects when true
}

// The resolved effect stack at an instant — what renderFrame consumes (mirrors CameraState).
// `intensity` is already eased; `vignette` carried through for the overlay branch.
export type ResolvedEffect = { kind: VideoEffectKind; intensity: number; vignette?: VignetteParams }
```

Touched:
- `Project` gains `effects?: VideoEffect[]`.
- `ProjectAction` union gains the four `*_EFFECT` actions (R13).
- `EditorOptions` (in `renderer.ts`) gains `effects?: ResolvedEffect[]`.
- A factory `createVideoEffect(kind, options?)` mirroring `createCameraZoom` (defaults: `intensity 1`,
  `transitionIn 0.4`, `hold 2`, `transitionOut 0.4`, `easing 'easeInOutCubic'`; when `kind ===
  'vignette'`, seeds `vignette: { shape: 'rectangle', size: 0.6, feather: 0.4 }`).

### The resolver — new `src/lib/effects.ts` (mirrors `camera.ts`)

- `resolveEffects(effects: VideoEffect[] | undefined, globalTime: number): ResolvedEffect[]` —
  filters `!hidden`, and for each effect active at `globalTime` computes its eased intensity from the
  envelope (`transitionIn` ramp / `hold` / `transitionOut` ramp using `ease(effect.easing, u)`),
  dropping any at intensity ≤ 0. Simpler than `resolveCamera`: **no governing-window / A→B chaining**
  — colour effects don't hand off to each other, they just stack. Each effect resolves independently.
- Helper `effectEnvelope(e)` = `transitionIn + hold + transitionOut` (parity with `zoomEnvelope`).
- `effectsToFilterString(fx: ResolvedEffect[]): string` — maps only the **colour-grade** kinds to
  `grayscale(i)` / `sepia(i)` / `invert(i)` (i = eased intensity), joined by spaces; **ignores
  `vignette`** (that's the overlay branch). Returns `''` when no colour effects are active.

### The renderer post-process (`renderFrame`)

After the object loop, apply the resolved stack in two branches — colour filters first, then overlays:

```ts
// pseudo — at the very end of renderFrame, after the object loop
const fx = editorOptions?.effects ?? []

// (a) colour-grade branch: one filter string, one self-composited redraw
const filter = effectsToFilterString(fx)   // e.g. "grayscale(0.8) invert(1)"; '' if none
if (filter) {
  ctx.save()
  ctx.filter = filter
  ctx.globalCompositeOperation = 'copy'     // replace, don't blend
  ctx.drawImage(ctx.canvas, 0, 0)           // re-draw the frame through the filter
  ctx.restore()
}

// (b) overlay branch: draw each overlay effect on top of the graded frame
for (const e of fx) {
  if (e.kind === 'vignette' && e.vignette) {
    ctx.save()
    ctx.filter = 'none'                      // don't let (a)'s filter leak onto the overlay
    drawVignette(ctx, w, h, e.intensity, e.vignette)  // radial/shaped black gradient, alpha = intensity
    ctx.restore()
  }
}
```

- **Why `ctx.filter` + self-draw and not `getImageData`/`putImageData`?** `ctx.filter` is
  GPU-accelerated, ~free, and supported on `OffscreenCanvas` (so the `exportWorker.ts` path works
  too). Per-pixel JS would be slow on 1080p×fps and duplicate the browser's own filter math.
- **Intensity → filter amount is linear and native:** `grayscale(0.6)`, `sepia(0.6)`, `invert(0.6)`
  are all valid fractional filters that blend toward identity at 0. So the eased envelope intensity
  maps straight to the filter argument — the ease-in *is* the fade-in, no extra work.
- **Composition:** the CSS `filter` shorthand chains functions space-separated; multiple active
  colour effects concatenate. Overlays stack after, alpha over alpha. Order within each branch = Q4.
- **`drawImage(ctx.canvas, 0, 0)` on the same canvas** is legal and widely used; with
  `globalCompositeOperation = 'copy'` it replaces pixels 1:1 (no double-exposure). Verify on the
  export `OffscreenCanvas` 2D context (spot-check in the verify checklist).
- **`drawVignette` (new, e.g. in `lib/effects.ts` or `lib/annotations.ts`)** — draws a black darkening
  that's transparent through the central shape and opaque toward the edges, with `globalAlpha`/gradient
  peak = `intensity`:
  - **circle:** `ctx.createRadialGradient(cx, cy, size·R, cx, cy, (size+feather)·R)` from
    `rgba(0,0,0,0)` → `rgba(0,0,0,intensity)`, then fill the frame; beyond the outer stop stays fully
    dark. `R` = half the frame diagonal (or min dimension — tune so `size=1` clears the visible frame).
  - **rectangle ("screen size"):** an inset feathered frame matching the canvas aspect — e.g. fill the
    frame with `rgba(0,0,0,intensity)`, then punch out a rounded inset rect via
    `globalCompositeOperation='destination-out'` with a soft (blurred / gradient) edge whose inset =
    `(1-size)` and edge softness = `feather`. Exact technique is an implementation detail; the params
    (shape/size/feather/intensity) are the contract.
  - All lengths derive from `w`/`h` so it scales with project dims and is identical in preview/export.

### Preview wiring
- `useCanvasRenderer` already forwards an `editorOptions` object built in `Canvas.tsx`. Add
  `effects: resolveEffects(project.effects, globalTime)` there. **Unlike the camera** (which is only
  passed in Live view so Frame view stays editable), colour effects don't move geometry, so they can
  be applied in **both Frame and Live view** — recommended default (Q2). Effects grade the preview
  the whole time you author, which is what you want for a colour look.

### Export wiring
- Add `effects: resolveEffects(project.effects, globalTime)` next to the existing
  `camera: resolveCamera(project.zooms, globalTime)` in both `ffmpegExport.ts` call sites
  (lines ~366 and ~776) and in `exportWorker.ts`. No other export changes.

### Future-effect accommodation (design-only, not built)
- `VideoEffectKind` is a string union → adding `'underwater' | 'heat'` later is additive.
- The two-branch post-process (filter string + overlay draw) is exactly the **dispatch-by-kind** these
  need. Vignette already establishes the overlay/custom-draw branch in v1; future kinds that need a
  **time input** (animated shimmer, flame flicker) extend the overlay signature to
  `(ctx, w, h, intensity, params, time) => void` — `renderFrame` already has `globalTime` in scope, so
  threading it through is a one-line change when the first time-animated effect lands. Keep v1's
  overlay branch time-free but don't hard-code the assumption that *every* effect is a filter string.

## Related Systems and Tasks

- **Spec 13 (`SPECS/13-camera-zoom.md`, `TASKS/13-zoom.md`)** — the template this generalizes.
  `src/lib/camera.ts` is the structural model for `src/lib/effects.ts`; `ZoomEditor` in
  `PropertiesPanel.tsx` for the effect editor; the Timeline Camera track for the effect track.
- **Spec 19 (`text-effects`)** — note the name collision: spec 19 "effects" are **per-text-object**
  `TextData.effect`. This spec's effects are **project-level, full-frame**. Different layer; keep the
  naming unambiguous in code (`VideoEffect` vs the text `effect`).
- **`renderer.ts`** — the shared compositor; the one place the post-process is added.
- **`useProject.ts`** — reducer; add the `*_EFFECT` cases next to the `*_ZOOM` cases.
- **`Canvas.tsx` / `useCanvasRenderer.ts`** — preview editorOptions.
- **`ffmpegExport.ts`, `exportWorker.ts`** — export render loops.
- **`LeftRail.tsx`** — the "Animations" → "Effects" section.
- **`Timeline.tsx`** — pinned effect track + drag handlers (mirror `zoom-move` / `zoom-resize-*`).
- **`App.tsx`** — `selectedEffectId` state + mutual-exclusion invariant + `handleCreate*` handlers.

## Resolved Decisions

- **Q1 — One merged type or two? → TWO.** Keep `CameraZoom` exactly as-is; add a separate
  `VideoEffect`, unified with zoom **only in the UX**. Merging into one discriminated union would
  destabilize the mature zoom code (focal point, keyframe path, governing-window chaining) for no
  runtime benefit — they render at different pipeline stages regardless. (Consistent with all the
  answers below and the user's framing "leave camera zoom in there, add each as an effect".)
- **Q2 — Frame view too, or Live only? → BOTH Frame + Live.** Colour effects and the vignette overlay
  don't move geometry, so they can't block object editing/hit-testing; the look shows the whole time
  you author. (Camera stays Live-only.) ⇒ `Canvas.tsx` passes `resolveEffects(...)` in both views, but
  keeps passing `camera` only in Live view. (Minor: a strong vignette darkens edges in Frame view too;
  acceptable — hit-testing is unaffected.)
- **Q3 — Timeline track layout? → SEPARATE Effects track.** Keep the pinned Camera track untouched;
  add a **second pinned track** below it for effect bars (colour + vignette). Least churn, and
  overlapping zoom + effect read clearly on separate rows.
- **Q4 — Compose order for overlapping effects? → by `startTime`, then `id`.** Deterministic and
  documented; `resolveEffects` returns the stack in that order; `effectsToFilterString` concatenates
  colour filters in it and the overlay branch draws vignettes in it.
- **Q5 — Kind switchable after creation? → FIXED at creation.** To change type, delete + re-add. No
  kind dropdown in the editor for v1.
- **Q6 — Intensity control in v1? → INCLUDE intensity.** A per-effect 0–100% slider (`intensity`
  field, R2). Nearly free with fractional CSS filters and makes the ease-in/out fades work.
- **Q7 — UI labels.** Using **"Camera zoom"**, **"Black & white"**, **"Sepia"**, **"Invert"**,
  **"Vignette"** in the left rail. (Cosmetic — trivially changed during implementation.)

### Vignette — assumptions taken (flag if wrong)
- **Params = shape + size + feather + intensity.** "Overall transparency" → the shared `intensity`
  (peak darkness, enveloped so it fades in/out). "Blur distance" → `feather`. Plus `size` (extent of
  the clear centre) as the natural "and stuff". Colour is **black** in v1 (`color?` is a future add).
- **v1 shapes = rectangle ("screen size") + circle**, per your "start with screen size, then a
  circle". The shape is a string union so more (ellipse, rounded-rect) drop in later.
- **Vignette is static in v1** (no animated shimmer/movement) — only its intensity animates, via the
  envelope. Animated overlays are the future underwater/heat path.

## Acceptance Criteria

- Left-rail section reads **Effects** and lists Camera zoom, Black & white, Sepia, Invert, Vignette.
- Adding e.g. Sepia at the playhead creates a bar on the Effects timeline track, selected, with its
  editor shown; dragging the bar body retimes it and dragging an edge lengthens/shortens it.
- During the effect's window the **preview** shows the sepia grade, fading in/out over the
  transitions; scrubbing outside the window shows the untouched frame.
- **Vignette:** adding one darkens the frame edges toward black, clear through the central shape;
  switching Shape Rectangle↔Circle changes the clear region; Size grows/shrinks the clear centre;
  Feather softens the fade; Intensity sets peak darkness and fades in/out with the envelope.
- **Export** (WebCodecs primary path) produces an MP4 whose graded/vignetted frames match Live preview
  frame-for-frame; the MediaRecorder and worker paths agree.
- Two overlapping effects both apply (colour filters compose; a colour filter + vignette = graded then
  darkened) in preview and export.
- A project with **no effects** renders **pixel-identical** to pre-spec-23 (no regression), and old
  `.brep`/localStorage projects load unchanged.
- Effects survive `.brep` export/import and localStorage persistence.
- `npx tsc -b` is green.

## Implementation Notes

Suggested order (each step keeps `tsc -b` green):
1. **Types + factory** (`types.ts`): `VideoEffectKind` (incl. `'vignette'`), `VignetteShape`,
   `VignetteParams`, `VideoEffect` (with `vignette?`), `ResolvedEffect`, `Project.effects?`,
   `createVideoEffect` (vignette seed), the four `*_EFFECT` actions, `EditorOptions.effects`.
2. **Resolver** (`lib/effects.ts`): `resolveEffects`, `effectEnvelope`, `effectsToFilterString`
   (colour kinds only). Pure functions, unit-test-friendly (mirror `camera.ts`).
3. **Renderer** (`renderer.ts`): the end-of-frame two-branch post-process (R4/R4a–R6) — filter string
   redraw, then the overlay loop — plus a `drawVignette(ctx, w, h, intensity, params)` helper.
   Verify the identity no-op (no active effects ⇒ untouched frame).
4. **Reducer** (`useProject.ts`): `*_EFFECT` cases beside `*_ZOOM`.
5. **Preview** (`Canvas.tsx`/`useCanvasRenderer.ts`): pass `resolveEffects(...)` (both views, Q2).
6. **Export** (`ffmpegExport.ts` ×2, `exportWorker.ts`): pass `resolveEffects(...)`.
7. **Left rail** (`LeftRail.tsx`): rename + new items (incl. Vignette) + `App.handleCreateEffect`.
8. **Selection** (`App.tsx`): `selectedEffectId` + extend the mutual-exclusion invariant.
9. **Panel editor** (`PropertiesPanel.tsx`): a kind-aware `EffectEditor` mirroring `ZoomEditor` —
   shared intensity/timing/easing + a vignette-only Shape/Size/Feather block.
10. **Timeline** (`Timeline.tsx`): the effect track + `effect-move` / `effect-resize-*` drag kinds,
    copied from the `zoom-*` handlers.

Follow the project convention: no dev server / browser automation — verify with `npx tsc -b` and hand
the user a "click X, look for Y" checklist (see `.claude/skills/verify/SKILL.md`).

---
*This specification is ready for implementation. Use `/task 23-more-effects` to begin development.*

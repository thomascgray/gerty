# 23 — More Effects (render-wide, full-video effects)

**Status**: In Progress

## Overview

Generalize the "render-wide, full-video effect" idea (currently only camera zoom, spec 13) into a
family of timeline-scheduled **Effects**. Keep camera zoom as-is; add new project-level `VideoEffect`s:
colour-grade filters (**grayscale / sepia / invert**) and one overlay effect (**vignette**). Each
behaves like a zoom on the timeline (own pinned track, select, lengthen/shorten). Full design lives in
[SPECS/23-more-effects.md](../SPECS/23-more-effects.md).

## Task Context

- **Zoom is the template.** `VideoEffect` mirrors `CameraZoom`'s envelope + CRUD but is a **separate
  type** (unified with zoom only in UX). Reference files:
  - `src/lib/camera.ts` → model for new `src/lib/effects.ts` (resolver + helpers)
  - `src/lib/renderer.ts` → `renderFrame`; add end-of-frame post-process (two branches)
  - `src/types.ts` → `CameraZoom`, `Project`, `ProjectAction`, `createCameraZoom` (lines ~157–290)
  - `src/hooks/useProject.ts` → `*_ZOOM` reducer cases → add `*_EFFECT`
  - `src/components/Canvas.tsx` → builds preview `editorOptions` (camera only in Live view)
  - `src/hooks/useCanvasRenderer.ts` → forwards `editorOptions` to `renderFrame`
  - `src/lib/ffmpegExport.ts` (2 call sites ~366, ~776) + `exportWorker.ts` → export render loops
  - `src/components/LeftRail.tsx` → "Animations" section id `'zoom'` (lines ~99–103) → rename "Effects"
  - `src/components/App.tsx` → `selectedZoomId`/`handleCreateZoom`/mutual-exclusion (~65, ~104, ~317–334)
  - `src/components/PropertiesPanel.tsx` → `ZoomEditor` → model for `EffectEditor`
  - `src/components/Timeline.tsx` → pinned Camera track + `zoom-move`/`zoom-resize-*` drag kinds
- **Conventions:** verify with `npx tsc -b` only; NO dev server / browser automation. `UPDATE_*`
  shallow-merges so nested `data`/`vignette` must be passed whole. Transient→commit = one undo/gesture.
- **Key decisions (from spec):** separate `VideoEffect` type; effects in BOTH Frame+Live view (camera
  stays Live-only); per-effect intensity slider; kind fixed at creation; separate pinned Effects track;
  compose order by `startTime` then `id`; vignette params = shape/size/feather (+ shared intensity).

## Blockers/Issues

None currently.

## TODO

[X] 1. Types + factory (`types.ts`): `VideoEffectKind`, `VignetteShape`, `VignetteParams`,
      `VideoEffect`, `ResolvedEffect`, `Project.effects?`, `createVideoEffect`, four `*_EFFECT` actions
[X] 2. Resolver (`lib/effects.ts`): `resolveEffects`, `effectEnvelope`, `effectsToFilterString`
[X] 3. Renderer (`renderer.ts`): `EditorOptions.effects`, two-branch post-process, `drawVignette`
[X] 4. Reducer (`useProject.ts`): `*_EFFECT` cases beside `*_ZOOM`
[X] 5. Preview (`Canvas.tsx`): pass `resolveEffects(...)` in both views
[X] 6. Export (`ffmpegExport.ts` ×2, `exportWorker.ts`): pass `resolveEffects(...)`
[X] 7. Left rail (`LeftRail.tsx`): rename + new items + `App.handleCreateEffect`
[X] 8. Selection (`App.tsx`): `selectedEffectId` + mutual-exclusion invariant
[X] 9. Panel editor (`PropertiesPanel.tsx`): kind-aware `EffectEditor`
[X] 10. Timeline (`Timeline.tsx`): pinned Effects track + `effect-*` drag kinds
[X] 11. `npx tsc -b` green (full `npm run build` also green) + verify checklist handed to user

## Work Log

[2026-07-24] Split old-film **wobble** (gate weave) into its own `OldFilmParams.wobble` (0–1),
decoupled from `intensity` (scratches/dust/flicker), defaulting to **0** on a new effect — so you can
have heavy grain with a steady frame or vice versa. Added a Wobble slider to the panel; jitter
amplitude is now `wobble*14`. The two jitter randoms are always consumed so toggling wobble doesn't
reshuffle the dust/scratch pattern. Files: src/types.ts, src/lib/renderer.ts, src/lib/effects.ts,
src/components/PropertiesPanel.tsx. Build green.

[2026-07-24] Added an **Old Film** effect (second time-animated overlay) — procedural vintage-projector
damage drawn per frame, seeded deterministically by frame index so preview + export match: gate-weave
jitter (whole frame hops a few px via a scratch-canvas copy, black-filled edge), exposure flicker,
flickering vertical scratch lines, dust/specks scaled to area+intensity, and the odd bezier "hair".
Composes with vignette + sepia for an old-cowboy-film look. Refactored the grain PRNG into a shared
`mulberry32`. New overlay kind `oldfilm` (no filter string / no params; default intensity 0.5).
- Files modified: src/types.ts, src/lib/renderer.ts, src/lib/effects.ts,
  src/components/LeftRail.tsx, src/components/PropertiesPanel.tsx, src/components/Timeline.tsx.
  Full `npm run build` green.

[2026-07-24] Post-review polish (user feedback on first build): (1) recoloured the effects track +
panel from violet → **fuchsia `#d946ef`** since violet clashed with the video-object bars; (2) effects
now **auto-stack into display rows** on the timeline (greedy interval layout, `layoutEffectRows`) so an
overlapping Sepia + Vignette are both visible/grabbable — the track grows to fit N rows and the gutter
label matches (renderer still stacks all active effects regardless of row); (3) added **Film Grain** —
the first time-animated effect: a cached, seeded monochrome noise tile composited with an `overlay`
blend and a deterministic per-frame offset (`drawGrain` in renderer.ts, quantized to ~24fps so preview
+ export animate identically). Chose a canvas noise tile over SVG feTurbulence because SVG needs async
rasterization and doesn't run in the OffscreenCanvas export worker. `grain` is an overlay kind (no
filter string, no vignette params); default intensity 0.5.
- Files modified: src/types.ts, src/lib/renderer.ts, src/lib/effects.ts,
  src/components/LeftRail.tsx, src/components/PropertiesPanel.tsx, src/components/Timeline.tsx.
  Full `npm run build` green.

[2026-07-24] Implemented the effects core (data → render → export). Added `VideoEffect`/
`VignetteParams`/`ResolvedEffect` types, `Project.effects?`, `createVideoEffect`, and the four
`*_EFFECT` reducer actions. New `lib/effects.ts` resolver (`resolveEffects`/`effectEnvelope`/
`effectsToFilterString`) mirrors `camera.ts` but with no chaining — effects just stack, ordered by
(startTime, id). `renderFrame` now applies a two-branch end-of-frame post-process (colour filters via
self-composited `ctx.filter` redraw, then a `drawVignette` overlay). Wired resolved effects into
preview (Canvas, both views) and all three export paths.
- Files modified: src/types.ts, src/lib/effects.ts (new), src/lib/renderer.ts,
  src/hooks/useProject.ts, src/components/Canvas.tsx, src/components/App.tsx,
  src/lib/ffmpegExport.ts, src/lib/exportWorker.ts. tsc -b green.

[2026-07-24] Built the effects UI. LeftRail "Animations" → "Effects" (sparkles icon) with Camera
zoom + Black & white / Sepia / Invert / Vignette items. App gained `selectedEffectId` (3-way
mutual-exclusion with object/zoom), `handleCreateEffect`/`handleSelectEffect`, keyboard delete, and
wiring into Canvas/PropertiesPanel/Timeline. PropertiesPanel gained a violet-headed, kind-aware
`EffectEditor` (intensity + timing/motion envelope + vignette-only Shape/Size/Feather). Timeline
gained a second pinned track below the Camera track (violet wash, sparkles gutter label) rendering
effect envelope bars with move/resize-left/resize-right drags (transient→commit) + hide toggle,
mirroring the zoom bars. Full `npm run build` green.
- Files modified: src/components/LeftRail.tsx, src/components/App.tsx,
  src/components/PropertiesPanel.tsx, src/components/Timeline.tsx.

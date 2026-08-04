# 36-image-effects — per-object continuous "loop" animations

## Overview

Add an opt-in **loop effect** to any visual object: a continuously-running, ambient animation that
plays for the object's whole lifetime and is applied **on top of** wherever keyframes / drags put the
object. Think of the text `wave` / `warble` effects (spec 19) but generalized from glyph-level to
**object-level**, so a photo, video, or shape can gently oscillate-zoom, spin, 3D-warble, or hue-cycle
regardless of how it is positioned by keyframe animation.

User's motivating examples:
- oscillate zoom in and out repeatedly
- rotate repeatedly (continuous spin)
- a slight 3D warble
- a rainbow hue shift

Distinct from every existing animation concept:

| Concept | What it is | One-shot? |
|---|---|---|
| `animateIn` reveal | draw-on fraction | one-shot at clip start |
| enter / exit `Transition` | fade/slide/pop | one-shot at start/end |
| `keyframes` | user-placed whole-pose waypoints | user-timed |
| **loop effect (this spec)** | **ambient, always-running modulation on top of the resolved pose** | **continuous / cyclic** |
| text `effect` (spec 19) | glyph-level fill/warble, text only | continuous but text-only |
| video `effect` (spec 23) | render-wide colour grade / overlay | render-wide, not per-object |

## The governing constraint (read first)

Same as spec 19's **R-DET**: `renderFrame` is the single pure compositor shared by preview and export,
run once per preview frame and once per exported frame. **Every loop effect must be a deterministic
pure function of `(object, clip-relative time)`** — no wall clock, no unseeded `Math.random()`, no GPU
dependency. This holds trivially here because the modulation is Canvas-2D `ctx` transforms + an optional
`ctx.filter`, and `drawObject` **already receives** `time` (clip-relative seconds), threaded for the
spec-19 text effects. Preview and exported MP4 are then pixel-identical by construction, and effects
play in sync at any fps.

Note: the per-pixel-effects rule (`glEffects.ts`, no Canvas-2D `getImageData`) does **not** bite here —
loop effects are cheap affine transforms + CSS `hue-rotate`, not per-pixel readbacks.

## Requirements

### R-DET — Determinism (blocking, applies to every effect)
- Effects render purely from `(object, clip-relative time)`; preview and exported MP4 pixel-identical;
  animated effects play in sync at 30 and 60 fps.

### R1 — Data model & back-compat
- R1.1 A visual object may carry an optional `TimelineObject.loop?` (name TBD — see OQ1). Absent ⇒
  **rendered exactly as today** (visual + perf no-op for un-effected objects).
- R1.2 Persists in the project JSON, `.gerty` export/import, and undo/redo (it lives on `TimelineObject`,
  so it flows through `UPDATE_OBJECT` / `DUPLICATE_OBJECT` for free — deep-clone already copies the object
  shape; a flat effect record needs no special clone handling like `data`/`keyframes` do).
- R1.3 **DECIDED:** one loop effect per object in v1 (a single `loop?`, not a stack) — mirrors the
  spec-19 single `effect?` decision. Stacking is a follow-up.

### R2 — The effect set (v1) — DECIDED: ship all eight
Each effect is `{ kind, speed, amount }` (`rainbow` carries no `amount`). The four requested + all
proposed extras (user confirmed sway, bob, pulse, shake):
- R2.1 **zoom** — scale oscillates in/out about the object center (`1 + amount·sin(2π·speed·t)`).
- R2.2 **spin** — continuous rotation about the object center (`amount`·(2π)·speed·t, sign = direction).
- R2.3 **sway** — rotation oscillates back and forth about center (a bounded `spin`).
- R2.4 **bob** — vertical float (translate y by `amount·sin`), optionally horizontal drift.
- R2.5 **warble** — faux-3D axis wobble about center — **reuse the exact affine math from the text
  `warble`** (annotations.ts:407-423), lifted to operate on the object bbox.
- R2.6 **pulse** — scale + opacity oscillation (the object-level twin of text `pulse`).
- R2.7 **shake** — deterministic jitter/vibration. Offset x/y by a value **seeded from `time`** (a hash,
  NOT `Math.random`), matching the spec-23 grain/oldfilm determinism pattern (see R-DET). `amount` =
  displacement magnitude, `speed` = how fast the jitter resamples.
- R2.8 **rainbow** — hue cycles over time via `ctx.filter = hue-rotate((speed·t·k) deg)`.
- R2.9 Each is driven by **clip-relative time** so it starts with the clip and is identical in preview
  and export. `speed` (cycles/sec-ish) and `amount` (magnitude 0–1) tune it; sensible defaults per kind.

### R3 — Composition (the load-bearing requirement)
- R3.1 The loop effect is applied **after** `resolveRenderPose` (keyframes + enter/exit), as a modulation
  wrapping the type dispatch inside `drawObject`. So it layers on top of the resolved pose: an object
  animated across the screen by keyframes still spins/warbles/hue-shifts **while** it travels.
- R3.2 It composes with `animateIn` reveal, enter/exit transitions, keyframes, the camera transform
  (loop transforms happen inside the per-object camera transform, so a zoom-oscillating object oscillates
  *within* the camera frame), rotation, and opacity — none of these need to know it exists.
- R3.3 The effect **does not** move the object's logical pose: hit-testing, the selection box, and drag
  keep using the keyframe-resolved pose (`resolvePose`), NOT the modulated visual. You grab the object
  where it "is", not where it momentarily wobbled to. (Same precedent as text warble/pulse, which the
  selection box doesn't track — see Gotchas.)

### R4 — Authoring UI
- R4.1 A **loop-effect picker** in `PropertiesPanel` for eligible object types (kind dropdown + per-kind
  `speed`/`amount` sliders), modeled on the spec-19 `EffectFields` text-effect picker.
- R4.2 "None" removes the effect (back to R1.1 rendering).
- R4.3 Editing a param is one undo entry (reuse the `updateData`/"remember" helper pattern) and updates
  live in the preview while playing.

## Technical Considerations

### Relevant types (to add / where)

`TimelineObject` — [src/types.ts:5-45](src/types.ts#L5-L45). Add an optional field + a new union.
`ObjectStyle` is shared across all types and is the wrong home (this is per-object animation, not style),
so the field goes directly on `TimelineObject` alongside `enter`/`exit`:

```ts
// A continuously-running ambient animation applied ON TOP of the resolved pose (spec 36).
// Pure fn of clip-relative time (R-DET). Absent = no modulation (today's rendering).
export type LoopEffect =
  | { kind: 'zoom';    speed: number; amount: number }   // scale oscillation about center
  | { kind: 'spin';    speed: number; amount: number }   // continuous rotation (amount = direction/turns)
  | { kind: 'sway';    speed: number; amount: number }   // bounded rotate back-and-forth
  | { kind: 'bob';     speed: number; amount: number }   // vertical float
  | { kind: 'warble';  speed: number; amount: number }   // faux-3D axis wobble (reuse text-warble affine)
  | { kind: 'pulse';   speed: number; amount: number }   // scale + opacity oscillation
  | { kind: 'shake';   speed: number; amount: number }   // jitter, seeded from time (NOT Math.random)
  | { kind: 'rainbow'; speed: number }                   // hue cycle via ctx.filter

export type LoopEffectKind = LoopEffect['kind']

// on TimelineObject:
//   loop?: LoopEffect   // NEW (spec 36)
```

Naming: `loop` risks confusion with clip-looping; candidates `loop` / `motion` / `idle` / `ambient` /
`fx`. Defaulting to `loop` in the draft; confirm in OQ1.

### Where it plugs in (one change point)

`drawObject` — [renderer.ts:665-745](src/lib/renderer.ts#L665-L745). It already computes the bbox center
`(cx, cy)`, opens a `ctx.save()`, applies the base rotation, and receives `time` (clip-relative). Insert
a **loop-modulation block immediately after the base rotation and before the `switch (obj.type)`**, all
inside the existing save/restore so nothing leaks:

```
ctx.save()
  base rotation about (cx, cy)              // existing
  applyLoopEffect(ctx, obj.loop, time, cx, cy, /*opacity handle*/)   // NEW — transforms + optional filter
  switch (obj.type) { … draw* … }           // existing
ctx.restore()
```

- Transform kinds (`zoom`/`spin`/`sway`/`bob`/`warble`/`pulse`) map to `ctx.translate(center) →
  ctx.scale/rotate/transform → translate(-center)`, exactly like text `warble`/`pulse` (annotations.ts).
- `rainbow` sets `ctx.filter = 'hue-rotate(<deg>deg)'` before the type dispatch. The per-object filter
  is scoped by the existing `ctx.save()/restore()` and is independent of the render-wide effects filter
  (spec 23), which runs after the whole object loop via a self-composited redraw.
- `pulse`'s opacity component: `drawObject` sets `ctx.globalAlpha = style.opacity * progress` inside each
  `case`. Either fold the pulse opacity factor into that (pass it into the block / multiply after), or
  keep pulse scale-only to avoid touching each case. Decide during implementation (favor a single
  `globalAlpha *=` right before dispatch so it covers photo/video/shape uniformly).

Suggested home for the math: a small pure helper `applyLoopEffect(ctx, loop, time, cx, cy)` in
`renderer.ts` (or a new `src/lib/loopEffects.ts` if it grows), returning any opacity multiplier it wants
applied. Keeps `drawObject` readable and the math unit-testable.

### Eligible object types

**DECIDED: all visual types.** The mechanism is type-agnostic (it wraps the dispatch), so it applies to
`photo`, `video`, `rectangle`, `circle`, `arrow`, `freehand`, and `text`. `audio` has no canvas presence
⇒ excluded. The panel shows the loop-effect picker for any non-audio object. (Text also keeps its
glyph-level `warble`/`pulse` from spec 19 — the object-level loop stacks on top harmlessly.)

### Determinism details
- All oscillators use `Math.sin`/`Math.cos` of `2π·speed·time`. `spin` uses unbounded `time` (angle grows
  linearly) — fine and deterministic.
- **`shake` must NOT use `Math.random`.** Derive its per-frame offset from a hash of `time` (e.g. a small
  fract-of-sin hash, or the value-noise approach spec-23 grain/oldfilm use). Optionally quantize the hash
  input by `speed` so the jitter resamples at a controlled rate rather than every frame. This keeps
  preview and export bit-identical (R-DET).

## Related Systems and Tasks

- **spec 19 (text effects)** — the direct architectural precedent: `wave`/`warble`/`pulse` are `ctx`
  modulations driven by clip-relative `time` inside a draw fn. This spec lifts the same idea to
  `drawObject`. Reuse the `warble` affine and `pulse` oscillator math. `EffectFields`
  ([PropertiesPanel.tsx](src/components/PropertiesPanel.tsx)) is the UI precedent for R4.
- **spec 12 / 21 / 29 (animation)** — loop effects apply strictly AFTER `resolveRenderPose`, so they are
  orthogonal to keyframes/transitions and require no changes to `keyframes.ts`. (They are NOT keyframable
  in v1 — a loop effect is a constant descriptor, not an animatable channel.)
- **spec 13 (camera)** — loop transforms nest inside the per-object camera transform in `renderFrame`;
  a spinning object spins within the zoomed frame. No camera changes needed.
- **spec 23 (video effects)** — the per-object `rainbow` `ctx.filter` is independent of the render-wide
  filter (different scope, different phase). Don't confuse the two `hue`s: spec-23 `hue` is a static
  render-wide grade; spec-36 `rainbow` is a per-object animated hue cycle.
- **Export** — no export-specific code: because the modulation lives in the shared `drawObject`, both
  WebCodecs and MediaRecorder paths get it for free. Zero renderer-signature change (`time` already flows).

## Open Questions

Resolved in the spec session (2026-08-04):
- **OQ2 — single vs stack → SINGLE.** v1 = single `loop?` per object (parallel to spec-19). Stacking is a
  possible follow-up.
- **OQ3 — object-type scope → ALL visual types** (photo/video/shapes/arrow/freehand/text; audio excluded).
- **OQ4 — effect set → ALL EIGHT** ship: zoom, spin, sway, bob, warble, pulse, shake, rainbow.
- **OQ5 — params → RAW `speed`/`amount` sliders** with sensible per-kind defaults (not curated presets).

Still open (non-blocking):
- **OQ1 — field name.** `loop` (default) vs `motion` / `idle` / `ambient` / `fx`? `loop` is concise but
  overloads "clip looping". Confirm the persisted key at implementation time; leaning `loop`.
- **OQ6 — selection-box feedback.** v1 leaves the selection box on the un-modulated pose (R3.3). Is a
  small "this object has a loop effect" affordance in the panel enough, or is a timeline badge wanted?
  (Default: picker in the panel is enough for v1.)

## Acceptance Criteria

- **AC1 (R-DET):** For each effect, preview and exported MP4 are pixel-identical; animated effects play in
  sync in the export at 30 and 60 fps.
- **AC2 (R1):** An object with no loop effect renders exactly as before (visual + perf no-op); adding one
  persists through save / `.gerty` / undo / redo, and survives `DUPLICATE_OBJECT` independently.
- **AC3 (R2):** zoom, spin, sway, bob, warble, pulse, and rainbow each animate smoothly and continuously
  for the object's whole lifetime.
- **AC4 (R3):** With a loop effect AND position keyframes on the same object, the object travels along its
  keyframe path **while** the loop animation runs on top; hit-testing / selection / drag still track the
  keyframe pose (not the wobble).
- **AC5 (R4):** The panel shows a loop-effect picker + per-kind params for eligible objects; "None" fully
  removes it; edits are single undo entries and update live during playback.
- **AC6:** `npx tsc -b` stays green.

## Implementation Notes

- **Types:** add `LoopEffect` union + `LoopEffectKind` + `TimelineObject.loop?` in
  [src/types.ts](src/types.ts).
- **Renderer:** add `applyLoopEffect(ctx, loop, time, cx, cy)` (in `renderer.ts` or a new
  `src/lib/loopEffects.ts`) and call it in `drawObject` right after the base rotation, before the
  `switch` ([renderer.ts:697-699](src/lib/renderer.ts#L697-L699)). Reuse the text `warble` affine
  (annotations.ts:407-423) and `pulse` oscillator (annotations.ts:395-406). Fold any opacity factor into
  the `globalAlpha` set per-case (or a single multiply before dispatch).
- **Panel:** a loop-effect section in [PropertiesPanel.tsx](src/components/PropertiesPanel.tsx) modeled on
  `EffectFields`; wire through the existing `updateData`/remember helper so param edits are single undo
  entries. It edits `obj.loop` directly (a `TimelineObject` field), so it uses `UPDATE_OBJECT`, not the
  `text.effect` channel path.
- **No keyframes.ts / export / camera changes.** The only renderer edit is the `drawObject` block; `time`
  already flows.
- **Suggested order:** (1) types + `applyLoopEffect` + transform kinds (zoom/spin/sway/bob/warble/pulse)
  + panel picker; (2) `rainbow` (ctx.filter) + polish defaults. Verify per `.claude/skills/verify`
  (static `npx tsc -b` only), then hand the user a "click X, look for Y" checklist covering AC1–AC5. Do
  **not** run the dev server / browser.

## Gotchas / risks

- **Selection box does not track the modulation** (R3.3) — intentional and matches text warble/pulse. If
  it ever needs to (e.g. so resize handles hug a zoomed-in-loop image), the overlay would need the same
  modulation applied, which reintroduces the "mirror the transform in the overlay" problem the camera
  spec avoided. Keep un-mirrored in v1.
- **`ctx.filter` cost.** `hue-rotate` on a full image per frame is cheap but non-zero; note it for
  export (many frames). Only the `rainbow` kind pays it.
- **`spin` + a non-square bbox** rotates the whole draw rect; for `photo`/`video` (object-fit cover) this
  is fine, but a rotating rectangle/text may clip differently than expected — acceptable, it's the same
  as animating `rotation` via keyframes.
- **Don't double-apply opacity** — if `pulse` folds into `globalAlpha`, make sure it multiplies the
  existing `style.opacity * progress` rather than replacing it.

---
*This specification is ready for implementation. Use `/task 36-image-effects` to begin development.*

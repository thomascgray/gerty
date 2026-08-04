# 36 — Image effects (per-object continuous "loop" animations)

**Status**: In Progress

## Overview

Add an opt-in per-object **loop effect**: a continuously-running ambient animation that plays for an
object's whole lifetime and is applied ON TOP of the keyframe-resolved pose. Generalizes the spec-19
text `warble`/`pulse` (glyph-level ctx transforms driven by clip-relative `time`) up to object level so
photos, video, shapes, etc. can oscillate-zoom, spin, sway, bob, 3D-warble, pulse, shake, or hue-cycle.

Spec: [SPECS/36-image-effects.md](../SPECS/36-image-effects.md).

## Task Context

- **Governing constraint (R-DET):** `renderFrame` is the single pure compositor shared by preview +
  export. Every effect must be a pure fn of `(object, clip-relative time)` — no wall clock, no unseeded
  `Math.random`, no GPU. `drawObject` ALREADY receives `time` (clip-relative), threaded for spec 19.
- **The one change point:** `drawObject` in [src/lib/renderer.ts:665-745](../src/lib/renderer.ts#L665) —
  insert a modulation block right after the base rotation (`renderer.ts:693-697`) and before the
  `switch (obj.type)`. All inside the existing `ctx.save()/restore()` so nothing leaks.
- **Reuse the text math:** `warble` affine = [annotations.ts:407-423](../src/lib/annotations.ts#L407);
  `pulse` oscillator = [annotations.ts:395-406](../src/lib/annotations.ts#L395).
- **rainbow** = `ctx.filter = 'hue-rotate(<deg>deg)'` before the dispatch — independent of the spec-23
  render-wide filter (different scope/phase; don't conflate with the static spec-23 `hue` grade).
- **shake determinism:** offset seeded from a hash of `time`, NOT `Math.random` (spec-23 grain pattern).
- **Composition:** applied AFTER `resolveRenderPose` (keyframes + enter/exit). No changes to
  `keyframes.ts`, camera, or export paths. Loop transforms nest inside the per-object camera transform.
- **Selection box stays on the un-modulated pose** (`resolvePose`) — hit-test/drag track the keyframe
  pose, not the wobble. Same precedent as text warble/pulse. Intentional.
- **Persistence:** `loop?` lives on `TimelineObject`, so it flows through `UPDATE_OBJECT` /
  `DUPLICATE_OBJECT` / project JSON / `.gerty` / undo for free (flat record, no special clone).
- **Panel precedent:** model the picker on `EffectFields` (spec-19 text effect UI) in
  [PropertiesPanel.tsx](../src/components/PropertiesPanel.tsx) / propertyControls.tsx. But it edits the
  `obj.loop` TimelineObject field via `UPDATE_OBJECT`, NOT the `text.effect` channel path.
- **Verify:** static only — `npx tsc -b`. Do NOT run dev server / browser (per .claude/skills/verify).

### Decisions (from spec session)
- Scope: ALL visual object types (audio excluded).
- Single `loop?` per object (no stacking in v1).
- Ship all 8 kinds: zoom, spin, sway, bob, warble, pulse, shake, rainbow.
- Raw `speed`/`amount` sliders with per-kind defaults (not curated presets).
- Field name: `loop` (leaning; slightly overloads "clip looping" but concise).

## Blockers/Issues

None currently.

## TODO

[X] Types: add `LoopEffect` union + `LoopEffectKind` + `TimelineObject.loopEffect?` in src/types.ts
    - Named `loopEffect` (not `loop`) to avoid clash with existing `PhotoData.loop` (GIF playback).
    - `spin` + `rainbow` are `{speed}` only; the rest are `{speed, amount}`.
[X] Renderer: `applyLoopEffect(ctx, loop, time, bx,by,bw,bh)` helper in new src/lib/loopEffects.ts
    (transforms + filter, returns opacity multiplier; deterministic value-noise for shake)
[X] Renderer: call it in `drawObject` after base rotation, before the type switch; fold pulse opacity
    into `effStyle` so it covers every object type uniformly
[X] Implement all 8 kinds with sensible per-kind defaults (zoom/spin/sway/bob/warble/pulse/shake/rainbow)
[X] Panel: `LoopFields` picker (kind dropdown + speed/amount sliders) in a "Motion" accordion for
    non-audio objects, wired via `update({ loopEffect })` (UPDATE_OBJECT — one undo/edit)
[X] Per-kind default factory (`DEFAULT_LOOP_EFFECT`) seeds params when switching kind
[X] `npx tsc -b` green
[ ] Hand user a "click X, look for Y" verification checklist (AC1–AC5) — below; awaiting user browser test

## Work Log

[2026-08-04] Implemented spec 36 — per-object continuous "loop" (motion) effects end to end.

- `src/types.ts`: added `LoopEffect` union (zoom/spin/sway/bob/warble/pulse/shake/rainbow) +
  `LoopEffectKind` + `TimelineObject.loopEffect?`.
- `src/lib/loopEffects.ts` (new): `applyLoopEffect()` — pure fn of clip-relative time; ctx transforms
  for the geometric kinds (reuses the text-warble affine + pulse oscillator), `ctx.filter` hue-rotate
  for rainbow, deterministic value-noise jitter for shake (no Math.random). Returns an opacity
  multiplier (only pulse dims).
- `src/lib/renderer.ts`: import + call in `drawObject` right after the base rotation and before the
  type dispatch, inside the existing save scope; folds the returned opacity into `effStyle` used by
  every case. Zero signature change (`time` already flowed for spec 19).
- `src/components/propertyControls.tsx`: `LOOP_EFFECT_KINDS` / `LOOP_EFFECT_LABELS` /
  `DEFAULT_LOOP_EFFECT` + `LoopFields` component (dropdown + speed/amount sliders).
- `src/components/PropertiesPanel.tsx`: "Motion" accordion (IconArrowsMove) for all non-audio objects,
  wired through `update({ loopEffect })`.
- No changes needed to keyframes.ts / camera / export / DUPLICATE_OBJECT (flowed through the shared
  compositor + `...original` spread). `npx tsc -b` green.

[2026-08-04] Side change (user request, tangential to spec 36): keyframes are now created ONLY by the
`+ Keyframe` button / ◆ toggle. `editChannel` no longer auto-creates a keyframe on an off-keyframe edit
of an already-animated channel — it edits the base value instead. Removes the "scrub + nudge spawns
keyframes" annoyance.

- `src/lib/keyframes.ts`: `editChannel` — off-keyframe edits all route to `base`; the keyframe-creation
  branch is gone (on-keyframe merge unchanged). Removed the now-unused `animated` lookup.
- `CLAUDE.md`: updated the three passages that described the old auto-create as intentional (editPose
  primitive bullet, Canvas-interaction paragraph, Gotchas bullet).
- `npx tsc -b` green.

# 37 — Stacked effects

**Status**: In Progress

## Overview

Make three single-slot effect surfaces stackable:
1. **Object motion / loop effects** — `TimelineObject.loopEffect?` → `loopEffects?: LoopEffect[]` (motivating case: shake AND bob).
2. **Text glyph effects** — `TextData.effect?` → `TextData.effects?: TextEffect[]`.
3. **Full-screen video effects** — `VideoEffect` becomes a **container** with a shared envelope + `layers: EffectLayer[]`. Left rail's 22 buttons collapse to one "Full screen effect" entry; presets build one stacked container.

Hard requirement: old saved projects (localStorage + `.gerty`) load unchanged; a pre-37 single effect = the first layer of the new stack.

Full spec: [SPECS/37-stacked-effects.md](../SPECS/37-stacked-effects.md).

## Task Context

### Decisions locked (spec session 2026-08-04)
- **OQ1 Full-screen envelope → SHARED** per container; each layer keeps own peak intensity + params.
- **OQ2 Text keyframing → FIRST LAYER ONLY** (`effects[0]` via existing `text.effect` channel); rest static.
- **OQ3 Reorder → YES** in v1 for all three stacks (order is meaningful everywhere).
- **OQ4 `VideoEffect` reshape → IN-PLACE** (add `layers`, keep legacy top-level fields optional, normalize on load).
- **OQ5 Text stack combine → GROUPED LAST-WINS** (cross-group combine; within a conflicting group last layer wins). Not arbitrary N-of-a-kind.
- **OQ6 Normalization → ON LOAD + tolerant render helpers** (`loopEffectsOf`/`textEffectsOf`/`layersOf`).
- **OQ7 "Full screen effect" creation → CREATE empty container + OPEN add-layer picker.**

### Choke points (change once, everything follows)
- **#1** `drawObject` [renderer.ts:706-709](../src/lib/renderer.ts#L706-L709) — single `if (obj.loopEffect)` → loop over stack; accumulate opacity multiplier; concatenate filters into one `ctx.filter`.
- **#2** `drawText` [annotations.ts:343-543](../src/lib/annotations.ts#L343-L543) — single `switch(effect.kind)` → ordered passes (grouped last-wins).
- **#3** `resolveEffects` [effects.ts:46-77](../src/lib/effects.ts#L46-L77) — iterate containers; eased envelope factor × each layer.intensity → push a `ResolvedEffect` per layer. `renderFrame`/`effectsToFilterString`/WebGL branch/export paths UNCHANGED (they consume `ResolvedEffect[]`).

### Key files
- Types/factories: [src/types.ts](../src/types.ts)
- Renderer: [src/lib/renderer.ts](../src/lib/renderer.ts), [src/lib/annotations.ts](../src/lib/annotations.ts), [src/lib/loopEffects.ts](../src/lib/loopEffects.ts)
- Resolver/presets: [src/lib/effects.ts](../src/lib/effects.ts), [src/lib/effectPresets.ts](../src/lib/effectPresets.ts)
- Reducer: [src/hooks/useProject.ts](../src/hooks/useProject.ts) (ADD_EFFECT/ADD_EFFECTS/UPDATE_EFFECT(_TRANSIENT)/REMOVE_EFFECT ~L244-258)
- Keyframes: [src/lib/keyframes.ts](../src/lib/keyframes.ts) (`text.effect` channel L164-166) — first-layer keyframing
- UI: [PropertiesPanel.tsx](../src/components/PropertiesPanel.tsx) (LoopFields ~L667, EffectFields ~L681, VideoEffect editor ~L1257), [LeftRail.tsx](../src/components/LeftRail.tsx) (Effects L131-170), [Timeline.tsx](../src/components/Timeline.tsx) (EFFECT_BAR_LABEL L75, layoutEffectRows L106, drag L546-561), [App.tsx](../src/components/App.tsx) (onCreateEffect/onApplyPreset/selectedEffect L159), [propertyControls.tsx](../src/components/propertyControls.tsx) (LoopFields/EffectFields)
- Persistence: [src/lib/projectStorage.ts](../src/lib/projectStorage.ts) — normalization-on-load point

### Conventions
- Verify with `npx tsc -b` only. **Do NOT run dev server / browser** (`.claude/skills/verify`). Hand user a "click X, look for Y" checklist.
- No em-dash in copy. No per-pixel Canvas2D effects (stay in glEffects.ts).
- Reducer shallow-merges `UPDATE_OBJECT`/`UPDATE_EFFECT`; pass whole arrays (`loopEffects`/`data.effects`/`layers`) like `keyframes`/`data` today.

## Blockers/Issues

None currently.

## TODO

Build order (per spec Implementation Notes):

**Phase 1 — types + normalization + resolveEffects (unblocks #3 render, no downstream changes)**
[X] Types: `TimelineObject.loopEffects?`, `TextData.effects?`, `EffectLayer` + `VideoEffect` container reshape (legacy fields optional)
[X] Reading helpers: `loopEffectsOf(obj)`, `textEffectsOf(data)`, `layersOf(effect)`
[X] Normalization on load (projectStorage loadProject + importProjectBrep): legacy singular → stack
[X] `resolveEffects` flattens containers → `ResolvedEffect[]` (envelope factor × layer.intensity)
[X] `createEffectLayer` (per-kind defaults) + `createVideoEffect` (container) factories
[X] `npx tsc -b` green

**Phase 2 — #1 object loop stack (smallest, self-contained)**
[ ] `drawObject` loops the stack; opacity multipliers multiply; filters concatenate
[ ] `applyLoopEffect` refactor for filter accumulation (assign ctx.filter once)
[ ] Panel: LoopFields → stack editor (add/remove/reorder, per-layer params)
[ ] `npx tsc -b` green

**Phase 3 — #3 full-screen UI**
[X] Left rail: 22 buttons → single "Full screen effect" entry (Camera zoom kept)
[X] `onCreateEffect()` creates empty container; panel opens add-layer picker when empty (OQ7)
[X] Panel `EffectEditor` → stack editor (`LayerFields` per layer + reorder/hide/remove + add picker + shared envelope)
[X] Timeline: one bar per container; `effectBarLabel` lists the stack ("CRT + Halftone")
[X] Presets → build ONE container (`buildPresetEffect`, ADD_EFFECT)
[X] `npx tsc -b` green

**Phase 2 — #1 object loop stack (smallest, self-contained)** [done]
[X] `drawObject` loops the stack; opacity multipliers multiply; filters concatenate
[X] `applyLoopEffect` returns `{ alpha, filter }`; caller assigns ctx.filter once
[X] Panel: `LoopFieldsStack` (add/remove/reorder, per-kind params) in the Motion section
[X] `npx tsc -b` green

**Phase 4 — #2 text stack (riskiest, do last)**
[X] `drawText` iterates `textEffectsOf(data)` (grouped last-wins: decoration + transform + fill + per-glyph; glitch = collected `glitchEffect`, last wins)
[X] Panel: `EffectFieldsStack` (add/remove/reorder) in the text Effects section
[X] First-layer keyframing preserved (`text.effect` channel reads/writes `effects[0]` via textEffectsOf)
[X] `npx tsc -b` green

**Wrap**
[X] Full `npx tsc -b` green
[X] DUPLICATE_OBJECT deep-clones `loopEffects` (data.effects already cloned via data)
[X] Changelog v1.2.2 entry
[ ] User runs the AC1-AC5 browser checklist (below)

## Work Log

[2026-08-04] Task created from SPECS/37-stacked-effects.md (spec ready, 7 OQs resolved).

[2026-08-04] Phase 1 + Phase 3 (full-screen effect stack, end to end). tsc green.
- `src/types.ts`: added `loopEffects?`/`effects?` (+ kept legacy `loopEffect`/`effect`), new `EffectLayer` type, reshaped `VideoEffect` to a container (`layers` + envelope, legacy top-level fields optional). New factories `createEffectLayer` (per-kind defaults) + `createVideoEffect` (container). New `loopEffectsOf`/`textEffectsOf`/`layersOf` readers + `normalizeVideoEffect`/`normalizeProject` (legacy → stack on load).
- `src/lib/effects.ts`: `resolveEffects` now flattens containers → `ResolvedEffect[]` via a shared `envelopeFactorAt` × each layer's peak intensity. Renderer / filter-string / WebGL / export paths unchanged.
- `src/lib/effectPresets.ts`: `EffectSpec` options are layer-level; `buildPresetEffect` builds ONE container.
- `src/lib/projectStorage.ts`: `normalizeProject` on localStorage load + `.gerty` import.
- `src/components/App.tsx`: `handleCreateEffect()` creates an empty container; `handleApplyPreset` uses `buildPresetEffect` + ADD_EFFECT.
- `src/components/PropertiesPanel.tsx`: split old EffectEditor into `LayerFields` (per-layer Intensity + per-kind params) + container `EffectEditor` (layer list w/ reorder/hide/remove, add-effect picker, shared Timing envelope, delete).
- `src/components/LeftRail.tsx`: 22 effect buttons → single "Full screen effect" entry; removed now-unused EFFECT_ICON import.
- `src/components/Timeline.tsx`: `effectBarLabel(effect)` labels a bar from its layer stack.

[2026-08-04] Phase 2 (object loop stack). tsc green.
- `src/lib/loopEffects.ts`: `applyLoopEffect` now returns `{ alpha, filter }` (rainbow returns a filter fragment instead of setting ctx.filter) so a stack composes.
- `src/lib/renderer.ts`: `drawObject` loops `loopEffectsOf(obj)` - transforms compose, alphas multiply, filter fragments concatenate into one ctx.filter.
- `src/components/propertyControls.tsx`: extracted `LoopEffectParams`; added `LoopFieldsStack` (reorder/remove + add picker); removed the single `LoopFields`.
- `src/components/PropertiesPanel.tsx`: Motion section uses `LoopFieldsStack` over `loopEffectsOf(obj)`.
- `src/hooks/useProject.ts`: DUPLICATE_OBJECT deep-clones `loopEffects`.

[2026-08-04] Phase 4 (text effect stack). tsc green.
- `src/lib/annotations.ts`: `drawText` iterates `textEffectsOf(data)` with grouped last-wins (fill/shadow/per-glyph last-wins; pulse/warble compose; glitch collected into `glitchEffect`, last wins in the paint tail).
- `src/lib/keyframes.ts`: `text.effect` channel read/write now target `effects[0]` via `textEffectsOf` (OQ2: first-layer keyframable; old keyframed text still animates).
- `src/components/propertyControls.tsx`: extracted `TextEffectParams`; added `EffectFieldsStack`; removed the single `EffectFields`.
- `src/components/PropertiesPanel.tsx`: text Effects section uses `EffectFieldsStack` over `textEffectsOf(data)`; removed the unused `TextEffect` import; keyed `EffectEditor` by id.
- `src/changelog.ts`: v1.2.2 entry.

Known v1 limitation (OQ2): text-effect keyframe AUTHORING is not surfaced in the new stack UI (the old channel dot/+keyframe on text.effect is gone). Existing keyframed text still PLAYS correctly. Re-editing effects[0] via the panel while it is keyframed edits the base (the keyframe still overrides at render) - same "park on a keyframe to change it" model as elsewhere, but not routed through editChannel here.

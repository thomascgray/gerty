# 37-stacked-effects — stack multiple effects everywhere

## Overview

Three effect surfaces in the app are currently **single-slot** — you may attach at most one:

| # | Surface | Today's field | Added by | Consumed by |
|---|---|---|---|---|
| 1 | **Object motion / loop effect** (spec 36) | `TimelineObject.loopEffect?: LoopEffect` | `PropertiesPanel` `LoopFields` | `applyLoopEffect` in `drawObject` |
| 2 | **Text glyph effect** (spec 19) | `TextData.effect?: TextEffect` | `PropertiesPanel` `EffectFields` (`text.effect` channel) | `drawText` |
| 3 | **Full-screen video effect** (spec 23-25) | `Project.effects?: VideoEffect[]` — but each entry is **one** kind with its own timeline envelope | `LeftRail` Effects section (22 buttons + presets) | `resolveEffects` → `renderFrame` post-process |

This spec makes all three **stackable**:

- **Objects** can carry several loop effects at once (the motivating case: `shake` **and** `bob` on a photo).
- **Text** can carry several glyph effects at once (e.g. `outline` + `wave` + `rainbow`).
- **Full-screen effects** change shape: instead of N independent single-kind bars on the timeline, there is **one timeline object (a "Full screen effect") that contains a stack of effect layers** (e.g. CRT + Halftone + Grain), sharing one envelope. Each layer keeps its own params exactly as today. The left rail's 22 individual effect buttons collapse into a single **"Full screen effect"** entry; presets still exist but now build **one** stacked object instead of N separate ones.

**Hard back-compat requirement (user):** old saved projects (`localStorage` + `.gerty` imports) must load unchanged. Any pre-37 single effect is read as **the first (and only) layer** of the new stack.

## The governing constraint (read first)

`renderFrame` is the single pure compositor shared by preview and export (CLAUDE.md). Every effect, stacked or not, must stay a **deterministic pure fn of `(object/effect, time)`** — no wall clock, no unseeded `Math.random`, no per-frame `getImageData` for per-pixel kinds (those stay in `glEffects.ts`). Stacking must not break this: it is just "apply the same pure functions N times, in a defined order." Preview and exported MP4 stay pixel-identical by construction.

## Requirements

### R0 — Back-compat & determinism (blocking)
- **R0.1** Any project saved before this spec loads and renders identically. A pre-37 `loopEffect` / `TextData.effect` / single-kind `VideoEffect` is normalized to a one-element stack; nothing about its rendering changes.
- **R0.2** `.gerty` export/import round-trips the new stacked shape, and (still) accepts the legacy shape on import.
- **R0.3** Undo/redo, `DUPLICATE_OBJECT`, and split continue to work (stacks live on the same objects/records that already flow through those paths).
- **R0.4** Preview == export for every stacked combination, at 30 and 60 fps.

### R1 — Object loop-effect stack
- **R1.1** `TimelineObject` carries an ordered **list** of loop effects. Absent/empty ⇒ rendered exactly as today (no-op).
- **R1.2** All effects in the stack apply **on top of** the keyframe/transition-resolved pose, composed in list order, still inside the single per-object `ctx.save()/restore()` in `drawObject`.
- **R1.3** Composition rules across the stack:
  - Transform kinds (`zoom`/`spin`/`sway`/`bob`/`warble`/`pulse`/`shake`) compose as successive `ctx` transforms (so `shake` + `bob` = both offsets applied).
  - Opacity multipliers (only `pulse`) **multiply together** into the effective alpha.
  - `rainbow` sets `ctx.filter`; multiple filter-setting effects must **concatenate into one filter string** (last-write-wins would drop earlier ones — see Technical Considerations).
- **R1.4** Hit-testing / selection box / drag keep using the un-modulated resolved pose (unchanged from spec 36 R3.3).
- **R1.5** Panel: add / remove / (reorder — see OQ3) loop effects; each with its own kind + `speed`/`amount` params, editing live during playback, one undo entry per edit.

### R2 — Text glyph-effect stack
- **R2.1** `TextData` carries an ordered **list** of text effects. Absent/empty ⇒ plain fill (today).
- **R2.2** `drawText` applies the stack with a **defined precedence** so effects that touch the same channel don't silently clobber each other (see Technical Considerations "Text stack ordering"). Multiple effects that genuinely combine (e.g. `outline` + `wave` + `rainbow`) all take effect.
- **R2.3** Keyframing (`text.effect` channel, spec 29): **only the first layer** (`effects[0]`) is keyframable via the existing channel; the rest are static (OQ2). Old single-effect keyframe projects animate exactly as before.
- **R2.4** Panel: add / remove / reorder text effects; each with its own params; one undo entry per edit; live update.

### R3 — Full-screen effect stack (the biggest change)
- **R3.1** A **Full screen effect** is one timeline object that owns a **shared envelope** (`startTime` / `transitionIn` / `hold` / `transitionOut` / `easing`) and an ordered **list of effect layers**. Each layer = `{ kind, intensity, per-kind params, hidden? }` — the same per-kind data carried today.
- **R3.2** The shared envelope eases a factor 0→1 (ease-in → hold → ease-out); each layer contributes `layer.intensity × envelopeFactor` as its resolved intensity. So the whole stack fades in/out together, but each layer keeps its own peak strength and params. (Per-layer independent envelopes are OQ1.)
- **R3.3** `resolveEffects` flattens the active containers' layers into the existing `ResolvedEffect[]` in a deterministic compose order (container order, then layer order within a container). **Downstream is unchanged** — `renderFrame`, `effectsToFilterString`, the overlay branch, and the WebGL branch all keep consuming `ResolvedEffect[]`.
- **R3.4** Left rail: the 22 per-kind buttons collapse into a single **"Full screen effect"** entry. Adding layers to the stack happens **in the panel** (an "add effect" kind picker on the selected Full screen effect). Presets remain in the rail; applying one now creates **one** Full screen effect whose layers are the preset's stack (one undo entry).
- **R3.5** Timeline: a Full screen effect shows as **one bar** on the Effects track (not one bar per kind). Envelope drags (move / resize left / resize right) operate on the container, exactly as the single-effect bar does today. The layer count / kinds are shown on/under the bar (label lists the stack).
- **R3.6** Panel: the effect editor becomes a **stack editor** — the shared envelope + timing controls, then a list of layers each with its kind header, its per-kind params, a remove control, and a per-layer hide toggle; plus an "add effect" picker. Reorder per OQ3.
- **R3.7** Selection: `selectedEffectId` now selects a **container**; the panel edits its stack. (Multi-select of containers on the timeline keeps working as today.)

### R4 — Consistency
- **R4.1** The three stack editors should feel the same (add / remove / reorder / per-layer params) even though they live in different panel sections and edit different data.

## Technical Considerations

### Relevant types (current → proposed)

All three are **additive**: keep the legacy singular field readable, add the new plural/stack field, normalize on load.

**#1 Loop effects** — [src/types.ts:31](src/types.ts#L31), [src/types.ts:178-188](src/types.ts#L178-L188)
```ts
// TimelineObject
loopEffects?: LoopEffect[]   // NEW (spec 37) — ordered stack; applied in order in drawObject
loopEffect?: LoopEffect      // LEGACY (spec 36) — read-only fallback; normalized → loopEffects[0]
```
`LoopEffect` union itself is unchanged.

**#2 Text effects** — [src/types.ts:190-200](src/types.ts#L190-L200)
```ts
// TextData
effects?: TextEffect[]   // NEW (spec 37) — ordered stack
effect?: TextEffect      // LEGACY (spec 19) — read-only fallback; normalized → effects[0]
```
`TextEffect` union unchanged.

**#3 Full-screen effects** — [src/types.ts:376-402](src/types.ts#L376-L402)
```ts
// A single effect within a Full screen effect stack: the kind + strength + per-kind payload
// (everything that is NOT the timeline envelope). Mirrors the old top-level VideoEffect fields
// minus startTime/transitionIn/hold/transitionOut/easing.
export type EffectLayer = {
  id: string
  kind: VideoEffectKind
  intensity: number          // 0-1 peak; scaled by the container's eased envelope factor
  hidden?: boolean           // hide this one layer without deleting it
  // per-kind payloads (same optional set as today's VideoEffect):
  vignette?: VignetteParams; oldfilm?: OldFilmParams; hue?: HueParams;
  lightleak?: LightLeakParams; chromatic?: ChromaticParams; gradientmap?: GradientMapParams;
  posterize?: PosterizeParams; threshold?: ThresholdParams; channelswap?: ChannelSwapParams;
  colorisolate?: ColorIsolateParams; dither?: DitherParams; crt?: CrtParams;
  vhs?: VhsParams; halftone?: HalftoneParams; comic?: ComicParams;
}

// VideoEffect becomes a CONTAINER: a shared timeline envelope + a stack of layers.
export type VideoEffect = {
  id: string
  layers: EffectLayer[]      // NEW — the stack (>=1 entry after normalization)
  startTime: number; transitionIn: number; hold: number; transitionOut: number; easing: EasingKind
  hidden?: boolean           // hides the whole container
  // LEGACY (pre-37) top-level fields kept OPTIONAL on the type for load tolerance, never written:
  kind?: VideoEffectKind; intensity?: number
  vignette?: VignetteParams; /* …all the pre-37 payload fields… */
}
```
`ResolvedEffect` ([src/types.ts:406-424](src/types.ts#L406-L424)) is **unchanged** — the resolver still emits a flat list of resolved single-kind effects.

- **Decision needed (OQ4): in-place reshape of `VideoEffect`** (above — add `layers`, keep legacy fields optional) **vs a new `FullScreenEffect` type** with a load-time migration. In-place is less churn for the Timeline envelope-drag code (envelope fields stay put) and the reducer.

### Where each plugs in (choke points)

- **#1** `drawObject` [renderer.ts:706-709](src/lib/renderer.ts#L706-L709): replace the single `if (obj.loopEffect)` with a loop over the resolved stack, accumulating the opacity multiplier and concatenating filters. Reading helper: `loopEffectsOf(obj) = obj.loopEffects ?? (obj.loopEffect ? [obj.loopEffect] : [])`.
- **#2** `drawText` [annotations.ts:343-543](src/lib/annotations.ts#L343-L543): today a single `switch (effect.kind)`. Restructure into ordered passes (see below). Reading helper `textEffectsOf(data)` with the same fallback.
- **#3** `resolveEffects` [effects.ts:46-77](src/lib/effects.ts#L46-L77): iterate containers; for each non-hidden container compute the eased envelope factor once (`intensityAt` refactored to return the 0-1 factor), then for each non-hidden layer push a `ResolvedEffect { kind, intensity: layer.intensity * factor, ...payloads }`. **`renderFrame`, `effectsToFilterString`, the WebGL branch, and both export paths need no change** — they already consume `ResolvedEffect[]`. Compose order: container order (startTime then id, as today) then layer order.

### Loop-stack filter concatenation (#1 detail)
`ctx.filter` is a single string but accepts multiple functions (`"hue-rotate(30deg) blur(2px)"`). Multiple `rainbow` layers (or a future filter-based loop kind) must build one combined string, not overwrite. `applyLoopEffect` currently sets `ctx.filter` directly and returns an opacity multiplier; for stacking, refactor so the caller collects filter fragments across the stack and assigns `ctx.filter` once. (Alternatively `applyLoopEffect` reads+appends, but a single assignment at the end is cleaner.)

### Text stack ordering (#2 detail — the tricky one)
The current text effects fall into groups that touch different render state; stacking them needs a defined precedence so combining ones cooperate and conflicting ones have a clear winner:
- **Fill producers** (`gradient`, `rainbow`, `shimmer`) all set `fillStyle` — **last one in the stack wins** (only one fill can apply). Document this.
- **Decorations** (`glow`, `outline`, `shadow`) set shadow/stroke — can combine, but note `glow`/`shadow` both use `ctx.shadow*` (a second overwrites the first unless we render extra passes; v1: last shadow-setter wins, `outline` is independent).
- **Transforms** (`pulse`, `warble`) apply `ctx` transforms — compose.
- **Per-glyph** (`wave`) sets the per-glyph offset fn — one at a time (last wins) unless summed.
- **`glitch`** is a whole separate render path ([annotations.ts:537-543](src/lib/annotations.ts#L537-L543)) — decide whether it can coexist with the normal path or remains exclusive.

This is the riskiest rendering work in the spec. A realistic v1 may allow **decorations + one transform + one fill + one per-glyph** to combine and define last-wins within each conflicting group, rather than promising arbitrary N-of-a-kind stacking. Flagged in OQ5.

### Keyframe interaction (#2 detail)
`text.effect` is an animatable channel ([keyframes.ts:164-166](src/lib/keyframes.ts#L164-L166)) with bespoke `lerpEffect` interpolation (magnitude ramp + hand-over). Stacking + keyframing is a genuine design tension (OQ2). Loop effects and full-screen effects are **not** keyframable, so they don't have this problem.

### UI touchpoints
- `PropertiesPanel.tsx`: `LoopFields` block [~L667-L676](src/components/PropertiesPanel.tsx#L667-L676) (#1); `EffectFields` block [~L681-L686](src/components/PropertiesPanel.tsx#L681-L686) (#2); the `VideoEffect` editor [~L1257+](src/components/PropertiesPanel.tsx#L1257) (#3) becomes the stack editor. `EffectFields`/`LoopFields` live in `propertyControls.tsx`.
- `LeftRail.tsx` Effects section [L131-L170](src/components/LeftRail.tsx#L131-L170): collapse the 22 buttons → one "Full screen effect"; presets stay but call the new one-container builder.
- `Timeline.tsx`: `EFFECT_BAR_LABEL` [L75](src/components/Timeline.tsx#L75), `layoutEffectRows` [L106](src/components/Timeline.tsx#L106), envelope-drag handlers [L546-L561](src/components/Timeline.tsx#L546-L561) — a container is still one bar with one envelope, so these mostly stand; the bar label lists the stack.
- `App.tsx`: `onCreateEffect` / `onApplyPreset` / `selectedEffect` [L159](src/components/App.tsx#L159) wire to the container model.
- `useProject.ts`: `ADD_EFFECT` / `ADD_EFFECTS` / `UPDATE_EFFECT(_TRANSIENT)` / `REMOVE_EFFECT` [L244-L258](src/hooks/useProject.ts#L244-L258). May add layer-level actions (add/remove/reorder/update a layer within a container) or express them via whole-object `UPDATE_EFFECT` merges (the reducer shallow-merges, so passing a whole new `layers` array is the simplest — mirrors how `data`/`keyframes` are passed whole).
- `effectPresets.ts`: `buildPresetEffects` [L123-L127](src/lib/effectPresets.ts#L123-L127) returns one container.

### Determinism
Unchanged: all oscillators use `Math.sin/cos` of clip/global time; `shake`/grain/oldfilm/crt/vhs jitter is time-seeded (never `Math.random`); per-pixel kinds stay in `glEffects.ts` (no `getImageData` per frame).

## Related Systems and Tasks
- **spec 36** (loop effects) — [SPECS/36-image-effects.md](SPECS/36-image-effects.md). OQ2 there deferred stacking ("single loop effect per object in v1; stacking is a follow-up") — **this is that follow-up** for #1.
- **spec 19** (text effects) — [SPECS/19-text-effects.md](SPECS/19-text-effects.md). Same "single effect in v1" decision; #2 lifts it.
- **spec 23-25** (video effects + WebGL) + **spec 26** (presets) — [SPECS/23-more-effects.md](SPECS/23-more-effects.md), [SPECS/25-webgl-effects.md](SPECS/25-webgl-effects.md), [TASKS/26-effect-presets.md](TASKS/26-effect-presets.md). #3 restructures their data model without touching the render/WebGL paths.
- **spec 29** (keyframe channels) — [SPECS/29-keyframe-enhancements.md](SPECS/29-keyframe-enhancements.md). The `text.effect` channel is the one keyframe tension (OQ2).

## Open Questions

All resolved in the spec session (2026-08-04):

- **OQ1 — Full-screen envelope → SHARED.** One envelope per container; the whole stack fades in/out together; each layer keeps its own peak `intensity` + params. Independent timing = a second Full screen effect. (R3.2 stands.)
- **OQ2 — Text-effect keyframing → FIRST LAYER ONLY.** Only `effects[0]` stays keyframable via the existing `text.effect` channel (spec 29); the rest are static. Old single-effect keyframed projects are unaffected. (R2.3 stands.)
- **OQ3 — Reordering → YES**, in v1, for all three stacks (up/down or drag). Order is meaningful: full-screen compose order, text last-wins groups, motion transform order.
- **OQ4 — `VideoEffect` reshape → IN-PLACE.** Add `layers`, keep legacy top-level fields optional, normalize on load. Least churn for the timeline envelope-drag code and reducer.
- **OQ5 — Text stack combination → GROUPED LAST-WINS** for v1: effects across different groups combine (decoration + transform + fill + per-glyph); within a conflicting group (e.g. two fills), the **last layer wins**. Not arbitrary N-of-a-kind compositing. (See Text stack ordering.)
- **OQ6 — Normalization → ON LOAD + tolerant helpers.** Normalize legacy → stack at load (`projectStorage` / `SET_PROJECT`) so the app only sees stacks; render helpers (`loopEffectsOf`/`textEffectsOf`/`layersOf`) still fall back to the legacy field as belt-and-braces.
- **OQ7 — "Full screen effect" creation → CREATE + OPEN ADD-LAYER PICKER.** Clicking the rail entry creates an empty container at the playhead, selects it, and immediately opens the kind picker in the panel to pick the first layer.

## Acceptance Criteria
- **AC1 (R0):** A pre-37 project (with a `loopEffect`, a text `effect`, and several single-kind `VideoEffect`s) loads and renders pixel-identically; re-saving writes the new stacked shape; `.gerty` round-trips.
- **AC2 (R1):** A photo with `shake` **and** `bob` visibly does both at once; both persist through save / `.gerty` / undo / duplicate; preview == export.
- **AC3 (R2):** A text object with (per OQ5) `outline` + `wave` + a fill effect renders all three; edits are one undo each; preview == export.
- **AC4 (R3):** One Full screen effect containing CRT + Halftone + Grain shows as a **single** Effects-track bar, fades in/out with one envelope, and renders all three layers; a preset drops as one such object; per-layer hide/remove works; export matches preview.
- **AC5 (R3.4):** The left rail shows a single "Full screen effect" entry (plus presets); layers are added from the panel.
- **AC6:** `npx tsc -b` stays green.

## Implementation Notes
- **Suggested order:** (1) types + normalization helpers + `resolveEffects` container flatten (unblocks #3 render with no downstream changes); (2) #1 loop stack in `drawObject` (smallest, self-contained); (3) #3 UI — rail entry, panel stack editor, timeline bar label, presets → one container; (4) #2 text stack ordering + panel (riskiest — do last, guard with OQ5's grouped model); (5) keyframe decision (OQ2) polish.
- **Normalization helpers** (one place, e.g. a `normalizeProject`/`normalizeObject` in `projectStorage.ts` or `types.ts`): `loopEffect → loopEffects`, `TextData.effect → effects`, legacy `VideoEffect → { layers: [legacyLayer], envelope }`. Render-time reading helpers (`loopEffectsOf`, `textEffectsOf`, `layersOf`) as a fallback so an un-normalized object still renders.
- **Reducer:** simplest is to keep passing whole arrays through `UPDATE_OBJECT` (`loopEffects`/`data.effects`) and `UPDATE_EFFECT` (`layers`) since the reducer shallow-merges and these are self-contained arrays (like `keyframes`/`data` today). Add dedicated layer actions only if the whole-array path proves awkward.
- **Do NOT run the dev server / browser** (`.claude/skills/verify`): verify with `npx tsc -b`, then hand the user a "click X, look for Y" checklist covering AC1-AC5.

## Gotchas / risks
- **Text stack ordering** is the highest-risk area — several effects write the same `ctx` state (`fillStyle`, `ctx.shadow*`), and `glitch` is a separate render path. Keep v1 to the grouped last-wins model unless OQ5 says otherwise.
- **`resolveEffects` compose order** is load-bearing for deterministic output (filters concatenate, overlays stack). Keep it explicit: container order (startTime, id) then layer order.
- **Timeline `layoutEffectRows`** packs in creation order and freezes during drag (CLAUDE.md) — a container is one bar, so far fewer rows now; keep the freeze behavior.
- **Legacy field cleanup:** do NOT delete the singular legacy fields from the types until confident no persisted/`.gerty` file needs them on import; they cost nothing kept optional.

---
*This specification is ready for implementation. Use `/task 37-stacked-effects` to begin development.*

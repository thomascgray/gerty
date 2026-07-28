# 29-keyframe-enhancements

**Status**: In Progress

## Overview

Normalise what a keyframe can animate. Today `Keyframe.pose` is a fixed 6-number snapshot
(`x/y/width/height/rotation/opacity`) and nothing else animates — colour, line width, font size,
the text content itself, and text effects are all static for the clip's whole life. The inspector
compounds this by turning the *entire* panel the keyframe's colour, implying everything there is
animated when only Position is.

Three coupled changes (see [SPECS/29-keyframe-enhancements.md](../SPECS/29-keyframe-enhancements.md)):

1. **Channel registry** — a single table of animatable properties (pose + style + type-specific
   data) with a per-channel interpolation rule, replacing the hardcoded 6.
2. **Sparse keyframes** — `Keyframe.props` declares only the properties actually changed; each
   property resolves as an independent track.
3. **Per-section/per-field indicators** + an **animated text-content morph** (L→R per-glyph wipe).

## Task Context

- **Spec**: [SPECS/29-keyframe-enhancements.md](../SPECS/29-keyframe-enhancements.md) — all Qs resolved.
- **Predecessors**: `SPECS/12-keyframe-easing-engine.md` (the whole-pose model being generalised),
  `SPECS/21-animation-rethink.md` (`leadIn` + 7-preset easing — the morph reuses both verbatim),
  `SPECS/19-text-effects.md` (`TextEffect` union + the per-glyph draw loop the morph reuses).
- **Verification**: `npx tsc -b` only. **Never** run the dev server or browser automation
  (`.claude/skills/verify/SKILL.md`) — the user tests in the browser and gets a click-X-look-for-Y list.
- **`UPDATE_OBJECT` shallow-merges** (`{...o, ...updates}`) so nested `data`/`style`/`keyframes`
  must be passed **whole**. Channel `write` accessors return update objects, never mutations.
- **Back-compat rule**: a legacy keyframe (`pose`, no `props`) reads as "declares all six pose
  channels". No migration, no persistence change. An object with no keyframes must render
  pixel-identically to today.
- **Perf**: `resolvePose` runs once per visible object per frame inside `renderFrame`, and the panel
  re-renders at 60 Hz during playback — channel resolution must not allocate per field per frame.

### Key files

| Area | File |
|---|---|
| Types | `src/types.ts` (`AnimatableChannel`, `ChannelValue`, `Keyframe.props`) |
| Engine | `src/lib/keyframes.ts` (registry, `channelValueAt`, `animatedChannels`, `editChannel`, `textMorphAt`) |
| Colour lerp | `src/lib/color.ts` (new) |
| Render | `src/lib/renderer.ts` (pass `TextMorph`), `src/lib/annotations.ts` (`drawText` morph branch) |
| Panel | `src/components/PropertiesPanel.tsx`, `src/components/propertyControls.tsx` (`KeyframeDot`) |
| Timeline | `src/components/Timeline.tsx` (hollow diamond for style-only keyframes, R22) |
| Reducer | `src/hooks/useProject.ts` (`SPLIT_OBJECT` continuity pin over all animated channels) |
| Untouched | `src/components/Canvas.tsx`, `ContextToolbar.tsx` — `editPose` keeps its signature |

## Blockers/Issues

None currently.

## Deviations from the spec (decided during implementation)

1. **`text.padding` dropped from the registry.** No padding field exists in the inspector or the
   context toolbar, so the channel would have been unreachable — you could never opt it in. The
   layout knobs that *are* reachable (`cornerRadius`, `autoSize`) cover the visual need.
2. **`text.autoSize` and `arrow.progressiveHead` are NOT channels.** Both are modes rather than
   looks: `autoSize` toggling mid-clip would fight the morph's font-size locking (R13a), and
   `progressiveHead` only affects the `animateIn` draw-on reveal, which keyframes don't drive.
3. **Added a "Head size" field to the Arrow card.** `arrow.headSize` had no UI at all, so the
   channel needed a field to be reachable (same reasoning as #1, resolved the other way since it's
   a genuine look property).
4. **Absent optional values are STORED as `null`, normalised to `undefined` on read**
   (`storeValue` / `channelOf`). `JSON.stringify` drops undefined-valued keys, so a keyframe
   declaring "no background" or "no effect" would silently *un-declare* the channel on save/reload.
   Not in the spec — found while wiring the background checkbox.
5. **Refined R9 after user testing (2026-07-28).** As first built, a non-animated channel *always*
   edited the base — even when the playhead was parked exactly on a keyframe. Editing the text
   while on a keyframe therefore changed it for the whole clip, which reads as broken: the banner
   says "Keyframe 1" and the panel is tinted, so "changes land here" is the only sensible reading.
   Now: **on a keyframe → the edit is declared on that keyframe** (any property, animated or not);
   **anywhere else → unchanged R9 behaviour** (only already-animated channels keyframe; the rest
   edit the base). This still satisfies the original concern behind Q2 — a colour tweak at an
   arbitrary time never silently becomes an animation — while making a property animatable without
   hunting for its ◆.
6. **`ContextToolbar` had to change** (the spec assumed it wouldn't). It edits colour, background,
   bold/italic, align, font, size, line width and curvature — all now channels — but wrote the base
   directly, so on an animated property the keyframes would immediately override the edit and the
   toolbar would look broken. Added `editPatch` (a shared style/data-patch → channel router) and
   routed both its `updateStyle`/`updateData` through it. Its controls now also *read* from
   `resolvePose(obj, globalTime)` so swatches show what's on screen at the playhead.

## TODO

- [X] **1. Registry + generic resolution** (pure refactor, no visible change)
  - [X] `AnimatableChannel` / `ChannelValue` / `ChannelSpec` types
  - [X] `CHANNELS` table + `CHANNELS_BY_KEY` + `channelsFor(type)`
  - [X] Shared bracket helper (`segmentAt` — owns the spec-21 lead-in/easing formula once)
  - [X] `channelValueAt`, `animatedChannels`, `declaredChannels`
  - [X] `poseAt` re-expressed over the helper; `resolvePose` applies every animated channel
- [X] **2. Sparse `Keyframe.props` + `editChannel`**
  - [X] `props?` on `Keyframe`; legacy `pose` read path (`declares`/`channelOf`)
  - [X] `editChannel` (merge / base / insert), `editPose` as a thin wrapper
  - [X] `addKeyframeAt` writes the six pose keys into `props`
  - [X] `toggleChannel` — the ◆ opt-in/out (materialises legacy `pose` when un-declaring)
- [X] **3. Style channels + `lerpColor`**
  - [X] `src/lib/color.ts` — sRGB lerp, `rgba()` output for the transparent-background case, `toHexColor`
  - [X] colour / lineWidth / fontSize wired panel → resolver → renderer
- [X] **4. Panel indicators** (the step that fixes the reported confusion)
  - [X] `KeyframeDot` (off / animated / active) + `Field` `dot` slot
  - [X] `Accordion` section accent + summary dot; removed the full-panel ring; reworded the banner
- [X] **5. Text content + effect channels**
  - [X] `text.*` + `arrow.*` + discrete `step` channels in the registry
  - [X] `textMorphAt` + `drawText` per-glyph wipe (R13/R13a), threaded through `renderFrame`
- [X] **6. Correctness pass**
  - [X] `SPLIT_OBJECT` continuity pin covers every animated channel
  - [X] `DUPLICATE_OBJECT` independence — already `structuredClone`s keyframes, covers nested `props`
  - [X] Timeline hollow diamond for style-only keyframes (R22)
  - [X] `ContextToolbar` routed through `editPatch` (see Deviations #5)
  - [X] `npx tsc -b` green
- [ ] **7. User browser verification** — see the checklist handed over 2026-07-28

## Work Log

[2026-07-28] Implemented the whole spec — channel registry, sparse keyframes, indicators, text morph.

- **`src/types.ts`** — `AnimatableChannel` (flat dotted key space), `ChannelValue`, `Keyframe.props?`
  with `pose?` demoted to a read-only legacy fallback.
- **`src/lib/keyframes.ts`** (largely rewritten) — the `CHANNELS` registry (18 channels with
  label/section/interp/types/read/write); `segmentAt` as the ONE implementation of the spec-21
  lead-in + easing formula, now shared by every channel; `channelValueAt` / `animatedChannels`
  (WeakMap-cached by keyframe-array identity, so 60 Hz playback never rebuilds it) /
  `declaredChannels` / `declares` / `channelOf`; `resolvePose` generalised to apply every animated
  channel (early-returns the same object reference when nothing animates); `poseAt` re-expressed
  over the registry; `editChannel` + `editPose` wrapper + `toggleChannel` + `editPatch`;
  `textMorphAt`; `lerpEffect` (same-kind params lerp, cross-kind steps).
- **`src/lib/color.ts`** (new) — `parseColor`/`formatColor`/`lerpColor`/`toHexColor`. Absent side of
  a colour lerp ramps the other's alpha, so a keyframed text background fades in instead of popping.
- **`src/lib/annotations.ts`** — `drawText` layout/paint split into `renderText(lines, reveal,
  alphaFn)`; per-glyph alpha in `paintRun`; R13a font-size locking across a morph; `MORPH_FEATHER`.
- **`src/lib/renderer.ts`** — computes `textMorphAt` from the RAW object (the resolved copy has its
  content already collapsed to the held value) and threads it through `drawObject` → `drawText`.
- **`src/components/PropertiesPanel.tsx`** — `chan`/`setChan`/`dotFor`/`secProps`; every style, text,
  effect and arrow field re-pointed at channels; per-section accents; full-panel ring removed; banner
  now names the sections the keyframe governs; new Head size field.
- **`src/components/propertyControls.tsx`** — `KeyframeDot`; `Field` gained a `dot` slot.
- **`src/components/ContextToolbar.tsx`** — `updateStyle`/`updateData` routed through `editPatch`;
  controls read from `resolvePose(obj, globalTime)`.
- **`src/components/Timeline.tsx`** — hollow diamond + channel-listing tooltip for style/text-only
  keyframes.
- **`src/hooks/useProject.ts`** — `SPLIT_OBJECT` continuity pin now covers every animated channel
  (was pose-only) and writes `props` rather than legacy `pose`.

[2026-07-28] Two morph-continuity fixes after user testing.

- **Font-size jump** — R13a as specced (re-fit both strings to the smaller shared size) created a
  discontinuity: outside the morph the outgoing text draws at its own natural size, so it snapped
  the instant the morph began. Replaced with a **scale** morph: each string keeps its natural
  layout, and both are drawn under a uniform scale toward `targetSize = lerp(outSize, inSize, u)`,
  anchored on the aligned edge. Continuous at both boundaries (k=1 for the outgoing at u=0, for the
  incoming at u=1) and nothing re-wraps mid-morph. `renderText` now takes a whole layout.
  - Files: `src/lib/annotations.ts` (`layoutOf`, `targetSize`, `anchorX`, `renderText`).
- **Effect pop** — an effect appearing at a keyframe stepped on, snapping glyphs straight to their
  wave/pulse offsets. `lerpEffect` now ramps an appearing/disappearing effect's **magnitude** from
  or to 0 (`EFFECT_MAGNITUDE` + `scaleEffect`), over the same window as the text wipe. Kinds with no
  scalar magnitude (gradient/rainbow/shimmer) still step.
  - Files: `src/lib/keyframes.ts`.
- Spec updated: R13a revised, R13b added.

[2026-07-28] Generalised effect transitions to a hand-over (user-reported: wave → glow was harsh).

The previous rule only ramped when one side was ABSENT; two different real kinds still stepped.
Now every non-same-kind change is a hand-over — the outgoing effect's magnitude decays to 0 over the
first half of the segment, the incoming one grows from 0 over the second, kind swapping at the
midpoint where both are visually nothing. One rule now covers appear / disappear / switch, and
because only one effect is live at any instant it needs **no double-paint** in the renderer.

- Files modified: `src/lib/keyframes.ts` (`lerpEffect`), `src/lib/annotations.ts`.
- **`drawGlitchText` behaviour change**: its chromatic `split` had a constant floor
  (`2 + amt*5`), so glitch at amount 0 still showed ~2px of RGB fringing and the hand-over popped.
  Now multiplied by `amt` — identical at amount 1, subtler at partial amounts.
- **Known limit**: gradient / rainbow / shimmer have no scalar magnitude (their look is a fill, not
  a displacement) so they can't decay — they hand over at the midpoint. That's a colour change with
  no positional jump, so it reads far softer than the old kind-step. A true crossfade for those
  would need `drawText` restructured to paint the glyph loop twice (once per effect) with a blend
  alpha — deferred unless the midpoint swap turns out to be visible in practice.

[2026-07-28] Routed the ON-CANVAS text editor through `editChannel` too (user-reported).

Double-clicking a text object to edit it in the render frame (`commitTextEdit`, spec 18-qol R6) was
a third write path that still wrote `data.content` directly — so the same edit set the keyframe
from the inspector but silently rewrote the whole clip from the canvas. Editing the text is editing
the text; both must hit the same rules and flip the same ◆.

- Files modified: `src/components/Canvas.tsx` (`commitTextEdit` + `editChannel` import).
- The READ side was already correct — the double-click seeds from `resolvePose(raw, globalTime)`,
  so it opens with the keyframe's text.
- **Swept every other direct `data`/`style` dispatch** to confirm no fourth hole: the remaining ones
  are all properties with no channel by design — `points`/`strokes` (geometry), `muted`/`volume`
  (audio, spec 15), `loop` (animated photo), `autoSize`, `progressiveHead`.

Verified: `npx tsc -b` clean. `npx eslint` on all touched files reports only the 7 pre-existing
errors (spec-19/21 constant exports in `propertyControls.tsx`, spec-23 `frozenEffectLayoutRef` in
`Timeline.tsx`) — none introduced here.

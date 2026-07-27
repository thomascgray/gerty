# 26 — Effect Presets

**Status**: In Progress

## Overview

Add a **preset system**: named, developer-authored *stacks* of effects that drop with one click (e.g. "Super 8" = old film + grain + vignette + sepia; "Retro TV" = CRT + VHS). Presets are just a convenient starting point — they create ordinary `VideoEffect`s on the timeline that the user can then tweak or delete individually.

**UI direction (from user):** in the LeftRail Effects section, split the vertical column — **top half = raw effects** (the existing list of individual graphical effects), **bottom half = Presets** (named looks we've authored). Presets read as curated "named things"; raw effects are just raw graphical primitives.

## Task Context

**Builds on:** the spec-23/24/25 effect system. Effects are `Project.effects: VideoEffect[]`, created via `createVideoEffect(kind, options)`, resolved by `resolveEffects`, rendered in `renderFrame` (Canvas-2D filters/overlays + WebGL shader branch). A preset = a list of `{kind, options}` specs → N `VideoEffect`s at the playhead.

**Key files:**
- `src/hooks/useProject.ts` — reducer. `ADD_EFFECT` (single) exists (L237). Need **`ADD_EFFECTS`** (plural) so a whole preset is ONE undo entry (mirrors `ADD_OBJECTS` L214). Confirmed: any normal action = one history entry (outer reducer L188-199), so plural add = one undo.
- `src/types.ts` — `ProjectAction` union (add `ADD_EFFECTS`), `createVideoEffect(kind, options)`.
- NEW `src/lib/effectPresets.ts` — `EffectPreset` type + `EFFECT_PRESETS` catalog + `buildPresetEffects(preset, startTime): VideoEffect[]`.
- `src/components/App.tsx` — `handleApplyPreset(presetId)`: build effects at playhead → dispatch `ADD_EFFECTS` → select first (feedback). Mirrors `handleCreateEffect` (L351).
- `src/components/LeftRail.tsx` — `section === 'effects'`: currently one `SimpleSection title="Effects"`. Split into raw **Effects** + **Presets** `SimpleSection`s; new `onApplyPreset` prop.

**Design decisions:**
- Preset = pure data (`{id, name, description, effects: [{kind, options}]}`) — no functions, serializable. `options` is `Partial<Omit<VideoEffect,'id'|'kind'>>` (intensity/envelope/param payloads). All effects in a preset start at the playhead; longer default `hold` (~5s) so a dropped preset visibly covers a clip.
- Applying a preset = `ADD_EFFECTS` (one undo). Effects stack on the Effects track (it already lays overlapping effects into display rows). Fully editable/deletable afterward.
- Preset icons: small id→tabler-icon map in LeftRail (keeps effectPresets.ts free of React imports).

**Hard rules:** additive (no effect kinds change; presets just compose existing ones); `npx tsc -b` + `vite build` green; no browser automation (hand user a checklist).

## Blockers/Issues

None.

## TODO

[X] `types.ts`: add `ADD_EFFECTS` action
[X] `useProject.ts`: `case 'ADD_EFFECTS'`
[X] `effectPresets.ts`: `EffectPreset` type + `EFFECT_PRESETS` (7 presets) + `buildPresetEffects`
[X] `App.tsx`: `handleApplyPreset` + pass to LeftRail
[X] `LeftRail.tsx`: `onApplyPreset` prop + split into Effects + Presets sections
[X] `tsc -b` + `vite build` green
[ ] USER browser verification
[X] **Cinematic presets** — 2 new gradient-map ramps (`cinematic` teal/orange, `cinemacool` cool blue) + 2 presets (Cinematic, Cinematic Cool); wired through types/shader/panel dropdown
[X] **Effects menu layout** — raw Effects list capped to ~half height with its own scroll; Presets always visible below (own scroll)
[ ] USER browser verification of the Cinematic presets + the new menu layout

## Work Log

[2026-07-25] Task created. Preset system: developer-authored effect stacks, one-click apply as ADD_EFFECTS (one undo). UI = LeftRail Effects section split into raw Effects (top) + Presets (bottom).

[2026-07-25] Implemented the preset system. `tsc -b` + `vite build` green.
- **`types.ts`**: `ADD_EFFECTS` action (plural).
- **`useProject.ts`**: `case 'ADD_EFFECTS'` (appends all; one undo entry via the normal history path).
- **NEW `src/lib/effectPresets.ts`**: `EffectPreset` type + `EFFECT_PRESETS` (Super 8, Retro TV, Film Noir, Comic Book, Grimdark, Vaporwave, Night Vision) + `buildPresetEffects(preset, startTime)` (default hold 5s so a drop covers a clip). Pure data — composes existing effect kinds via `createVideoEffect`.
- **`App.tsx`**: `handleApplyPreset(presetId)` builds the stack at the playhead → `ADD_EFFECTS` → selects the first effect. Imports `EFFECT_PRESETS`/`buildPresetEffects`; passes `onApplyPreset` to LeftRail.
- **`LeftRail.tsx`**: `onApplyPreset` prop; Effects section split into raw **Effects** (top) + **Presets** (bottom) `SimpleSection`s; `PRESET_ICON` id→tabler map; added optional `title` (hover tooltip = preset description) to SimpleSection items.
- Files: `src/types.ts`, `src/hooks/useProject.ts`, `src/lib/effectPresets.ts` (new), `src/components/App.tsx`, `src/components/LeftRail.tsx`.

[2026-07-27] Cinematic presets + effects-menu layout (user request against spec 25). `tsc -b` + `vite build` green.
- **Cinematic look**: no existing effect could push teal-into-shadows / warm-into-highlights, so added 2 new gradient-map ramps in the shader — `cinematic` (teal shadows → warm mids → orange → cream highlights) and `cinemacool` (deep-blue moody night grade). Blended at partial intensity (0.5) so original hue survives — a colour grade, not a full LUT replace.
  - `types.ts`: extended `GradientMapPreset` union (+`cinematic`, +`cinemacool`).
  - `glEffects.ts`: 2 ramp fns + shader branches + `GRADIENT_PRESET_INDEX` entries (4, 5).
  - `PropertiesPanel.tsx`: 2 new `<option>`s in the gradient-map preset dropdown.
  - `effectPresets.ts`: 2 presets — **Cinematic** (gradientmap cinematic 0.5 + contrast 0.35 + soft rectangle vignette) and **Cinematic Cool** (gradientmap cinemacool 0.5 + contrast + vignette). Placed first in the catalog.
  - `LeftRail.tsx`: `PRESET_ICON` entries (IconVideo / IconMoon).
- **Effects-menu layout**: the effects pane is now a full-height flex column — raw **Effects** list gets its own `flex-1 min-h-0 overflow-y-auto` (≈half), **Presets** sits below in an equal `flex-1` scroll area with a top border, so presets are always visible without scrolling past the long effects list. Media/Text/Elements sections each wrapped in their own scroll container (previously the whole pane scrolled).
- Files: `src/types.ts`, `src/lib/glEffects.ts`, `src/components/PropertiesPanel.tsx`, `src/lib/effectPresets.ts`, `src/components/LeftRail.tsx`.

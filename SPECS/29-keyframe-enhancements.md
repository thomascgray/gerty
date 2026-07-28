# 29-keyframe-enhancements

> Source: [gerty#12 — "normalise/refactor what elements are changeable via keyframes"](https://github.com/thomascgray/gerty/issues/12)

## Overview

Today a keyframe animates **exactly six numbers** — `x, y, width, height, rotation, opacity` — and nothing else. Everything else about an object (its colour, line width, font size, the *text itself*, its text effect) is static for the clip's whole life. That mismatch is invisible in the UI: when the playhead parks on a keyframe the **entire** inspector turns that keyframe's colour, implying "everything here is animated", but only the Position fields actually are. A user who keyframes a text object, changes the words, and sees them change for the whole clip has been actively misled.

This spec does three coupled things:

1. **Normalise what is keyframable.** Extend the keyframe model from a fixed 6-number pose to a *registry* of animatable channels — position, style, and type-specific data (text content, text effect, arrow curvature…) — with a per-channel interpolation rule (lerp / colour-lerp / step / morph).
2. **Make it legible.** Replace the "whole panel goes red" signal with **per-section and per-field keyframe indicators** in the keyframe's own colour, so you can see at a glance *which* properties this keyframe governs and which properties animate at all on this object.
3. **Animated text content.** Because "the text changes at 3s" is a new kind of transition, define how the old string leaves and the new one arrives — a left-to-right per-glyph wipe driven by the same easing/lead-in engine, with `instant` easing giving a hard cut for free.

Everything stays inside `resolveRenderPose` → `renderFrame`, so **preview and export remain identical by construction** (the spec-12/13/23 invariant).

### What exists today (grounded)

- **`Keyframe = { time, pose: KeyframePose, easing, leadIn? }`** ([types.ts:67-73](src/types.ts#L67-L73)); `KeyframePose = Record<AnimatableProperty, number>` with `AnimatableProperty = 'x'|'y'|'width'|'height'|'rotation'|'opacity'` ([types.ts:62-65](src/types.ts#L62-L65)). Every keyframe is a **whole-pose snapshot** — all six, always.
- **`poseAt(obj, t)`** ([keyframes.ts:69-98](src/lib/keyframes.ts#L69-L98)) builds `[base@0, ...keyframes]`, brackets `t`, applies the spec-21 lead-in window, and `lerpPose`s the six numbers with the arriving keyframe's easing.
- **`resolvePose(obj, globalTime)`** ([keyframes.ts:114-122](src/lib/keyframes.ts#L114-L122)) returns a copy of the object with the six values written back (`opacity` into `style`). `resolveRenderPose` = `resolvePose` → `applyTransitions` ([keyframes.ts:176-178](src/lib/keyframes.ts#L176-L178)) and is called once per object per frame in `renderFrame` ([renderer.ts:66](src/lib/renderer.ts#L66)).
- **`editPose(obj, overrides, t)`** ([keyframes.ts:192-220](src/lib/keyframes.ts#L192-L220)) is the shared edit primitive (panel inputs, canvas drag, `ContextToolbar`): on a keyframe → update it; at `t ≤ KF_EPS` → move the base pose; otherwise → **insert** a keyframe capturing the current interpolated pose + overrides. Consumers: [Canvas.tsx:1361/1383/1391/1499/1521/1528](src/components/Canvas.tsx#L1361), [ContextToolbar.tsx:345/355](src/components/ContextToolbar.tsx#L345), [PropertiesPanel.tsx:84-91](src/components/PropertiesPanel.tsx#L84-L91).
- **The panel's "everything goes red"** — `activeColor` ([PropertiesPanel.tsx:98](src/components/PropertiesPanel.tsx#L98)) drives a full-panel `inset 0 0 0 3px` ring ([PropertiesPanel.tsx:121](src/components/PropertiesPanel.tsx#L121)) plus a banner ([PropertiesPanel.tsx:124-133](src/components/PropertiesPanel.tsx#L124-L133)). Sections are `Accordion`s keyed by title ([PropertiesPanel.tsx:1501-1517](src/components/PropertiesPanel.tsx#L1501-L1517)) with a `SECTION_ICONS` map ([PropertiesPanel.tsx:1471-1499](src/components/PropertiesPanel.tsx#L1471-L1499)).
- **Style/data edits bypass keyframes entirely**: `updateStyle` ([PropertiesPanel.tsx:61-66](src/components/PropertiesPanel.tsx#L61-L66)) and `updateData` ([PropertiesPanel.tsx:70-73](src/components/PropertiesPanel.tsx#L70-L73)) write straight to `obj.style` / `obj.data` for the whole clip. This is the bug the issue describes.
- **`drawText`** ([annotations.ts:238-…](src/lib/annotations.ts#L238)) lays out from the **full** string (so the typewriter `progress` reveal doesn't reflow), and already has a **per-glyph** draw path (used by the `wave` effect's `waveFn`) — the machinery a per-glyph content morph needs.
- **`SPLIT_OBJECT`** ([useProject.ts:47-52](src/hooks/useProject.ts#L47-L52)) pins `poseAt(obj, splitOffset)` onto both halves for continuity — it must pin the new channels too.

## Requirements

### A. The channel model

- **R1**: A keyframe declares a **sparse set of properties** ("channels") rather than an implicit whole-pose snapshot. A property animates on an object **iff at least one keyframe declares it**; otherwise it reads its static base value from `obj` (unchanged, for the whole clip).
- **R2**: Resolution is **per-channel, independent**: for channel `c`, waypoints = `[base(c)@0, ...keyframes that declare c]`; bracket `t`; apply the arriving keyframe's `easing` + `leadIn` (spec-21 formula, unchanged); interpolate per that channel's rule. Hold before the first declaring waypoint and after the last.
- **R3**: Channels are described **once**, in a registry (`CHANNELS` in `keyframes.ts`), giving each: key, human label, owning **panel section**, interpolation rule, which object `type`s expose it, and read/write accessors. Every consumer (resolver, editor primitive, panel badges, timeline) derives from this table — no second list.
- **R4**: Interpolation rules:
  | rule | applies to | behaviour |
  |---|---|---|
  | `number` | x, y, width, height, rotation, opacity, lineWidth, fontSize, padding, cornerRadius, arrow curvature/headSize | linear lerp of the eased `u` (as today) |
  | `color` | style.color, text background | component-wise sRGB lerp of the two hex values |
  | `step` | fontFamily, fontWeight, fontStyle, align, autoSize, progressiveHead | holds the previous value, snaps to the arriving value **at the keyframe's `time`** |
  | `content` | text content | left-to-right per-glyph wipe (§C) over the arriving segment |
  | `effect` | text effect | same `kind` on both sides → lerp its numeric params (+ `color` rule for its colours); different kinds → `step` |
- **R5 (channel scope, v1 — RESOLVED)** — which properties are keyframable, by object type. All three optional groups were taken in:
  - **all visual types**: `x`, `y`, `width`, `height`, `rotation`, `opacity`
  - **text**: `+ style.color`, `style.fontSize`, `text.content`, `text.effect`, `text.background`, `text.cornerRadius`, `text.padding`, and the **discrete** (`step`) set `text.align`, `style.fontFamily`, `style.fontWeight`, `style.fontStyle`
  - **arrow**: `+ style.color`, `style.lineWidth`, `arrow.curvature`, `arrow.headSize`
  - **freehand / rectangle / circle**: `+ style.color`, `style.lineWidth`
  - **photo / video**: pose + `opacity` only — **RESOLVED (user)**: opacity *is* the whole ask for images/videos, and it is already a pose channel. No new render feature (tint/blur/grade) is in scope.
  - **audio**: nothing (no visual); `volume` keyframing is explicitly **out of scope** here — it belongs to spec 15 (audio polish).
- **R6 (back-compat)**: a keyframe stored in the legacy shape (a `pose` with all six numbers and no channel set) reads as **declaring all six pose channels**, so existing projects and `.gerty` imports animate exactly as before. An object with no keyframes renders **pixel-identically** to today.
- **R7**: `DUPLICATE_OBJECT` and `SPLIT_OBJECT` keep working: copies stay independent (deep clone must cover the new nested channel payloads — e.g. a `TextEffect` object), and the split's continuity pin declares **every channel that animates across the cut**, not just the pose, so neither half pops.

### B. Editing / authoring

- **R8**: A generalised `editChannel(obj, updates, t)` replaces/absorbs `editPose`, keeping the same landing rule: **on** a keyframe → merge into it; at `t ≤ KF_EPS` → write the **base** (`obj.x` / `obj.style` / `obj.data`); otherwise → **insert** a keyframe declaring the edited channels at the playhead. `editPose(obj, poseOverrides, t)` remains as a thin wrapper so `Canvas.tsx`/`ContextToolbar.tsx` call sites are untouched.
- **R9 (opt-in per channel)**: away from a keyframe, the "insert a keyframe" branch fires **only for channels that already animate on this object**. Editing a *non-animated* channel (e.g. changing the colour of an object that only has *position* keyframes) writes the **base** value for the whole clip — the behaviour users expect. Pose channels keep today's behaviour by virtue of R6/R9 (an object with keyframes already animates its pose).
- **R9a (revised after user testing)**: when the playhead is parked **on** a keyframe, **any** property you edit is declared on that keyframe, animated or not. The user is explicitly in keyframe-editing context — the banner names the keyframe and its section is tinted — so an edit landing anywhere else reads as a bug. R9 still governs every other playhead position, so a colour tweak mid-clip never silently becomes an animation.
- **R10**: A property is opted **into** animation by an explicit affordance: a **◆ keyframe toggle next to that field** in the inspector. Clicking it on a non-animated field declares the current value as a keyframe at the playhead (creating the keyframe if needed). Clicking it on a field the active keyframe declares **removes** that declaration (and deletes the keyframe if it ends up declaring nothing).
- **R11**: `+ Keyframe` keeps its current meaning — capture the **pose** (all six) at the playhead — so nothing about the existing position-animation workflow changes.

### C. Animated text content

- **R12**: When a `text.content` channel is mid-segment at time `t`, the renderer draws a **morph** between the outgoing string and the incoming one over that segment's `[animStart, time]` window (so `leadIn` = "hold the old words, then swap over the last N seconds").
- **R13**: The default (and only) morph is a **left-to-right per-glyph wipe**: a soft front sweeps across the box; each outgoing glyph fades out as the front passes it, each incoming glyph fades in just behind. Both strings are drawn superimposed with per-glyph alpha. There is **no morph-kind field** — `instant` easing already covers the cut (R14).
- **R13a (revised after user testing)**: each string keeps its **own** natural layout (auto-fit size + line breaks) and the size difference is morphed by drawing each at a uniform **scale** toward the incoming size, anchored on the aligned edge. Neither string reflows, and the drawn size equals each string's natural size at its own end of the morph — so there is no jump entering or leaving the transition. *(The original R13a — re-fit both to the smaller shared size — was wrong: it made the outgoing text visibly snap the instant the morph began.)*
- **R13b (revised)**: any effect change that isn't a same-kind param lerp is a **hand-over**: the outgoing effect's magnitude decays to 0 across the first half of the segment, the incoming one grows from 0 across the second, and the kind swaps at the midpoint where both are visually nothing. One rule covers appearing, disappearing, and switching kinds (`wave → glow` settles the glyphs to the baseline before the halo blooms). Magnitude params: `wave.amplitude`, `pulse.amount`, `glow.blur`, `outline.width`, `shadow.dx/dy/blur`, `warble.amount`, `glitch.amount`. Only one effect is ever active at an instant, so the renderer needs no double-paint. Kinds with no scalar magnitude (gradient/rainbow/shimmer — a fill, not a displacement) cannot decay and simply hand over at the midpoint: a colour change with no positional jump.
- **R14**: `instant` easing on the arriving keyframe produces a **hard cut** (u steps 0→1 → the front jumps past every glyph) with no extra code path.
- **R15**: The morph is **deterministic** — a pure function of `(from, to, u)` with no `Math.random`, no wall-clock — so preview and export are frame-identical (the spec-19/23 R-DET rule).
- **R16**: The morph composes with the existing `animateIn` typewriter reveal without either corrupting the other: the reveal applies to whichever string is *current*; the morph applies on top. (See Q3 for the overlap case.)

### D. Legibility (the badges)

- **R17**: The **full-panel colour ring is removed**. In its place: each inspector `Accordion` whose section contains a property **declared by the keyframe under the playhead** is tinted in that keyframe's colour (header dot + left border). Sections with no declared property stay neutral.
- **R18**: **Two indicator states**, both derived from the `CHANNELS` registry:
  - *animated* (hollow ◆, neutral) — this property animates somewhere on this object;
  - *active* (filled ◆, `keyframeColor(activeIdx)`) — the keyframe under the playhead declares this property; edits here land on it.
- **R19**: Indicators appear at **both levels**: per field (next to the input) and summarised on the section header, so a collapsed section still shows that something inside it animates.
- **R20**: The "Editing Keyframe N" banner stays (it is the loudest correct signal) but is reworded to name what the keyframe governs, e.g. *"Keyframe 2 — Position, Text"*.
- **R22**: On the timeline bar, a keyframe declaring **only** non-pose channels draws a **hollow** diamond (pose-declaring keyframes stay filled), so a style/text keyframe is identifiable without opening the inspector. Derived from `declaredChannels(k)`; retiming/drag behaviour is unchanged.
- **R21**: `npx tsc -b` stays green. No behaviour change for objects with no keyframes, in preview or export.

## Technical Considerations

### Types (`src/types.ts`)

```ts
// --- The channel registry key space -------------------------------------------------
// A flat, dotted key space so ONE sparse map covers pose + style + type-specific data.
// (Nesting would force three parallel merge paths in the resolver and three badge maps.)
export type AnimatableChannel =
  // pose — the legacy six (top-level on TimelineObject, `opacity` → style.opacity)
  | 'x' | 'y' | 'width' | 'height' | 'rotation' | 'opacity'
  // style
  | 'style.color' | 'style.lineWidth' | 'style.fontSize'
  | 'style.fontFamily' | 'style.fontWeight' | 'style.fontStyle'
  // text data
  | 'text.content' | 'text.background' | 'text.padding' | 'text.cornerRadius'
  | 'text.align' | 'text.effect'
  // arrow data
  | 'arrow.curvature' | 'arrow.headSize'

// Legacy alias kept so existing pose code/­types read unchanged.
export type AnimatableProperty = 'x' | 'y' | 'width' | 'height' | 'rotation' | 'opacity'
export type KeyframePose = Record<AnimatableProperty, number>

// A channel's stored value. Only `TextEffect` is non-scalar (see the `effect` interp rule).
export type ChannelValue = number | string | boolean | TextEffect | undefined

// --- Keyframe (EXTENDED) ------------------------------------------------------------
export type Keyframe = {
  time: number                                   // clip-relative seconds (unchanged)
  pose: KeyframePose                             // LEGACY: present on old data; see migration
  props?: Partial<Record<AnimatableChannel, ChannelValue>>  // NEW: the sparse declaration set
  easing: EasingKind                             // arriving-segment curve (unchanged)
  leadIn?: number                                // spec 21 (unchanged)
}
```

**Migration / read model (R6).** `pose` and `props` coexist rather than one replacing the other:

- **Read**: `declaredChannels(k)` = `Object.keys(k.props ?? {})` ∪ (`k.pose` present ? the six pose keys : ∅). `channelValue(k, c)` prefers `k.props[c]`, falls back to `k.pose[c]` for pose keys.
- **Write**: newly created keyframes write `props` only. `addKeyframeAt` (the `+ Keyframe` button, R11) writes all six pose keys **into `props`** — so a fresh keyframe has no `pose` at all and is honestly sparse.
- Old data (`pose`, no `props`) therefore behaves exactly as today — a whole-pose waypoint — with **zero migration step** and no persisted-data rewrite.
- `pose` becomes optional in a follow-up once no project in the wild carries it. *(This is the low-risk path; the alternative — a one-shot migration that folds `pose` into `props` on load in `projectStorage.ts` — is cleaner but touches persistence. See Q1.)*

### The registry (`src/lib/keyframes.ts`)

```ts
export type InterpKind = 'number' | 'color' | 'step' | 'content' | 'effect'
export type PanelSection = 'Position' | 'Style' | 'Text' | 'Effects' | 'Arrow'

export type ChannelSpec = {
  key: AnimatableChannel
  label: string                       // "Colour", "Line width", "Text"
  section: PanelSection               // drives the badge grouping (R17/R19)
  interp: InterpKind
  types: TimelineObjectType[]         // which object types expose this channel
  read: (o: TimelineObject) => ChannelValue          // the object's BASE value
  write: (o: TimelineObject, v: ChannelValue) => Partial<Omit<TimelineObject,'id'|'type'>>
}

export const CHANNELS: ChannelSpec[]                  // the single source of truth (R3)
export const CHANNELS_BY_KEY: Record<AnimatableChannel, ChannelSpec>
export function channelsFor(type: TimelineObjectType): ChannelSpec[]
```

`write` returns *update objects* (not mutations) because `UPDATE_OBJECT` **shallow-merges** — nested `style`/`data` must be passed whole (CLAUDE.md). E.g. `style.color`'s writer returns `{ style: { ...o.style, color: v } }`.

### Resolution (`src/lib/keyframes.ts`)

```ts
// Generalises poseAt. For ONE channel: waypoints = [base@0, ...keyframes declaring it],
// bracket t, apply the spec-21 lead-in window, interpolate per the channel's rule.
export function channelValueAt(obj: TimelineObject, c: AnimatableChannel, t: number): ChannelValue

// Which channels animate on this object at all (drives the hollow ◆, R18).
export function animatedChannels(obj: TimelineObject): Set<AnimatableChannel>

// resolvePose becomes resolveSnapshot: applies every animated channel via its writer.
export function resolvePose(obj: TimelineObject, globalTime: number): TimelineObject
```

- `poseAt` stays (hot path for the six numbers, and used by `SPLIT_OBJECT`/`Canvas` drag) but is re-expressed over the generic bracket helper so the lead-in/easing logic exists **once**.
- `resolvePose` short-circuits to `obj` when `animatedChannels(obj)` is empty → the "no keyframes ⇒ pixel-identical" guarantee (R6/R21) is structural, not incidental.
- **Perf**: called once per visible object per frame in `renderFrame` ([renderer.ts:66](src/lib/renderer.ts#L66)) and in `Canvas.tsx`. Keep the per-frame allocation to one object spread + at most one `style`/`data` spread; `animatedChannels` should be computed from the keyframe array without allocating a Set per frame (cache by array identity, or return a bitmask).

### Colour interpolation (new — `src/lib/color.ts` or an addition to `easing.ts`)

```ts
export function lerpColor(a: string, b: string, u: number): string   // '#rrggbb', sRGB component lerp
```

Open detail: `text.background` is `string | undefined` (undefined = no panel). Interpolating "none → #ff0000" has no natural midpoint. **Recommendation**: when either side is `undefined`, treat it as the other colour at alpha 0 and lerp the alpha (a fade-in panel), which is what "the background appears" should look like. That requires the writer to emit `rgba(...)`, which `drawText` already accepts (`ctx.fillStyle`). *(Q5.)*

### Text morph (`src/lib/keyframes.ts` + `annotations.ts` + `renderer.ts`)

```ts
// null when the content channel isn't animating or isn't mid-segment.
export type TextMorph = { from: string; to: string; u: number }
export function textMorphAt(obj: TimelineObject, t: number): TextMorph | null
```

- `renderFrame` computes it alongside `resolveRenderPose` and passes it into `drawObject` → `drawText(…, morph?)`. It is **not** written into `obj.data` — `data` is persisted, and a transient render-only field there would leak into the project JSON.
- `drawText` with a morph: lay out `from` and `to` independently (both via the existing `fitText`/`wrapText`), then draw each glyph with an alpha from a shared wipe front:
  ```
  front  = u * (1 + FEATHER)                  // FEATHER ≈ 0.25 of the string
  p_i    = i / max(1, N-1)                    // glyph i of that string
  aOut_i = 1 - clamp01((front - p_i) / FEATHER)
  aIn_i  =     clamp01((front - p_i) / FEATHER)
  ```
  `u = 0` ⇒ only the old string; `u = 1` ⇒ front past every glyph ⇒ only the new. `instant` easing steps `u` 0→1 ⇒ hard cut (R14) with no branch.
- Per-glyph fills already exist for the `wave` effect ([annotations.ts:350-353](src/lib/annotations.ts#L350-L353)) — the morph reuses that loop rather than adding a second one. Cost is bounded (2 strings' glyphs, only while morphing).
- **Layout mismatch**: with `autoSize` on, a longer new string fits to a *smaller* font, so the two layouts differ in size during the morph. Recommendation is to fit **both at the smaller of the two fitted sizes** for the morph's duration, so the type height stays stable and only the letters change. *(Q7.)*
- Text **effects** (spec 19) wrap the glyph loop; during a morph both strings should get the same effect treatment (the effect channel may itself be mid-`step`, in which case the arriving effect applies at the keyframe time, i.e. mid-morph — acceptable and consistent with the `step` rule).

### Panel indicators (`PropertiesPanel.tsx` + `propertyControls.tsx`)

- New `KeyframeDot` control: props `{ channel, obj, activeIdx, clipTime, onToggle }`; renders hollow/filled/off ◆ per R18 and is the R10 opt-in affordance. Placed inside the existing `Field` wrapper so every field gets one for free where a channel exists.
- `Accordion` gains `accent?: string | null` (tint header + left border, R17) and `dot?: 'none'|'animated'|'active'`. The section for each channel comes from `ChannelSpec.section`, so the mapping is declarative.
- The full-panel `boxShadow` at [PropertiesPanel.tsx:121](src/components/PropertiesPanel.tsx#L121) is **deleted**; the banner at [124-133](src/components/PropertiesPanel.tsx#L124-L133) is reworded per R20.
- Note the section/property overlap: `opacity` is a *pose* channel but lives in the **Style** accordion — the registry's `section` field (not the property's storage location) decides where the badge shows.
- **Gotcha**: the panel re-renders at 60 Hz during playback (CLAUDE.md) — indicator state must be cheap to derive (`animatedChannels` cached, no per-render Set building per field).

### Timeline

Keyframe diamonds ([Timeline.tsx](src/components/Timeline.tsx), spec 21 ramps) need no structural change. Optional polish: a keyframe that declares **only** non-pose channels could draw a hollow diamond so "this is a style/text keyframe" reads on the timeline. *(Deferred unless wanted — Q6.)*

### Blast radius

| File | Change |
|---|---|
| `src/types.ts` | `AnimatableChannel`, `ChannelValue`, `Keyframe.props?` |
| `src/lib/keyframes.ts` | registry, `channelValueAt`, `animatedChannels`, `resolvePose`, `editChannel`, `textMorphAt`; `poseAt`/`editPose` re-expressed as wrappers |
| `src/lib/color.ts` (new) | `lerpColor` |
| `src/lib/renderer.ts` | pass `TextMorph` into `drawObject`/`drawText` |
| `src/lib/annotations.ts` | `drawText` morph branch (per-glyph alpha) |
| `src/components/PropertiesPanel.tsx` | remove full-panel ring; section accents; per-field ◆; reworded banner |
| `src/components/propertyControls.tsx` | `KeyframeDot`; `Field` slot |
| `src/hooks/useProject.ts` | `SPLIT_OBJECT` continuity pin covers all animated channels (R7) |
| `src/components/Canvas.tsx`, `ContextToolbar.tsx` | unchanged if `editPose` keeps its signature (R8) |

## Related Systems and Tasks

- **`SPECS/12-keyframe-easing-engine.md`** / `TASKS/12-…` — the whole-pose model this generalises.
- **`SPECS/21-animation-rethink.md`** / `TASKS/21-…` — `leadIn` + the 7-preset easing vocabulary; the morph reuses both verbatim.
- **`SPECS/19-text-effects.md`** — `TextEffect` union and the per-glyph draw loop the morph reuses; the R-DET determinism rule.
- **`SPECS/13-camera-zoom.md`** — `CameraZoom.keyframes` is a **parallel** 3-component mirror (`camera.ts`). It is deliberately **not** in scope here (a zoom has no style/content), but if the generic bracket helper lands, `zoomPoseAt` should be re-expressed over it to keep one lead-in implementation.
- **`SPECS/15-audio-polish.md`** — where `volume` keyframing belongs (R5).
- CLAUDE.md → "Animation system (spec 12)" and the Gotcha *"Editing a keyframed object auto-creates keyframes … an auto-created one also freezes size/rotation/opacity"* — **R1/R9 remove that gotcha**: a sparse keyframe only freezes what you touched.

## Open Questions — all resolved

1. **Keyframe storage — RESOLVED (user): sparse per-property tracks.** A keyframe declares only the properties actually changed; each property resolves as an independent track (R1/R2). This is what gives the badges information content, and it removes the CLAUDE.md gotcha where dragging mid-clip freezes width/rotation/opacity at their interpolated values. Legacy `pose` keyframes stay readable in place as "declares all six" (R6) — **no migration step, no persistence change**.
2. **Opt-in — RESOLVED (user): edit the base.** Editing a property that isn't yet animated writes the object's static value for the whole clip, however far along the playhead is. Animation is opted into per property via the ◆ affordance (R10); after that, edits auto-insert keyframes exactly as position does today (R9).
3. **Text morph — RESOLVED (user): left-to-right per-glyph wipe**, driven by the arriving keyframe's existing easing + `leadIn` window. **No new morph-kind field** — `instant` easing already yields a hard cut (R13/R14).
4. **Channel scope — RESOLVED (user): all three optional groups in** — discrete text props as `step`s, arrow `curvature`/`headSize`, text `background`/`cornerRadius` (R5).
5. **`text.background` — RESOLVED (follows from Q4's opt-in):** absent ⇄ colour interpolates by **fading the alpha** (writer emits `rgba(...)`), so "the panel appears" reads as a fade-in rather than a pop.

6. **Photo/video "style" — RESOLVED (user): opacity is the whole ask.** The issue's "images and videos: position, the style" is already satisfied by the existing pose channels; no per-object tint/blur/grade is in scope. If one is ever wanted it is a new *render* feature with its own spec, and gains a keyframe channel off this registry for free afterwards.
7. **Auto-size during a text morph — RESOLVED (rec):** lock **both** strings to the smaller of the two fitted sizes for the morph's duration (R13a), so the type height stays stable and only the letters change. Costs one extra `fitText` per morphing frame.
8. **Content keyframe inside the `animateIn` window — RESOLVED (rec):** no special-casing. The typewriter reveal applies to whichever string is *current* (the morph's incoming side); the morph runs on top (R16).
9. **Timeline distinction — RESOLVED (rec): yes, do it.** A keyframe declaring **only** non-pose channels draws a **hollow** diamond on the timeline bar (filled = pose), so "this is a style/text keyframe" reads without opening the inspector. Trivial once `declaredChannels(k)` exists (R22).
10. **Naming — RESOLVED (rec):** the field is `Keyframe.props`; the per-field indicator is a bare ◆ with a tooltip ("Animate this property" / "Remove from keyframe N").

*(All questions settled. Fix by feel during implementation where a recommendation turns out wrong in the browser.)*

## Acceptance Criteria

- A text object can have a keyframe at 0s and another at 3s with **different words**, and the words wipe from the old to the new across that segment — identically in the preview and in the exported MP4.
- Setting the arriving keyframe's motion to **Instant** turns that same swap into a hard cut on the exact frame.
- A text object's **colour** can be animated from red to blue across two keyframes and interpolates smoothly; a rectangle's **line width** and an arrow's **curvature** likewise.
- A discrete channel (e.g. text **align** left → right) snaps on the arriving keyframe's frame rather than interpolating.
- A text object with no background can keyframe one **in**, and the panel fades up from transparent rather than popping.
- Changing the colour of an object that has only **position** keyframes changes it for the **whole clip** (no surprise keyframe) — and clicking the ◆ next to the colour field is what opts it into animation.
- Parking the playhead on a keyframe tints **only** the sections that keyframe governs; the rest of the inspector stays neutral. Every field that animates on the object shows a ◆ even when the playhead is between keyframes.
- Dragging a keyframed object at a time between keyframes creates a keyframe that changes **position only** — its width/rotation/opacity keep tweening through (the old freeze-everything behaviour is gone).
- Existing projects (and `.gerty` imports) with pose-only keyframes animate exactly as before; an object with no keyframes renders pixel-identically.
- Splitting a clip whose colour/text animates across the cut produces two halves with no visual pop at the boundary.
- `npx tsc -b` is clean.

## Implementation Notes

Suggested landing order (each step independently verifiable):

0. **Sequencing note.** Steps 1–2 are a pure refactor with *no* user-visible change — land and verify them on their own before any new channel exists, because every later step rides on them. Step 4 (the indicators) is the step that actually fixes the reported confusion and is worth landing before the text morph.
1. **Registry + generic resolution.** Add `AnimatableChannel`/`ChannelSpec`/`CHANNELS`; re-express `poseAt` over a shared bracket helper; add `channelValueAt` + `animatedChannels`; extend `resolvePose`. Nothing visible changes yet — verify by "everything still behaves exactly as before".
2. **`Keyframe.props` + `editChannel`.** Sparse writes, legacy `pose` reads (R6), `editPose` as a wrapper. Verify drag/resize/rotate unchanged and that a new keyframe declares only what moved.
3. **Style channels + `lerpColor`.** Colour / line width / font size animating end-to-end (panel → resolver → renderer → export).
4. **Panel indicators.** `KeyframeDot`, section accents, banner rewrite, remove the full-panel ring. This is the step that fixes the reported confusion — worth landing even before the text morph.
5. **Text content + effect channels**, then the `drawText` morph.
6. **`SPLIT_OBJECT` continuity** for the new channels, and a `DUPLICATE_OBJECT` independence check.

Per `.claude/skills/verify`: static checks only (`npx tsc -b`), then hand over a browser checklist — the colour tween, the text wipe, the instant cut, the badge states, and a no-keyframe regression pass.

---
*Implemented 2026-07-28 — see [TASKS/29-keyframe-enhancements.md](../TASKS/29-keyframe-enhancements.md),
which records five deviations decided during implementation: `text.padding` dropped (no UI to reach
it), `autoSize`/`progressiveHead` left static (modes, not looks), a Head size field added so
`arrow.headSize` is reachable, absent optional values stored as `null` for JSON round-tripping, and
`ContextToolbar` routed through a new `editPatch` (the spec wrongly assumed it needed no change).*

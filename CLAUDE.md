# Gerty — architecture guide

A browser-based video editor: **React 19 + TypeScript + Canvas 2D + WebCodecs**, bundled with Vite, styled with Tailwind v4. No backend — everything runs client-side; assets live in IndexedDB, projects in localStorage. Output is MP4 (H.264 + AAC) muxed in-browser with `mp4-muxer`.

> Naming gotcha: `src/lib/ffmpegExport.ts` does **not** use ffmpeg.wasm — it's the live **WebCodecs + mp4-muxer** export path (with a MediaRecorder fallback). The README is stale on this.

## Working conventions

- **Verify with `npx tsc -b`** (the build is `tsc -b && vite build`). Keep it green — there is no other typecheck gate.
- **Do NOT run the dev server or browser automation.** The user always has `npm run dev` running and tests changes in the browser themselves. After a change, run static checks and hand the user a short "click X, look for Y" checklist. (See `.claude/skills/verify/SKILL.md`.)
- `src/config.ts` → `persistProject` (default **false**): when false the app boots to an empty default project and does **not** load/save localStorage. Flip to true to persist across refreshes.
- Specs live in `SPECS/` (02–31), implementation logs in `TASKS/`. Landed work includes 12 (keyframe animation), 13 (camera zoom), 14 (video trim/split), 16 + 17 (UI redesign → `LeftRail`/`ContextToolbar`/`TransportBar`), 19 + 20 (text objects/effects), 21 (animation rethink), 22 (markers), 23 + 24 + 25 (video effects, incl. the WebGL tier), 26 (effect presets), 28 (image/URL import), 29 (keyframe enhancements), 30 (quality-based export). This batch: 31 (QoL fixes). Still open / partial: 09 (video perf — export still main-thread), 11 (audio pitch), 15 (audio polish).

## The data model (`src/types.ts`)

Everything on the canvas is a flat, non-destructive **`TimelineObject`** — photos, annotations, text, audio, and video are all the same shape with a type-specific `data` payload. This single decision is why most features are a layer, not a rewrite.

```ts
type TimelineObject = {
  id: string
  type: 'photo'|'arrow'|'text'|'rectangle'|'circle'|'freehand'|'audio'|'video'
  name: string
  startTime: number   // global seconds
  duration: number    // seconds visible on the timeline
  lane: number        // higher = renders on top (z-order)
  x, y, width, height: number   // NORMALIZED 0–1 (relative to canvas)
  rotation: number    // radians, about the bbox center
  animateIn: number   // "type-on"/draw-on reveal duration (0 = instant) — see Animation
  keyframes?: Keyframe[]   // whole-pose animation waypoints (spec 12)
  enter?: Transition       // On Appear animation
  exit?: Transition        // On Exit animation
  style: ObjectStyle       // color, lineWidth, opacity, font*
  data: PhotoData | ArrowData | TextData | ShapeData | FreehandData | AudioData | VideoData
}
```

- **Coordinates are normalized 0–1**, multiplied by the canvas `width`/`height` (project dims, default 1920×1080) at draw time. This is why a camera/zoom (spec 13) is just one `ctx` transform, and why hit-testing on a non-square canvas converts to pixel space (`Canvas.tsx`).
- `data` variants: `PhotoData{assetId}`, `ArrowData{points[],headSize,curvature,progressiveHead}`, `TextData{content,background?,padding?}`, `ShapeData` (empty — rect/circle), `FreehandData{strokes[][]}`, `AudioData`/`VideoData{assetId,volume,muted?,originalDuration,waveform?,sourceIn?,sourceOut?,sourceMin?,sourceMax?}`.
- **Trim vs speed (spec 14, done)**: audio/video separate **trim** (`sourceIn`/`sourceOut` — which source span plays) from **speed** (`rate = span/duration`). All mapping is centralized in `src/lib/mediaTiming.ts` (`srcIn/srcOut/sourceSpan/clipRate/sourceTimeAt`, plus the recoverable-window `srcMin/srcMax`). Defaults (`sourceIn=0, sourceOut=originalDuration`) reproduce the old speed-stretch behaviour. See **Timeline lanes & selection** for the trim-ghost / split-window model.
- `Project = {id,name,fps,width,height,objects[],assets[], zooms?, markers?, effects?}`. `AssetMeta = {id,type,filename,mimeType,size,duration?}`. `zooms?` (camera, spec 13), `markers?` (spec 22), `effects?` (spec 23) are all optional/additive and persist via the same whole-project JSON.
- **`CameraZoom` is NOT a `TimelineObject`** — no `lane`/`data`/`keyframes`. It's `{id, x, y, scale, startTime, transitionIn, hold, transitionOut, easing}` (see Camera below). Selected via a **separate `selectedZoomId`** in `App.tsx`, mutually exclusive with `selectedObjectId`.
- Factories: `createDefaultProject()`, `createTimelineObject(type, data, options)`, `createCameraZoom(options?)` (defaults: `scale 2`, `transitionIn 0.6`, `hold 2`, `transitionOut 0.6`, `easeInOutCubic`).

### State & undo (`src/hooks/useProject.ts`)

A reducer over `{past[], present, future[], transientSnapshot}` (undo stack capped at 50). Dispatch `ProjectAction`s:
- `UPDATE_OBJECT` — shallow-merges `updates` into the object (`{...o, ...updates}`), so nested `data`/`style`/`keyframes` must be passed **whole**. Every dispatch = one undo entry.
- `UPDATE_OBJECT_TRANSIENT` → `COMMIT_TRANSIENT` — the pattern for a continuous gesture (drag): transient updates don't grow history; commit collapses the whole gesture into **one** undo entry. Used by canvas drag/resize and timeline bar drags.
- `ADD_OBJECTS`, `REMOVE_OBJECT`, `DUPLICATE_OBJECT` (deep-clones `data`+`keyframes` so copies are independent), `ADD_ASSETS`, `REMOVE_LANE`, `SET_PROJECT`, `SET_NAME`, `UNDO`/`REDO`.
- Camera zooms (spec 13): `ADD_ZOOM`, `UPDATE_ZOOM`, `UPDATE_ZOOM_TRANSIENT` (→ reuse `COMMIT_TRANSIENT`), `REMOVE_ZOOM` — mirror the object CRUD + transient/commit pattern (one undo per drag gesture).
- Media split (spec 14): `SPLIT_OBJECT` slices an audio/video clip at the playhead into two independent halves (deep-cloned data/keyframes). Markers (spec 22): `ADD_MARKER`/`UPDATE_MARKER(_TRANSIENT)`/`REMOVE_MARKER`/`CLEAR_MARKERS`. Effects (spec 23): `ADD_EFFECT`/`UPDATE_EFFECT(_TRANSIENT)`/`REMOVE_EFFECT` — same CRUD + transient/commit shape as zooms.

## Timeline lanes & selection (`Timeline.tsx`, `App.tsx`)

**Lanes are a sparse integer z-order, not an array index.** `obj.lane` — higher renders on top (the renderer sorts by `lane`). Lanes are **never compacted**: dropping a clip on a "new" lane just writes a different integer, and gaps between lane numbers are fine. The **visible lane range is derived each render** — `objMinLane`/`objMaxLane` from the objects, unioned with the ephemeral `addedTopLane`/`addedBottomLane` (the ± lane CTAs; pure view state, not persisted, not undo).

- **Lane-drag reach rule**: a move-drag can always push a clip **one lane past the top/bottom of the clips it is NOT dragging** (unioned with the current visible extent). So a fresh top/bottom layer is *always* reachable — even after the former top clip moved down — but it's bounded to +1 so you never spawn infinite empty lanes. The clamp is captured at drag start from the non-dragged objects, so it's stable through the gesture.

**Multi-selection**: `selectedObjectIds: string[]` in `App.tsx` is the **source of truth**; `selectedObjectId` (the single "primary" that drives the `PropertiesPanel` + `Canvas` overlay) is **derived** = the one id *only when exactly one* is selected. A multi-selection intentionally shows **no panel and no canvas box** — it's a timeline bulk-move tool. `selectedObjectId`/`selectedZoomId`/`selectedEffectId` remain **mutually exclusive** (selecting one clears the others in `App.tsx`).

- **Gestures** (timeline bar body): **shift-click** toggles a clip in/out of the set (no drag starts); **plain-drag** a clip already in the set moves the **whole group**; grabbing any *other* clip collapses to just it; a plain **click** (moved < 3px) on a group member collapses the selection to that one clip.
- **Group move** = one `UPDATE_OBJECT_TRANSIENT` **per member** each mousemove, then a single `COMMIT_TRANSIENT` → **one undo** (the transient snapshot is captured once, on the first dispatch of the gesture). The shared time delta is **floored so the earliest member can't cross 0** (relative spacing preserved); the shared lane delta is clamped to the group's collective extent. Snapping is driven by the grabbed clip and **excludes the whole moving group** so members don't snap to each other. **Delete** removes every clip in the selection (one `REMOVE_OBJECT` per id).

**Trim ghosts & split** (audio/video, spec 14): the timeline bar draws dimmed **trim "ghosts"** on each end for *recoverable* trimmed-off source you can drag back out. A clip's recoverable window is `[sourceMin, sourceMax]` (default `[0, originalDuration]`). **Splitting (`S`) collapses each half's window to its own played span** (`sourceMin=sourceIn`, `sourceMax=sourceOut`), so the halves read as fresh **untrimmed** clips — no ghosts, and neither edge can be dragged back out over the sibling. (This is why split halves no longer overlap and steal each other's clicks.)

## Rendering pipeline

**`renderFrame(ctx, objects, globalTime, {width,height}, imageCache, editorOptions?)` in `src/lib/renderer.ts` is the single, pure compositor shared by preview and export.** Change it once, both update.

1. Fills black background (un-zoomed, so the letterbox stays black), then wraps the object loop in `ctx.save()` → optional **camera transform** (`editorOptions.camera: CameraState`, spec 13) → `ctx.restore()`. Absent/identity camera = no-op = pixel-identical to pre-camera output. Filters objects visible at `globalTime`, sorts by `lane`.
2. Per object: `resolveRenderPose(obj, globalTime)` (see Animation) → computes `progress` from `animateIn` → `drawObject`.
3. `drawObject` applies rotation about the bbox center, then dispatches by type to the `draw*` fns in `src/lib/annotations.ts`. Photos/videos use `drawImageCover` (object-fit: cover, duck-typed to work in workers with `VideoFrame`/`ImageBitmap`/`HTMLVideoElement`).
4. `imageCache: Map<string, HTMLImageElement|HTMLVideoElement|ImageBitmap|VideoFrame>` — photos keyed by `assetId`, videos by **object id** (preview blits the shared `<video>` element; export decodes frames).

**Preview** (`src/hooks/useCanvasRenderer.ts`): pulls each video object's shared element from `mediaRegistry`, then calls `renderFrame` on a plain 2D context. Renders via a rAF loop while playing, or on state change while paused. **No DPR handling** — the canvas backing store is the raw project dims; CSS letterboxes it.

**Two canvases** (`src/components/Canvas.tsx`): a *render* canvas (goes through `renderFrame`) and a stacked *overlay* canvas (selection box, resize/rotate handles, arrow rubber-band, **camera framing rect + grey scrim**) drawn in pixel space by `drawOverlay`. The overlay owns all mouse events. **The overlay is NOT part of `renderFrame`.** The camera (spec 13) sidesteps the "mirror the transform in the overlay" problem entirely: in **Frame view** the render canvas is *un-transformed* and the overlay draws the zoom as a framing rectangle, so object hit-testing never needs the inverse transform; **Live view** applies the real transform to the render canvas but disables editing. See Camera below.

## Animation system (spec 12 — freshest, likely bug-fix target)

**Three independent concepts compose**, in this order inside `resolveRenderPose`:

```
base pose (obj.x/y/w/h/rotation + style.opacity)
  → keyframes (poseAt)          — whole-pose waypoints
  → enter/exit (applyTransitions) — On Appear / On Exit
  → [then drawObject applies `progress` for animateIn reveal]
```

All the logic lives in **`src/lib/keyframes.ts`** (shared by renderer, canvas, and panel). Easing curves are in **`src/lib/easing.ts`** (`ease(kind,u)` — polynomial eases hand-written, `easeOutBack`/`spring` from the `motion` library's utilities; `clamp01`, `lerp`).

### 1. `animateIn` — the "type-on" / draw-on reveal
A per-draw-fn *reveal fraction*, not a transform. `progress = min(1, elapsed/animateIn)` is passed to each `draw*` fn, which reveals a fraction of the finished shape: typewriter text, arrow draw-on, freehand point count, rect/circle grow+fade. `animateIn = 0` ⇒ `progress = 1` ⇒ appears **instantly** (no reveal). Editor mode shows a faint "ghost" of the full shape under the revealing part. Set via the draggable **`TypeOnBar`** in the panel's Timing section (track = the clip's lifespan, amber fill = reveal length; drag fully left = instant). The timeline object bar shows a **display-only stripe** for the same region — it is *not* draggable (edit it from the panel). Orthogonal to keyframes/transitions.

### 2. Enter / exit transitions — "On Appear" / "On Exit"
Menu-driven entrance/exit: `Transition = {kind: 'none'|'fade'|'slide'|'pop', duration, direction?, easing?}` on `obj.enter`/`obj.exit`. Applied by `applyTransitions` as a transform near the clip's start (`enter`) or end (`exit`): fade multiplies opacity, slide offsets x/y from off-screen, pop scales from the center. **They do NOT create keyframes** and don't pin position — so an object with only an entrance stays freely draggable. Edited in the **On Appear** / **On Exit** panel sections: kind, a **Motion** easing dropdown (`easing`; falls back to `defaultTransitionEasing(kind, phase)` when unset — the fn is exported for the panel), and a duration **slider whose track spans the whole clip lifespan** (`max = obj.duration`) with a `LifespanBar` showing the slice filled from the start (enter) / end (exit).

### 3. Keyframes — whole-pose waypoints (`Keyframe = {time, pose, easing}`)
- `KeyframePose = Record<AnimatableProperty, number>` where `AnimatableProperty = x|y|width|height|rotation|opacity`. Each keyframe is a **full pose snapshot**; anything that differs between keyframes tweens (a "morph"). There is no per-keyframe "style" — the easing IS the how.
- `time` is clip-relative seconds (when the pose is reached). `easing` shapes the segment **arriving** at that keyframe.
- **`poseAt(obj, t)`**: builds waypoints `[base@0, ...keyframes]` (a keyframe at ~0 replaces the base), finds the bracketing pair, interpolates each property with the arriving keyframe's easing; holds before first / after last.
- **`addKeyframeAt(obj, t)`** (the `+ Keyframe` button) captures the current rendered pose at the playhead (inserted sorted; updates in place if one's already at that time). This is how you start animating an un-keyframed object.
- **`editPose(obj, overrides, t)`** — the edit primitive shared by panel inputs AND canvas drag. **Editing NEVER creates a keyframe** (spec 36 change; keyframes are born only from the `+ Keyframe` button / the ◆ toggle): **on** a keyframe → update it; **anywhere else** (the start, or mid-clip on an already-animated channel) → edit the base/home value for the whole clip. Consequence by design: nudging an already-animated pose channel mid-clip writes the base and won't visibly move the object at a scrub point past its first keyframe — park on a keyframe or add one to change an animated property at a given time.
- UI (`PropertiesPanel` "Keyframes" section): a **KeyframeTrack** (mini timeline of colored diamonds + live playhead) and a **KeyframeStatus** line ("On keyframe 2" / "Between keyframe 2 and 3"), colored pips `◆ 1 ◆ 2 …` (per-index color via `keyframeColor`, click to jump), `+ Keyframe`, and for the keyframe under the playhead a **Motion** dropdown (descriptive easing labels; shapes the segment *arriving* at this keyframe) + Delete. Keyframes are **retimed by dragging their diamond on the timeline bar** (clamped between neighbors), not via a panel field.

### Keyframe color accent
`keyframeColor(i)` (in `keyframes.ts`, palette `KEYFRAME_COLORS`: red, blue, green, …) gives each keyframe index a stable color used **everywhere** — the panel pips + ring + banner, the timeline diamonds, and the canvas selection box/handles. When the playhead is parked on a keyframe (`activeKeyframeIndex`), the whole selection overlay + panel switch to that color, making "you are editing keyframe N" unmistakable.

### Canvas interaction with animation
`Canvas.tsx` derives `selectedObject = resolvePose(raw, globalTime)` — the **keyframe-resolved** pose (NOT enter/exit, so the object stays grabbable at home during an entrance). So the overlay/hit-test/drag all follow keyframed motion, and both drag dispatch paths (the canvas handler and the window-level one for dragging outside the canvas) go through `editPose`, which per the rule above edits the on-keyframe pose when parked on one, otherwise edits the base — it **never** spawns a keyframe (spec 36). So dragging a keyframed object while parked on a keyframe reshapes that keyframe (box turns its color); dragging off a keyframe edits the home pose and won't move the object at a mid-animation scrub point.

## Camera / zooms (spec 13 — screen-recorder-style push-ins)

A project-level list of discrete **`CameraZoom`s** (`Project.zooms?`) compiles into a single global `ctx.translate/scale` on the render — a "camera". Because object coords are normalized 0–1, one transform composes over every object for free, and it lives inside the shared `renderFrame`, so **preview (Live view) and export are identical by construction**. A thin layer on the spec-12 easing engine (reuses `ease`/`lerp`) with its own **`{x,y,scale}` pose model** — a 3-component mirror of the object `Keyframe[]` machinery (poses/upsert/color), not a reuse of it.

- **Resolver (`src/lib/camera.ts`)**: `resolveCamera(zooms, globalTime): CameraState` (`{x,y,scale≥1}`; `IDENTITY_CAMERA = {0.5,0.5,1}` = full frame). **Governing-window model**: zooms are sorted by `startTime`; each governs `[startTime_i, startTime_{i+1})` and plays ease-in → hold → ease-out, but the ease-in starts from `fromPose_i` = the resolved pose at its start. So **A→B chaining is timing-driven**: if B starts while A is still active the camera moves straight A→B (no pull-back); a gap → A eases back to full frame first. Single left-to-right pass. Also exports `cameraFrameRect`/`cameraFromFrameRect` (the normalized rect a pose frames: `w=h=1/scale`), `isIdentityCamera`, `zoomEnvelope`, `governingZoomAt`. **`scale ≥ 1` only** (no zoom-out in v1).
- **Zoom keyframes (pan/scale path)**: a `CameraZoom` can carry `keyframes?: CameraKeyframe[]` — a whole-pose (`{x,y,scale}`) path so one zoom pans/scales through several poses. **Times are relative to the HOLD-segment start** (`startTime + transitionIn`), so ease-in still ramps full-frame→first pose and ease-out ramps last pose→full-frame; the keyframe path plays *during the hold*. The zoom's own `x/y/scale` is the `t=0` waypoint. No keyframes ⇒ constant path ⇒ **bit-identical** to the old static hold. Helpers mirror `keyframes.ts`: `zoomPoseAt`/`zoomTargetPoseAt` (`poseAt`), `editZoomPose` (`editPose`, upsert-per-rule), `addZoomKeyframeAt`, `activeZoomKeyframeIndex`, `zoomHoldTime`. All three surfaces get parity: canvas framing-rect drag upserts via `editZoomPose` against the live zoom, `ZoomEditor` has a Keyframes section (+ keyframe-aware Focus x/y/scale), and the Timeline camera-track bar shows draggable diamonds (`zoom-move-keyframe`). Because it's all inside `resolveCamera`, Live view + export pan for free.
- **Frame view vs Live view** (`cameraView: 'frame'|'live'` in `App.tsx` — pure view state, NOT persisted / not undo): **Frame** (default authoring) renders un-zoomed + the overlay draws the framing rectangle & grey scrim; **Live** passes `resolveCamera(...)` into `renderFrame` for the real push-in and **disables object editing**. Toggle = canvas corner button or **`V`**. Export always renders Live.
- **Authoring**: `+ Zoom` / "Camera zoom" CTA (the **Effects** section of `LeftRail.tsx`) creates a default zoom at the playhead, selects it, switches to Frame view. Edit numerically in `PropertiesPanel`'s **`ZoomEditor`** (focus x/y, scale, timing, easing, delete), or on-canvas: drag the framing rect body (moves focal point, clamped in-bounds) / a corner handle (scales about the fixed focal point) via `UPDATE_ZOOM_TRANSIENT`→`COMMIT_TRANSIENT`. In Frame view a **selected** zoom shows its *editable target* rect (with handles); when nothing is selected the *resolved* rect is shown read-only and **animates** as the playhead moves.
- **Timeline Camera track** (`Timeline.tsx`): a **pinned** track (its own row under the ruler, ⛶ gutter label) rendering `project.zooms` as amber envelope bars (ease-in/out shown as end ramps, hold = solid middle). Drag body = retime `startTime`; drag edges = adjust `hold` anchored at the opposite edge; click = select. Adjacent bars make A→B chaining visible. All transient→commit.
- **Selection invariant**: `selectedObjectId` and `selectedZoomId` are mutually exclusive — selecting one clears the other (enforced in `App.tsx`). `PropertiesPanel` renders the `ZoomEditor` instead of the object editor when a zoom is selected.

## Video effects (spec 23 — render-wide colour/overlay post-process)

A project-level list of **`VideoEffect`s** (`Project.effects?`) resolved by `src/lib/effects.ts` into the effect stack active at a time, then applied as a **full-frame post-process AFTER the object loop** inside the shared `renderFrame` — so preview and export match by construction. Mirrors the camera's architecture, but effects **do NOT chain / hand off** — each resolves its own eased intensity from its envelope and they simply stack. No active effects ⇒ the whole block is skipped ⇒ output is pixel-identical to pre-spec-23.

- **Model (`types.ts`)**: `VideoEffect = {id, kind, intensity (0–1 peak), startTime, transitionIn, hold, transitionOut, easing, vignette?, oldfilm?, …per-kind payloads, hidden?}`. `VideoEffectKind` is now **22 kinds across three tiers** (`types.ts:256-266`): **spec 23** `grayscale|sepia|invert|vignette|grain|oldfilm`; **spec 24** CSS-`ctx.filter` grades `hue|contrast|bleach` + blend/overlay `lightleak|chromatic|pixelate`; **spec 25 (WebGL)** `gradientmap|posterize|threshold|channelswap|colorisolate|dither|crt|vhs|halftone|comic`. The **envelope shape is identical to a zoom** (`effectEnvelope = in+hold+out`), but the eased quantity is the **intensity** (0→peak→0), so the ease-in *is* the fade-in. Per-kind payload mirrors `{type,data}`: e.g. `vignette` → `VignetteParams{shape,size,feather}`, `oldfilm` → `OldFilmParams{wobble}` (frame-weave, **decoupled from intensity**), plus payloads for the WebGL kinds.
- **Resolver**: `resolveEffects(effects, globalTime): ResolvedEffect[]` — skips hidden, drops intensity ≤ 0, orders by **`startTime` then `id`** (deterministic compose order). The renderer splits the survivors by tier: colour grades → one `ctx.filter` string (`effectsToFilterString`, applied via a self-composited redraw); Canvas-2D overlay kinds (vignette/grain/oldfilm/etc.) drawn on top with the filter reset; **per-pixel / warp kinds → the WebGL pipeline** (see below). **Time-animated kinds** (grain, old-film, VHS, …) derive their per-frame jitter **deterministically from `globalTime`, never `Math.random`** — so preview and export are identical and frame-reproducible.
- **WebGL/regl pipeline (`src/lib/glEffects.ts`, spec 25)**: per-pixel and warp effects (`gradientmap`, `posterize`, `threshold`, `channelswap`, `colorisolate`, `dither`, `crt`, `vhs`, `halftone`, `comic`) run as **regl/WebGL fragment-shader passes**, NOT Canvas 2D. **Architectural rule (load-bearing):** per-pixel/warp effects belong in the shader pipeline and must **never** use a Canvas 2D `getImageData` readback per frame — that readback is too slow to sustain frame rate (spec 24 D3). Anything needing to read/transform every pixel goes in `glEffects.ts`; Canvas 2D `ctx.filter` + composited overlays cover only the colour-grade and overlay tiers. The pipeline is invoked inside the shared `renderFrame`, so preview (Live view) and export stay identical by construction.
- **Actions / selection**: `ADD_EFFECT` / `UPDATE_EFFECT` / `UPDATE_EFFECT_TRANSIENT` / `REMOVE_EFFECT` (mirror zoom CRUD). `selectedEffectId` in `App.tsx`, mutually exclusive with object/zoom selection; `PropertiesPanel` shows the effect editor when one is selected. Created from the **Effects** section of `LeftRail.tsx` (which also holds effect **presets**, `src/lib/effectPresets.ts`).
- **Effects track** (`Timeline.tsx`): a **pinned** track below the Camera track, rendering `project.effects` as amber envelope bars stacked into **display rows** so overlapping effects stay visible + grabbable. **Row-layout rule**: `layoutEffectRows` packs greedily in **creation (array) order — NOT sorted by `startTime`** — so an effect's row is stable and it never "jumps lanes" when dragged past another in time (first-fit still guarantees no two overlapping bars share a row). The layout is additionally **frozen for the duration of any effect drag** (captured on mousedown, released on mouseup) so rows don't reshuffle mid-gesture — they re-pack only on release.

## Playback, audio, media (`src/hooks/`)

- **`usePlayback`** — owns `globalTime` (state, advanced by rAF while playing), `isPlaying`, `totalDuration`, `play/pause/togglePlayback/seek`.
- **`useAudioPlayback`** — one `HTMLVideoElement`/`HTMLAudioElement` per audio/video object; syncs `currentTime` to `sourceTimeAt(...)`, sets `playbackRate = clipRate(data, duration)` (= `span/duration`, clamped; see `mediaTiming.ts`), applies `volume`, handles mute. Preview audio preserves pitch (media element default); export does not (spec 11). Registers video elements in `mediaRegistry` so the canvas can blit them.
- **`mediaRegistry.ts`** — module-level `Map<objectId, HTMLVideoElement>`; written by `useAudioPlayback`, read by `useCanvasRenderer`. One decoded element per video object.
- **`assetStore.ts`** — asset blobs in IndexedDB; `getAssetUrl/getAssetBlob`, `getMediaDuration`, `generateWaveform` (200 mono max-peaks, audio only today; video has no waveform field yet). Size warnings (`SIZE_WARN_*`).

## Export (`src/lib/ffmpegExport.ts` + worker files)

Tiered: **WebCodecs `VideoEncoder` + `mp4-muxer`** (primary, main thread) → **MediaRecorder → WebM** (non-WebCodecs browsers). Per frame it calls `renderFrame` onto a canvas, wraps it in a `VideoFrame`, encodes. Audio is pre-mixed on the main thread via `OfflineAudioContext` (sums **all** audio + video sources — confirmed multi-track), AAC-encoded. `videoDecoder.ts` (WebCodecs `VideoDecoder`) sources video frames; it handles a non-zero starting CTS. `exportWorker.ts`/`exportWorkerTypes.ts` are a **partly-dead** worker pipeline being resurrected in spec 09 (export currently runs on the main thread → UI freezes during export). `ExportModal.tsx` + `useFFmpegExport.ts` drive the UI.

## File map

| Area | Files |
|---|---|
| Types / factories | `src/types.ts` |
| Reducer / undo | `src/hooks/useProject.ts` |
| Playback | `src/hooks/usePlayback.ts`, `useAudioPlayback.ts`, `useCanvasRenderer.ts` |
| Compositor | `src/lib/renderer.ts` (shared preview+export) |
| Animation core | `src/lib/keyframes.ts` (poses/keyframes/transitions), `src/lib/easing.ts` |
| Camera / zooms | `src/lib/camera.ts` (`resolveCamera` + rect helpers); zoom UI in `Canvas.tsx` (framing rect/scrim + Live toggle), `Timeline.tsx` (Camera track), `PropertiesPanel.tsx` (`ZoomEditor`), `LeftRail.tsx` (`+ Zoom`) |
| Video effects | `src/lib/effects.ts` (`resolveEffects`), `src/lib/glEffects.ts` (WebGL/regl per-pixel tier), `src/lib/effectPresets.ts` (preset stacks); Canvas-2D overlays drawn in `renderer.ts`; per-kind icons in `src/components/effectIcons.ts` (`EFFECT_ICON`); UI in `Timeline.tsx` (Effects track), `PropertiesPanel.tsx` (effect editor), `LeftRail.tsx` (Effects + Presets sections) |
| Lanes / selection | `Timeline.tsx` (lane range, multi-select gestures, group move, trim/split bars), `App.tsx` (`selectedObjectIds` + derived `selectedObjectId`) |
| Drawing | `src/lib/annotations.ts` (arrow/text/shape/freehand + bezier math) |
| Media/assets | `src/lib/assetStore.ts`, `mediaRegistry.ts`, `src/lib/mediaTiming.ts` (trim/speed/window mapping), `src/lib/animatedImage.ts` (animated GIF/WebP probe) |
| Colour / helpers | `src/lib/color.ts`, `src/lib/snapping.ts` (timeline snap), `src/lib/objectDefaults.ts` (remembered style/data), `src/lib/aspectRatios.ts`, `src/lib/canvasSizePref.ts`, `src/lib/exportSettings.ts` |
| Persistence / prefs | `src/lib/projectStorage.ts` (localStorage + `.gerty` zip export/import), `src/hooks/useUiPrefs.ts` |
| Export | `src/lib/ffmpegExport.ts`, `videoDecoder.ts`, `exportWorker.ts`, `exportWorkerTypes.ts`, `ExportModal.tsx`, `src/hooks/useFFmpegExport.ts` |
| Per-object download | `src/lib/objectDownload.ts` (original source blob + trimmed/extracted re-encode via the export encoders); UI = Download buttons in `PropertiesPanel.tsx`, wired through `App.tsx` `handleDownloadObject` |
| UI | `App.tsx`, `Canvas.tsx` (viewport+overlay), `Timeline.tsx`, `PropertiesPanel.tsx` (+ `propertyControls.tsx`), `LeftRail.tsx` (creation/asset rail), `ContextToolbar.tsx` (selection toolbar + Animate popover), `TransportBar.tsx`, `HotkeysModal.tsx`, `AppearanceControls.tsx`, `AspectRatioSelector.tsx`, `VolumeControl.tsx`, `Popover.tsx`, `ImportModal.tsx`, `ExportModal.tsx` |

## Gotchas / current rough edges

- **60Hz re-render**: `globalTime` is React state, so playback re-renders `App`→`Canvas`→`Timeline`→`PropertiesPanel` every frame. Fine for now; spec 09 A3 addresses it for video-heavy projects.
- **No DPR handling**; canvas backing store = raw project dims.
- **Lanes never compact & a new top/bottom lane is always +1 reachable** — the lane-drag clamp is intentionally relative to the clips you're *not* dragging (see Timeline lanes & selection), not the current extent, so you can always promote/demote a clip past the others.
- **A split clip is deliberately "untrimmed"** — its `sourceMin/sourceMax` window is collapsed to its span so no recoverable ghost overlaps the sibling. Editing trim afterward can re-open ghosts *within that window* only.
- **Effect track rows pack in creation order, not by `startTime`** (and freeze during a drag) — otherwise a dragged effect bar re-ranks and appears to jump to another track. Display-only; the renderer stacks all active effects regardless of row.
- **Export runs on the main thread** → UI freezes during export; not cancellable. Spec 09 B4/B8.
- **Overlay must mirror render transforms** — the selection overlay is a separate canvas. Spec 13's camera **avoids** needing an inverse transform in v1 by only editing objects in the un-zoomed **Frame view** (Live view disables editing). If object editing while zoomed is ever added, the overlay/hit-testing will need the inverse camera transform.
- **Camera export is wired but main-thread** — all three export paths (`ffmpegExport.ts` WebCodecs + MediaRecorder, plus `exportWorker.ts`) pass `resolveCamera(project.zooms, t)` per frame, so exports show the same push-ins as Live view.
- **Editing NEVER auto-creates keyframes** (spec 36) — `editChannel`/`editPose` only edit the keyframe you're parked on, else the base value. Keyframes are created solely by the `+ Keyframe` button (`addKeyframeAt`) and the ◆ channel toggle (`toggleChannel`). (This replaced the earlier button-optional model where any off-keyframe edit dropped a keyframe at the playhead, which spawned unwanted keyframes while scrubbing.)

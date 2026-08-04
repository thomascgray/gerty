# 35 — Auto Captions (in-browser speech-to-text subtitles)

## Overview

A new **Auto Captions** flow: the user clicks "Auto captions", the app runs **speech recognition
entirely in-browser** (no backend) over the timeline's mixed audio, and produces a **caption track** -
a project-level entity that lives on its own pinned timeline row (like camera zooms and video
effects) and **renders styled subtitle text onto the canvas** at the times each phrase is spoken.

Because it transcribes the **final mixed audio** of the whole timeline, it works for **any source of
spoken word**: a video clip's own audio track, an imported audio clip, or a TTS narration clip
(spec 32) - all at once, at the correct time, with no per-source wiring.

The caption track remembers *how it was generated* (source scope), so if the user changes the audio
they can **re-generate** the captions on demand (they are not auto-invalidated - regeneration is a
manual action, matching the user's ask).

This spec covers **generation + rendering + the track UI**. Rich per-cue editing and deep style
controls in the properties panel are explicitly **deferred** (the panel is minimal in v1 - a
regenerate button and basic style).

> This is a large feature. The load-bearing good news: the app **already ships an in-browser ML
> stack** from spec 32 (TTS) - `onnxruntime-web`, a lazy-loaded Web Worker, self-hosted model
> weights on Cloudflare R2, and COOP/COEP cross-origin isolation headers. Auto-captions reuses all
> of that infrastructure; the only genuinely new ML piece is a Whisper ASR model + engine wrapper.

## Requirements

### R1 — "Auto captions" entry point
- A new item in the **Media** section of `LeftRail.tsx` (alongside "Add media", "Text to speech",
  "Record voiceover"), labeled **"Auto captions"** with a captions/subtitle-style icon. Clicking it
  opens the **Captions modal**.
  - Rationale for Media (resolved): captions are *derived from the media's audio* and sit next to the
    other audio-authoring tools (TTS, Record). It behaves architecturally like an Effects/zoom entity
    (own pinned row), but its *authoring affordance* belongs with audio.

### R2 — Captions modal (choose scope + generate)
- A modal (`CaptionsModal.tsx`, styled like `TtsModal.tsx`/`RecordModal.tsx`) with:
  - An on-device notice ("Transcription happens in your browser and never leaves this device.",
    matching the TTS/Record modals' tone).
  - **Scope**: v1 defaults to **"Entire timeline"**. The source model is structured to allow a
    **time range** later (see Open Q / Technical §5). (Whole-timeline first, per the ticket: "all
    the video to start with is just conceptually simpler.")
  - A **Generate** action that: mixes the audio (§2), runs ASR (§3) with progress (model download %
    on first run, then a transcribing state), and shows a **preview list** of the recognized cues
    (timestamp + text) so the user sees what was produced before committing.
  - A primary button **"Add captions"** (create) / **"Regenerate"** (edit) that commits the cues to
    the project. Disabled until a successful Generate.
- The modal must remain responsive during generation (worker-threaded ASR, §4).

### R3 — Speech recognition produces timed cues
- ASR yields a list of **caption cues**, each `{ startTime, endTime, text }` in **global timeline
  seconds** (segment/phrase granularity - a cue per spoken phrase, the standard subtitle unit).
- Empty/whitespace segments are dropped. Cues are sorted by `startTime`. Overlaps are clamped so
  cues don't overlap (an ASR segment's `endTime` is capped at the next segment's `startTime`).

### R4 — Lands as a project-level Caption track (own pinned row)
- Generation creates/updates a **`CaptionTrack`** on `Project.captions` (a **new project-level
  entity**, NOT a `TimelineObject` - mirrors `CameraZoom`/`VideoEffect`). It carries the `cues[]`,
  the generation `source` scope, a shared subtitle `style`, and `hidden?`.
- It renders as a **pinned timeline row** below the Camera and Effects tracks in `Timeline.tsx`,
  showing one small bar per cue (with its text) positioned at each cue's `[startTime, endTime]`.

### R5 — Captions render on the canvas (preview + export identical)
- Inside the shared `renderFrame` (`src/lib/renderer.ts`), a **new final render stage** - AFTER the
  object loop AND after the video-effects post-process, and **outside the camera transform** - finds
  the **active cue** at `globalTime` (the cue whose `[startTime, endTime)` contains it) and draws its
  text as a subtitle: horizontally centered, near the bottom of the frame, with an optional
  background/outline for legibility. Only one cue shows at a time (standard subtitle model).
- Because this lives in the single shared compositor, **preview (Live view) and export are identical
  by construction** - no export-path changes (exactly like text objects and effects).
- Captions are **pinned overlays**: unaffected by the camera zoom and NOT graded by video effects
  (they draw last, on top). This is the correct subtitle behavior and it's why the stage sits after
  the effects block, with the camera transform not applied.

### R6 — Re-generate on demand
- Selecting the caption track shows a **"Regenerate"** action (in the panel and/or modal) that
  re-runs the whole flow (mix → ASR) and **replaces the cues in place**, preserving the track id,
  style, and scope. One undo entry. (Captions are NOT auto-invalidated when audio changes - the user
  regenerates manually, per the ticket.)

### R7 — Selection + properties panel (incl. per-cue text editing)
- A new **`selectedCaptionId`** in `App.tsx`, **mutually exclusive** with
  `selectedObjectId`/`selectedZoomId`/`selectedEffectId` (selecting one clears the others).
- `PropertiesPanel.tsx` shows a **CaptionEditor** when the track is selected, with:
  - A **Regenerate** button and a **hide** toggle.
  - **An editable list of cues** — each cue's recognized `text` is shown in an editable field so the
    user can **correct whatever the ASR got wrong** (misheard words, names, punctuation). This is a
    **v1 requirement**, not deferred: auto-transcription is never perfect, so text correction is core
    to the feature being usable. Each cue row shows its timestamp (read-only in v1) alongside the
    editable text. Editing text is one undo entry per edit and does not re-run ASR.
  - Basic style (font size, color, background on/off, vertical position) is a nice-to-have for v1.
  - Deferred to a follow-up: editing cue **timings**, splitting/merging cues, adding/deleting
    individual cues.
- Clicking any cue bar on the timeline row selects the **track** (and could scroll the panel's cue
  list to that cue — nice-to-have). Per-cue *timing* selection is deferred; per-cue *text* editing
  happens in the panel list.

### R8 — Persistence
- `Project.captions` persists in the project JSON and in the `.gerty` export (additive/optional,
  exactly like `zooms`/`effects`/`markers`). No asset blob is involved (cues are just text +
  timings), so `.gerty` needs no new bundling. Reopening a project restores the captions and the
  ability to regenerate. The ASR model is re-downloaded on first regeneration on a fresh machine
  (the cues themselves are already saved).

### R9 — Non-blocking generation
- ASR (and model load) run in a **Web Worker** so the modal's progress UI stays live - reusing the
  worker pattern established for TTS (spec 32 R8). No main-thread inference.

### R10 — Graceful failure & empty results
- If the model fails to download (offline / CDN error) or inference throws, the modal shows an error
  and the user can retry; no partial/broken track is created.
- If the timeline has **no audio/video sources** (nothing to transcribe), the modal says so and the
  Generate action is disabled. If ASR finds **no speech**, the modal reports "No speech detected"
  and creates no track.

## Technical Considerations

**CRITICAL: TypeScript types.** New/changed types in `src/types.ts`:

```ts
// === Captions (spec 35) ===

// One recognized subtitle line. Times are GLOBAL timeline seconds (not clip-relative), so the
// renderer can pick the active cue with a plain globalTime range test — no per-object mapping.
export type CaptionCue = {
  id: string
  startTime: number   // global seconds — when the phrase begins
  endTime: number     // global seconds — when it ends (> startTime; clamped not to overlap the next)
  text: string        // the recognized phrase
}

// How the captions were generated — provenance for Regenerate (mirrors TtsSource's role). v1 only
// emits mode:'all'; the range fields are reserved so a time-range scope drops in without a migration.
export type CaptionSource = {
  mode: 'all' | 'range'
  rangeStart?: number  // global seconds (mode:'range')
  rangeEnd?: number    // global seconds (mode:'range')
  // No model/engine version pinned in v1; regenerating uses whatever ASR model is current.
}

// Shared subtitle styling for the whole track (all cues render uniformly — the standard subtitle
// model). Kept small in v1; extend later. Position is expressed as a normalized 0–1 baseline anchor.
export type CaptionStyle = {
  fontSize: number      // px in project space (pre-scaleFactor), like TextData/ObjectStyle.fontSize
  fontFamily: string
  color: string         // fill
  background: boolean    // draw a translucent box behind the text for legibility
  position: number      // normalized 0–1 vertical anchor of the caption baseline (default ~0.9)
  // (future: outline, alignment, max width, per-cue overrides)
}

// A generated caption track — a project-level entity (NOT a TimelineObject; mirrors CameraZoom /
// VideoEffect). Rendered by renderFrame as on-canvas subtitles; shown on its own pinned timeline row.
export type CaptionTrack = {
  id: string
  cues: CaptionCue[]
  source: CaptionSource
  style: CaptionStyle
  hidden?: boolean       // spec 14 R11 parity: skipped in render when true
}
```

- **`Project`**: add optional `captions?: CaptionTrack` (additive, back-compat - absent ⇒ no
  captions, output pixel-identical to pre-spec-35). Single track in v1; see Open Q on array-vs-single.
- **Actions** (`ProjectAction`): `SET_CAPTIONS` (create/replace the whole track - covers both first
  generation and regenerate as one undo entry), `UPDATE_CAPTIONS` (merge style/hidden edits),
  `UPDATE_CAPTION_CUE` (`{ cueId, text }` — edit one cue's text for R7 correction; one undo entry per
  edit), `REMOVE_CAPTIONS`. Mirrors the effect CRUD shape.
- **Factory**: `createCaptionTrack(cues, source, options?)` with sensible default `CaptionStyle`
  (e.g. `{ fontSize: 48, fontFamily: 'sans-serif', color: '#ffffff', background: true, position: 0.9 }`).

### §0 — Why NOT the browser Web Speech API (`SpeechRecognition`) — load-bearing
Considered and **rejected**, for the same class of reason spec 32 rejected Web Speech for TTS:
- **It only listens to the live microphone.** There is no standard way to feed `SpeechRecognition`
  a decoded `AudioBuffer`, a file blob, or a timeline `MediaStream` — it captures the default audio
  *input* device. So it fundamentally cannot transcribe the timeline's **mixed audio** (the core
  requirement). The only "workaround" is acoustic loopback (play audio aloud → mic re-hears it),
  which is unshippable (needs speakers+mic, room noise, poor quality).
- **No media-anchored timestamps.** It returns interim/final transcript strings, not per-segment
  `[start, end]` tied to the audio timeline. Subtitles are entirely about timing — this alone
  disqualifies it. (Whisper's `return_timestamps` is exactly what we need.)
- **Not on-device + patchy support.** Chrome streams audio to Google servers (breaking the app's
  "never leaves this device" posture that the TTS/Record modals promise); Firefox doesn't implement
  it; Safari is partial.
Conclusion: a client-side neural ASR model that takes a raw PCM buffer and returns timed text is the
only viable path. (Decision confirmed with the user, spec session.)

### §1 — Why the mixed-audio approach (load-bearing)
The ticket wants captions for "ANY source of spoken word" - video audio, audio clips, or TTS. Rather
than transcribe each source object separately (which sources? how to merge overlapping timelines?),
we transcribe the **final mixed audio of the timeline**, exactly what the viewer hears. This reuses
the **existing export audio-mix pattern**: `prerenderAudioMix` in `ffmpegExport.ts` (lines ~150-203)
already sums **all** non-hidden audio+video sources through an `OfflineAudioContext`, honoring each
clip's `startTime`, trim (`sourceIn`/`sourceSpan`), rate, and volume. We do the same, but render to
the format Whisper wants: **16 kHz mono** (`new OfflineAudioContext(1, ceil(dur*16000), 16000)`).
The returned `Float32Array` feeds straight into the ASR pipeline, and the **timestamps come back
relative to the start of that buffer** - so they map directly to global time (offset by the range
start when a range scope is added later).

- Consequence: background music with lyrics would also be transcribed. Acceptable for v1 (the user
  can regenerate/edit); a per-source picker is a future refinement (Open Q).
- Factor the 16 kHz-mono mix into a small shared helper (or a parameter on the existing mix code) so
  the export path and the caption path don't drift.

### §2 — ASR engine: Whisper via transformers.js (recommended)
- **`@huggingface/transformers`** (transformers.js v3) exposes a turnkey
  `pipeline('automatic-speech-recognition', model, { device, dtype })` that runs **Whisper** ONNX
  models on `onnxruntime-web` (the runtime **already bundled**). Call it with
  `{ return_timestamps: true, chunk_length_s: 30, stride_length_s: 5 }` to get **segment-level
  timestamps** over long audio (it handles the 30s-window chunking + stitching internally). Output is
  `{ text, chunks: [{ timestamp: [start, end], text }] }` - each `chunk` becomes a `CaptionCue`.
- **Model (chosen): `distil-whisper/distil-small.en`** — English-only distilled Whisper (~170 MB q8),
  faster than the full small.en with a clear accuracy step up from base.en. Use **q8/int8**
  quantization on the WASM path. transformers.js supports distil-whisper via the same ASR pipeline
  call — only the model id differs, so bumping to `distil-medium.en` / `whisper-small.en` (more
  accuracy) or `distil-small.en`→lighter (smaller) later is a one-line swap. **Distil-whisper caveat**:
  distil models are tuned for `return_timestamps: true` (segment) — **segment timestamps are reliable;
  word-level timestamps are NOT well-supported on distil models**, which reinforces the segment-level
  choice (Open Q1).
- **Bundle discipline** (same rule as spec 32): all `@huggingface/transformers` imports live **only
  inside the ASR Web Worker**, dynamically loaded, so the initial bundle and non-caption users pay
  nothing. Verify the code-split (a new worker chunk, transformers not in the main bundle).
- **Raw-ORT alternative (NOT recommended for v1)**: build the Whisper encoder/decoder loop directly
  on `onnxruntime-web` (as spec 32 did for pocket-tts) - avoids adding transformers.js but is *far*
  more wiring (log-mel feature extraction, autoregressive decode, timestamp-token parsing, tokenizer,
  KV-cache). transformers.js's ASR pipeline does all of this and is well-trodden for exactly this use
  case. Recommend transformers.js; note the alternative for the record.
- **Faster English-only alternative (future)**: transformers.js also runs **Moonshine** (ONNX),
  markedly faster than Whisper on CPU, English-only. Timestamp support is less mature - stick with
  Whisper for reliable subtitle timings in v1, note Moonshine as a speed follow-up.

### §3 — Model hosting reuses spec-32 infra
- Whisper ONNX weights are large (~75-150 MB). **Reuse the exact hosting strategy spec 32 landed**:
  self-host on **Cloudflare R2** (gitignored locally, fetched by an `npm run fetch-*` script for dev;
  served from the R2 custom domain in prod), with the app's **COOP/COEP headers already in place**
  (`public/_headers` + the Vite dev headers) so `SharedArrayBuffer`/threaded WASM works. transformers.js
  can be pointed at a custom model host via its `env` (mirroring how the pocket-tts worker sets
  `MODEL_BASE`). One-time download, browser-cached; gate behind the first Generate with progress.
- **Threading caveat carried over from spec 32**: the onnxruntime pthread deadlock they hit was fixed
  by **dynamically importing** the ORT/engine module so Rollup code-splits it into its own chunk (so
  ORT's pthread workers re-load the ORT-only chunk, not our worker chunk). Keep the transformers.js
  import dynamic inside the worker for the same reason. See TASK 32 work log (2026-08-03 threading).

### §4 — Rendering stage (renderFrame)
- Current `renderFrame` order (`src/lib/renderer.ts:42-161`): (1) black bg fill; (2) per-object loop,
  each object individually wrapped in the camera transform (lines 60-94); (3) effects post-process -
  colour-grade filter, Canvas-2D overlays, then the WebGL shader branch (lines 96-161). There is
  currently **no final un-transformed overlay stage** after effects - captions add one.
- **New stage (append after line ~161)**: if `editorOptions.captions` (or passed alongside effects)
  and not hidden, resolve the active cue at `globalTime`, and if present draw the subtitle. It runs
  with **no camera transform and `ctx.filter='none'`**, on top of the graded frame - so captions are
  never zoomed or colour-graded. Reuse the text measurement/drawing helpers from
  `src/lib/annotations.ts` (`drawText`) where practical, or a small dedicated `drawCaption`.
- Thread the caption track into `renderFrame` the same way effects/camera are: via `EditorOptions`
  (add `captions?: CaptionTrack`), populated by `useCanvasRenderer` (preview) and each export path.
  Export currently passes `resolveCamera(...)` and effects per frame; add the caption track the same
  way (it's static per frame - just pass it through; no per-frame resolve needed beyond the active-cue
  lookup, which the renderer does).
- Optional polish: a short per-cue fade-in/out (a few frames) driven deterministically from
  `globalTime` around each cue's edges, so cues don't hard-pop. Keep deterministic (no `Math.random`)
  so preview==export. Deferred if it complicates v1.

### §5 — Scope / time range (v1 = whole timeline)
- v1 emits `source: { mode: 'all' }` and mixes `[0, totalDuration]`. The `CaptionSource` type already
  carries `rangeStart`/`rangeEnd` so a range scope is a modal control + an offset added to the ASR
  timestamps later - no type migration. Recommend shipping whole-timeline first.

### §6 — Determinism / export
- Like TTS: ASR runs **once at author time**; the cues are frozen data in the project. Export just
  reads `captions.cues` and the renderer draws the active one per frame - no per-frame ML, fully
  deterministic, preview==export. (Unlike the time-animated video effects, there's no per-frame RNG
  concern beyond the optional fade, which is time-derived.)

## Related Systems and Tasks

- **In-browser ML precedent (reuse wholesale)**: `SPECS/32-text-to-speech.md` + `TASKS/32-text-to-speech.md`
  - the worker pattern, onnxruntime-web, R2 model hosting, COOP/COEP headers, the pthread-deadlock
  fix, lazy-load/code-split discipline, and the modal scaffold all transfer directly.
- **Audio mix**: `src/lib/ffmpegExport.ts` `prerenderAudioMix` (~150-203) - the template for the
  16 kHz-mono caption mix; uses `mediaTiming.ts` (`srcIn`/`sourceSpan`/`clipRate`) + `effectiveVolume`.
- **Project-level own-row entities (architecture to mirror)**: `CameraZoom`/`VideoEffect` in
  `src/types.ts`; `resolveEffects` (`src/lib/effects.ts`); the Camera/Effects pinned tracks in
  `src/components/Timeline.tsx`; the `selectedZoomId`/`selectedEffectId` selection model + mutual
  exclusion in `src/components/App.tsx`; `PropertiesPanel.tsx` editor routing.
- **Rendering**: `src/lib/renderer.ts` `renderFrame` (shared preview+export); text drawing in
  `src/lib/annotations.ts` (`drawText`).
- **Creation rail**: `src/components/LeftRail.tsx` Media section (TTS/Record buttons + threaded props).
- **Modal scaffolds**: `src/components/TtsModal.tsx`, `src/components/RecordModal.tsx`.

## Resolved Decisions (spec session)

- **Engine: client-side neural ASR (Whisper via transformers.js), NOT Web Speech.** See §0.
- **Entry point: Media section** (next to Text to speech + Record voiceover).
- **Scope: whole timeline only** in v1 (`source.mode:'all'`); range fields reserved for later.
- **Single track**: `Project.captions?: CaptionTrack` (not an array).
- **Model: `distil-whisper/distil-small.en`** (English-only distilled Whisper, ~170MB q8) — a
  one-line model-id swap for more accuracy (distil-medium.en / small.en) or non-English later.
- **Per-cue text editing is a v1 requirement** (R7) so users can correct ASR mistakes.

## Open Questions (non-blocking — sensible defaults chosen, can revisit in `/task`)

1. **Timestamp granularity — effectively settled: segment-level.** Phrase per cue is the natural
   subtitle unit AND distil-whisper models don't reliably support word-level timestamps (§2), so
   `return_timestamps: true` (segment) is the choice. Word-level karaoke highlighting would need a
   non-distil model — a future consideration, not v1.
2. **How much style in v1.** Default: v1 = generate + render + regenerate + hide + **per-cue text
   editing (locked in, R7)**, with *basic* style (size/color/background/position) optional. Per-cue
   *timing* editing and cue add/split/merge deferred to a follow-up spec.
3. **Caption position.** Default ~0.9 (near bottom). Should it dodge bottom-anchored text objects?
   v1: fixed position, user-adjustable later.

## Acceptance Criteria

1. An **"Auto captions"** button appears in the Media rail and opens the Captions modal.
2. Pressing Generate on a timeline that has spoken audio (video audio, an audio clip, or a TTS clip)
   downloads the model on first run (with progress, UI responsive), transcribes it, and shows a
   preview list of timestamped cues.
3. "Add captions" creates a caption track that appears on its own **pinned timeline row** (below the
   Camera/Effects tracks) with a bar per cue.
4. During playback (preview / Live view), the correct caption text appears on the canvas at the right
   time, near the bottom, and disappears when the phrase ends - one cue at a time.
5. Captions are **not** zoomed by the camera and **not** colour-graded by video effects (they render
   on top, pinned).
6. Exporting an MP4 (WebCodecs path) burns in the captions, correctly timed, with **no** changes to
   the export mixer/encoder (they flow through the shared `renderFrame`).
7. Selecting the track shows the panel with a working **Regenerate** (replaces cues in place, one undo
   entry), a hide toggle, and **an editable list of cues** where editing a cue's text corrects the
   on-canvas caption (one undo entry per edit, no re-transcription).
8. Saving to `.gerty` and reopening preserves the caption track (cues + style + scope) and the ability
   to regenerate.
9. Timeline with no audio → the modal says so and disables Generate; audio with no speech → "No
   speech detected", no track created; model-fetch failure → readable error, no broken track.
10. `npx tsc -b` is green; the initial (non-caption) bundle does **not** include the ASR engine
    (verify the dynamic-import code-split).

## Implementation Notes

- **New files**:
  - `src/components/CaptionsModal.tsx` - scope + Generate/preview + Add/Regenerate; progress; error
    (mirror `TtsModal.tsx`/`RecordModal.tsx`).
  - `src/lib/captions.ts` - main-thread client: build the 16 kHz-mono mix (reuse/extract from
    `prerenderAudioMix`), drive the worker, map `chunks` → `CaptionCue[]` (sort, clamp overlaps,
    drop empties), plus the active-cue resolver (`activeCueAt(track, globalTime)`).
  - `src/lib/captions.worker.ts` - the ASR Web Worker: dynamic `import('@huggingface/transformers')`,
    lazy-singleton Whisper pipeline, `env` pointed at the R2 model base, progress callbacks. Keep the
    engine import dynamic (pthread-deadlock fix, spec 32).
  - `drawCaption` in `src/lib/renderer.ts` (or `annotations.ts`) - the on-canvas subtitle draw.
- **`src/types.ts`**: add `CaptionCue`/`CaptionSource`/`CaptionStyle`/`CaptionTrack`, `Project.captions?`,
  the `SET_CAPTIONS`/`UPDATE_CAPTIONS`/`REMOVE_CAPTIONS` actions, and `createCaptionTrack`.
- **`src/hooks/useProject.ts`**: handle the new actions (SET/UPDATE/REMOVE captions +
  UPDATE_CAPTION_CUE), each one undo entry - mirror the effect reducer cases. UPDATE_CAPTION_CUE
  maps `text` onto the matching cue in `captions.cues` immutably.
- **`src/lib/renderer.ts`**: `EditorOptions` gains `captions?: CaptionTrack`; append the caption
  render stage after the effects block (`~line 161`), un-transformed, `ctx.filter='none'`.
- **`src/hooks/useCanvasRenderer.ts`**: pass `project.captions` into `renderFrame`'s `editorOptions`.
- **Export paths** (`ffmpegExport.ts` + `exportWorker.ts`): pass `project.captions` into the per-frame
  `renderFrame` call alongside camera/effects (thread it through the frame-render options).
- **`src/components/App.tsx`**: `selectedCaptionId` state (mutually exclusive - clear it where
  zoom/effect/object selections are cleared, and clear those when selecting a caption); a
  `handleCreateCaptions` (open modal) + `handleCaptionsConfirm` (dispatch `SET_CAPTIONS`) +
  `handleRegenerateCaptions`; render `<CaptionsModal>`.
- **`src/components/LeftRail.tsx`**: add `onCreateCaptions` to props, thread into the Media section,
  render an "Auto captions" button (icon e.g. `IconBadgeCc`/`IconCaptions`).
- **`src/components/Timeline.tsx`**: add a pinned Captions row (mirror the Camera/Effects track
  render + click-to-select), drawing one bar per cue; clicking selects the track (`selectedCaptionId`).
- **`src/components/PropertiesPanel.tsx`**: route to a `CaptionEditor` when `selectedCaptionId` is set
  (Regenerate + hide + basic style + **an editable, scrollable cue list**: each row = timestamp +
  editable text field dispatching `UPDATE_CAPTION_CUE` on change/blur).
- **package.json**: add `@huggingface/transformers` (dynamically imported only).
- **Model hosting**: extend the spec-32 fetch/host scripts + R2 bucket to include the Whisper ONNX
  files; point the worker's model base at them.
- **Verify**: `npx tsc -b`, then a browser checklist (open modal → generate → see cues → add → play →
  confirm on-canvas timing → export → regenerate → reopen) per `.claude/skills/verify`.

### Precise code anchors (from investigation)
- **`renderer.ts`**: append the caption stage **after the `if (fx...)` effects block (after
  line ~161), before the closing brace at line 162** - the last existing draw is the effects
  post-process; there is currently **no** un-transformed overlay stage. Draw un-transformed (like the
  bg fill at `renderer.ts:42-44`) with `ctx.filter='none'`. `EditorOptions` (interface ~`renderer.ts:19-20`)
  gains `captions?: CaptionTrack`. Effects self-composite via `'copy'` redraws (`renderer.ts:108-109,156-157`),
  which is exactly why captions drawn *before* the block would get graded → must draw *after*.
- **`Timeline.tsx`**: constants `RULER_HEIGHT=24`, `CAMERA_TRACK_HEIGHT=32`, `EFFECT_ROW_HEIGHT=26`,
  `GUTTER_WIDTH=32` (`~37-40`). Add a props triplet next to `zooms/effects` (`~21-28`); a gutter label
  cell after the Effects label (`~674-680`) with `top: RULER_HEIGHT + CAMERA_TRACK_HEIGHT + effectsTrackHeight`;
  a new sticky track block mirroring the Effects-track block (`~947-1050`) with its own `top`. If cues
  never overlap, a single fixed row suffices (no `layoutEffectRows`-style packer, `~98-115`). Click a
  cue bar → `onSelectCaption(track.id)` (mirror `onSelectEffect`, `~996-1001`).
- **`App.tsx`**: add `selectedCaptionId` state near `~91`; derived `selectedCaption` near `~149`;
  `handleCreateCaptions`/`handleSelectCaptions` mirroring `handleCreateEffect`/`handleSelectEffect`
  (`~477-507`); add `setSelectedCaptionId(null)` into the zoom/effect/object select+create handlers
  (`~456-507`) for mutual exclusion; thread props to LeftRail (`~848-850`), PropertiesPanel (`~896-909`),
  Timeline (`~950-955`); add caption delete to the keydown effect + its dep array (`~627-642`).
- **`PropertiesPanel.tsx`**: add `if (caption) return <CaptionEditor .../>` to the mutually-exclusive
  branch chain (`~53-59`, alongside `ZoomEditor`@`812` / `EffectEditor`@`1058`); add a `caption` prop.
- **`LeftRail.tsx`**: captions is a distinct entity, so add a dedicated `onCreateCaptions` prop
  (declare `~26`, destructure `~55`) rather than overloading `onCreateEffect`. If placed in the Effects
  section it's a `SimpleSection` item (`~135`); if in Media, mirror the TTS/Record buttons there.

## Rough edges / watch-list
- First-run model download is large + CDN-dependent (reuse spec-32's progress + one-time notice).
- Whole-mix transcription also captures music/lyrics - acceptable v1, note the per-source-picker
  future refinement.
- ASR timing is approximate ("roughly the right time", per the ticket) - segment timestamps drift a
  little; that's expected and editable later.
- Keep the ASR engine import dynamic (bundle split + the ORT pthread-deadlock fix from spec 32).
- Captions must render **after** effects and **outside** the camera transform, or they'd be graded /
  zoomed - the single most important rendering-order constraint here.

---
*This specification is ready for implementation. Use `/task 35-auto-captions` to begin development.*

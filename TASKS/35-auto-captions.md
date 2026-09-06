# 35 — Auto Captions (in-browser speech-to-text subtitles)

**Status**: In Progress

## Overview

Add an **Auto Captions** feature: run in-browser speech recognition over the timeline's mixed audio
and produce a **caption track** - a project-level entity (like camera zooms / video effects) that
lives on its own pinned timeline row and renders styled subtitle text on the canvas at the times each
phrase is spoken. Works for any spoken-word source (video audio, audio clips, TTS) because it
transcribes the final mixed audio. Cues are editable (text correction) and regenerable on demand.

Full spec: [SPECS/35-auto-captions.md](../SPECS/35-auto-captions.md).

## Task Context

- **Reuse the spec-32 (TTS) in-browser ML stack**: `onnxruntime-web`, a lazy Web Worker
  (`src/lib/tts.worker.ts` + `src/lib/tts.ts` client), COOP/COEP headers (already set:
  `public/_headers` + vite dev), model-hosting scripts. Auto-captions mirrors this wholesale.
- **Engine**: Whisper via `@huggingface/transformers` (transformers.js v3) `pipeline(
  'automatic-speech-recognition', ...)` with `return_timestamps: true`, `chunk_length_s: 30`. NEW dep,
  dynamically imported inside the worker only (bundle code-split).
- **Model (chosen)**: `distil-whisper/distil-small.en` (English-only distilled, ~170MB q8). Segment
  timestamps (distil doesn't do reliable word-level). One-line model-id swap if accuracy is too low
  (user will test in browser and may swap models).
- **Model fetching (v1)**: simplest testable path = let transformers.js fetch weights from the HF CDN
  on first Generate (HF sends CORS, works under our COEP). Self-host on R2 is a later/deploy concern
  (mirror spec-32 scripts then). Set `env.allowLocalModels=false` (Vite SPA-fallback trap, spec 32).
- **Threading**: start with `env.backends.onnx.wasm.numThreads = 1` for reliability (spec-32 pthread
  deadlock lesson); revisit multi-thread later if speed matters.
- **Audio input**: mirror `prerenderAudioMix` (`ffmpegExport.ts:150-203`) but render 16kHz MONO
  (`new OfflineAudioContext(1, ceil(dur*16000), 16000)`) summing all non-hidden audio+video sources at
  correct start/trim/rate/volume. Feed the Float32Array to the pipeline; segment timestamps map to
  global time directly (whole-timeline scope).
- **Rendering**: new final stage in `renderFrame` (`src/lib/renderer.ts`, append after the effects
  block ~line 161, before closing brace line 162), drawn un-transformed + `ctx.filter='none'` so
  captions sit on top of everything, un-zoomed and un-graded. `EditorOptions` gains `captions?`.
- **Entity model (locked)**: `Project.captions?: CaptionTrack` (single track, NOT array). New types:
  `CaptionCue`, `CaptionSource`, `CaptionStyle`, `CaptionTrack`. Actions: `SET_CAPTIONS`,
  `UPDATE_CAPTIONS`, `UPDATE_CAPTION_CUE` (per-cue text edit), `REMOVE_CAPTIONS`. Factory
  `createCaptionTrack`.
- **Locked decisions**: Media-section entry point · whole-timeline scope · single track ·
  distil-small.en · segment timestamps · **per-cue text editing in v1** (R7, so users correct ASR).

### Key code anchors (from spec investigation)
- `src/lib/renderer.ts`: `renderFrame` 29-162; bg fill 42-44; per-object camera loop 60-94; effects
  block 96-161; **append caption stage after 161**. `EditorOptions` interface ~19-20.
- `src/components/Timeline.tsx`: consts 37-40 (`RULER_HEIGHT`/`CAMERA_TRACK_HEIGHT`/`EFFECT_ROW_HEIGHT`/
  `GUTTER_WIDTH`); props ~21-28; gutter labels 653-680; Camera track 786-945; Effects track 947-1050;
  `layoutEffectRows` 98-115.
- `src/components/App.tsx`: selection state 83-91; derived selected 147-149; `handleCreateZoom`
  456-464; `handleSelectZoom` 466-473; `handleCreateEffect` 477-484; `handleSelectEffect` 500-507;
  LeftRail wiring 848-850; PropertiesPanel wiring 896-909; Timeline wiring 946-955; delete keydown
  627-642.
- `src/components/PropertiesPanel.tsx`: routing 53-67; `ZoomEditor` 812; `EffectEditor` 1058.
- `src/components/LeftRail.tsx`: props ~26; destructure ~55; section registry 47; Media section
  (TTS/Record buttons); Effects `SimpleSection` items 130-171.
- `src/lib/ffmpegExport.ts`: `prerenderAudioMix` 150-203 (audio-mix template); per-frame `renderFrame`
  calls pass camera+effects (add captions there too).
- `src/hooks/useCanvasRenderer.ts`: preview `renderFrame` call (pass `project.captions`).
- `src/hooks/useProject.ts`: effect reducer cases (mirror for caption actions).
- `src/lib/annotations.ts`: `drawText` (reuse for `drawCaption`).

## Blockers/Issues

None yet. Watch-list:
- transformers.js + Vite module worker + dynamic ort import (bundling/threads) - the spec-32 worker is
  the working reference.
- ASR accuracy of distil-small.en - user tests in browser; model swap is a one-liner if too rough.
- Captions MUST render after effects + outside camera transform (else graded/zoomed).

## TODO

[X] `types.ts`: `CaptionCue`/`CaptionSource`/`CaptionStyle`/`CaptionTrack`, `Project.captions?`,
    4 actions, `createCaptionTrack` factory + `DEFAULT_CAPTION_STYLE`
[X] `useProject.ts`: reducer cases SET/UPDATE/UPDATE_CUE/REMOVE captions (one undo each)
[X] `src/lib/captions.worker.ts`: ASR Web Worker (dynamic `@huggingface/transformers`, distil-small.en,
    segment timestamps, progress messages, numThreads=1)
[X] `src/lib/captions.ts`: client - 16kHz mono mix (mirrors prerenderAudioMix), drive worker,
    map chunks→cues (sort/clamp/drop-empty), `activeCueAt(track, t)` resolver, `hasTranscribableAudio`
[X] `renderer.ts`: `EditorOptions.captions?`, `drawCaption` stage after effects (un-transformed, filter
    reset, wrap + bg box + shadow/outline)
[X] `Canvas.tsx`: `captions` prop → `editorOpts` (shown in BOTH Frame + Live view, like effects)
[X] export paths (`ffmpegExport.ts` x2 + `exportWorker.ts`): pass captions into per-frame renderFrame
[X] `App.tsx`: `selectedCaptionId` (+ mutual exclusion everywhere), handlers (create/select/confirm),
    caption Delete-key case, `<CaptionsModal>` render + LeftRail/Canvas/Timeline/Panel wiring
[X] `CaptionsModal.tsx`: Generate + cue preview list + Add/Regenerate; progress phases; error; no-audio guard
[X] `LeftRail.tsx`: "Auto captions" Media button + `onCreateCaptions` prop
[X] `Timeline.tsx`: pinned Captions row (only when a track exists; bar per cue; click selects+seeks)
[X] `PropertiesPanel.tsx`: `CaptionEditor` (Regenerate + hide + size/colour/position/background +
    editable cue list dispatching UPDATE_CAPTION_CUE + jump-to-cue)
[X] add `@huggingface/transformers` dep (^3.7.5)
[X] verify `npx tsc -b` green + `vite build` green + code-split confirmed (captions.worker 0.99kB;
    transformers.web 877kB + ort as separate lazy chunks, NOT in main bundle)
[X] Fix dev-only full-page-reload on first Generate (Vite optimizeDeps) — needs dev-server restart
[ ] USER: browser test accuracy of distil-small.en; if too rough, swap `MODEL_ID` in captions.worker.ts
[X] FOLLOW-UP: self-host Whisper weights on R2 (mirror spec-32 scripts) — repointed transformers.js
    env.remoteHost/remotePathTemplate at the R2 bucket; `npm run fetch-captions-model` mirrors the tree
[ ] USER: run `npm run fetch-captions-model`, then upload `public/models/distil-whisper/` to the
    gerty-models R2 bucket root (keys like `distil-whisper/distil-small.en/main/config.json`)

## Work Log

[2026-08-04] Implemented the full feature end-to-end. `npx tsc -b` green; `vite build` green and
confirms the ASR engine is code-split out of the main bundle.
- New files: `src/lib/captions.ts` (client: 16kHz-mono timeline mix + worker driver + chunk→cue
  mapping + `activeCueAt`), `src/lib/captions.worker.ts` (transformers.js Whisper `distil-small.en`,
  dynamic import, segment timestamps, numThreads=1), `src/components/CaptionsModal.tsx`.
- Modified: `src/types.ts` (Caption* types + `Project.captions?` + 4 actions + `createCaptionTrack`),
  `src/hooks/useProject.ts` (4 reducer cases), `src/lib/renderer.ts` (`EditorOptions.captions` +
  final `drawCaption` stage after effects, un-transformed + filter reset), `src/components/Canvas.tsx`
  (`captions` prop → editorOpts), `src/lib/ffmpegExport.ts` + `src/lib/exportWorker.ts` (pass captions
  per frame), `src/components/App.tsx` (selection state + handlers + mutual exclusion + Delete + modal
  wiring), `src/components/LeftRail.tsx` ("Auto captions" Media button), `src/components/Timeline.tsx`
  (pinned Captions row + gutter label), `src/components/PropertiesPanel.tsx` (CaptionEditor),
  `package.json`/`package-lock.json` (`@huggingface/transformers`).
- Engine fetches Whisper weights from the HF CDN on first Generate (HF sends CORS → passes our COEP);
  R2 self-hosting deferred to a follow-up. `env.allowLocalModels=false` (Vite SPA-fallback trap);
  numThreads=1 for first-run reliability (spec-32 pthread lesson) — revisit for speed later.
- Build chunks: `captions.worker` 0.99kB, `transformers.web` 877kB, `ort.bundle.min` 463kB (all lazy);
  main `index` 979kB (engine NOT bundled in) → AC10 satisfied.
- KNOWN RUNTIME RISKS to watch in browser test (tsc/build can't catch): (1) transformers.js ESM inside
  the Vite module worker; (2) ort wasm loading from CDN under COEP require-corp (if blocked, serve ort
  wasm locally like TTS's /vendor/ort/); (3) first-run download UX. All surface as a modal error, not a
  silent hang.

[2026-08-04] Fixed dev-only full-page-reload on first Generate (user report: "it tried to reload the
page"). Same root cause as spec-32 TTS: `@huggingface/transformers` (+ its onnxruntime-web) is imported
lazily in captions.worker.ts, so Vite dev discovers it at runtime on the first Generate and does a "new
dependencies optimized" full reload. Fix: added `@huggingface/transformers` to `optimizeDeps.include`
in vite.config.ts so it's pre-bundled at server start. REQUIRES a dev-server restart to take effect.
Prod (vite build) was never affected. Feature otherwise confirmed working by user.

[2026-08-04] Iteration 3 — self-host Whisper weights on R2 (the deferred follow-up). Captions no
longer fetch from the HF CDN at runtime. transformers.js builds file URLs from
`env.remoteHost`+`env.remotePathTemplate`, so the worker now sets `remoteHost` = R2
(`https://gerty-models.tomg.cool/`, the same bucket as TTS) in prod / `/models/` same-origin in dev
(`VITE_CAPTIONS_MODEL_HOST` overrides), and `remotePathTemplate` = `{model}/{revision}/` (flattens
HF's `/resolve/`). New `scripts/fetch-captions-model.mjs` mirrors the exact q8 file tree (10 small
config/tokenizer JSONs + `onnx/encoder_model_quantized.onnx` + `onnx/decoder_model_merged_quantized.onnx`,
all HEAD-verified 200 on HF) into gitignored `public/models/distil-whisper/distil-small.en/main/`, laid
out so the folder uploads to the R2 bucket root verbatim. Shared download helper extracted to
`scripts/hf-mirror.mjs` (fetch-tts-model.mjs refactored onto it). Widened the worker's local
`TransformersModule` env type + added `VITE_CAPTIONS_MODEL_HOST` to vite-env.d.ts. `npm run
fetch-captions-model` script added. tsc + eslint green. REMAINING (user): run the fetch script and
upload the tree to R2. Same bucket already serves TTS under COEP, so CORS needs no new work.
- Files: `src/lib/captions.worker.ts`, `src/vite-env.d.ts`, `scripts/hf-mirror.mjs` (new),
  `scripts/fetch-captions-model.mjs` (new), `scripts/fetch-tts-model.mjs` (refactored), `package.json`.

[2026-08-04] Iteration 2 — user feedback after real testing (music/singing → garbage cues; no real
progress; no cue timing/add/delete). tsc + eslint green. Three additions:
- **Exclude clips from captions**: new top-level `excludeFromCaptions?` on `TimelineObject`. The mix
  (`captions.ts` `isCaptionSource`) skips excluded (and hidden) audio/video, so music/singing clips
  don't confuse Whisper. Panel: "Skip captions" checkbox in the Audio accordion for audio/video
  objects (`PropertiesPanel.tsx`). Requires a regenerate to apply. Persists in project JSON/.gerty.
- **Junk-cue filter**: `hasSpeech()` drops segments with no letter/digit (the stray ",", "...",
  ",..." Whisper emits on non-speech) in `segmentsToCues`.
- **Real progress**: rewrote transcription to window the mix client-side (30s windows, 5s overlap,
  midpoint "core" dedup) in `captions.ts` `transcribeWindowed`; the worker now transcribes one window
  per call (pipeline cached across calls). Progress reports `{phase:'transcribe', done, total}` per
  window → modal shows "Recognizing speech… N% (k/M)" + a determinate/indeterminate progress bar.
- **Full cue editing**: `UPDATE_CAPTION_CUE` now takes `updates` (text AND start/end); added
  `ADD_CAPTION_CUE` (insert sorted) + `REMOVE_CAPTION_CUE` reducer cases + `createCaptionCue` factory.
  CaptionEditor panel: per-cue Start/End number inputs (clamped so a cue can't invert) + delete
  button + "＋ Add caption at playhead". Timeline cue-bar drag deferred (panel gives precise control).
- Files: `src/types.ts`, `src/hooks/useProject.ts`, `src/lib/captions.ts`, `src/components/CaptionsModal.tsx`,
  `src/components/PropertiesPanel.tsx`.

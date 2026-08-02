# 32 — Text to Speech (narration)

## Overview

A new **Text to Speech** authoring flow: the user types or pastes a script, picks a voice
and speed, and the app synthesizes narration **entirely in-browser** (no backend), producing a
real audio clip that drops onto the timeline as an ordinary `audio` `TimelineObject`. From that
point on it behaves exactly like any imported audio clip - it previews, scrubs, trims, splits,
shows a waveform, and is mixed into the exported MP4 with no special-casing.

The clip remembers *how it was generated* (the script text, voice, speed), so the user can reopen
it, edit the text, and **re-generate** - replacing the audio in place.

Target user: someone adding voice-over narration to a screen recording / slideshow.

> Decision locked (spec session): the engine is a **client-side neural TTS model** (WASM/WebGPU),
> not the browser Web Speech API. Rationale in Technical Considerations §1.

## Requirements

### R1 — "Text to Speech" entry point in the Media rail
- A new item in the **Media** section of `LeftRail.tsx` (alongside "Add media"), labeled
  **"Text to speech"** with a mic-style icon. Clicking it opens the **TTS modal** in *create* mode.

### R2 — TTS modal (author + generate)
- A modal (`TtsModal.tsx`, styled like `ImportModal.tsx`) with:
  - A large **script** textarea (multi-line, paste-friendly, no hard length cap but see R9).
  - A **voice** picker (dropdown or grid), grouped by accent/language, with friendly labels
    (e.g. "American - Female (Bella)", "British - Male (George)").
  - A **speed** control (slider, 0.5x–2x), baked into synthesis.
  - A **Generate** action that synthesizes the WAV **once** and plays it in-modal (`<audio>`) so the
    user hears it before committing. The generated `{ blob, duration, sampleRate, params }` is held
    in modal state.
  - A primary button: **"Add to timeline"** (create mode) or **"Re-generate"** (edit mode), which
    **reuses the held blob** - it does not re-synthesize. It is disabled until a successful Generate,
    and editing the text/voice/speed after generating invalidates the held blob (re-enables Generate,
    disables Add until re-generated).
- Generation shows progress: first-run **model download** progress, then a **synthesizing** state.
  The modal must remain responsive (see R8 for the worker/threading requirement).

### R3 — Synthesis produces a real, decodable audio asset
- Synthesis yields PCM samples encoded to a **WAV blob** (16-bit PCM). WAV is chosen over
  MediaRecorder/WebM specifically because `OfflineAudioContext.decodeAudioData` (export) and
  `getMediaDuration` both handle it cleanly, and we already know the exact duration from
  `samples / sampleRate` (no `duration = Infinity` pitfall - see §1).
- The blob is registered as an audio asset via `storeAsset(new File([blob], name, {type:'audio/wav'}))`,
  `meta.duration` is set from the known sample count, and a waveform is generated
  (`generateWaveform`) for the timeline bar.

### R4 — Lands as a normal `audio` TimelineObject
- Create mode: build `AudioData` (`assetId`, `volume:1`, `originalDuration=dur`, `waveform`,
  `sourceIn:0`, `sourceOut:dur`) **plus the new `tts` metadata (R6)**, wrap in
  `createTimelineObject('audio', data, {startTime: playhead, duration: dur, name})`, and add via the
  existing `addObjects([obj])` path (auto-lane, select, Frame view). Reuses `handleAddExistingAsset`
  as the template.
- The clip's `name` is derived from the script (e.g. first ~4 words + "…").

### R5 — Re-generate / edit an existing narration clip
- When an `audio` object carrying `tts` metadata is selected, `PropertiesPanel.tsx` shows an
  **"Edit narration"** button that opens the TTS modal in *edit* mode, pre-filled with the saved
  text/voice/speed.
- Re-generating synthesizes a new WAV, stores a **new** asset, and dispatches `UPDATE_OBJECT`
  merging: new `assetId`, `originalDuration`, `waveform`, reset `sourceIn:0`/`sourceOut:newDur`/
  `sourceMin`/`sourceMax`, updated `duration` (to the new audio length), and updated `data.tts`.
  `startTime` and `lane` are preserved. One undo entry.

### R6 — The clip remembers its TTS parameters (persist + editable)
- Add optional `tts?: TtsSource` to `AudioData`. It persists in project JSON and in the `.gerty`
  export (which already bundles the audio asset blob), so reopening a project keeps both the
  narration audio *and* the ability to edit its script. (The model is re-downloaded on first
  regeneration on a fresh machine; the audio itself is already baked in.)

### R7 — Voice & accent options
- Expose the engine's voice roster as a curated, human-labeled list grouped by accent. At minimum
  cover multiple English accents (American/British) and both binary voice timbres the model ships.
  Speed is a separate control (R2). No other engine params exposed in v1.

### R8 — Non-blocking synthesis
- Model inference must not freeze the UI. Run synthesis (and model load) in a **Web Worker**
  (preferred) so the modal's progress UI stays live. (Export today runs on the main thread and
  freezes the UI - we explicitly do *not* want to repeat that here; spec 09.) A main-thread MVP
  with a spinner is a fallback only if the worker path proves problematic.

### R9 — Long-script handling
- Long scripts are split into sentence/clause chunks, synthesized sequentially, and the resulting
  buffers concatenated into one WAV (the engine ships a text splitter for this). Progress reflects
  chunk completion.

### R10 — Graceful failure
- If the model fails to download (offline / CDN error) or inference throws, the modal shows an error
  and the user can retry; no partial/broken asset or object is created. The rest of the app is
  unaffected (feature is fully lazy-loaded, R-perf).

## Technical Considerations

### §1 — Why NOT the Web Speech API (the load-bearing constraint)
`window.speechSynthesis.speak()` renders straight to the audio output device. There is **no
standard way for a web page to capture that output** into an `AudioBuffer`, `MediaStream`, or Blob
(it is not a `MediaStreamAudioSourceNode`). Since export (`ffmpegExport.ts`) pre-mixes every audio
source through an `OfflineAudioContext` **from decoded blobs**, a Web-Speech clip would be **silent
in the exported MP4** and could not be scrubbed/trimmed/waveformed like a real clip. That fails the
core requirement ("during export it's just the voice"). Hence a neural engine that returns real PCM.

### §2 — Engine: `kokoro-js` (recommended)
- **`kokoro-js`** (npm) wraps **Kokoro-82M** running via `onnxruntime-web` (WebGPU with WASM
  fallback). It is purpose-built for browser TTS: `KokoroTTS.from_pretrained(...)` →
  `tts.generate(text, { voice, speed })` → a `RawAudio` you convert to a **WAV Blob**
  (`audio.toBlob()`), plus a `TextSplitterStream` for long input (R9). ~50 voices spanning
  American/British English (and more), which satisfies R7 directly.
- **Model weights** are fetched from a CDN (HuggingFace / jsDelivr) on first use and cached in the
  browser (Cache Storage / IndexedDB by onnxruntime). Quantized sizes ~**80MB (q8)** up to
  ~330MB (fp32). Pick a quantization that balances size vs quality (e.g. q8 on WASM, fp16/fp32 on
  WebGPU). See Open Q1 (external CDN fetch vs the app's otherwise-offline posture) and Open Q2 (quant).
- **Bundle impact**: `kokoro-js` + `onnxruntime-web` is multi-MB of JS. It MUST be **dynamically
  imported** only when the TTS modal first opens (`import('kokoro-js')`), so the initial app bundle
  and non-TTS users pay nothing. Vite handles the code-split automatically.
- Alternative considered: `@huggingface/transformers` (transformers.js v3) TTS pipeline
  (SpeechT5 / MMS-TTS / Kokoro). More general, more wiring, same runtime footprint. `kokoro-js` is
  the tighter fit for v1. Not chosen: cloud APIs (violate no-backend) and Web Speech (§1).

### §3 — New / changed types (`src/types.ts`)
```ts
// NEW — the parameters that generated a narration clip. Stored on AudioData so the clip is
// re-editable and the choice survives save/.gerty export.
export type TtsSource = {
  text: string     // the narration script (source of truth for re-generation)
  voice: string    // engine voice id, e.g. 'af_bella'
  speed: number    // 0.5–2, baked into synthesis
  // NOTE: no engine version pinned in v1; regenerating uses whatever model is current.
}

// CHANGED — one optional, additive field. Absent ⇒ an ordinary (imported) audio clip, exactly
// as today. Present ⇒ a TTS narration clip (enables the "Edit narration" affordance).
export type AudioData = {
  assetId: string
  volume: number
  muted?: boolean
  originalDuration: number
  waveform?: number[]
  sourceIn?: number
  sourceOut?: number
  sourceMin?: number
  sourceMax?: number
  tts?: TtsSource        // NEW
}
```
- No new `TimelineObjectType`. **A TTS clip is an `audio` object** - this is deliberate and matches
  the codebase's "everything is a flat TimelineObject; features are a layer, not a rewrite" ethos.
  Reusing `audio` inherits playback (`useAudioPlayback`), export mix (`ffmpegExport`), trim/split,
  waveform, timeline bar, and volume for **free**.
- No new reducer action needed: create → `ADD_ASSETS` + `ADD_OBJECTS` (via `addObjects`);
  regenerate → `ADD_ASSETS` + `UPDATE_OBJECT`. Both already exist.

### §4 — Confirmed: downstream pipeline needs no changes
From the audio-pipeline investigation:
- **Preview** (`useAudioPlayback.ts`): any audio object with a valid `assetId` gets an
  `<audio>` element via `getAssetUrl` and plays; nothing is source-specific.
- **Export** (`ffmpegExport.ts` `prerenderAudioMix`, lines ~150-203, duplicated at ~427-461 and
  ~705-739): the source filter is `type === 'audio' || 'video'` and `!hidden`, decoding each blob
  through `decodeAudioData`. A TTS audio clip is included automatically in all three export tiers.
- **Asset registration** (`assetStore.ts`): `storeAsset(File)` populates `blobCache` + IndexedDB
  synchronously and returns `AssetMeta`; `getAssetBlob`/`getAssetUrl` work immediately after.
  Must set `meta.duration` ourselves (storeAsset doesn't for audio) - we have it from the sample
  count. `generateWaveform(blob)` works on WAV.

### §5 — Threading & determinism
- Run inference in a Web Worker (R8). onnxruntime-web supports worker execution; `kokoro-js` can be
  driven from a worker. The worker posts progress (download %, chunk index) back to the modal.
- **Determinism is a non-issue for export**: synthesis happens once, at author time, and the result
  is a frozen asset blob. Export just reads that buffer - no per-frame regeneration, unlike the
  time-animated video effects.

### §6 — Orphaned assets on re-generate
- Re-generating leaves the previous WAV asset in IndexedDB unreferenced (the app has no asset GC
  today). Acceptable minor storage cost for v1; note in Implementation Notes. Optionally remove the
  old blob on regenerate if a safe `removeAsset` exists (verify no other object references it -
  a duplicated/split clip could).

## Related Systems and Tasks

- **Audio object model & pipeline**: `src/types.ts` (`AudioData`, `createTimelineObject`),
  `src/lib/assetStore.ts`, `src/hooks/useAudioPlayback.ts`, `src/lib/ffmpegExport.ts`.
- **Import flow (reference implementation)**: `src/components/ImportModal.tsx` (audio branch,
  ~325-351), `src/components/App.tsx` `addObjects` (~262-276) and `handleAddExistingAsset`
  (~281-307, the closest template - build one object from an existing asset id).
- **Creation rail**: `src/components/LeftRail.tsx` (`MediaSection` ~176-203, `SimpleSection`
  pattern ~229-250, `LeftRailProps` ~18-26).
- **Selected-object editor**: `src/components/PropertiesPanel.tsx` (add "Edit narration" for
  audio clips with `tts`).
- **Trim/split**: `src/lib/mediaTiming.ts` (a TTS clip trims/splits like any audio clip).
- Prior specs establishing the "additive optional field + reuse the audio object" pattern: spec 14
  (trim/split fields on AudioData), spec 28 (image import via `storeAsset`).

## Resolved Decisions

1. **External model download - ACCEPTED.** Kokoro weights (~80-330MB) are fetched from a CDN
   (HF/jsDelivr) on first use and cached by the browser. This one-time external fetch is acceptable
   despite the app's otherwise-offline posture. Gate it behind the first Generate click with clear
   download progress and a one-time notice that a voice model is being downloaded.
2. **Voice roster - CURATED to start.** Ship a curated English-accent subset (American/British, M/F)
   in v1, structured so the rest of the Kokoro roster is trivial to add later. Avoids an
   overwhelming picker.
3. **Preview reuses the synthesized blob - CONFIRMED (efficiency).** The flow is a **single**
   synthesis pass: pressing **Generate** synthesizes the WAV *once* and plays it in-modal for
   preview; **"Add to timeline"** then reuses that exact same blob to register the asset + build the
   object - it does **not** re-synthesize. The modal holds the last-generated `{ blob, duration,
   sampleRate, params }` in state; "Add to timeline" is disabled until a successful Generate, and
   editing the text/voice/speed after generating invalidates the held blob (requires a fresh
   Generate). Same reuse rule applies to Re-generate in edit mode.

## Open Questions

- **Quantization / device policy.** WebGPU fp16/fp32 (bigger, faster, better) vs WASM q8 (smallest,
  slowest). **Recommendation (proceeding with this unless told otherwise):** auto-detect WebGPU →
  higher precision; else WASM q8. No user toggle in v1.
- **Regenerate on a split clip.** If the user split a narration clip then edits one half's text,
  regeneration replaces that half with full-length new audio. **Recommendation (proceeding):**
  acceptable edge case - document it; optionally disable "Edit narration" on clips whose
  `sourceMin/Max` window has been narrowed by a split.

## Acceptance Criteria

1. A **"Text to speech"** button appears in the Media rail and opens the TTS modal.
2. Typing a script, choosing a voice + speed, and pressing Generate produces audible speech that can
   be previewed in the modal; first run shows model-download progress; the UI stays responsive.
3. "Add to timeline" places an `audio` clip at the playhead with a correct waveform and duration
   matching the spoken audio; it selects and shows in the properties panel.
4. Pressing play narrates in preview at the correct time; scrubbing/seeking works; trim and split
   behave like any audio clip.
5. Exporting an MP4 (WebCodecs path) includes the narration audio, correctly timed, with no code
   changes to the export mixer.
6. Selecting the clip shows **"Edit narration"**; editing the text and pressing Re-generate replaces
   the audio in place (new waveform/duration), preserves start time, and is a single undo entry.
7. Saving to `.gerty` and reopening preserves both the narration audio and the editable script/voice.
8. `npx tsc -b` is green; the initial (non-TTS) bundle does not include the TTS engine (verify the
   dynamic-import code-split).
9. Offline / model-fetch failure surfaces an error in the modal and creates no broken clip.

## Implementation Notes

- **New files**: `src/components/TtsModal.tsx` (author UI, mirrors `ImportModal.tsx`),
  `src/lib/tts.ts` (engine wrapper: lazy `import('kokoro-js')`, load model, `synthesize(text,
  voice, speed) → { blob: Blob, duration: number, sampleRate }`, voice roster + labels, progress
  callbacks), and `src/lib/tts.worker.ts` (Web Worker running the engine; `tts.ts` is the
  main-thread client that posts to it). Add `kokoro-js` to `dependencies`.
- **types.ts**: add `TtsSource`; add optional `tts?` to `AudioData`. No new object type, no new
  action.
- **Create flow** (App.tsx): a new `handleCreateTTS`/modal-confirm handler that: `synthesize(...)`
  → wrap WAV blob in a `File` → `storeAsset` → set `meta.duration` → `generateWaveform` →
  `dispatch(ADD_ASSETS,[meta])` → `createTimelineObject('audio', {...audioData, tts})` →
  `addObjects([obj])`. Model it on `handleAddExistingAsset` (App.tsx ~281-307). Do **not** route
  through `handleCreateObject` (its audio default is an empty `assetId`).
- **LeftRail.tsx**: add `onCreateTTS: () => void` to `LeftRailProps`, thread into `MediaSection`,
  render a button in the `section === 'media'` block (icon e.g. `IconMicrophone`). Wire in App's
  `<LeftRail>` to open the modal.
- **PropertiesPanel.tsx**: for a selected `audio` object where `data.tts` is set, render an
  "Edit narration" button that opens `TtsModal` in edit mode; on confirm, run the regenerate flow
  (store new asset → `UPDATE_OBJECT` with new assetId/duration/waveform/reset trim/updated `tts`).
- **Bundle discipline**: keep all `kokoro-js`/`onnxruntime-web` imports behind the dynamic
  `import()` inside `tts.ts`/the worker so Vite splits them out (AC8).
- **WAV encoding**: prefer the engine's built-in `toBlob()`/`toWav()`; only hand-roll a PCM→WAV
  encoder if needed. Compute `duration = samples / sampleRate` and set `meta.duration` from it
  (avoids the WebM `Infinity` duration issue entirely).
- **Verify**: `npx tsc -b`, then hand the user a browser checklist (open modal → generate → hear it
  → add → play → export → edit narration → reopen) per `.claude/skills/verify`.

## Rough edges / watch-list

- First-run model download is large and CDN-dependent (Open Q1); make the progress + one-time
  nature obvious.
- Main-thread inference would freeze the UI - keep it in the worker (R8).
- Re-generate orphans the prior WAV asset in IndexedDB (no GC today) - acceptable, noted (§6).
- A TTS clip is a plain `audio` object: duplicate/split deep-clone `data` including `tts`, so both
  copies claim the same script - fine, but "Edit narration" on a split half regenerates full-length
  audio (see Open Questions).

---
*This specification is ready for implementation. Use `/task 32-text-to-speech` to begin development.*

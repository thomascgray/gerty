# 34 — Straight audio (record from microphone)

## Overview

Let the user create an `audio` clip by **recording their own microphone**, in-app, without leaving the
project or round-tripping through a file. Press a button, grant mic access, talk, stop, preview, and
drop the result onto the timeline at the playhead - a voiceover / narration recorded live.

The clip it produces is an **ordinary `audio` `TimelineObject`** (exactly like an imported MP3 or a
TTS clip), so preview, export, trim, split, waveform, volume, mute, duplicate, download, and `.gerty`
round-trip all keep working with **zero downstream changes**. This is a **new capture front-end on
the existing audio-asset path**, not new plumbing - and it is architecturally the same move spec 32
(TTS) already made: *generate an audio blob at runtime → `storeAsset` → `generateWaveform` →
`createTimelineObject('audio', …)`*. We are swapping the pocket-tts synth for `MediaRecorder`.

## The load-bearing insight: this is the TTS commit path with a different blob source

Spec 32 proved the whole "runtime-generated audio blob becomes a first-class clip" path end to end:
[handleTTSConfirm](../src/components/App.tsx#L336) does `storeAsset(new File([blob], …))` →
`meta.duration = …` → `generateWaveform(blob)` → `dispatch ADD_ASSETS` →
`createTimelineObject('audio', {assetId, volume, originalDuration, waveform, sourceIn:0, sourceOut:dur})`
→ `addObjects`. A recorded clip commits through the **identical** shape. The only real work is the
**capture UI + getting a decodable blob with a known duration**. Everything after the blob exists is
already built and battle-tested.

## Requirements

### R1 — A "Record" entry point in the Media rail
- The **Media** section of `LeftRail.tsx` (`MediaSection`) gains a **"Record voiceover"** button
  (mic icon, e.g. `IconMicrophone`), sitting alongside **Add media** and **Text to speech** - the
  same visual treatment as the TTS button (`bg-surface-muted` secondary style). Clicking it opens the
  recording modal. No new rail section; this is purely additive to the existing Media pane.

### R2 — A recording modal with an explicit, legible state machine
- A new `RecordModal.tsx` (mirroring `TtsModal.tsx`'s structure and styling) walks the user through:
  **idle → (permission prompt) → recording → recorded/preview**, with **Cancel** always available and
  **Re-record** from the recorded state. Concretely:
  - **Idle:** a big **Record** button + a one-line privacy/permission note ("Recording happens in your
    browser and never leaves this device", matching the TTS on-device notice tone).
  - **Recording:** a live **elapsed timer** (`M:SS`), a **Stop** button, and (nice-to-have, R7) a
    live **input-level meter** so the user can see the mic is actually picking them up.
  - **Recorded:** an inline **audio preview** (play/pause, showing duration - reuse the TtsModal
    hidden `<audio>` + play/pause pattern), **Re-record**, and the primary **Add to timeline** button.
- Escape / backdrop click closes the modal, but **not while actively recording** (mirror the TtsModal
  `generating` guard) - a stray Escape mid-take shouldn't silently discard the recording; require an
  explicit Stop first. On close from any state, **stop the mic and release the `MediaStream` tracks**.

### R3 — Capture produces a decodable blob with a reliable duration
- Capture uses `navigator.mediaDevices.getUserMedia({ audio: true })` → `MediaRecorder`, collecting
  `dataavailable` chunks into a `Blob` on `stop`.
- **MIME selection mirrors the export fallback's `getSupportedMimeType` pattern**
  ([ffmpegExport.ts:832](../src/lib/ffmpegExport.ts#L832)): probe `MediaRecorder.isTypeSupported` over
  a small preference list (`audio/webm;codecs=opus` → `audio/webm` → `audio/mp4` for Safari) and use
  the first supported one; the stored asset's `mimeType`/extension follow `recorder.mimeType`.
- **Duration must NOT be read from an `<audio>` element on the raw MediaRecorder blob.** MediaRecorder
  WebM blobs are written without a container duration in the header, so `HTMLMediaElement.duration`
  reports **`Infinity`** until a forced seek-to-end - a well-known trap that would poison
  `originalDuration`, the timeline bar length, and trim math. Instead derive duration from **one of**:
  1. the **elapsed record time** (wall-clock between start and stop - also what drives the live timer), or
  2. the **decoded `AudioBuffer.duration`** from the same `decodeAudioData` pass that builds the waveform.
  Recommendation: use the decoded `AudioBuffer.duration` as the authoritative value (exact, and we're
  already decoding for the waveform), with the elapsed timer as the live display + a fallback. See §2.

### R4 — Commit lands a normal audio clip at the playhead
- **Add to timeline** runs a `handleRecordConfirm` in `App.tsx` that is `handleTTSConfirm` minus the
  TTS metadata: `storeAsset(new File([blob], 'Recording.<ext>', {type: recorder.mimeType}))` →
  `meta.duration = dur` → `generateWaveform(blob)` → `dispatch ADD_ASSETS` →
  `createTimelineObject('audio', {assetId, volume:1, originalDuration:dur, waveform, sourceIn:0,
  sourceOut:dur}, {startTime: playback.globalTime, duration:dur, name})` → `addObjects([obj])`.
- The clip is named something friendly and unique-ish, e.g. **"Recording 1"** / **"Recording"** (see
  Open Q4). It appears in the asset grid (reusable like any asset) and on the timeline immediately.

### R5 — No new type, no downstream changes, full round-trip
- A recorded clip is a **plain `audio` object** - **no new `TimelineObject` type, no new `data`
  variant, no `types.ts` change required for v1** (contrast with TTS, which added `TtsSource` *because*
  it needed re-generation; a recording is not re-generatable, so it carries no extra metadata). See
  Open Q3 for the optional "mark it as a recording" nicety.
- Preview (`useAudioPlayback`), export (`ffmpegExport` `prerenderAudioMix` via `OfflineAudioContext`),
  trim/split (`mediaTiming`), volume/mute, duplicate, per-object download, and `.gerty` save/reopen
  all work **unchanged** - the recorded blob is just another audio asset in IndexedDB.

### R6 — Graceful permission / device / capability failure
- Handle, with readable in-modal messages (no thrown console errors, no broken clip), at minimum:
  - **Permission denied** (`NotAllowedError` / `SecurityError`): "Microphone access was blocked. Allow
    it in your browser's site settings and try again."
  - **No mic present** (`NotFoundError` / `DevicesNotFoundError`): "No microphone was found."
  - **Insecure context / unsupported:** `navigator.mediaDevices`/`MediaRecorder` absent (non-HTTPS
    non-localhost, or an old browser) - show a clear "recording isn't available here" message and
    ideally hide/disable the entry point up front. (Dev is `localhost` = secure; production must be
    HTTPS - see §4.)
  - **Empty/zero-length recording** (stop before any audio, or a decode failure): don't create a clip;
    surface a gentle "That recording was empty - try again."

### R7 — Live level feedback (IN v1)
- While recording, show a simple **input-level meter** driven by a WebAudio `AnalyserNode` tapped off
  the capture stream (RMS/peak → a bar), so a dead/muted mic is obvious *before* the user records a
  silent 30 seconds. Must be torn down (disconnect nodes, `close()` the context) when recording stops
  or the modal closes. **Confirmed in scope for v1** (Open Q2 resolved: yes).

## Technical Considerations

### §1 — The existing pipeline this rides on (confirmed present, no changes needed)
- **Asset store:** [storeAsset](../src/lib/assetStore.ts#L67) takes a `File`, writes it to IndexedDB +
  the in-memory cache, and returns `{meta, blob}`. `detectAssetType` maps `audio/*` → `'audio'`, so a
  `audio/webm` blob classifies correctly with no change. `generateWaveform`
  ([assetStore.ts:197](../src/lib/assetStore.ts#L197)) decodes via `AudioContext.decodeAudioData` and
  returns ~200 peaks - **this same decode yields `audioBuffer.duration`** (see §2).
- **Commit template:** [handleTTSConfirm](../src/components/App.tsx#L336) - copy its structure.
- **Commit factory:** `createTimelineObject('audio', AudioData, options)` ([types.ts](../src/types.ts)).
- **MIME probing:** `getSupportedMimeType` ([ffmpegExport.ts:824-834](../src/lib/ffmpegExport.ts#L824)) -
  the exact pattern to copy for audio, using `MediaRecorder.isTypeSupported`.
- **Modal scaffold + preview UX:** [TtsModal.tsx](../src/components/TtsModal.tsx) - z-index, header,
  footer, hidden `<audio>` element preview, Escape-guard, object-URL revoke discipline.

### §2 — Duration + waveform from ONE decode (the correct, trap-free path)
`generateWaveform` currently decodes the blob and returns only peaks. The MediaRecorder-WebM
`duration === Infinity` trap (R3) means we should **not** call `getMediaDuration` (which uses an
`<audio>` element) on a recorded blob. Two clean options:
- **(a) Add a sibling helper** `decodeAudio(blob): Promise<{ duration: number; peaks: number[] }>` (or
  extend `generateWaveform` to also return duration) so a single `decodeAudioData` yields both. Cleanest;
  avoids a second decode. Recommended.
- **(b)** Keep `generateWaveform` as-is and take duration from the **elapsed record timer**
  (`performance.now()` delta between `start()` and `stop()`). Simpler, no shared-helper change, and the
  timer already exists for the UI - but a hair less exact than the decoded buffer (codec priming /
  trailing silence can differ by a few ms). Acceptable, since trim defaults (`sourceOut = dur`) are
  forgiving.

Recommendation: **(a)** for exactness and to kill the Infinity trap outright; fall back to the timer
value if `decodeAudioData` throws.

> Note: scripts/workers can't use `Math.random()`/`Date.now()` in *workflow* contexts, but this is
> ordinary app code - `performance.now()`/`Date.now()` for the elapsed timer are fine here.

### §3 — Types
- **v1 needs no `types.ts` change.** A recorded clip is a bare `AudioData`
  (`{assetId, volume, originalDuration, waveform?, sourceIn, sourceOut}`), identical to an imported
  audio clip. `AudioData` already defined at [types.ts:186](../src/types.ts#L186).
- **No marker in v1 (Open Q3 resolved):** recordings stay indistinguishable from imported audio - no
  field added. If a future UI needs to branch (a "Recording" badge, a re-record affordance), an
  optional additive `source?: 'import'|'tts'|'recording'` on `AudioData` is a trivial later change that
  persists in project JSON/`.gerty` for free and is back-compat with every existing clip.

### §4 — Secure context / deployment
- `getUserMedia` requires a **secure context**: HTTPS **or** `localhost`/`127.0.0.1`. The user's
  `npm run dev` on localhost is secure, so this works in dev. **Production hosting must be HTTPS** or
  the button will always fail - worth a one-line note in the modal's unsupported branch and in the
  eventual TASK log. Detect via `window.isSecureContext` / presence of `navigator.mediaDevices` to
  disable the entry point cleanly rather than failing on click.

### §5 — Export compatibility of the recorded codec
- Export pre-mixes **all** audio through `OfflineAudioContext.decodeAudioData` from the stored blob
  (`prerenderAudioMix`). Chrome decodes WebM/Opus fine; this is the same path imported `.webm`/`.ogg`
  audio already takes, so a recorded WebM is not a new case. (If we ever record `audio/mp4` on Safari,
  Safari's decodeAudioData handles AAC/mp4 - same story.) No export changes.

### §6 — Resource lifecycle (the easy-to-leak bits)
- **Always** stop every `MediaStreamTrack` (`stream.getTracks().forEach(t => t.stop())`) on stop AND on
  modal close/unmount - otherwise the browser's mic-in-use indicator stays on. Revoke preview object
  URLs (copy TtsModal's `urlRef` discipline). Close any `AudioContext` opened for the level meter.
- Guard against double-commit / commit-while-recording (disable the primary button unless a finished
  blob exists), mirroring TtsModal's `canCommit`.

## Related Systems and Tasks

- **Spec 32 (the pipeline this clones):** [SPECS/32-text-to-speech.md](32-text-to-speech.md),
  [TASKS/32-text-to-speech.md](../TASKS/32-text-to-speech.md) - the runtime-blob→audio-clip path, modal
  UX, and commit handler are the direct template.
- **Commit template:** [App.tsx handleTTSConfirm](../src/components/App.tsx#L336) (~336-371).
- **Entry point host:** [LeftRail.tsx MediaSection](../src/components/LeftRail.tsx#L177) (~177-213).
- **Asset + waveform:** [assetStore.ts](../src/lib/assetStore.ts) (`storeAsset`, `generateWaveform`,
  `detectAssetType`).
- **MIME-probe pattern:** [ffmpegExport.ts getSupportedMimeType](../src/lib/ffmpegExport.ts#L824).
- **Modal scaffold:** [TtsModal.tsx](../src/components/TtsModal.tsx).
- **Types:** [types.ts AudioData](../src/types.ts#L186).
- **Downstream (unchanged):** `useAudioPlayback.ts`, `ffmpegExport.ts` (`prerenderAudioMix`),
  `mediaTiming.ts`, `.gerty` in `projectStorage.ts`.

## Open Questions

**Resolved (2026-08-03):**
- **Open Q1 — Modal capture, or record-against-the-playing-timeline?** → **(A) Simple modal record for
  v1.** Record in isolation, drop the take at the playhead (`globalTime`). Live-voiceover-to-picture
  (B) - start playback and recording together so the user narrates over the running video - is a
  documented **fast-follow**, additive on the same code path (couples capture to `usePlayback`; solve
  latency/monitoring then).
- **Open Q2 — Level meter in v1?** → **Yes** (R7 is in scope). `AnalyserNode`-driven bar, torn down on
  stop/close.
- **Open Q3 — Mark recorded clips in the type?** → **No marker.** A recording is indistinguishable from
  an imported audio clip; **no `types.ts` change**. Add an optional `source?`/`recorded?` field later
  only if a concrete UI needs to branch on it (trivial additive change).

**Still open (safe defaults, not blocking):**
- **Open Q4 — Naming.** "Recording", "Recording 1/2/3…", or a timestamp? *Recommendation: "Recording"
  (or an incrementing "Recording N" if a cheap counter is handy) - matches the friendly-name spirit of
  `ttsClipName`.*
- **Open Q5 — Mic device picker / input selection?** Multiple mics → let the user pick, or just use the
  default device? *Recommendation: default device for v1; a device dropdown (via
  `enumerateDevices`) is a later nicety.*
- **Open Q6 — Max length / size guard?** Long recordings grow the asset store. Reuse the existing
  `SIZE_WARN_*` guards on commit, or add a soft time cap? *Recommendation: rely on existing size
  warnings; no hard cap in v1.*

## Acceptance Criteria

1. The Media rail shows a **Record voiceover** button; clicking it opens the recording modal.
2. Pressing **Record** prompts for mic permission (first time), then shows a running timer while
   capturing; **Stop** ends capture and reveals an in-modal preview that plays back the take.
3. **Add to timeline** places a normal `audio` clip **at the playhead** with a correct waveform and a
   **finite, correct duration** (never `Infinity`); it plays at the right time, scrubs, trims, splits,
   and honours volume/mute like any audio clip.
4. **Exporting** an MP4 includes the recorded audio, correctly timed, **with no changes to the export
   mixer**.
5. Denying permission, having no mic, or an insecure/unsupported context each shows a **readable
   in-modal message** and creates **no broken clip**; a zero-length take is rejected gracefully.
6. Closing the modal (or stopping) **releases the microphone** (the browser's mic-in-use indicator
   turns off) and revokes preview URLs - no lingering streams or leaked object URLs.
7. `.gerty` save/reopen preserves the recorded clip and its audio; a project made before this spec
   opens with no migration.
8. `npx tsc -b` is green.

## Implementation Notes

- **`src/components/RecordModal.tsx` (new):** model it on `TtsModal.tsx`. Local state machine
  (`'idle'|'recording'|'recorded'|'error'`), a `MediaRecorder` + `MediaStream` in refs, a chunks array,
  an elapsed-time state for the timer, `result` blob + `previewUrl` (with the `urlRef` revoke pattern).
  `onConfirm(blob, durationHint)` hands the finished take up to `App`. Pick the MIME via a local
  `getSupportedAudioMimeType()` (copy of the export helper, audio list). Tear down stream/tracks/
  context on stop and on unmount.
- **`App.tsx`:** add `recordModalOpen` state + `handleOpenRecord`/`handleRecordConfirm`. Make
  `handleRecordConfirm` a near-copy of `handleTTSConfirm` (drop the `tts`/edit branches): store asset,
  set `meta.duration`, generate waveform, `ADD_ASSETS`, `createTimelineObject('audio', …, {startTime:
  playback.globalTime, duration, name})`, `addObjects`. Render `{recordModalOpen && <RecordModal … />}`
  next to the TTS modal.
- **`LeftRail.tsx`:** add an `onRecord` prop threaded from `App`, and a **Record voiceover** button in
  `MediaSection` beneath **Text to speech** (mic icon from `@tabler/icons-react`, e.g.
  `IconMicrophone`). Consider disabling it when `!navigator.mediaDevices || !window.isSecureContext`.
- **`assetStore.ts` (optional, §2a):** add `decodeAudio(blob) → {duration, peaks}` (or have
  `generateWaveform` also return duration) so one decode gives both; use `audioBuffer.duration` as the
  authoritative clip duration to sidestep the WebM-`Infinity` trap.
- **Verify:** `npx tsc -b`, then a browser checklist: open modal → Record → allow mic → see timer →
  Stop → preview plays → Add → clip appears at playhead with a waveform and correct length → play the
  timeline (hear it) → export MP4 (hear it, correctly timed) → trim/split it → save `.gerty` + reopen →
  deny-permission path shows a friendly message → closing the modal turns the mic indicator off.

## Rough edges / watch-list
- **The `duration === Infinity` MediaRecorder-WebM trap** is the single most likely bug - do not read
  duration from an `<audio>` element on the raw blob (§2/R3).
- **Mic never released:** forgetting `track.stop()` on close leaves the browser recording indicator on.
- **Secure context:** works on `localhost` in dev; **production must be HTTPS** or the feature is dead
  on arrival (§4).
- **Codec portability:** Safari records `audio/mp4` (AAC), Chrome/Firefox `audio/webm` (Opus) - probe
  with `isTypeSupported`; both decode in their own browser's export mixer.
- **Commit guards:** don't allow commit while still recording or with an empty blob; don't double-add.

## Open decisions summary
The three shaping decisions are settled: **modal record (v1)**, **level meter in**, **no type marker**.
Remaining Q4/Q5/Q6 are cosmetic/scope defaults (default naming "Recording N", default mic device,
existing size warnings) and don't block implementation.

---
*This specification is ready for implementation. Use `/task 34-straight-audio` to begin development.*

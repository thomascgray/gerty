# 34 — Straight audio (record from microphone)

**Status**: In Progress

## Overview

Let the user create an `audio` clip by recording their microphone in-app, at the playhead, without
leaving the project. Press Record → grant mic access → talk → Stop → preview → Add to timeline. The
result is an ordinary `audio` `TimelineObject`, so preview/export/trim/split/waveform/volume/`.gerty`
all work unchanged. This is the spec 32 (TTS) commit path with `MediaRecorder` swapped for the synth.

Spec: [SPECS/34-straight-audio.md](../SPECS/34-straight-audio.md).

## Task Context

- **Design decisions (locked):** modal record for v1 (drop take at playhead, NOT record-to-picture);
  live input-level meter IS in scope; NO `types.ts` change (a recording is indistinguishable from an
  imported audio clip).
- **The template:** `handleTTSConfirm` ([App.tsx:336](../src/components/App.tsx#L336)) — copy its
  shape minus the tts/edit branches. `TtsModal.tsx` — copy the modal scaffold (header/footer, hidden
  `<audio>` preview, Escape-guard, object-URL revoke via `urlRef`).
- **Entry point host:** `MediaSection` in [LeftRail.tsx:177](../src/components/LeftRail.tsx#L177) —
  add a "Record voiceover" button under "Text to speech". Thread an `onRecord` prop (mirror
  `onCreateTTS`). Disable when `!navigator.mediaDevices || !window.isSecureContext`.
- **Asset path:** `storeAsset` → `generateWaveform` → `ADD_ASSETS` → `createTimelineObject('audio',…)`
  → `addObjects`. `detectAssetType` maps `audio/*` → `'audio'` already.
- **MIME probe:** copy `getSupportedMimeType` pattern from
  [ffmpegExport.ts:824](../src/lib/ffmpegExport.ts#L824), audio list
  (`audio/webm;codecs=opus` → `audio/webm` → `audio/mp4`), via `MediaRecorder.isTypeSupported`.
- **THE trap:** MediaRecorder WebM reports `duration === Infinity` from an `<audio>` element. Take
  duration from the decoded `AudioBuffer` (same pass as the waveform) or the record timer — never
  `getMediaDuration`. Plan: add `decodeAudio(blob) → {duration, peaks}` to assetStore (one decode for
  both), fall back to the elapsed timer if decode throws.
- **Lifecycle:** stop every `MediaStreamTrack` on Stop AND on modal close/unmount (mic indicator);
  revoke preview URLs; close the AnalyserNode's AudioContext.
- **Secure context:** works on localhost dev; production must be HTTPS.

## Blockers/Issues

None currently.

## TODO

[X] Add `decodeAudio(blob) → {duration, peaks}` helper to `assetStore.ts` (single decode → duration + waveform)
[X] New `RecordModal.tsx`: state machine (idle/recording/recorded/error), getUserMedia + MediaRecorder, MIME probe, elapsed timer, level meter (AnalyserNode), in-modal preview, teardown on stop/close
[X] Graceful failures: permission denied / no mic / insecure-or-unsupported / empty take
[X] `App.tsx`: `showRecord` state + `handleRecordConfirm` (TTS-confirm minus tts/edit); render `<RecordModal>`
[X] `LeftRail.tsx`: `onRecord` prop + "Record voiceover" button in MediaSection (disabled when unsupported)
[X] Verify `npx tsc -b` green
[ ] User browser-tests the full flow (checklist below)

## Work Log

[2026-08-03] Implemented microphone recording end to end (spec 34, v1).

- `src/lib/assetStore.ts`: extracted `peaksFromChannel`; added `decodeAudio(blob) → {duration, peaks}`
  (one `decodeAudioData` pass giving exact `AudioBuffer.duration` + waveform, sidestepping the
  MediaRecorder-WebM `duration === Infinity` trap). `generateWaveform` refactored onto the shared helper.
- `src/components/RecordModal.tsx` (new): idle→recording→recorded/error state machine over
  getUserMedia + MediaRecorder; MIME probe (`getSupportedMimeType`-style, audio list); live M:SS timer
  + AnalyserNode RMS input-level meter; in-modal `<audio>` preview; Escape/backdrop close guarded while
  recording; full teardown (stop tracks, close AudioContext, revoke URL) on stop/close/unmount;
  readable errors for permission-denied / no-mic / in-use / unsupported / empty take.
- `src/components/App.tsx`: `showRecord` state, `handleRecordConfirm` (store asset → `decodeAudio` for
  duration+waveform, elapsed-time fallback → `ADD_ASSETS` → `createTimelineObject('audio', …)` at the
  playhead), wired `onRecord` into `LeftRail`, rendered `<RecordModal>`.
- `src/components/LeftRail.tsx`: `onRecord` prop; "Record voiceover" button in `MediaSection`, disabled
  (with explanatory title) when `!isSecureContext`/no getUserMedia/no MediaRecorder.
- `npx tsc -b` green. No `types.ts` change (a recording is a plain `audio` clip, per spec decision).

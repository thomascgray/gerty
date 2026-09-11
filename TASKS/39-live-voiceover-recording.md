# 39-live-voiceover-recording

**Status**: In Progress
**Spec**: ./SPECS/39-live-voiceover-recording.md

## Overview
Record a voiceover while the timeline plays. Arm-mode + Space: R/Record button arms (pauses, anchors
at playhead, grabs mic); Space starts capture+playback; Space stops and auto-drops a "Voiceover N"
audio clip at the anchor; Escape cancels. Reuses spec 34's capture+commit pipeline.

## Repos
- `.` (C:/Programming/videoeditor) - the whole feature.

## Context
- Commit template: `App.tsx:394` handleRecordConfirm (decodeAudio → storeAsset → ADD_ASSETS →
  createTimelineObject('audio') → addObjects).
- Capture plumbing lives in `RecordModal.tsx` (recordingSupported, pickAudioMimeType, describeMicError,
  AnalyserNode level meter, teardown). Extract to `src/hooks/useMicRecorder.ts`.
- `decodeAudio` at assetStore.ts:233 → {duration, peaks}; avoids WebM Infinity trap.
- Playback: usePlayback.ts; auto-pause-at-end at usePlayback.ts:54-59 (needs holdPastEnd).
- canRecord gate: LeftRail.tsx:168.
- Keydown map: App.tsx:615-702; Space at :619; R unbound.
- Toasts: useToasts.ts / Toasts.tsx.
- TransportBar.tsx is the transport pill (play/pause, clock, speed, markers, volume).
- Verify: `npx tsc -b`. Do NOT run dev server (verify skill).

## Decisions
- 2026-09-11: Gesture = arm-mode + Space; auto-commit on stop + toast/undo; return to anchor after
  stop; keep other tracks playing (headphones); no countdown / no latency comp in v1. (User-confirmed
  spec Open Qs 1/2/3/5; 4/6 deferred.)
- 2026-09-11: Extracted capture into `src/hooks/useMicRecorder.ts` (arm/start/stop/cancel/dispose +
  level/elapsed/phase/error) and refactored RecordModal (spec 34) onto it. One implementation, no
  duplication. Modal keeps its own recorded/preview UI.
- 2026-09-11: arm()/start() return the error message (string|null) instead of a boolean, so callers
  toast the specific failure without hitting the stale `mic.error` closure value.
- 2026-09-11: usePlayback gained `holdPastEnd` (recMode==='recording') so the playhead keeps advancing
  past totalDuration while recording (R13), and `resume()` (setIsPlaying(true) with no rewind / no
  empty-timeline guard) so recording starts at the playhead and works even on an empty project.
- 2026-09-11: Commit reuses the shared `addRecordedClip(rec, startTime, name)`. ADD_ASSETS + ADD_OBJECTS
  are two undo entries (same as the existing TTS/import path), so the first Ctrl+Z removes the clip and
  the reusable asset stays in the rail — consistent with every other add. R9 met by that first undo.
- 2026-09-11: `R` shortcut is suppressed while any modal is open (incl. the spec-34 record modal) so we
  never open two mic captures at once.

## Blockers
None

## TODO
- [x] R1 Record control in TransportBar next to Play/Pause; click toggles record-armed mode
- [x] R2 hotkey R toggles record-armed mode
- [x] R3 entering armed pauses playback, anchors at playhead, acquires mic up front
- [x] R4 armed state visually unmistakable (red), distinct from recording state
- [x] R5 armed+idle Space/button starts session (playback from anchor + recorder start together)
- [x] R6 recording Space/Stop stops + finalizes
- [x] R7 Space normal play/pause unchanged when record mode off; preventDefault stays
- [x] R8 Escape while recording cancels (discard, release mic, return to anchor); Escape while armed exits mode
- [x] R9 auto-commit take as plain audio clip at anchor via existing commit path, one undo entry
- [x] R10 toast on commit + return to armed at anchor for one-key re-take
- [x] R11 clips named "Voiceover N" incrementing
- [x] R12 zero-length/empty take makes no clip + gentle message
- [x] R13 during live recording playback does NOT auto-pause at totalDuration (playhead keeps advancing)
- [x] R14 mic acquired on arm; released on stop/cancel/exit/unmount; indicator off when idle+off
- [x] R15 clip startTime = playhead at capture start; residual = mic latency; draggable; no auto comp
- [x] R16 live elapsed timer + input-level meter + recording indicator near transport
- [x] R17 existing timeline audio keeps playing during recording; headphones hint shown
- [x] R18 Record control disabled when unsupported (canRecord); R no-op then
- [x] R19 permission/no-mic/insecure failures show readable message (toast); no broken clip
- [x] R20 plain audio object; no types.ts change; preview/export/trim/split/volume/mute/gerty unchanged

## Work log
- 2026-09-11: Spec written (39). Task started.
- 2026-09-11: Added `useMicRecorder` hook; refactored `RecordModal` onto it. `usePlayback` gained
  `holdPastEnd` + `resume`. App: recMode state, anchor, arm/start/stop/cancel handlers, shared
  `addRecordedClip`, Space/R/Escape routing (+ modal guard). `TransportBar` record cluster (arm/start/
  stop, timer, level meter, exit/cancel, headphones hint). `HotkeysModal` documents R + Space.
  `npx tsc -b` green; eslint clean on changed files (one pre-existing App.tsx:254 error untouched).

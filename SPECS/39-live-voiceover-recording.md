# 39: Live voiceover recording (record against the playing timeline)

**Source**: none (verbal request). Fast-follow explicitly scoped by spec 34 Open Q1.

> Note on the ID: this was requested as `23-audio-record-live`, but `23` is already
> `23-more-effects.md`. Filed as `39` (next free number). Rename if you'd rather.

## What and why

Let the user record a voiceover **while the video plays**. They park the playhead, hit a key,
watch the timeline run, narrate over it, and hit the key again to stop. The take lands as a normal
`audio` clip **anchored where recording started**, so it lines up with the picture with no manual
placement. The goal is speed and flow: press-record, talk, press-stop, done, repeat, without opening
a modal or dragging a clip into position each time.

This is the live-to-picture case spec 34 deferred (its Open Q1 (B): "start playback and recording
together so the user narrates over the running video"). It reuses spec 34's whole capture-and-commit
pipeline (`getUserMedia` → `MediaRecorder` → `decodeAudio` → `storeAsset` → `createTimelineObject`).
The only new parts are: coupling capture to `usePlayback`, a spacebar-driven start/stop, and an
in-transport recording UI. No new `TimelineObject` type, no export changes.

## Requirements from the source

none (verbal). The relevant prior decision, copied from `SPECS/34-straight-audio.md` Open Q1:

> **Open Q1 — Modal capture, or record-against-the-playing-timeline?** → (A) Simple modal record for
> v1. [...] Live-voiceover-to-picture (B) - start playback and recording together so the user narrates
> over the running video - is a documented fast-follow, additive on the same code path (couples
> capture to `usePlayback`; solve latency/monitoring then).

## Requirements

### Entry and mode
- **R1** A **Record** control lives in the transport pill (`TransportBar.tsx`), next to Play/Pause.
  Clicking it enters **record-armed mode**; clicking it again (or Escape while armed-but-not-recording)
  exits back to normal.
- **R2** A hotkey **`R`** toggles record-armed mode (`R` is currently unbound; see App keydown map).
- **R3** Entering record-armed mode **pauses playback** if it is playing and arms at the **current
  playhead** (the anchor). It also **acquires the microphone stream up front** (see R14) so the
  start gesture has near-zero latency.
- **R4** The control and transport show an unmistakable armed state (red accent) distinct from both
  normal and actively-recording states. See the state machine in Technical notes.

### Spacebar start/stop (the core gesture)
- **R5** While **armed and idle**, pressing **Space** (or clicking the transport Record/Stop button)
  **starts a recording session**: playback begins from the anchor and `MediaRecorder` begins capturing,
  as close to simultaneously as possible (see R15 for the sync strategy).
- **R6** While **recording**, pressing **Space** (or the Stop button) **stops** the session: playback
  pauses and the take is finalized.
- **R7** Space's normal play/pause behavior is **unchanged whenever record mode is off**. The
  start/stop meaning applies only inside record-armed mode. `e.preventDefault()` on Space stays.
- **R8** **Escape while recording cancels**: discard the take, create no clip, release the mic, and
  return the playhead to the anchor. Escape while armed-but-not-recording exits record mode.

### The take becomes a clip
- **R9** On stop, the take is **auto-committed** as a plain `audio` `TimelineObject` at
  `startTime = anchor`, through the **existing commit path** (`decodeAudio` for exact duration +
  waveform → `storeAsset` → `ADD_ASSETS` → `createTimelineObject('audio', …)` → `addObjects`). No
  modal, no preview-then-add step. The commit is **one undo entry** (Ctrl+Z removes the clip).
- **R10** After commit, a **toast** confirms it ("Voiceover added — Ctrl+Z to undo" or similar), and
  the app returns to **record-armed mode at the anchor** so the user can immediately re-take with one
  Space press. (Exiting record mode is explicit: Record button or Escape.)
- **R11** Clips are named **"Voiceover N"** (incrementing), matching the friendly-name spirit of
  `ttsClipName` / spec 34's "Recording N".
- **R12** A zero-length / empty take (stopped instantly, or a decode-less silent blob) creates **no
  clip** and shows a gentle message, same guard as spec 34 R6.

### Recording-while-playing behavior
- **R13** While a live recording is active, playback **does not auto-pause when it reaches
  `totalDuration`**. The playhead keeps advancing past the old end so the user can narrate a tail over
  the last frame; the resulting clip extends the timeline. (`usePlayback` currently sets
  `isPlaying=false` at `totalDuration`; this must be suppressed during a live recording.)
- **R14** The mic stream is acquired on **arm** (R3), not on start, so the start gesture is instant.
  The stream is released on: stop, cancel, exiting record mode, and unmount. The browser mic-in-use
  indicator must turn off whenever no session is active and the mode is exited.
- **R15** **Sync/anchor:** the clip's `startTime` is the playhead position at the instant capture
  begins. Because the stream is pre-acquired (R14), `recorder.start()` + `playback.play()` fire
  together and the residual offset is only the mic's own input latency (tens of ms), accepted for v1.
  The committed clip is a normal draggable timeline bar, so the user can nudge it to fine-tune sync.
  (No automatic latency compensation in v1.)

### Feedback
- **R16** While recording, show a live **elapsed timer** and a **live input-level meter** (reuse spec
  34's `AnalyserNode` RMS tap), plus a clear "recording" indicator, all within/near the transport.
  A dead or muted mic must be visible before the user records a silent minute.
- **R17** Monitoring: existing timeline audio (music, prior voiceovers) **keeps playing** during a live
  recording so the user can narrate in time with it. Headphones are assumed to avoid the mic capturing
  speaker output; a one-line hint states this. (See Open Q5 — no forced mute of other tracks in v1.)

### Capability / failure
- **R18** The Record control is **disabled** (with an explanatory title) when recording is unavailable:
  no secure context, no `getUserMedia`, or no `MediaRecorder` — the exact `canRecord` check already in
  `LeftRail.tsx:168`. `R` is a no-op in that case.
- **R19** Permission-denied / no-mic / mic-in-use / insecure-context failures show a **readable
  message** (toast) and create no broken clip, reusing spec 34's `describeMicError` strings.

### No downstream changes
- **R20** A live-recorded clip is a **plain `audio` object** — no new type, no `data` variant, no
  `types.ts` change. Preview, export, trim/split, volume/mute, duplicate, download, and `.gerty`
  round-trip all work unchanged (same guarantee as spec 34 R5).

## Out of scope

- Automatic latency compensation / calibration (v1 anchors at the playhead and relies on the clip
  being draggable). A fixed input-latency offset is a later nicety.
- Punch-in / overdub / loop recording, take management (comping multiple takes), and a takes lane.
- A pre-roll that rewinds and plays lead-in video before the anchor.
- Muting or ducking existing timeline audio during recording (Open Q5; headphones assumed for v1).
- Mic device picker (spec 34 Open Q5 still applies: default device).
- Live waveform drawn on the growing clip while recording (level meter only).
- Any change to the existing spec-34 **modal** recorder; it stays as the isolated-record entry point.

## Technical notes

**Repo:** single repo at `C:/Programming/videoeditor` (session starts in it; paths are repo-relative).
**Verify with `npx tsc -b`.** Do not run the dev server (see `.claude/skills/verify/SKILL.md`).

### Existing pieces this rides on (all present, confirmed)
- **Commit path** — `handleRecordConfirm` in `App.tsx:394` is the template: `decodeAudio(blob)` for
  exact duration + waveform, `storeAsset`, `ADD_ASSETS`, `createTimelineObject('audio', {assetId,
  volume:1, originalDuration, waveform, sourceIn:0, sourceOut:dur}, {startTime, duration, name})`,
  `addObjects`. Reuse it; only `startTime` (the anchor) and `name` ("Voiceover N") differ.
- **Capture plumbing** — `RecordModal.tsx` already contains everything: `recordingSupported()`,
  `pickAudioMimeType()`, `describeMicError()`, the `AnalyserNode` level meter, chunk assembly, and
  teardown discipline (`teardownCapture`). This should be **extracted into a shared hook**
  `src/hooks/useMicRecorder.ts` so both the modal and the live recorder use one implementation. The
  modal refactor is optional but recommended to avoid two copies of the capture logic.
- **decodeAudio** — `assetStore.ts:233` returns `{duration, peaks}` from one decode; sidesteps the
  MediaRecorder-WebM `duration === Infinity` trap (spec 34 R3/§2). Use it, fall back to elapsed time.
- **Playback** — `usePlayback.ts`: `play()`, `pause()`, `seek()`, `globalTime`, `isPlaying`,
  `totalDuration`. The auto-pause at `totalDuration` is at `usePlayback.ts:54-59`.
- **Capability gate** — `canRecord` in `LeftRail.tsx:168` (secure context + `getUserMedia` +
  `MediaRecorder`). Reuse the same predicate for the transport control.
- **Keydown map** — `App.tsx:615-702`. Space handling is at `:619`. `R`/`r` is unbound. The handler
  early-returns for `input`/`textarea` targets (`:617`).
- **Toasts** — `useToasts.ts` / `Toasts.tsx` for R10/R12/R19 messages.

### State machine (live recording)
```
idle ──(Record btn / R)──▶ armed ──(Space / Rec btn)──▶ recording ──(Space / Stop)──▶ commit ──▶ armed
  ▲                          │  ▲                            │
  └──(Record btn / Esc)──────┘  └────(Esc = cancel, discard)─┘
```
- `idle`: normal editor. Space = play/pause. Mic not held.
- `armed`: playback paused at the anchor; mic stream acquired (R14); transport red. Space = start.
- `recording`: playback running from the anchor, `MediaRecorder` capturing; timer + level meter live.
  Space/Stop = stop→commit; Esc = cancel→discard. Auto-pause-at-end suppressed (R13).
- `commit`: finalize blob → decode → store → add clip at anchor → toast → back to `armed`.

Suggested home for this state + the mic hook wiring: a `useLiveRecorder` hook (or state co-located in
`App.tsx` alongside `showRecord`), holding `mode: 'off'|'armed'|'recording'`, the anchor, and the
`useMicRecorder` instance. `App.tsx` already owns playback, the keydown map, and the commit handler,
so the coupling lives there naturally.

### Spacebar routing (R5–R7)
In `App.tsx` keydown, branch **before** the existing `if (e.key === ' ')`:
```
if (e.key === ' ') {
  e.preventDefault()
  if (liveRecMode === 'armed')      startLiveRecording()
  else if (liveRecMode === 'recording') stopLiveRecording()   // → commit
  else                               playback.togglePlayback()
}
```
Escape branch: if `liveRecMode === 'recording'` cancel; else if `'armed'` exit mode; else fall through
to the existing Escape handling. Keep the `input`/`textarea` early-return.

### Sync / anchor (R15)
Acquire the stream on arm. On start: read `playback.globalTime` as the anchor, then
`recorder.start()` and `playback.play()` in the same tick. Commit `startTime = anchor`. If the
playhead is at `totalDuration` when arming, seek to the anchor as-is (the clip will define new
duration); do not silently rewind to 0.

### Auto-pause suppression (R13)
`usePlayback` needs to know a live recording is in progress so its tick does not flip `isPlaying` off
at `totalDuration`. Cleanest: pass a `holdPastEnd` (or `recording`) flag into `usePlayback` (a ref it
reads in the tick), so during recording the playhead keeps advancing and `isPlaying` stays true.
`totalDuration` itself is derived from objects and will jump when the clip is committed; that is fine
(the clip already covers the recorded span).

### Types
- **No `types.ts` change.** Same as spec 34 R5/§3. A live-recorded clip is bare `AudioData`
  (`{assetId, volume, originalDuration, waveform?, sourceIn, sourceOut}`), `types.ts:186`.
- If a future UI ever needs to tell recordings apart, the optional additive `source?:
  'import'|'tts'|'recording'` field noted in spec 34 §3 is the trivial later change. Not needed here.

### Files
- `src/hooks/useMicRecorder.ts` (new): extract capture from `RecordModal.tsx` — stream acquisition,
  mime pick, `MediaRecorder`, chunk assembly, level meter, teardown; expose `arm()/start()/stop()/
  cancel()/dispose()`, `level`, `elapsed`, `error`. Used by both the live recorder and the modal.
- `src/components/App.tsx`: live-record mode state + anchor, Space/Escape routing, start/stop/cancel,
  commit (reuse `handleRecordConfirm`'s body with anchor + "Voiceover N"), `holdPastEnd` into
  `usePlayback`, thread record-mode props into `TransportBar`.
- `src/components/TransportBar.tsx`: Record/Stop button + armed/recording visual states, elapsed timer,
  level meter, headphones hint. New props (mode, level, elapsed, onToggleArm, onStartStop).
- `src/hooks/usePlayback.ts`: `holdPastEnd` flag consulted in the tick's end check.
- `src/components/RecordModal.tsx`: optionally refactor onto `useMicRecorder` (recommended, not
  required).
- `src/components/HotkeysModal.tsx`: document `R` (toggle record mode) and Space's record-mode meaning.

## Open questions

**Resolved (2026-09-11):**
1. **Start/stop gesture model** → **arm-mode + Space.** Record button (or `R`) arms and pauses at the
   playhead; Space starts, Space stops, Escape cancels/exits. Space keeps normal play/pause when
   record mode is off. (R1–R8 as written.)
2. **Auto-commit vs preview** → **auto-commit on stop** with a toast + undo. No preview step. (R9–R10.)
3. **After-stop playhead** → **return to the anchor** for one-key re-takes. (R10.)
5. **Monitoring** → **keep other tracks playing** + a headphones hint; no forced mute of existing audio
   in v1. (R17.)

**Still open (safe defaults, not blocking):**
4. **Countdown pre-roll.** A 3-2-1 count before capture begins. *Default: none in v1 (start
   immediately); add later if wanted.*
6. **Latency compensation.** *Default: none in v1 — anchor at the playhead, rely on dragging the clip
   (R15). A fixed input-latency offset is a later nicety.*
7. **ID/number.** Filed as `39`; requested as `23` (taken). *Default: keep `39`; rename on request.*

## Implementation guide

1. **Extract `useMicRecorder`** from `RecordModal.tsx`: move stream/recorder/chunks/level-meter/
   teardown into `src/hooks/useMicRecorder.ts`. Expose `arm()` (acquire stream), `start()`, `stop()`
   (→ returns/emits `{blob, elapsed}`), `cancel()`, `dispose()`, and reactive `level`, `elapsed`,
   `phase`, `error`. Keep `pickAudioMimeType`/`describeMicError`/`recordingSupported` exported from
   there. Optionally re-point `RecordModal` at the hook (no behavior change).
2. **`usePlayback` hold-past-end:** add a `holdPastEnd` ref/param; in the tick's `next >=
   totalDurationRef.current` branch, when `holdPastEnd` is set, keep advancing and do not clear
   `isPlaying`.
3. **App live-record state:** add `liveRecMode: 'off'|'armed'|'recording'` and `anchorTime`. Wire
   `useMicRecorder`. `toggleRecordArm()` → acquire mic (`arm()`), pause playback, set anchor =
   `globalTime`, mode `armed`; toggling again or Escape → `dispose()`, mode `off`.
4. **Start/stop/cancel:** `startLiveRecording()` → set anchor, `recorder.start()` + `playback.play()`,
   mode `recording`, `holdPastEnd = true`. `stopLiveRecording()` → `recorder.stop()`, `playback.pause()`,
   `holdPastEnd = false`; on the finished blob run the commit (decode → store → add clip at anchor,
   name "Voiceover N"), toast, `seek(anchor)`, mode back to `armed`. `cancelLiveRecording()` (Escape)
   → `recorder.cancel()`, `playback.pause()`, `seek(anchor)`, no clip, mode `armed`.
5. **Keydown routing** in `App.tsx:619`: branch Space by `liveRecMode` (see Technical notes); add
   `R`/`r` → `toggleRecordArm()` (respect the `canRecord` gate); route Escape.
6. **TransportBar UI:** Record button with three visual states, elapsed timer + level meter while
   recording, headphones hint. Thread props from `App`.
7. **Naming counter** for "Voiceover N" (count existing objects whose name starts with "Voiceover",
   or a simple incrementing ref).
8. **HotkeysModal:** document `R` and Space's record-mode meaning.
9. **Verify:** `npx tsc -b` green, then hand the user the browser checklist below.

### Browser checklist (for the user to run)
- Park the playhead mid-timeline → press `R` (or click Record) → transport goes red, playback paused,
  browser asks for mic once.
- Press Space → video plays from the playhead and recording starts; timer + level meter move as you
  talk; existing audio still plays.
- Press Space again → playback pauses, a "Voiceover N" clip appears **at the position you started**,
  with a waveform and correct length; a toast confirms.
- Play the timeline → the voiceover is heard at the right time. Ctrl+Z removes it.
- Re-arm and record a take that runs **past the end** → the playhead keeps advancing and the clip
  extends the timeline.
- Press Escape mid-recording → nothing is added, playhead is back at the start, mic indicator off.
- Export MP4 → the voiceover is present and correctly timed.
- Trim/split the clip, save `.gerty` + reopen → all intact.
- On a non-secure / no-mic context → the Record control is disabled with an explanatory tooltip; `R`
  does nothing.

## Acceptance criteria

1. A Record control in the transport (and `R`) toggles record-armed mode; arming pauses playback,
   anchors at the playhead, and acquires the mic.
2. While armed, **Space starts** recording+playback from the anchor; while recording, **Space stops**.
   Space keeps its normal play/pause meaning whenever record mode is off.
3. On stop, a normal `audio` clip is created **at the anchor** with a correct waveform and a **finite,
   correct duration**, as one undo entry; a toast confirms and the app returns to armed at the anchor.
4. A recording that runs past `totalDuration` keeps the playhead advancing and produces a clip that
   extends the timeline (no auto-pause at the old end).
5. Escape mid-recording discards the take (no clip), returns to the anchor, and releases the mic.
6. Existing timeline audio keeps playing during a recording; a headphones hint is shown.
7. Exiting record mode / stopping / cancelling releases the microphone (indicator off); no leaked
   streams or object URLs.
8. Permission-denied / no-mic / insecure-context each show a readable message and create no clip; the
   Record control is disabled when recording is unsupported.
9. The recorded clip previews, exports, trims, splits, honours volume/mute, and `.gerty` round-trips
   unchanged. No `types.ts` change.
10. `npx tsc -b` is green.

---
*Ready for implementation: `/task 39-live-voiceover-recording`*

# 33 — TTS extras (retro / "Microsoft Sam" voices)

## Overview

Spec 32 shipped neural narration (pocket-tts): natural, but the user finds the voices a bit
"AI-y". This spec adds an **old-school robotic voice** option - the "Microsoft Sam" / retro
computer-narrator aesthetic - as an additional voice choice in the *same* Text to Speech flow.

The clip it produces is still an ordinary `audio` `TimelineObject` with `tts` metadata, so preview,
export, trim, split, waveform, volume, and re-generate all keep working unchanged. This is a **new
engine + voice group behind the existing modal**, not new plumbing.

## The load-bearing question: can we use the Web Speech API voices the user linked?

**Short answer: no - not the actual browser/OS voices (Microsoft George/David/Hazel/Sam), for two
independent reasons. But yes to the *sound* they want, via a different mechanism.**

1. **Not capturable.** `window.speechSynthesis.speak()` renders straight to the audio output
   device. There is no standard web API to capture that into an `AudioBuffer` / `MediaStream` /
   `Blob`. This is the exact wall spec 32 §1 documented and rejected the Web Speech API over: a
   Web-Speech clip would be **silent in the exported MP4**, because export
   (`ffmpegExport.ts prerenderAudioMix`) pre-mixes every audio source through an
   `OfflineAudioContext` **from decoded blobs**. No blob → no export audio, no waveform, no scrub.
   (Hacks like `getDisplayMedia({audio:true})` tab-audio capture are Chrome-only, require a
   share-tab permission prompt, capture whatever else is playing, and are not a clean render. Not
   viable.)
2. **Not portable / not reproducible.** Those voices are the machine's installed SAPI/OS voices.
   "Microsoft George" exists on a Windows box and not on a Mac; the roster differs per machine and
   per browser. Even if we *could* capture, the choice wouldn't survive re-generation on another
   device - directly against the "re-editable, reproducible" property spec 32 built.

**What we CAN do:** the sound the user is chasing - a formant/retro robot narrator - is available
from an in-browser synth that returns **real PCM we own**, exactly like pocket-tts does. Two
candidate engines (see Technical Considerations §2), both tiny, offline, deterministic-enough, and
CPU-only (no WebGPU, no SharedArrayBuffer). They plug into the existing
`synthesizeSpeech → WAV blob → audio asset` path as a new voice group. So the feature is: **add a
retro engine + expose its voices**, and route synthesis to the right engine by voice.

## Requirements

### R1 — Retro voice(s) available in the existing TTS modal
- The Text to Speech modal (`TtsModal.tsx`) gains one or more retro/robotic voices, surfaced as a
  new **`optgroup`** in the existing voice picker (e.g. "Retro" / "Robotic"), alongside the current
  "English" (pocket-tts) group. No new modal, no separate entry point.
- Picking a retro voice and pressing **Generate** synthesizes with the retro engine and previews
  in-modal exactly like today; **Add to timeline** reuses the held blob (no re-synthesis).

### R2 — Retro synthesis returns a real, decodable WAV
- The retro engine produces PCM → a **16-bit PCM WAV `Blob`** (same format spec 32 standardized on,
  chosen because `decodeAudioData`/`getMediaDuration` handle it cleanly and duration is known from
  `samples / sampleRate`). Reuse the existing `encodeWav` in the worker (or an equivalent) so the
  output is byte-shape-identical to a pocket-tts clip.
- Returned as the same `TtsResult = { blob, duration, sampleRate }` the client already expects, so
  `handleTTSConfirm` needs **zero changes** to store the asset + build the clip.

### R3 — The clip remembers which engine + voice made it (re-generate must pick the right engine)
- A narration clip's `tts` metadata must record **which engine** generated it, so "Edit narration"
  regenerates with the same engine (a retro clip must not silently regenerate as a neural voice, or
  vice-versa). See Technical Considerations §3 for the type change (the load-bearing decision:
  `engine` field vs. namespaced voice ids).

### R4 — Retro-specific controls (if the chosen engine exposes them)
- Classic retro synths expose **pitch / speed / mouth / throat**-style knobs (sam-js) or
  **variant / pitch / speed** (eSpeak). Decide in the spec whether v1 exposes any of these or ships
  a single fixed "robot" voice per timbre. Recommendation: **v1 ships a small curated set of named
  presets** (e.g. "Robot", "Deep robot", "Glitchy") rather than raw sliders, matching how spec 32
  hid engine params behind curated voices. Any exposed control must round-trip in `TtsSource`.

### R5 — No regression to the neural path or the rest of the app
- pocket-tts voices behave exactly as before. The retro engine is **lazy-loaded** only when a retro
  voice is generated (or bundled only if it is genuinely tiny - see §2 bundle note), so non-TTS and
  neural-only users pay nothing extra.
- Export, preview, trim/split, `.gerty` round-trip: all unchanged (a retro clip is a plain `audio`
  object; the only new persisted bit is the engine tag in `tts`).

### R6 — Graceful failure
- If the retro engine fails to load (voice data fetch error) or throws, the modal surfaces a
  readable error and creates no broken clip - identical handling to the neural path today.

## Technical Considerations

### §1 — The existing pipeline this rides on (all confirmed present, no changes needed downstream)
- **Client:** `synthesizeSpeech(params, onProgress): Promise<TtsResult>` ([src/lib/tts.ts](../src/lib/tts.ts)) posts to a singleton worker and resolves `{ blob, duration, sampleRate }`.
- **Worker:** [src/lib/tts.worker.ts](../src/lib/tts.worker.ts) currently hardcodes the pocket-tts pipeline; it owns `encodeWav` (16-bit PCM WAV) and the `generate → progress* → result` protocol.
- **Commit:** `handleTTSConfirm(result, params)` ([App.tsx:336](../src/components/App.tsx#L336)) → `storeAsset(File)` → set `meta.duration` → `generateWaveform` → `createTimelineObject('audio', {…, tts})` → `addObjects`. Edit mode replaces in place via `UPDATE_OBJECT`.
- **Modal:** `TtsModal.tsx` groups `TTS_VOICES` by `voice.group` into `<optgroup>`s already - a retro group is purely additive data.
- **Type:** `TtsSource = { text, voice, speed }` on `AudioData` ([types.ts:180](../src/types.ts#L180)).

### §2 — Engine options for the retro sound

Both are in-browser, offline, CPU-only, return PCM (so both satisfy R2 the same way pocket-tts
does). They differ in exact timbre, size, and license. **This is the primary open decision (Open Q1).**

**Option A — `sam-js` (Software Automatic Mouth, the 1982 C64 voice).**
- The literal ancestor of the "Sam" name; the most unmistakably *retro/robotic* sound (buzzy,
  alien, C64-era). Pure JS, **no model download** (~tens of KB of code), instant, runs main-thread.
- API shape (to confirm in spike): `new SamJs(opts).buf8(text) → Uint8Array` of 8-bit unsigned PCM
  @ 22050 Hz; exposes `pitch`, `speed`, `mouth`, `throat`, and a `phonetic` mode. We wrap the PCM
  in our WAV encoder (upconvert 8-bit → 16-bit, set rate 22050).
- Sound is *buzzier / more alien* than XP-era "Microsoft Sam" (which was smoother). Closest to
  "old school computer voice".
- License: reverse-engineered 1982 software; JS ports are typically MIT-licensed but the underlying
  provenance is murky. **Verify the specific package's license before adopting (Open Q2).**

**Option B — eSpeak-NG (formant synth) via a WASM/JS port (`mespeak` / `espeak-ng.js`).**
- A cleaner, more *intelligible* robot - closest to actual XP-era "Microsoft Sam" and the eSpeak
  robot voices people recognize. Many languages, `variant`/`pitch`/`speed`/`wordgap` knobs.
- `meSpeak.speak(text, { rawdata: 'buffer' }) → ArrayBuffer` (already a WAV) - even less encoding
  work. Needs a **voice/config data download** (config + voice files, on the order of hundreds of
  KB, far smaller than pocket-tts's ~156MB).
- **License: eSpeak-NG is GPLv3.** Shipping GPLv3 code in this app has licensing implications the
  neural path (MIT pocket-tts) doesn't. **This is a real blocker to weigh (Open Q2).**

**Recommendation:** `sam-js` for v1 - it best matches "old school Microsoft Sam style thing", has no
model download, no GPL entanglement, and no threading/COEP needs. Keep eSpeak as a documented
alternative if a *more intelligible* robot is wanted later.

**Bundle note:** sam-js is small enough (~tens of KB) that it can be **statically imported in the
worker** without a meaningful bundle cost, unlike pocket-tts/ort. Confirm exact size in the spike;
if it grows, lazy-`import()` it inside the worker on first retro generate.

### §3 — Type change: how a clip records its engine (the load-bearing decision)

`TtsSource.voice` today is a bare engine voice id. Re-generate (R3) must route to the correct
engine. Two designs:

**(a) Add an explicit `engine` field (recommended):**
```ts
export type TtsEngine = 'pocket' | 'sam'   // extend when eSpeak/others land

export type TtsSource = {
  text: string
  voice: string           // engine-scoped voice id
  speed: number
  engine?: TtsEngine      // NEW — absent ⇒ 'pocket' (back-compat for spec-32 clips)
}
```
- `engine?` **optional, defaulting to `'pocket'`** keeps every existing spec-32 clip valid with no
  migration (absent ⇒ the neural engine, which is what they are). Additive, persists in project
  JSON + `.gerty` for free (same as `tts` itself did).
- The modal's voice roster entries carry their engine (extend `TtsVoice` with `engine`), the client
  passes `engine` to the worker, and the worker dispatches to the right pipeline.

**(b) Namespace the voice id (e.g. `sam:robot`) and infer engine from the prefix.** No type change,
but it overloads `voice` with two meanings and needs parsing everywhere. **Rejected** unless we want
to avoid touching `types.ts` - explicit `engine` is clearer and matches the codebase's typed style.

Decision to confirm: **(a)**, `engine?: TtsEngine` defaulting to `'pocket'`.

### §4 — Worker dispatch

`tts.worker.ts` currently *is* the pocket-tts pipeline. Cleanest refactor:
- The `generate` message gains `engine`. The worker's `onmessage` dispatches: `engine==='sam'` →
  the sam-js path (synchronous-ish, no big model load; emit a single `synth` progress tick), else
  the existing pocket-tts path.
- Keep `encodeWav` shared. sam-js's 8-bit PCM upconverts to the same 16-bit WAV shape.
- Alternative: a **separate `ttsRetro.worker.ts`** so the pocket-tts code stays untouched and the
  retro engine never drags in ort. Given sam-js is tiny and main-thread-capable, a **second small
  worker (or even main-thread synthesis)** is viable and lower-risk than editing the delicate
  pocket-tts worker (which has load-bearing dynamic-import/threading comments). **Lean toward a
  separate retro path** so the two engines are fully decoupled. Confirm in Implementation Notes.

### §5 — Determinism
- sam-js is deterministic (no RNG) → same text+params = same audio, nice for reproducibility.
- pocket-tts uses `Math.random` Gaussian sampling (non-deterministic), but that's already fine
  because synthesis bakes to a frozen asset once (spec 32 §5). Retro is strictly simpler here.

## Related Systems and Tasks

- **Spec 32 (the whole pipeline this extends):** [SPECS/32-text-to-speech.md](32-text-to-speech.md),
  [TASKS/32-text-to-speech.md](../TASKS/32-text-to-speech.md) (esp. §1 Web-Speech rejection, and the
  pocket-tts pivot log).
- **Engine wrapper / roster:** [src/lib/tts.ts](../src/lib/tts.ts) (`TtsVoice`, `TTS_VOICES`,
  `synthesizeSpeech`, protocol types).
- **Worker:** [src/lib/tts.worker.ts](../src/lib/tts.worker.ts) (`encodeWav`, `generate` protocol).
- **Modal:** [src/components/TtsModal.tsx](../src/components/TtsModal.tsx) (voice `optgroup`s,
  generate/preview/commit).
- **Commit + edit handlers:** [src/components/App.tsx](../src/components/App.tsx) `handleTTSConfirm`
  / `handleEditNarration` (~336 / ~327).
- **Type:** [src/types.ts](../src/types.ts) `TtsSource` / `AudioData` (~180-197).
- **Downstream (unchanged, confirmed in spec 32 §4):** `useAudioPlayback.ts`, `ffmpegExport.ts`,
  `mediaTiming.ts`, `assetStore.ts`.

## Direction pivot (2026-08-03, after in-browser sound test)

The user tried both full-formant retro engines (sam-js and eSpeak) and found **both too broken** -
they read as "robot", not the wanted vibe. The real target is a **middle ground**: still
intelligible, but *less "AI-y"* (less of the clean, polished, synthetic-neural sheen the current
pocket-tts voices have). So the retro-synth direction above is **shelved**; the live question is how
to get a *different-character but still natural-ish* voice. Candidate routes (see revised Open Qs):

- **Route A — Piper voices.** Add Piper (rhasspy) as a second neural engine with a **library of
  downloadable voices** (many speakers; low/medium/high quality tiers - the lighter tiers read as
  characterful / slightly lo-fi, often exactly the "less slick" quality wanted, without being
  broken). In-browser ONNX, per-voice ~20-60MB, returns PCM → same pipeline. Same `engine` type
  machinery as §3 (`'piper'`).
- **Route B — pocket-tts voice cloning.** Enable the `mimi_encoder` we currently skip; let the user
  upload a short reference clip and clone that voice (a real person / old recording / character).
  The most direct "sound like a specific non-AI human" lever, entirely within the current engine.
- **Route C — Vintage post-FX.** Run the synthesized WAV through a WebAudio filter chain
  (telephone/tape/lo-fi: bandpass, gentle bitcrush, noise, wobble) to strip the "clean digital"
  sheen. Cheap, complements A/B, but only fixes **timbre**, not **cadence**.
- **Route D — More curated pocket-tts voices.** Limited: no known large public library of drop-in
  pocket-tts voice embeddings beyond the shipped 8.

Open decision below drives which of these v1 pursues.

## Open Questions

- **Open Q1 (SUPERSEDED by the pivot above) — Which retro engine for v1?** sam-js (truest retro / no download / permissive-ish) vs
  eSpeak-NG (more intelligible "Microsoft Sam", multi-language, but GPLv3 + a voice-data download).
  *Recommendation: sam-js.* — **needs the user's call (drives everything below).**
- **Open Q2 — License clearance.** If eSpeak: is GPLv3 acceptable in this app? If sam-js: pin the
  exact npm package and confirm its stated license before adopting.
- **Open Q3 — Controls (R4).** Ship a few curated named presets, or expose raw pitch/speed/mouth
  sliders? *Recommendation: 2-4 curated presets in v1.*
- **Open Q4 — Worker vs main thread / shared vs separate worker (§4).** *Recommendation: keep the
  retro engine fully decoupled from the pocket-tts worker (separate worker or main-thread), to avoid
  destabilizing the neural pipeline.*
- **Open Q5 — De-risk spike first?** Spec 32 spiked pocket-tts standalone before porting and it paid
  off. Worth a tiny standalone sam-js/eSpeak sound check in the user's browser before wiring in?
  *Recommendation: yes, a 15-minute sound-and-quality check, since "does it actually sound like what
  I want" is the whole point.*

## Acceptance Criteria

1. The TTS modal shows a retro/robotic voice group; picking one and generating produces audibly
   old-school robotic speech, previewable in-modal, UI responsive.
2. "Add to timeline" places a normal `audio` clip with correct waveform + duration; it plays at the
   right time, scrubs, trims, and splits like any audio clip.
3. Exporting an MP4 includes the retro narration audio, correctly timed, **with no changes to the
   export mixer**.
4. "Edit narration" on a retro clip reopens pre-filled and regenerates **with the retro engine**
   (never silently switches engines); one undo entry; start time preserved.
5. Existing spec-32 (neural) clips are unaffected and still regenerate as neural; a project saved
   before this spec opens with no migration.
6. `.gerty` save/reopen preserves the retro audio and its editable script/voice/engine.
7. `npx tsc -b` is green; the neural (pocket-tts/ort) bundle is not pulled in by choosing a retro
   voice unless a neural voice is also used.

## Implementation Notes

- **types.ts:** add `TtsEngine` + optional `engine?: TtsEngine` on `TtsSource` (default `'pocket'`).
  Extend the `TtsVoice` roster shape with `engine`.
- **tts.ts:** add retro voices to `TTS_VOICES` (new `group: 'Retro'`, `engine: 'sam'`); thread
  `engine` through `synthesizeSpeech` → the worker message. Optionally route retro to a separate
  `ttsRetro.worker.ts` (or synthesize sam-js on the main thread) so pocket-tts stays untouched.
- **worker(s):** wrap sam-js PCM (8-bit @ 22050) into the shared 16-bit `encodeWav`. Emit a single
  `synth` progress tick (retro is near-instant, no download phase).
- **TtsModal.tsx:** no structural change - the new `optgroup` falls out of the roster data. If R4
  presets are per-engine, the picker already handles arbitrary groups/labels.
- **App.tsx:** `handleTTSConfirm` writes `engine` into `data.tts`; `handleEditNarration` already
  round-trips `tts` params - confirm `engine` flows into `TtsParams`/the modal `initial`.
- **Verify:** `npx tsc -b`, then a browser checklist (open modal → pick retro voice → generate →
  hear the robot → add → play → export → edit narration → confirm still retro → reopen).

## Rough edges / watch-list
- Don't destabilize the pocket-tts worker (it has load-bearing dynamic-import/threading comments) -
  prefer a decoupled retro path (§4).
- License: eSpeak is GPLv3; sam-js provenance is murky. Clear this before adopting (Open Q2).
- A retro clip is a plain `audio` object: duplicate/split deep-clone `data.tts` including `engine`;
  "Edit narration" on a split half regenerates full-length (same known edge as spec 32).
- If any retro control (pitch/speed) is exposed, it must round-trip in `TtsSource` or re-generate
  will drift from the original.

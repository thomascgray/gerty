# 32 — Text to Speech (narration)

**Status**: Shipped (live in production; follow-up backlog tracked at the bottom of this file)

## Overview

Add a **Text to Speech** narration feature. The user types/pastes a script, picks a curated voice
+ speed, and the app synthesizes narration **entirely client-side** (neural TTS via `kokoro-js`,
WebGPU→WASM, in a Web Worker). The result is a WAV blob registered as an audio asset and dropped
onto the timeline as an ordinary `audio` `TimelineObject` - so preview, export, trim, split,
waveform, and volume all work with **zero downstream changes**. The clip remembers its
`{text, voice, speed}` so the user can reopen and **re-generate** in place.

Full spec: [SPECS/32-text-to-speech.md](../SPECS/32-text-to-speech.md).

## Task Context

- **Core decision**: a TTS clip is NOT a new object type - it's an `audio` object with an optional
  `tts?: TtsSource` field on `AudioData`. Matches "features are a layer, not a rewrite".
- **Engine**: `kokoro-js` (Kokoro-82M ONNX). API: `KokoroTTS.from_pretrained(modelId, {dtype,
  device, progress_callback})` → `tts.generate(text, {voice, speed})` → `RawAudio` with
  `.audio` (Float32Array), `.sampling_rate` (24000), `.toWav()` (ArrayBuffer) / `.toBlob()` (WAV).
  `TextSplitterStream` for long text. Model id `onnx-community/Kokoro-82M-v1.0-ONNX`.
- **WAV** chosen (not WebM): decodes cleanly in export's `decodeAudioData` + duration known from
  `samples/sampleRate` (avoids the WebM `Infinity`-duration pitfall).
- **Lazy-load / worker**: all `kokoro-js` imports live inside `tts.worker.ts` (dynamic worker chunk)
  so the initial bundle and non-TTS users pay nothing, and inference doesn't freeze the UI.
- **Model download**: ~80-330MB from HF CDN on first Generate, browser-cached. Accepted; show
  progress + a one-time notice.
- **Single synthesis pass**: Generate synthesizes once + previews; "Add to timeline" reuses the held
  blob (no re-synth). Editing any field after generating invalidates the held blob.

### pocket-tts pivot (2026-08-02)
- **Why**: kokoro is unusable on the user's hardware (WebGPU garbled/silent; WASM too slow for
  multi-sentence). pocket-tts (kyutai-labs) is CPU-first (~6x realtime, no WebGPU needed), streams
  ~200ms chunks, MIT licensed, 100M params, English + FR/DE/PT/IT/ES, 25+ voices, runs on old phones.
  Directly resolves our speed + GPU-reliability blockers instead of working around them.
- **No official JS/npm package** - official pocket-tts is Python. Browser support is community ports.
- **Chosen port: KevinAHM ONNX Runtime Web** - keeps us on a single runtime (`ort`, already bundled
  via kokoro-js) with full control. Repos:
  - Exporter: https://github.com/KevinAHM/pocket-tts-onnx-export (MIT; produces the ONNX bundle)
  - **Working browser reference (port target)**: HF Space `KevinAHM/pocket-tts-web`
    (https://huggingface.co/spaces/KevinAHM/pocket-tts-web/tree/main). Key files:
    `inference-worker.js` (34kB, model load + orchestration, already a Web Worker),
    `onnx-streaming.js` (32.6kB, ONNX exec + streaming diffusion loop),
    `sentencepiece-browser.js` (tokenizer), `PCMPlayerWorklet.js` (live playback - IGNORE, we write
    a WAV blob), `EventEmitter.js`.
- **Model = streaming LM + Mimi neural codec** = 5 ONNX graphs per language bundle:
  `text_conditioner`, `flow_lm_main` (transformer backbone + state), `flow_lm_flow` (stateless
  flow-matching step, looped = the diffusion loop lives in the JS runtime), `mimi_decoder`,
  `mimi_encoder` (voice-cloning ref audio only). Streaming caches/counters are exposed as explicit
  ONNX inputs/outputs. Bundle also ships `bundle.json`, `tokenizer.model`, `bos_before_voice.npy`,
  optional int8-quantized variants.
- **Inference chain**: text → sentencepiece tokens → `text_conditioner` → `flow_lm_main` +
  `flow_lm_flow` (looped) → latents → `mimi_decoder` → PCM chunks → (client) assemble WAV.
- **Curated voices**: likely ship *precomputed* voice embeddings + `bos_before_voice.npy` and SKIP
  `mimi_encoder` at runtime (encoder is only for cloning arbitrary reference audio). Confirm in port.
- **Integration fit**: our existing `tts.worker.ts` (Web Worker) + `ort` + planned client-side WAV
  encoding map directly onto the reference. The paused streaming `init`/`gen`→`chunk` protocol suits
  pocket-tts's chunked output - reuse it rather than revert.
- **De-risk first**: throwaway spike (standalone, outside the app worker) to confirm the port
  actually produces good, non-garbled audio at acceptable speed IN THE USER'S BROWSER before wiring
  into the app. "Works in the author's demo" is exactly what kokoro promised and broke on this GPU.

### Key files / anchors (from spec investigation)
- `src/types.ts`: `AudioData` ~177-187, `createTimelineObject` ~586-631.
- `src/lib/assetStore.ts`: `storeAsset` 67-99 (takes a `File`; does NOT set audio `meta.duration`),
  `getAssetBlob`/`getAssetUrl` 110-122, `generateWaveform` 197-219.
- `src/components/App.tsx`: `addObjects` ~262-276, `handleAddExistingAsset` ~281-307 (best template),
  `handleCreateObject` ~309-352 (do NOT use for TTS), `<LeftRail>` wiring ~742-746,
  `<ImportModal>` wiring ~864-868.
- `src/components/LeftRail.tsx`: `LeftRailProps` ~18-26, `MediaSection` ~176-203, `SimpleSection`
  ~229-250.
- `src/components/PropertiesPanel.tsx`: add "Edit narration" for audio objects with `data.tts`.
- `src/hooks/useAudioPlayback.ts` + `src/lib/ffmpegExport.ts`: NO changes needed (confirmed).

## Blockers/Issues

> 🔀 **PIVOT (2026-08-02): abandoning kokoro as the engine, moving to pocket-tts.** Kokoro hit a
> hard wall on the user's machine that we cannot code around: WebGPU produces garbled/silent audio
> (their GPU/driver, same as kokoro's own hosted demo), and the WASM CPU fallback is too slow for
> multi-sentence scripts. This is the *exact* problem the pocket-tts blog post describes. pocket-tts
> is CPU-first by design (~6x realtime, no WebGPU), streams ~200ms chunks, MIT, 100M params. See the
> "pocket-tts pivot" section under Task Context. **Chosen integration path: the ONNX Runtime Web port
> (KevinAHM), spiked standalone first.** The half-migrated kokoro worker below is now moot - the
> streaming `init`/`gen`→`chunk` protocol it introduced is, however, a good match for pocket-tts and
> may be reused rather than reverted.

> ⚠️ **PRIOR CODE STATE (2026-08-02): HALF-MIGRATED / RUNTIME-BROKEN.** `src/lib/tts.worker.ts` was
> rewritten to a **per-sentence service** (protocol: `init` / `gen` → `chunk`) as the first half of a
> CPU worker-pool parallelization. **`src/lib/tts.ts` (client) was NOT updated** — it still speaks the
> OLD whole-text protocol (`generate` → `result`). tsc stays green (postMessage payloads aren't
> cross-checked), but **TTS will not work at runtime**: the client sends `generate`, the new worker
> only handles `init`/`gen`, so no `result` ever comes back. **The user paused here — has a new
> solution in mind.** To get back to a working state we must EITHER finish the client pool OR revert
> the worker to the last-working single-worker version (git: the worker as of the "WASM default" work
> log entry below — whole-text `generate`/`result`, internal sentence split, own WAV encoder).

Resolved during build:
- **transformers.js `allowLocalModels` default is `true`** → under Vite dev the SPA fallback returns
  index.html (200) for `/models/...`, which then fails to parse as model JSON. Fixed by setting
  `env.allowLocalModels = false` in the worker (import `env` from `@huggingface/transformers`, which
  is kokoro-js's own dependency and always present).
- **Engine decision**: forced WASM path (`device:'wasm', dtype:'q8'`) — no WebGPU dependency — because
  the user found the hosted (WebGPU) kokoro demo non-functional. WASM runs on any browser.

## Decisions locked (this session)

- Model download from HF CDN accepted; gated behind first Generate with progress + one-time notice.
- Curated 8-voice English roster (American/British, M/F) to start.
- Single synthesis pass: Generate synthesizes+previews once; commit reuses the held blob.
- **Engine = kokoro-js, forced WASM** (not WebGPU, not Web Speech). Web Speech can't be captured to a
  file and is Chrome-only via getDisplayMedia; kokoro WASM is cross-browser and returns real PCM.

## Port decisions locked (2026-08-02, post-spike)

- **Engine**: pocket-tts (KevinAHM ONNX Runtime Web port), adapted into `tts.worker.ts`. Drop
  `kokoro-js` + all WebGPU/device fallback code. Add `onnxruntime-web` as a direct dep.
- **Pipeline**: 4 ONNX graphs (skip `mimi_encoder` - curated voices come from `voices.bin`, encoder
  is voice-cloning only). `text_conditioner → flow_lm_main/flow (loop) → mimi_decoder` → PCM chunks
  → assemble one WAV on the worker. Single worker (RTFx already >1; no pool).
- **sentencepiece.js**: self-contained (wasm embedded via `wasmBinary`, own browser shims). Vendor as
  a committed static asset (`public/vendor/sentencepiece.js`), loaded in the worker via a
  `/* @vite-ignore */` runtime dynamic import so Vite doesn't try to bundle its dead Node branches.
- **Model hosting**: self-host, GITIGNORED, populated by an `npm run fetch-tts-model` script →
  `public/models/pocket-tts/english/`. Repo stays lean; offline once fetched.
- **ORT wasm**: served locally from `public/vendor/ort/` (copied by the fetch script), `wasmPaths`
  pointed there - no CDN, honors the client-side/offline architecture.
- **Speed**: pocket-tts has NO speed param → remove the modal's Speed slider. `TtsSource.speed` stays
  in the type (fixed 1) so persistence/other code is untouched. Timeline clip-speed still works after.
- **Voices**: 8 English voices labelled by capitalized character name (Alba, Azelma, Cosette,
  Eponine, Fantine, Javert, Jean, Marius) under one "English" group - no gender guessing. Default
  `alba`. Refine labels after previewing in-app.

## TODO

[X] Install `kokoro-js` dependency (v1.2.1)
[X] `types.ts`: add `TtsSource` type + optional `tts?` on `AudioData`
[X] `src/lib/tts.worker.ts`: Web Worker - forced WASM (q8), lazy singleton model, sentence-split +
    per-sentence progress, own 16-bit PCM WAV encoder, post progress/result/error
[X] `src/lib/tts.ts`: main-thread client (singleton worker, `synthesizeSpeech(params, onProgress)`,
    curated `TTS_VOICES` roster)
[X] `src/components/TtsModal.tsx`: script textarea + grouped voice picker + speed slider +
    Generate/preview + Add-to-timeline / Update-narration; progress; error; held-blob invalidation
[X] `App.tsx`: `handleCreateTTS` + `handleEditNarration` + `handleTTSConfirm`; `ttsModal` state;
    `ttsClipName` helper; render `<TtsModal>`
[X] `LeftRail.tsx`: "Text to speech" button in Media section + `onCreateTTS` prop threaded through
[X] `PropertiesPanel.tsx`: "Narration" accordion + "Edit narration" button when audio has `data.tts`
[X] Verify `npx tsc -b` green; production build confirms engine is code-split into `tts.worker`
    chunk (2.2MB) + ort wasm (21MB) as lazy assets, NOT in the main bundle (954KB)
[X] Core feature verified working end-to-end by user (WASM path: generate → preview → add → play).

Speed follow-up (GPU unreliable on user's machine → CPU parallelization chosen):
[~] `tts.worker.ts`: rewrite to per-sentence service — **DONE**
[ ] `tts.ts`: client worker-pool orchestrator — **NOT DONE (paused; user has a new solution)**
[~] Code is half-migrated → superseded by the pocket-tts pivot (kokoro no longer the engine).
[ ] User browser test of the final speed solution

Pocket-tts pivot (2026-08-02 — kokoro abandoned as engine):
[X] SPIKE scaffolded: KevinAHM `pocket-tts-web` reference app dropped verbatim into gitignored
    `public/pocket-tts-spike/` (served by the app's own Vite dev server, which already sends the
    COOP/COEP headers pocket-tts needs). English bundle only (~194MB). Awaiting user browser test.
[X] User browser test of the spike PASSED (2026-08-02): audio clean on multiple voices, fully
    on-device, RTFx 1.53x (faster than realtime), TTFB 225ms. Green light to port into the app.
[X] Decide model hosting: self-host, gitignored, `npm run fetch-tts-model` → public/models + vendor.
[X] Decide curated-voice story: voices.bin precomputed states, skip `mimi_encoder`. 8-voice roster.
[X] Port into app: `tts.worker.ts` rewritten as the pocket-tts ONNX pipeline (TS); PCM → WAV on the
    worker. Dropped kokoro-js + all WebGPU/device code. tsc + eslint green.
[X] User browser test of the ported in-app feature — PASSED locally AND in production (gerty.tomg.cool,
    weights from R2). Final prod blocker was the ort threading deadlock, fixed via numThreads=1.

## Work Log

[2026-08-02] Task started. Spec 32 finalized. Installed `kokoro-js` v1.2.1.

[2026-08-02] Implemented the full feature end-to-end. tsc green; production build confirms code-split.
- Files added: `src/lib/tts.ts` (client + voice roster), `src/lib/tts.worker.ts` (WASM engine +
  WAV encoder), `src/components/TtsModal.tsx`.
- Files modified: `src/types.ts` (TtsSource + `AudioData.tts?`), `src/components/App.tsx` (state +
  3 handlers + ttsClipName + modal render + LeftRail/PropertiesPanel wiring),
  `src/components/LeftRail.tsx` ("Text to speech" Media button), `src/components/PropertiesPanel.tsx`
  ("Narration" accordion + Edit narration), `package.json`/`package-lock.json` (kokoro-js).
- Engine forced to WASM per user (hosted WebGPU demo was broken for them). `env.allowLocalModels=false`
  to dodge the Vite SPA-fallback model-path trap.

[2026-08-02] Hardening after first user test ("modal just closed on first Generate").
- `tts.ts`: added worker `error`/`messageerror` listeners → reject the promise with a readable message
  instead of hanging/dying silently; also try/catch around postMessage.
- `TtsModal.tsx`: backdrop-click + Esc no longer dismiss the modal while generating (an accidental
  click during the long first-run model download was the likely cause of the "just closed").
- Files modified: `src/lib/tts.ts`, `src/components/TtsModal.tsx`.

[2026-08-02] Speed pass (user: "generation takes ages for >1 sentence").
- WASM threading: set `env.backends.onnx.wasm.numThreads = min(hardwareConcurrency, 8)` (effective
  under our COOP/COEP isolation). Free CPU-path win.
- **WebGPU with auto-fallback** (user opted in): `loadModel` now tries `device:'webgpu', dtype:'fp16'`
  first, VALIDATES it with a tiny warmup generate (so a broken GPU stack fails during load and falls
  back, not on real text), then falls back to `device:'wasm', dtype:'q8'` on any failure or when no
  GPU adapter is present. 5-20x faster when the GPU path takes. GPU path does a one-time larger
  (~160MB fp16) download; non-GPU users keep q8/86MB.
- Surfaced the active backend to the UI (result carries `device`; modal shows a GPU/CPU chip). Worker
  logs `[tts] using WebGPU/WASM` to console.
- Files modified: `src/lib/tts.worker.ts`, `src/lib/tts.ts`, `src/components/TtsModal.tsx`.

[2026-08-02] Fix: WebGPU generated SILENT audio (user report). Root cause: Kokoro's **fp16 WebGPU**
path produces NaN/zero samples (silent, but doesn't throw), and my warmup "validation" only checked
that generate() didn't throw — so silence passed. Fixes in `tts.worker.ts`:
- WebGPU dtype `fp16` → **`fp32`** (the known-good Kokoro GPU dtype; ~326MB one-time download vs
  fp16's 163MB, but actually produces sound).
- Added `hasSignal(samples)` — rejects non-finite (NaN/Inf) or near-silent output. The GPU warmup now
  generates a probe utterance AND checks it has real signal; failure falls back to WASM q8 (known
  good). So a silently-broken GPU path can no longer slip through.

[2026-08-02] WebGPU garbles on the user's GPU (razor noise on fp32; silent on fp16) — same as they
saw on kokoro's own site → it's their GPU/driver, not our code. Garbled (non-NaN) output can't be
auto-detected, so we can't safely auto-use WebGPU. Reverted default to **WASM**, kept WebGPU behind
an opt-in `device` param (default `'wasm'`), model cached per-device (`modelPromises` map). Client +
worker thread the `device` through; modal currently always requests wasm (no toggle yet).
- Files modified: `src/lib/tts.worker.ts`, `src/lib/tts.ts`.

[2026-08-02] Speed: user chose "parallelize across CPU cores". STARTED the worker-pool rewrite, then
PAUSED at user request (new solution in mind). **Left the code half-migrated — see the ⚠️ warning at
the top of Blockers/Issues.**
- DONE: `src/lib/tts.worker.ts` rewritten to a per-sentence service. New protocol:
  - `{type:'init', threads, reportDownload}` — sent once per worker before first gen; sets
    `numThreads` (client divides total cores across the pool so it doesn't oversubscribe) and whether
    this worker reports model-download progress (only the pool's worker 0 does).
  - `{type:'gen', reqId, text, voice, speed, device?}` → `{type:'chunk', reqId, pcm, sampleRate,
    device}` (pcm buffer transferred) or `{type:'error', reqId, message}`; download progress arrives
    as `{type:'progress', phase:'download', …}` (no reqId).
  - Worker no longer splits sentences, merges, or encodes WAV — those move to the client.
- NOT DONE: `src/lib/tts.ts` client pool orchestrator. Intended design (for whoever resumes):
  - Persistent pool, `poolSize = min(cores, MAX_POOL=4)`, `threadsPerWorker = min(4, floor(cores/
    poolSize))`. Grow lazily to `min(poolSize, sentenceCount)`.
  - Client-side sentence split (simple regex — kokoro's `TextSplitterStream` lives in the worker, and
    we no longer want a worker round-trip just to split).
  - Cache-prime: run sentence 0 on worker 0 and AWAIT it (downloads+caches the ~86MB model once),
    THEN grow the pool + distribute remaining sentences via a work queue (idle worker pulls next
    index) so the other workers hit the browser cache instead of a thundering-herd re-download.
  - Move `mergeFloat32` + `encodeWav` (16-bit PCM) from the worker into the client; assemble the WAV
    from the collected per-sentence PCM chunks in index order. `duration = merged.length/sampleRate`.
  - Progress: forward download progress from worker 0; emit `{phase:'synth', done, total}` as chunks
    complete.
- Alternatives not taken (in case the new solution revisits): keep simple single-worker WASM; add an
  opt-in "experimental GPU" toggle for machines whose GPU works (user previews to verify not garbled).

[2026-08-02] PIVOT to pocket-tts (kokoro abandoned as engine). Kokoro is unusable on the user's
hardware - WebGPU garbled/silent, WASM too slow for multi-sentence - which is the exact problem the
pocket-tts blog post (kcsujeet.com.np) describes. Researched pocket-tts (kyutai-labs): CPU-first
(~6x realtime, no WebGPU), streaming, MIT, 100M params. No official JS package; browser support is
community ports. User chose the **ONNX Runtime Web port (KevinAHM)** to stay on a single `ort`
runtime. Found the HF Space `KevinAHM/pocket-tts-web` is a complete browser reference (Web Worker +
onnxruntime-web + sentencepiece), a direct port target for our `tts.worker.ts`. Recorded the pivot,
the 5-ONNX-graph architecture, and a spike-first plan in Blockers/Issues + Task Context + TODO. No
code changed yet - next step is a throwaway standalone spike to confirm quality/speed in the user's
browser before wiring into the app.

[2026-08-02] Scaffolded the pocket-tts spike. Verified the KevinAHM `pocket-tts-web` HF Space is a
complete browser reference (worker `inference-worker.js` + `onnx-streaming.js` + `sentencepiece.js`;
curated voices from `voices.bin`, encoder only for custom uploads; ort + wasm from jsdelivr CDN;
needs COOP/COEP). Confirmed the app's Vite dev already sends those headers. Dropped the whole
reference app verbatim into gitignored `public/pocket-tts-spike/` + downloaded the English
`english_2026-04` bundle (~194MB, all int8 ONNX; sample_rate 24000; voices alba/azelma/cosette/
eponine/fantine/javert/jean/marius). Serve via the running dev server; test URL
`/pocket-tts-spike/index.html`. Purpose: confirm non-garbled audio + acceptable CPU speed on the
user's machine BEFORE porting into `tts.worker.ts`. Files: `.gitignore` (+spike entry), everything
under `public/pocket-tts-spike/` (untracked). No app code touched.

[2026-08-02] Ported pocket-tts into the app (engine swap complete). tsc + eslint green; awaiting user
browser test.
- Deps: removed `kokoro-js`, added `onnxruntime-web@1.20`.
- `scripts/fetch-tts-model.mjs` + `npm run fetch-tts-model`: downloads the English bundle (weights +
  sentencepiece.js) from the KevinAHM HF Space into gitignored `public/models/pocket-tts/english_2026-04/`
  and copies ORT wasm + `.mjs` glue from node_modules into `public/vendor/ort/`. `.gitignore`:
  `public/models/` + `public/vendor/`. (Spike folder `public/pocket-tts-spike/` deleted - throwaway.)
- `src/lib/tts.worker.ts`: full rewrite as the pocket-tts pipeline (adapted from KevinAHM
  inference-worker.js → TS). Loads 4 int8 ONNX graphs (no encoder), sentencepiece tokenizer (runtime
  `/* @vite-ignore */` import of vendored module), voices.bin curated states. `text_conditioner →
  flow_lm_main/flow (loop) → mimi_decoder` → collects PCM → 16-bit WAV on the worker. ORT wasm served
  from `/vendor/ort/` (local), `numThreads` under COOP/COEP. Protocol kept as generate→progress→result
  (matches the untouched client message shape), progress carries the request id (download + synth phases).
- `src/lib/tts.ts`: new 8-voice roster (Alba/Azelma/Cosette/Eponine/Fantine/Javert/Jean/Marius, group
  "English", default `alba`); dropped TtsDevice/speed/device from the protocol + result.
- `src/components/TtsModal.tsx`: removed the Speed slider + GPU/CPU chip; Voice picker full-width.
  `speed` retained (fixed 1) only for TtsSource round-tripping on edit.
- App.tsx / types.ts / PropertiesPanel.tsx / LeftRail.tsx: unchanged (TtsSource still {text,voice,speed};
  handlers use blob/duration only).
- KNOWN RUNTIME RISKS to watch in the browser test: (1) onnxruntime-web ESM bundling inside the Vite
  module worker; (2) the vendored sentencepiece.js @vite-ignore runtime import resolving under COEP;
  (3) ORT threaded wasm/.mjs loading from /vendor/ort/. All are load-time - a failure surfaces as a
  modal error / console error, not a silent hang.

[2026-08-02] Fixed two dev-only runtime bugs found in the first in-app test (tsc/eslint can't catch
either; `npx vite optimize` confirms the dep fix):
- **Full page reload on first Generate** (closed the modal): Vite discovered `onnxruntime-web` (imported
  lazily in the worker) at runtime and did a "new dependencies optimized" full reload. Fix:
  `optimizeDeps.include: ['onnxruntime-web']` in vite.config.ts so it's pre-bundled at server start.
- **`Failed to load url /vendor/sentencepiece.js` + Vite red overlay** (looked like an app crash; was
  actually the graceful modal error under the HMR overlay): Vite dev refuses a dynamic `import()` of a
  `/public` file even with `@vite-ignore`. Fix: `loadTokenizer` now fetches sentencepiece.js as TEXT
  and imports it via a **Blob URL** (opaque to Vite, same-origin under COEP; the module's wasm is
  embedded so blob `import.meta.url` is fine). Files: `vite.config.ts`, `src/lib/tts.worker.ts`.
- REQUIRES a dev-server restart to pick up the vite.config change.

[2026-08-02] Made it Cloudflare-Pages-deployable (the self-host-in-/public approach can't ship: Pages
rejects any file >25MiB, and flow_lm_main is ~73MiB, voices.bin ~50MiB). Decision: weights load from
HuggingFace at RUNTIME in prod; only the small vendor runtime ships with the app. Verified HF sends
CORS headers (ACAO on the 302 + the CDN 200), so the cross-origin fetch passes our COEP. Full
`npm run build` passes (exit 0); dist has _headers + /vendor + HF URL baked into the worker.
- `tts.worker.ts` MODEL_BASE now env-aware: `VITE_TTS_MODEL_BASE` override → else local `/models/...`
  in dev, HF Space URL in prod (`import.meta.env.DEV`). ORT wasm + sentencepiece stay same-origin
  (`/vendor/`). `src/vite-env.d.ts` added for the env var type.
- Split scripts: `setup-tts-vendor.mjs` (ort wasm + sentencepiece → public/vendor; all <25MiB; runs at
  build) + `fetch-tts-model.mjs` (weights → public/models for LOCAL dev; reuses setupVendor).
- `build` = `node scripts/setup-tts-vendor.mjs && tsc -b && vite build` → a fresh CF clone self-heals
  vendor at build; weights never enter the deploy.
- `public/_headers` (committed): COOP `same-origin` + COEP `require-corp` on `/*` (prod parity with
  vite.config dev headers; needed for SharedArrayBuffer → ORT threads), immutable cache on `/vendor/*`.
- Cloudflare Pages settings for the user: build cmd `npm run build`, output dir `dist`, set
  NODE_VERSION ≥ 18 (fetch global). Committing the repo now yields a working deploy (public/models +
  public/vendor stay gitignored; public/_headers + scripts are committed).
- Caveats: (1) depends on KevinAHM's HF Space staying up — mirror to your own HF repo and set
  VITE_TTS_MODEL_BASE for stability (config-only change). (2) Build fetches sentencepiece.js from HF —
  needs network at build; commit it instead if that's a problem. (3) Vite emits an unused hashed copy
  of the 11MB ort wasm in dist/assets (wasmPaths overrides it to /vendor/) — harmless, <25MiB.

[2026-08-02] Prod weights hosting: chose Cloudflare R2 (over HF-at-runtime and git LFS). Git LFS was
ruled out - the 25MiB Pages limit is on SERVED assets, not git storage, so LFS-tracked weights still
get rejected at deploy; the only "LFS overcomes 25MiB" path is a runtime proxy Worker to the LFS
server (same shape as R2/HF but with GitHub LFS's metered 1GB/mo egress). R2 has ZERO egress fees
(unlike S3) + free tier covers our 156MB storage & read ops → ~$0, no Worker needed (public bucket +
custom domain serves the browser directly). Setup (no code change - worker already reads
VITE_TTS_MODEL_BASE): create bucket, upload the 7 fetched files under key `pocket-tts/english_2026-04/`
(bundle.json, tokenizer.model, voices.bin, text_conditioner/flow_lm_flow/flow_lm_main/mimi_decoder
_int8.onnx), custom domain, CORS policy (GET/HEAD + AllowedOrigins) for our COEP, set
`VITE_TTS_MODEL_BASE=https://<domain>/pocket-tts/english_2026-04` in Pages PRODUCTION env (VITE_ vars
inline at BUILD time → must be in the Pages build env + redeploy). HF Space remains the default
fallback when the var is unset. Awaiting user to perform the R2 setup.

[2026-08-03] Deploy #1 (tts #16, master c2bddce) shipped but was pulling weights from HUGGINGFACE, not
R2 — DevTools showed onnx requests to huggingface.co, and the deployed worker chunk was byte-identical
to the HF-baked build. Root cause: Cloudflare Pages did NOT expose the `VITE_TTS_MODEL_BASE` dashboard
var to the Vite build (import.meta.env.DEV baked fine → hit the else branch → HF default; the var came
through undefined). Fix: hardcoded the PROD default in `tts.worker.ts` to the R2 root
`https://gerty-models.tomg.cool` (files are at the bucket ROOT — no path suffix), env var kept as an
optional override. Proven locally: fresh `npm run build` → new worker chunk bakes only the R2 URL, HF
string gone. Needs commit → PR → master → redeploy, then re-verify the baked URL + DevTools Network.
The CF `VITE_TTS_MODEL_BASE` var is now inert (can be removed).

[2026-08-03] Prod-only HANG at "67%" fixed (worked in dev, deadlocked on Cloudflare). Root cause:
onnxruntime-web multi-threading. With numThreads>1, ort spawns Emscripten pthread workers by
RE-LOADING this bundled worker chunk; our top-level `ctx.onmessage` then clobbers the handler the
pthread runtime installs → pthreads never report ready → main thread deadlocks inside
`InferenceSession.create` (Network confirmed: all model files 200, ort wasm loaded, ~8 repeated
tts.worker chunk loads = the pthreads, and NO tokenizer/voices fetch = frozen mid-compile, no error).
Dev escaped it because ort is a separate optimized-dep module there, so its pthreads load ort's own
glue, not our chunk. Fix: `ort.env.wasm.numThreads = 1` (single-threaded SIMD; reliable everywhere,
pocket-tts int8 stays usable). Trade-off: slower than the threaded local run (~1.5x RTFx) — revisit
via a dedicated ort worker if speed matters. Also improved progress UX: added a `prepare` phase so the
modal shows "Preparing voice model…" during the (now longer, single-threaded) compile instead of a
frozen "67%". Files: `src/lib/tts.worker.ts`, `src/lib/tts.ts`, `src/components/TtsModal.tsx`. Build
verified: numThreads=1 + R2 URL both baked. Needs commit → PR → deploy → retest.
- Side note (user asked): weights re-download on each page refresh because the R2 objects have no
  strong browser-cache headers (Cf-Cache-Status DYNAMIC). Expected for now; fix later by setting
  Cache-Control: immutable on the R2 objects (or a CF cache rule). Not blocking.

[2026-08-03] ✅ LIVE IN PRODUCTION AND WORKING. Deployed on Cloudflare Pages (gerty.tomg.cool),
weights served from our own Cloudflare R2 (gerty-models.tomg.cool, verified in DevTools Network),
single-threaded ort, end-to-end generate → preview → add-to-timeline confirmed by the user. Core
spec 32 is done. Remaining items are the backlog below (not blockers).

[2026-08-03] Restored multi-threading (undid the numThreads=1 workaround) by fixing the ROOT cause of
the pthread deadlock: static `import * as ort from 'onnxruntime-web'` bundled ort into the tts.worker
chunk, so ort's Emscripten pthread workers re-loaded THAT chunk (with our `onmessage`) and clobbered
the pthread runtime's handler. Fix = load ort via a DYNAMIC `await import('onnxruntime-web')`, which
makes Rollup code-split ort into its own chunk. Build proves the split: tts.worker chunk dropped
474KB → 9.4KB with ZERO ort internals; ort now lives in `ort.bundle.min-*.js` (463KB). pthreads
re-load the ort-only chunk → no clobber → threads init. `numThreads` back to
`crossOriginIsolated ? min(hardwareConcurrency,8) : 1`. Kept a type-only `import type * as Ort` for the
`Ort.Tensor`/`Ort.InferenceSession` annotations; runtime `ort` is the dynamically-loaded module. tsc +
eslint + build green; R2 URL still baked. NEEDS prod verification: after deploy, generate on
gerty.tomg.cool and confirm (a) it still works (no 67% hang) and (b) it's faster than the single-thread
build (check DevTools has the ort pthread workers loading `ort.bundle.min-*.js`, NOT tts.worker). If it
regresses/hangs, revert this commit to fall back to the reliable numThreads=1.

## Follow-up improvements (backlog for later specs)

Ordered roughly by value. None blocks the shipped feature.

### Performance
- **Cache weights across page refreshes.** Right now every reload re-fetches ~156MB (R2 objects have no
  strong browser-cache headers → Cf-Cache-Status DYNAMIC; in-memory ort sessions only live for the page
  session). Fix: set `Cache-Control: public, max-age=31536000, immutable` on the R2 objects (object
  metadata or a Cloudflare cache rule). For true persistence even across cache eviction, have the worker
  stash the fetched model blobs in Cache Storage / IndexedDB and read them back first.
- ~~Restore multi-threading for faster synthesis.~~ DONE 2026-08-03 (pending prod verification) —
  changed `import * as ort` to a DYNAMIC `await import('onnxruntime-web')` so Vite code-splits ort into
  its own chunk (`ort.bundle.min-*.js`, 463KB) instead of bundling it into the tts.worker chunk (now
  9.4KB). ort's pthread workers now re-load the ort-only chunk, not ours, so nothing clobbers the
  pthread handler. `numThreads` restored to `crossOriginIsolated ? min(cores,8) : 1`. Verified in the
  build (worker chunk has zero ort internals). See the 2026-08-03 threading log below.

### Resilience / hosting
- **Remove the build-time dependency on KevinAHM's HF Space.** `setup-tts-vendor.mjs` fetches
  `sentencepiece.js` from that Space at every build, and `fetch-tts-model.mjs` pulls the weights from
  it for local dev. If that Space disappears, builds + fresh dev setup break. Fix: commit
  `sentencepiece.js` (4MB, it's app code) and mirror the weights to our own R2 (point fetch-tts-model
  at R2). Then we depend on nothing external.
- **CORS allowlist is `gerty.tomg.cool` only** → TTS is CORS-blocked on `videoeditor-c2h.pages.dev`
  and on preview deploys. Add those origins to the R2 CORS policy if TTS should work there.
- **Model versioning / cache-busting.** Weights sit at the R2 bucket ROOT (no version prefix, because
  we stripped the path when the files were uploaded to root). A future model update couldn't cache-bust
  cleanly. Re-upload under a versioned prefix (e.g. `english_2026-04/`) and set MODEL_BASE to match.

### UX
- **Refine voice labels.** Currently bare character names (Alba, Azelma, Cosette, Eponine, Fantine,
  Javert, Jean, Marius) under one "English" group. Now that they're audible, group by gender/accent and
  give friendlier labels. (Roster in `src/lib/tts.ts` `TTS_VOICES`.)
- **Download progress jumps** (4 parallel fetches map to 17/33/50/67%). Make it monotonic/byte-based.
- **Cancellable generation** — no way to abort a long synth mid-flight today.

### Features
- **More languages.** pocket-tts also has German / Italian / Portuguese / Spanish bundles (same shape);
  add a language selector (each is another ~156MB download).
- **Custom voice cloning.** We skip `mimi_encoder` (curated voices only). Wire the encoder + an audio
  upload to enable cloning from a reference clip.
- **Speed control.** Removed (pocket-tts has no native speed knob). Could add pitch-preserving
  time-stretch, or expose via the clip's timeline rate.

### Cleanup
- **Verify TTS narration in an EXPORTED mp4 on prod.** It's an ordinary audio clip so it should just
  work (and did in local reasoning), but it hasn't been explicitly re-verified after the R2 deploy.
- **Stray unused ort wasm in `dist/assets`** (~11MB) — Vite emits a hashed copy from ort's import graph
  even though `wasmPaths` overrides it to `/vendor/ort/`. Harmless (<25MiB) but wasteful; suppress if
  worth it.
- **`VITE_TTS_MODEL_BASE` is inert on Cloudflare** (Pages doesn't expose it to the Vite build; R2 URL is
  hardcoded as the prod default). Remove the env var from the Pages dashboard or document that it's a
  no-op there.

# 30 — Quality-based export encoding (QP / "CRF" mode)

## Overview

Export currently targets an **absolute average bitrate** derived from pixel count alone:

```
bitrate = width × height × fps × bpp        // exportSettings.ts:128-135
```

Nothing in that formula knows what the content *is*. A screen recording — mostly static pixels, near-empty P-frames — is charged exactly the same as live-action footage. The encoder is configured with `bitrate` only ([ffmpegExport.ts:606-612](src/lib/ffmpegExport.ts#L606-L612)), which puts it in average-bitrate mode: it does not come in under budget on easy content, it lowers the quantizer until it spends the money.

**The bug this causes (the motivating repro):** a 57 MB, 11-minute, 1080×716 screen recording (≈0.69 Mbps, encoded by its recorder in quality mode) imported and immediately re-exported:

| | output pixels | target bitrate | estimate |
|---|---|---|---|
| source file | 1080×716 | 0.69 Mbps *(measured)* | 57 MB |
| export @ "1080p" / Social | 1920×1080 | 6.22 Mbps | **513 MB** |
| export @ "480p" / Social | 854×480 | 1.23 Mbps + audio | **112 MB** |

Even at **one sixth the pixels** the app asks for nearly **double** the source's bitrate. The content is never consulted.

This spec replaces bitrate targeting with **quantizer (QP) targeting** — the WebCodecs equivalent of x264's CRF — so easy content costs few bits and hard content costs many, which is what every other encoder in the world does and what users already believe the "Compression" chips mean.

**Scope note:** the same repro also exposes a *second*, independent bug — the project canvas is 1920×1080 while the source is 1080×716, so "1080p" export upscales by 2.7× in area. That is **out of scope here** (see §D3 and Related Systems).

## Requirements

### A. Encoding core

- **A1.** When the browser supports it, the WebCodecs export paths configure the encoder with `bitrateMode: 'quantizer'` and **omit `bitrate`**, then pass a per-frame quantizer via `encode(frame, { keyFrame, avc: { quantizer } })`.
- **A2.** Each existing `CompressionPreset` maps to an H.264 QP (0–51, lower = better) instead of / in addition to its `bpp`. Proposed mapping, mirroring x264 CRF convention:

  | preset | label | QP | bpp (retained, see A5) |
  |---|---|---|---|
  | `studio` | Studio | 18 | 0.20 |
  | `social` | Social Media | 23 | 0.10 |
  | `web` | Web | 28 | 0.05 |
  | `web-low` | Web (Low) | 33 | 0.025 |

- **A3.** **Keyframes get a lower QP than inter frames.** Constant-QP is not CRF and has no built-in I:P ratio, so keyframes must be biased manually — `quantizer = clamp(isKeyFrame ? qp - 3 : qp, 0, 51)`. The frame loops already compute `isKeyFrame` ([ffmpegExport.ts:388](src/lib/ffmpegExport.ts#L388), [exportWorker.ts:197](src/lib/exportWorker.ts#L197)), so this is a one-line change at each call site.
- **A4.** **Support probe.** Quantizer mode must be probed via `VideoEncoder.isConfigSupported({ ..., bitrateMode: 'quantizer' })` inside the codec ladder. If no codec supports it, fall back cleanly to today's ABR config for the same preset.
- **A5.** **The `bpp` table is retained, not deleted** — it is the fallback ladder for A4 and the only knob the MediaRecorder path has (§A6). Nothing about today's behaviour is removed; it becomes the second tier.
- **A6.** **MediaRecorder fallback is unchanged.** `MediaRecorder` exposes only `videoBitsPerSecond` ([ffmpegExport.ts:748-751](src/lib/ffmpegExport.ts#L748-L751)) — there is no quantizer concept. It keeps the bpp math. This means Firefox output size will differ from Chromium output size for the same settings; that divergence must be documented, not hidden.
- **A7.** All three encode paths must agree on the resolved config. `findSupportedVideoCodec` is currently **duplicated** in [ffmpegExport.ts:590](src/lib/ffmpegExport.ts#L590) and [exportWorker.ts:333](src/lib/exportWorker.ts#L333); the quantizer-aware version should be written **once** in a shared DOM-free module (`exportSettings.ts` already declares itself pure/DOM-free and is imported by both) rather than forked a third time.

### B. Presenting it to the user

- **B1. The Compression chips do not change.** They are already framed as quality ("Compression is almost impossible to notice"), not as bitrate. Studio / Social Media / Web / Web (Low) keep their labels, order, default, and blurbs. **No new control is added for the quality knob** — only its meaning becomes true.
- **B2. The static "Estimated size" row is removed.** Under QP there is no bitrate to multiply by duration; `estimateExportBytes` cannot be computed ahead of time without encoding. Keeping a number that is now structurally a fiction is worse than showing none.
- **B3. It is replaced by a one-line expectation-setter** in the Compression block, e.g.:
  > Final size depends on what's in the video — screen recordings and simple animation come out far smaller than live-action footage.
- **B4. A live, measured size readout during export.** The progress UI gains an actual byte count and a projection, sourced from the encoded chunks the pipeline already accumulates (`videoChunks[].data.byteLength`):
  > `Encoding… 34% · 61 MB so far, projecting ≈ 180 MB`

  This is strictly **better** than the estimate it replaces — it is a measurement, not a guess, and it would have surfaced the motivating bug faster and more honestly. It requires widening the progress callback from `(pct: number)` to carry bytes, through both the main-thread path and the worker `progress` message.
- **B5. (Recommended, phase 2) "Target size" advanced mode.** ABR has exactly one genuine virtue — **predictable output size** — and real users need it (Discord 10/25 MB, email caps, upload limits). Rather than delete that capability, expose it honestly behind a disclosure in the modal:

  ```
  Quality      [Studio] [Social Media] [Web] [Web (Low)]
               Final size depends on what's in the video…

               ▸ Need a specific file size?
  ```

  Expanded, this swaps the quality chips for a size input and back-computes the bitrate (`bitrate = target_bytes × 8 / duration − audio`), reusing the existing ABR path verbatim. `ExportSettings` becomes a discriminated union (§Technical Considerations). This is a **better** product than today's compression chips for that use case, because the user states the constraint they actually have.

### C. Safety and limits — the real risk of this change

- **C1. Output size becomes unbounded.** Today `bpp` caps the encode. Under QP, `videoChunks` ([ffmpegExport.ts:305](src/lib/ffmpegExport.ts#L305), [exportWorker.ts:140](src/lib/exportWorker.ts#L140)) holds the **entire encoded stream in RAM** as `Uint8Array`s before muxing, and `mp4-muxer`'s `ArrayBufferTarget` then materialises a **second full copy**. An 11-minute Studio-QP export of complex live-action footage could plausibly exceed 1 GB × 2 and OOM the tab. This is the most serious consequence of the change and must be handled, not discovered.
- **C2.** Implement at minimum a **running byte guard**: if accumulated encoded bytes cross a threshold (proposal: warn at 1 GB, hard-stop with a clear error at 2 GB), surface it in the UI rather than crashing. The live counter from B4 makes this nearly free.
- **C3. Noisy effects become expensive.** Spec 23's `grain` and `oldfilm` inject per-pixel noise, which is close to incompressible. Under ABR that noise merely stole quality from the rest of the frame; under QP it **multiplies file size**. Behaviour change worth flagging (see Open Questions Q4).
- **C4.** Cancel, progress monotonicity, and the existing tier fallbacks (worker → main thread → MediaRecorder) must survive unchanged.

### D. Non-goals

- **D1.** No change to `renderFrame`, camera, effects, audio mixing, or the muxer.
- **D2.** No change to resolution options, fps, or the audio bitrate (128 kbps AAC).
- **D3.** **Not fixing the canvas/source dimension mismatch.** Importing a 1080×716 video into a 1920×1080 project and exporting "1080p" still upscales. Separate spec.
- **D4.** No format changes (MP4/WebM/GIF) — that's spec 27.

## Technical Considerations

### Types already exist — no shims needed ✅

Verified against the installed toolchain (TypeScript `~5.9.3`, `lib: ["ES2022","DOM","DOM.Iterable"]`). `lib.dom.d.ts` already ships everything required:

```ts
// lib.dom.d.ts:39418
type VideoEncoderBitrateMode = "constant" | "quantizer" | "variable";

// lib.dom.d.ts:2416-2423
interface VideoEncoderEncodeOptions {
    avc?: VideoEncoderEncodeOptionsForAvc;
    keyFrame?: boolean;
}
interface VideoEncoderEncodeOptionsForAvc {
    quantizer?: number | null;
}
```

⚠️ One thing to confirm on first compile: `@types/dom-webcodecs` (a transitive dep of `mp4-muxer`) declares its own global `VideoEncoderEncodeOptions` with **only** `keyFrame`. Global interfaces *merge*, so the union should still expose `avc` — but `tsconfig.app.json` sets `"types": ["vite/client"]`, so whether that package is in scope at all depends on `mp4-muxer`'s triple-slash references. Confirm with `npx tsc -b` immediately after the first `avc: { quantizer }` call site; if it fails, a local interface augmentation is the fix, not a cast.

### Current types to change

`exportSettings.ts`:

```ts
export type CompressionPreset = 'studio' | 'social' | 'web' | 'web-low'

type CompressionSpec = {
  id: CompressionPreset
  label: string
  bpp: number        // retained — ABR fallback + MediaRecorder
  qp: number         // NEW — H.264 quantizer, 0–51
  blurb: string
}

export type ExportSettings = {
  shortEdge: number
  compression: CompressionPreset
}
```

`EncodeConfig` — [exportWorkerTypes.ts:12-16](src/lib/exportWorkerTypes.ts#L12-L16), structured-cloned to the worker:

```ts
// today
export type EncodeConfig = { width: number; height: number; videoBitrate: number }

// proposed — a discriminated union so a path can never read the wrong knob
export type EncodeConfig = {
  width: number
  height: number
} & (
  | { mode: 'quantizer'; qp: number; videoBitrate: number }  // bitrate kept for the A4/A6 fallbacks
  | { mode: 'bitrate';   videoBitrate: number }
)
```

Keeping `videoBitrate` populated in both variants is deliberate: the MediaRecorder path (§A6) and the A4 fallback need it regardless of which mode was chosen, and it stays structured-clone-safe.

If **B5** ships, `ExportSettings` becomes:

```ts
export type ExportSettings = {
  shortEdge: number
} & (
  | { mode: 'quality'; compression: CompressionPreset }
  | { mode: 'size';    targetBytes: number }
)
```

Progress callback (B4), affecting `exportVideo`, `useFFmpegExport`, and `ExportWorkerResponse`:

```ts
export type ExportProgress = { pct: number; encodedBytes: number }
// ExportWorkerResponse: { type: 'progress'; pct: number }  →  + encodedBytes
```

### Constant QP is not CRF

Worth being precise, because the spec title invites the confusion. `bitrateMode: 'quantizer'` gives **constant QP**, not x264's rate-factor CRF. CRF additionally applies psychovisual adaptation across frame types and motion; constant QP does not. For this feature's goal — *bits spent should follow content complexity* — constant QP is entirely sufficient, and A3's keyframe bias recovers the most important piece of what CRF does for free.

### Browser support

- **Chromium**: `bitrateMode: 'quantizer'` with per-frame `avc.quantizer` — supported.
- **Safari**: WebCodecs `VideoEncoder` exists (16.4+), quantizer-mode support **unverified**. A4's probe handles it.
- **Firefox**: no `VideoEncoder` at all → already on MediaRecorder → §A6, unaffected.

Residual risk: `isConfigSupported` could report `supported: true` while the per-frame quantizer is silently ignored, in which case output reverts to whatever default rate control the encoder picks. The B4 live byte counter makes such an anomaly immediately visible rather than silent — which is a further argument for shipping B4 alongside A, not after.

## Related Systems and Tasks

- **[SPECS/27-expand-export-options.md](SPECS/27-expand-export-options.md)** — format selection (WebM/GIF). Both specs thread new fields through `ExportSettings → resolveEncodeConfig → EncodeConfig → worker`. **Coordinate:** if 27 lands first, VP9/Opus need their own quantizer option key (`vp9: { quantizer }`), and `EncodeConfig` should be extended once, not twice. If GIF ships, neither bitrate nor QP applies to it at all.
- **[SPECS/09-in-video-perf.md](SPECS/09-in-video-perf.md)** — the export worker. C1's memory ceiling is a worker-pipeline concern too; both `videoChunks` accumulators need the guard.
- **[SPECS/23-more-effects.md](SPECS/23-more-effects.md)** / **[SPECS/25-webgl-effects.md](SPECS/25-webgl-effects.md)** — grain/old-film noise vs. compressibility (C3).
- **Canvas-size mismatch (no spec yet)** — nothing in the import path sets project dimensions from an imported video; `useProject` seeds from the `canvasSizePref` localStorage value, defaulting to 1920×1080 ([useProject.ts:352](src/hooks/useProject.ts#L352)). `resolutionOptions` therefore reads the *canvas*, not the asset, and happily offers "1080p" for 716px-tall source. Worth its own spec (D3).
- **CLAUDE.md** — `ffmpegExport.ts` is misnamed; it is the WebCodecs + `mp4-muxer` path, not ffmpeg.wasm.

## Open Questions

1. **Does B5 ("Target size" mode) ship in this spec or as a follow-up?** Shipping A+B1–B4 alone *removes* a capability users currently have (a predictable size number) without replacing it. B5 restores it in a better form. → **Recommend: A + B1–B4 as the core; B5 in the same spec if appetite allows, otherwise immediately after.**
2. **Are the proposed QP values (18/23/28/33) right?** They follow x264 CRF convention but need one real-world A/B against the motivating 11-minute screen recording plus one live-action clip. Studio at QP 18 on live-action is where the C1 memory risk actually bites — is Studio 18 or 20?
3. **What are the C2 thresholds**, and is the hard stop an error or a "keep going?" prompt? An aborted 11-minute export at 90% is a miserable outcome; a warning at 1 GB with the option to continue may be better than a hard stop.
4. **C3 — should noisy effects clamp QP?** Options: (a) do nothing, let grain cost what it costs; (b) clamp QP to a floor when a grain/old-film effect is active; (c) warn in the modal when the project contains one. → **Lean (a) + (c)**: silently overriding the user's chosen quality is worse than telling them.
5. **Should the live projection (B4) be shown for the MediaRecorder path**, where output size *is* predictable? Probably yes for consistency — a measurement is never wrong.
6. **Does removing the pre-export estimate need a migration note** anywhere (README mentions the estimate)? Minor, but check.

## Acceptance Criteria

- **AC1. (The motivating repro.)** Import the 57 MB / 11-min / 1080×716 screen recording, export at native resolution / **Social Media** with no edits. Output lands in the **same order of magnitude as the source** — target ≤ ~2× (≈120 MB), versus 513 MB today — with no visible quality loss versus the source.
- **AC2.** The same project at **Web (Low)** produces a materially smaller file than at **Studio**, and **Studio** is visually indistinguishable from the source. The presets remain monotonic in both size and quality.
- **AC3.** A live-action / high-motion clip still produces a *large* file at Studio — i.e. the change is genuinely content-adaptive, not a blanket size reduction. (This is the control case; without it AC1 could be satisfied by simply lowering all the bitrates.)
- **AC4.** On a browser without quantizer support, export still completes via the ABR fallback with today's sizes, and no error is shown.
- **AC5.** Firefox (MediaRecorder path) still exports successfully.
- **AC6.** Worker path, main-thread path, and cancel all behave as before; progress remains monotonic and reaches 100%.
- **AC7.** The Export modal shows no fabricated pre-encode size figure, and during export shows an accurate running byte count whose final value matches the downloaded file's actual size.
- **AC8.** A deliberately oversized export (Studio, long, complex) either completes or fails with a clear message — it does not crash the tab (C1/C2).
- **AC9.** `npx tsc -b` stays green. Verify per [.claude/skills/verify/SKILL.md](.claude/skills/verify/SKILL.md) — static checks by Claude, browser click-list for the user; no dev server run by Claude.

## Implementation Notes

Suggested order — each step is independently verifiable:

1. **`exportSettings.ts`** — add `qp` to `CompressionSpec`, add `qpFor(preset)`, widen `EncodeConfig` to the discriminated union, and move a quantizer-aware `findSupportedVideoCodec` here (it is already pure/DOM-free by design, and both `ffmpegExport.ts` and the module worker can import it). Delete the two duplicated copies (A7).
2. **`ffmpegExport.ts`** — consume the shared probe; in quantizer mode omit `bitrate` from the config and pass `{ keyFrame, avc: { quantizer } }` at [line 389](src/lib/ffmpegExport.ts#L389) with the A3 keyframe bias. Leave `exportWithMediaRecorder` alone.
3. **`exportWorker.ts`** — mirror step 2 at [line 198](src/lib/exportWorker.ts#L198). Keep the two loops structurally identical; they are already near-copies and drifting them further is the main maintenance hazard here.
4. **Progress plumbing (B4)** — accumulate `chunk.byteLength` where chunks are pushed (both `output` callbacks already receive them), widen the progress payload, thread through `ExportWorkerResponse` → `exportVideo` → `useFFmpegExport` → `ExportModal`. Add the C2 guard in the same place, since it reads the same counter.
5. **`ExportModal.tsx`** — remove the estimate row and the `estimateExportBytes` import, add the B3 blurb line, render the live counter in the existing progress block. Keep `totalDurationOf` (still used for the Duration fact tile).
6. **`estimateExportBytes`** — retain the function only if B5 ships (it back-computes the size↔bitrate relation); otherwise delete it with its only caller.

Do **not** attempt to keep a pre-encode size estimate alive by re-deriving it from QP. There is no closed-form mapping from quantizer to bitrate — that is the entire point of the change, and any number produced that way would be exactly the kind of confident fiction this spec exists to remove.

---
*Ready for implementation once Open Questions 1–3 are decided. Use `/task 30` to begin development.*

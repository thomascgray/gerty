# 30 — Efficient export encoding (source-anchored ABR, with a QP phase-2)

> **Status (2026-08-02):** unimplemented, and re-scoped. The original draft of this
> spec made **quantizer/QP targeting** the core change. After review the direction
> flipped: **Phase 1 is a low-risk "smarter ABR" fix** that keeps average-bitrate
> mode (and therefore keeps the size estimate exact), and simply stops asking for a
> target wildly larger than the content justifies. **QP is preserved as Phase 2**
> (§E) — genuinely more efficient, but higher risk (unbounded memory, browser-support
> surface, and it *destroys* the pre-export estimate the user explicitly wants to keep).
>
> Two user goals drive the re-scope: **(1) export as efficiently as possible**, and
> **(2) the estimated MB should be closer — "even if it's not perfect, closer is
> better."** These pull apart slightly: QP maximizes (1) but makes (2) structurally
> impossible; ABR keeps (2) exact but can't undershoot on easy content the way QP can.
> Phase 1 captures most of (1) and all of (2); Phase 2 chases the rest of (1) later.

## Overview

Export targets an **absolute average bitrate** derived from pixel count alone:

```
bitrate = width × height × fps × bpp        // exportSettings.ts:127-135
```

Nothing in that formula knows what the content *is*. A screen recording — mostly
static pixels, near-empty P-frames — is charged exactly the same per pixel as
live-action footage. Worse, the target ignores the **source we already imported**:
we know a re-exported clip's own bitrate (from its asset `size` ÷ `duration`), yet we
happily ask the encoder for many times that.

**The motivating repro:** a 57 MB, 11-minute, 1080×716 screen recording
(≈0.69 Mbps, encoded by its recorder in quality mode) imported and immediately
re-exported:

| | output pixels | target bitrate | estimate |
|---|---|---|---|
| source file | 1080×716 | 0.69 Mbps *(measured)* | 57 MB |
| export @ "1080p" / Social | 1920×1080 | 6.22 Mbps | **513 MB** |
| export @ "480p" / Social | 854×480 | 1.23 Mbps + audio | **112 MB** |

Even at **one sixth the pixels** the app asks for nearly **double** the source's
bitrate, and the "Estimated size" row faithfully reports that absurd number — so the
estimate isn't lying, the *target* is wrong, and the estimate is only as sane as the
target it multiplies.

**Phase 1 (this spec's core)** replaces the content-blind target with a
**source-anchored ABR target**: cap the requested bitrate at roughly what the richest
imported video source actually carried (modulated per compression preset), and keep
today's `bpp` formula only as the ceiling / no-source fallback. Because we stay in
average-bitrate mode, `estimateExportBytes` still multiplies a real target by duration
— so the estimate stays **exact in form and finally sane in value**. This is the whole
"closer estimate" win, achieved by fixing the target rather than by inventing a fuzzier
estimator.

**Phase 2 (§E, deferred)** is the original QP design: per-frame quantizer targeting for
true content-adaptive efficiency, at the cost of the pre-export estimate. Kept in full
so the analysis isn't lost, but explicitly out of scope for the first landing.

**Scope notes:**
- The same repro also exposes a *second*, independent bug — the project canvas is
  1920×1080 while the source is 1080×716, so "1080p" export upscales by 2.7× in area.
  Still **out of scope** (see §D2). Phase 1 mitigates its *size* fallout for free
  (the source-anchored cap doesn't grant more bits just because we upscaled), but does
  not fix the upscale itself.
- The **per-object Download** re-encode ([objectDownload.ts](src/lib/objectDownload.ts))
  has the *same* content-blind bitrate bug (hardcoded `0.1` bpp,
  [objectDownload.ts:407-409](src/lib/objectDownload.ts#L407-L409)) and a **third copy**
  of `findSupportedVideoCodec`. Per the scoping decision it is **out of scope** here
  (§D3), but it is the obvious next consumer of the same helper.

## Requirements

### A. Source-anchored ABR target (Phase 1 core)

- **A1. Derive a source bitrate for the project.** From the video assets actually used
  by non-hidden `video` objects, compute each asset's own bitrate as
  `assetBitrate = size × 8 / duration` (bytes → bits, using `AssetMeta.size` and
  `AssetMeta.duration`; skip assets with no/zero `duration`). The project's
  `sourceBitrate` is the **max** across those assets (the richest input is the one we
  must not starve). Projects with no usable video source → `sourceBitrate = 0`.
  - Rationale for **max** (not sum or average): clips play sequentially in time, and
    we're picking a single per-second target. The busiest source sets the bar; anything
    lower re-encodes comfortably under it.
  - `assetBitrate` includes the source's audio track — acceptable slop for a "closer,
    not perfect" target. Documented, not corrected (see Open Questions Q3).

- **A2. Cap the target at a preset-scaled multiple of the source bitrate.** When
  `sourceBitrate > 0`:

  ```
  videoBitrate = min( bppTarget , sourceBitrate × headroom(preset) )
  ```

  where `bppTarget = width × height × fps × bpp(preset)` (today's formula, unchanged)
  and `headroom(preset)` is a small per-preset factor. Proposed:

  | preset | label | bpp (retained) | headroom |
  |---|---|---|---|
  | `studio` | Studio | 0.20 | 1.5 |
  | `social` | Social Media | 0.10 | 1.0 |
  | `web` | Web | 0.05 | 0.7 |
  | `web-low` | Web (Low) | 0.025 | 0.5 |

  So Studio keeps headroom above the source (room for the composited annotations/effects
  that the source never had), Social ≈ matches the source, and the Web tiers deliberately
  come in **under** it. The `min(...)` means the cap only ever *lowers* the target — a
  genuinely demanding output (small source, huge canvas, heavy motion graphics) still
  gets the full `bppTarget`.
  - **No resolution-scaling term is needed.** The source bitrate already encodes the
    source's own resolution, and re-encoding cannot manufacture detail the source lacked;
    capping near source bitrate is therefore correct whether we output smaller *or*
    larger than the source. (This is why the missing source-dimension metadata, §Technical
    Considerations, doesn't matter.)

- **A3. No-source fallback is exactly today's behaviour.** When `sourceBitrate = 0`
  (pure annotation / text / shapes / photo projects, or audio-only), fall back to the
  unmodified `bppTarget`. **Nothing about today's output changes for those projects.**
  (These projects *also* over-charge — vector/text content compresses to almost nothing —
  but there is no source to anchor to; a lower default bpp for the no-source case is left
  to Open Questions Q4, not assumed here.)

- **A4. Bitrate mode is `'variable'` (decided).** Today the code sets `bitrate` and leaves
  `bitrateMode` at the browser default. Phase 1 sets it explicitly to **`'variable'`**
  (VBR) in the encoder config so easy content is *allowed* to undershoot the (now sane)
  target — this is where the remaining efficiency comes from (a mostly-static screen
  recording spends less on its easy seconds). Consequence for the estimate: the output
  lands **at or below** the estimate, never above, so the estimate is worded as a
  trustworthy **upper bound** ("up to ~X"), not a bullseye. CBR (`'constant'`) was
  considered and rejected: it would make the estimate exact but pad the easy footage,
  costing the efficiency that is half the point of this spec.

- **A5. The estimate is kept, not removed.** `estimateExportBytes` continues to compute
  `(videoBitrate + audioBitrate) × duration / 8`, now over the source-anchored
  `videoBitrate`. No new estimator, no heuristic fudge — the existing exact-form estimate
  simply stops being multiplied by an absurd target. The ExportModal "Estimated size" row
  **stays**, reworded to an upper bound ("up to ~X" / "≈") since A4's VBR mode lets the
  real file come in under it.

- **A6. One target policy, used by every ABR consumer in scope.** The new logic lives in
  `exportSettings.ts` (already pure / DOM-free, already imported by both the main-thread
  export and the module worker). `resolveEncodeConfig`, `videoBitrateFor`, and
  `estimateExportBytes` must all resolve the **same** source-anchored number, so the
  estimate and the encode can never disagree. This needs the `Project` in scope where the
  bitrate is computed (it already is — `resolveEncodeConfig(project, settings)`).

### B. Encoding paths

- **B1. Both WebCodecs paths pass the source-anchored bitrate + explicit mode.** The
  main-thread ([ffmpegExport.ts:302](src/lib/ffmpegExport.ts#L302)) and worker
  ([exportWorker.ts:137](src/lib/exportWorker.ts#L137)) encoder configs already receive
  `videoBitrate` via `EncodeConfig`; they additionally set `bitrateMode` per A4. The
  per-frame keyframe cadence and the `encode(frame, { keyFrame })` call sites are
  **unchanged** (no `avc.quantizer` in Phase 1).
- **B2. MediaRecorder fallback** ([ffmpegExport.ts:748-751](src/lib/ffmpegExport.ts#L748-L751))
  passes the same source-anchored `videoBitrate` as `videoBitsPerSecond`. It already only
  had this one knob; it simply gets the better number. No behavioural split to document
  (unlike the QP phase, where Firefox would have diverged).
- **B3. `findSupportedVideoCodec` may set `bitrateMode`.** It is duplicated in
  [ffmpegExport.ts:590](src/lib/ffmpegExport.ts#L590) and
  [exportWorker.ts:333](src/lib/exportWorker.ts#L333) (and a third time in
  [objectDownload.ts:412](src/lib/objectDownload.ts#L412), out of scope §D3). Phase 1 does
  **not** require the dedup — passing `bitrateMode` through the existing signature is a
  smaller change. Consolidating the two in-scope copies into `exportSettings.ts` is
  **recommended but optional** here, and becomes load-bearing in Phase 2. If touched,
  move it to the shared module rather than forking a fourth copy.

### C. Behaviour to preserve

- **C1. The Compression chips do not change** — labels, order, default (`social`), blurbs.
  Their meaning becomes *truer*: the preset now genuinely trades source-fidelity headroom,
  not just an abstract bpp.
- **C2. Cancel, progress monotonicity, tier fallbacks** (worker → main thread →
  MediaRecorder) all behave exactly as today. Phase 1 changes only the *number* fed to the
  encoder, not the pipeline shape — so there is essentially no new failure surface.
- **C3. No memory-ceiling risk.** Because Phase 1 stays in average-bitrate mode with a
  *lower* target than today, `videoChunks` RAM use only ever **decreases**. The unbounded-
  output hazard is a Phase-2/QP concern (§E C1), not a Phase-1 one.
- **C4. `estimateExportBytes` stays live** and its only caller (ExportModal) is untouched
  structurally.

### D. Non-goals (Phase 1)

- **D1.** No change to `renderFrame`, camera, effects, audio mixing, or the muxer.
- **D2.** **Not** fixing the canvas/source dimension mismatch (importing 1080×716 into a
  1920×1080 project still upscales on export). Separate spec — see Related Systems.
- **D3.** **Not** touching the per-object Download re-encode
  ([objectDownload.ts](src/lib/objectDownload.ts)), per the scoping decision. It shares the
  bug and would be the natural next consumer of A6's helper, but is deliberately excluded to
  keep the blast radius small.
- **D4.** No QP / quantizer mode (that is §E, Phase 2).
- **D5.** No resolution/fps/format changes; audio stays 128 kbps AAC.

## Technical Considerations

### Data available for the source-anchored target ✅

`AssetMeta` ([types.ts:402-412](src/types.ts#L402-L412)) carries `size: number` (bytes)
and `duration?: number` (seconds) — everything A1 needs:

```ts
export type AssetMeta = {
  id: string
  type: AssetType
  filename: string
  mimeType: string
  size: number       // bytes
  duration?: number  // seconds (audio/video length)
  // ...animated-image fields
}
```

`video` objects carry `data.assetId` ([types.ts:189-199](src/types.ts#L189-L199)), so the
used-asset set is `objects.filter(o => o.type === 'video' && !o.hidden).map(o => o.data.assetId)`.

⚠️ **No source width/height is stored** anywhere in `AssetMeta` — which is why A2 anchors on
bitrate directly and needs no resolution-scaling term. If a future refinement wants
resolution-aware capping it must first thread source dimensions through import (out of scope).

### Current types to change

`exportSettings.ts` — add `headroom` to the preset table and a source-bitrate helper:

```ts
type CompressionSpec = {
  id: CompressionPreset
  label: string
  bpp: number        // retained — no-source fallback + MediaRecorder + the min() ceiling
  headroom: number   // NEW — source-anchor multiplier (A2)
  blurb: string
}

/** Richest used-video source bitrate (bits/sec), or 0 if the project has no usable video. */
export function projectSourceBitrate(project: Project): number { /* A1 */ }
```

`resolveEncodeConfig` keeps its **shape** — `{ width, height, videoBitrate }` — so
`EncodeConfig` ([exportWorkerTypes.ts:12-16](src/lib/exportWorkerTypes.ts#L12-L16)) does
**not** need the discriminated-union rework the QP phase required. Only the computation of
`videoBitrate` changes. (Phase 2 is where `EncodeConfig` grows a `mode`.)

`videoBitrateFor` gains the project/source-bitrate input, or a sibling
`resolveVideoBitrate(project, width, height, fps, preset)` is added and both
`resolveEncodeConfig` and `estimateExportBytes` route through it (A6).

### The estimate is honest again, for free

Today's `estimateExportBytes` doc-comment already claims "*accurate to within codec
overhead because the encoder targets this same bitrate*". Under Phase 1 that stays true —
same formula, same code path — the only thing that changed upstream is that
`videoBitrate` is now source-anchored. With A4's VBR mode the actual file lands **≤** the
estimate on easy content, so the estimate becomes a slightly-generous upper bound rather
than a fiction. This is precisely the "closer is better" outcome, with no new estimator to
justify.

### Browser support

Phase 1 uses only APIs already in use (`bitrate`, and `bitrateMode` which is a
long-standing `VideoEncoderConfig` field). No new capability probe is required — unlike
Phase 2's per-frame quantizer. `VideoEncoderBitrateMode = "constant" | "quantizer" |
"variable"` is already in `lib.dom.d.ts`.

## Related Systems and Tasks

- **[SPECS/27-expand-export-options.md](SPECS/27-expand-export-options.md)** — format
  selection (WebM/GIF). Both specs thread export knobs through
  `ExportSettings → resolveEncodeConfig → EncodeConfig`. Phase 1 does **not** change
  `EncodeConfig`'s shape, so no coordination is needed for it; Phase 2 (which does) should
  coordinate with 27.
- **[objectDownload.ts](src/lib/objectDownload.ts)** — the per-object Download re-encode:
  same content-blind bitrate (`bitrateFor`, [line 407](src/lib/objectDownload.ts#L407)) and
  a third `findSupportedVideoCodec` copy. **Out of scope (D3)** but the obvious follow-up.
- **[SPECS/09-in-video-perf.md](SPECS/09-in-video-perf.md)** — the export worker; Phase 1's
  bitrate change lands in it too (the worker already imports `exportSettings.ts`).
- **Canvas-size mismatch (no spec yet)** — nothing in the import path sets project
  dimensions from an imported video; `useProject` seeds from `canvasSizePref` localStorage,
  defaulting to 1920×1080 ([useProject.ts:352](src/hooks/useProject.ts#L352)). So
  `resolutionOptions` reads the *canvas*, not the asset, and offers "1080p" for 716px-tall
  source (D2). Worth its own spec.
- **CLAUDE.md** — `ffmpegExport.ts` is misnamed; it is the WebCodecs + `mp4-muxer` path.

## Decided

- **Headroom factors = 1.5 / 1.0 / 0.7 / 0.5** (Studio / Social / Web / Web-Low), per the A2
  table. These are the **starting** values; the user will run real exports and adjust if the
  quality invariant slips (Studio must stay visually indistinguishable from the source; the
  presets must stay monotonic in size and quality). Tuning them is a one-line change to the
  preset table, not a design change.
- **`bitrateMode: 'variable'` (VBR)** — see A4. Estimate is presented as an upper bound.

## Open Questions

3. **Audio bytes in `assetBitrate` (A1).** The source `size` includes its audio track, so
   `assetBitrate` slightly overstates the *video* source bitrate — which only makes the cap
   a touch generous (safe). Correct it (subtract a nominal audio bitrate) or accept the
   slop? → **Lean accept**; "closer, not perfect" is the explicit bar.
4. **Should the no-source case (A3) also get a lower bpp?** Pure annotation/text/photo
   projects over-charge today too, but have no source to anchor to. Options: (a) leave
   today's bpp (this spec's default — zero regression risk); (b) add a lower `bpp` floor for
   the no-source path. → **Lean (a)** for Phase 1; (b) is a cheap follow-up once (a) is
   validated.
5. **Does the ExportModal copy need any change beyond "≈ → up to"?** The existing blurbs
   frame compression as quality, which stays true. → probably a one-word tweak, if that.

## Acceptance Criteria

- **AC1. (The motivating repro.)** Import the 57 MB / 11-min / 1080×716 screen recording,
  export at native resolution / **Social Media** with no edits. Output lands in the **same
  order of magnitude as the source** — target ≤ ~2× (≈120 MB), versus 513 MB today — with no
  visible quality loss versus the source. The **Estimated size row shows a number in that
  same range**, not 513 MB.
- **AC2.** **Studio** is visually indistinguishable from the source; **Web (Low)** produces a
  materially smaller file; presets stay **monotonic** in size and quality.
- **AC3.** A **no-video project** (annotations / text / photos only) exports **byte-identical
  to today** — the source-anchor path is skipped (A3), so there is zero regression where
  there is no source to anchor to.
- **AC4.** The **estimate matches the delivered file** to within codec overhead (CBR) or is a
  slightly-generous upper bound the file comes in under (VBR) — never off by an order of
  magnitude as today. Verified in-browser by comparing the modal's number to the downloaded
  file size.
- **AC5.** Worker path, main-thread path, MediaRecorder fallback, and cancel all behave as
  before; progress remains monotonic and reaches 100%.
- **AC6.** `npx tsc -b` stays green. Verify per
  [.claude/skills/verify/SKILL.md](.claude/skills/verify/SKILL.md) — static checks by Claude,
  browser click-list for the user; no dev server run by Claude.

## Implementation Notes

Suggested order — each step independently verifiable:

1. **`exportSettings.ts`** — add `headroom` to each `CompressionSpec`; add
   `projectSourceBitrate(project)` (A1) and a `resolveVideoBitrate(...)` that applies the A2
   `min(bppTarget, sourceBitrate × headroom)` (falling back to `bppTarget` when
   `sourceBitrate === 0`). Route both `resolveEncodeConfig` and `estimateExportBytes` through
   it (A6). This step alone makes the estimate correct and is verifiable by reading the modal
   number before any encoder change.
2. **`ffmpegExport.ts` / `exportWorker.ts`** — set `bitrateMode` (A4) in the encoder config
   (via `findSupportedVideoCodec` or at the `configure` site). The `videoBitrate` they
   receive is already the new number from step 1. Leave the frame loops and
   `encode(frame, { keyFrame })` untouched.
3. **MediaRecorder path** — no code change beyond receiving the new `videoBitrate` (B2);
   confirm it still reads `encode.videoBitrate`.
4. **`ExportModal.tsx`** — optional one-word copy tweak on the estimate row per Q2/Q5. No
   structural change; `estimateExportBytes`, `totalDurationOf`, `formatBytes` all stay.
5. **(Optional) dedup `findSupportedVideoCodec`** into `exportSettings.ts` (B3) — nice-to-have
   in Phase 1, prerequisite for Phase 2.

Do **not** invent a separate heuristic estimator. The estimate is already exact-in-form; the
entire fix is to feed it a sane target. Any parallel "guessing" estimator would reintroduce
the confident-fiction problem this spec removes.

---

## E. Phase 2 (deferred) — Quantizer / QP targeting

> Preserved from the original spec draft. **Out of scope for the first landing** — it is
> genuinely more efficient than Phase 1 on easy content, but (a) it *removes* the pre-export
> estimate the user wants to keep, (b) it makes output size unbounded (a real OOM risk that
> must be guarded), and (c) it adds a browser-support probe and a Firefox/Chromium size
> divergence. Revisit once Phase 1 is validated and if the residual efficiency gap matters.

### E-A. Encoding core (QP)

- **A1.** Where supported, configure the WebCodecs encoder with `bitrateMode: 'quantizer'`
  and **omit `bitrate`**, passing a per-frame quantizer via
  `encode(frame, { keyFrame, avc: { quantizer } })`.
- **A2.** Each `CompressionPreset` maps to an H.264 QP (0–51, lower = better). Proposed,
  mirroring x264 CRF convention: `studio` 18, `social` 23, `web` 28, `web-low` 33. The `bpp`
  table is **retained** as the fallback ladder + MediaRecorder knob.
- **A3.** Keyframes get a lower QP than inter frames (constant-QP has no built-in I:P ratio):
  `quantizer = clamp(isKeyFrame ? qp - 3 : qp, 0, 51)`. The frame loops already compute
  `isKeyFrame` ([ffmpegExport.ts:388](src/lib/ffmpegExport.ts#L388),
  [exportWorker.ts:197](src/lib/exportWorker.ts#L197)).
- **A4.** Probe quantizer support via
  `VideoEncoder.isConfigSupported({ ..., bitrateMode: 'quantizer' })`; if unsupported, fall
  back to Phase-1 source-anchored ABR for the same preset.
- **A7.** Write the quantizer-aware `findSupportedVideoCodec` **once** in `exportSettings.ts`
  and delete the (now three) duplicated copies — ffmpegExport, exportWorker, **and**
  objectDownload.

### E-B. Presenting it (QP)

- **B2 (the reason QP is Phase 2).** Under QP there is no bitrate to multiply by duration, so
  the exact `estimateExportBytes` cannot be computed ahead of time. The original plan was to
  **remove** the estimate and replace it with a **live measured byte counter** during export
  (`Encoding… 34% · 61 MB so far, projecting ≈ 180 MB`), sourced from
  `videoChunks[].data.byteLength`. This is honest but directly conflicts with the user's
  "keep a closer estimate" goal — hence Phase 1 exists. If Phase 2 ever lands, the live
  counter is the right presentation and should be **added alongside** Phase 1's pre-export
  estimate, not instead of it.
- **B5. "Target size" advanced mode** (Discord 10/25 MB, email caps): expose an optional size
  input that back-computes a bitrate (`bitrate = target_bytes × 8 / duration − audio`) and
  reuses the ABR path verbatim. `ExportSettings` becomes a discriminated union
  (`{mode:'quality'} | {mode:'size'}`). Independent of QP; could ship on the Phase-1 ABR base.

### E-C. Safety (QP-only risks)

- **C1. Output size becomes unbounded.** `videoChunks` holds the entire encoded stream in RAM,
  and `mp4-muxer`'s `ArrayBufferTarget` materialises a second full copy. A long Studio-QP
  export of complex footage could exceed 1 GB × 2 and OOM the tab. **This risk does not exist
  in Phase 1** (average-bitrate mode with a lowered target only ever reduces RAM).
- **C2.** Running byte guard: warn at ~1 GB, hard-stop with a clear error at ~2 GB, surfaced in
  the UI. The live counter (B2) makes this nearly free.
- **C3. Noisy effects become expensive under QP.** Spec 23's `grain` / `oldfilm` inject
  near-incompressible per-pixel noise; under QP that multiplies file size (under ABR it merely
  stole quality). Flag in the modal; don't silently clamp QP.

### E-D. QP types

`EncodeConfig` would become a discriminated union so a path can't read the wrong knob:

```ts
export type EncodeConfig = { width: number; height: number } & (
  | { mode: 'quantizer'; qp: number; videoBitrate: number }  // bitrate kept for fallbacks
  | { mode: 'bitrate';   videoBitrate: number }
)
```

`@types/dom-webcodecs` (transitive via `mp4-muxer`) declares a global
`VideoEncoderEncodeOptions` with only `keyFrame`; global interface **merge** should still
expose `avc`, but confirm with `npx tsc -b` on the first `avc: { quantizer }` call site — if it
fails, a local interface augmentation is the fix, not a cast.

*Constant QP is not CRF* — it lacks CRF's psychovisual/frame-type adaptation — but for
"bits follow content complexity" it is sufficient, and A3's keyframe bias recovers the most
important piece for free.

---
*Phase 1 (§A–D) is ready for implementation — the two blocking decisions (headroom values, VBR)
are made; the remaining open questions are minor and default-safe. Use `/task 30` to begin
development. Phase 2 (§E) is deferred and re-opens only if the residual efficiency gap matters
after Phase 1 ships.*

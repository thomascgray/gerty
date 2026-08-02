# 30 — Efficient export encoding (source-anchored ABR)

**Status**: In Progress

## Overview

Export currently targets a content-blind average bitrate (`width × height × fps × bpp`),
so a 57 MB / 11-min / 1080×716 screen recording re-exports at ~513 MB. Phase 1 of
[SPECS/30](../SPECS/30-quality-based-export-encoding.md) fixes this by **capping the
target at the imported source's own bitrate, scaled per compression preset**, and
switching the encoder to **VBR** so easy content undershoots. Because we stay in
average-bitrate mode, the existing size estimate stays exact-in-form and finally reads
a sane number.

Only the *number* fed to the encoder changes plus one `bitrateMode` flag - the pipeline
shape, frame loops, muxer, camera, effects, and audio are all untouched.

## Task Context

- **Single chokepoint:** `resolveEncodeConfig(project, settings)` ([exportSettings.ts:151](../src/lib/exportSettings.ts#L151))
  is called once ([ffmpegExport.ts:46](../src/lib/ffmpegExport.ts#L46)) to build the `encode`
  config for BOTH the main-thread and worker paths, and `estimateExportBytes` also calls it.
  Anchoring the bitrate inside `resolveEncodeConfig` makes the encode and the estimate agree
  for free (spec A6). `EncodeConfig` shape stays `{width,height,videoBitrate}` - no union rework.
- **Source data available:** `AssetMeta.size` (bytes) + `AssetMeta.duration` (s)
  ([types.ts:402](../src/types.ts#L402)); `video` objects carry `data.assetId`
  ([types.ts:189](../src/types.ts#L189)). No source width/height stored - fine, we cap on
  bitrate directly (re-encoding can't manufacture detail, so no resolution-scaling term).
- **Decided values:** headroom = Studio 1.5 / Social 1.0 / Web 0.7 / Web-Low 0.5 (starting
  values, tune from real exports); `bitrateMode: 'variable'` (VBR); estimate row worded as an
  upper bound ("up to ~X").
- **`bitrateMode` plumbing:** set `bitrateMode: 'variable'` inside the two in-scope
  `findSupportedVideoCodec` copies ([ffmpegExport.ts:590](../src/lib/ffmpegExport.ts#L590),
  [exportWorker.ts:333](../src/lib/exportWorker.ts#L333)). MediaRecorder path already reads
  `encode.videoBitrate` - no code change there beyond the new number.
- **Out of scope (spec D2/D3):** the canvas/source dimension mismatch (upscaling), and
  `objectDownload.ts` (which has the same bug + a 3rd `findSupportedVideoCodec` copy).
- Verify per [.claude/skills/verify/SKILL.md](../.claude/skills/verify/SKILL.md): `npx tsc -b`
  by Claude, browser click-list for the user. No dev server run by Claude.

## Blockers/Issues

None currently.

## TODO

[X] `exportSettings.ts`: add `headroom` to `CompressionSpec` + the four preset values
[X] `exportSettings.ts`: add `projectSourceBitrate(project)` (max used-video assetBitrate, 0 if none)
[X] `exportSettings.ts`: apply the `min(bppTarget, sourceBitrate × headroom)` cap in `resolveEncodeConfig` (estimate routes through it automatically)
[X] `ffmpegExport.ts` + `exportWorker.ts`: set `bitrateMode: 'variable'` in each `findSupportedVideoCodec`
[X] `ExportModal.tsx`: reword the estimate row to an upper bound ("up to ~X")
[X] `npx tsc -b` green
[ ] Hand user a browser click-list to validate AC1-AC5 (awaiting user browser test)

## Work Log

[2026-08-02] Implemented Phase 1 (source-anchored ABR + VBR). All code + typecheck done; awaiting browser validation.

- `src/lib/exportSettings.ts`: added `headroom` to `CompressionSpec` (Studio 1.5 / Social 1.0 / Web 0.7 / Web-Low 0.5); added `projectSourceBitrate(project)` (max `size×8/duration` over non-hidden used video assets, 0 if none); added `resolveVideoBitrate(...)` applying `min(bppTarget, sourceBitrate × headroom)`; routed `resolveEncodeConfig` through it (so `estimateExportBytes` is anchored too). Renamed internal `bppFor` → `specFor`.
- `src/lib/ffmpegExport.ts` + `src/lib/exportWorker.ts`: set `bitrateMode: 'variable'` in each `findSupportedVideoCodec` config.
- `src/components/ExportModal.tsx`: estimate row now reads "up to ~X" (VBR upper bound).
- MediaRecorder path unchanged - already reads `encode.videoBitrate` (verified), so it gets the anchored number for free.
- `npx tsc -b` → exit 0.

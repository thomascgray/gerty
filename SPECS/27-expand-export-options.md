# 27 — Expand Export Options (formats + clipboard)

## Overview

The Export modal today does exactly one thing: encode the timeline to an **MP4 (H.264 + AAC)** blob and trigger a browser download. This spec expands the *destination* and *format* options so a user can:

1. Choose an **output format** (MP4 today; add **WebM**, possibly **GIF**), and
2. Optionally send the result **straight to the clipboard** instead of downloading a file, so it can be pasted into Slack/Discord/etc. without a round-trip through the filesystem.

The motivating use case is fast sharing: record → export → paste into a chat app.

## ⚠️ Hard constraint discovered during spec (read first)

**You cannot put a video on the clipboard from a browser.** The async Clipboard API (`navigator.clipboard.write([new ClipboardItem(...)])`) gates which MIME types may be written. Across Chrome, Safari, and Firefox the only broadly-supported write types are:

- `text/plain`
- `text/html`
- `image/png`  (Safari also allows a few more; Chrome has `image/svg+xml` partially/flagged)

`video/mp4`, `video/webm`, and **`image/gif` are NOT writable** to the clipboard — `ClipboardItem` construction / `write()` rejects them ("Type ... not supported on write"). There is no browser API to place a *file reference* on the OS clipboard either.

Consequently:

- **"Copy a WebM/MP4/GIF to the clipboard and paste the moving video into Slack"** is **not achievable** with current web APIs. This is a browser platform limit, not an implementation gap.
- Slack and Discord accept **video via file upload / drag-drop**, not via clipboard paste. Their *paste* handlers only ingest **still images** (PNG).
- The only "copy → paste into chat and it just works" path that actually exists is **copying a single still frame as a PNG**.

This reframes the feature into two independent capabilities that should be scoped separately:

- **(A) Format choice for the downloaded file** — MP4 / WebM / (optional) GIF. Fully viable.
- **(B) Copy to clipboard** — viable *only* as **"copy current frame as PNG"** (a screenshot), not as video. Needs a product decision (see Open Questions).

## Requirements

> Requirements are grouped; the clipboard-video items are intentionally listed as **rejected/blocked** so the record is explicit.

### A. Output format selection (file download)

- **A1.** The Export modal gains a **Format** control (chip row, matching the existing Resolution/Compression chips) offering at least **MP4** (default) and **WebM**.
- **A2.** Selecting **WebM** produces a `video/webm` blob (VP9 + Opus preferred, VP8 + Opus fallback) with the same resolution/compression settings applied.
- **A3.** The download filename extension tracks the chosen format (`.mp4` / `.webm` / `.gif`). (`useFFmpegExport` currently derives the extension from `blob.type` — keep that, but make sure the blob type is correct for each path.)
- **A4.** The static "Format" fact tile (currently hard-coded `"MP4 · H.264"`) and the primary button label (`"Export MP4"`) update to reflect the selected format.
- **A5.** The **estimated size** figure should remain at least roughly correct per format, or be hidden/annotated for formats where the current bitrate math doesn't apply (GIF especially — see A8).
- **A6. (Optional) GIF.** If GIF is in scope: encode the frames to an animated GIF (`image/gif`). This has major caveats (no native encoder, 256-color palette, no audio, large files) — see Technical Considerations.
- **A7.** Formats unsupported by the current browser must degrade gracefully (disable the chip with a tooltip, or fall back) rather than throwing mid-export.
- **A8. (If GIF)** GIF has **no audio** and is **palette-limited**; the modal must communicate this (blurb + hide audio-dependent size math) and likely cap resolution/fps to keep size sane.

### B. Copy to clipboard

- **B1. (Viable) Copy current frame as PNG.** A "Copy frame" affordance renders the frame at the current playhead to a PNG and writes it to the clipboard via `ClipboardItem({'image/png': blob})`. Pasteable into Slack/Discord/docs immediately.
- **B2.** Success/failure feedback (the clipboard write is async and can reject on permissions / non-secure context / unfocused document).
- **B3.** Must run in a **secure context** (https or localhost) and typically requires the document to be focused; handle the rejection path with a clear message.
- **B4. (BLOCKED) Copy the exported video to the clipboard.** Not implementable — see the hard-constraint section. Should be explicitly out of scope, not a TODO.

### C. Non-goals / preserved behavior

- **C1.** Existing MP4 download path, settings (resolution/compression), progress UI, and cancel must be unchanged when MP4 + download is selected (byte-for-byte the same output).
- **C2.** No backend; everything stays client-side.

## Technical Considerations

### Current types & where they live

`ExportSettings` — [src/lib/exportSettings.ts](src/lib/exportSettings.ts):

```ts
export type CompressionPreset = 'studio' | 'social' | 'web' | 'web-low'

export type ExportSettings = {
  shortEdge: number
  compression: CompressionPreset
}
```

To add format + destination, this likely becomes:

```ts
export type ExportFormat = 'mp4' | 'webm' | 'gif'      // NEW
export type ExportDestination = 'download' | 'clipboard' // NEW (clipboard = still-frame PNG only, per §B)

export type ExportSettings = {
  shortEdge: number
  compression: CompressionPreset
  format: ExportFormat          // NEW
  // destination handled in the hook/modal, not necessarily in encode settings
}
```

`EncodeConfig` — [src/lib/exportWorkerTypes.ts](src/lib/exportWorkerTypes.ts) (resolved via `resolveEncodeConfig`): currently `{ width, height, videoBitrate }`. A `format` field may need to flow through so the worker/muxer picks the right container/codec.

The export entry point — [src/lib/ffmpegExport.ts](src/lib/ffmpegExport.ts):

```ts
export async function exportVideo(
  project: Project,
  settings: ExportSettings,
  onProgress: (pct: number) => void,
  signal?: AbortSignal,
): Promise<Blob>
```

Returns a `Blob` (`video/mp4` from the WebCodecs paths, `video/webm` from the MediaRecorder fallback).

The download trigger — [src/hooks/useFFmpegExport.ts](src/hooks/useFFmpegExport.ts): builds an `<a download>` with `ext = blob.type === 'video/mp4' ? 'mp4' : 'webm'`.

The modal — [src/components/ExportModal.tsx](src/components/ExportModal.tsx): Resolution + Compression chip rows, size estimate, progress, Export button.

### WebM path (A1/A2) — the clean win

Two ways to produce WebM:

1. **`webm-muxer`** (by the same author as the already-used `mp4-muxer`) + WebCodecs `VideoEncoder` configured for **VP9** (`vp09.*`) or **VP8** + **Opus** audio. This mirrors the existing `exportWithWebCodecs` MP4 pipeline almost exactly — same frame loop, same `renderFrame`, just a different muxer + codec strings. **Preferred**: keeps the fast, off-real-time, cancellable WebCodecs pipeline and the worker variant.
2. **Reuse the existing `exportWithMediaRecorder` fallback**, which *already* outputs `video/webm` (VP9/VP8 + Opus). Cheapest to wire up, but MediaRecorder runs in **real time** (there's a `setTimeout(1000/fps)` per frame), is lower quality, and isn't the primary pipeline. Acceptable as a v1 WebM path but a UX downgrade (slow).

**Recommendation:** add `webm-muxer` and parameterize the WebCodecs pipeline on container/codec. The frame-rendering loop, audio pre-mix (`OfflineAudioContext`), camera (`resolveCamera`) and effects (`resolveEffects`) are all format-agnostic and reused as-is. Note the worker pipeline (`exportWorker.ts`) and the codec-probe (`findSupportedVideoCodec`, currently H.264-only) both need the format threaded through.

### GIF path (A6) — expensive, optional

- **No native browser GIF encoder.** Needs a JS lib — `gifenc` (fast, modern, good palette quantization) is the current best pick; `gif.js` is older/worker-based.
- **256-color palette per frame** → visible banding; needs quantization + optional dithering.
- **No audio.**
- **Large files** at video resolutions/fps → almost certainly must cap fps (~10–15) and short-edge (~480–720) or sizes explode. Slack/Discord have upload caps.
- The `estimateExportBytes` bitrate math **does not apply** to GIF; size estimate must be hidden or replaced.
- Given the cost and the fact that WebM already satisfies "paste into Slack/Discord as a moving clip via drag/upload," **GIF should be a stretch goal or a follow-up**, not v1.

### Clipboard (B) — what's actually possible

- **Frame → PNG → clipboard** is the only real path. Rendering a single frame is cheap: we already have `renderFrame(ctx, objects, globalTime, dims, imageCache, {camera, effects})` used by preview. The preview canvas already holds the current frame — the simplest implementation grabs the live preview/render canvas and calls `canvas.toBlob(blob => navigator.clipboard.write([new ClipboardItem({'image/png': blob})]))`.
- Requires: secure context, focused document, user gesture, and try/catch around the async write.
- **This is arguably a different feature from the Export modal** ("copy screenshot to clipboard" belongs near the canvas/toolbar, e.g. a `C`/toolbar action), and it produces a still, not a video. Decide whether it lives in the Export modal at all (see Open Questions).

### Browser support matrix (informing A7)

- **WebCodecs `VideoEncoder`** (MP4/WebM fast path): Chromium + Safari 16.4+; **Firefox lacks it** → MediaRecorder WebM fallback already covers Firefox.
- **`ClipboardItem` PNG write:** Chrome, Edge, Safari, Firefox (recent) — OK for B1.
- **`ClipboardItem` video/gif write:** none — confirms B4 is blocked.

## Related Systems and Tasks

- **Spec/Task 08** — [SPECS/08-refactor-to-webcodecs-video-export.md](SPECS/08-refactor-to-webcodecs-video-export.md): the WebCodecs refactor this builds on.
- **Spec/Task 09** — [SPECS/09-in-video-perf.md](SPECS/09-in-video-perf.md): resurrecting the export **worker** so export doesn't freeze the UI. Adding formats interacts with the worker pipeline — coordinate the `EncodeConfig`/format threading so we don't fork the codec logic twice.
- **`renderFrame`** — [src/lib/renderer.ts](src/lib/renderer.ts): the shared compositor reused for any format/frame-grab.
- **Camera / effects** — `resolveCamera` ([src/lib/camera.ts](src/lib/camera.ts)), `resolveEffects` ([src/lib/effects.ts](src/lib/effects.ts)): already applied in export; format-agnostic.
- CLAUDE.md note: `ffmpegExport.ts` is misnamed — it's the WebCodecs+mp4-muxer path, **not** ffmpeg.wasm.

## Open Questions

1. **Scope of clipboard (the big one).** Given video-to-clipboard is impossible: do we
   - (a) ship **"Copy current frame as PNG"** as the clipboard feature (honest, useful, but it's a screenshot not a video), or
   - (b) **drop clipboard entirely** and focus this spec purely on **format choice (WebM)** for downloads, or
   - (c) both — WebM download **and** a separate "copy frame" button?
   → **Recommend (b) for this spec's core + (a) as a small separate add** (likely near the canvas, not in the Export modal).
2. **Is GIF actually wanted for v1**, given WebM covers Slack/Discord sharing and GIF is costly (new dep, palette limits, no audio, size caps)? → Recommend deferring GIF to a follow-up.
3. **WebM implementation:** add `webm-muxer` + parameterize the fast WebCodecs pipeline (recommended), or take the quick-but-slow **MediaRecorder** WebM path for v1?
4. **Where does "copy frame" live** if we do it — Export modal, or a canvas/toolbar action (e.g. shortcut `C`)? Which frame — the current playhead, always?
5. **Does the size estimate need to be format-aware**, or is per-format accuracy not worth it for v1 (annotate/hide for GIF)?

## Acceptance Criteria

- **AC1.** Export modal shows a **Format** selector; choosing **WebM** downloads a playable `.webm` (video + audio) that opens in VLC/Chrome and uploads to Slack/Discord.
- **AC2.** Choosing **MP4** yields byte-identical output to today (no regression in the default path).
- **AC3.** Format label, button text, and download extension all reflect the chosen format.
- **AC4.** On a browser lacking a needed codec/encoder, the unsupported format is disabled or cleanly falls back — no uncaught error, no partial file.
- **AC5. (If clipboard-frame ships)** Triggering "Copy frame" places a PNG on the clipboard that pastes as an image into Slack/Discord/a doc; failures show a clear message.
- **AC6. (If GIF ships)** A GIF exports, loops, and is visibly reasonable at the capped fps/resolution; the modal communicates "no audio" and the size caveat.
- **AC7.** `npx tsc -b` stays green; verify per [.claude/skills/verify/SKILL.md](.claude/skills/verify/SKILL.md) (static checks + a browser click-list; no dev server run by Claude).

## Implementation Notes

- **Thread `format` through** `ExportSettings → resolveEncodeConfig → EncodeConfig → exportVideo → export*` rather than branching at the top; the frame loop, audio pre-mix, camera, and effects are all shared and unchanged.
- **WebM (recommended):** `npm i webm-muxer`; add a `Muxer`/codec switch in `exportWithWebCodecs` (and the worker) — VP9 (`vp09.00.10.08`) → VP8 (`vp8`) probe mirroring `findSupportedVideoCodec`, Opus audio. Keep `mp4-muxer` for MP4.
- **`useFFmpegExport`** already picks the extension from `blob.type`; extend for `image/gif`/`video/webm` and keep the `<a download>` name from `project.name`.
- **Modal:** add a Format chip row above/next to Resolution; derive the primary button label + Format fact tile from it; keep the size estimate but hide/annotate for GIF.
- **Copy frame (if in scope):** small util that grabs the render canvas (or renders one frame to an offscreen canvas at project dims) → `toBlob('image/png')` → `navigator.clipboard.write`. Wrap in try/catch; gate on `window.isSecureContext`.
- **Do NOT** attempt `ClipboardItem` with a video or gif MIME — it will throw; the spec records this as blocked (B4).

## Decisions still needed before `/task`

See Open Questions 1–5 — chiefly: **(1)** clipboard scope, **(2)** GIF in/out, **(3)** WebM via muxer vs MediaRecorder. These change the size of the task materially.

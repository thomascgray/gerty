# 28 — Image stuff: paste-a-URL import + animated images that actually render

**Status**: In Progress

## Overview

Two independent features from [gerty#10](https://github.com/thomascgray/gerty/issues/10):

**A.** The Add Assets modal should accept a **URL pasted as text** (Ctrl+V), fetch it, and stage it as a normal pending asset — images, audio and video, same as a dropped file. Modal copy expanded to say so.

**B.** **Animated images (WebP/GIF/APNG) must actually animate** in the render canvas and in every export path, with the frame chosen from the scrubber position. Today they only animate in the `<img>` thumbnails; the compositor never receives more than one frame.

Full spec: [SPECS/28-image-stuff.md](../SPECS/28-image-stuff.md) — all open questions resolved.

## Task Context

### The core insight (B)

`renderFrame` is the shared preview+export compositor and it is **pure** — the caller puts frames in `imageCache`. Video already solves exactly this problem: frames keyed by **object id** (`renderer.ts:619`, `imageCache.get(obj.id) ?? imageCache.get(vdata.assetId)`). Animated photos get the same treatment, so:

- **`renderer.ts` needs a ONE-LINE change** (`case 'photo'` → object-id-first lookup). `drawImageCover` already accepts `ImageBitmap`/`VideoFrame` and duck-types dimensions for worker safety (spec 08).
- All the real work is in the **four `imageCache` population sites**: `useCanvasRenderer.ts:67-92`+`:37-45`, `ffmpegExport.ts:252`/`:338`, `ffmpegExport.ts:639` (MediaRecorder), `exportWorker.ts:90`.

### Key decisions (locked, from spec)

- **Decode on demand, retain ONE frame per clip.** No pre-decoded pixel buffer, no LRU. Decode only fires when the resolved frame **index** changes (a 12fps GIF at 60Hz decodes 1 in 5 renders).
- **Frame timings persist on `AssetMeta.frameDelaysMs` as INTEGER MILLISECONDS** — one copy per asset (duplicating a clip is free), ~6× smaller than cumulative float seconds (which accumulate `0.30000000000000004`-style FP noise). `PhotoData` carries only 3 scalars: `animated`, `animationDuration`, `loop`.
- **Full exact probe at import** — `ImageDecoder` has no metadata-only timing API, so every frame is decoded once for its `duration` then closed immediately. ~0.25–1s for a 10s 500×500 WebP, once, persisted. Rejected the O(1) "assume even delays" shortcut: variable-delay GIFs would lose their rhythm.
- **Native speed, no trim/rate. One control: a `Loop` toggle** (default on) in the Properties panel. Loop off = play once, hold last frame. The file's own `repetitionCount` is ignored.
- **No CORS proxy.** Fetch failures get a human error row. Never `mode:'no-cors'`, never an `<img>` fallback — **canvas tainting would break ALL export**, not just that object.
- **URL paste pre-rejects on `Content-Length` > `SIZE_WARN_PER_FILE` (50 MB)** before reading the body.

### Gotchas to hold onto

- **`VideoFrame` leaks.** One-frame-per-object means every swap must `.close()` its predecessor, and so must object deletion, `SET_PROJECT`, unmount, and export teardown (`exportWorker.ts:206` already does this for video).
- **`UPDATE_OBJECT` shallow-merges** — the Loop toggle must dispatch the **whole** `data` object (`{...data, loop}`) or `assetId` is dropped.
- **`ImageDecoder` is Chromium-only** and worker-safe. No `ImageDecoder` ⇒ degrade to first frame (today's behaviour), `console.warn`, never throw.
- Clipboard `getData('text/plain')` must be read **synchronously before any `await`** — it's unavailable once the handler yields.
- Backwards seeks can be slow (inter-frame formats may internally decode `0..n`). Bounded by index-change gating; acceptable.

### Files / references

- Model `animatedImage.ts` on `src/lib/videoDecoder.ts` (structure, tiered fallback, `console.warn`-don't-throw).
- `CLAUDE.md` → *Rendering pipeline*, *File map*, *Gotchas*.
- `SPECS/08-refactor-to-webcodecs-video-export.md` — the precedent: a new frame type enters through `imageCache`, the renderer barely changes.
- **Verification is static only** (`npx tsc -b`). Do NOT run the dev server — user tests in the browser (`.claude/skills/verify/SKILL.md`).

## Blockers/Issues

**Known limitation (accepted):** a project saved BEFORE this change that contains an animated
image keeps rendering as a still. Its `AssetMeta` has no `frameDelaysMs` and its `PhotoData` has
no `animated` flag, and back-filling would mean an O(frameCount) probe of every image on project
load. Re-importing the asset fixes it. New imports and new `.gerty` round-trips are unaffected.

**Lint baseline:** `npx eslint src` reports 20 problems (17 errors, 3 warnings) on `master`
BEFORE this work — mostly pre-existing `react-hooks/refs` "cannot access refs during render".
The gate is `npx tsc -b` (per CLAUDE.md). This change ends at exactly the same 20/17/3, i.e. it
adds no new lint problems.

## TODO

**Feature B — animated images (bottom-up)**

- [X] `src/lib/animatedImage.ts` (new) — `probeAnimatedImage`, `buildTimeline`, `createAnimatedImageSource`, `animTimeAt`, plus shared export helpers. Worker-safe, no DOM.
- [X] `src/types.ts` — additive optional fields on `PhotoData` (`animated`/`animationDuration`/`loop`) and `AssetMeta` (`animated`/`frameDelaysMs`, reuse `duration`).
- [X] `src/lib/assetStore.ts` — probe image blobs in `storeAsset`, record on `AssetMeta`.
- [X] `src/lib/renderer.ts` — `case 'photo'` object-id-first lookup (the only renderer change).
- [X] `src/hooks/useCanvasRenderer.ts` — create/destroy sources; index-gated decode-and-swap in `doRender`; close outgoing frames.
- [X] `src/lib/ffmpegExport.ts` — WebCodecs path (setup + per-frame + cleanup).
- [X] `src/lib/ffmpegExport.ts` — MediaRecorder fallback path.
- [X] `src/lib/exportWorker.ts` — worker path + teardown.
- [X] Import wiring — `ImportModal.handleImport` (clip duration = one loop) and `App.handleAddExistingAsset`.
- [X] `src/components/Timeline.tsx` — animated badge on the clip bar.
- [X] `src/components/PropertiesPanel.tsx` — `Loop` toggle (animated photos only).

**Feature A — paste a URL**

- [X] `src/lib/assetStore.ts` — `fetchAssetFromUrl(url)`: scheme validation, `Content-Length` pre-check, `Content-Type` + magic-byte sniff, filename derivation, typed user-facing errors.
- [X] `src/components/ImportModal.tsx` — `PendingAsset` gains `status`/`error`/`sourceUrl`; paste handler text branch; loading/error row variants; Import disabled while loading; drop-zone copy.

**Verification**

- [X] `npx tsc -b` green; `eslint` at baseline (no new problems).
- [ ] User click-through in the browser (checklist handed over — awaiting results).

## Work Log

### [2026-07-28] Implemented spec 28 in full — both features

**New module: `src/lib/animatedImage.ts`**
- `probeAnimatedImage(blob)` — the one O(frameCount) operation. Decodes each frame purely to read
  `image.duration`, closes it immediately, returns integer-ms delays. Never throws; degrades to
  `STILL_IMAGE_INFO` on any failure (B8).
- Mime resolution is by **magic-byte sniff**, not `File.type` — `sniffImageMime` also distinguishes
  APNG (PNG + `acTL` chunk before the first `IDAT`) from a still PNG. Candidates are tried in order
  and **APNG falls back to `image/png`** because browsers disagree about whether `image/apng` is an
  accepted decoder type; without that fallback APNG would silently render as a still.
- `couldBeAnimated` gates on the sniffed type, so a plain PNG/JPEG never constructs a decoder.
- Zero/10ms frame delays are clamped to 100ms **inside the probe**, so the clamp is baked into the
  persisted timings and preview/export can't disagree about it.
- `animTimeAt(data, elapsed)` — pure, object-local, honours the Loop toggle. Shared by preview and
  all three export paths so they cannot drift.
- `createAnimatedExportSources(...)` — shared helper used by all three export paths rather than
  triplicating the decode-on-index-change logic.

**Files modified:** `src/types.ts`, `src/lib/assetStore.ts`, `src/lib/renderer.ts`,
`src/hooks/useCanvasRenderer.ts`, `src/lib/ffmpegExport.ts`, `src/lib/exportWorker.ts`,
`src/components/ImportModal.tsx`, `src/components/App.tsx`, `src/components/Canvas.tsx`,
`src/components/Timeline.tsx`, `src/components/PropertiesPanel.tsx`.

**Deviation from the spec, and why:** the spec assumed `useCanvasRenderer` could reach the per-frame
timings, but it only receives `objects` — the timings live on `AssetMeta`. Rather than re-probing on
every project load (which would defeat the whole point of persisting them) or syncing a module-level
registry from the several project-load entry points (fragile — easy to miss one), `assets` is now
passed explicitly: `App` → `Canvas` (new `assets` prop) → `useCanvasRenderer` (new 8th arg). Export
paths read `project.assets` directly. This keeps the data flow honest and has no staleness risk.

**Leak discipline (the risk flagged in the spec):** the retained `VideoFrame` per clip is closed on
every swap, when its object leaves the project, on unmount, and on export finish/abort. In
`exportWorker` the animated teardown runs BEFORE the existing ImageBitmap cleanup loop, because
animated frames are caller-owned whereas video-source frames are not — closing them in the generic
loop would double-free.

**Also fixed while in the file:** `ImportModal`'s unmount cleanup captured the initial (empty)
`pending` array via an `eslint-disable`, so preview object URLs were never revoked. Now reads a ref.

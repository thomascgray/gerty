# 28 — Image stuff: paste-a-URL import + animated images that actually render

> Source: [thomascgray/gerty#10](https://github.com/thomascgray/gerty/issues/10) — *"imrpove asset add flow, plus render animated images properly"*

## Overview

Two independent improvements to how images get into a project and how they come out of it.

**A. Paste a URL into the Add Assets modal.** Today `ImportModal` listens for `paste` and only handles clipboard items whose `type` starts with `image/` (i.e. raw bitmap data). If the clipboard holds a *string* that is a URL to an image, nothing happens. We want Ctrl+V of an image URL to fetch that image and stage it as a pending asset, exactly as if the file had been dropped. The modal copy needs to say this is possible.

**B. Animated images render as animations.** An animated WebP/GIF added today animates in the little `<img>` thumbnails (LeftRail `AssetThumb`, ImportModal preview) because those are real DOM `<img>` elements, but the render canvas and every export path show a **single static frame**. Cause: the compositor only ever receives a still. `useCanvasRenderer` caches `await loadImage(url)` → `HTMLImageElement`; `ffmpegExport` does the same; `exportWorker` does `await createImageBitmap(blob)` which is definitively first-frame-only. `drawObject`'s `case 'photo'` just blits whatever is in `imageCache` — so there is no frame selection at all.

The fix is to give animated images the same shape video already has: a per-object, time-indexed frame source that `renderFrame` reads at `globalTime`. The issue explicitly asks for the animation frame to be **scrubber-relative** ("in an ideal world…"), which is also the only variant that makes preview and export identical by construction — the project's core invariant.

> **Why "just let it animate like an `<img>`" can't work.** An `HTMLImageElement` animates on *wall-clock* time. Export doesn't run on wall-clock time — it renders N frames as fast as the encoder allows, so a wall-clock `<img>` would advance a second or two of animation across an entire 30-second export (or the reverse). And `exportWorker.ts` has no DOM at all, so there is no `<img>` to animate. Deriving the frame from `globalTime` is what makes "it just plays" true in *both* preview and export. Happily, it costs no more memory than the wall-clock approach would — see **Frame sourcing model** below.

---

## Requirements

### A — Paste a URL in the Add Assets modal

- **A1.** With the Add Assets modal open, pressing Ctrl/Cmd+V when the clipboard contains a plain-text string that parses as an `http:`/`https:` URL fetches that resource and stages it as a pending asset.
- **A2.** **Precedence.** If the clipboard carries *both* image data and text (the common case when copying an image out of a browser page — you get an `image/png` file *and* a `text/html`/`text/plain` fragment), the **binary image item wins** and the text is ignored. Only fall through to URL handling when no `image/*` item was consumed.
- **A3.** **Accepted schemes.** `https:` and `http:`. Also accept a pasted `data:` URL (`data:image/...;base64,...`) — trivial via `fetch`, and it's a real paste case. `blob:` and `file:` URLs are rejected with an explanatory message (a `blob:` URL from another origin/tab is dead by the time it's pasted; `file:` can't be fetched).
- **A4.** **Type validation — images, audio and video, same as the rest of the uploader. (RESOLVED.)** After fetch, the resource is accepted only if the response `Content-Type` (or, when the header is missing/`application/octet-stream`, a magic-byte sniff) resolves to a supported media type. It runs through the **same `image/` · `audio/` · `video/` classification `addFiles` already applies to dropped files** — a pasted `.mp4` or `.mp3` URL stages a video/audio asset with its duration probed and waveform generated exactly as a dropped file would. Anything else is an error row (A6).
- **A5.** **Naming.** The pending asset's name is derived from the URL's last path segment (decoded, query string stripped). If that is empty or extension-less, synthesise `pasted-image.<ext-from-mime>`. Data URLs get `pasted-image.<ext>`.
- **A6.** **Async feedback.** A fetch is not instant and can fail. While in flight, the modal shows a placeholder row for that URL in a **loading** state (spinner + the URL, truncated); on success it becomes a normal pending row with a thumbnail; on failure the row becomes an **error** row showing a human-readable reason with a dismiss (×) button. It must never silently do nothing.
- **A7.** **CORS failures are reported, never worked around. (RESOLVED — no proxy.)** Gerty has no backend, so a cross-origin fetch of a host that doesn't send `Access-Control-Allow-Origin` will be blocked. When `fetch` rejects with a `TypeError` (the opaque signature of a CORS/network failure) the error row says something like *"Couldn't load that URL — the site doesn't allow other sites to read its images. Try saving the image and dragging it in instead."*
  We deliberately do **not**:
  - use `mode: 'no-cors'` — an opaque response yields an unreadable blob;
  - fall back to loading via a plain `<img>` — that **taints the canvas**, which breaks `VideoFrame(canvas)` / `captureStream()` and would kill export for the *entire project*, not just that object;
  - route through a public CORS proxy — no third-party dependency, and no pasted URL is ever disclosed to anyone but its own host.

  Real bytes or a clear error. This is non-negotiable.
- **A8.** **The staged asset is a real blob, identical to a dropped file.** The fetched blob is wrapped in a `File` and pushed through the existing `addFiles`/`storeAsset` path, so it lands in IndexedDB, gets an `AssetMeta`, appears in the LeftRail library, is included in `.gerty` export (`projectStorage.exportProject` zips `getAssetBlob(asset.id)`), and needs no network access ever again. **No remote URL is persisted anywhere in the project.**
- **A9.** **Size guard — pre-reject before downloading. (RESOLVED.)** If the response's `Content-Length` exceeds `SIZE_WARN_PER_FILE` (50 MB), abort before reading the body and show an error row (*"That file is too big to load from a link (X MB) — download it and drag it in"*). This is the only guard available before the bytes are already in memory, and it matters more now that A4 admits video URLs. Responses with **no** `Content-Length` (chunked) can't be pre-checked — download and let the existing post-download `SIZE_WARN_PER_FILE` badge and `SIZE_WARN_TOTAL` import confirm handle them, unchanged.
- **A10.** **Modal copy.** The drop-zone body text is expanded to explain all three routes. Target wording (final copy is the user's call):
  - line 1: `Drag & drop files here, or click to browse`
  - line 2 (new): `You can also paste (Ctrl+V) an image — or a link to one`
  - line 3 (existing types line): `Images (PNG, JPG, WebP, GIF) · Audio (…) · Video (…)`
- **A11.** **Multiple URLs.** If the pasted text contains several whitespace/newline-separated URLs, each is fetched and staged independently (independent rows, independent failures). A pasted string that isn't a URL at all is ignored silently (no error row) — people paste text by accident.
- **A12.** **Scope: modal only.** The paste listener stays scoped to the mounted `ImportModal` (it is currently a `window` listener that only exists while the modal is open). There is no global paste-to-import today and this spec does not add one.

### B — Animated images

- **B1.** **Detection at import.** When an image asset is stored, probe whether it is animated and, if so, record the frame count and per-frame timing. Detection is by decode probe (`ImageDecoder`), **not** by mime type — a `.webp`/`.png` may or may not be animated. Applies to every entry point: `ImportModal.handleImport`, the URL-paste path (A), and `.gerty` project import.
- **B2.** **Render at the scrubber position.** For an animated photo object, the frame drawn at `globalTime` is a deterministic function of the clip-relative elapsed time. `renderFrame` stays pure — the caller is responsible for putting the right frame in `imageCache` (exactly the contract video already has).
- **B3.** **It just plays at native speed. One control: Loop. (RESOLVED.)** No trim, no speed, no rate multiplier. The animation plays at the file's own frame timings, and a single per-object **Loop** toggle decides what happens once it reaches the end:
  - **Loop on (default):** `animTime = elapsed % animationDuration` — repeats for the whole clip duration. Extending the clip replays the loop; shortening it truncates mid-loop.
  - **Loop off:** `animTime = min(elapsed, animationDuration)` — plays through once and then **holds the last frame** for the rest of the clip.

  The source file's own `repetitionCount` (a GIF may declare "play once") is **ignored** — the toggle is the single source of truth, so behaviour never depends on an invisible property of the file. Default is on, which is what people expect from a GIF and means a clip can't sit mysteriously frozen unless you asked it to.
- **B4.** **Default clip duration on import.** An animated image's clip defaults to **one full animation loop** (its `animationDuration`), like video does with `asset.duration` — not the 5s still-image default. Both `ImportModal.handleImport` and `App.handleAddExistingAsset` must agree.
- **B5.** **Export parity — all three paths.** Animated frames must appear in:
  1. `ffmpegExport.ts` WebCodecs path (primary, main thread),
  2. `exportWorker.ts` worker path (spec 09),
  3. `ffmpegExport.ts` MediaRecorder/WebM fallback.

  A frame exported at time *t* must be the same frame the preview shows when the playhead is parked at *t*.
- **B6.** **Two objects, one asset, independent time.** Two photo objects referencing the same animated asset at different `startTime`s must show different frames at the same `globalTime`. This forces the same cache-keying rule video uses: **animated photo frames are keyed in `imageCache` by OBJECT id**, not asset id. Still photos keep their existing asset-id keying (dedup is still worth it for stills).
- **B7.** **Stills are untouched.** A non-animated image follows exactly the current code path (`loadImage` → `HTMLImageElement` cached by `assetId`). No new decode, no per-object cache entry, no behaviour or output change.
- **B8.** **Graceful degradation.** Where animated decoding is unavailable (no `ImageDecoder`, unsupported/corrupt animation, decode failure), the object renders its **first frame** as a still — i.e. today's behaviour — and never blocks or breaks the render/export. A decode failure is logged via `console.warn` and does not abort an export.
- **B9.** **Everything else keeps working on an animated photo.** Keyframes, enter/exit transitions, `animateIn`, camera zoom, `ignoreCamera`, effects, `hidden`, opacity, rotation, resize, duplicate, undo/redo — all unchanged, because an animated image remains a `photo` `TimelineObject` and only its `imageCache` lookup changes. `DUPLICATE_OBJECT` deep-clones `data`, so the copy is an independent clip with an independent frame cursor (B6's keying makes this fall out for free).
- **B10.** **Memory: decode on demand, retain one frame per clip. (RESOLVED.)** No frame buffer, no LRU, no pre-decoded pixel cache. Retained pixel memory is exactly **one decoded frame per animated clip on screen** — the frame currently being drawn, which we'd have to hold anyway. See **Frame sourcing model** below for how this stays fast.
- **B11.** **Scrubbing and playback must not stutter.** A decode is only issued when the resolved *frame index* changes, not per rendered frame — animations typically run at 10–25 fps, so at 60 Hz playback most rendered frames reuse the frame already in `imageCache`.
- **B12.** **UI surface. (RESOLVED.)** Exactly two additions, both only visible for an animated photo (`data.animated === true`):
  1. **Timeline bar badge** — a small loop/animation marker so the clip reads as animated rather than still, and (when Loop is off) reflects that state.
  2. **A `Loop` toggle in the right-hand Properties panel** (B3). It sits in the photo `Style` accordion (`PropertiesPanel.tsx:589-604`, the existing photo/video Opacity block), labelled to explain itself — e.g. `Loop` with sub-text *"Repeat the animation for the whole clip"*.

  Nothing appears for a still image. No LeftRail badge, no frame-count readout, no other UI.

---

## Technical Considerations

### Frame sourcing model — decode on demand, hold one frame

This is the core design decision and it drives everything else.

**Nothing is pre-decoded and no pixels are cached.** Per animated *asset* we hold a live `ImageDecoder` plus a small `number[]` of frame start times. Per animated *object* we hold exactly one decoded frame — the one currently on screen. Total pixel residency = one frame per visible animated clip, regardless of whether the animation is 8 frames or 800.

```
render at globalTime
  → elapsed  = globalTime - obj.startTime
  → animTime = data.loop !== false                 // B3: Loop toggle, default on
                 ? elapsed % animationDuration     //   repeat
                 : min(elapsed, animationDuration) //   play once, hold last frame
  → idx      = frameIndexAt(animTime)              // pure array lookup, no I/O
  → idx === lastIdx[obj.id] ?  draw the frame already in imageCache[obj.id]
                            :  decode({frameIndex: idx}) → replace imageCache[obj.id] → redraw
```

Why this is fast enough:

- **Index changes are rare relative to render calls.** A 12 fps GIF played back at 60 Hz changes index once every 5 rendered frames; the other 4 are a `Map.get`. Scrubbing only decodes when you cross a frame boundary.
- **Preview decodes are async and non-blocking**, using the pattern `useCanvasRenderer` already has twice: kick off the work, `cache.set(...)` on resolve, call `doRender()`. Identical in shape to the existing photo-load effect (`:77-89`) and the video `seeked → re-render` handler (`:119-130`). Worst case while scrubbing fast is that the canvas shows the previous frame for a beat — the same behaviour video already has when a seek hasn't settled.
- **Export decodes are awaited**, and export is already `await`-per-frame. Export walks strictly forward, which is `ImageDecoder`'s best case.

**The one thing that must be paid up front: frame timings.** `ImageDecoder` exposes `frameCount` for free on the track, but has **no metadata-only timing API** — per-frame `duration` is only readable off a decoded `VideoFrame`. So `probeAnimatedImage(blob)` decodes each frame once at import purely to read `image.duration`, closing each frame immediately, and keeps only the resulting `number[]`.

This **exact full probe is a deliberate choice** over the cheaper approximation (decode only frame 0 and assume every frame holds the same delay, which would be O(1)): variable-delay animations — a GIF that pauses on its punchline frame, say — are common enough that even spacing would visibly change the author's rhythm. The cost is bounded and lands in the right place: a one-off at import, **not** per session and **never** on the render path, because the timings persist on `AssetMeta` and travel with the project JSON.

**Where the timings are stored — asset, not object. (Important.)** Frame timings live on **`AssetMeta` only**, as `frameDelaysMs: number[]` — *integer milliseconds per frame*, not cumulative float seconds. Three reasons, all of which fell out of costing this:

1. **One copy per asset, not per clip.** Duplicating an animated clip, or dropping the same GIF on the timeline ten times, adds **zero** bytes. Storing the array in `PhotoData` would copy it per object (`DUPLICATE_OBJECT` deep-clones `data`).
2. **Integer ms serialises tiny.** Cumulative float seconds accumulate FP error — `0.05 + 0.05 + …` gives you `0.30000000000000004`, ~19 characters *per frame*, for no precision benefit. Per-frame integer delays are 2–3 characters, and GIF delays are quantised to 10 ms at the source anyway. This is ~6× smaller.
3. **The renderer never needed it persisted.** The in-memory `AnimatedImageSource` holds the derived cumulative `frameTimes` array (built by a one-line scan at load); the persisted form only has to survive a reload without re-probing.

`PhotoData` therefore carries only three scalars — `animated`, `animationDuration`, `loop` — so all the per-object loop maths is object-local, and only the index lookup goes through the source.

**Known cost — backwards seeks.** GIF/WebP frames can depend on prior frames (disposal/blend modes), so `decode({frameIndex: n})` may internally decode `0..n`. Chromium caches internally, and forward playback/export is the good case; scrubbing backwards through a long animation may briefly lag. Acceptable, and bounded by B11's index-change gating. If it proves annoying in practice, the mitigation is a bounded forward-decode hint, not a pixel cache.

### Costs — import time and project size

Worked for the reference case: a **10-second, 500×500 animated WebP**. Frame counts vary with authoring fps (12–30 fps ⇒ 120–300 frames); 200 frames is the central estimate used below.

**Import time (the probe).** Each frame is 0.25 Mpx — roughly 1 ms to decode, plus ~0.3 ms of `ImageDecoder` call overhead. The probe walks strictly forward, which is the cheap direction for inter-frame formats.

| | 120 frames | 200 frames | 300 frames |
|---|---|---|---|
| Probe (lossy WebP) | ~0.15 s | ~0.25 s | ~0.4 s |
| Probe (lossless WebP, 2–3× slower) | ~0.4 s | ~0.7 s | ~1.1 s |

Plus blob read + `dec.completed` buffering: tens of ms for a file this size. **Call it 0.25–1 s, once, ever** — it does not recur on project load, and a still image is unaffected.

It runs on the main thread inside `addFiles`, so the modal is momentarily unresponsive. That is acceptable because it happens while staging (before the user hits Import) and A6 is already introducing per-row loading state, which the probe reuses — the row shows as loading until it resolves. **Escape hatch if it ever feels slow:** `ImageDecoder` is worker-safe, so `probeAnimatedImage` can move to a worker with no API change. Not worth doing pre-emptively.

**Project size.** With integer-ms delays on `AssetMeta`: 200 frames × ~4 bytes (`"50,"`) ≈ **0.8 KB per unique animated asset**, plus ~40 bytes of scalars per clip. For scale, against the existing localStorage project JSON:

| Payload | Cost | Per what |
|---|---|---|
| `frameDelaysMs`, 200-frame animation | **~0.8 KB** | per unique **asset** |
| `PhotoData` scalars (`animated`/`animationDuration`/`loop`) | ~40 B | per clip |
| *(existing, for comparison)* `VideoData.waveform` — 200 raw floats | **~3.8 KB** | per **clip** |

So an animated image costs roughly **a fifth of what one audio clip's waveform already costs**, and unlike the waveform it doesn't multiply when you duplicate the clip. Twenty distinct animated assets in a project ≈ 16 KB, against a ~5 MB localStorage budget — around 0.3%. **This does not meaningfully balloon project files.** (`.gerty` export is unaffected in any practical sense: it's a zip dominated by the asset blobs themselves.)

The one pathological case worth knowing about: a very long animation (say 2000+ frames) would push a single asset toward 8 KB. Still fine, and bounded — there's no per-clip multiplier to make it worse.

### Existing types (all in `src/types.ts` unless noted)

```ts
// src/types.ts:89 — the entire current photo payload
export type PhotoData = {
  assetId: string
}

// src/types.ts:363
export type AssetMeta = {
  id: string
  type: AssetType            // 'image' | 'audio' | 'video'
  filename: string
  mimeType: string
  size: number               // bytes
  duration?: number          // seconds — currently only set for audio/video
}
```

```ts
// src/lib/renderer.ts:28 — the shared compositor signature
export function renderFrame(
  ctx: CanvasRenderingContext2D,
  objects: TimelineObject[],
  globalTime: number,
  options: { width: number; height: number },
  imageCache: Map<string, HTMLImageElement | HTMLVideoElement | ImageBitmap | VideoFrame | OffscreenCanvas>,
  editorOptions?: EditorOptions,
)
```

```ts
// src/lib/renderer.ts:595 — the photo draw case, verbatim
case 'photo': {
  const data = obj.data as PhotoData
  const img = imageCache.get(data.assetId)      // ← asset-id keyed, no time input
  if (img) {
    ctx.globalAlpha = style.opacity * progress
    drawImageCover(ctx, img, bx, by, bw, bh)
  }
  break
}

// src/lib/renderer.ts:619 — the video case, for contrast: object id first, asset id fallback
case 'video': {
  const vdata = obj.data as VideoData
  const videoEl = imageCache.get(obj.id) ?? imageCache.get(vdata.assetId)
  …
}
```

`drawImageCover` (`renderer.ts:641`) already accepts `ImageBitmap` and `VideoFrame` and duck-types dimensions for worker safety, so **no renderer change is needed to draw a decoded animation frame** — only to *pick* one.

### New types (proposed)

Additive and optional — the same back-compat pattern as `zooms?`/`markers?`/`effects?`. No migration.

```ts
// src/types.ts — extend PhotoData; absent fields ⇒ a plain still, exactly as today
// Three scalars only — NO per-frame array here. See "Where the timings are stored".
export type PhotoData = {
  assetId: string
  /** Set at import when the asset decodes to >1 frame. Absent/false = still image. */
  animated?: boolean
  /** Total loop length in seconds. Animated only. Lets all the loop maths be object-local. */
  animationDuration?: number
  /** B3: repeat the animation for the whole clip. Absent = true (loop).
   *  false = play through once, then hold the last frame. Animated only. */
  loop?: boolean
}

// src/types.ts — AssetMeta owns the frame timings: ONE copy per asset, so duplicating
// a clip costs nothing, and persisted so a project reload never re-probes the blob.
export type AssetMeta = {
  …
  /** seconds — audio/video length, AND an animated image's loop length (RESOLVED: this
   *  field is reused rather than adding `animationDuration`, so App.handleAddExistingAsset's
   *  existing `asset.duration ?? 5` at App.tsx:268 sizes an animated clip correctly with
   *  ZERO changes. Update this comment when implementing.) */
  duration?: number
  animated?: boolean
  /** Per-frame delay in INTEGER MILLISECONDS; length = frameCount. Animated images only.
   *  Deliberately not cumulative float seconds — those accumulate FP noise
   *  (0.30000000000000004) and serialise ~6x larger for no precision gain. */
  frameDelaysMs?: number[]
}
```

```ts
// NEW — src/lib/animatedImage.ts
/** Persisted form — what goes on AssetMeta. Integer ms, one entry per frame. */
export type AnimatedImageInfo = {
  animated: boolean
  frameCount: number
  duration: number            // seconds, total loop (sum of delays)
  frameDelaysMs: number[]     // per-frame delay, integer ms
}

/** In-memory form — cumulative seconds, derived from the above by a one-line scan
 *  at load. Never persisted; exists purely to make frameIndexAt a binary search. */
export type AnimatedImageTimeline = { duration: number; frameTimes: number[] }
export function buildTimeline(info: AnimatedImageInfo): AnimatedImageTimeline

/** A lazily-decoding frame source for one animated image asset.
 *  Holds a live ImageDecoder and NO decoded pixels — each getFrame call decodes. */
export type AnimatedImageSource = {
  readonly info: AnimatedImageInfo
  /** Pure lookup against the derived cumulative timeline — no I/O. `t` is loop-relative seconds. */
  frameIndexAt(t: number): number
  /** Decode a specific frame. Caller owns the returned frame and must close()/replace it. */
  getFrame(index: number): Promise<VideoFrame | null>
  destroy(): void           // closes the underlying ImageDecoder
}

/** Decode-once-to-measure: reads every frame's duration, closes each immediately,
 *  and returns only the timing array. Called at import, never at render time. */
export function probeAnimatedImage(blob: Blob): Promise<AnimatedImageInfo>

export function createAnimatedImageSource(blob: Blob, info: AnimatedImageInfo): AnimatedImageSource

/** Loop-relative time for a clip-relative elapsed, honouring the Loop toggle (B3).
 *  PURE and object-local — needs no asset lookup, no source, no I/O. Shared by preview
 *  and every export path so they can't drift. Returns -1 for a non-animated photo. */
export function animTimeAt(data: PhotoData, elapsed: number): number
```

The two-step split (`animTimeAt(data, elapsed)` → `source.frameIndexAt(animTime)`) is what lets the loop/hold semantics live on the object while the per-frame table lives once per asset.

`animatedFrameIndexAt` being the single shared implementation is what guarantees B5's preview/export parity — the same reason `mediaTiming.ts` centralises the video trim maths.

### `ImageDecoder` — the decode mechanism

The WebCodecs `ImageDecoder` is the only browser API exposing *individual frames* of an animated GIF/WebP/APNG:

```ts
const dec = new ImageDecoder({ data: await blob.arrayBuffer(), type: blob.type })
await dec.completed                                     // whole animation buffered
const track = dec.tracks.selectedTrack                  // .frameCount, .animated, .repetitionCount
const { image } = await dec.decode({ frameIndex: i })   // image: VideoFrame
image.duration                                          // µs — this frame's delay
image.timestamp                                         // µs — cumulative start
```

Notes that shape the implementation:

- **Availability:** Chromium-only (Chrome/Edge 94+); absent in Firefox and Safari. `ImageDecoder.isTypeSupported(mime)` is the feature test. Consistent with the app's existing `VideoEncoder`/`VideoDecoder` dependency; B8's still-frame degradation covers everyone else.
- **Available in Web Workers** — so `exportWorker.ts` can use it directly.
- **Frame lifetime:** `decode()` returns a `VideoFrame` that must be `.close()`d. Under B10 each object holds exactly one at a time — closing the outgoing frame when replacing it in `imageCache` is the critical leak-avoidance step, and it must also happen on object removal, project load, and export teardown.
- **`type` must be a real mime.** `AssetMeta.mimeType` comes from `File.type`, which can be `''`. Fall back to an extension→mime map, then a magic-byte sniff (`GIF8`, `RIFF…WEBP`, `\x89PNG` + `acTL` chunk for APNG).
- **Animated AVIF** support is inconsistent; treat as best-effort under B8.
- **Zero-duration frames:** GIFs with a 0/10 ms delay are common and browsers clamp to ~100 ms. Apply one clamp (suggest: `duration <= 10ms` → 100 ms, matching `<img>` behaviour) inside `probeAnimatedImage`, so the clamp is baked into the persisted `frameDelaysMs` and preview/export can't disagree.
- **Rounding:** `image.duration` is microseconds; round to whole milliseconds when building `frameDelaysMs`. Sub-millisecond frame delays are meaningless here, and exact integers are what keep the persisted array small.
- **Probe cost is the import cost.** `probeAnimatedImage` is the only O(frameCount) operation in this spec — see *Costs* above for measured expectations and the worker escape hatch.

### The four call sites that populate `imageCache`

| # | File | Today (photos) | Change |
|---|---|---|---|
| 1 | `src/hooks/useCanvasRenderer.ts:67-92` | effect loads `loadImage(getAssetUrl(assetId))`, cached by `assetId` | for animated photos create an `AnimatedImageSource` per asset; in `doRender` (`:37-45`, beside the video-element merge) compute the index, and if it differs from the last index for `obj.id`, fire an async decode that closes the old frame, sets the new one under **`obj.id`**, and re-renders |
| 2 | `src/lib/ffmpegExport.ts:252-259` (WebCodecs) | `imageCache.set(assetId, await loadImage(url))` | build sources for animated assets alongside `videoSources`; in the per-frame loop (`:338-361`, where video frames are sourced) `await` the animated frame under `obj.id` on index change |
| 3 | `src/lib/exportWorker.ts:90-100` | `imageCache.set(assetId, await createImageBitmap(blob))` | same shape; blobs already arrive via `assetBlobs`, `ImageDecoder` works in workers |
| 4 | `src/lib/ffmpegExport.ts:639-647` (MediaRecorder fallback) | `imageCache.set(assetId, await loadImage(url))` | same shape |

`renderer.ts` `case 'photo'` becomes object-id-first with an asset-id fallback — **structurally identical to the existing `case 'video'` at `renderer.ts:619`**:

```ts
const img = imageCache.get(obj.id) ?? imageCache.get(data.assetId)
```

That one line plus B7 means a still photo (never written under `obj.id`) resolves through the fallback to its existing asset-id entry — bit-identical output.

### Import-path touch points (both features)

- `src/components/ImportModal.tsx`
  - `:89-104` paste effect — add the text/URL branch (A1–A3, A11) after the existing image-item loop.
  - `:41-87` `addFiles` — for images, `await probeAnimatedImage(file)` and stash the result on `PendingAsset` (B1, B4).
  - `:21-28` `PendingAsset` — gains `status: 'ready' | 'loading' | 'error'`, `error?: string`, `sourceUrl?: string`, `animation?: AnimatedImageInfo`.
  - `:151-266` `handleImport` — animated images use `animationDuration` instead of the hard-coded `duration: 5` at `:192`; loading/error rows are excluded from the import set; the Import button is disabled while any row is loading.
  - `:322-328` drop-zone copy (A10).
- `src/lib/assetStore.ts` — `storeAsset` records the probe on `AssetMeta` (B1). `fetchAssetFromUrl(url): Promise<File>` also belongs here rather than in the component, so the CORS/type/status error mapping is testable and `ImportModal` stays presentational.
- `src/components/App.tsx:264-285` `handleAddExistingAsset` — re-adding an animated image from the LeftRail must reproduce the same `PhotoData` fields and clip duration as a fresh import (currently hard-codes `duration: 5` at `:272`).
- `src/components/Timeline.tsx` — the animated badge (B12.1), near the existing per-type bar decoration (the animateIn stripe at `:1244` is the closest precedent).
- `src/components/PropertiesPanel.tsx:589-604` — the `Loop` toggle (B12.2) in the existing photo/video `Style` accordion, rendered only when `obj.type === 'photo' && (obj.data as PhotoData).animated`. It's a plain `UPDATE_OBJECT` writing the **whole** `data` object (`{ ...data, loop }`) — `UPDATE_OBJECT` shallow-merges, so a partial `data` would drop `assetId`. One dispatch = one undo entry; no transient/commit needed for a checkbox.
- `src/lib/projectStorage.ts:67-95` — `.gerty` import restores blobs; the `PhotoData` scalars and `AssetMeta.frameDelaysMs` ride along inside `project.json`, so there is nothing to do *if* they were written at import. Round-trip must be verified — this is what makes a reload free of re-probing.

### Risks / constraints

- **Canvas tainting** — restated because it is fatal: any path that draws a cross-origin image without CORS-clean bytes taints the canvas and breaks *all* export, not just that object.
- **`VideoFrame` leaks.** B10's one-frame-per-object model means every replacement must close its predecessor. Missing a close is a GPU-memory leak that won't show up in a quick click-through. Teardown paths: object deleted, project replaced (`SET_PROJECT`), component unmount, export finish/abort (`exportWorker.ts:206` already does this for video frames).
- **Main-thread export already freezes the UI** (known gotcha, spec 09). On-demand decoding adds a small per-frame cost only when the index changes; it does not add a large up-front stall, which is a point in this model's favour.
- **60 Hz re-render** (known gotcha) — B11's index gating exists so animated images don't make it worse.
- The URL fetch is the app's **first outbound network request for user content**; it discloses the paste to the target host and nobody else (A7).

---

## Related Systems and Tasks

- `CLAUDE.md` → *Rendering pipeline*, *File map*, *Gotchas* (main-thread export, 60 Hz re-render, `imageCache` keying).
- `SPECS/07-import-assets.md` / `TASKS/07-import-assets.md` — where `PhotoData.src` (base64) became `PhotoData.assetId` and the IndexedDB asset store was introduced. Establishes "blobs in IndexedDB, ids in the project".
- `SPECS/08-refactor-to-webcodecs-video-export.md` / `TASKS/08-webcodecs-refactor.md` — added `VideoFrame` to the `imageCache` union and duck-typed `drawImageCover` for worker safety. **The precedent this spec follows**: a new frame type enters through `imageCache`, the renderer barely changes.
- `SPECS/09-in-video-perf.md` — frame-source lifetime/ownership conventions and the worker-export resurrection that call-site #3 depends on.
- `SPECS/14-video-sequencing.md` + `src/lib/mediaTiming.ts` — the trim/speed model deliberately *not* reused here (B3: no controls).
- `src/lib/videoDecoder.ts` — the closest existing analogue to `animatedImage.ts`; follow its structure, tiered fallback and error handling.

---

## Open Questions

**None — all resolved.** For the record, the decisions that shaped this spec:

| Question | Decision |
|---|---|
| CORS-blocked URL paste | **No proxy.** Clear, human error row telling the user to save the file and drag it in. Never `no-cors`, never an `<img>` fallback (canvas tainting would break all export). |
| URL paste media types | **Images, audio and video** — the same classification the drop/browse path already applies. |
| Max URL download | **Pre-reject above `SIZE_WARN_PER_FILE` (50 MB)** on `Content-Length`; no-`Content-Length` responses fall through to the existing post-download warnings. |
| Decoded-frame memory | **Decode on demand, retain one frame per clip.** No pre-decoded pixel buffer, no LRU. Decode is gated on frame-*index* change. |
| Frame timing source | **Full exact probe at import** (decode every frame once for its duration, close immediately, persist the delays). Rejected the O(1) "assume even delays" approximation because variable-delay animations are common and it would visibly alter their rhythm. Costed at ~0.25–1 s for a 10 s 500×500 WebP, once. |
| Where timings are persisted | **`AssetMeta.frameDelaysMs`, integer ms** — one copy per asset (duplicating a clip is free), ~6× smaller than cumulative float seconds. `PhotoData` carries three scalars only. |
| Playback controls | **Native speed, no trim, no rate.** One control only: a **Loop** toggle (default on) in the right-hand Properties panel. |
| UI surface | **Timeline bar badge + the Loop toggle.** Nothing else — no LeftRail badge, no frame-count readout, nothing for still images. |

---

## Acceptance Criteria

**A — URL paste**

- [ ] With the modal open and an image URL on the clipboard, Ctrl+V shows a loading row, then a normal pending row with a working thumbnail, correct filename, and size.
- [ ] Importing that row produces a photo object identical in every way to one produced by dragging the same file in.
- [ ] The imported asset survives a refresh (with `persistProject: true`) and a `.gerty` export→import round-trip **with no network access**.
- [ ] Copying an image *itself* (not a link) still works exactly as before — the binary item wins and no duplicate URL row appears.
- [ ] Pasting a URL that CORS-blocks shows a specific, human error row (not a silent no-op, not a stack trace) and the modal remains usable.
- [ ] Pasting a non-URL string does nothing visible.
- [ ] Pasting a URL to an **MP4** stages a video asset with its duration and waveform, exactly as dropping the file would; same for an **MP3**.
- [ ] Pasting a URL to a non-media resource (e.g. an HTML page) shows an error row naming the problem.
- [ ] Pasting a URL to a file whose `Content-Length` exceeds 50 MB shows a too-big error row **without** downloading it.
- [ ] Pasting two newline-separated URLs stages two rows, and one failing doesn't affect the other.
- [ ] The Import button is disabled while any row is still loading.
- [ ] The drop-zone copy mentions pasting an image *and* pasting a link.

**B — Animated images**

- [ ] Adding an animated WebP creates a clip whose default duration equals one animation loop, with an animated badge on its timeline bar.
- [ ] Scrubbing the playhead across that clip steps the animation forward *and backward* in the render area, and parking the playhead holds a specific frame.
- [ ] Pressing play animates it at native speed; it loops if the clip is longer than one loop.
- [ ] A **variable-delay** GIF (one that holds a frame noticeably longer than the rest) reproduces that rhythm in both preview and export — not evenly-spaced frames.
- [ ] The same is true of an animated **GIF** and an **APNG**.
- [ ] The `Loop` toggle appears in the Properties panel for an animated photo and **not** for a still one; turning it off makes a clip longer than the animation play once and hold its last frame, in preview *and* export; the change is a single undo step.
- [ ] Exporting produces an MP4 in which the image animates, and the frame at time *t* matches the preview at time *t*.
- [ ] Exporting via the worker path produces the same result.
- [ ] Two clips of the same animated asset at different start times show different frames simultaneously.
- [ ] Duplicating an animated clip and moving it in time gives an independent frame cursor.
- [ ] A **still** PNG/JPG renders byte-identically to before this change, in preview and export.
- [ ] Keyframes, enter/exit, camera zoom, effects, opacity and rotation all behave on an animated clip exactly as on a still.
- [ ] Hiding an animated clip skips it (no decode work, no render) in preview and export.
- [ ] A long animation (100+ frames, 1080p) plays and exports without memory growth — deleting the clip or finishing the export releases everything.
- [ ] Re-opening a saved project with an animated image does **not** re-run the probe (it reads `frameDelaysMs` off the asset) and the animation plays immediately.
- [ ] Duplicating an animated clip ten times adds only scalars to the saved project — the frame-delay array appears exactly **once**, on the asset.
- [ ] In a browser without `ImageDecoder`, an animated image renders as its first frame everywhere and nothing crashes.
- [ ] `npx tsc -b` is green.

---

## Implementation Notes

**Suggested order** — A and B are fully independent; B is the bigger piece.

*Feature B, bottom-up (renderer wired late, so nothing is half-connected):*

1. **`src/lib/animatedImage.ts`** — new module: `probeAnimatedImage`, `buildTimeline`, `createAnimatedImageSource`, `animTimeAt`. Model on `src/lib/videoDecoder.ts` (same error posture, same lifetime discipline). Everything here must be worker-safe — no DOM (this is also what keeps the probe-in-a-worker escape hatch open).
2. **`src/types.ts`** — additive optional fields on `PhotoData` and `AssetMeta`. No reducer changes, no migration; `UPDATE_OBJECT` shallow-merges so `data` is always passed whole anyway.
3. **`src/lib/assetStore.ts`** — probe on `storeAsset` for image blobs; record on `AssetMeta`.
4. **`src/lib/renderer.ts:595`** — `case 'photo'` becomes `imageCache.get(obj.id) ?? imageCache.get(data.assetId)`. **This is the only renderer change.**
5. **`src/hooks/useCanvasRenderer.ts`** — mirror the video pattern: create/destroy sources in the asset-loading effect (`:67-92`); do the index-gated decode-and-swap in `doRender` where video elements are merged (`:37-45`). Close the outgoing `VideoFrame` on every swap and on teardown.
6. **Export paths** — `ffmpegExport.ts` (setup `:252`, per-frame `:338`, MediaRecorder `:639`) and `exportWorker.ts:90`. Keep the animated-source map keyed by object id next to `videoSources`/`videoDecoders` and tear it down in the same cleanup that closes video frames (`exportWorker.ts:206`).
7. **Import wiring** — `ImportModal.handleImport` (clip duration + `PhotoData` fields) and `App.handleAddExistingAsset:264-285`.
8. **UI** — `Timeline.tsx` animated badge and the `PropertiesPanel.tsx` `Loop` toggle (B12). Do these last; by then `animatedFrameIndexAt` already honours `data.loop`, so the toggle is pure wiring.

*Feature A:*

9. **`src/lib/assetStore.ts`** — `fetchAssetFromUrl(url): Promise<File>`: validate scheme, `fetch`, check status + `Content-Type`, sniff if needed, derive filename, wrap in `File`. Map failures to typed, user-facing messages (`cors`, `network`, `http-status`, `unsupported-type`, `too-large`) rather than raw exceptions — the error copy *is* this feature's UX.
10. **`ImportModal`** — extend `PendingAsset` with `status`/`error`/`sourceUrl`; add the text branch to the paste effect (read `getData('text/plain')` **synchronously before any `await`** — clipboard data is unavailable once the handler yields); render loading/error row variants; update the copy.

**Patterns to follow:** the video clip's object-id `imageCache` keying (`renderer.ts:619`); `videoDecoder.ts`'s tiered fallback and `console.warn`-don't-throw posture; additive-optional-field back-compat (`zooms?`/`markers?`/`effects?`); centralised timing maths (`mediaTiming.ts` as the model for `animatedFrameIndexAt`).

**Verification:** static only — `npx tsc -b`. Do not run the dev server (`.claude/skills/verify/SKILL.md`); hand over a click-through checklist derived from the acceptance criteria. Testing needs an animated WebP, a GIF, an APNG, one **variable-delay** GIF (to prove the exact-timing probe was worth it), and one long animation (100+ frames, 1080p) for the memory check.

---

*This specification is ready for implementation. Use `/task 28-image-stuff` to begin development.*

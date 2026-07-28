import type { AssetMeta, PhotoData, TimelineObject } from '../types'

/**
 * Animated image (GIF / animated WebP / APNG) frame sourcing — spec 28 B.
 *
 * The compositor (`renderer.ts`) is pure: it draws whatever the caller put in
 * `imageCache`. Video already solves "which frame at time t" by keying decoded
 * frames under the OBJECT id; animated photos get the same treatment, so this
 * module is the animated-image twin of `videoDecoder.ts`.
 *
 * Memory model (spec 28 B10): NOTHING is pre-decoded and no pixels are cached.
 * A source holds a live ImageDecoder plus a small timing array; the caller holds
 * exactly ONE decoded frame per clip — the one currently on screen. So an 800-frame
 * animation costs the same as an 8-frame one.
 *
 * IMPORTANT: every VideoFrame returned by getFrame() MUST be .close()'d by the
 * caller (when it is replaced, and on teardown) or it leaks GPU memory.
 *
 * Everything here is worker-safe (no DOM) — ImageDecoder exists in workers, which
 * is what lets `exportWorker.ts` use it and keeps the probe-in-a-worker option open.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Persisted form — what goes on AssetMeta. Integer ms, one entry per frame. */
export type AnimatedImageInfo = {
  animated: boolean
  frameCount: number
  duration: number            // seconds, total loop (sum of delays)
  frameDelaysMs: number[]     // per-frame delay, integer ms
}

/**
 * In-memory form — cumulative seconds, derived from AnimatedImageInfo by a single
 * scan at load. Never persisted: cumulative floats accumulate FP noise and
 * serialise ~6x larger than the integer-ms delays for no precision gain.
 */
export type AnimatedImageTimeline = {
  duration: number
  frameTimes: number[]        // seconds, cumulative start time of each frame
}

/** A lazily-decoding frame source for one animated image asset. */
export type AnimatedImageSource = {
  readonly info: AnimatedImageInfo
  /** Pure lookup against the derived timeline — no I/O. `t` is loop-relative seconds. */
  frameIndexAt(t: number): number
  /** Decode one frame. Caller OWNS the result and must close()/replace it. */
  getFrame(index: number): Promise<VideoFrame | null>
  destroy(): void
}

/** A still image (or one we failed to probe) — the shape B7/B8 fall back to. */
export const STILL_IMAGE_INFO: AnimatedImageInfo = {
  animated: false,
  frameCount: 1,
  duration: 0,
  frameDelaysMs: [],
}

// GIF/WebP authoring tools commonly emit 0ms or 10ms delays meaning "as fast as
// possible"; every browser clamps those to ~100ms when rendering an <img>. We bake
// the same clamp into the probe so the persisted timings already carry it and
// preview/export can never disagree about it.
const MIN_FRAME_DELAY_MS = 100
const CLAMP_BELOW_MS = 10

// ---------------------------------------------------------------------------
// Mime detection
// ---------------------------------------------------------------------------

/**
 * ImageDecoder needs a real mime type, but `File.type` is '' for some drops and
 * some servers send `application/octet-stream`. Sniff the container magic bytes,
 * which is also how we tell an APNG (PNG + an `acTL` chunk) from a plain PNG.
 */
export async function sniffImageMime(blob: Blob): Promise<string | null> {
  const head = new Uint8Array(await blob.slice(0, 64).arrayBuffer())
  if (head.length < 12) return null

  const ascii = (o: number, n: number) =>
    String.fromCharCode(...head.subarray(o, o + n))

  if (ascii(0, 3) === 'GIF') return 'image/gif'
  if (ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WEBP') return 'image/webp'
  if (head[0] === 0xff && head[1] === 0xd8) return 'image/jpeg'
  if (ascii(4, 8) === 'ftypavif') return 'image/avif'
  if (
    head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47
  ) {
    // APNG is a PNG whose chunk list contains `acTL`. It always appears before the
    // first IDAT, so a bounded scan of the header region is enough.
    const probe = new Uint8Array(await blob.slice(0, 4096).arrayBuffer())
    for (let i = 8; i < probe.length - 4; i++) {
      if (
        probe[i] === 0x61 && probe[i + 1] === 0x63 &&
        probe[i + 2] === 0x54 && probe[i + 3] === 0x4c
      ) return 'image/apng'
      if (
        probe[i] === 0x49 && probe[i + 1] === 0x44 &&
        probe[i + 2] === 0x41 && probe[i + 3] === 0x54
      ) break // reached image data — no acTL, so it's a still PNG
    }
    return 'image/png'
  }
  return null
}

/**
 * Mime types to try with ImageDecoder, best first. The sniffed container wins over the
 * declared type, and APNG falls back to `image/png` because browsers disagree about
 * whether `image/apng` is an accepted decoder type — the PNG decoder handles APNG
 * either way, so trying both is what makes APNG animate rather than silently degrade.
 */
async function decodeMimeCandidates(blob: Blob): Promise<string[]> {
  const out: string[] = []
  const sniffed = await sniffImageMime(blob)
  if (sniffed) {
    out.push(sniffed)
    if (sniffed === 'image/apng') out.push('image/png')
  }
  if (blob.type?.startsWith('image/') && !out.includes(blob.type)) out.push(blob.type)
  return out
}

/** First candidate this browser will actually decode, or null. */
async function firstSupportedMime(blob: Blob): Promise<string | null> {
  for (const mime of await decodeMimeCandidates(blob)) {
    try {
      if (await ImageDecoder.isTypeSupported(mime)) return mime
    } catch {
      // treat as unsupported and try the next candidate
    }
  }
  return null
}

/**
 * Only these containers can carry an animation, so a plain PNG/JPEG never builds a
 * decoder at all. Tested against the SNIFFED type — `image/png` is excluded here
 * precisely because the sniff already distinguishes APNG from a still PNG.
 */
function couldBeAnimated(mime: string): boolean {
  return mime === 'image/gif' || mime === 'image/webp' ||
    mime === 'image/apng' || mime === 'image/avif'
}

// ---------------------------------------------------------------------------
// Probe
// ---------------------------------------------------------------------------

/**
 * Decode-once-to-measure. ImageDecoder exposes `frameCount` for free but has NO
 * metadata-only timing API — a frame's `duration` is only readable off the decoded
 * VideoFrame — so measuring exact timings means decoding every frame once. Each is
 * closed immediately; only the integer-ms delay array survives.
 *
 * This is the single O(frameCount) operation in the feature. It runs ONCE per asset
 * at import (~0.25-1s for a 10s 500x500 WebP), never per session and never on the
 * render path, because the result persists on AssetMeta.
 *
 * Never throws: anything unexpected (no ImageDecoder, unsupported codec, corrupt
 * data) degrades to STILL_IMAGE_INFO, i.e. today's first-frame-only behaviour (B8).
 */
export async function probeAnimatedImage(blob: Blob): Promise<AnimatedImageInfo> {
  if (typeof ImageDecoder === 'undefined') return STILL_IMAGE_INFO

  let candidates: string[]
  try {
    candidates = await decodeMimeCandidates(blob)
  } catch {
    return STILL_IMAGE_INFO
  }
  if (candidates.length === 0 || !couldBeAnimated(candidates[0])) return STILL_IMAGE_INFO

  let decoder: ImageDecoder | null = null
  try {
    const mime = await firstSupportedMime(blob)
    if (!mime) return STILL_IMAGE_INFO

    decoder = new ImageDecoder({ data: await blob.arrayBuffer(), type: mime })
    await decoder.completed          // whole animation buffered
    await decoder.tracks.ready

    const track = decoder.tracks.selectedTrack
    if (!track || !track.animated || track.frameCount < 2) return STILL_IMAGE_INFO

    const frameDelaysMs: number[] = []
    for (let i = 0; i < track.frameCount; i++) {
      const { image } = await decoder.decode({ frameIndex: i })
      // `duration` is microseconds and may be null on a malformed frame.
      const ms = Math.round((image.duration ?? 0) / 1000)
      image.close()
      frameDelaysMs.push(ms <= CLAMP_BELOW_MS ? MIN_FRAME_DELAY_MS : ms)
    }

    const totalMs = frameDelaysMs.reduce((a, b) => a + b, 0)
    if (totalMs <= 0) return STILL_IMAGE_INFO

    return {
      animated: true,
      frameCount: frameDelaysMs.length,
      duration: totalMs / 1000,
      frameDelaysMs,
    }
  } catch (err) {
    console.warn(
      `[animatedImage] probe failed (${err instanceof Error ? err.message : String(err)}); treating as a still image`,
    )
    return STILL_IMAGE_INFO
  } finally {
    decoder?.close()
  }
}

// ---------------------------------------------------------------------------
// Timeline + frame selection
// ---------------------------------------------------------------------------

/** Derive cumulative frame start times (seconds) from the persisted integer-ms delays. */
export function buildTimeline(info: AnimatedImageInfo): AnimatedImageTimeline {
  const frameTimes: number[] = []
  let acc = 0
  for (const ms of info.frameDelaysMs) {
    frameTimes.push(acc / 1000)
    acc += ms
  }
  return { duration: acc / 1000, frameTimes }
}

/** Index of the frame covering a loop-relative time. Binary search; holds at the ends. */
export function frameIndexAt(timeline: AnimatedImageTimeline, t: number): number {
  const { frameTimes } = timeline
  if (frameTimes.length === 0) return 0
  if (t <= 0) return 0
  if (t >= timeline.duration) return frameTimes.length - 1

  let lo = 0
  let hi = frameTimes.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (frameTimes[mid] <= t) lo = mid
    else hi = mid - 1
  }
  return lo
}

/**
 * Loop-relative time for a clip-relative elapsed, honouring the Loop toggle (B3).
 * Pure and object-local — no asset lookup, no source, no I/O — which is what lets
 * preview and every export path share one implementation and never drift.
 *
 * Returns -1 when the object isn't an animated image (nothing to select).
 */
export function animTimeAt(data: PhotoData, elapsed: number): number {
  if (!data.animated) return -1
  const loopLength = data.animationDuration ?? 0
  if (loopLength <= 0) return -1
  const e = Math.max(0, elapsed)
  // `loop !== false` — absent defaults to looping (B3).
  return data.loop !== false ? e % loopLength : Math.min(e, loopLength)
}

/** Convenience: does this photo object need per-frame sourcing at all? */
export function isAnimatedPhoto(data: PhotoData): boolean {
  return data.animated === true && (data.animationDuration ?? 0) > 0
}

// ---------------------------------------------------------------------------
// Source
// ---------------------------------------------------------------------------

/**
 * Build a decode-on-demand source for an already-probed animated blob.
 *
 * Returns null when the blob can't be decoded here (no ImageDecoder, unsupported
 * type) so callers fall back to the plain still-image path (B8) rather than
 * branching on browser support themselves.
 */
export async function createAnimatedImageSource(
  blob: Blob,
  info: AnimatedImageInfo,
): Promise<AnimatedImageSource | null> {
  if (typeof ImageDecoder === 'undefined' || !info.animated) return null

  let decoder: ImageDecoder
  try {
    const mime = await firstSupportedMime(blob)
    if (!mime) return null
    decoder = new ImageDecoder({ data: await blob.arrayBuffer(), type: mime })
    await decoder.completed
    await decoder.tracks.ready
  } catch (err) {
    console.warn(
      `[animatedImage] source init failed (${err instanceof Error ? err.message : String(err)}); falling back to a still frame`,
    )
    return null
  }

  const timeline = buildTimeline(info)
  let destroyed = false

  return {
    info,
    frameIndexAt: (t: number) => frameIndexAt(timeline, t),
    async getFrame(index: number): Promise<VideoFrame | null> {
      if (destroyed) return null
      const i = Math.max(0, Math.min(info.frameCount - 1, index))
      try {
        const { image } = await decoder.decode({ frameIndex: i })
        // decode() can resolve after destroy() raced ahead of it.
        if (destroyed) {
          image.close()
          return null
        }
        return image
      } catch (err) {
        console.warn(
          `[animatedImage] frame ${i} failed to decode: ${err instanceof Error ? err.message : String(err)}`,
        )
        return null
      }
    },
    destroy() {
      if (destroyed) return
      destroyed = true
      try {
        decoder.close()
      } catch {
        // already closed
      }
    },
  }
}

// ---------------------------------------------------------------------------
// Export helpers
// ---------------------------------------------------------------------------

/** The `imageCache` renderFrame reads. Widest form; narrower caches assign to it fine. */
type FrameCache = Map<
  string,
  HTMLImageElement | HTMLVideoElement | ImageBitmap | VideoFrame | OffscreenCanvas
>

/** Frame sources for one export run, plus the per-object bookkeeping to drive them. */
export type AnimatedExportSources = {
  /** Empty when the project has no animated images — every call becomes a no-op. */
  readonly size: number
  /** Advance each animated clip's frame in `imageCache` to `globalTime`. */
  update(objects: TimelineObject[], globalTime: number, imageCache: FrameCache): Promise<void>
  /** Close every decoder + retained frame. Safe to call twice. */
  destroy(imageCache: FrameCache): void
}

/** Rebuild the persisted probe result off an asset record, or null if it isn't animated. */
export function animationInfoFromAsset(asset: AssetMeta | undefined): AnimatedImageInfo | null {
  if (!asset?.animated || !asset.frameDelaysMs?.length) return null
  return {
    animated: true,
    frameCount: asset.frameDelaysMs.length,
    duration: asset.duration ?? 0,
    frameDelaysMs: asset.frameDelaysMs,
  }
}

/**
 * Build the animated-image frame sources for an export run — one decoder per animated
 * ASSET, retaining one frame per animated OBJECT. Shared by all three export paths
 * (WebCodecs, worker, MediaRecorder) so a frame exported at time t is always the frame
 * the preview shows at time t.
 *
 * Never throws: an asset that can't be decoded here is simply absent from the map, and
 * its object falls back to the still first frame already in the cache (B8).
 */
export async function createAnimatedExportSources(
  objects: TimelineObject[],
  assets: AssetMeta[] | undefined,
  getBlob: (assetId: string) => Blob | undefined,
): Promise<AnimatedExportSources> {
  const sources = new Map<string, AnimatedImageSource>()
  const lastIndex = new Map<string, number>()

  const assetIds = new Set(
    objects
      .filter((o) => o.type === 'photo' && !o.hidden && isAnimatedPhoto(o.data as PhotoData))
      .map((o) => (o.data as PhotoData).assetId),
  )

  for (const assetId of assetIds) {
    const info = animationInfoFromAsset(assets?.find((a) => a.id === assetId))
    const blob = getBlob(assetId)
    if (!info || !blob) continue
    const source = await createAnimatedImageSource(blob, info)
    if (source) sources.set(assetId, source)
  }

  return {
    size: sources.size,

    async update(objs, globalTime, imageCache) {
      if (sources.size === 0) return
      for (const obj of objs) {
        if (obj.type !== 'photo' || obj.hidden) continue
        const data = obj.data as PhotoData
        const source = sources.get(data.assetId)
        if (!source) continue

        const elapsed = globalTime - obj.startTime
        if (elapsed < 0 || elapsed >= obj.duration) continue

        const t = animTimeAt(data, elapsed)
        if (t < 0) continue

        const index = source.frameIndexAt(t)
        if (lastIndex.get(obj.id) === index) continue   // already cached — no decode

        const frame = await source.getFrame(index)
        if (!frame) continue
        closeFrame(imageCache.get(obj.id))
        imageCache.set(obj.id, frame)
        lastIndex.set(obj.id, index)
      }
    },

    destroy(imageCache) {
      for (const objectId of lastIndex.keys()) {
        closeFrame(imageCache.get(objectId))
        imageCache.delete(objectId)
      }
      lastIndex.clear()
      for (const source of sources.values()) source.destroy()
      sources.clear()
    },
  }
}

/** Close a cache entry if it's a decoded frame — the leak guard for the one-frame model. */
function closeFrame(entry: unknown): void {
  if (typeof VideoFrame !== 'undefined' && entry instanceof VideoFrame) entry.close()
}

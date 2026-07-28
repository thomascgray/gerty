import { useEffect, useRef, useCallback } from 'react'
import type { TimelineObject, PhotoData, AssetMeta } from '../types'
import { renderFrame, loadImage } from '../lib/renderer'
import { getAssetUrl, getAssetBlob } from '../lib/assetStore'
import { getVideoElement, subscribeVideoReady } from '../lib/mediaRegistry'
import {
  animTimeAt,
  isAnimatedPhoto,
  createAnimatedImageSource,
  type AnimatedImageSource,
} from '../lib/animatedImage'
import type { EditorOptions } from '../lib/renderer'

/** Close a cache entry if it's a decoded frame we own (spec 28 B10 — no leaks). */
function closeIfFrame(entry: unknown): void {
  if (typeof VideoFrame !== 'undefined' && entry instanceof VideoFrame) entry.close()
}

/**
 * Draws the timeline onto a canvas.
 *
 * Photos are loaded/cached here. Video frames come from the shared PLAYING
 * elements owned by useAudioPlayback (via mediaRegistry) — the canvas never
 * seeks them. While playing, a rAF loop blits each element's current frame, so
 * the canvas stays smooth and decoupled from React's 60Hz playback state. While
 * paused, it renders on demand (scrubbing) and after a seek settles.
 *
 * Animated images (spec 28) sit between the two: one ImageDecoder per animated
 * ASSET, and exactly one decoded frame retained per animated OBJECT — the one on
 * screen. A decode only fires when the resolved frame INDEX changes, so a 12fps
 * GIF decodes on ~1 in 5 rendered frames at 60Hz playback, and scrubbing decodes
 * only when you cross a frame boundary.
 */
export function useCanvasRenderer(
  canvasRef: React.RefObject<HTMLCanvasElement | null>,
  objects: TimelineObject[],
  globalTime: number,
  isPlaying: boolean,
  width: number,
  height: number,
  editorOptions?: EditorOptions,
  assets?: AssetMeta[],
) {
  // Photos cached by assetId; video elements and animated-image frames are merged
  // in per-render (by object id).
  const imageCacheRef = useRef<Map<string, HTMLImageElement | HTMLVideoElement | VideoFrame>>(new Map())
  const globalTimeRef = useRef(globalTime)
  globalTimeRef.current = globalTime

  // Animated images: one source per ASSET (null = probed/unavailable, don't retry),
  // plus the last-decoded frame index and in-flight guard per OBJECT.
  const animSourcesRef = useRef<Map<string, AnimatedImageSource | null>>(new Map())
  const animPendingRef = useRef<Set<string>>(new Set())
  const animIndexRef = useRef<Map<string, number>>(new Map())
  const animDecodingRef = useRef<Set<string>>(new Set())
  // Lets an async decode trigger a redraw without capturing a stale doRender.
  const doRenderRef = useRef<() => void>(() => {})

  const doRender = useCallback(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    // Pull the current video element for each video object from the shared
    // registry (keyed by object id — matches renderer.ts's lookup).
    const cache = imageCacheRef.current
    for (const obj of objects) {
      if (obj.type === 'video') {
        const el = getVideoElement(obj.id)
        if (el) cache.set(obj.id, el)
      }
    }

    // Animated images: pick the frame for the playhead and decode it if it changed.
    // The decode is async — we draw whatever frame is already cached now and redraw
    // when the new one lands, exactly like a video element that hasn't finished seeking.
    for (const obj of objects) {
      if (obj.type !== 'photo' || obj.hidden) continue
      const data = obj.data as PhotoData
      if (!isAnimatedPhoto(data)) continue

      const source = animSourcesRef.current.get(data.assetId)
      if (!source) continue

      const elapsed = globalTimeRef.current - obj.startTime
      if (elapsed < 0 || elapsed >= obj.duration) continue  // not on screen

      const t = animTimeAt(data, elapsed)
      if (t < 0) continue

      const index = source.frameIndexAt(t)
      if (animIndexRef.current.get(obj.id) === index) continue   // already showing it
      if (animDecodingRef.current.has(obj.id)) continue          // one decode in flight

      animDecodingRef.current.add(obj.id)
      source.getFrame(index).then((frame) => {
        animDecodingRef.current.delete(obj.id)
        if (!frame) return
        // Replace the retained frame — closing the outgoing one is what keeps
        // residency at exactly one frame per clip.
        closeIfFrame(cache.get(obj.id))
        cache.set(obj.id, frame)
        animIndexRef.current.set(obj.id, index)
        doRenderRef.current()
      })
    }

    renderFrame(ctx, objects, globalTimeRef.current, {
      width: canvas.width,
      height: canvas.height,
    }, cache, editorOptions)
  }, [canvasRef, objects, editorOptions])

  useEffect(() => { doRenderRef.current = doRender }, [doRender])

  // Own the render canvas's backing-store size. Setting canvas.width/height clears it, so we
  // resize (only when it actually changed) and immediately redraw in the same effect — otherwise
  // switching aspect ratio while paused would leave the canvas blank until the next scrub/play.
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width
      canvas.height = height
    }
    doRender()
  }, [width, height, doRender, canvasRef])

  // Load images for photo objects from the asset store.
  useEffect(() => {
    let cancelled = false
    const cache = imageCacheRef.current
    const photoAssetIds = objects
      .filter((o) => o.type === 'photo')
      .map((o) => (o.data as PhotoData).assetId)
      .filter((id) => !cache.has(id))

    if (photoAssetIds.length === 0) return

    ;(async () => {
      for (const assetId of photoAssetIds) {
        if (cancelled) return
        const url = getAssetUrl(assetId)
        if (!url) continue
        try {
          cache.set(assetId, await loadImage(url))
        } catch {
          // skip failed images
        }
      }
      if (!cancelled) doRender()
    })()

    return () => { cancelled = true }
  }, [objects, doRender])

  // Animated images: build one decoder per animated asset in play, and release
  // decoders + retained frames for anything that has left the project.
  useEffect(() => {
    let cancelled = false
    const cache = imageCacheRef.current
    const sources = animSourcesRef.current

    const liveObjectIds = new Set(objects.map((o) => o.id))
    const liveAnimAssetIds = new Set(
      objects
        .filter((o) => o.type === 'photo' && !o.hidden && isAnimatedPhoto(o.data as PhotoData))
        .map((o) => (o.data as PhotoData).assetId),
    )

    // Release frames retained for objects that no longer exist (deleted, or the whole
    // project replaced). Still photos are keyed by assetId and aren't touched here.
    for (const key of [...cache.keys()]) {
      const entry = cache.get(key)
      if (typeof VideoFrame !== 'undefined' && entry instanceof VideoFrame && !liveObjectIds.has(key)) {
        entry.close()
        cache.delete(key)
        animIndexRef.current.delete(key)
      }
    }

    // Tear down decoders for assets nothing references any more.
    for (const [assetId, source] of [...sources]) {
      if (!liveAnimAssetIds.has(assetId)) {
        source?.destroy()
        sources.delete(assetId)
      }
    }

    const missing = [...liveAnimAssetIds].filter(
      (id) => !sources.has(id) && !animPendingRef.current.has(id),
    )
    if (missing.length === 0) return

    ;(async () => {
      for (const assetId of missing) {
        if (cancelled) return
        const blob = getAssetBlob(assetId)
        const meta = assets?.find((a) => a.id === assetId)
        // The per-frame timings were measured once at import and persisted on the
        // asset, so opening a saved project never re-probes.
        if (!blob || !meta?.animated || !meta.frameDelaysMs?.length) continue

        animPendingRef.current.add(assetId)
        const source = await createAnimatedImageSource(blob, {
          animated: true,
          frameCount: meta.frameDelaysMs.length,
          duration: meta.duration ?? 0,
          frameDelaysMs: meta.frameDelaysMs,
        })
        animPendingRef.current.delete(assetId)

        if (cancelled) {
          source?.destroy()
          return
        }
        // null is cached too: it means "can't decode this here" (B8), so we fall back
        // to the still first frame and never retry.
        sources.set(assetId, source)
      }
      if (!cancelled) doRender()
    })()

    return () => { cancelled = true }
  }, [objects, assets, doRender])

  // Release every decoder + retained frame on unmount.
  useEffect(() => {
    const cache = imageCacheRef.current
    const sources = animSourcesRef.current
    const indices = animIndexRef.current
    const decoding = animDecodingRef.current
    return () => {
      for (const entry of cache.values()) closeIfFrame(entry)
      for (const source of sources.values()) source?.destroy()
      sources.clear()
      indices.clear()
      decoding.clear()
    }
  }, [])

  // Playing: blit the playing video elements' frames via a rAF loop. No seeking,
  // and independent of React re-render frequency.
  useEffect(() => {
    if (!isPlaying) return
    let raf = 0
    const loop = () => {
      doRender()
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
  }, [isPlaying, doRender])

  // Paused: render on demand when time / objects / options change (scrubbing).
  useEffect(() => {
    if (isPlaying) return
    doRender()
  }, [isPlaying, globalTime, objects, editorOptions, doRender])

  // Redraw when any video element decodes a paint-worthy frame. Covers the import
  // case: useAudioPlayback registers the element AFTER this hook's effects run on the
  // import commit, so we can't attach to the element here — the registry notifies us.
  useEffect(() => subscribeVideoReady(doRender), [doRender])

  // Paused: redraw once a scrub-seek settles on a shared element (nearest frame).
  useEffect(() => {
    if (isPlaying) return
    const els = objects
      .filter((o) => o.type === 'video')
      .map((o) => getVideoElement(o.id))
      .filter((el): el is HTMLVideoElement => el != null)
    if (els.length === 0) return

    const onSeeked = () => doRender()
    els.forEach((el) => el.addEventListener('seeked', onSeeked))
    return () => els.forEach((el) => el.removeEventListener('seeked', onSeeked))
  }, [isPlaying, objects, doRender])
}

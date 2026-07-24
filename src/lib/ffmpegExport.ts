import type { Project, PhotoData, AudioData, VideoData } from '../types'
import { renderFrame, loadImage } from './renderer'
import { resolveCamera } from './camera'
import { resolveEffects } from './effects'
import { clipRate, sourceTimeAt, srcIn, sourceSpan, effectiveVolume } from './mediaTiming'
import { getAssetUrl, getAssetBlob } from './assetStore'
import { createVideoFrameSource, type VideoFrameSource } from './videoDecoder'
import type { ExportWorkerRequest, ExportWorkerResponse, RenderedAudio, EncodeConfig } from './exportWorkerTypes'
import { resolveEncodeConfig, type ExportSettings } from './exportSettings'
import { Muxer, ArrayBufferTarget } from 'mp4-muxer'

/**
 * Check if this browser supports WebCodecs VideoEncoder.
 */
function hasWebCodecsSupport(): boolean {
  return (
    typeof VideoEncoder !== 'undefined' &&
    typeof VideoFrame !== 'undefined'
  )
}

function hasWorkerExportSupport(): boolean {
  return typeof Worker !== 'undefined' && typeof OffscreenCanvas !== 'undefined'
}

function abortError(): DOMException {
  return new DOMException('Export cancelled', 'AbortError')
}

/**
 * Export video as MP4 (WebCodecs — off the main thread when possible) or WebM
 * (MediaRecorder fallback). Pass `signal` to cancel an in-progress export.
 *
 * Tiering: worker + decoder → main-thread decoder (+ per-clip element fallback)
 * → MediaRecorder.
 */
export async function exportVideo(
  project: Project,
  settings: ExportSettings,
  onProgress: (pct: number) => void,
  signal?: AbortSignal,
): Promise<Blob> {
  // Resolve the resolution/compression choices (issue #6) into concrete output
  // dimensions + video bitrate once, up front — every path below encodes to these.
  const encode = resolveEncodeConfig(project, settings)
  if (hasWebCodecsSupport()) {
    if (hasWorkerExportSupport()) {
      return exportWithWorker(project, encode, onProgress, signal)
    }
    return exportWithWebCodecs(project, encode, onProgress, signal)
  }
  return exportWithMediaRecorder(project, encode, onProgress, signal)
}

// ---------------------------------------------------------------------------
// Worker pipeline (WebCodecs off the main thread — cancellable via terminate)
// ---------------------------------------------------------------------------

async function exportWithWorker(
  project: Project,
  encode: EncodeConfig,
  onProgress: (pct: number) => void,
  signal?: AbortSignal,
): Promise<Blob> {
  onProgress(0)

  // Audio must be pre-rendered on the main thread (OfflineAudioContext isn't
  // available in workers) and transferred to the worker as raw channel data.
  const audio = await prerenderAudioMix(project)
  if (signal?.aborted) throw abortError()

  const assetBlobs = collectAssetBlobs(project)
  const worker = new Worker(new URL('./exportWorker.ts', import.meta.url), { type: 'module' })

  return new Promise<Blob>((resolve, reject) => {
    let settled = false

    const cleanup = () => {
      signal?.removeEventListener('abort', onAbort)
      worker.terminate()
    }
    const onAbort = () => {
      if (settled) return
      settled = true
      cleanup()
      reject(abortError())
    }
    if (signal?.aborted) { onAbort(); return }
    signal?.addEventListener('abort', onAbort, { once: true })

    worker.onmessage = async (e: MessageEvent<ExportWorkerResponse>) => {
      if (settled) return
      const msg = e.data
      if (msg.type === 'progress') {
        onProgress(msg.pct)
      } else if (msg.type === 'done') {
        settled = true
        cleanup()
        resolve(msg.blob)
      } else if (msg.type === 'error') {
        settled = true
        cleanup()
        if (msg.recoverable) {
          // B5 tier 2: worker couldn't decode a clip (no HTMLVideoElement in a
          // worker). Retry on the main thread, which has the element-seek fallback.
          console.warn('[export] worker path unsupported, falling back to main thread:', msg.message)
          try { resolve(await exportWithWebCodecs(project, encode, onProgress, signal)) }
          catch (err) { reject(err) }
        } else {
          reject(new Error(msg.message))
        }
      }
    }
    worker.onerror = (e) => {
      if (settled) return
      settled = true
      cleanup()
      reject(new Error(e.message || 'Export worker crashed'))
    }

    // Transfer the audio channel buffers (zero-copy); exportWithWebCodecs re-renders
    // its own audio on the fallback path, so detaching them here is safe.
    const transfer = audio ? audio.channelData.map((c) => c.buffer) : []
    const req: ExportWorkerRequest = { type: 'start', project, assetBlobs, audio, encode }
    worker.postMessage(req, transfer)
  })
}

/** Gather raw blobs for photo + video assets (audio is sent via RenderedAudio). */
function collectAssetBlobs(project: Project): Array<[string, Blob]> {
  const ids = new Set<string>()
  for (const obj of project.objects) {
    if (obj.type === 'photo' || obj.type === 'video') {
      ids.add((obj.data as PhotoData | VideoData).assetId)
    }
  }
  const out: Array<[string, Blob]> = []
  for (const id of ids) {
    const blob = getAssetBlob(id)
    if (blob) out.push([id, blob])
  }
  return out
}

/**
 * Pre-render the audio mix (OfflineAudioContext) on the main thread and extract
 * transferable channel data for the worker. Returns null when there's no audio.
 */
async function prerenderAudioMix(project: Project): Promise<RenderedAudio | null> {
  const { objects } = project
  const totalDuration = objects.reduce(
    (max, obj) => Math.max(max, obj.startTime + obj.duration),
    0,
  )
  const audioVideoObjects = objects.filter(
    (o) => (o.type === 'audio' || o.type === 'video') && !o.hidden,
  )
  if (audioVideoObjects.length === 0) return null

  const sampleRate = 48000
  const offlineCtx = new OfflineAudioContext(
    2,
    Math.ceil(totalDuration * sampleRate),
    sampleRate,
  )

  for (const obj of audioVideoObjects) {
    const data = obj.data as AudioData | VideoData
    const blob = getAssetBlob(data.assetId)
    if (!blob) continue
    try {
      const arrayBuffer = await blob.arrayBuffer()
      const decoded = await offlineCtx.decodeAudioData(arrayBuffer)
      const source = offlineCtx.createBufferSource()
      source.buffer = decoded
      source.playbackRate.value = clipRate(data, obj.duration)
      const gain = offlineCtx.createGain()
      gain.gain.value = effectiveVolume(data)
      source.connect(gain)
      gain.connect(offlineCtx.destination)
      // Trim: start at sourceIn, play only the source span (spec 14 R6).
      source.start(obj.startTime, srcIn(data), sourceSpan(data))
    } catch {
      continue
    }
  }

  const audioBuffer = await offlineCtx.startRendering()
  const numberOfChannels = audioBuffer.numberOfChannels
  const channelData: Float32Array[] = []
  for (let ch = 0; ch < numberOfChannels; ch++) {
    // Copy into a buffer we own so it can be transferred to the worker.
    channelData.push(new Float32Array(audioBuffer.getChannelData(ch)))
  }

  return {
    channelData,
    sampleRate: audioBuffer.sampleRate,
    numberOfChannels,
    length: audioBuffer.length,
  }
}

// ---------------------------------------------------------------------------
// WebCodecs Pipeline (main thread — uses HTMLVideoElement for video frames)
// ---------------------------------------------------------------------------

/** Stored chunk for deferred muxing (mp4-muxer needs audio config at construction) */
type StoredChunk = {
  data: Uint8Array
  type: 'key' | 'delta'
  timestamp: number
  duration: number
  meta?: EncodedVideoChunkMetadata | EncodedAudioChunkMetadata
}

/**
 * Per-timeline-object video source. Primary path is a sequential WebCodecs
 * decoder; the element fallback (B5) engages when the decoder rejects the codec.
 */
type VideoSource =
  | { kind: 'decoder'; source: VideoFrameSource }
  | { kind: 'element'; el: HTMLVideoElement }

async function exportWithWebCodecs(
  project: Project,
  encode: EncodeConfig,
  onProgress: (pct: number) => void,
  signal?: AbortSignal,
): Promise<Blob> {
  const { fps, objects } = project
  // Output dimensions/bitrate come from the export settings (issue #6), not the
  // project — renderFrame scales normalized coords + fontSize/lineWidth to fit.
  const { width, height, videoBitrate } = encode

  const totalDuration = objects.reduce(
    (max, obj) => Math.max(max, obj.startTime + obj.duration),
    0,
  )
  const totalFrames = Math.ceil(totalDuration * fps)
  if (totalFrames === 0) throw new Error('No frames to export')

  onProgress(0)

  // --- Load photos (by assetId) + create a video source per video OBJECT ---
  // Photos live in imageCache keyed by assetId. Decoded video frames are written
  // into imageCache keyed by OBJECT id (B3: each clip decodes independently, so
  // two clips sharing one asset never collide on the same cache slot).
  const imageCache = new Map<string, HTMLImageElement | HTMLVideoElement | VideoFrame | OffscreenCanvas>()
  const videoSources = new Map<string, VideoSource>() // keyed by object id

  for (const obj of objects) {
    if (obj.hidden) continue  // spec 14 R11: hidden clips are never drawn, so skip asset setup
    if (obj.type === 'photo') {
      const assetId = (obj.data as PhotoData).assetId
      if (!imageCache.has(assetId)) {
        const url = getAssetUrl(assetId)
        if (url) imageCache.set(assetId, await loadImage(url))
      }
    } else if (obj.type === 'video') {
      const data = obj.data as VideoData
      const blob = getAssetBlob(data.assetId)
      if (!blob) continue
      try {
        // Primary path (B1): sequential WebCodecs decode — frame-accurate, no seeks.
        const source = await createVideoFrameSource(blob)
        videoSources.set(obj.id, { kind: 'decoder', source })
      } catch (err) {
        // B5: the decoder rejected this source codec (e.g. HEVC). Fall back to
        // HTMLVideoElement seeking for this clip, with the seek race fixed below.
        console.warn(
          `[export] VideoDecoder unavailable for "${obj.name}" ` +
          `(${err instanceof Error ? err.message : String(err)}); falling back to element seeking.`,
        )
        const url = getAssetUrl(data.assetId)
        if (!url) continue
        const el = document.createElement('video')
        el.src = url
        el.muted = true
        el.preload = 'auto'
        el.playsInline = true
        await new Promise<void>((resolve) => {
          el.onloadeddata = () => resolve()
          el.onerror = () => resolve()
        })
        videoSources.set(obj.id, { kind: 'element', el })
      }
    }
  }

  // --- Set up canvas ---
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')!

  // --- Find a supported H.264 encoder config ---
  const encoderConfig = await findSupportedVideoCodec(width, height, fps, videoBitrate)

  // --- Encode video frames ---
  const videoChunks: StoredChunk[] = []

  const videoEncoder = new VideoEncoder({
    output: (chunk, meta) => {
      const buf = new Uint8Array(chunk.byteLength)
      chunk.copyTo(buf)
      videoChunks.push({
        data: buf,
        type: chunk.type,
        timestamp: chunk.timestamp,
        duration: chunk.duration ?? 0,
        meta: meta ?? undefined,
      })
    },
    error: (e) => { throw new Error(`VideoEncoder error: ${e.message}`) },
  })

  videoEncoder.configure(encoderConfig)

  const videoObjects = objects.filter((o) => o.type === 'video' && !o.hidden)

  const cleanupVideoSources = () => {
    for (const vs of videoSources.values()) {
      // B6: decoder frames are source-owned; destroy() closes the retained frame,
      // buffered frames, and the decoder exactly once. Elements just release.
      if (vs.kind === 'decoder') vs.source.destroy()
      else { vs.el.pause(); vs.el.src = '' }
    }
    videoSources.clear()
  }

  try {
    for (let f = 0; f < totalFrames; f++) {
      if (signal?.aborted) throw abortError()
      const globalTime = f / fps
      const timestampUs = Math.round(globalTime * 1_000_000)

      // Source the correct frame for each active clip into imageCache[obj.id].
      for (const obj of videoObjects) {
        const data = obj.data as VideoData
        const vs = videoSources.get(obj.id)
        if (!vs) continue

        const clipStart = obj.startTime
        const clipEnd = obj.startTime + obj.duration
        if (globalTime < clipStart || globalTime >= clipEnd) continue

        const clipProgress = (globalTime - clipStart) / obj.duration
        const sourceTime = sourceTimeAt(data, clipProgress)

        if (vs.kind === 'decoder') {
          // Sequential decode (B1) — frame-accurate. The returned frame is owned
          // by the source (valid until the next call); we must NOT close it.
          const frame = await vs.source.getFrameAtTime(sourceTime)
          if (frame) imageCache.set(obj.id, frame)
        } else {
          // B5 fallback: element seek — ALWAYS await `seeked` (watchdog is only a
          // stuck-decoder escape, never the normal frame-capture mechanism).
          vs.el.currentTime = sourceTime
          await awaitSeeked(vs.el, 500)
          imageCache.set(obj.id, vs.el)
        }
      }

      // Composite all objects onto canvas (with the camera transform, spec 13, + render-wide effects,
      // spec 23 — export always renders the real camera + effects so the MP4 matches Live preview).
      renderFrame(ctx, objects, globalTime, { width, height }, imageCache, {
        camera: resolveCamera(project.zooms, globalTime),
        effects: resolveEffects(project.effects, globalTime),
      })

      // Encode canvas as video frame (no real-time delay!)
      const frame = new VideoFrame(canvas, {
        timestamp: timestampUs,
        duration: Math.round(1_000_000 / fps),
      })

      const isKeyFrame = f % Math.round(fps * 2) === 0
      videoEncoder.encode(frame, { keyFrame: isKeyFrame })
      frame.close()

      // Backpressure
      while (videoEncoder.encodeQueueSize > 10) {
        await new Promise<void>((r) => {
          videoEncoder.addEventListener('dequeue', () => r(), { once: true })
        })
      }

      onProgress((f / totalFrames) * 0.85)
    }

    await videoEncoder.flush()
    videoEncoder.close()
  } catch (err) {
    // B6: release decoders/frames and the encoder on failure before bubbling up.
    cleanupVideoSources()
    if (videoEncoder.state !== 'closed') videoEncoder.close()
    throw err
  }

  // Free the ~2×file-size demux buffers + decoded frames before audio/mux.
  cleanupVideoSources()

  onProgress(0.88)

  // --- Pre-render audio mix ---
  const audioChunks: StoredChunk[] = []
  const audioVideoObjects = objects.filter(
    (o) => (o.type === 'audio' || o.type === 'video') && !o.hidden,
  )

  let audioSampleRate = 48000
  let audioChannels = 2

  if (audioVideoObjects.length > 0) {
    const sampleRate = 48000
    const offlineCtx = new OfflineAudioContext(
      2,
      Math.ceil(totalDuration * sampleRate),
      sampleRate,
    )

    for (const obj of audioVideoObjects) {
      const data = obj.data as AudioData | VideoData
      const blob = getAssetBlob(data.assetId)
      if (!blob) continue

      try {
        const arrayBuffer = await blob.arrayBuffer()
        const decoded = await offlineCtx.decodeAudioData(arrayBuffer)

        const source = offlineCtx.createBufferSource()
        source.buffer = decoded

        source.playbackRate.value = clipRate(data, obj.duration)

        const gain = offlineCtx.createGain()
        gain.gain.value = effectiveVolume(data)

        source.connect(gain)
        gain.connect(offlineCtx.destination)
        // Trim: start at sourceIn, play only the source span (spec 14 R6).
        source.start(obj.startTime, srcIn(data), sourceSpan(data))
      } catch {
        continue
      }
    }

    const audioBuffer = await offlineCtx.startRendering()
    audioSampleRate = audioBuffer.sampleRate
    audioChannels = audioBuffer.numberOfChannels

    // Encode audio with AudioEncoder
    const audioEncoder = new AudioEncoder({
      output: (chunk, meta) => {
        const buf = new Uint8Array(chunk.byteLength)
        chunk.copyTo(buf)
        audioChunks.push({
          data: buf,
          type: chunk.type,
          timestamp: chunk.timestamp,
          duration: chunk.duration ?? 0,
          meta: meta ?? undefined,
        })
      },
      error: (e) => { throw new Error(`AudioEncoder error: ${e.message}`) },
    })

    audioEncoder.configure({
      codec: 'mp4a.40.2', // AAC-LC
      numberOfChannels: audioChannels,
      sampleRate: audioSampleRate,
      bitrate: 128_000,
    })

    const frameSize = 1024
    const totalSamples = audioBuffer.length

    for (let offset = 0; offset < totalSamples; offset += frameSize) {
      const numSamples = Math.min(frameSize, totalSamples - offset)

      const planarData = new Float32Array(numSamples * audioChannels)
      for (let ch = 0; ch < audioChannels; ch++) {
        const channelData = audioBuffer.getChannelData(ch)
        planarData.set(
          channelData.subarray(offset, offset + numSamples),
          ch * numSamples,
        )
      }

      const audioFrame = new AudioData({
        format: 'f32-planar',
        sampleRate: audioSampleRate,
        numberOfFrames: numSamples,
        numberOfChannels: audioChannels,
        timestamp: Math.round((offset / audioSampleRate) * 1_000_000),
        data: planarData,
      })

      audioEncoder.encode(audioFrame)
      audioFrame.close()
    }

    await audioEncoder.flush()
    audioEncoder.close()
  }

  onProgress(0.93)

  // --- Mux video + audio into MP4 ---
  const hasAudio = audioChunks.length > 0

  const muxer = new Muxer({
    target: new ArrayBufferTarget(),
    video: {
      codec: 'avc',
      width,
      height,
    },
    ...(hasAudio ? {
      audio: {
        codec: 'aac',
        numberOfChannels: audioChannels,
        sampleRate: audioSampleRate,
      },
    } : {}),
    fastStart: 'in-memory',
    firstTimestampBehavior: 'offset',
  })

  for (const chunk of videoChunks) {
    muxer.addVideoChunkRaw(
      chunk.data, chunk.type, chunk.timestamp, chunk.duration,
      chunk.meta as EncodedVideoChunkMetadata,
    )
  }

  for (const chunk of audioChunks) {
    muxer.addAudioChunkRaw(
      chunk.data, chunk.type, chunk.timestamp, chunk.duration,
      chunk.meta as EncodedAudioChunkMetadata,
    )
  }

  muxer.finalize()

  onProgress(1)

  const outputBuffer = (muxer.target as ArrayBufferTarget).buffer
  return new Blob([outputBuffer], { type: 'video/mp4' })
}

/**
 * Await a video element's `seeked` event, with a watchdog escape (logged if hit).
 * The watchdog guards against a genuinely stuck decoder — it is NOT the normal
 * path, so the export waits for the real `seeked` on every frame.
 */
function awaitSeeked(el: HTMLVideoElement, watchdogMs: number): Promise<void> {
  return new Promise<void>((resolve) => {
    let settled = false
    const finish = () => {
      if (settled) return
      settled = true
      el.removeEventListener('seeked', finish)
      resolve()
    }
    el.addEventListener('seeked', finish)
    setTimeout(() => {
      if (settled) return
      console.warn(`[export] seek watchdog fired (${watchdogMs}ms) — frame may be stale`)
      finish()
    }, watchdogMs)
  })
}

/**
 * Try H.264 codec strings from most to least capable,
 * returning the first supported encoder config.
 */
async function findSupportedVideoCodec(
  width: number,
  height: number,
  framerate: number,
  bitrate: number,
): Promise<VideoEncoderConfig> {
  const codecs = [
    'avc1.640028', // High Profile, Level 4.0
    'avc1.4d0028', // Main Profile, Level 4.0
    'avc1.420028', // Baseline Profile, Level 4.0
    'avc1.640020', // High Profile, Level 3.0
    'avc1.4d0020', // Main Profile, Level 3.0
    'avc1.420020', // Baseline Profile, Level 3.0
  ]

  for (const codec of codecs) {
    const config: VideoEncoderConfig = {
      codec,
      width,
      height,
      bitrate,
      framerate,
    }

    try {
      const support = await VideoEncoder.isConfigSupported(config)
      if (support.supported) return support.config!
    } catch {
      // try next
    }
  }

  throw new Error(
    'No supported H.264 encoder found in this browser.',
  )
}

// ---------------------------------------------------------------------------
// MediaRecorder Fallback (for browsers without WebCodecs)
// ---------------------------------------------------------------------------

async function exportWithMediaRecorder(
  project: Project,
  encode: EncodeConfig,
  onProgress: (pct: number) => void,
  signal?: AbortSignal,
): Promise<Blob> {
  const { fps, objects } = project
  const { width, height, videoBitrate } = encode

  const totalDuration = objects.reduce(
    (max, obj) => Math.max(max, obj.startTime + obj.duration),
    0,
  )
  const totalFrames = Math.ceil(totalDuration * fps)
  if (totalFrames === 0) throw new Error('No frames to export')

  onProgress(0)

  const imageCache = new Map<string, HTMLImageElement | HTMLVideoElement>()
  for (const obj of objects) {
    if (obj.hidden) continue  // spec 14 R11: hidden clips are never drawn, so skip asset setup
    if (obj.type === 'photo') {
      const assetId = (obj.data as PhotoData).assetId
      if (!imageCache.has(assetId)) {
        const url = getAssetUrl(assetId)
        if (url) imageCache.set(assetId, await loadImage(url))
      }
    } else if (obj.type === 'video') {
      const assetId = (obj.data as VideoData).assetId
      if (!imageCache.has(assetId)) {
        const url = getAssetUrl(assetId)
        if (url) {
          const video = document.createElement('video')
          video.src = url
          video.muted = true
          video.preload = 'auto'
          video.playsInline = true
          await new Promise<void>((resolve) => {
            video.onloadeddata = () => resolve()
            video.onerror = () => resolve()
          })
          imageCache.set(assetId, video)
        }
      }
    }
  }

  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')!

  const videoStream = canvas.captureStream(0)
  const videoTrack = videoStream.getVideoTracks()[0]

  const audioVideoObjects = objects.filter(
    (o) => (o.type === 'audio' || o.type === 'video') && !o.hidden,
  )

  let combinedStream: MediaStream
  let audioCtx: AudioContext | null = null

  if (audioVideoObjects.length > 0) {
    audioCtx = new AudioContext()
    const destination = audioCtx.createMediaStreamDestination()

    const sampleRate = 44100
    const offlineCtx = new OfflineAudioContext(
      2,
      Math.ceil(totalDuration * sampleRate),
      sampleRate,
    )

    for (const obj of audioVideoObjects) {
      const data = obj.data as AudioData | VideoData
      const blob = getAssetBlob(data.assetId)
      if (!blob) continue

      try {
        const arrayBuffer = await blob.arrayBuffer()
        const decoded = await offlineCtx.decodeAudioData(arrayBuffer)

        const source = offlineCtx.createBufferSource()
        source.buffer = decoded

        source.playbackRate.value = clipRate(data, obj.duration)

        const gain = offlineCtx.createGain()
        gain.gain.value = effectiveVolume(data)

        source.connect(gain)
        gain.connect(offlineCtx.destination)
        // Trim: start at sourceIn, play only the source span (spec 14 R6).
        source.start(obj.startTime, srcIn(data), sourceSpan(data))
      } catch {
        continue
      }
    }

    const renderedBuffer = await offlineCtx.startRendering()

    const bufferSource = audioCtx.createBufferSource()
    bufferSource.buffer = renderedBuffer
    bufferSource.connect(destination)
    bufferSource.connect(audioCtx.destination)
    bufferSource.start()

    const audioTrack = destination.stream.getAudioTracks()[0]
    combinedStream = new MediaStream([videoTrack, audioTrack])
  } else {
    combinedStream = videoStream
  }

  const chunks: Blob[] = []
  const recorder = new MediaRecorder(combinedStream, {
    mimeType: getSupportedMimeType(),
    videoBitsPerSecond: videoBitrate,
  })

  recorder.ondataavailable = (e) => {
    if (e.data.size > 0) chunks.push(e.data)
  }

  const recordingDone = new Promise<void>((resolve) => {
    recorder.onstop = () => resolve()
  })

  recorder.start()

  const videoObjects = objects.filter((o) => o.type === 'video' && !o.hidden)

  for (let f = 0; f < totalFrames; f++) {
    if (signal?.aborted) {
      recorder.stop()
      if (audioCtx) await audioCtx.close()
      throw abortError()
    }
    const globalTime = f / fps

    for (const obj of videoObjects) {
      const data = obj.data as VideoData
      const videoEl = imageCache.get(data.assetId)
      if (!videoEl || !(videoEl instanceof HTMLVideoElement)) continue

      const clipStart = obj.startTime
      const clipEnd = obj.startTime + obj.duration
      if (globalTime >= clipStart && globalTime < clipEnd) {
        const clipProgress = (globalTime - clipStart) / obj.duration
        const sourceTime = sourceTimeAt(data, clipProgress)
        videoEl.currentTime = sourceTime
        await new Promise<void>((resolve) => {
          videoEl.onseeked = () => resolve()
          setTimeout(resolve, 100)
        })
      }
    }

    renderFrame(ctx, objects, globalTime, { width, height }, imageCache, {
      camera: resolveCamera(project.zooms, globalTime),
      effects: resolveEffects(project.effects, globalTime),
    })

    // @ts-expect-error - requestFrame exists on CanvasCaptureMediaStreamTrack
    if (videoTrack.requestFrame) videoTrack.requestFrame()

    await new Promise((r) => setTimeout(r, 1000 / fps))

    onProgress((f / totalFrames) * 0.95)
  }

  recorder.stop()
  await recordingDone

  if (audioCtx) {
    await audioCtx.close()
  }

  onProgress(1)
  return new Blob(chunks, { type: recorder.mimeType || 'video/webm' })
}

function getSupportedMimeType(): string {
  const types = [
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp8,opus',
    'video/webm;codecs=vp9',
    'video/webm;codecs=vp8',
    'video/webm',
  ]
  for (const type of types) {
    if (MediaRecorder.isTypeSupported(type)) return type
  }
  return 'video/webm'
}

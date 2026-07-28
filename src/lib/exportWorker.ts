import type { PhotoData, VideoData, Project } from '../types'
import { createAnimatedExportSources } from './animatedImage'
import type { ExportWorkerRequest, ExportWorkerResponse, RenderedAudio, EncodeConfig } from './exportWorkerTypes'
import { renderFrame } from './renderer'
import { resolveCamera } from './camera'
import { resolveEffects } from './effects'
import { sourceTimeAt } from './mediaTiming'
import { createVideoFrameSource, type VideoFrameSource } from './videoDecoder'
import { Muxer, ArrayBufferTarget } from 'mp4-muxer'

// ---------------------------------------------------------------------------
// Stored chunk types for deferred muxing
// ---------------------------------------------------------------------------

type StoredVideoChunk = {
  data: Uint8Array
  type: 'key' | 'delta'
  timestamp: number
  duration: number
  meta?: EncodedVideoChunkMetadata
}

type StoredAudioChunk = {
  data: Uint8Array
  type: 'key' | 'delta'
  timestamp: number
  duration: number
  meta?: EncodedAudioChunkMetadata
}

// ---------------------------------------------------------------------------
// Worker message handler
// ---------------------------------------------------------------------------

function sendMessage(msg: ExportWorkerResponse) {
  self.postMessage(msg)
}

function sendProgress(pct: number) {
  sendMessage({ type: 'progress', pct })
}

/** Thrown when the worker can't proceed but the main thread might (element fallback). */
class RecoverableExportError extends Error {}

self.onmessage = async (e: MessageEvent<ExportWorkerRequest>) => {
  const { type } = e.data
  if (type !== 'start') return

  try {
    const blob = await runExport(e.data.project, e.data.assetBlobs, e.data.audio, e.data.encode)
    sendMessage({ type: 'done', blob })
  } catch (err) {
    sendMessage({
      type: 'error',
      message: err instanceof Error ? err.message : 'Export failed',
      recoverable: err instanceof RecoverableExportError,
    })
  }
}

// ---------------------------------------------------------------------------
// Export pipeline (runs entirely in the worker)
// ---------------------------------------------------------------------------

async function runExport(
  project: Project,
  assetBlobEntries: Array<[string, Blob]>,
  audio: RenderedAudio | null,
  encode: EncodeConfig,
): Promise<Blob> {
  const { fps, objects } = project
  // Output dimensions come from the export settings (issue #6), not the project —
  // renderFrame scales normalized coords + fontSize/lineWidth to whatever we pass.
  const { width, height, videoBitrate } = encode
  const assetBlobs = new Map(assetBlobEntries)

  const totalDuration = objects.reduce(
    (max, obj) => Math.max(max, obj.startTime + obj.duration),
    0,
  )
  const totalFrames = Math.ceil(totalDuration * fps)
  if (totalFrames === 0) throw new Error('No frames to export')

  sendProgress(0)

  // --- Load photos as ImageBitmap (by assetId) + one decoder per video object ---
  const imageCache = new Map<string, ImageBitmap | VideoFrame | OffscreenCanvas>()
  const videoDecoders = new Map<string, VideoFrameSource>() // keyed by object id (B3)
  // Animated images (spec 28) — ImageDecoder works in workers, so this path is
  // identical to the main-thread one and produces the same frames.
  const animatedSources = await createAnimatedExportSources(
    objects,
    project.assets,
    (assetId) => assetBlobs.get(assetId),
  )

  for (const obj of objects) {
    if (obj.hidden) continue  // spec 14 R11: hidden clips are never drawn, so skip asset setup
    if (obj.type === 'photo') {
      const assetId = (obj.data as PhotoData).assetId
      if (!imageCache.has(assetId)) {
        const blob = assetBlobs.get(assetId)
        if (blob) {
          const bitmap = await createImageBitmap(blob)
          imageCache.set(assetId, bitmap)
        }
      }
    } else if (obj.type === 'video') {
      const data = obj.data as VideoData
      const blob = assetBlobs.get(data.assetId)
      if (blob && !videoDecoders.has(obj.id)) {
        try {
          const source = await createVideoFrameSource(blob)
          videoDecoders.set(obj.id, source)
        } catch (err) {
          // No HTMLVideoElement fallback exists in a worker — signal the main
          // thread to retry on its element-seeking path (B5 tier 2).
          throw new RecoverableExportError(
            `decoder init failed for "${obj.name}": ${err instanceof Error ? err.message : String(err)}`,
          )
        }
      }
    }
  }

  // --- Set up OffscreenCanvas ---
  const canvas = new OffscreenCanvas(width, height)
  // OffscreenCanvasRenderingContext2D shares the drawing API renderFrame uses;
  // cast so it satisfies renderFrame's CanvasRenderingContext2D parameter.
  const ctx = canvas.getContext('2d') as unknown as CanvasRenderingContext2D

  // Audio is pre-rendered on the main thread (OfflineAudioContext isn't available in workers)
  // and passed in as raw Float32Array channel data

  // --- Find a supported H.264 codec ---
  const codecConfig = await findSupportedVideoCodec(width, height, fps, videoBitrate)

  // --- Encode video frames ---
  const videoChunks: StoredVideoChunk[] = []

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

  videoEncoder.configure(codecConfig)

  const videoObjects = objects.filter((o) => o.type === 'video' && !o.hidden)

  for (let f = 0; f < totalFrames; f++) {
    const globalTime = f / fps
    const timestampUs = Math.round(globalTime * 1_000_000)

    // Source the current frame for each active clip into imageCache[obj.id].
    for (const obj of videoObjects) {
      const data = obj.data as VideoData
      const decoder = videoDecoders.get(obj.id)
      if (!decoder) continue

      const clipStart = obj.startTime
      const clipEnd = obj.startTime + obj.duration
      if (globalTime >= clipStart && globalTime < clipEnd) {
        const clipProgress = (globalTime - clipStart) / obj.duration
        const sourceTime = sourceTimeAt(data, clipProgress)

        // Frame is owned by the source (valid until the next call); do NOT close it.
        const frame = await decoder.getFrameAtTime(sourceTime)
        if (frame) imageCache.set(obj.id, frame)
      }
    }

    await animatedSources.update(objects, globalTime, imageCache)

    // Composite all objects onto canvas (with the camera transform, spec 13, + effects, spec 23)
    renderFrame(ctx, objects, globalTime, { width, height }, imageCache, {
      camera: resolveCamera(project.zooms, globalTime),
      effects: resolveEffects(project.effects, globalTime),
    })

    // Encode canvas as video frame
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

    sendProgress((f / totalFrames) * 0.85)
  }

  await videoEncoder.flush()
  videoEncoder.close()

  // Clean up. Animated-image frames ARE caller-owned (unlike video-source frames), so
  // they're closed and removed from the cache first.
  animatedSources.destroy(imageCache)
  // VideoFrames left here are owned by their VideoFrameSource — destroy() closes them
  // (closing here too would double-free). Only ImageBitmaps are ours to close.
  for (const [, val] of imageCache) {
    if (val instanceof ImageBitmap) val.close()
  }
  for (const [, decoder] of videoDecoders) {
    decoder.destroy()
  }

  sendProgress(0.88)

  // --- Encode audio ---
  const audioChunks: StoredAudioChunk[] = []

  if (audio) {
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
      numberOfChannels: audio.numberOfChannels,
      sampleRate: audio.sampleRate,
      bitrate: 128_000,
    })

    const frameSize = 1024
    const totalSamples = audio.length
    const { numberOfChannels, sampleRate } = audio

    for (let offset = 0; offset < totalSamples; offset += frameSize) {
      const numSamples = Math.min(frameSize, totalSamples - offset)

      const planarData = new Float32Array(numSamples * numberOfChannels)
      for (let ch = 0; ch < numberOfChannels; ch++) {
        planarData.set(
          audio.channelData[ch].subarray(offset, offset + numSamples),
          ch * numSamples,
        )
      }

      const audioFrame = new AudioData({
        format: 'f32-planar',
        sampleRate,
        numberOfFrames: numSamples,
        numberOfChannels,
        timestamp: Math.round((offset / sampleRate) * 1_000_000),
        data: planarData,
      })

      audioEncoder.encode(audioFrame)
      audioFrame.close()
    }

    await audioEncoder.flush()
    audioEncoder.close()
  }

  sendProgress(0.93)

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
        numberOfChannels: audio!.numberOfChannels,
        sampleRate: audio!.sampleRate,
      },
    } : {}),
    fastStart: 'in-memory',
    firstTimestampBehavior: 'offset',
  })

  for (const chunk of videoChunks) {
    muxer.addVideoChunkRaw(chunk.data, chunk.type, chunk.timestamp, chunk.duration, chunk.meta)
  }

  for (const chunk of audioChunks) {
    muxer.addAudioChunkRaw(chunk.data, chunk.type, chunk.timestamp, chunk.duration, chunk.meta)
  }

  muxer.finalize()

  sendProgress(1)

  const outputBuffer = (muxer.target as ArrayBufferTarget).buffer
  return new Blob([outputBuffer], { type: 'video/mp4' })
}

// ---------------------------------------------------------------------------
// Codec negotiation
// ---------------------------------------------------------------------------

/**
 * Try a list of H.264 codec strings from most to least capable,
 * returning the first one the browser supports for encoding.
 */
async function findSupportedVideoCodec(
  width: number,
  height: number,
  framerate: number,
  bitrate: number,
): Promise<VideoEncoderConfig> {
  // H.264 profiles/levels from high to baseline
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
    'No supported H.264 encoder found. Your browser may not support hardware video encoding.',
  )
}

// === Per-object download (spec 31 follow-up) ===
//
// Let the user save an individual timeline object back to their computer. Two flavours:
//
//   • ORIGINAL   — the untouched source blob from IndexedDB, with its original filename.
//                  Instant + lossless. What you imported, byte-for-byte.
//   • PROCESSED  — re-encoded to reflect the edit that makes downloading worthwhile:
//                    - a trimmed video  → an MP4 of just the played span [sourceIn, sourceOut]
//                    - a trimmed audio  → an M4A of just that span
//                    - a video "converted to audio" (audio object whose source is a video)
//                      → an M4A extracting the audio track
//                  Re-encode is lossy + main-thread (same tier as the project export), so it's
//                  only offered when it actually produces something different from the original.
//
// Reuses the export encoders (createVideoFrameSource / VideoEncoder / AudioEncoder / mp4-muxer)
// but renders the RAW media trimmed — NOT the composited canvas frame — so the download is a
// clean clip of the footage, not the object placed in its timeline position.

import type { TimelineObject, Project, AssetMeta, PhotoData, AudioData, VideoData } from '../types'
import { getAssetBlob } from './assetStore'
import { srcIn, sourceSpan } from './mediaTiming'
import { createVideoFrameSource } from './videoDecoder'
import { Muxer, ArrayBufferTarget } from 'mp4-muxer'

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** The asset id backing an object, or undefined for objects with no media (shapes/text/etc.). */
function objectAssetId(obj: TimelineObject): string | undefined {
  if (obj.type === 'photo' || obj.type === 'audio' || obj.type === 'video') {
    return (obj.data as PhotoData | AudioData | VideoData).assetId
  }
  return undefined
}

function assetFor(obj: TimelineObject, assets: AssetMeta[]): AssetMeta | undefined {
  const id = objectAssetId(obj)
  return id ? assets.find((a) => a.id === id) : undefined
}

/** Filename minus its final extension (`clip.mp4` → `clip`). */
function baseName(filename: string): string {
  const dot = filename.lastIndexOf('.')
  return dot > 0 ? filename.slice(0, dot) : filename
}

/** True when the clip plays only a sub-span of its source (either end trimmed in). */
function isTrimmed(data: AudioData | VideoData): boolean {
  return srcIn(data) > 1e-4 || sourceSpan(data) < data.originalDuration - 1e-4
}

/** True when an object's source asset is actually a video (matters for audio objects — the
 *  "convert to audio" flow keeps the video assetId, so the source is still a video file). */
function sourceIsVideo(obj: TimelineObject, asset: AssetMeta | undefined): boolean {
  if (obj.type === 'video') return true
  return asset?.type === 'video' || (asset?.mimeType?.startsWith('video/') ?? false)
}

/** Kick off a browser download for a blob under `filename`, revoking the object URL after. */
function triggerDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  // Revoke on the next tick — revoking synchronously can cancel the download in some browsers.
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

// ---------------------------------------------------------------------------
// What the UI should offer
// ---------------------------------------------------------------------------

export type ProcessedKind = 'video-trim' | 'audio-trim' | 'audio-extract'

export type DownloadOptions = {
  /** Whether an original-source download is possible (i.e. the object has a media asset). */
  canOriginal: boolean
  /** The processed re-encode on offer, or null when it'd just duplicate the original. */
  processed: { kind: ProcessedKind; label: string } | null
}

/**
 * Decide which download buttons make sense for an object. Drives PropertiesPanel.
 * Photos only ever offer the original; audio/video offer a processed re-encode when it
 * would differ from the source (trimmed, or a video-sourced audio object to extract).
 */
export function getDownloadOptions(obj: TimelineObject, assets: AssetMeta[]): DownloadOptions {
  const asset = assetFor(obj, assets)
  if (!asset && !objectAssetId(obj)) return { canOriginal: false, processed: null }

  if (obj.type === 'video') {
    const data = obj.data as VideoData
    return {
      canOriginal: true,
      processed: isTrimmed(data) ? { kind: 'video-trim', label: 'Download trimmed clip' } : null,
    }
  }
  if (obj.type === 'audio') {
    const data = obj.data as AudioData
    if (sourceIsVideo(obj, asset)) {
      // Source is a video (a "converted to audio" clip) — extracting the audio is always useful.
      return { canOriginal: true, processed: { kind: 'audio-extract', label: 'Download as audio' } }
    }
    return {
      canOriginal: true,
      processed: isTrimmed(data) ? { kind: 'audio-trim', label: 'Download trimmed audio' } : null,
    }
  }
  // photo (incl. animated GIF/WebP) — nothing to re-encode, original only.
  return { canOriginal: objectAssetId(obj) !== undefined, processed: null }
}

// ---------------------------------------------------------------------------
// Original download
// ---------------------------------------------------------------------------

/** Save the untouched source blob with its original filename. Throws if the asset is missing. */
export function downloadOriginal(obj: TimelineObject, assets: AssetMeta[]): void {
  const id = objectAssetId(obj)
  const blob = id ? getAssetBlob(id) : undefined
  if (!id || !blob) throw new Error('Source file is unavailable')
  const asset = assetFor(obj, assets)
  triggerDownload(blob, asset?.filename ?? `${obj.name || 'download'}`)
}

// ---------------------------------------------------------------------------
// Processed download
// ---------------------------------------------------------------------------

/** Re-encode + download the object per its `getDownloadOptions().processed.kind`. */
export async function downloadProcessed(obj: TimelineObject, project: Project): Promise<void> {
  const opts = getDownloadOptions(obj, project.assets)
  if (!opts.processed) throw new Error('Nothing to process for this object')

  const id = objectAssetId(obj)!
  const blob = getAssetBlob(id)
  if (!blob) throw new Error('Source file is unavailable')
  const asset = assetFor(obj, project.assets)
  const base = baseName(asset?.filename ?? (obj.name || 'clip'))

  if (opts.processed.kind === 'video-trim') {
    const out = await encodeTrimmedVideo(obj.data as VideoData, blob, project.fps)
    triggerDownload(out, `${base}-trimmed.mp4`)
    return
  }

  // audio-trim / audio-extract — both render the trimmed source span to AAC/M4A.
  const data = obj.data as AudioData | VideoData
  const buffer = await renderTrimmedAudio(blob, srcIn(data), sourceSpan(data))
  const out = await audioBufferToM4a(buffer)
  const suffix = opts.processed.kind === 'audio-extract' ? '-audio' : '-trimmed'
  triggerDownload(out, `${base}${suffix}.m4a`)
}

// ---------------------------------------------------------------------------
// Audio: render the trimmed span → AAC in an MP4 (.m4a) container
// ---------------------------------------------------------------------------

/** Decode `blob`'s audio and render just [sourceIn, sourceIn+span] at natural speed. */
async function renderTrimmedAudio(blob: Blob, sourceInS: number, spanS: number): Promise<AudioBuffer> {
  const sampleRate = 48000
  // A throwaway context to decode (decodeAudioData needs an AudioContext; Offline resamples to 48k).
  const decodeCtx = new OfflineAudioContext(1, sampleRate, sampleRate)
  const decoded = await decodeCtx.decodeAudioData(await blob.arrayBuffer())

  const span = Math.max(0, Math.min(spanS, decoded.duration - sourceInS))
  const length = Math.max(1, Math.ceil(span * sampleRate))
  const outCtx = new OfflineAudioContext(decoded.numberOfChannels, length, sampleRate)
  const source = outCtx.createBufferSource()
  source.buffer = decoded
  source.connect(outCtx.destination)
  source.start(0, sourceInS, span)
  return outCtx.startRendering()
}

/** AAC-encode an AudioBuffer and mux it into an audio-only MP4 (.m4a). */
async function audioBufferToM4a(buffer: AudioBuffer): Promise<Blob> {
  if (typeof AudioEncoder === 'undefined') {
    throw new Error('Audio encoding is not supported in this browser')
  }
  const channels = buffer.numberOfChannels
  const sampleRate = buffer.sampleRate

  const muxer = new Muxer({
    target: new ArrayBufferTarget(),
    audio: { codec: 'aac', numberOfChannels: channels, sampleRate },
    fastStart: 'in-memory',
    firstTimestampBehavior: 'offset',
  })

  const encoder = new AudioEncoder({
    output: (chunk, meta) => {
      const buf = new Uint8Array(chunk.byteLength)
      chunk.copyTo(buf)
      muxer.addAudioChunkRaw(
        buf, chunk.type, chunk.timestamp, chunk.duration ?? 0,
        meta as EncodedAudioChunkMetadata,
      )
    },
    error: (e) => { throw new Error(`AudioEncoder error: ${e.message}`) },
  })
  encoder.configure({ codec: 'mp4a.40.2', numberOfChannels: channels, sampleRate, bitrate: 192_000 })

  const frameSize = 1024
  const total = buffer.length
  for (let offset = 0; offset < total; offset += frameSize) {
    const numSamples = Math.min(frameSize, total - offset)
    const planar = new Float32Array(numSamples * channels)
    for (let ch = 0; ch < channels; ch++) {
      planar.set(buffer.getChannelData(ch).subarray(offset, offset + numSamples), ch * numSamples)
    }
    const frame = new AudioData({
      format: 'f32-planar',
      sampleRate,
      numberOfFrames: numSamples,
      numberOfChannels: channels,
      timestamp: Math.round((offset / sampleRate) * 1_000_000),
      data: planar,
    })
    encoder.encode(frame)
    frame.close()
  }

  await encoder.flush()
  encoder.close()
  muxer.finalize()

  return new Blob([(muxer.target as ArrayBufferTarget).buffer], { type: 'audio/mp4' })
}

// ---------------------------------------------------------------------------
// Video: decode the trimmed span → H.264 in an MP4, muxed with the trimmed audio
// ---------------------------------------------------------------------------

type StoredChunk = {
  data: Uint8Array
  type: 'key' | 'delta'
  timestamp: number
  duration: number
  meta?: EncodedVideoChunkMetadata
}

/** Encode the source video's played span [sourceIn, sourceOut] at its native resolution + fps. */
async function encodeTrimmedVideo(data: VideoData, blob: Blob, projectFps: number): Promise<Blob> {
  if (typeof VideoEncoder === 'undefined') {
    throw new Error('Video encoding is not supported in this browser')
  }
  const source = await createVideoFrameSource(blob)
  const fps = source.fps > 0 ? source.fps : projectFps || 30
  const sIn = srcIn(data)
  const span = sourceSpan(data)
  const totalFrames = Math.max(1, Math.round(span * fps))
  const gopSize = Math.max(1, Math.round(fps * 2))

  let canvas: HTMLCanvasElement | null = null
  let ctx: CanvasRenderingContext2D | null = null
  let encoder: VideoEncoder | null = null
  let width = 0
  let height = 0
  const videoChunks: StoredChunk[] = []

  try {
    for (let i = 0; i < totalFrames; i++) {
      const frame = await source.getFrameAtTime(sIn + i / fps)
      if (!frame) continue

      // getFrameAtTime returns an orientation-corrected drawable at DISPLAY size
      // (a VideoFrame, or an OffscreenCanvas when the container declared a rotation).
      const fw = 'displayWidth' in frame ? frame.displayWidth : frame.width
      const fh = 'displayHeight' in frame ? frame.displayHeight : frame.height

      if (!ctx) {
        // H.264 needs even dimensions — round down.
        width = Math.max(2, Math.floor(fw / 2) * 2)
        height = Math.max(2, Math.floor(fh / 2) * 2)
        canvas = document.createElement('canvas')
        canvas.width = width
        canvas.height = height
        ctx = canvas.getContext('2d')!
        const cfg = await findSupportedVideoCodec(width, height, fps, bitrateFor(width, height, fps))
        encoder = new VideoEncoder({
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
        encoder.configure(cfg)
      }

      ctx.drawImage(frame as CanvasImageSource, 0, 0, width, height)
      const vf = new VideoFrame(canvas!, {
        timestamp: Math.round((i / fps) * 1_000_000),
        duration: Math.round(1_000_000 / fps),
      })
      encoder!.encode(vf, { keyFrame: i % gopSize === 0 })
      vf.close()

      while (encoder!.encodeQueueSize > 10) {
        await new Promise<void>((r) => {
          encoder!.addEventListener('dequeue', () => r(), { once: true })
        })
      }
    }

    if (!encoder) throw new Error('No frames could be decoded from this video')
    await encoder.flush()
    encoder.close()
  } finally {
    source.destroy()
  }

  // Trimmed audio track — absent (or undecodable) audio just yields a silent MP4.
  let audioChunks: StoredChunk[] = []
  let audioChannels = 2
  let audioSampleRate = 48000
  try {
    const audioBuffer = await renderTrimmedAudio(blob, sIn, span)
    const encoded = await encodeAudioChunks(audioBuffer)
    audioChunks = encoded.chunks
    audioChannels = encoded.channels
    audioSampleRate = encoded.sampleRate
  } catch {
    // no audio track / decode failed → video-only
  }

  const hasAudio = audioChunks.length > 0
  const muxer = new Muxer({
    target: new ArrayBufferTarget(),
    video: { codec: 'avc', width, height },
    ...(hasAudio ? { audio: { codec: 'aac', numberOfChannels: audioChannels, sampleRate: audioSampleRate } } : {}),
    fastStart: 'in-memory',
    firstTimestampBehavior: 'offset',
  })
  for (const c of videoChunks) {
    muxer.addVideoChunkRaw(c.data, c.type, c.timestamp, c.duration, c.meta as EncodedVideoChunkMetadata)
  }
  for (const c of audioChunks) {
    muxer.addAudioChunkRaw(c.data, c.type, c.timestamp, c.duration, c.meta as unknown as EncodedAudioChunkMetadata)
  }
  muxer.finalize()

  return new Blob([(muxer.target as ArrayBufferTarget).buffer], { type: 'video/mp4' })
}

/** Encode an AudioBuffer to raw AAC chunks (for muxing alongside video). */
async function encodeAudioChunks(
  buffer: AudioBuffer,
): Promise<{ chunks: StoredChunk[]; channels: number; sampleRate: number }> {
  if (typeof AudioEncoder === 'undefined') return { chunks: [], channels: 2, sampleRate: 48000 }
  const channels = buffer.numberOfChannels
  const sampleRate = buffer.sampleRate
  const chunks: StoredChunk[] = []

  const encoder = new AudioEncoder({
    output: (chunk, meta) => {
      const buf = new Uint8Array(chunk.byteLength)
      chunk.copyTo(buf)
      chunks.push({
        data: buf,
        type: chunk.type,
        timestamp: chunk.timestamp,
        duration: chunk.duration ?? 0,
        meta: meta as unknown as EncodedVideoChunkMetadata,
      })
    },
    error: (e) => { throw new Error(`AudioEncoder error: ${e.message}`) },
  })
  encoder.configure({ codec: 'mp4a.40.2', numberOfChannels: channels, sampleRate, bitrate: 192_000 })

  const frameSize = 1024
  const total = buffer.length
  for (let offset = 0; offset < total; offset += frameSize) {
    const numSamples = Math.min(frameSize, total - offset)
    const planar = new Float32Array(numSamples * channels)
    for (let ch = 0; ch < channels; ch++) {
      planar.set(buffer.getChannelData(ch).subarray(offset, offset + numSamples), ch * numSamples)
    }
    const frame = new AudioData({
      format: 'f32-planar',
      sampleRate,
      numberOfFrames: numSamples,
      numberOfChannels: channels,
      timestamp: Math.round((offset / sampleRate) * 1_000_000),
      data: planar,
    })
    encoder.encode(frame)
    frame.close()
  }
  await encoder.flush()
  encoder.close()
  return { chunks, channels, sampleRate }
}

/** A sane per-clip video bitrate from resolution × fps (≈0.1 bits/pixel), clamped. */
function bitrateFor(width: number, height: number, fps: number): number {
  return Math.min(20_000_000, Math.max(1_000_000, Math.round(width * height * fps * 0.1)))
}

/** First supported H.264 encoder config, most→least capable (mirrors ffmpegExport). */
async function findSupportedVideoCodec(
  width: number, height: number, framerate: number, bitrate: number,
): Promise<VideoEncoderConfig> {
  const codecs = [
    'avc1.640028', 'avc1.4d0028', 'avc1.420028',
    'avc1.640020', 'avc1.4d0020', 'avc1.420020',
  ]
  for (const codec of codecs) {
    const config: VideoEncoderConfig = { codec, width, height, bitrate, framerate }
    try {
      const support = await VideoEncoder.isConfigSupported(config)
      if (support.supported) return support.config!
    } catch {
      // try next
    }
  }
  throw new Error('No supported H.264 encoder found in this browser')
}

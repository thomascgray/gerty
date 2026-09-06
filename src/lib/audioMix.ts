import type { AudioData, VideoData, TimelineObject } from '../types'
import { clipRate, srcIn, sourceSpan } from './mediaTiming'
import { timeStretch } from './timeStretch'

/** Speeds this close to 1 aren't worth stretching - schedule the buffer directly. */
const RATE_EPSILON = 1e-3

/**
 * Schedule one audio/video clip onto an offline mix, connected to `gain`, with
 * PITCH PRESERVED. When the clip plays at its native speed we schedule the decoded
 * buffer verbatim (bit-identical to the old `playbackRate`-of-1 path). When it's
 * sped up or slowed, we trim the source segment and time-stretch it (WSOLA) to the
 * clip's on-timeline length, then play at rate 1 - so the pitch matches preview
 * instead of the resampled "chipmunk" that `AudioBufferSourceNode.playbackRate`
 * would produce.
 *
 * `gain` must already be configured + connected to the destination by the caller;
 * its envelope is expressed in the OUTPUT (timeline) domain, which the stretched
 * buffer preserves, so gain scheduling is unaffected.
 */
export function scheduleClipSource(
  ctx: BaseAudioContext,
  decoded: AudioBuffer,
  data: AudioData | VideoData,
  obj: TimelineObject,
  gain: GainNode,
): void {
  const rate = clipRate(data, obj.duration)
  const source = ctx.createBufferSource()

  if (Math.abs(rate - 1) < RATE_EPSILON) {
    // Native speed: no pitch problem to solve. Trim via start()'s offset/duration
    // args exactly as before (spec 14 R6).
    source.buffer = decoded
    source.connect(gain)
    source.start(obj.startTime, srcIn(data), sourceSpan(data))
    return
  }

  const sr = decoded.sampleRate
  const inStart = Math.max(0, Math.round(srcIn(data) * sr))
  const inLen = Math.min(decoded.length - inStart, Math.round(sourceSpan(data) * sr))
  if (inLen <= 0) return

  // Extract the trimmed segment per channel (views - timeStretch only reads them).
  const segment: Float32Array[] = []
  for (let ch = 0; ch < decoded.numberOfChannels; ch++) {
    segment.push(decoded.getChannelData(ch).subarray(inStart, inStart + inLen))
  }

  const stretched = timeStretch(segment, rate, sr)
  const outLen = stretched[0]?.length ?? 0
  if (outLen <= 0) return

  const buffer = ctx.createBuffer(stretched.length, outLen, sr)
  for (let ch = 0; ch < stretched.length; ch++) buffer.getChannelData(ch).set(stretched[ch])

  source.buffer = buffer
  source.connect(gain)
  // Buffer is already the trimmed + retimed segment, so play it whole at rate 1.
  source.start(obj.startTime)
}

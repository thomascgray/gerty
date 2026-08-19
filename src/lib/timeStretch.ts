/**
 * WSOLA time-stretch: change tempo while PRESERVING pitch.
 *
 * Preview gets this for free - it plays clips through an HTMLMediaElement whose
 * `preservesPitch` defaults to true, so a sped-up clip stays the same pitch. The
 * export mix, however, runs through an OfflineAudioContext and an
 * `AudioBufferSourceNode`, whose only speed control (`playbackRate`) resamples the
 * buffer and therefore shifts pitch (the "chipmunk" export). This module fills that
 * gap: given a clip's decoded segment we resample it in TIME (not pitch) to the
 * clip's on-timeline length, then the mix schedules it at rate 1.
 *
 * The algorithm is classic WSOLA (Waveform Similarity Overlap-Add): hop through the
 * input at an analysis rate set by the tempo change, but nudge each grabbed frame by
 * a few samples so successive frames stay waveform-aligned, which kills the periodic
 * warble a naive overlap-add produces. All channels share one analysis path (the
 * per-frame nudge is chosen from a mono mixdown) so the stereo image stays coherent.
 */

/** Hann window of length n (0 at both ends, used for the overlap-add taper). */
function hann(n: number): Float32Array {
  const w = new Float32Array(n)
  for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1))
  return w
}

/** Down-mix all channels to a single mono reference for the similarity search. */
function mixMono(channels: Float32Array[], len: number): Float32Array {
  const mono = new Float32Array(len)
  const inv = 1 / channels.length
  for (const ch of channels) {
    for (let i = 0; i < len; i++) mono[i] += ch[i] * inv
  }
  return mono
}

/**
 * Find the frame offset (delta), within +/-tol of `candCenter`, whose `corrLen`-sample
 * window best matches the natural continuation of the previous frame (`refStart`).
 * Coarse-to-fine (step 4 then +/-4 refine) keeps it cheap enough for long clips.
 */
function bestDelta(
  x: Float32Array,
  len: number,
  refStart: number,
  candCenter: number,
  corrLen: number,
  tol: number,
): number {
  const score = (delta: number): number => {
    const cs = candCenter + delta
    let acc = 0
    for (let n = 0; n < corrLen; n++) {
      const ri = refStart + n
      const ci = cs + n
      const rv = ri >= 0 && ri < len ? x[ri] : 0
      const cv = ci >= 0 && ci < len ? x[ci] : 0
      acc += rv * cv
    }
    return acc
  }
  const search = (lo: number, hi: number, step: number): number => {
    let best = lo
    let bestScore = -Infinity
    for (let d = lo; d <= hi; d += step) {
      const s = score(d)
      if (s > bestScore) {
        bestScore = s
        best = d
      }
    }
    return best
  }
  const coarse = search(-tol, tol, 4)
  return search(Math.max(-tol, coarse - 4), Math.min(tol, coarse + 4), 1)
}

/**
 * Time-stretch `channels` so the output plays at the clip's on-timeline length.
 *
 * `rate` is the clip's speed = source span / on-timeline duration: rate > 1 = sped up
 * (output is compressed), rate < 1 = slowed (output is expanded). Output length is
 * `round(inputLength / rate)`. Returns one Float32Array per input channel. Input is
 * read-only. Passing rate ~= 1 still works but callers should skip it (a plain buffer
 * schedule is bit-identical and cheaper).
 */
export function timeStretch(
  channels: Float32Array[],
  rate: number,
  sampleRate: number,
): Float32Array[] {
  const numCh = channels.length
  const inLen = channels[0]?.length ?? 0
  const outLen = Math.max(0, Math.round(inLen / rate))
  if (numCh === 0 || inLen === 0 || outLen === 0) {
    return channels.map(() => new Float32Array(0))
  }

  // ~40 ms frame, 50% overlap - a solid speech/music compromise at 44.1-48 kHz.
  const frame = Math.max(128, Math.round(sampleRate * 0.04))
  const synHop = frame >> 1
  const anaHop = synHop * rate // advance faster/slower through the input than the output
  const corrLen = synHop // similarity window
  const tol = Math.max(1, Math.round(sampleRate * 0.01)) // ~1 pitch period search radius

  const win = hann(frame)
  const out = channels.map(() => new Float32Array(outLen))
  const norm = new Float32Array(outLen)
  const mono = numCh === 1 ? channels[0] : mixMono(channels, inLen)

  let delta = 0
  const numFrames = Math.ceil(outLen / synHop) + 1
  for (let i = 0; i < numFrames; i++) {
    const synPos = i * synHop
    const anaPos = Math.round(i * anaHop) + delta

    // Overlap-add this frame from every channel (window sum tracked once, in `norm`).
    for (let ch = 0; ch < numCh; ch++) {
      const src = channels[ch]
      const dst = out[ch]
      for (let n = 0; n < frame; n++) {
        const di = synPos + n
        if (di >= outLen) break
        const si = anaPos + n
        if (si < 0 || si >= inLen) continue
        dst[di] += src[si] * win[n]
        if (ch === 0) norm[di] += win[n]
      }
    }

    // Pick the nudge for the NEXT frame: align the next ideal analysis frame with the
    // natural continuation (advance-by-synHop) of the frame we just placed.
    const nextCenter = Math.round((i + 1) * anaHop)
    delta = bestDelta(mono, inLen, anaPos + synHop, nextCenter, corrLen, tol)
  }

  // Undo the accumulated Hann weighting (50% overlap isn't perfectly flat, and the
  // very ends collect fewer taps).
  for (let ch = 0; ch < numCh; ch++) {
    const dst = out[ch]
    for (let j = 0; j < outLen; j++) {
      const w = norm[j]
      if (w > 1e-6) dst[j] /= w
    }
  }
  return out
}

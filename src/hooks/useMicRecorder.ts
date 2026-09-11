import { useCallback, useEffect, useRef, useState } from 'react'

export type RecordResult = { blob: Blob; duration: number }

// idle: no mic held. armed: mic acquired + level meter live, ready to record (used by the live
// voiceover path, spec 39). recording: MediaRecorder capturing. error: acquisition/capture failed.
export type MicPhase = 'idle' | 'armed' | 'recording' | 'error'

// True when this browser/context can actually record: needs a secure context (HTTPS or localhost),
// getUserMedia, and MediaRecorder. Checked up front so callers degrade to a readable message instead
// of throwing on the first click.
export function recordingSupported(): boolean {
  return (
    typeof window !== 'undefined' &&
    window.isSecureContext &&
    typeof navigator !== 'undefined' &&
    !!navigator.mediaDevices?.getUserMedia &&
    typeof MediaRecorder !== 'undefined'
  )
}

// Pick a supported audio container, mirroring the export fallback's getSupportedMimeType (Opus in
// WebM for Chrome/Firefox, mp4/AAC for Safari). undefined ⇒ let the browser choose its default.
export function pickAudioMimeType(): string | undefined {
  const types = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus']
  for (const t of types) {
    if (MediaRecorder.isTypeSupported(t)) return t
  }
  return undefined
}

export function describeMicError(err: unknown): string {
  const name = (err as DOMException)?.name
  if (name === 'NotAllowedError' || name === 'SecurityError')
    return "Microphone access was blocked. Allow it in your browser's site settings and try again."
  if (name === 'NotFoundError' || name === 'DevicesNotFoundError')
    return 'No microphone was found. Plug one in and try again.'
  if (name === 'NotReadableError' || name === 'TrackStartError')
    return 'Your microphone is in use by another app. Close it and try again.'
  return "Couldn't start recording. Check your microphone and try again."
}

/**
 * Microphone capture, shared by RecordModal (spec 34, modal record) and the live voiceover recorder
 * (spec 39, record against the playing timeline).
 *
 * Two entry paths:
 * - Modal: call `start()` directly — it acquires the mic (permission prompt), then records.
 * - Live: call `arm()` first (acquires the mic + runs the level meter so the start gesture is
 *   instant), then `start()` fires the recorder with no getUserMedia latency.
 *
 * `stop()` resolves the finished take and returns to `armed` (the stream stays live for another take);
 * `cancel()` discards the in-progress take and returns to `armed`; `dispose()` releases everything.
 * Duration here is the wall-clock elapsed hint — callers derive the authoritative value from
 * `decodeAudio` (AudioBuffer.duration) to sidestep the MediaRecorder-WebM `duration === Infinity` trap.
 */
export function useMicRecorder() {
  const supported = recordingSupported()
  const [phase, setPhase] = useState<MicPhase>('idle')
  const [level, setLevel] = useState(0)
  const [elapsed, setElapsed] = useState(0)
  const [error, setError] = useState<string | null>(null)

  const recorderRef = useRef<MediaRecorder | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const chunksRef = useRef<Blob[]>([])
  const audioCtxRef = useRef<AudioContext | null>(null)
  const analyserRef = useRef<AnalyserNode | null>(null)
  const rafRef = useRef<number | null>(null)
  const startRef = useRef(0)
  const recordingRef = useRef(false)
  // Set the moment stop() is called, cleared when the recorder actually stops — lets the onstop
  // handler resolve the pending promise with the assembled blob.
  const stopResolveRef = useRef<((r: RecordResult | null) => void) | null>(null)
  // Set by cancel() so the onstop handler throws the take away instead of producing a clip.
  const discardRef = useRef(false)

  // Per-frame while the mic is live: update the RMS input level (and, while recording, the timer).
  // Named function expression so the self-scheduled rAF references its own binding, not the const.
  const tick = useCallback(function tick() {
    const analyser = analyserRef.current
    if (analyser) {
      const buf = new Uint8Array(analyser.fftSize)
      analyser.getByteTimeDomainData(buf)
      let sum = 0
      for (let i = 0; i < buf.length; i++) { const v = (buf[i] - 128) / 128; sum += v * v }
      setLevel(Math.min(1, Math.sqrt(sum / buf.length) * 2.8))
    }
    if (recordingRef.current) setElapsed((performance.now() - startRef.current) / 1000)
    rafRef.current = requestAnimationFrame(tick)
  }, [])

  // Release the mic stream + its AudioContext + the meter loop. Idempotent — safe on stop, error,
  // dispose, and unmount, so the browser's mic-in-use indicator never lingers.
  const teardownCapture = useCallback(() => {
    if (rafRef.current != null) { cancelAnimationFrame(rafRef.current); rafRef.current = null }
    setLevel(0)
    streamRef.current?.getTracks().forEach((t) => t.stop())
    streamRef.current = null
    analyserRef.current = null
    recordingRef.current = false
    if (audioCtxRef.current) { void audioCtxRef.current.close().catch(() => {}); audioCtxRef.current = null }
  }, [])

  useEffect(() => () => { teardownCapture(); recorderRef.current = null }, [teardownCapture])

  // Acquire the mic + wire the level-meter analyser (an AnalyserNode tapped off the live stream, never
  // connected to a destination, so it makes no sound). Resolves null on success, or a readable error
  // message on failure (returned directly so callers avoid the stale-closure `error` state).
  const arm = useCallback(async (): Promise<string | null> => {
    if (!supported) { const e = describeMicError(new DOMException('', 'SecurityError')); setError(e); setPhase('error'); return e }
    if (streamRef.current) return null
    setError(null)
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      streamRef.current = stream
      const ac = new AudioContext()
      const analyser = ac.createAnalyser()
      analyser.fftSize = 1024
      ac.createMediaStreamSource(stream).connect(analyser)
      audioCtxRef.current = ac
      analyserRef.current = analyser
      setElapsed(0)
      rafRef.current = requestAnimationFrame(tick)
      setPhase('armed')
      return null
    } catch (err) {
      teardownCapture()
      const e = describeMicError(err)
      setError(e)
      setPhase('error')
      return e
    }
  }, [supported, tick, teardownCapture])

  // Assemble the finished blob and resolve the pending stop() promise. An empty capture (stopped
  // instantly / decode-less silent blob) or a cancelled take resolves null so no clip is created.
  const handleStop = useCallback(() => {
    recordingRef.current = false
    const resolve = stopResolveRef.current
    stopResolveRef.current = null
    if (discardRef.current) { discardRef.current = false; chunksRef.current = []; resolve?.(null); return }
    const chunks = chunksRef.current
    const type = recorderRef.current?.mimeType || chunks[0]?.type || 'audio/webm'
    const blob = new Blob(chunks, { type })
    const dur = (performance.now() - startRef.current) / 1000
    chunksRef.current = []
    if (blob.size === 0 || dur < 0.15) { resolve?.(null); return }
    resolve?.({ blob, duration: dur })
  }, [])

  // Begin capture. If not already armed, acquire the mic first (the modal path). No-op while recording.
  // Resolves null on success or a readable error message on failure.
  const start = useCallback(async (): Promise<string | null> => {
    if (recordingRef.current) return null
    if (!streamRef.current) { const err = await arm(); if (err) return err }
    const stream = streamRef.current
    if (!stream) return "Couldn't start recording. Check your microphone and try again."
    const mimeType = pickAudioMimeType()
    const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined)
    chunksRef.current = []
    discardRef.current = false
    recorder.ondataavailable = (e) => { if (e.data.size > 0) chunksRef.current.push(e.data) }
    recorder.onstop = handleStop
    recorderRef.current = recorder
    startRef.current = performance.now()
    setElapsed(0)
    recordingRef.current = true
    recorder.start()
    setPhase('recording')
    return null
  }, [arm, handleStop])

  // Stop and return the take. Keeps the stream live (back to 'armed') for another take; callers that
  // want the mic released (the modal, on close) call dispose() afterwards.
  const stop = useCallback((): Promise<RecordResult | null> => {
    const rec = recorderRef.current
    return new Promise<RecordResult | null>((resolve) => {
      if (!rec || rec.state === 'inactive') { resolve(null); return }
      stopResolveRef.current = resolve
      rec.stop()
    }).then((r) => {
      setElapsed(0)
      if (streamRef.current) setPhase('armed')
      return r
    })
  }, [])

  // Discard an in-progress take (Escape). Keeps the stream armed.
  const cancel = useCallback(() => {
    discardRef.current = true
    const rec = recorderRef.current
    if (rec && rec.state !== 'inactive') rec.stop()  // → handleStop, resolves null
    else { chunksRef.current = []; recordingRef.current = false }
    setElapsed(0)
    if (streamRef.current) setPhase('armed')
  }, [])

  // Full teardown: release the mic + context + loop, drop the recorder, back to idle.
  const dispose = useCallback(() => {
    const rec = recorderRef.current
    if (rec && rec.state !== 'inactive') { discardRef.current = true; try { rec.stop() } catch { /* already gone */ } }
    recorderRef.current = null
    teardownCapture()
    setElapsed(0)
    setPhase('idle')
  }, [teardownCapture])

  return { supported, phase, level, elapsed, error, arm, start, stop, cancel, dispose }
}

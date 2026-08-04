import { useState, useEffect, useRef, useCallback } from 'react'
import {
  IconX, IconAlertTriangle, IconMicrophone, IconPlayerStopFilled,
  IconPlayerPlayFilled, IconPlayerPauseFilled, IconLock,
} from '@tabler/icons-react'

export type RecordResult = { blob: Blob; duration: number }

type RecordModalProps = {
  onClose: () => void
  // Commit the finished take. The parent stores the asset (deriving the exact duration + waveform
  // from the blob) and creates the audio clip at the playhead. `duration` is the elapsed-time hint.
  onConfirm: (result: RecordResult) => void
}

type Phase = 'idle' | 'recording' | 'recorded' | 'error'

// True when this browser/context can actually record: needs a secure context (HTTPS or localhost),
// getUserMedia, and MediaRecorder. Checked up front so the modal degrades to a readable message
// instead of throwing on the first click.
function recordingSupported(): boolean {
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
function pickAudioMimeType(): string | undefined {
  const types = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus']
  for (const t of types) {
    if (MediaRecorder.isTypeSupported(t)) return t
  }
  return undefined
}

function describeMicError(err: unknown): string {
  const name = (err as DOMException)?.name
  if (name === 'NotAllowedError' || name === 'SecurityError')
    return "Microphone access was blocked. Allow it in your browser's site settings and try again."
  if (name === 'NotFoundError' || name === 'DevicesNotFoundError')
    return 'No microphone was found. Plug one in and try again.'
  if (name === 'NotReadableError' || name === 'TrackStartError')
    return 'Your microphone is in use by another app. Close it and try again.'
  return "Couldn't start recording. Check your microphone and try again."
}

function fmtTime(sec: number): string {
  const s = Math.max(0, Math.floor(sec))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

/**
 * Microphone recording modal (spec 34). idle → recording (live timer + input-level meter) →
 * recorded (in-modal preview) → Add to timeline. Mirrors TtsModal's scaffold; the finished blob
 * goes up to App which commits it through the same audio-asset path a TTS clip uses.
 */
export default function RecordModal({ onClose, onConfirm }: RecordModalProps) {
  const [supported] = useState(recordingSupported)
  const [phase, setPhase] = useState<Phase>('idle')
  const [elapsed, setElapsed] = useState(0)
  const [level, setLevel] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<RecordResult | null>(null)
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  const [playing, setPlaying] = useState(false)

  const recorderRef = useRef<MediaRecorder | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const chunksRef = useRef<Blob[]>([])
  const audioCtxRef = useRef<AudioContext | null>(null)
  const analyserRef = useRef<AnalyserNode | null>(null)
  const rafRef = useRef<number | null>(null)
  const startRef = useRef(0)
  const urlRef = useRef<string | null>(null)
  const audioRef = useRef<HTMLAudioElement | null>(null)

  const setPreview = useCallback((url: string | null) => {
    if (urlRef.current) URL.revokeObjectURL(urlRef.current)
    urlRef.current = url
    setPreviewUrl(url)
  }, [])

  // Stop the level-meter loop; release the mic stream + its AudioContext. Idempotent — safe to call
  // on stop, on error, and on unmount, so the browser's mic-in-use indicator never lingers.
  const teardownCapture = useCallback(() => {
    if (rafRef.current != null) { cancelAnimationFrame(rafRef.current); rafRef.current = null }
    setLevel(0)
    streamRef.current?.getTracks().forEach((t) => t.stop())
    streamRef.current = null
    analyserRef.current = null
    if (audioCtxRef.current) { void audioCtxRef.current.close().catch(() => {}); audioCtxRef.current = null }
  }, [])

  // Full cleanup on unmount: capture teardown + revoke the preview URL.
  useEffect(() => () => {
    teardownCapture()
    if (urlRef.current) URL.revokeObjectURL(urlRef.current)
  }, [teardownCapture])

  // Per-frame while recording: update the elapsed timer and the RMS input level.
  const tick = useCallback(() => {
    const analyser = analyserRef.current
    if (!analyser) return
    const buf = new Uint8Array(analyser.fftSize)
    analyser.getByteTimeDomainData(buf)
    let sum = 0
    for (let i = 0; i < buf.length; i++) { const v = (buf[i] - 128) / 128; sum += v * v }
    const rms = Math.sqrt(sum / buf.length)
    setLevel(Math.min(1, rms * 2.8))
    setElapsed((performance.now() - startRef.current) / 1000)
    rafRef.current = requestAnimationFrame(tick)
  }, [])

  // MediaRecorder.stop fires this: assemble the blob, release the mic, and move to preview. An empty
  // capture (stopped instantly, or a decode-less silent blob) is rejected rather than becoming a clip.
  const handleStop = useCallback(() => {
    const chunks = chunksRef.current
    const type = recorderRef.current?.mimeType || chunks[0]?.type || 'audio/webm'
    const blob = new Blob(chunks, { type })
    const dur = (performance.now() - startRef.current) / 1000
    teardownCapture()
    if (blob.size === 0 || dur < 0.15) {
      setPhase('error')
      setError('That recording was empty - try again.')
      return
    }
    setResult({ blob, duration: dur })
    setPreview(URL.createObjectURL(blob))
    setElapsed(dur)
    setPlaying(false)
    setPhase('recorded')
  }, [setPreview, teardownCapture])

  const startRecording = useCallback(async () => {
    if (!supported) return
    setError(null)
    setResult(null)
    setPreview(null)
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      streamRef.current = stream

      // Level-meter tap: an AnalyserNode off the live stream (never connected to a destination, so it
      // makes no sound). Torn down with the stream in teardownCapture.
      const ac = new AudioContext()
      const analyser = ac.createAnalyser()
      analyser.fftSize = 1024
      ac.createMediaStreamSource(stream).connect(analyser)
      audioCtxRef.current = ac
      analyserRef.current = analyser

      const mimeType = pickAudioMimeType()
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined)
      chunksRef.current = []
      recorder.ondataavailable = (e) => { if (e.data.size > 0) chunksRef.current.push(e.data) }
      recorder.onstop = handleStop
      recorderRef.current = recorder

      startRef.current = performance.now()
      setElapsed(0)
      recorder.start()
      setPhase('recording')
      rafRef.current = requestAnimationFrame(tick)
    } catch (err) {
      teardownCapture()
      setPhase('error')
      setError(describeMicError(err))
    }
  }, [supported, handleStop, tick, setPreview, teardownCapture])

  const stopRecording = useCallback(() => {
    recorderRef.current?.stop()  // → handleStop
  }, [])

  const togglePreview = useCallback(() => {
    const el = audioRef.current
    if (!el) return
    if (el.paused) { void el.play(); setPlaying(true) }
    else { el.pause(); setPlaying(false) }
  }, [])

  // Esc / backdrop close, but never mid-recording (an accidental keypress shouldn't discard a take;
  // require an explicit Stop first).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && phase !== 'recording') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, phase])

  const canClose = phase !== 'recording'
  const canCommit = phase === 'recorded' && result != null

  return (
    <div
      className="fixed inset-0 bg-black/70 flex items-center justify-center z-100"
      onClick={canClose ? onClose : undefined}
    >
      <div
        className="bg-surface rounded-lg shadow-xl w-[480px] max-w-[90vw] max-h-[85vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-border">
          <h2 className="text-lg font-bold text-fg flex items-center gap-2">
            <IconMicrophone size={20} stroke={2} /> Record voiceover
          </h2>
          <button
            onClick={canClose ? onClose : undefined}
            disabled={!canClose}
            className="flex items-center text-muted hover:text-fg disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
          >
            <IconX size={20} stroke={2} />
          </button>
        </div>

        {/* Body */}
        <div className="p-4 flex flex-col gap-4 overflow-y-auto">
          {!supported ? (
            <div className="flex items-start gap-2 text-xs text-red-400 bg-red-500/10 border border-red-500/30 rounded-lg px-3 py-2">
              <IconAlertTriangle size={15} className="shrink-0 mt-0.5" />
              <span>
                Recording isn't available here. It needs a secure page (HTTPS or localhost) and a
                browser with microphone support.
              </span>
            </div>
          ) : (
            <>
              {/* On-device notice, matching the TTS modal's tone. */}
              <div className="flex items-start gap-2 text-[11px] leading-relaxed text-subtle bg-surface-muted border border-border rounded-lg px-3 py-2">
                <IconLock size={14} className="shrink-0 mt-0.5 text-muted" />
                <span>Recording happens in your browser and never leaves this device.</span>
              </div>

              {/* Timer + level meter */}
              <div className="flex flex-col items-center gap-3 py-2">
                <div className="flex items-center gap-2">
                  {phase === 'recording' && (
                    <span className="w-2.5 h-2.5 rounded-full bg-red-500 animate-pulse" />
                  )}
                  <span className="text-3xl font-mono tabular-nums text-fg">{fmtTime(elapsed)}</span>
                </div>

                {/* Input level: a bar that only carries signal while recording. */}
                <div className="w-full h-2 rounded-full bg-surface-muted overflow-hidden">
                  <div
                    className="h-full bg-accent transition-[width] duration-75 ease-out"
                    style={{ width: `${(phase === 'recording' ? level : 0) * 100}%` }}
                  />
                </div>

                {/* Primary transport control per phase. */}
                {phase === 'recording' ? (
                  <button
                    onClick={stopRecording}
                    className="flex items-center gap-2 px-5 py-2.5 text-sm font-medium rounded-lg bg-red-500 text-white hover:bg-red-600 cursor-pointer transition-colors"
                  >
                    <IconPlayerStopFilled size={16} /> Stop
                  </button>
                ) : (
                  <button
                    onClick={startRecording}
                    className="flex items-center gap-2 px-5 py-2.5 text-sm font-medium rounded-lg bg-accent text-accent-contrast hover:bg-accent-hover cursor-pointer transition-colors"
                  >
                    <IconMicrophone size={16} /> {phase === 'recorded' || phase === 'error' ? 'Re-record' : 'Record'}
                  </button>
                )}
              </div>

              {/* Preview of a finished take. */}
              {phase === 'recorded' && previewUrl && (
                <div className="flex items-center justify-center gap-3">
                  <button
                    onClick={togglePreview}
                    className="flex items-center gap-1.5 px-3 py-2 text-sm text-fg rounded-lg bg-surface-muted border border-border hover:bg-surface-hover cursor-pointer transition-colors"
                  >
                    {playing ? <IconPlayerPauseFilled size={15} /> : <IconPlayerPlayFilled size={15} />}
                    Preview{result ? ` · ${result.duration.toFixed(1)}s` : ''}
                  </button>
                  <audio ref={audioRef} src={previewUrl} onEnded={() => setPlaying(false)} className="hidden" />
                </div>
              )}

              {error && (
                <div className="flex items-start gap-2 text-xs text-red-400 bg-red-500/10 border border-red-500/30 rounded-lg px-3 py-2">
                  <IconAlertTriangle size={15} className="shrink-0 mt-0.5" />
                  <span>{error}</span>
                </div>
              )}
            </>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 p-4 border-t border-border">
          <button
            onClick={canClose ? onClose : undefined}
            disabled={!canClose}
            className="px-4 py-2 text-sm text-muted hover:text-fg disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
          >
            Cancel
          </button>
          <button
            onClick={() => result && onConfirm(result)}
            disabled={!canCommit}
            className="px-4 py-2 text-sm font-medium rounded-lg bg-accent text-accent-contrast hover:bg-accent-hover disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer transition-colors"
          >
            Add to timeline
          </button>
        </div>
      </div>
    </div>
  )
}

import { useState, useEffect, useRef, useCallback } from 'react'
import {
  IconX, IconAlertTriangle, IconMicrophone, IconPlayerStopFilled,
  IconPlayerPlayFilled, IconPlayerPauseFilled, IconLock,
} from '@tabler/icons-react'
import { useMicRecorder, type RecordResult } from '../hooks/useMicRecorder'

export type { RecordResult }

type RecordModalProps = {
  onClose: () => void
  // Commit the finished take. The parent stores the asset (deriving the exact duration + waveform
  // from the blob) and creates the audio clip at the playhead. `duration` is the elapsed-time hint.
  onConfirm: (result: RecordResult) => void
}

function fmtTime(sec: number): string {
  const s = Math.max(0, Math.floor(sec))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

/**
 * Microphone recording modal (spec 34). idle → recording (live timer + input-level meter) →
 * recorded (in-modal preview) → Add to timeline. Capture is handled by the shared `useMicRecorder`
 * hook (spec 39); the finished blob goes up to App which commits it through the same audio-asset path
 * a TTS clip uses. The live-voiceover recorder in the transport uses the same hook.
 */
export default function RecordModal({ onClose, onConfirm }: RecordModalProps) {
  const mic = useMicRecorder()
  const [result, setResult] = useState<RecordResult | null>(null)
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  const [playing, setPlaying] = useState(false)
  const [emptyMsg, setEmptyMsg] = useState<string | null>(null)

  const urlRef = useRef<string | null>(null)
  const audioRef = useRef<HTMLAudioElement | null>(null)

  const isRecording = mic.phase === 'recording'

  const setPreview = useCallback((url: string | null) => {
    if (urlRef.current) URL.revokeObjectURL(urlRef.current)
    urlRef.current = url
    setPreviewUrl(url)
  }, [])

  // Revoke the preview URL on unmount (the hook releases the mic on its own unmount).
  useEffect(() => () => { if (urlRef.current) URL.revokeObjectURL(urlRef.current) }, [])

  const startRecording = useCallback(async () => {
    setResult(null)
    setPreview(null)
    setPlaying(false)
    setEmptyMsg(null)
    await mic.start()  // auto-arms (permission prompt) then records
  }, [mic, setPreview])

  const stopRecording = useCallback(async () => {
    const r = await mic.stop()
    mic.dispose()  // release the mic for the preview step
    if (r) {
      setResult(r)
      setPreview(URL.createObjectURL(r.blob))
    } else {
      setEmptyMsg('That recording was empty - try again.')
    }
    // Permission/device failures surface via mic.error below.
  }, [mic, setPreview])

  const togglePreview = useCallback(() => {
    const el = audioRef.current
    if (!el) return
    if (el.paused) { void el.play(); setPlaying(true) }
    else { el.pause(); setPlaying(false) }
  }, [])

  // Esc / backdrop close, but never mid-recording (an accidental keypress shouldn't discard a take;
  // require an explicit Stop first). Release the mic on close.
  const handleClose = useCallback(() => { mic.dispose(); onClose() }, [mic, onClose])
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !isRecording) handleClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [handleClose, isRecording])

  const canClose = !isRecording
  const canCommit = result != null
  const elapsed = result ? result.duration : mic.elapsed

  return (
    <div
      className="fixed inset-0 bg-black/70 flex items-center justify-center z-100"
      onClick={canClose ? handleClose : undefined}
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
            onClick={canClose ? handleClose : undefined}
            disabled={!canClose}
            className="flex items-center text-muted hover:text-fg disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
          >
            <IconX size={20} stroke={2} />
          </button>
        </div>

        {/* Body */}
        <div className="p-4 flex flex-col gap-4 overflow-y-auto">
          {!mic.supported ? (
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
                  {isRecording && (
                    <span className="w-2.5 h-2.5 rounded-full bg-red-500 animate-pulse" />
                  )}
                  <span className="text-3xl font-mono tabular-nums text-fg">{fmtTime(elapsed)}</span>
                </div>

                {/* Input level: a bar that only carries signal while recording. */}
                <div className="w-full h-2 rounded-full bg-surface-muted overflow-hidden">
                  <div
                    className="h-full bg-accent transition-[width] duration-75 ease-out"
                    style={{ width: `${(isRecording ? mic.level : 0) * 100}%` }}
                  />
                </div>

                {/* Primary transport control per phase. */}
                {isRecording ? (
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
                    <IconMicrophone size={16} /> {result || mic.phase === 'error' ? 'Re-record' : 'Record'}
                  </button>
                )}
              </div>

              {/* Preview of a finished take. */}
              {result && previewUrl && (
                <div className="flex items-center justify-center gap-3">
                  <button
                    onClick={togglePreview}
                    className="flex items-center gap-1.5 px-3 py-2 text-sm text-fg rounded-lg bg-surface-muted border border-border hover:bg-surface-hover cursor-pointer transition-colors"
                  >
                    {playing ? <IconPlayerPauseFilled size={15} /> : <IconPlayerPlayFilled size={15} />}
                    Preview · {result.duration.toFixed(1)}s
                  </button>
                  <audio ref={audioRef} src={previewUrl} onEnded={() => setPlaying(false)} className="hidden" />
                </div>
              )}

              {(mic.error || emptyMsg) && (
                <div className="flex items-start gap-2 text-xs text-red-400 bg-red-500/10 border border-red-500/30 rounded-lg px-3 py-2">
                  <IconAlertTriangle size={15} className="shrink-0 mt-0.5" />
                  <span>{mic.error || emptyMsg}</span>
                </div>
              )}
            </>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 p-4 border-t border-border">
          <button
            onClick={canClose ? handleClose : undefined}
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

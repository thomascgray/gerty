import { useState, useEffect, useRef, useCallback } from 'react'
import { IconX, IconAlertTriangle, IconPlayerPlayFilled, IconPlayerPauseFilled, IconWaveSine, IconLock } from '@tabler/icons-react'
import { synthesizeSpeech, TTS_VOICES, DEFAULT_TTS_VOICE } from '../lib/tts'
import type { TtsProgress, TtsResult } from '../lib/tts'

export type TtsParams = { text: string; voice: string; speed: number }

type TtsModalProps = {
  mode: 'create' | 'edit'
  initial?: TtsParams
  onClose: () => void
  // Commit the currently-generated audio. The parent stores the asset + creates/updates the clip.
  onConfirm: (result: TtsResult, params: TtsParams) => void
}

// Group voices by accent/gender for the <optgroup> picker.
const VOICE_GROUPS = TTS_VOICES.reduce<Record<string, typeof TTS_VOICES>>((acc, v) => {
  ;(acc[v.group] ??= []).push(v)
  return acc
}, {})

/**
 * Text-to-Speech authoring modal (spec 32). The user writes a script, picks a voice + speed, presses
 * Generate (synthesizes ONCE, previews in-modal), then commits with the primary button, which reuses
 * the held blob — no re-synthesis. Editing any field after generating invalidates the held blob.
 */
export default function TtsModal({ mode, initial, onClose, onConfirm }: TtsModalProps) {
  const [text, setText] = useState(initial?.text ?? '')
  const [voice, setVoice] = useState(initial?.voice ?? DEFAULT_TTS_VOICE)
  // pocket-tts has no speed control (spec 32 port); the field is retained for TtsSource round-tripping.
  const [speed] = useState(initial?.speed ?? 1)

  const [generating, setGenerating] = useState(false)
  const [progress, setProgress] = useState<TtsProgress | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<TtsResult | null>(null)
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  const [playing, setPlaying] = useState(false)

  const audioRef = useRef<HTMLAudioElement | null>(null)
  const urlRef = useRef<string | null>(null)

  // Revoke the last preview object URL whenever it changes or on unmount.
  const setPreview = useCallback((url: string | null) => {
    if (urlRef.current) URL.revokeObjectURL(urlRef.current)
    urlRef.current = url
    setPreviewUrl(url)
  }, [])
  useEffect(() => () => { if (urlRef.current) URL.revokeObjectURL(urlRef.current) }, [])

  // Editing text/voice/speed invalidates a held blob — the preview no longer matches the inputs, so
  // the commit button disables and the user must Generate again.
  const invalidate = useCallback(() => {
    setResult(null)
    setPreview(null)
    setPlaying(false)
  }, [setPreview])

  const generate = useCallback(async () => {
    if (!text.trim() || generating) return
    setGenerating(true)
    setError(null)
    setProgress(null)
    invalidate()
    try {
      const res = await synthesizeSpeech({ text: text.trim(), voice }, setProgress)
      setResult(res)
      setPreview(URL.createObjectURL(res.blob))
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setGenerating(false)
      setProgress(null)
    }
  }, [text, voice, generating, invalidate, setPreview])

  const togglePreview = useCallback(() => {
    const el = audioRef.current
    if (!el) return
    if (el.paused) { void el.play(); setPlaying(true) }
    else { el.pause(); setPlaying(false) }
  }, [])

  // Esc closes — but not mid-generation (avoids losing an in-flight ~80MB first-run download to a
  // stray keypress; the same guard applies to the backdrop click below).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !generating) onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, generating])

  const canGenerate = text.trim().length > 0 && !generating
  const canCommit = result != null && !generating
  const commitLabel = mode === 'edit' ? 'Update narration' : 'Add to timeline'

  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-100" onClick={generating ? undefined : onClose}>
      <div
        className="bg-surface rounded-lg shadow-xl w-[560px] max-w-[90vw] max-h-[85vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-border">
          <h2 className="text-lg font-bold text-fg flex items-center gap-2">
            <IconWaveSine size={20} stroke={2} /> {mode === 'edit' ? 'Edit narration' : 'Text to speech'}
          </h2>
          <button onClick={onClose} className="flex items-center text-muted hover:text-fg cursor-pointer">
            <IconX size={20} stroke={2} />
          </button>
        </div>

        {/* Body */}
        <div className="p-4 flex flex-col gap-4 overflow-y-auto">
          {/* On-device notice: privacy + the CPU-bound speed trade-off. */}
          <div className="flex items-start gap-2 text-[11px] leading-relaxed text-subtle bg-surface-muted border border-border rounded-lg px-3 py-2">
            <IconLock size={14} className="shrink-0 mt-0.5 text-muted" />
            <span>
              Runs entirely in your browser: your script and the audio never leave this device.
              The first generation downloads a one-time voice model (then it's cached). Synthesis
              runs on your CPU, so longer scripts and slower machines take more time.
            </span>
          </div>

          {/* Script */}
          <div>
            <label className="block text-[11px] font-semibold text-subtle uppercase tracking-wider mb-1.5">Script</label>
            <textarea
              value={text}
              onChange={(e) => { setText(e.target.value); invalidate() }}
              placeholder="Type or paste the narration here…"
              rows={5}
              autoFocus
              className="w-full resize-y rounded-lg bg-surface-muted border border-border px-3 py-2 text-sm text-fg placeholder:text-subtle focus:outline-none focus:border-accent"
            />
          </div>

          {/* Voice */}
          <div>
            <label className="block text-[11px] font-semibold text-subtle uppercase tracking-wider mb-1.5">Voice</label>
            <select
              value={voice}
              onChange={(e) => { setVoice(e.target.value); invalidate() }}
              className="w-full rounded-lg bg-surface-muted border border-border px-3 py-2 text-sm text-fg cursor-pointer focus:outline-none focus:border-accent"
            >
              {Object.entries(VOICE_GROUPS).map(([group, voices]) => (
                <optgroup key={group} label={group}>
                  {voices.map((v) => <option key={v.id} value={v.id}>{v.label}</option>)}
                </optgroup>
              ))}
            </select>
          </div>

          {/* Generate + preview row */}
          <div className="flex items-center gap-3">
            <button
              onClick={generate}
              disabled={!canGenerate}
              className="flex items-center justify-center gap-1.5 px-4 py-2 text-sm font-medium rounded-lg bg-surface-muted text-fg border border-border hover:bg-surface-hover disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer transition-colors"
            >
              {generating ? 'Generating…' : result ? 'Regenerate' : 'Generate'}
            </button>

            {previewUrl && (
              <button
                onClick={togglePreview}
                className="flex items-center gap-1.5 px-3 py-2 text-sm text-fg rounded-lg bg-surface-muted border border-border hover:bg-surface-hover cursor-pointer transition-colors"
              >
                {playing ? <IconPlayerPauseFilled size={15} /> : <IconPlayerPlayFilled size={15} />}
                Preview{result ? ` · ${result.duration.toFixed(1)}s` : ''}
              </button>
            )}
            {/* Hidden element drives the preview. */}
            {previewUrl && (
              <audio ref={audioRef} src={previewUrl} onEnded={() => setPlaying(false)} className="hidden" />
            )}
          </div>

          {/* Progress / status */}
          {generating && (
            <div className="text-xs text-muted">
              {progress?.phase === 'download' ? (
                <div className="flex flex-col gap-1">
                  <span>Downloading voice model{progress.progress != null ? ` · ${Math.round(progress.progress)}%` : '…'}</span>
                  <span className="text-subtle text-[11px]">One-time download; it's cached for next time.</span>
                </div>
              ) : progress?.phase === 'prepare' ? (
                <div className="flex flex-col gap-1">
                  <span>Preparing voice model…</span>
                  <span className="text-subtle text-[11px]">Compiling on your CPU; the first run can take a little while.</span>
                </div>
              ) : progress?.phase === 'synth' ? (
                <span>Synthesizing… {progress.done}/{progress.total}</span>
              ) : (
                <span>Preparing…</span>
              )}
            </div>
          )}

          {error && (
            <div className="flex items-start gap-2 text-xs text-red-400 bg-red-500/10 border border-red-500/30 rounded-lg px-3 py-2">
              <IconAlertTriangle size={15} className="shrink-0 mt-0.5" />
              <span>{error}</span>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 p-4 border-t border-border">
          <button onClick={onClose} className="px-4 py-2 text-sm text-muted hover:text-fg cursor-pointer">
            Cancel
          </button>
          <button
            onClick={() => result && onConfirm(result, { text: text.trim(), voice, speed })}
            disabled={!canCommit}
            className="px-4 py-2 text-sm font-medium rounded-lg bg-accent text-accent-contrast hover:bg-accent-hover disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer transition-colors"
          >
            {commitLabel}
          </button>
        </div>
      </div>
    </div>
  )
}

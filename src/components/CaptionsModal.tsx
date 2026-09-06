import { useState, useEffect, useCallback } from 'react'
import { IconX, IconAlertTriangle, IconBadgeCc, IconLock } from '@tabler/icons-react'
import { generateCaptions, hasTranscribableAudio } from '../lib/captions'
import type { CaptionProgress } from '../lib/captions'
import type { Project, CaptionCue } from '../types'

type CaptionsModalProps = {
  mode: 'create' | 'edit'
  project: Project
  onClose: () => void
  // Commit the generated cues. The parent creates/replaces the caption track.
  onConfirm: (cues: CaptionCue[]) => void
}

function fmtTime(sec: number): string {
  const s = Math.max(0, Math.floor(sec))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

/**
 * Auto-captions modal (spec 35). The user presses Generate → the app mixes the timeline audio and
 * runs in-browser speech recognition (Whisper), showing the recognized cues for review, then commits
 * them with the primary button. First run downloads the ASR model (cached after).
 */
export default function CaptionsModal({ mode, project, onClose, onConfirm }: CaptionsModalProps) {
  const [generating, setGenerating] = useState(false)
  const [progress, setProgress] = useState<CaptionProgress | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [cues, setCues] = useState<CaptionCue[] | null>(null)

  const hasAudio = hasTranscribableAudio(project)

  const generate = useCallback(async () => {
    if (generating || !hasAudio) return
    setGenerating(true)
    setError(null)
    setProgress(null)
    setCues(null)
    try {
      const res = await generateCaptions(project, setProgress)
      setCues(res.cues)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setGenerating(false)
      setProgress(null)
    }
  }, [generating, hasAudio, project])

  // Esc closes — but not mid-generation (avoids losing an in-flight model download to a stray keypress).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !generating) onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, generating])

  const canGenerate = hasAudio && !generating
  const canCommit = cues != null && cues.length > 0 && !generating
  const commitLabel = mode === 'edit' ? 'Regenerate captions' : 'Add captions'

  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-100" onClick={generating ? undefined : onClose}>
      <div
        className="bg-surface rounded-lg shadow-xl w-[560px] max-w-[90vw] max-h-[85vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-border">
          <h2 className="text-lg font-bold text-fg flex items-center gap-2">
            <IconBadgeCc size={20} stroke={2} /> {mode === 'edit' ? 'Regenerate captions' : 'Auto captions'}
          </h2>
          <button onClick={onClose} className="flex items-center text-muted hover:text-fg cursor-pointer">
            <IconX size={20} stroke={2} />
          </button>
        </div>

        {/* Body */}
        <div className="p-4 flex flex-col gap-4 overflow-y-auto">
          {/* On-device notice. */}
          <div className="flex items-start gap-2 text-[11px] leading-relaxed text-subtle bg-surface-muted border border-border rounded-lg px-3 py-2">
            <IconLock size={14} className="shrink-0 mt-0.5 text-muted" />
            <span>
              Transcribes the entire timeline's audio (video, audio clips, and narration) in your
              browser — nothing leaves this device. The first run downloads a one-time speech model
              (then it's cached). Recognition runs on your CPU, so longer timelines take more time.
            </span>
          </div>

          {!hasAudio && (
            <div className="flex items-start gap-2 text-xs text-amber-400 bg-amber-500/10 border border-amber-500/30 rounded-lg px-3 py-2">
              <IconAlertTriangle size={15} className="shrink-0 mt-0.5" />
              <span>There's no audio on the timeline yet. Add a video or audio clip to caption.</span>
            </div>
          )}

          {/* Generate */}
          <div>
            <button
              onClick={generate}
              disabled={!canGenerate}
              className="flex items-center justify-center gap-1.5 px-4 py-2 text-sm font-medium rounded-lg bg-surface-muted text-fg border border-border hover:bg-surface-hover disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer transition-colors"
            >
              {generating ? 'Transcribing…' : cues ? 'Regenerate' : 'Generate captions'}
            </button>
          </div>

          {/* Progress / status */}
          {generating && (
            <div className="text-xs text-muted">
              {progress?.phase === 'mixing' ? (
                <span>Mixing timeline audio…</span>
              ) : progress?.phase === 'download' ? (
                <div className="flex flex-col gap-1">
                  <span>Downloading speech model{progress.progress != null ? ` · ${Math.round(progress.progress)}%` : '…'}</span>
                  <span className="text-subtle text-[11px]">One-time download; it's cached for next time.</span>
                </div>
              ) : progress?.phase === 'prepare' ? (
                <span>Preparing speech model…</span>
              ) : progress?.phase === 'transcribe' ? (
                <div className="flex flex-col gap-1">
                  <span>
                    Recognizing speech…{progress.total ? ` · ${Math.round(((progress.done ?? 0) / progress.total) * 100)}% (${progress.done}/${progress.total})` : ''}
                  </span>
                  <span className="text-subtle text-[11px]">Running on your CPU; this can take a little while.</span>
                </div>
              ) : (
                <span>Preparing…</span>
              )}

              {/* Progress bar — determinate for download (%) and transcribe (windows done/total);
                  indeterminate (animated) for the mixing/prepare phases which have no measurable %. */}
              {(() => {
                const pct =
                  progress?.phase === 'download' && progress.progress != null ? progress.progress
                  : progress?.phase === 'transcribe' && progress.total ? ((progress.done ?? 0) / progress.total) * 100
                  : null
                return (
                  <div className="mt-2 w-full h-1.5 rounded-full bg-surface-muted overflow-hidden">
                    {pct != null ? (
                      <div className="h-full bg-accent transition-[width] duration-200 ease-out" style={{ width: `${Math.max(2, Math.min(100, pct))}%` }} />
                    ) : (
                      <div className="h-full w-1/3 bg-accent/70 animate-pulse" />
                    )}
                  </div>
                )
              })()}
            </div>
          )}

          {error && (
            <div className="flex items-start gap-2 text-xs text-red-400 bg-red-500/10 border border-red-500/30 rounded-lg px-3 py-2">
              <IconAlertTriangle size={15} className="shrink-0 mt-0.5" />
              <span>{error}</span>
            </div>
          )}

          {/* Cue preview */}
          {cues && cues.length > 0 && (
            <div className="flex flex-col gap-1.5">
              <div className="text-[11px] font-semibold text-subtle uppercase tracking-wider">
                {cues.length} caption{cues.length === 1 ? '' : 's'} · review before adding
              </div>
              <div className="max-h-[240px] overflow-y-auto rounded-lg border border-border divide-y divide-border">
                {cues.map((c) => (
                  <div key={c.id} className="flex gap-2 px-3 py-1.5 text-xs">
                    <span className="shrink-0 font-mono tabular-nums text-subtle">{fmtTime(c.startTime)}</span>
                    <span className="text-fg">{c.text}</span>
                  </div>
                ))}
              </div>
              <span className="text-subtle text-[11px]">You can correct any wording after adding, in the properties panel.</span>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 p-4 border-t border-border">
          <button onClick={onClose} className="px-4 py-2 text-sm text-muted hover:text-fg cursor-pointer">
            Cancel
          </button>
          <button
            onClick={() => cues && onConfirm(cues)}
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

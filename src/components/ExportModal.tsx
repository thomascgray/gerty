import { useMemo, useState } from 'react'
import type { Project } from '../types'
import { useFFmpegExport } from '../hooks/useFFmpegExport'
import {
  COMPRESSION_PRESETS,
  DEFAULT_COMPRESSION,
  defaultShortEdge,
  resolutionOptions,
  estimateExportBytes,
  totalDurationOf,
  formatBytes,
  type CompressionPreset,
} from '../lib/exportSettings'

type ExportModalProps = {
  project: Project
  onClose: () => void
}

export default function ExportModal({ project, onClose }: ExportModalProps) {
  const { isExporting, progress, error, startExport, cancelExport } = useFFmpegExport()

  const resolutions = useMemo(() => resolutionOptions(project), [project])
  const [shortEdge, setShortEdge] = useState(() => defaultShortEdge(project))
  const [compression, setCompression] = useState<CompressionPreset>(DEFAULT_COMPRESSION)

  const settings = { shortEdge, compression }
  const selectedRes = resolutions.find((r) => r.shortEdge === shortEdge) ?? resolutions[0]
  const selectedComp = COMPRESSION_PRESETS.find((c) => c.id === compression)!
  const estBytes = estimateExportBytes(project, settings)
  const duration = totalDurationOf(project)

  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-100">
      <div className="bg-surface rounded-lg shadow-xl p-6 w-[34rem] max-w-[92vw]">
        <h2 className="text-lg font-bold text-fg mb-4">Export Video</h2>

        {error && (
          <div className="mb-4 p-3 bg-danger-soft border border-danger/30 rounded text-danger text-sm max-h-32 overflow-y-auto wrap-break-word">
            {error}
          </div>
        )}

        {/* Static facts */}
        <div className="grid grid-cols-3 gap-3 mb-5 text-sm">
          <Fact label="Format" value="MP4 · H.264" />
          <Fact label="FPS" value={String(project.fps)} />
          <Fact label="Duration" value={`${duration.toFixed(1)}s`} />
        </div>

        {/* Resolution */}
        <div className="mb-5">
          <div className="flex items-baseline justify-between mb-2">
            <span className="text-sm font-medium text-fg">Resolution</span>
            <span className="text-xs text-subtle">
              {selectedRes.width} × {selectedRes.height}px
            </span>
          </div>
          <div className="flex gap-2">
            {resolutions.map((r) => (
              <ChipButton
                key={r.shortEdge}
                selected={r.shortEdge === shortEdge}
                onClick={() => setShortEdge(r.shortEdge)}
                disabled={isExporting}
              >
                {r.label}
                {r.native && <span className="ml-1 text-[10px] opacity-60">Full</span>}
              </ChipButton>
            ))}
          </div>
        </div>

        {/* Compression */}
        <div className="mb-5">
          <span className="text-sm font-medium text-fg">Compression</span>
          <div className="flex flex-wrap gap-2 mt-2">
            {COMPRESSION_PRESETS.map((c) => (
              <ChipButton
                key={c.id}
                selected={c.id === compression}
                onClick={() => setCompression(c.id)}
                disabled={isExporting}
              >
                {c.label}
              </ChipButton>
            ))}
          </div>
          <p className="text-xs text-muted mt-2 leading-relaxed">{selectedComp.blurb}</p>
          <p className="text-xs text-subtle mt-1">Quality does not affect export speed.</p>
        </div>

        {/* Estimated size — an upper bound: VBR (spec 30) lets simple content come in under. */}
        <div className="flex items-baseline justify-between mb-5 px-3 py-2 bg-surface-muted rounded border border-border">
          <span className="text-sm text-muted">Estimated size</span>
          <span className="text-sm font-semibold text-fg">up to ~{formatBytes(estBytes)}</span>
        </div>

        {isExporting && (
          <div className="mb-4">
            <div className="w-full bg-surface-hover rounded-full h-3 overflow-hidden">
              <div
                className="bg-accent h-full transition-all duration-200"
                style={{ width: `${Math.round(progress * 100)}%` }}
              />
            </div>
            <p className="text-xs text-muted mt-1 text-center">
              {progress < 0.95
                ? `Encoding... ${Math.round(progress * 100)}%`
                : 'Finalizing...'}
            </p>
          </div>
        )}

        <div className="flex gap-3">
          <button
            onClick={isExporting ? cancelExport : onClose}
            className="flex-1 px-4 py-2 bg-surface-muted hover:bg-surface-hover text-fg rounded transition-colors cursor-pointer"
          >
            {isExporting ? 'Cancel export' : 'Close'}
          </button>
          <button
            onClick={() => startExport(project, settings)}
            disabled={isExporting || project.objects.length === 0}
            className="flex-1 px-4 py-2 bg-accent hover:bg-accent-hover disabled:opacity-50 text-accent-contrast font-medium rounded transition-colors cursor-pointer"
          >
            {isExporting ? 'Exporting...' : 'Export MP4'}
          </button>
        </div>
      </div>
    </div>
  )
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-surface-muted rounded px-3 py-2">
      <div className="text-[11px] uppercase tracking-wide text-subtle">{label}</div>
      <div className="text-sm text-fg mt-0.5">{value}</div>
    </div>
  )
}

function ChipButton({
  selected,
  onClick,
  disabled,
  children,
}: {
  selected: boolean
  onClick: () => void
  disabled?: boolean
  children: React.ReactNode
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`px-3 py-2 rounded text-sm font-medium transition-colors cursor-pointer disabled:cursor-not-allowed disabled:opacity-50 ${
        selected
          ? 'bg-accent-soft text-accent ring-2 ring-accent'
          : 'bg-surface-muted text-fg hover:bg-surface-hover ring-2 ring-transparent'
      }`}
    >
      {children}
    </button>
  )
}

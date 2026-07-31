import { useState, useRef, useEffect, useLayoutEffect } from 'react'
import { createPortal } from 'react-dom'
import { IconPlayerPlayFilled, IconPlayerPauseFilled, IconFlag, IconClockPlus, IconTrash } from '@tabler/icons-react'
import VolumeControl from './VolumeControl'

type TransportBarProps = {
  isPlaying: boolean
  onTogglePlayback: () => void
  globalTime: number
  totalDuration: number
  playbackSpeed: number
  onSetSpeed: (v: number) => void
  volume: number
  isMuted: boolean
  onVolume: (v: number) => void
  onToggleMute: () => void
  // Markers (spec 22): add at the playhead / clear all. markerCount gates the clear-all button.
  onAddMarker: () => void
  // Add a marker at an explicit typed time (clock popover).
  onAddMarkerAt: (time: number) => void
  onClearMarkers: () => void
  markerCount: number
}

/** m:ss.s clock — mirrors the timeline ruler's format. */
function formatClock(t: number): string {
  const clamped = Math.max(0, t)
  const m = Math.floor(clamped / 60)
  const s = clamped % 60
  return `${m}:${s.toFixed(1).padStart(4, '0')}`
}

/**
 * Parse a typed time into seconds. Accepts either plain seconds ("12.5") or an m:ss(.s) clock
 * ("1:05.0") mirroring the ruler/clock format. Returns null on anything unparseable.
 */
function parseTime(input: string): number | null {
  const str = input.trim()
  if (!str) return null
  if (str.includes(':')) {
    const parts = str.split(':')
    if (parts.length !== 2) return null
    const m = Number(parts[0])
    const s = Number(parts[1])
    if (!Number.isFinite(m) || !Number.isFinite(s)) return null
    return m * 60 + s
  }
  const n = Number(str)
  return Number.isFinite(n) ? n : null
}

/**
 * Popover for adding a marker at a typed time (rounds out the marker cluster's quick "flag at
 * playhead"). Pre-fills the current playhead clock; parses seconds or m:ss. Portalled + positioned
 * above the trigger (the transport pill floats near the bottom), with outside-click / Escape close.
 */
function AddMarkerAtPopover({
  globalTime,
  onAddMarkerAt,
}: {
  globalTime: number
  onAddMarkerAt: (time: number) => void
}) {
  const [open, setOpen] = useState(false)
  const [value, setValue] = useState('')
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  // On open, seed the field with the current playhead clock and focus/select it.
  useEffect(() => {
    if (!open) return
    setValue(formatClock(globalTime))
    const id = requestAnimationFrame(() => inputRef.current?.select())
    return () => cancelAnimationFrame(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  // Position the panel above the trigger (flip below when there's no room), clamped to the viewport.
  useLayoutEffect(() => {
    if (!open) { setPos(null); return }
    const t = triggerRef.current
    if (!t) return
    const reposition = () => {
      const tr = t.getBoundingClientRect()
      const pw = panelRef.current?.offsetWidth ?? 0
      const ph = panelRef.current?.offsetHeight ?? 0
      const GAP = 8, M = 8
      let left = tr.left + tr.width / 2 - pw / 2
      let top = tr.top - GAP - ph
      if (top < M) top = tr.bottom + GAP
      left = Math.max(M, Math.min(left, window.innerWidth - pw - M))
      top = Math.max(M, Math.min(top, window.innerHeight - ph - M))
      setPos({ left, top })
    }
    reposition()
    window.addEventListener('resize', reposition)
    return () => window.removeEventListener('resize', reposition)
  }, [open])

  // Close on outside click / Escape (stop Escape reaching App's window handler).
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node
      if (panelRef.current?.contains(target) || triggerRef.current?.contains(target)) return
      setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.stopPropagation(); setOpen(false) }
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const parsed = parseTime(value)
  const valid = parsed !== null && parsed >= 0

  const submit = () => {
    if (!valid) return
    onAddMarkerAt(parsed)
    setOpen(false)
  }

  return (
    <>
      <button
        ref={triggerRef}
        onClick={() => setOpen((o) => !o)}
        title="Add marker at a specific time…"
        aria-label="Add marker at a specific time"
        className={`flex items-center justify-center w-7 h-7 rounded-full cursor-pointer transition-colors ${
          open ? 'bg-surface-hover text-fg' : 'text-muted hover:text-fg hover:bg-surface-hover'
        }`}
      >
        <IconClockPlus size={15} stroke={2} />
      </button>
      {open &&
        createPortal(
          <div
            ref={panelRef}
            className="fixed z-80 rounded-lg border border-border bg-surface shadow-xl p-2.5"
            style={{
              left: pos?.left ?? -9999,
              top: pos?.top ?? -9999,
              visibility: pos ? 'visible' : 'hidden',
            }}
          >
            <div className="text-[11px] font-semibold text-subtle mb-1.5">Marker at time</div>
            <div className="flex items-center gap-1.5">
              <input
                ref={inputRef}
                type="text"
                value={value}
                onChange={(e) => setValue(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') { e.preventDefault(); submit() }
                }}
                placeholder="1:05.0 or 65"
                className="w-24 px-1.5 py-1 text-xs tabular-nums rounded border border-border bg-bg text-fg focus:outline-none focus:border-accent"
              />
              <button
                onClick={submit}
                disabled={!valid}
                className="px-2.5 py-1 text-xs font-medium rounded bg-accent text-accent-contrast hover:bg-accent-hover disabled:opacity-30 disabled:cursor-default cursor-pointer transition-colors"
              >
                Add
              </button>
            </div>
            <div className="text-[10px] text-subtle mt-1.5">Seconds, or m:ss</div>
          </div>,
          document.body,
        )}
    </>
  )
}

/**
 * Floating transport pill (spec 17 C): play/pause, the playhead clock, preview speed, and master
 * volume — lifted out of the top bar to float above the scrub bar. Preview speed + volume are
 * editor-only monitoring and never affect export. Space still toggles play (handled in App).
 */
export default function TransportBar({
  isPlaying, onTogglePlayback, globalTime, totalDuration,
  playbackSpeed, onSetSpeed, volume, isMuted, onVolume, onToggleMute,
  onAddMarker, onAddMarkerAt, onClearMarkers, markerCount,
}: TransportBarProps) {
  return (
    <div className="pointer-events-auto flex items-center gap-3 px-2.5 py-1.5 bg-surface/95 border border-border rounded-full shadow-lg backdrop-blur-sm">
      <button
        onClick={onTogglePlayback}
        title={isPlaying ? 'Pause (Space)' : 'Play (Space)'}
        className="flex items-center justify-center w-8 h-8 rounded-full bg-accent text-accent-contrast hover:bg-accent-hover cursor-pointer transition-colors shrink-0"
      >
        {isPlaying ? <IconPlayerPauseFilled size={16} /> : <IconPlayerPlayFilled size={16} />}
      </button>

      <span className="text-xs tabular-nums select-none whitespace-nowrap">
        <span className="text-fg">{formatClock(globalTime)}</span>
        <span className="text-subtle"> / {formatClock(totalDuration)}</span>
      </span>

      <span className="w-px h-5 bg-border shrink-0" />

      <div
        className="flex items-center gap-1.5"
        title="Preview speed — how fast Play runs in the editor. Does not affect export. Double-click to reset to 1×."
      >
        <span className="text-[10px] text-subtle select-none">Speed</span>
        <input
          type="range"
          min={0.25} max={2} step={0.25}
          value={playbackSpeed}
          onChange={(e) => onSetSpeed(Number(e.target.value))}
          onDoubleClick={() => onSetSpeed(1)}
          className="w-20 accent-accent cursor-pointer"
        />
        <span className="text-xs text-muted tabular-nums w-8 text-right">{playbackSpeed}×</span>
      </div>

      <span className="w-px h-5 bg-border shrink-0" />

      {/* Markers (spec 22): flag drops a marker at the playhead (also M); trash clears them all. */}
      <div className="flex items-center gap-0.5 shrink-0">
        <button
          onClick={onAddMarker}
          title="Add marker at playhead (M)"
          className="flex items-center justify-center w-7 h-7 rounded-full text-muted hover:text-fg hover:bg-surface-hover cursor-pointer transition-colors"
        >
          <IconFlag size={15} stroke={2} />
        </button>
        <AddMarkerAtPopover globalTime={globalTime} onAddMarkerAt={onAddMarkerAt} />
        {markerCount > 0 && (
          <button
            onClick={onClearMarkers}
            title={`Clear all markers (${markerCount})`}
            className="flex items-center justify-center w-7 h-7 rounded-full text-muted hover:text-danger hover:bg-danger-soft cursor-pointer transition-colors"
          >
            <IconTrash size={14} stroke={2} />
          </button>
        )}
      </div>

      <span className="w-px h-5 bg-border shrink-0" />

      <VolumeControl volume={volume} isMuted={isMuted} onVolume={onVolume} onToggleMute={onToggleMute} />
    </div>
  )
}

import { useEffect } from 'react'
import { IconX } from '@tabler/icons-react'

type HotkeysModalProps = {
  onClose: () => void
}

type Hotkey = { keys: string[]; label: string; desc: string }
type HotkeyGroup = { title: string; items: Hotkey[] }

// Keep this in sync with the keyboard handler in App.tsx (the `handleKeyDown` effect)
// and the inline shortcuts in Canvas.tsx / Timeline.tsx. Shortcuts are ignored while an
// input/textarea is focused.
const GROUPS: HotkeyGroup[] = [
  {
    title: 'Playback & navigation',
    items: [
      { keys: ['Space'], label: 'Play / pause', desc: 'Toggle playback of the timeline from the current playhead position.' },
      { keys: ['V'], label: 'Toggle camera view', desc: 'Switch between Frame view (author zooms un-zoomed) and Live view (see the real push-in). Editing is disabled in Live view.' },
    ],
  },
  {
    title: 'Markers',
    items: [
      { keys: ['M'], label: 'Add marker', desc: 'Drop a marker at the playhead. Works while playing, so you can tap to the beat.' },
      { keys: [','], label: 'Previous marker', desc: 'Jump the playhead back to the previous marker.' },
      { keys: ['.'], label: 'Next marker', desc: 'Jump the playhead forward to the next marker.' },
    ],
  },
  {
    title: 'Selected object / clip',
    items: [
      { keys: ['H'], label: 'Toggle hidden', desc: 'Hide or show the selected object or camera zoom without deleting it.' },
      { keys: ['S'], label: 'Split clip', desc: 'Slice the selected audio/video clip at the playhead. Only works when the playhead is inside the clip.' },
      { keys: ['Shift', 'Click'], label: 'Multi-select clips', desc: 'Shift-click timeline clips to add/remove them from a selection that can span lanes, then drag any one to move them all in time (and lanes) together. Delete removes the whole group.' },
      { keys: ['Delete'], label: 'Delete selection', desc: 'Remove the selected object(s), camera zoom, or effect. Deletes every clip in a multi-selection.', },
      { keys: ['Backspace'], label: 'Delete selection', desc: 'Same as Delete — removes the selected object(s), zoom, or effect.' },
    ],
  },
  {
    title: 'Drawing (arrows & freehand)',
    items: [
      { keys: ['Enter'], label: 'Finish arrow', desc: 'Complete the arrow being drawn (needs at least two points).' },
      { keys: ['Backspace'], label: 'Remove last point', desc: 'While drawing an arrow, delete the most recently placed point.' },
      { keys: ['Esc'], label: 'Finish / deselect', desc: 'Finish the current drawing, or if not drawing, clear the current selection.' },
    ],
  },
  {
    title: 'Editing',
    items: [
      { keys: ['Ctrl', 'Z'], label: 'Undo', desc: 'Step backward through the edit history (up to 50 steps).' },
      { keys: ['Ctrl', 'Y'], label: 'Redo', desc: 'Step forward through the edit history.' },
      { keys: ['Ctrl', 'Shift', 'Z'], label: 'Redo', desc: 'Alternate redo shortcut.' },
    ],
  },
  {
    title: 'Text editing',
    items: [
      { keys: ['Esc'], label: 'Commit text', desc: 'Finish editing a text object and apply the changes.' },
      { keys: ['Ctrl', 'Enter'], label: 'Commit text', desc: 'Also commits the text being edited.' },
    ],
  },
]

function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="inline-flex items-center justify-center min-w-[24px] h-6 px-1.5 rounded border border-border bg-bg text-fg text-xs font-medium font-mono shadow-sm">
      {children}
    </kbd>
  )
}

/** A reference sheet of every keyboard shortcut in the app. Opened from the header, closes on Escape or backdrop click. */
export default function HotkeysModal({ onClose }: HotkeysModalProps) {
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.stopPropagation(); onClose() }
    }
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [onClose])

  return (
    <div
      className="fixed inset-0 bg-black/70 flex items-center justify-center z-100"
      onClick={onClose}
    >
      <div
        className="bg-surface rounded-lg shadow-xl w-[640px] max-w-[90vw] max-h-[85vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-border">
          <div>
            <h2 className="text-base font-semibold text-fg">Keyboard shortcuts</h2>
            <p className="text-xs text-muted mt-0.5">Shortcuts are ignored while typing in a text field.</p>
          </div>
          <button
            onClick={onClose}
            className="flex items-center justify-center w-7 h-7 rounded text-muted hover:text-fg hover:bg-surface-hover cursor-pointer transition-colors"
            aria-label="Close"
          >
            <IconX size={18} stroke={2} />
          </button>
        </div>

        {/* Body */}
        <div className="overflow-y-auto p-4 flex flex-col gap-5">
          {GROUPS.map((group) => (
            <section key={group.title}>
              <h3 className="text-xs font-semibold uppercase tracking-wide text-muted mb-2">{group.title}</h3>
              <div className="flex flex-col divide-y divide-border/60">
                {group.items.map((hk, i) => (
                  <div key={i} className="flex items-start gap-3 py-2">
                    <div className="flex items-center gap-1 shrink-0 w-40 flex-wrap">
                      {hk.keys.map((k, j) => (
                        <span key={j} className="flex items-center gap-1">
                          {j > 0 && <span className="text-muted text-xs">+</span>}
                          <Kbd>{k}</Kbd>
                        </span>
                      ))}
                    </div>
                    <div className="min-w-0">
                      <div className="text-sm font-medium text-fg">{hk.label}</div>
                      <div className="text-xs text-muted mt-0.5">{hk.desc}</div>
                    </div>
                  </div>
                ))}
              </div>
            </section>
          ))}
        </div>
      </div>
    </div>
  )
}

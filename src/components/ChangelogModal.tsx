import { useEffect } from 'react'
import { IconX } from '@tabler/icons-react'
import { CHANGELOG } from '../changelog'

type ChangelogModalProps = {
  onClose: () => void
}

/** The "What's new" changelog. Content lives in `src/changelog.ts` (easy to hand-edit).
 *  Opened from the header, closes on Escape or backdrop click. */
export default function ChangelogModal({ onClose }: ChangelogModalProps) {
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
        className="bg-surface rounded-lg shadow-xl w-[560px] max-w-[90vw] max-h-[85vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-border">
          <h2 className="text-base font-semibold text-fg">What’s new</h2>
          <button
            onClick={onClose}
            className="flex items-center justify-center w-7 h-7 rounded text-muted hover:text-fg hover:bg-surface-hover cursor-pointer transition-colors"
            aria-label="Close"
          >
            <IconX size={18} stroke={2} />
          </button>
        </div>

        {/* Body */}
        <div className="overflow-y-auto p-5 flex flex-col gap-6">
          {CHANGELOG.map((entry) => (
            <section key={entry.version}>
              <div className="flex items-baseline gap-2 mb-2.5">
                <h3 className="text-sm font-semibold text-fg">{entry.version}</h3>
                {entry.date && <span className="ml-auto text-xs text-muted">{entry.date}</span>}
              </div>
              <ul className="flex flex-col gap-1.5">
                {entry.items.map((item, i) => (
                  <li key={i} className="flex gap-2.5 text-sm text-fg/90 leading-snug">
                    <span className="mt-[7px] h-1 w-1 shrink-0 rounded-full bg-accent" />
                    <span className="min-w-0">{item}</span>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      </div>
    </div>
  )
}

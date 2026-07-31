import { IconX, IconAlertTriangle, IconInfoCircle, IconCheck } from '@tabler/icons-react'
import { useToasts, dismissToast, type ToastKind } from '../hooks/useToasts'

// Top-centre, non-blocking toast stack (spec 31 B12-B16). The container is pointer-events-none so it
// never steals clicks; each toast re-enables pointer events only for itself (so its ✕ is clickable).
// Top-centre keeps it clear of the timeline, properties panel, and transport controls (B16).

const KIND_ICON: Record<ToastKind, React.ReactNode> = {
  info: <IconInfoCircle size={16} stroke={2} />,
  error: <IconAlertTriangle size={16} stroke={2} />,
  success: <IconCheck size={16} stroke={2} />,
}

export default function Toasts() {
  const toasts = useToasts()
  if (toasts.length === 0) return null
  return (
    <div className="fixed top-3 left-1/2 -translate-x-1/2 z-200 flex flex-col items-center gap-2 pointer-events-none">
      {toasts.map((t) => (
        <div
          key={t.id}
          role="status"
          className="pointer-events-auto flex items-start gap-2 max-w-md rounded-lg border border-border bg-surface px-3 py-2 shadow-lg text-sm text-fg"
        >
          <span className={t.kind === 'error' ? 'text-red-500' : 'text-subtle'}>{KIND_ICON[t.kind]}</span>
          <span className="min-w-0 break-words">{t.message}</span>
          <button
            onClick={() => dismissToast(t.id)}
            className="shrink-0 -mr-1 text-muted hover:text-fg cursor-pointer transition-colors"
            aria-label="Dismiss"
          >
            <IconX size={15} stroke={2} />
          </button>
        </div>
      ))}
    </div>
  )
}

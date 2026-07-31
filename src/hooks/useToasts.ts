import { useSyncExternalStore } from 'react'

// Minimal toast system (spec 31 B12-B17). A module-level store (precedent: mediaRegistry.ts) so any
// component can push a transient message without threading a callback through props. Rendered once by
// <Toasts/> in App. Deliberately tiny — { id, message, kind } — not a notification framework.

export type ToastKind = 'info' | 'error' | 'success'
export type Toast = { id: string; message: string; kind: ToastKind }

const MAX_VISIBLE = 4          // cap so a burst of drops can't grow unbounded (B13)
const AUTO_DISMISS_MS = 5000   // auto-dismiss after a few seconds (B13)

let toasts: Toast[] = []
const listeners = new Set<() => void>()
const timers = new Map<string, ReturnType<typeof setTimeout>>()

function emit() {
  for (const l of listeners) l()
}

function clearTimer(id: string) {
  const t = timers.get(id)
  if (t) {
    clearTimeout(t)
    timers.delete(id)
  }
}

export function dismissToast(id: string) {
  clearTimer(id)
  toasts = toasts.filter((t) => t.id !== id)
  emit()
}

export function pushToast(message: string, kind: ToastKind = 'info'): string {
  const id = crypto.randomUUID()
  let next = [...toasts, { id, message, kind }]
  // Drop the oldest beyond the cap (and cancel their timers) so stacking stays legible (B13).
  if (next.length > MAX_VISIBLE) {
    for (const o of next.slice(0, next.length - MAX_VISIBLE)) clearTimer(o.id)
    next = next.slice(-MAX_VISIBLE)
  }
  toasts = next
  timers.set(id, setTimeout(() => dismissToast(id), AUTO_DISMISS_MS))
  emit()
  return id
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb)
  return () => {
    listeners.delete(cb)
  }
}

function getSnapshot(): Toast[] {
  return toasts
}

/** Subscribe a component to the live toast list. */
export function useToasts(): Toast[] {
  return useSyncExternalStore(subscribe, getSnapshot)
}

// Remembers the last-chosen canvas size (aspect ratio / dimensions) so the next NEW/default project
// opens at that size instead of the hard-coded 1920×1080. This is a *preference*, persisted to
// localStorage independently of `config.persistProject`, undo/redo, and the `.gerty` export — exactly
// like `useUiPrefs`. When `persistProject: true` the loaded project carries its own dims; this pref
// only seeds the `createDefaultProject()` boot path. (Spec 18-qol R3.)

import { sanitizeDimension } from './aspectRatios'

export type CanvasSize = { width: number; height: number }

const STORAGE_KEY = 'canvas-size'

/** The remembered canvas size, sanitized, or null if never set / unavailable / corrupt. */
export function loadCanvasSize(): CanvasSize | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    const p = JSON.parse(raw) as Partial<CanvasSize>
    if (typeof p.width !== 'number' || typeof p.height !== 'number') return null
    if (!Number.isFinite(p.width) || !Number.isFinite(p.height)) return null
    return { width: sanitizeDimension(p.width), height: sanitizeDimension(p.height) }
  } catch {
    return null
  }
}

/** Remember a canvas size for the next new project. Degrades silently if storage is unavailable. */
export function saveCanvasSize(size: CanvasSize): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ width: size.width, height: size.height }))
  } catch {
    /* storage unavailable (private mode / quota) — pref simply not remembered this session */
  }
}

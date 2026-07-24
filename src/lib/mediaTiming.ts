// === Media timing: the single source of truth for trim + speed (spec 14) ===
//
// Every media path (preview seek, export decode, audio mixdown) maps an output
// time -> a source time and derives a playback rate. Before spec 14 each site
// inlined the same speed-stretch formula (`sourceTime = progress*originalDuration`,
// `rate = originalDuration/duration`) which assumed the source always starts at 0.
//
// Spec 14 separates TRIM (which sub-range of the source plays: [sourceIn, sourceOut])
// from SPEED (how fast it plays: rate = span/duration). These helpers centralize the
// mapping so all sites agree. The `?? ` fallbacks make untrimmed clips (and existing
// projects with no sourceIn/sourceOut) behave bit-identically to the old model.

import type { AudioData, VideoData } from '../types'

// Playback-speed bounds. Speed is set from the Properties panel slider (the timeline
// no longer has a speed-drag handle — edges trim only). The slider, the preview
// playbackRate clamp (clipRate), and export all read these, so they stay in lockstep.
export const RATE_MIN = 0.2
export const RATE_MAX = 2

type MediaData = AudioData | VideoData

/** Source-time (seconds into the asset) where the played span begins. Default 0. */
export function srcIn(d: MediaData): number {
  return d.sourceIn ?? 0
}

/** Source-time (seconds into the asset) where the played span ends. Default = full asset. */
export function srcOut(d: MediaData): number {
  return d.sourceOut ?? d.originalDuration
}

/** Length of the played source span, in source seconds: sourceOut - sourceIn. */
export function sourceSpan(d: MediaData): number {
  return srcOut(d) - srcIn(d)
}

/** Floor of the recoverable-source window: sourceIn can't be trimmed below this. Default 0 (asset
 *  start). A split collapses the window to the played span so the halves show no trim ghosts. */
export function srcMin(d: MediaData): number {
  return d.sourceMin ?? 0
}

/** Ceil of the recoverable-source window: sourceOut can't be trimmed past this. Default = full asset. */
export function srcMax(d: MediaData): number {
  return d.sourceMax ?? d.originalDuration
}

/** Effective audio gain for a clip: its own volume, or 0 when the clip is muted. Read by both
 *  preview (useAudioPlayback) and every export mixdown, so mute is honored consistently. */
export function effectiveVolume(d: MediaData): number {
  return d.muted ? 0 : d.volume
}

/**
 * Playback rate = span / duration, clamped to [0.25, 4].
 * When span == duration the clip is pure trim (rate 1, no speed change).
 */
export function clipRate(d: MediaData, duration: number): number {
  return Math.max(RATE_MIN, Math.min(RATE_MAX, sourceSpan(d) / duration))
}

/**
 * Source time for a given clip progress (0..1): sourceIn + progress*span.
 * This is where the media element / decoder should be positioned.
 */
export function sourceTimeAt(d: MediaData, clipProgress: number): number {
  return srcIn(d) + clipProgress * sourceSpan(d)
}

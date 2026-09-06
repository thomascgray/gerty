// === Auto-level: dynamic per-clip loudness balancing (spec 38) ===
//
// Evens out within-clip loudness variation (e.g. a clip that starts loud and drifts quiet) by
// applying a TIME-VARYING gain that boosts quiet stretches and tames loud ones toward a target
// level. Non-destructive: nothing rewrites the asset blob; the gain is resolved at playback/mix
// time and applied through a GainNode (preview graph + every export OfflineAudioContext).
//
// Design (the load-bearing bit): the source is analyzed ONCE into a fine, mode-independent RMS
// array (`data.loudness`, one value per ANALYSIS_WINDOW seconds). Each "mode" then derives its
// character at resolve time by SMOOTHING that same array with the preset's time-constant. So
// switching mode or dragging the Amount slider only recomputes gain — never re-decodes. All three
// mixdown paths and the preview hook call `resolvedGainAt`, so there is one source of truth.
//
// Everything works in SOURCE time (seconds into the asset), matching sourceTimeAt() in
// mediaTiming.ts, so auto-level rides trim + speed changes for free.

import type { AudioData, VideoData, AutoLevelMode } from '../types'
import { effectiveVolume } from './mediaTiming'

type MediaData = AudioData | VideoData

/** Seconds per stored RMS window. Fine + fixed + mode-independent (see module note). */
export const ANALYSIS_WINDOW = 0.05

export type AutoLevelPreset = {
  smoothing: number   // seconds; time-constant applied to the fine RMS before computing gain (reaction speed)
  targetRms: number   // level auto-level aims each window toward
  maxBoost: number    // cap on lift for quiet sections (avoids amplifying hiss into a roar)
  maxCut: number      // floor on attenuation for loud sections (keeps some natural dynamics)
  noiseFloor: number  // below this smoothed RMS -> treat as silence, gain 1 (no boost)
}

// Starting-point presets — expect to refine each by ear on real clips.
export const AUTO_LEVEL_PRESETS: Record<AutoLevelMode, AutoLevelPreset> = {
  smooth:     { smoothing: 0.8,  targetRms: 0.16, maxBoost: 3, maxCut: 0.35, noiseFloor: 0.02  },
  balanced:   { smoothing: 0.3,  targetRms: 0.18, maxBoost: 4, maxCut: 0.25, noiseFloor: 0.02  },
  aggressive: { smoothing: 0.12, targetRms: 0.20, maxBoost: 6, maxCut: 0.15, noiseFloor: 0.015 },
}

export const DEFAULT_AUTO_LEVEL_MODE: AutoLevelMode = 'balanced'
export const DEFAULT_AUTO_LEVEL_AMOUNT = 1

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v))
}

/**
 * Per-window RMS (0–1) across the whole channel, one value per ANALYSIS_WINDOW seconds. Run once
 * per source (lazily, when auto-level is first enabled); the result is cached on data.loudness.
 */
export function analyzeLoudness(channel: Float32Array, sampleRate: number): number[] {
  const windowSamples = Math.max(1, Math.round(ANALYSIS_WINDOW * sampleRate))
  const windows: number[] = []
  for (let start = 0; start < channel.length; start += windowSamples) {
    const end = Math.min(start + windowSamples, channel.length)
    let sumSq = 0
    for (let i = start; i < end; i++) {
      const s = channel[i]
      sumSq += s * s
    }
    const count = end - start
    windows.push(count > 0 ? Math.sqrt(sumSq / count) : 0)
  }
  return windows
}

/** Preset for a clip's chosen mode (falls back to the default when unset). */
function presetFor(data: MediaData): AutoLevelPreset {
  return AUTO_LEVEL_PRESETS[data.autoLevelMode ?? DEFAULT_AUTO_LEVEL_MODE]
}

/**
 * Smoothed RMS at a source time (seconds into the asset). Averages the fine `loudness` windows over
 * a +/- half-`smoothing` span centered on the sample, so a mode's reaction speed comes purely from
 * `smoothing` — no re-analysis needed to change modes. Returns 0 when no analysis is present.
 */
function smoothedRmsAt(loudness: number[], sourceTime: number, smoothing: number): number {
  if (loudness.length === 0) return 0
  const center = sourceTime / ANALYSIS_WINDOW
  const half = smoothing / 2 / ANALYSIS_WINDOW
  const lo = Math.max(0, Math.floor(center - half))
  const hi = Math.min(loudness.length - 1, Math.ceil(center + half))
  let sum = 0
  let n = 0
  for (let i = lo; i <= hi; i++) {
    sum += loudness[i]
    n++
  }
  return n > 0 ? sum / n : 0
}

/**
 * Multiplicative auto-level gain at a given SOURCE time. Reads data.autoLevelMode (preset) and
 * data.autoLevelAmount (blend toward 1). Noise-gated + clamped. Returns 1 when auto-level is off or
 * no analysis is present, so callers can multiply unconditionally.
 */
export function autoLevelGainAt(data: MediaData, sourceTime: number): number {
  if (!data.autoLevel || !data.loudness || data.loudness.length === 0) return 1
  const p = presetFor(data)
  const rms = smoothedRmsAt(data.loudness, sourceTime, p.smoothing)
  // Below the noise floor is silence/room-tone: leave it alone (don't amplify).
  const rawGain = rms < p.noiseFloor
    ? 1
    : clamp(p.targetRms / rms, p.maxCut, p.maxBoost)
  const amount = clamp(data.autoLevelAmount ?? DEFAULT_AUTO_LEVEL_AMOUNT, 0, 1)
  // Blend between raw (1) and fully-leveled (rawGain).
  return 1 + (rawGain - 1) * amount
}

/**
 * Full resolved clip gain at a source time: the clip's own volume (0 when muted) times the
 * auto-level gain. The single source of truth for preview + all export mixdown paths.
 */
export function resolvedGainAt(data: MediaData, sourceTime: number): number {
  return effectiveVolume(data) * autoLevelGainAt(data, sourceTime)
}

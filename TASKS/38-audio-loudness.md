# 38 - Audio loudness: auto-level + 200% volume

**Status**: In Progress

## Overview

Two related per-clip audio features (see [SPECS/38-audio-loudness.md](../SPECS/38-audio-loudness.md)):

1. **Auto-level (dynamic loudness balancing)** - a non-destructive toggle that analyzes a clip once
   and applies a *time-varying* gain envelope so perceived loudness stays even across the clip (fixes
   loud-start/quiet-end). Three switchable **modes** (Smooth / Balanced / Aggressive) + an **Amount**
   slider (0-100%), all re-levelling instantly with no re-analysis. Applied identically in preview and
   export.
2. **200% volume cap** - per-clip Volume slider goes 0-200% (was 0-100).

## Task Context

- **Model (`src/types.ts`)**: add to BOTH `AudioData` and `VideoData` (shared "MediaData" shape):
  `autoLevel?: boolean`, `autoLevelMode?: AutoLevelMode`, `autoLevelAmount?: number`, `loudness?: number[]`.
  Add `export type AutoLevelMode = 'smooth' | 'balanced' | 'aggressive'`. `volume` semantics now 0-2.
- **New pure module `src/lib/loudness.ts`** (mirrors `mediaTiming.ts`/`camera.ts`, no React):
  `ANALYSIS_WINDOW=0.05`, `AUTO_LEVEL_PRESETS`, `DEFAULT_AUTO_LEVEL_MODE`, `analyzeLoudness(channel,
  sampleRate)`, `autoLevelGainAt(data, sourceTime)`, `resolvedGainAt(data, sourceTime)`.
- **Key architecture**: analysis is done ONCE at a fine fixed resolution (0.05s windows) and stored on
  `data.loudness`. Modes are derived at playback time by smoothing that array with the preset's
  `smoothing` time-constant, so switching mode / dragging Amount never re-decodes. All gain resolution
  lives in `resolvedGainAt` so preview + all 3 export paths call one function (no drift).
- **Work in SOURCE time**: every path already maps output->source via `sourceTimeAt(data, clipProgress)`
  ([src/lib/mediaTiming.ts:67](../src/lib/mediaTiming.ts#L67)), so auto-level rides trim/speed for free.
- **Preview (`src/hooks/useAudioPlayback.ts`)**: `HTMLMediaElement.volume` is browser-clamped to [0,1],
  so both >100% and the envelope require a Web Audio graph: `element -> MediaElementSource -> clipGain
  -> masterGain -> ctx.destination`. `clipGain` = volume*autoLevel(t); `masterGain` = master volume/mute.
  Gotchas: `createMediaElementSource` once per element (throws if repeated; recreate on asset churn);
  leave `el.volume=1`/`el.muted=false` in graph mode; resume AudioContext on play gesture.
- **Export (`src/lib/ffmpegExport.ts`)**: 3 `OfflineAudioContext` mixdown loops at ~178, ~448, ~726 do
  `gain.gain.value = effectiveVolume(data)`. Replace each with a shared `scheduleClipGain(gain, data,
  obj)` helper that schedules the envelope (via `linearRampToValueAtTime`) when `autoLevel`, else
  constant. OfflineAudioContext already accepts gain>1, so 200% "just works" in export today. Keep
  `exportWorker.ts` / MediaRecorder paths in sync (same helper).
- **UI (`src/components/PropertiesPanel.tsx`)**: Volume slider max 100->200
  ([~492](../src/components/PropertiesPanel.tsx#L492)). Add Auto level checkbox + (when on) Mode
  segmented control + Amount slider in the Audio accordion (~471-502). Lazy analysis on first enable
  with "Analyzing..." affordance. `update({ data: { ...md, ... } })` passes whole `data` (reducer
  shallow-merges).
- **Analysis decode**: mirror `assetStore.ts` `generateWaveform`/`decodeAudio` (decodeAudioData ->
  getChannelData(0)).
- **Constraints/conventions**: verify with `npx tsc -b` only; do NOT run dev server / browser (user
  tests). No em-dash in copy. Per-pixel effects rule N/A here (audio).
- **Preset defaults (tune by ear later)**:
  | Mode | smoothing | targetRms | maxBoost | maxCut | noiseFloor |
  |---|---|---|---|---|---|
  | smooth | 0.8 | 0.16 | 3 | 0.35 | 0.02 |
  | balanced | 0.3 | 0.18 | 4 | 0.25 | 0.02 |
  | aggressive | 0.12 | 0.20 | 6 | 0.15 | 0.015 |

## Blockers/Issues

None currently.

## TODO

[X] Types: add `AutoLevelMode` + 4 fields to `AudioData`/`VideoData`; update `volume` comments to 0-2
[X] New `src/lib/loudness.ts`: constants, presets, `analyzeLoudness`, `autoLevelGainAt`, `resolvedGainAt`
[X] Export: add shared `scheduleClipGain` helper; wire into all 3 mixdown loops in `ffmpegExport.ts`
    [X] `exportWorker.ts` uses the pre-rendered main-thread mix (no separate mixdown) - covered
[X] UI: Volume slider cap 100->200 in `PropertiesPanel.tsx`
[X] UI: Auto level checkbox + Mode selector + Amount slider; lazy analysis wiring + "Analyzing..." state
    (extracted into new `AudioControls` subcomponent to hold `analyzing` state cleanly)
[X] Analysis decode helper `analyzeAssetLoudness` in `assetStore.ts`
[X] Preview: restructure `useAudioPlayback.ts` to a Web Audio graph (MediaElementSource -> clipGain ->
    masterGain -> destination); time-varying gain via `resolvedGainAt`; master volume/mute on masterGain
[X] Verify `npx tsc -b` green
[ ] User browser test (see checklist handed over) + tune preset values by ear if needed

## Work Log

[2026-08-04] Task created from spec 38. Investigation captured in Task Context above.

[2026-08-04] Implemented spec 38 end-to-end. `npx tsc -b` green.

- `src/types.ts`: added `AutoLevelMode` union; added `autoLevel?`/`autoLevelMode?`/`autoLevelAmount?`/`loudness?` to `AudioData` + `VideoData`; `volume` now 0-2.
- `src/lib/loudness.ts` (new): `ANALYSIS_WINDOW`, `AUTO_LEVEL_PRESETS` (smooth/balanced/aggressive), defaults, `analyzeLoudness`, `autoLevelGainAt` (mode smoothing + noise gate + clamp + amount blend), `resolvedGainAt` (= effectiveVolume * autoLevel). Works in source time.
- `src/lib/assetStore.ts`: `analyzeAssetLoudness(assetId)` - decodes the asset once, returns the fine RMS array (or null).
- `src/lib/ffmpegExport.ts`: `scheduleClipGain` helper; replaced the constant-gain line in all 3 OfflineAudioContext mixdown loops (WebCodecs prerender, main-thread, MediaRecorder). Gain > 1 already supported by OfflineAudioContext, so 200% works in export.
- `src/components/PropertiesPanel.tsx`: extracted Audio accordion into new `AudioControls` component; Volume slider now 0-200%; added Auto level checkbox, Mode segmented control, Amount slider; lazy analysis on first enable with "Analyzing..." state.
- `src/hooks/useAudioPlayback.ts`: restructured onto a shared Web Audio graph (element -> MediaElementSource -> per-clip gainNode -> masterGain -> destination). Per-clip gain follows `resolvedGainAt` (smoothed via setTargetAtTime) so >100% + auto-level envelope work in preview; master gain carries preview volume/mute; context resumed on play; nodes disconnected on churn/unmount.
- Persistence: new fields ride the whole-project JSON in `projectStorage.ts` automatically (no whitelist).

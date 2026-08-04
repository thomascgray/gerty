# 38 - Audio loudness: auto-level + 200% volume

## Overview

Two related audio improvements for clips whose recording level is uneven or too quiet:

1. **Auto-level (dynamic loudness balancing)** - a per-clip, non-destructive toggle that analyzes the
   clip and applies a *time-varying* gain envelope so perceived loudness stays even across the whole
   clip. This directly fixes the reported problem: clips that start loud and drift quiet (or vice
   versa). The quiet stretches are boosted, the loud stretches tamed, toward a fixed target level.
   Applied identically in preview and export.

2. **200% volume cap** - the per-clip Volume slider in the Properties panel currently maxes at 100%.
   Raise it to 200% so a source recorded too quietly can be amplified beyond unity.

Both are non-destructive "runtime" effects resolved at playback/mix time (consistent with the app's
whole-project, resolver-driven architecture). Neither rewrites the stored asset blob.

### Decisions locked (spec session)

- **Loudness method: Auto-level (dynamic envelope)**, not a single constant normalize gain. It must
  even out *within-clip* variation, which a constant gain cannot do. (Auto-level normalizes to a fixed
  target, so it *also* raises an overall-quiet clip as a side effect.)
- **Multiple modes, switchable live.** Rather than one fixed character, auto-level offers a few
  **modes** (Smooth / Balanced / Aggressive) plus an **Amount** slider (0-100%). The user picks a mode,
  listens, and can switch modes / drag Amount and hear the difference **instantly** - no re-analysis
  (see R3: analysis is done once at a fine resolution; modes are derived from it at playback time).
- **RMS (not LUFS) for v1**, **lazy analysis on first toggle**, **master preview stays 100%** (resolved
  open questions - see below).
- **Preview fidelity: migrate preview audio to a Web Audio graph.** `HTMLMediaElement.volume` is
  clamped to `[0,1]` by the browser and cannot apply a smooth time-varying envelope, so both the >100%
  cap and the auto-level envelope require routing each preview element through
  `AudioContext -> MediaElementSource -> GainNode -> destination`. Preview then matches export exactly.
- **Volume cap scope: per-clip only.** The master preview `VolumeControl` (transport) stays 0-100%
  (it is monitoring-only and never affects export). Not in scope for this spec.

## Requirements

### R1 - Per-clip volume to 200%
- The Properties panel Volume slider ([PropertiesPanel.tsx:488-502](src/components/PropertiesPanel.tsx#L488-L502))
  ranges `0-200%` (`min=0 max=200`) instead of `0-100`. The stored value is still `data.volume` as a
  raw multiplier, now `0-2` (e.g. `1.5` = 150%).
- The `%` readout reflects the new range.
- Applies to both `audio` and `video` clips (shared control).

### R2 - Auto-level toggle + mode + amount (per clip)
- A new **Auto level** checkbox in the Audio accordion (same section as Mute / Volume).
- When enabled, the clip's audio is dynamically leveled toward a target loudness in **both preview and
  export**.
- **Mode** selector (default `balanced`), shown only when auto-level is on. Three modes vary the
  *character* of the leveling (see R4 table):
  - **Smooth** - slow, gentle drift correction. Best fit for the reported case (start loud, end quiet
    over the whole clip). Follows only the slow envelope, ignores syllable-level bumps, keeps it natural.
  - **Balanced** - medium reaction, moderate boost. General default.
  - **Aggressive** - fast reaction, high boost, near-flat leveling. For very uneven / very quiet sources.
- **Amount** slider `0-100%` (default 100%), shown only when auto-level is on. Blends between raw and
  fully-leveled gain: `gain = lerp(1, autoLevelGain, amount)`. Lets the user dial back a "too
  compressed / lifeless" result while keeping the drift fix.
- **Switching mode or dragging Amount re-levels instantly** - no re-analysis, no re-decode (R3). This is
  the "apply, listen, try another" loop the user asked for.
- Auto-level composes *underneath* the manual Volume slider:
  `finalGain(t) = volume * autoLevelGain(t)` (and `0` when muted). So a user can auto-level and still
  push the whole thing to 150%.
- Toggling on the *first* time triggers a one-time analysis of the source audio (see R3). While analysis
  runs, show a lightweight "Analyzing..." state on the control; the toggle/mode/amount reflect the
  persisted values once done.
- The flag, mode, amount, and cached analysis all persist via the normal whole-project JSON / `.gerty`
  export.

### R3 - Loudness analysis (once, at a fixed fine resolution)
- Analysis decodes the source audio once (reuse the `assetStore` decode pattern) and produces a
  **per-window RMS loudness array** sampled across the *entire source* in **source time** (so it stays
  correct under trim and speed changes - the same output->source mapping used everywhere else).
- **Resolution is fixed and fine** (`ANALYSIS_WINDOW`, ~0.05s), independent of the chosen mode. A 60s
  clip -> ~1200 values (still small; comparable order to the existing 200-value `waveform`). Storing at
  a fine resolution is the key that makes mode-switching free: each mode derives its coarser character
  by **smoothing this same array at playback time** (R4), so changing mode never re-decodes.
- Analysis is **lazy**: run when Auto level is first switched on for a clip (not eagerly at import for
  every clip). Cache the result (`data.loudness`) on the clip so re-toggling / mode-switching is instant
  and it survives save.
- For `video` clips, analysis decodes the video file's audio track (same `decodeAudioData` path already
  used for the video waveform / export mixdown).

### R4 - Auto-level gain curve + modes
- Each **mode** is a preset of `{ smoothing, targetRms, maxBoost, maxCut, noiseFloor }`. The stored
  `loudness[]` (fine, from R3) is smoothed by the mode's `smoothing` time constant (moving average /
  one-pole) before computing gain, so `smoothing` sets the reaction speed **without** re-analysis.
- Smoothed RMS at a source time -> raw gain:
  `rawGain = clamp(targetRms / max(smoothedRms, noiseFloor), maxCut, maxBoost)`.
- **Noise gate**: where `smoothedRms < noiseFloor`, gain is `1` (ramped, not a hard step), so silent
  gaps / room tone are NOT amplified.
- **Amount blend** (R2): `autoLevelGain = lerp(1, rawGain, amount)`.
- Default mode presets (starting points, tune by ear):

  | Mode | smoothing | targetRms | maxBoost | maxCut | noiseFloor | Character |
  |---|---|---|---|---|---|---|
  | `smooth` | ~0.8s | 0.16 | 3x | 0.35x | 0.02 | slow drift fix, natural, keeps dynamics |
  | `balanced` | ~0.3s | 0.18 | 4x | 0.25x | 0.02 | general default |
  | `aggressive` | ~0.12s | 0.20 | 6x | 0.15x | 0.015 | fast, near-flat, for very uneven/quiet |

- The final envelope is applied smoothly (linear ramps / `setTargetAtTime`) so gain changes are not
  audibly steppy.

### R5 - Apply in preview (Web Audio graph)
- Restructure `useAudioPlayback` so each live media element is routed
  `element -> MediaElementSource -> clipGain -> masterGain -> ctx.destination`, using a single shared
  `AudioContext`.
- `clipGain` carries `volume * autoLevelGain(t)` (time-varying when auto-level is on; constant
  otherwise). `masterGain` carries the master preview volume + master mute.
- The graph must support gain **> 1** (the whole point of R1 in preview).
- The `AudioContext` is resumed on a user play gesture (autoplay policy).

### R6 - Apply in export (all mixdown paths)
- The three `OfflineAudioContext` mixdown sites in [ffmpegExport.ts](src/lib/ffmpegExport.ts)
  (lines ~178, ~448, ~726) currently do `gain.gain.value = effectiveVolume(data)`. They must instead
  schedule the **auto-level envelope** on the `GainNode` when auto-level is on (constant
  `effectiveVolume` when off), so export matches preview.
- Centralize this into one shared helper so all three sites (and the preview graph) stay in lockstep.

### R7 - Backward compatibility
- Clips with no `autoLevel` / no `loudness` behave exactly as today (bit-identical mix): auto-level
  off, constant gain = `effectiveVolume(data)`.
- Existing projects load unchanged. `volume` values already stored (all `<= 1`) are unaffected by the
  cap change.

## Technical Considerations

### Types (`src/types.ts`)

Add two optional fields to **both** `AudioData` and `VideoData` (the shared "MediaData" shape used by
`mediaTiming.ts`). Optional + absent-default keeps old projects bit-identical (R7).

```ts
export type AutoLevelMode = 'smooth' | 'balanced' | 'aggressive'   // spec 38

export type AudioData = {
  // ...existing...
  volume: number             // now 0-2 (was documented 0-1); raw multiplier, 1 = unity
  autoLevel?: boolean        // spec 38: apply the dynamic auto-level gain envelope (preview + export)
  autoLevelMode?: AutoLevelMode  // spec 38: character preset; default 'balanced'
  autoLevelAmount?: number   // spec 38: 0-1 blend between raw and fully-leveled; default 1
  loudness?: number[]        // spec 38: per-window RMS of the SOURCE (source-time), sampled every ANALYSIS_WINDOW s
}

export type VideoData = {
  // ...existing...
  volume: number             // now 0-2
  autoLevel?: boolean        // spec 38
  autoLevelMode?: AutoLevelMode  // spec 38
  autoLevelAmount?: number   // spec 38
  loudness?: number[]        // spec 38: per-window RMS of the video's audio track
}
```

Update the `// 0-1` comments on `volume` to `// 0-2`. `autoLevelMode`/`autoLevelAmount` are only
meaningful when `autoLevel` is true; both default via `?? 'balanced'` / `?? 1` so old projects and
freshly-toggled clips behave consistently.

### New module: `src/lib/loudness.ts`

Mirrors the small pure-resolver shape used elsewhere (`mediaTiming.ts`, `camera.ts`). No React, shared
by the preview hook and all export paths.

```ts
export const ANALYSIS_WINDOW = 0.05     // seconds per stored RMS window (fine; fixed, mode-independent)

export type AutoLevelPreset = {
  smoothing: number   // seconds; time-constant applied to the fine RMS before computing gain (reaction speed)
  targetRms: number
  maxBoost: number
  maxCut: number
  noiseFloor: number
}

export const AUTO_LEVEL_PRESETS: Record<AutoLevelMode, AutoLevelPreset> = {
  smooth:     { smoothing: 0.8,  targetRms: 0.16, maxBoost: 3, maxCut: 0.35, noiseFloor: 0.02  },
  balanced:   { smoothing: 0.3,  targetRms: 0.18, maxBoost: 4, maxCut: 0.25, noiseFloor: 0.02  },
  aggressive: { smoothing: 0.12, targetRms: 0.20, maxBoost: 6, maxCut: 0.15, noiseFloor: 0.015 },
}
export const DEFAULT_AUTO_LEVEL_MODE: AutoLevelMode = 'balanced'

// Per-window RMS (0-1) across the whole channel, one value per ANALYSIS_WINDOW seconds. One-time.
export function analyzeLoudness(channel: Float32Array, sampleRate: number): number[]

// Multiplicative auto-level gain at a given SOURCE time (seconds into the asset). Reads
// data.loudness + data.autoLevelMode (preset -> smoothing/target/boost/cut/gate) + data.autoLevelAmount
// (lerp toward 1). Returns 1 if no analysis present. Noise-gated + clamped per R4. Pure -> instant on
// mode/amount change (no re-analysis).
export function autoLevelGainAt(data: MediaData, sourceTime: number): number

// Full resolved clip gain at a source time: effectiveVolume(data) * (autoLevel ? autoLevelGainAt : 1).
export function resolvedGainAt(data: MediaData, sourceTime: number): number
```

- Working in **source time** is deliberate: `useAudioPlayback` and every export path already map output
  time -> source time via `sourceTimeAt(data, clipProgress)` ([mediaTiming.ts:67](src/lib/mediaTiming.ts#L67)).
  So auto-level rides trim/speed for free - no separate handling.
- **Modes are runtime-derived from the one fine analysis** (smoothing the stored `loudness[]` by the
  preset's `smoothing`), so switching mode or amount only recomputes gain - the load-bearing choice
  behind the "apply, listen, try another" loop. Consider memoizing the smoothed-per-mode array so a
  scrub/playback doesn't re-smooth every frame.

### Preview graph restructure (`src/hooks/useAudioPlayback.ts`)

The largest change. Current code sets `el.volume` / `el.muted` directly
([useAudioPlayback.ts:50-59, 80, 101](src/hooks/useAudioPlayback.ts#L50-L59)). New shape:

- One module/ref `AudioContext` (lazy-created, resumed on play).
- Per `MediaEntry`: a `MediaElementAudioSourceNode` (created **once** per element) + a `clipGain` node.
  A shared `masterGain` -> `ctx.destination`.
- `el.volume = 1`, `el.muted = false` always in graph mode (all gain lives in nodes).
- Master volume/mute -> `masterGain.gain`. Clip volume/auto-level -> `clipGain.gain`.
- Time-varying gain: on the existing per-frame time sync, set `clipGain.gain` toward
  `resolvedGainAt(data, sourceTime)` (use `setTargetAtTime` / short `linearRampToValueAtTime` for
  smoothing rather than a hard `.value =` every frame).

**Gotchas:**
- `createMediaElementSource(el)` can be called **only once** per element and throws if repeated - track
  it on the entry and recreate only when the element is recreated (asset change / churn at
  [useAudioPlayback.ts:91-122](src/hooks/useAudioPlayback.ts#L91-L122)).
- Once an element is routed through a `MediaElementSource`, its native output goes only through the
  graph; `el.muted`/`el.volume` act as pre-gain and should be left neutral.
- `AudioContext` starts suspended under autoplay policy - resume it in the play path (user gesture).
- Blob-URL assets are same-origin, so no cross-origin tainting of the source node.

### Export mixdown (`src/lib/ffmpegExport.ts`)

Three near-identical loops build an `OfflineAudioContext` and set a constant gain
([~178](src/lib/ffmpegExport.ts#L178), ~448, ~726). Replace the `gain.gain.value = effectiveVolume(data)`
line at each with a shared helper that, when `data.autoLevel`, schedules the envelope:

```ts
// pseudo: schedule per-window gain along the OUTPUT timeline
function scheduleClipGain(gain: GainNode, data: MediaData, obj: TimelineObject) {
  if (!data.autoLevel || !data.loudness) { gain.gain.value = effectiveVolume(data); return }
  const rate = clipRate(data, obj.duration)
  for (let out = 0; out <= obj.duration; out += LOUDNESS_WINDOW / rate) {
    const src = sourceTimeAt(data, out / obj.duration)
    const t = obj.startTime + out
    gain.gain.linearRampToValueAtTime(resolvedGainAt(data, src), t)
  }
}
```

- OfflineAudioContext gain accepts values > 1 already, so R1's 200% "just works" in export today; only
  the preview path was blocked.
- Keep the `exportWorker.ts` / MediaRecorder mixdown paths in sync (same helper).

### UI (`src/components/PropertiesPanel.tsx`)

- R1: change the Volume slider `max={100}` -> `max={200}`
  ([PropertiesPanel.tsx:492](src/components/PropertiesPanel.tsx#L492)); value/readout math unchanged
  (`* 100` / `/ 100`).
- R2: add an **Auto level** `Field` + checkbox next to Mute/Volume. On enable, if `md.loudness` is
  absent, run the analysis (async) then write `{ ...md, autoLevel: true, loudness, autoLevelMode:
  md.autoLevelMode ?? 'balanced', autoLevelAmount: md.autoLevelAmount ?? 1 }`; if already analyzed just
  set `autoLevel: true`. On disable just flip `autoLevel` false (keep cached `loudness`/mode/amount).
  Show an "Analyzing..." affordance while decoding.
- When `autoLevel` is on, reveal two more controls (hidden otherwise):
  - **Mode** - a small segmented control / 3 buttons (Smooth | Balanced | Aggressive) writing
    `autoLevelMode`. Changing it is instant (no re-analysis).
  - **Amount** - a `0-100%` slider writing `autoLevelAmount` (`value/100`), same visual style as Volume.
- `update({ data: { ...md, ... } })` must pass the whole `data` object (reducer shallow-merges - see
  CLAUDE.md `UPDATE_OBJECT`). Note: mode/amount changes are ordinary `UPDATE_OBJECT`s (one undo each);
  if dragging Amount feels too undo-noisy, use the transient/commit pattern like other sliders.

## Related Systems and Tasks

- **Spec 14 / `mediaTiming.ts`** - trim + speed mapping; `sourceTimeAt`/`clipRate`/`effectiveVolume`
  are reused directly. Auto-level operating in source time inherits trim/speed correctness.
- **Spec 15 (audio polish)** and **Spec 11 (audio pitch on rate change)** - open/partial audio work;
  this spec is adjacent but independent.
- **Spec 34 (straight audio / mic recording)** and **Spec 32/33 (TTS)** - producers of audio clips
  that will benefit from auto-level.
- `assetStore.ts` `generateWaveform` / `decodeAudio` - the existing decode+peak pattern to mirror for
  `analyzeLoudness`.
- CLAUDE.md "Playback, audio, media" and "Export" sections.

## Open Questions

All resolved for v1:

1. **Mode presets + constant tuning** (was: single fixed constants) - **Resolved: ship three modes**
   (Smooth / Balanced / Aggressive) the user can switch between live, plus an Amount slider (R2/R4).
   The preset values in the R4 table are starting points; expect to refine each mode by ear on real
   clips. (Tuning deferred to implementation/testing; user tests in browser.)
2. **Strength/amount control** - **Resolved: include it now.** `autoLevelAmount` (0-100%), lerp toward
   raw gain (R2/R4).
3. **RMS vs perceptual (LUFS/K-weighting)** - **Resolved: RMS for v1.** Upgrade to K-weighting only if
   a bass-heavy clip mislevels in practice.
4. **Analysis timing UX** - **Resolved: lazy on first toggle** (short "Analyzing..." the first time per
   clip; cached after). Not eager-at-import.
5. **Master preview >100%** - **Resolved: out of scope**, master slider stays 0-100%. The Web Audio
   graph makes it a trivial follow-up if ever wanted.

## Acceptance Criteria

- [ ] Per-clip Volume slider goes to 200%; a value of e.g. 150% audibly amplifies in **both** preview
      and export.
- [ ] Enabling **Auto level** on a clip that starts loud and ends quiet produces roughly even
      perceived loudness across the clip, in preview and in the exported MP4 (they match).
- [ ] Auto-level does not amplify silent gaps / room tone into audible noise (noise gate works).
- [ ] Auto-level composes with the Volume slider (e.g. auto-level + 150% both apply).
- [ ] Switching Mode (Smooth/Balanced/Aggressive) and dragging Amount re-level the clip **instantly**
      (no re-analysis / no "Analyzing..." after the first time) and are audibly different.
- [ ] Amount 0% == auto-level off (gain back to raw); Amount 100% == full leveling.
- [ ] Muting a clip still silences it with auto-level on.
- [ ] Clips without auto-level are bit-identical to pre-spec-38 output; existing projects load and play
      unchanged.
- [ ] `autoLevel` + `autoLevelMode` + `autoLevelAmount` + `loudness` survive save / `.gerty` round-trip.
- [ ] `npx tsc -b` stays green.

## Implementation Notes

- Suggested order: (1) types + `loudness.ts` pure helpers (analyze + presets + `resolvedGainAt`);
  (2) export mixdown helper (easiest to verify, gain > 1 already supported); (3) UI (slider cap +
  Auto level toggle + Mode selector + Amount slider + analysis wiring); (4) preview Web Audio graph
  restructure (highest risk - do last, behind the now-tested resolver).
- Centralize the gain resolution in `loudness.ts` (`resolvedGainAt`) so preview, `ffmpegExport.ts`,
  `exportWorker.ts`, and the MediaRecorder path all call the same function - no per-site drift.
- Preview graph is the risky change: verify play/pause/seek, master volume, mute, per-clip volume,
  asset swap (element churn -> new MediaElementSource), and multiple simultaneous clips all still work.
- Follow the verify skill: after changes, run `npx tsc -b` and hand the user a "click X, listen for Y"
  browser checklist (loud->quiet clip with auto-level on/off; cycle Smooth/Balanced/Aggressive and drag
  Amount while playing; a very quiet clip at 200%; mute; export and compare to preview).

---
*This specification is ready for implementation. Use `/task 38` to begin development.*

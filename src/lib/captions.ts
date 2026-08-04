// Auto-captions main-thread client (spec 35). Owns a singleton worker (captions.worker.ts) and
// exposes a promise-based `generateCaptions`. This file imports NOTHING from the ASR engine —
// transformers.js + onnxruntime-web live entirely in the worker chunk, so importing this stays cheap.

import type { Project, AudioData, VideoData, CaptionCue, CaptionTrack } from '../types'
import { getAssetBlob } from './assetStore'
import { srcIn, sourceSpan, clipRate, effectiveVolume } from './mediaTiming'

// Whisper consumes 16 kHz mono. Rendering the mix at exactly that rate means the returned segment
// timestamps map straight to global timeline seconds (whole-timeline scope).
const ASR_SAMPLE_RATE = 16000

export type CaptionProgress =
  | { phase: 'mixing' }                                   // building the 16kHz mono audio mix
  | { phase: 'download'; file?: string; progress?: number } // first-ever model download
  | { phase: 'prepare' }                                  // model files fetched; compiling sessions
  | { phase: 'transcribe'; done?: number; total?: number } // inference running (window done/total)

type AsrChunk = { timestamp: [number, number | null]; text: string }

type WorkerOut =
  | ({ type: 'progress'; id: number } & CaptionProgress)
  | { type: 'result'; id: number; chunks: AsrChunk[] }
  | { type: 'error'; id: number; message: string }

// ---------------------------------------------------------------------------
// audio mix — sum every non-hidden audio/video source into one 16kHz mono buffer, honoring each
// clip's start/trim/rate/volume (mirrors ffmpegExport.prerenderAudioMix, but mono @ 16kHz).
// ---------------------------------------------------------------------------

export function timelineDuration(project: Project): number {
  return project.objects.reduce((max, o) => Math.max(max, o.startTime + o.duration), 0)
}

// A clip is transcribable when it's an audio/video source that's not hidden and not explicitly
// excluded from captions (spec 35 — so music/singing clips can be left out of the transcript).
function isCaptionSource(o: Project['objects'][number]): boolean {
  return (o.type === 'audio' || o.type === 'video') && !o.hidden && !o.excludeFromCaptions
}

export function hasTranscribableAudio(project: Project): boolean {
  return project.objects.some(isCaptionSource)
}

async function mixTimelineMono16k(project: Project): Promise<Float32Array | null> {
  const sources = project.objects.filter(isCaptionSource)
  if (sources.length === 0) return null
  const totalDuration = timelineDuration(project)
  if (totalDuration <= 0) return null

  const offlineCtx = new OfflineAudioContext(
    1,
    Math.ceil(totalDuration * ASR_SAMPLE_RATE),
    ASR_SAMPLE_RATE,
  )

  for (const obj of sources) {
    const data = obj.data as AudioData | VideoData
    const blob = getAssetBlob(data.assetId)
    if (!blob) continue
    try {
      const arrayBuffer = await blob.arrayBuffer()
      const decoded = await offlineCtx.decodeAudioData(arrayBuffer)
      const source = offlineCtx.createBufferSource()
      source.buffer = decoded
      source.playbackRate.value = clipRate(data, obj.duration)
      const gain = offlineCtx.createGain()
      gain.gain.value = effectiveVolume(data)
      source.connect(gain)
      gain.connect(offlineCtx.destination)
      source.start(obj.startTime, srcIn(data), sourceSpan(data))
    } catch {
      continue
    }
  }

  const rendered = await offlineCtx.startRendering()
  // Copy into a buffer we own so it can be transferred to the worker.
  return new Float32Array(rendered.getChannelData(0))
}

// ---------------------------------------------------------------------------
// worker plumbing
// ---------------------------------------------------------------------------

let worker: Worker | null = null
let seq = 0

function getWorker(): Worker {
  if (!worker) {
    worker = new Worker(new URL('./captions.worker.ts', import.meta.url), { type: 'module' })
  }
  return worker
}

// Transcribe ONE audio window in the worker. `windowIndex`/`windowCount` label transcribe-phase
// progress; download/prepare progress (first window only) passes through unchanged.
function transcribeWindow(
  audio: Float32Array,
  windowIndex: number,
  windowCount: number,
  onProgress?: (p: CaptionProgress) => void,
): Promise<AsrChunk[]> {
  const w = getWorker()
  const id = ++seq
  return new Promise<AsrChunk[]>((resolve, reject) => {
    const cleanup = () => {
      w.removeEventListener('message', handle)
      w.removeEventListener('error', onError)
      w.removeEventListener('messageerror', onMsgErr)
    }
    const handle = (e: MessageEvent<WorkerOut>) => {
      const msg = e.data
      if (msg.id !== id) return
      if (msg.type === 'progress') {
        const { type: _t, id: _i, ...rest } = msg
        void _t; void _i
        // The worker's per-call 'transcribe' phase carries no numbers; attach the window counter so
        // the modal can show "Recognizing speech… N/M".
        if (rest.phase === 'transcribe') onProgress?.({ phase: 'transcribe', done: windowIndex, total: windowCount })
        else onProgress?.(rest as CaptionProgress)
      } else if (msg.type === 'result') {
        cleanup()
        resolve(msg.chunks)
      } else if (msg.type === 'error') {
        cleanup()
        reject(new Error(msg.message))
      }
    }
    const onError = (e: ErrorEvent) => {
      cleanup()
      reject(new Error(e.message || 'The caption engine crashed while loading. Check the console for details.'))
    }
    const onMsgErr = () => { cleanup(); reject(new Error('The caption engine returned an unreadable response.')) }
    w.addEventListener('message', handle)
    w.addEventListener('error', onError)
    w.addEventListener('messageerror', onMsgErr)
    try {
      // Transfer the window buffer (zero-copy); it's a fresh slice, so the source mix stays intact.
      w.postMessage({ type: 'transcribe', id, audio }, [audio.buffer])
    } catch (err) {
      cleanup()
      reject(err instanceof Error ? err : new Error(String(err)))
    }
  })
}

// Whisper's receptive field is 30s. We window the mix ourselves (rather than let the pipeline chunk a
// single giant call) so we can report real per-window progress. Windows overlap so a phrase split by a
// boundary is still fully heard by one of them; each window "owns" only its non-overlap core, and a
// segment is kept by whichever window's core its midpoint falls in — deduping the overlap cleanly.
const WINDOW_SEC = 30
const WINDOW_OVERLAP_SEC = 5
const WINDOW_STEP_SEC = WINDOW_SEC - WINDOW_OVERLAP_SEC // 25

type OffsetSegment = { start: number; end: number; text: string }

async function transcribeWindowed(
  audio: Float32Array,
  onProgress?: (p: CaptionProgress) => void,
): Promise<OffsetSegment[]> {
  const total = audio.length
  const chunkSamples = WINDOW_SEC * ASR_SAMPLE_RATE
  const stepSamples = WINDOW_STEP_SEC * ASR_SAMPLE_RATE

  const windowStarts: number[] = []
  for (let start = 0; start < total; start += stepSamples) {
    windowStarts.push(start)
    if (start + chunkSamples >= total) break // this window already reaches the end
  }
  const n = windowStarts.length

  const segments: OffsetSegment[] = []
  for (let i = 0; i < n; i++) {
    const startSample = windowStarts[i]
    const endSample = Math.min(startSample + chunkSamples, total)
    const windowAudio = audio.slice(startSample, endSample) // fresh buffer (transferable)
    const offsetSec = startSample / ASR_SAMPLE_RATE
    const winDur = (endSample - startSample) / ASR_SAMPLE_RATE
    // "Core" (responsibility) range within the window — internal edges give up half the overlap.
    const coreStart = i === 0 ? 0 : WINDOW_OVERLAP_SEC / 2
    const coreEnd = i === n - 1 ? winDur : winDur - WINDOW_OVERLAP_SEC / 2

    const chunks = await transcribeWindow(windowAudio, i, n, onProgress)
    for (const c of chunks) {
      const s = c.timestamp[0] ?? 0
      const e = c.timestamp[1] ?? winDur
      const mid = (s + e) / 2
      if (mid < coreStart || mid > coreEnd) continue // belongs to the neighbouring window
      segments.push({ start: s + offsetSec, end: e + offsetSec, text: c.text })
    }
    onProgress?.({ phase: 'transcribe', done: i + 1, total: n })
  }
  return segments
}

// ---------------------------------------------------------------------------
// segment → cue mapping
// ---------------------------------------------------------------------------

// A cue must contain at least one letter or digit — Whisper emits stray punctuation-only segments
// (",", "...", ",...") on music/non-speech audio; those are noise, not captions (spec 35 follow-up).
function hasSpeech(text: string): boolean {
  return /[\p{L}\p{N}]/u.test(text)
}

// Turn recognized segments into clean cues: drop non-speech, sort by start, clamp each end so it never
// overlaps the next cue, and guarantee end > start. `totalDuration` caps a trailing/overrun end.
function segmentsToCues(segments: OffsetSegment[], totalDuration: number): CaptionCue[] {
  const cleaned = segments
    .map((c) => ({ start: c.start, end: c.end, text: c.text.trim() }))
    .filter((c) => hasSpeech(c.text))
    .sort((a, b) => a.start - b.start)

  const cues: CaptionCue[] = []
  for (let i = 0; i < cleaned.length; i++) {
    const c = cleaned[i]
    const nextStart = i + 1 < cleaned.length ? cleaned[i + 1].start : totalDuration
    let end = c.end
    if (nextStart > c.start) end = Math.min(end, nextStart)
    if (!(end > c.start)) end = Math.min(c.start + 1, nextStart > c.start ? nextStart : c.start + 1)
    cues.push({ id: crypto.randomUUID(), startTime: c.start, endTime: end, text: c.text })
  }
  return cues
}

export type GenerateResult = { cues: CaptionCue[] }

// Full generate flow: mix → windowed transcribe → map to cues. Throws a readable Error on no-audio /
// no-speech / engine failure (surfaced by the modal).
export async function generateCaptions(
  project: Project,
  onProgress?: (p: CaptionProgress) => void,
): Promise<GenerateResult> {
  onProgress?.({ phase: 'mixing' })
  const audio = await mixTimelineMono16k(project)
  if (!audio || audio.length === 0) {
    throw new Error('There is no audio on the timeline to transcribe. Add a video or audio clip first.')
  }
  const segments = await transcribeWindowed(audio, onProgress)
  const cues = segmentsToCues(segments, timelineDuration(project))
  if (cues.length === 0) {
    throw new Error('No speech was detected in the timeline audio.')
  }
  return { cues }
}

// ---------------------------------------------------------------------------
// render-time resolver
// ---------------------------------------------------------------------------

// The cue visible at globalTime (the one whose [startTime, endTime) contains it), or null. Only one
// caption shows at a time (standard subtitle model). Linear scan — cue counts are small.
export function activeCueAt(track: CaptionTrack, globalTime: number): CaptionCue | null {
  if (track.hidden) return null
  for (const cue of track.cues) {
    if (globalTime >= cue.startTime && globalTime < cue.endTime) return cue
  }
  return null
}

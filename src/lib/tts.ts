// Text-to-speech main-thread client (spec 32). Owns a singleton worker (src/lib/tts.worker.ts) and
// exposes a promise-based `synthesizeSpeech`. This file imports NOTHING from the engine — pocket-tts
// (onnxruntime-web + sentencepiece) lives entirely in the worker chunk, so importing this stays cheap.

// Curated voice roster. pocket-tts's English bundle ships 8 built-in voices (Les Misérables character
// names under the hood). We surface neutral "Masculine N" / "Feminine N" labels - hiding the character
// names avoids biasing the user's choice. `id` stays the underlying pocket-tts voice name.
export type TtsVoice = { id: string; label: string; group: string }

export const TTS_VOICES: TtsVoice[] = [
  { id: 'alba',    label: 'Masculine 1', group: 'English' }, // Alba
  { id: 'javert',  label: 'Masculine 2', group: 'English' }, // Javert
  { id: 'jean',    label: 'Masculine 3', group: 'English' }, // Jean
  { id: 'marius',  label: 'Masculine 4', group: 'English' }, // Marius
  { id: 'azelma',  label: 'Feminine 1',  group: 'English' }, // Azelma
  { id: 'cosette', label: 'Feminine 2',  group: 'English' }, // Cosette
  { id: 'eponine', label: 'Feminine 3',  group: 'English' }, // Eponine
  { id: 'fantine', label: 'Feminine 4',  group: 'English' }, // Fantine
]

export const DEFAULT_TTS_VOICE = 'alba'

// Progress emitted while synthesizing. `download` fires (once, on first-ever use) while the model
// files load; `synth` fires per sentence-chunk as audio is generated.
export type TtsProgress =
  | { phase: 'download'; file?: string; progress?: number }
  | { phase: 'prepare' } // model files fetched; compiling them into inference sessions (no % — opaque)
  | { phase: 'synth'; done: number; total: number }

export type TtsResult = { blob: Blob; duration: number; sampleRate: number }

type WorkerOut =
  | ({ type: 'progress'; id: number } & TtsProgress)
  | { type: 'result'; id: number; wav: ArrayBuffer; duration: number; sampleRate: number }
  | { type: 'error'; id: number; message: string }

let worker: Worker | null = null
let seq = 0

function getWorker(): Worker {
  if (!worker) {
    // Vite compiles this into a separate ES module worker chunk (worker.format: 'es').
    worker = new Worker(new URL('./tts.worker.ts', import.meta.url), { type: 'module' })
  }
  return worker
}

// Synthesize speech to a WAV Blob. Rejects with a readable Error on model-load / inference failure
// (surfaced by the modal). onProgress is optional.
export function synthesizeSpeech(
  params: { text: string; voice: string },
  onProgress?: (p: TtsProgress) => void,
): Promise<TtsResult> {
  const w = getWorker()
  const id = ++seq
  return new Promise<TtsResult>((resolve, reject) => {
    const cleanup = () => {
      w.removeEventListener('message', handle)
      w.removeEventListener('error', onError)
      w.removeEventListener('messageerror', onMsgErr)
    }
    const handle = (e: MessageEvent<WorkerOut>) => {
      const msg = e.data
      if (msg.id !== id) return // ignore results from other in-flight requests
      if (msg.type === 'progress') {
        const { type: _t, id: _i, ...rest } = msg
        void _t; void _i
        onProgress?.(rest as TtsProgress)
      } else if (msg.type === 'result') {
        cleanup()
        resolve({ blob: new Blob([msg.wav], { type: 'audio/wav' }), duration: msg.duration, sampleRate: msg.sampleRate })
      } else if (msg.type === 'error') {
        cleanup()
        reject(new Error(msg.message))
      }
    }
    // Worker-level failures (uncaught throw in the worker, module load error, thread/OOM crash) fire
    // here, NOT as a 'message'. Without these the promise would hang forever / die silently.
    const onError = (e: ErrorEvent) => {
      cleanup()
      reject(new Error(e.message || 'The speech engine crashed while loading. Check the console for details.'))
    }
    const onMsgErr = () => { cleanup(); reject(new Error('The speech engine returned an unreadable response.')) }
    w.addEventListener('message', handle)
    w.addEventListener('error', onError)
    w.addEventListener('messageerror', onMsgErr)
    try {
      w.postMessage({ type: 'generate', id, text: params.text, voice: params.voice })
    } catch (err) {
      cleanup()
      reject(err instanceof Error ? err : new Error(String(err)))
    }
  })
}

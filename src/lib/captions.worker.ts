// Auto-captions worker (spec 35) — speech recognition via transformers.js (Whisper ONNX).
//
// The whole timeline's audio is mixed to a 16 kHz mono Float32Array on the main thread
// (src/lib/captions.ts) and transferred in here; we run it through a Whisper ASR pipeline with
// segment timestamps and post back the recognized chunks. transformers.js (@huggingface/transformers)
// is imported ONLY here, via a DYNAMIC import, so Vite code-splits it (and the onnxruntime-web it
// bundles) into this worker chunk — non-caption users pay nothing, and ort's pthread workers re-load
// the split chunk rather than clobbering our top-level onmessage (the spec-32 deadlock lesson).
//
// Model weights are self-hosted in our Cloudflare R2 bucket (the same one as TTS, spec 32) and
// browser-cached after first use. transformers.js builds each file URL as
// `${env.remoteHost}${fill(env.remotePathTemplate)}${file}`, so we just repoint those two env fields
// (see MODEL_HOST / MODEL_PATH_TEMPLATE below) — no hand-rolled fetching like the TTS worker.

const ctx = self as unknown as Worker

// --- MODEL HOSTING (spec 35 follow-up; mirrors spec 32 TTS) --------------------------------------
// R2 has zero egress fees and its CORS passes our COEP require-corp; Cloudflare Pages can't host the
// weights (the merged decoder alone is ~170MB, over Pages' 25MiB/file limit). In dev we serve the
// SAME file tree same-origin from /models/ (populated by `npm run fetch-captions-model`), so no CDN
// and it works offline once fetched. VITE_CAPTIONS_MODEL_HOST overrides either default.
// The template flattens HF's `{model}/resolve/{revision}/` to `{model}/{revision}/` so the fetched
// public/models/<org>/ folder uploads to the R2 bucket root verbatim (trailing slash matters).
const MODEL_HOST =
  import.meta.env.VITE_CAPTIONS_MODEL_HOST ??
  (import.meta.env.DEV ? '/models/' : 'https://gerty-models.tomg.cool/')
const MODEL_PATH_TEMPLATE = '{model}/{revision}/'

// --- MODEL (swappable) ---------------------------------------------------------------------------
// distil-small.en: English-only distilled Whisper, ~170MB q8, segment timestamps. If accuracy is too
// low, swap MODEL_ID for a stronger one (all one-line changes, same pipeline call):
//   'distil-whisper/distil-medium.en'  — more accurate, ~2x the download
//   'Xenova/whisper-small.en'          — full small.en (not distilled)
//   'Xenova/whisper-base.en'           — smaller/faster, less accurate
//   'onnx-community/whisper-large-v3-turbo'  — multilingual, largest
const MODEL_ID = 'distil-whisper/distil-small.en'
const MODEL_DTYPE = 'q8' // quantization: 'q8' (smallest) | 'fp32' (best quality, largest)

// --- minimal transformers.js typings (the dep ships full types, but the module is loaded lazily) --
type ProgressInfo = { status: string; file?: string; name?: string; progress?: number; loaded?: number; total?: number }
type AsrChunk = { timestamp: [number, number | null]; text: string }
type AsrOutput = { text: string; chunks?: AsrChunk[] }
type Transcriber = (audio: Float32Array, opts: Record<string, unknown>) => Promise<AsrOutput>
type TransformersModule = {
  pipeline: (task: string, model: string, opts: Record<string, unknown>) => Promise<Transcriber>
  env: {
    allowLocalModels: boolean
    allowRemoteModels: boolean
    remoteHost: string
    remotePathTemplate: string
    backends: { onnx: { wasm: { numThreads: number } } }
  }
}

let transcriberPromise: Promise<Transcriber> | null = null

// Loaded once (promise cached), so download progress only fires on the first-ever request.
function ensureTranscriber(id: number): Promise<Transcriber> {
  if (!transcriberPromise) {
    transcriberPromise = (async () => {
      const mod = (await import('@huggingface/transformers')) as unknown as TransformersModule
      // Load from our R2 host (prod) / same-origin /models/ (dev), never transformers.js's built-in
      // localModelPath mechanism — allowLocalModels=false also dodges the Vite SPA fallback returning
      // index.html for a missing /models/... path (200 that fails to parse; the spec-32 lesson).
      mod.env.allowLocalModels = false
      mod.env.allowRemoteModels = true
      mod.env.remoteHost = MODEL_HOST
      mod.env.remotePathTemplate = MODEL_PATH_TEMPLATE
      // Single-threaded for reliability first (spec-32 pthread deadlock). Author-time job; speed is
      // secondary to it simply working. Revisit multi-thread once accuracy is validated.
      mod.env.backends.onnx.wasm.numThreads = 1

      return mod.pipeline('automatic-speech-recognition', MODEL_ID, {
        dtype: MODEL_DTYPE,
        device: 'wasm',
        progress_callback: (p: ProgressInfo) => {
          if (p.status === 'progress') {
            ctx.postMessage({ type: 'progress', id, phase: 'download', file: p.file ?? p.name, progress: Math.round(p.progress ?? 0) })
          } else if (p.status === 'ready') {
            ctx.postMessage({ type: 'progress', id, phase: 'prepare' })
          }
        },
      })
    })().catch((e) => {
      transcriberPromise = null // let a later attempt retry a failed load
      throw e
    })
  }
  return transcriberPromise
}

// message protocol (matches src/lib/captions.ts): transcribe → progress* → result | error
type InMsg = { type: 'transcribe'; id: number; audio: Float32Array }

ctx.onmessage = async (e: MessageEvent<InMsg>) => {
  const msg = e.data
  if (msg.type !== 'transcribe') return
  const { id, audio } = msg
  try {
    const transcribe = await ensureTranscriber(id)
    ctx.postMessage({ type: 'progress', id, phase: 'transcribe' })
    // Segment-level timestamps over long audio (Whisper's 30s window, stitched internally).
    const output = await transcribe(audio, {
      return_timestamps: true,
      chunk_length_s: 30,
      stride_length_s: 5,
    })
    const chunks: AsrChunk[] = output.chunks ?? []
    ctx.postMessage({ type: 'result', id, chunks })
  } catch (err) {
    ctx.postMessage({ type: 'error', id, message: err instanceof Error ? err.message : String(err) })
  }
}

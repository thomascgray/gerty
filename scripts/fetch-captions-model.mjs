// Downloads the Whisper ASR weights (spec 35, auto-captions) into gitignored public/models/, laid
// out EXACTLY as transformers.js requests them ({model}/{revision}/...) so the same folder uploads
// verbatim to our Cloudflare R2 bucket. In production the weights load from R2 at runtime (Cloudflare
// Pages can't host files >25MiB; the merged decoder is ~170MB); in dev they load same-origin from
// /models/. See src/lib/captions.worker.ts (MODEL_HOST / MODEL_ID / MODEL_DTYPE).
//
//   npm run fetch-captions-model
//
// Idempotent: existing files with the right size are skipped.

import { mkdir } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { download } from './hf-mirror.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

// MUST match captions.worker.ts: MODEL_ID, revision, and MODEL_DTYPE ('q8' → *_quantized.onnx).
const MODEL_ID = 'distil-whisper/distil-small.en'
const REVISION = 'main'
const HF_BASE = `https://huggingface.co/${MODEL_ID}/resolve/${REVISION}`

// Small config/tokenizer metadata transformers.js may request (several are optional / fetched
// fatal:false — we mirror them all so nothing 404s) plus the two q8 ONNX graphs actually loaded
// (encoder + merged decoder). Everything else in the repo (fp32 / safetensors / ggml / pytorch /
// unquantized onnx / with-past decoders) is deliberately skipped so we only pay for what runs.
const FILES = [
  'config.json',
  'generation_config.json',
  'preprocessor_config.json',
  'tokenizer.json',
  'tokenizer_config.json',
  'added_tokens.json',
  'special_tokens_map.json',
  'normalizer.json',
  'vocab.json',
  'merges.txt',
  'onnx/encoder_model_quantized.onnx',
  'onnx/decoder_model_merged_quantized.onnx',
]

// Flattened HF layout: {model}/{revision}/... (drops HF's `/resolve/`). Mirrors remotePathTemplate
// in captions.worker.ts, so `public/models/<org>/` uploads to the R2 bucket root as-is.
const DEST_DIR = join(root, 'public', 'models', ...MODEL_ID.split('/'), REVISION)

async function main() {
  console.log('Whisper caption weights (local dev; upload this tree to R2 for prod):')
  for (const f of FILES) {
    const dest = join(DEST_DIR, ...f.split('/'))
    await mkdir(dirname(dest), { recursive: true })
    await download(`${HF_BASE}/${f}`, dest, root)
  }
  const [org] = MODEL_ID.split('/')
  console.log(`\nDone. To deploy: upload public/models/${org}/ to the gerty-models R2 bucket root`)
  console.log(`(so keys read like "${MODEL_ID}/${REVISION}/config.json").`)
}

main().catch((err) => {
  console.error('\nfetch-captions-model failed:', err.message)
  process.exit(1)
})

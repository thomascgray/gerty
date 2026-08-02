// Full LOCAL-DEV setup for pocket-tts (spec 32): downloads the model weights into gitignored
// public/models/ AND populates public/vendor/ (via setupVendor). In production the weights are NOT
// used from here — they load from HuggingFace at runtime (Cloudflare Pages can't host files >25MiB);
// only the vendor step runs at build. See src/lib/tts.worker.ts MODEL_BASE and scripts/setup-tts-vendor.mjs.
//
//   npm run fetch-tts-model
//
// Idempotent: existing files with the right size are skipped.

import { mkdir, stat, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setupVendor } from './setup-tts-vendor.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

// Source: the KevinAHM pocket-tts-web HF Space (the ONNX export + browser reference we ported from).
const HF_BASE = 'https://huggingface.co/spaces/KevinAHM/pocket-tts-web/resolve/main'
const BUNDLE = 'english_2026-04'

// mimi_encoder is intentionally omitted — it's voice-cloning only; our curated voices come from
// voices.bin. (Add it back here if custom voice upload is ever wired up.)
const WEIGHT_FILES = [
  'bundle.json',
  'bos_before_voice.npy',
  'tokenizer.model',
  'voices.bin',
  'text_conditioner_int8.onnx',
  'flow_lm_flow_int8.onnx',
  'flow_lm_main_int8.onnx',
  'mimi_decoder_int8.onnx',
]

const WEIGHTS_DIR = join(root, 'public', 'models', 'pocket-tts', BUNDLE)

async function sizeOf(path) {
  try { return (await stat(path)).size } catch { return -1 }
}

async function download(url, dest) {
  const existing = await sizeOf(dest)
  const res = await fetch(url)
  if (!res.ok) throw new Error(`GET ${url} -> ${res.status} ${res.statusText}`)
  const expected = Number(res.headers.get('content-length') || 0)
  if (existing > 0 && expected > 0 && existing === expected) {
    console.log(`  = ${dest.replace(root, '.')} (${existing.toLocaleString()} bytes, skipped)`)
    res.body?.cancel?.()
    return
  }
  const buf = Buffer.from(await res.arrayBuffer())
  await writeFile(dest, buf)
  console.log(`  ↓ ${dest.replace(root, '.')} (${buf.length.toLocaleString()} bytes)`)
}

async function main() {
  await mkdir(WEIGHTS_DIR, { recursive: true })
  console.log('Model weights (local dev only):')
  for (const f of WEIGHT_FILES) {
    await download(`${HF_BASE}/onnx/${BUNDLE}/${f}`, join(WEIGHTS_DIR, f))
  }
  await setupVendor()
  console.log('\nDone. TTS assets are in place (gitignored).')
}

main().catch((err) => {
  console.error('\nfetch-tts-model failed:', err.message)
  process.exit(1)
})

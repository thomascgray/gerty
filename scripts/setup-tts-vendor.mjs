// Populates public/vendor/ with the pocket-tts (spec 32) runtime that CAN ship with the app: the ONNX
// Runtime Web wasm + glue (copied from node_modules) and the vendored sentencepiece tokenizer. Every
// file here is well under Cloudflare Pages' 25MiB/file limit, so this runs as part of `build` and a
// fresh deploy is self-sufficient. The model WEIGHTS are NOT here — they exceed 25MiB and load from
// HuggingFace at runtime instead (see src/lib/tts.worker.ts MODEL_BASE).
//
// Exported as setupVendor() (reused by fetch-tts-model.mjs) and runnable directly.

import { mkdir, stat, copyFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const HF_BASE = 'https://huggingface.co/spaces/KevinAHM/pocket-tts-web/resolve/main'
const VENDOR_DIR = join(root, 'public', 'vendor')
const ORT_DIR = join(VENDOR_DIR, 'ort')
const ORT_DIST = join(root, 'node_modules', 'onnxruntime-web', 'dist')
// Both .wasm binaries AND their .mjs loader glue — ORT's threaded runtime fetches the .mjs from
// wasmPaths at runtime, so serving only the .wasm would 404 the worker glue.
const ORT_FILES = [
  'ort-wasm-simd-threaded.wasm',
  'ort-wasm-simd-threaded.jsep.wasm',
  'ort-wasm-simd-threaded.mjs',
  'ort-wasm-simd-threaded.jsep.mjs',
]

async function sizeOf(path) {
  try { return (await stat(path)).size } catch { return -1 }
}

export async function setupVendor() {
  await mkdir(ORT_DIR, { recursive: true })

  console.log('sentencepiece tokenizer:')
  const spDest = join(VENDOR_DIR, 'sentencepiece.js')
  const res = await fetch(`${HF_BASE}/sentencepiece.js`)
  if (!res.ok) throw new Error(`GET sentencepiece.js -> ${res.status} ${res.statusText}`)
  const buf = Buffer.from(await res.arrayBuffer())
  if (await sizeOf(spDest) === buf.length) {
    console.log('  = public/vendor/sentencepiece.js (skipped)')
  } else {
    await writeFile(spDest, buf)
    console.log(`  ↓ public/vendor/sentencepiece.js (${buf.length.toLocaleString()} bytes)`)
  }

  console.log('ONNX Runtime Web wasm (from node_modules):')
  for (const f of ORT_FILES) {
    const src = join(ORT_DIST, f)
    if (await sizeOf(src) < 0) throw new Error(`Missing ${src} — run \`npm install\` first (onnxruntime-web).`)
    await copyFile(src, join(ORT_DIR, f))
    console.log(`  → public/vendor/ort/${f}`)
  }
}

// Run directly (not when imported).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  setupVendor()
    .then(() => console.log('\nVendor assets ready (public/vendor/).'))
    .catch((err) => { console.error('\nsetup-tts-vendor failed:', err.message); process.exit(1) })
}

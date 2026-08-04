// Shared HuggingFace file-mirror helpers, used by fetch-tts-model.mjs (spec 32) and
// fetch-captions-model.mjs (spec 35). Both scripts download model files from HF into gitignored
// public/ for local dev; the same files are uploaded to our Cloudflare R2 bucket for production.

import { stat, writeFile } from 'node:fs/promises'

export async function sizeOf(path) {
  try { return (await stat(path)).size } catch { return -1 }
}

// Download `url` to `dest`, skipping when an existing file already matches the response's
// content-length (idempotent re-runs). `root` is stripped from the logged path for readability.
export async function download(url, dest, root = '') {
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

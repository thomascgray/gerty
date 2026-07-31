import type { AssetMeta, AssetType } from '../types'
import { probeAnimatedImage, sniffImageMime, type AnimatedImageInfo } from './animatedImage'

const DB_NAME = 'gerty-assets'
const DB_VERSION = 1
const STORE_NAME = 'blobs'

// In-memory blob cache + object URL management
const blobCache = new Map<string, Blob>()
const objectUrls = new Map<string, string>()

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = () => {
      req.result.createObjectStore(STORE_NAME)
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

function idbPut(db: IDBDatabase, key: string, value: Blob): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite')
    tx.objectStore(STORE_NAME).put(value, key)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
}

function idbGet(db: IDBDatabase, key: string): Promise<Blob | undefined> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly')
    const req = tx.objectStore(STORE_NAME).get(key)
    req.onsuccess = () => resolve(req.result ?? undefined)
    req.onerror = () => reject(req.error)
  })
}

function idbDelete(db: IDBDatabase, key: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite')
    tx.objectStore(STORE_NAME).delete(key)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
}

function idbGetAllKeys(db: IDBDatabase): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly')
    const req = tx.objectStore(STORE_NAME).getAllKeys()
    req.onsuccess = () => resolve(req.result as string[])
    req.onerror = () => reject(req.error)
  })
}

/**
 * Store a blob in memory + IndexedDB. Returns asset metadata.
 *
 * Image assets are probed for animation (spec 28 B1) and the resulting per-frame
 * timings recorded on the meta, so the animation survives a reload without ever
 * re-decoding. Callers that already probed while staging (ImportModal) pass the
 * result in via `animation` to avoid paying for it twice.
 */
export async function storeAsset(
  file: File,
  animation?: AnimatedImageInfo,
): Promise<{ meta: AssetMeta; blob: Blob }> {
  const id = crypto.randomUUID()
  const type = detectAssetType(file.type)
  const blob = file as Blob

  blobCache.set(id, blob)

  const db = await openDB()
  await idbPut(db, id, blob)
  db.close()

  const meta: AssetMeta = {
    id,
    type,
    filename: file.name,
    mimeType: file.type,
    size: file.size,
  }

  if (type === 'image') {
    const info = animation ?? (await probeAnimatedImage(blob))
    if (info.animated) {
      meta.animated = true
      meta.duration = info.duration        // reused as the loop length
      meta.frameDelaysMs = info.frameDelaysMs
    }
  }

  return { meta, blob }
}

/** Store a blob directly (e.g. from project import). */
export async function storeAssetBlob(id: string, blob: Blob): Promise<void> {
  blobCache.set(id, blob)
  const db = await openDB()
  await idbPut(db, id, blob)
  db.close()
}

/** Get an Object URL for an asset. Cached — same URL returned for same id. */
export function getAssetUrl(id: string): string | undefined {
  if (objectUrls.has(id)) return objectUrls.get(id)
  const blob = blobCache.get(id)
  if (!blob) return undefined
  const url = URL.createObjectURL(blob)
  objectUrls.set(id, url)
  return url
}

/** Get the raw blob for an asset. */
export function getAssetBlob(id: string): Blob | undefined {
  return blobCache.get(id)
}

/** Remove an asset from memory + IndexedDB. */
export async function removeAsset(id: string): Promise<void> {
  blobCache.delete(id)
  const url = objectUrls.get(id)
  if (url) {
    URL.revokeObjectURL(url)
    objectUrls.delete(id)
  }
  const db = await openDB()
  await idbDelete(db, id)
  db.close()
}

/** Load all asset blobs from IndexedDB into the in-memory cache. Call on app startup. */
export async function loadAssetsFromDB(): Promise<void> {
  const db = await openDB()
  const keys = await idbGetAllKeys(db)
  for (const key of keys) {
    if (!blobCache.has(key)) {
      const blob = await idbGet(db, key)
      if (blob) blobCache.set(key, blob)
    }
  }
  db.close()
}

/** Clear all assets from memory and IndexedDB. */
export async function clearAllAssets(): Promise<void> {
  for (const url of objectUrls.values()) URL.revokeObjectURL(url)
  objectUrls.clear()
  blobCache.clear()
  const db = await openDB()
  const keys = await idbGetAllKeys(db)
  for (const key of keys) {
    await idbDelete(db, key)
  }
  db.close()
}

function detectAssetType(mimeType: string): AssetType {
  if (mimeType.startsWith('image/')) return 'image'
  if (mimeType.startsWith('audio/')) return 'audio'
  if (mimeType.startsWith('video/')) return 'video'
  return 'image' // fallback
}

/** The importable media types — image / audio / video. Shared by the drop and modal paths (spec 31 B7). */
export function isSupportedMediaFile(file: File): boolean {
  return file.type.startsWith('image/') || file.type.startsWith('audio/') || file.type.startsWith('video/')
}

/** Get media duration for audio/video files. */
export function getMediaDuration(blob: Blob): Promise<number> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob)
    const el = blob.type.startsWith('video/')
      ? document.createElement('video')
      : document.createElement('audio')
    el.preload = 'metadata'
    el.onloadedmetadata = () => {
      const duration = el.duration
      URL.revokeObjectURL(url)
      resolve(duration)
    }
    el.onerror = () => {
      URL.revokeObjectURL(url)
      reject(new Error('Failed to load media metadata'))
    }
    el.src = url
  })
}

/** Generate waveform peak data from an audio blob. Returns ~200 peak values (0–1). */
export async function generateWaveform(blob: Blob, numPeaks = 200): Promise<number[]> {
  const arrayBuffer = await blob.arrayBuffer()
  const audioCtx = new AudioContext()
  const audioBuffer = await audioCtx.decodeAudioData(arrayBuffer)
  const channelData = audioBuffer.getChannelData(0)
  await audioCtx.close()

  const samplesPerPeak = Math.floor(channelData.length / numPeaks)
  const peaks: number[] = []

  for (let i = 0; i < numPeaks; i++) {
    let max = 0
    const start = i * samplesPerPeak
    const end = Math.min(start + samplesPerPeak, channelData.length)
    for (let j = start; j < end; j++) {
      const abs = Math.abs(channelData[j])
      if (abs > max) max = abs
    }
    peaks.push(max)
  }

  return peaks
}

/** Total size of all cached blobs in bytes. */
export function getTotalAssetSize(): number {
  let total = 0
  for (const blob of blobCache.values()) total += blob.size
  return total
}

export const SIZE_WARN_PER_FILE = 50 * 1024 * 1024   // 50 MB
export const SIZE_WARN_TOTAL = 500 * 1024 * 1024      // 500 MB

// ---------------------------------------------------------------------------
// Fetching an asset from a pasted URL (spec 28 A)
// ---------------------------------------------------------------------------

export type AssetFetchErrorKind =
  | 'scheme'            // not http/https/data
  | 'network'           // CORS block, DNS failure, offline — indistinguishable by design
  | 'http-status'       // server said no
  | 'unsupported-type'  // fetched fine, but it isn't media we can use
  | 'too-large'         // Content-Length over the per-file cap

/**
 * A fetch failure carrying a message that is already fit to show the user —
 * the error copy IS this feature's UX, so it lives here rather than in the modal.
 */
export class AssetFetchError extends Error {
  kind: AssetFetchErrorKind
  constructor(kind: AssetFetchErrorKind, message: string) {
    super(message)
    this.name = 'AssetFetchError'
    this.kind = kind
  }
}

const MIME_EXT: Record<string, string> = {
  'image/png': 'png', 'image/apng': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif',
  'image/webp': 'webp', 'image/avif': 'avif', 'image/svg+xml': 'svg',
  'audio/mpeg': 'mp3', 'audio/wav': 'wav', 'audio/ogg': 'ogg', 'audio/webm': 'weba',
  'video/mp4': 'mp4', 'video/webm': 'webm', 'video/quicktime': 'mov',
}

const EXT_MIME: Record<string, string> = {
  png: 'image/png', apng: 'image/apng', jpg: 'image/jpeg', jpeg: 'image/jpeg',
  gif: 'image/gif', webp: 'image/webp', avif: 'image/avif',
  mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', m4a: 'audio/mp4',
  mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime',
}

function isSupportedMime(mime: string): boolean {
  return mime.startsWith('image/') || mime.startsWith('audio/') || mime.startsWith('video/')
}

/** Last path segment of a URL, query/hash stripped and percent-decoding undone. */
function filenameFromUrl(url: URL): string {
  const last = url.pathname.split('/').filter(Boolean).pop() ?? ''
  try {
    return decodeURIComponent(last)
  } catch {
    return last
  }
}

/** True when a string looks like something we could fetch as an asset. */
export function isFetchableUrl(text: string): boolean {
  try {
    const u = new URL(text)
    return u.protocol === 'http:' || u.protocol === 'https:' || u.protocol === 'data:'
  } catch {
    return false
  }
}

/**
 * Fetch a pasted URL and return it as a File, ready to go through the exact same
 * staging path as a dropped file (spec 28 A8) — so it lands in IndexedDB and the
 * project never references the remote URL again.
 *
 * Deliberately plain `fetch` with default CORS (A7): `mode: 'no-cors'` yields an
 * unreadable opaque blob, and loading via an <img> instead would TAINT THE CANVAS,
 * which breaks VideoFrame(canvas) and would kill export for the entire project.
 * Real bytes or a clear error.
 */
export async function fetchAssetFromUrl(rawUrl: string): Promise<File> {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    throw new AssetFetchError('scheme', "That doesn't look like a valid link.")
  }

  const scheme = url.protocol
  if (scheme !== 'http:' && scheme !== 'https:' && scheme !== 'data:') {
    throw new AssetFetchError(
      'scheme',
      scheme === 'blob:'
        ? "That's a temporary link from another page and can't be read here — save the file and drag it in."
        : `Links starting with "${scheme}" can't be loaded — save the file and drag it in.`,
    )
  }

  let res: Response
  try {
    res = await fetch(url.href)
  } catch {
    // A CORS block and a genuine network failure are deliberately indistinguishable
    // to page JS, so the message has to cover both without guessing.
    throw new AssetFetchError(
      'network',
      "Couldn't load that link — the site may not allow other sites to read its files. Try saving it and dragging it in instead.",
    )
  }

  if (!res.ok) {
    throw new AssetFetchError('http-status', `That link returned an error (${res.status} ${res.statusText}).`)
  }

  // Pre-reject oversized downloads before reading the body — the only guard available
  // before the bytes are already in memory (A9).
  const declaredLength = Number(res.headers.get('content-length'))
  if (Number.isFinite(declaredLength) && declaredLength > SIZE_WARN_PER_FILE) {
    throw new AssetFetchError(
      'too-large',
      `That file is too big to load from a link (${(declaredLength / 1024 / 1024).toFixed(0)} MB) — download it and drag it in.`,
    )
  }

  const headerMime = (res.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase()
  const blob = await res.blob()

  // Resolve a usable mime: a meaningful header wins, then the container's magic
  // bytes, then the URL's file extension.
  let mime = isSupportedMime(headerMime) ? headerMime : ''
  if (!mime) mime = (await sniffImageMime(blob)) ?? ''
  if (!mime) {
    const ext = filenameFromUrl(url).split('.').pop()?.toLowerCase() ?? ''
    mime = EXT_MIME[ext] ?? ''
  }
  if (!isSupportedMime(mime)) {
    throw new AssetFetchError(
      'unsupported-type',
      headerMime
        ? `That link is a ${headerMime} page, not an image, audio or video file.`
        : "That link doesn't point at an image, audio or video file.",
    )
  }

  // Name it after the URL where possible; otherwise synthesise one from the mime.
  const ext = MIME_EXT[mime] ?? mime.split('/')[1] ?? 'bin'
  let name = scheme === 'data:' ? '' : filenameFromUrl(url)
  if (!name || !name.includes('.')) {
    name = `pasted-${mime.split('/')[0]}.${ext}`
  }

  return new File([blob], name, { type: mime })
}

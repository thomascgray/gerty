// Text-to-speech worker (spec 32) — pocket-tts engine (kyutai-labs), ONNX Runtime Web.
//
// Ported from the KevinAHM `pocket-tts-web` browser reference. pocket-tts is a streaming LM + Mimi
// neural codec: 4 ONNX graphs (text_conditioner → flow_lm_main/flow → mimi_decoder) generate audio
// frame-by-frame. It's CPU-first (~1.5x realtime on WASM, no WebGPU) — which is exactly why we moved
// off kokoro (whose GPU path garbled on some machines and whose WASM path was too slow). See TASKS/32.
//
// onnxruntime-web + the sentencepiece tokenizer are imported ONLY here, so Vite code-splits them into
// this worker chunk; non-TTS users pay nothing. Weights + the ORT wasm + sentencepiece.js are served
// locally from public/ (populated by `npm run fetch-tts-model`) — no CDN, works offline once fetched.
//
// Curated voices come from voices.bin (precomputed states); the mimi_encoder (voice cloning) is NOT
// loaded. Non-determinism (Math.random sampling noise) is fine: TTS bakes to a WAV asset once.

import * as ort from 'onnxruntime-web'

// In a dedicated module worker `self` IS the worker global. Cast to Worker to borrow postMessage's
// (msg, transfer[]) + onmessage typing without pulling in the WebWorker lib (which clashes with DOM).
const ctx = self as unknown as Worker

// Model weights: local same-origin in dev (fast/offline, via `npm run fetch-tts-model`), fetched from
// HuggingFace at runtime in production. Cloudflare Pages rejects files >25MiB (ours reach ~73MiB), so
// the weights can't ship with the app; HF sends CORS headers so the cross-origin fetch is allowed
// under our COEP. Override with VITE_TTS_MODEL_BASE to point at your own HF mirror / R2 bucket.
const MODEL_BASE =
  import.meta.env.VITE_TTS_MODEL_BASE ??
  (import.meta.env.DEV
    ? '/models/pocket-tts/english_2026-04'
    : 'https://huggingface.co/spaces/KevinAHM/pocket-tts-web/resolve/main/onnx/english_2026-04')

// ORT wasm + the sentencepiece tokenizer are small enough to ship with the app (public/vendor/,
// served same-origin). Populated by `npm run fetch-tts-model` (dev) / the build step (prod).
const SENTENCEPIECE_URL = '/vendor/sentencepiece.js'
const ORT_WASM_BASE = '/vendor/ort/'

// --- generation constants (from the reference) ---
const CHUNK_GAP_SEC = 0.25          // silence inserted between sentence chunks
const MAX_FRAMES = 500              // hard cap on frames per chunk (safety)
const LSD_STEPS = 1                 // flow-matching (diffusion) steps per frame
const RESET_FLOW_STATE_EACH_CHUNK = true
const RESET_MIMI_STATE_EACH_CHUNK = true
const EOS_LOGIT_THRESHOLD = -4.0
const TEMPERATURE = 0.7

// --- bundle metadata shapes ---
type Dtype = 'float32' | 'bool' | 'int64'
type ManifestEntry = {
  dtype: Dtype
  fill?: string
  input_name: string
  output_name: string
  module: string
  key: string
  shape: number[]
}
type BundleMeta = {
  sample_rate: number
  samples_per_frame: number
  latent_dim: number
  conditioning_dim: number
  max_token_per_chunk?: number
  tokenizer_file: string
  bos_before_voice_file?: string
  insert_bos_before_voice?: boolean
  remove_semicolons?: boolean
  pad_with_spaces_for_short_inputs?: boolean
  model_recommended_frames_after_eos?: number | null
  predefined_voices?: string[]
  flow_lm_state_manifest: ManifestEntry[]
  mimi_state_manifest: ManifestEntry[]
}

type Raw = { data: Float32Array | BigInt64Array | Uint8Array; shape: number[]; dtype: string }
type VoiceRecord = Record<string, Raw>
type TensorMap = Record<string, ort.Tensor>
type RunResult = Record<string, ort.Tensor>

// The sentencepiece module is loaded at runtime (see loadTokenizer). Only the bits we use are typed.
type SpProcessor = {
  loadFromB64StringModel(b64: string): Promise<void>
  encodeIds(text: string): number[]
  decodeIds(ids: number[]): string
}

// --- lazily-loaded singletons (one English bundle, loaded once) ---
let loaded: Promise<void> | null = null
let meta: BundleMeta
let tokenizer: SpProcessor
let voiceRecords: Record<string, VoiceRecord> = {}
const voiceStateCache = new Map<string, TensorMap>()

let textConditioner: ort.InferenceSession
let flowLmMain: ort.InferenceSession
let flowLmFlow: ort.InferenceSession
let mimiDecoder: ort.InferenceSession

let sampleRate = 24000
let latentDim = 32
let conditioningDim = 1024
let maxTokenPerChunk = 50
let stTensors: { s: ort.Tensor; t: ort.Tensor }[] = []

// ---------------------------------------------------------------------------
// tensor / state helpers (ported from inference-worker.js)
// ---------------------------------------------------------------------------

function makeFilledArray(shape: number[], dtype: Dtype, fill?: string): Float32Array | BigInt64Array | Uint8Array {
  const size = shape.reduce((a, b) => a * b, 1)
  if (dtype === 'int64') return new BigInt64Array(size)
  if (dtype === 'bool') return new Uint8Array(size)
  const data = new Float32Array(size)
  if (fill === 'nan') data.fill(NaN)
  else if (fill === 'ones') data.fill(1)
  return data
}

function createTensor(dtype: Dtype, data: Float32Array | BigInt64Array | Uint8Array, dims: number[]): ort.Tensor {
  return new ort.Tensor(dtype as never, data as never, dims)
}

function initStateFromManifest(manifest: ManifestEntry[]): TensorMap {
  const state: TensorMap = {}
  for (const entry of manifest) {
    state[entry.input_name] = createTensor(entry.dtype, makeFilledArray(entry.shape, entry.dtype, entry.fill), entry.shape)
  }
  return state
}

function cloneState(state: TensorMap): TensorMap {
  return { ...state }
}

function updateStateFromManifestOutputs(state: TensorMap, result: RunResult, manifest: ManifestEntry[]): void {
  for (const entry of manifest) {
    state[entry.input_name] = result[entry.output_name]
  }
}

function groupVoiceRecordByModule(record: VoiceRecord): Record<string, Record<string, Raw>> {
  const grouped: Record<string, Record<string, Raw>> = {}
  for (const [key, value] of Object.entries(record)) {
    const slash = key.indexOf('/')
    if (slash === -1) continue
    const moduleName = key.slice(0, slash)
    const tensorKey = key.slice(slash + 1)
    ;(grouped[moduleName] ??= {})[tensorKey] = value
  }
  return grouped
}

// Copy a stored voice tensor into the model's expected shape/dtype, padding/truncating if needed.
function adaptTypedArray(source: Raw, entry: ManifestEntry): Float32Array | BigInt64Array | Uint8Array {
  const targetShape = entry.shape
  const targetSize = targetShape.reduce((a, b) => a * b, 1)
  const target = makeFilledArray(targetShape, entry.dtype, entry.fill)

  const exact = source.shape.length === targetShape.length && source.shape.every((d, i) => d === targetShape[i])
  if (exact || source.data.length === targetSize) {
    if (entry.dtype === 'int64') return new BigInt64Array(source.data as BigInt64Array)
    if (entry.dtype === 'bool') return new Uint8Array(source.data as Uint8Array)
    return new Float32Array(source.data as Float32Array)
  }
  if (source.shape.length !== targetShape.length) return target

  // Different shapes but same rank: copy the overlapping region element-by-element.
  const strides: number[] = []
  let stride = 1
  for (let i = source.shape.length - 1; i >= 0; i--) { strides[i] = stride; stride *= source.shape[i] }
  const indices = new Array(source.shape.length).fill(0)
  const maxIndices = source.shape.map((d, i) => Math.min(d, targetShape[i]))
  const targetIndex = (coords: number[]): number => {
    let idx = 0, tStride = 1
    for (let i = targetShape.length - 1; i >= 0; i--) { idx += coords[i] * tStride; tStride *= targetShape[i] }
    return idx
  }
  const srcData = source.data as unknown as { [i: number]: number | bigint }
  let done = false
  while (!done) {
    let sourceIdx = 0
    for (let i = 0; i < indices.length; i++) sourceIdx += indices[i] * strides[i]
    ;(target as unknown as { [i: number]: number | bigint })[targetIndex(indices)] = srcData[sourceIdx]
    for (let dim = indices.length - 1; dim >= 0; dim--) {
      indices[dim] += 1
      if (indices[dim] < maxIndices[dim]) break
      indices[dim] = 0
      if (dim === 0) done = true
    }
  }
  return target
}

function deriveStep(moduleState: Record<string, Raw>): Raw {
  if (moduleState.step) return { data: BigInt64Array.from([BigInt(Number(moduleState.step.data[0]))]), shape: [1], dtype: 'int64' }
  if (moduleState.offset && !moduleState.end_offset) return { data: BigInt64Array.from([BigInt(Number(moduleState.offset.data[0]))]), shape: [1], dtype: 'int64' }
  if (moduleState.current_end) return { data: BigInt64Array.from([BigInt(moduleState.current_end.shape[0])]), shape: [1], dtype: 'int64' }
  return { data: BigInt64Array.from([0n]), shape: [1], dtype: 'int64' }
}

// Build a flow-LM state from a stored (precomputed) voice record.
function stateFromVoiceRecord(record: VoiceRecord): TensorMap {
  const grouped = groupVoiceRecordByModule(record)
  const state = initStateFromManifest(meta.flow_lm_state_manifest)
  for (const entry of meta.flow_lm_state_manifest) {
    const moduleState = grouped[entry.module] || {}
    let source: Raw | undefined = moduleState[entry.key]
    if (!source && entry.key === 'step') source = deriveStep(moduleState)
    if (!source) continue
    state[entry.input_name] = createTensor(entry.dtype, adaptTypedArray(source, entry), entry.shape)
  }
  return state
}

// ---------------------------------------------------------------------------
// voices.bin parser (curated voice states), ported verbatim
// ---------------------------------------------------------------------------

function parseVoiceStatesBin(buffer: ArrayBuffer): Record<string, VoiceRecord> {
  const view = new DataView(buffer)
  let offset = 0
  const magic = new TextDecoder().decode(new Uint8Array(buffer, offset, 5)); offset += 5
  if (magic !== 'PTVB1') throw new Error('Invalid voices.bin header')
  const voices: Record<string, VoiceRecord> = {}
  const voiceCount = view.getUint32(offset, true); offset += 4
  for (let v = 0; v < voiceCount; v++) {
    const nameLen = view.getUint16(offset, true); offset += 2
    const name = new TextDecoder().decode(new Uint8Array(buffer, offset, nameLen)); offset += nameLen
    const tensorCount = view.getUint16(offset, true); offset += 2
    const tensors: VoiceRecord = {}
    for (let t = 0; t < tensorCount; t++) {
      const keyLen = view.getUint16(offset, true); offset += 2
      const key = new TextDecoder().decode(new Uint8Array(buffer, offset, keyLen)); offset += keyLen
      const dtypeCode = view.getUint8(offset); offset += 1
      const rank = view.getUint8(offset); offset += 1
      const shape: number[] = []
      for (let d = 0; d < rank; d++) { shape.push(view.getUint32(offset, true)); offset += 4 }
      const byteLength = view.getUint32(offset, true); offset += 4
      let data: Float32Array | BigInt64Array | Uint8Array
      if (dtypeCode === 0) data = new Float32Array(buffer.slice(offset, offset + byteLength))
      else if (dtypeCode === 1) data = new BigInt64Array(buffer.slice(offset, offset + byteLength))
      else if (dtypeCode === 2) data = new Uint8Array(buffer.slice(offset, offset + byteLength))
      else throw new Error(`Unsupported voices.bin dtype code: ${dtypeCode}`)
      offset += byteLength
      tensors[key] = { data, shape, dtype: dtypeCode === 0 ? 'float32' : dtypeCode === 1 ? 'int64' : 'bool' }
    }
    voices[name] = tensors
  }
  return voices
}

// ---------------------------------------------------------------------------
// text preparation + sentence chunking
// ---------------------------------------------------------------------------

function prepareTextPrompt(text: string): { text: string; framesAfterEos: number } {
  let prompt = text.trim()
  if (!prompt) return { text: '', framesAfterEos: 1 }
  prompt = prompt.replace(/\r/g, ' ').replace(/\n/g, ' ').replace(/\s+/g, ' ')
  if (meta.remove_semicolons) prompt = prompt.replace(/;/g, ',')
  const wordCount = prompt.split(/\s+/).filter(Boolean).length
  let framesAfterEos = wordCount <= 4 ? 3 : 1
  if (meta.model_recommended_frames_after_eos != null) framesAfterEos = Number(meta.model_recommended_frames_after_eos)
  if (prompt && !/[A-ZÀ-Þ]/.test(prompt[0])) prompt = prompt[0].toUpperCase() + prompt.slice(1)
  if (prompt && /[0-9A-Za-zÀ-ÿ]/.test(prompt[prompt.length - 1])) prompt += '.'
  if (meta.pad_with_spaces_for_short_inputs && wordCount < 5) prompt = '        ' + prompt
  return { text: prompt, framesAfterEos }
}

const SENTENCE_SPLIT_RE = /[^.!?]+[.!?]+|[^.!?]+$/g
function splitTextIntoSentences(text: string): string[] {
  const matches = text.match(SENTENCE_SPLIT_RE)
  if (!matches) return []
  return matches.map((s) => s.trim()).filter(Boolean)
}

function splitTokenIdsIntoChunks(tokenIds: number[], maxTokens: number): string[] {
  const chunks: string[] = []
  for (let i = 0; i < tokenIds.length; i += maxTokens) {
    const chunkText = tokenizer.decodeIds(tokenIds.slice(i, i + maxTokens)).trim()
    if (chunkText) chunks.push(chunkText)
  }
  return chunks
}

// Group sentences into chunks that fit under the model's per-chunk token budget.
function splitIntoBestSentences(text: string): { chunks: string[]; framesAfterEos: number } {
  const prepared = prepareTextPrompt(text)
  if (!prepared.text) return { chunks: [], framesAfterEos: prepared.framesAfterEos }
  const sentences = splitTextIntoSentences(prepared.text)
  if (!sentences.length) return { chunks: [prepared.text], framesAfterEos: prepared.framesAfterEos }

  const chunks: string[] = []
  let currentChunk = ''
  for (const sentence of sentences) {
    const ids = tokenizer.encodeIds(sentence)
    if (ids.length > maxTokenPerChunk) {
      if (currentChunk) { chunks.push(currentChunk.trim()); currentChunk = '' }
      for (const c of splitTokenIdsIntoChunks(ids, maxTokenPerChunk)) if (c) chunks.push(c.trim())
      continue
    }
    if (!currentChunk) { currentChunk = sentence; continue }
    const combined = `${currentChunk} ${sentence}`
    if (tokenizer.encodeIds(combined).length > maxTokenPerChunk) { chunks.push(currentChunk.trim()); currentChunk = sentence }
    else currentChunk = combined
  }
  if (currentChunk) chunks.push(currentChunk.trim())
  return { chunks, framesAfterEos: prepared.framesAfterEos }
}

function precomputeFlowBuffers(): void {
  stTensors = []
  const dt = 1.0 / LSD_STEPS
  for (let step = 0; step < LSD_STEPS; step++) {
    const s = step / LSD_STEPS
    stTensors.push({
      s: createTensor('float32', new Float32Array([s]), [1, 1]),
      t: createTensor('float32', new Float32Array([s + dt]), [1, 1]),
    })
  }
}

// ---------------------------------------------------------------------------
// WAV assembly (16-bit PCM mono)
// ---------------------------------------------------------------------------

function mergeFloat32(chunks: Float32Array[]): Float32Array {
  const total = chunks.reduce((sum, c) => sum + c.length, 0)
  const out = new Float32Array(total)
  let off = 0
  for (const c of chunks) { out.set(c, off); off += c.length }
  return out
}

function encodeWav(samples: Float32Array, rate: number): ArrayBuffer {
  const buffer = new ArrayBuffer(44 + samples.length * 2)
  const view = new DataView(buffer)
  const writeStr = (off: number, s: string) => { for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i)) }
  writeStr(0, 'RIFF')
  view.setUint32(4, 36 + samples.length * 2, true)
  writeStr(8, 'WAVE')
  writeStr(12, 'fmt ')
  view.setUint32(16, 16, true)      // PCM chunk size
  view.setUint16(20, 1, true)       // format = PCM
  view.setUint16(22, 1, true)       // channels = 1
  view.setUint32(24, rate, true)
  view.setUint32(28, rate * 2, true) // byte rate
  view.setUint16(32, 2, true)        // block align
  view.setUint16(34, 16, true)       // bits per sample
  writeStr(36, 'data')
  view.setUint32(40, samples.length * 2, true)
  let off = 44
  for (let i = 0; i < samples.length; i++, off += 2) {
    const s = Math.max(-1, Math.min(1, samples[i]))
    view.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true)
  }
  return buffer
}

// ---------------------------------------------------------------------------
// model loading
// ---------------------------------------------------------------------------

async function loadTokenizer(b64: string): Promise<void> {
  // sentencepiece.js is a vendored Emscripten ES module in /public (wasm embedded). Vite's dev server
  // refuses a direct dynamic import() of a /public path ("can only be referenced via HTML tags"), so
  // fetch it as text and import it through a Blob URL — opaque to Vite, same-origin (OK under COEP),
  // and its dead Node branches never execute in the worker. Revoke after load (module stays resident).
  const res = await fetch(SENTENCEPIECE_URL)
  if (!res.ok) throw new Error(`Failed to load sentencepiece.js (${res.status}). Run \`npm run fetch-tts-model\`?`)
  const url = URL.createObjectURL(new Blob([await res.text()], { type: 'text/javascript' }))
  try {
    const mod = await import(/* @vite-ignore */ url) as { SentencePieceProcessor: new () => SpProcessor }
    tokenizer = new mod.SentencePieceProcessor()
    await tokenizer.loadFromB64StringModel(b64)
  } finally {
    URL.revokeObjectURL(url)
  }
}

// Fetch a model file, reporting coarse download progress across the load (index/total files). `id` is
// the current request id so progress reaches the right in-flight synthesize() on the client.
async function fetchModelFile(name: string, index: number, total: number, id: number): Promise<ArrayBuffer> {
  ctx.postMessage({ type: 'progress', id, phase: 'download', file: name, progress: Math.round((index / total) * 100) })
  const res = await fetch(`${MODEL_BASE}/${name}`)
  if (!res.ok) throw new Error(`Failed to load ${name} (${res.status}). Did you run \`npm run fetch-tts-model\`?`)
  return res.arrayBuffer()
}

// Loaded once (the promise is cached), so download progress only ever fires on the first-ever request.
function ensureLoaded(id: number): Promise<void> {
  if (!loaded) {
    loaded = (async () => {
      ort.env.wasm.wasmPaths = ORT_WASM_BASE
      ort.env.wasm.simd = true
      ort.env.wasm.numThreads = (self as unknown as { crossOriginIsolated?: boolean }).crossOriginIsolated
        ? Math.min(navigator.hardwareConcurrency || 4, 8)
        : 1

      const metaBuf = await fetchModelFile('bundle.json', 0, 6, id)
      meta = JSON.parse(new TextDecoder().decode(metaBuf)) as BundleMeta
      sampleRate = Number(meta.sample_rate)
      latentDim = Number(meta.latent_dim)
      conditioningDim = Number(meta.conditioning_dim)
      maxTokenPerChunk = Number(meta.max_token_per_chunk || 50)
      precomputeFlowBuffers()

      const opts: ort.InferenceSession.SessionOptions = { executionProviders: ['wasm'], graphOptimizationLevel: 'all' }
      // The four ONNX graphs (mimi_encoder skipped — curated voices only).
      const [textCondBuf, flowMainBuf, flowFlowBuf, decoderBuf] = await Promise.all([
        fetchModelFile('text_conditioner_int8.onnx', 1, 6, id),
        fetchModelFile('flow_lm_main_int8.onnx', 2, 6, id),
        fetchModelFile('flow_lm_flow_int8.onnx', 3, 6, id),
        fetchModelFile('mimi_decoder_int8.onnx', 4, 6, id),
      ])
      ;[textConditioner, flowLmMain, flowLmFlow, mimiDecoder] = await Promise.all([
        ort.InferenceSession.create(textCondBuf, opts),
        ort.InferenceSession.create(flowMainBuf, opts),
        ort.InferenceSession.create(flowFlowBuf, opts),
        ort.InferenceSession.create(decoderBuf, opts),
      ])

      const tokBuf = await fetchModelFile(meta.tokenizer_file, 5, 6, id)
      const tokB64 = btoa(String.fromCharCode(...new Uint8Array(tokBuf)))
      await loadTokenizer(tokB64)

      const voicesRes = await fetch(`${MODEL_BASE}/voices.bin`)
      if (voicesRes.ok) voiceRecords = parseVoiceStatesBin(await voicesRes.arrayBuffer())
    })().catch((e) => {
      loaded = null // let a later attempt retry a failed load
      throw e
    })
  }
  return loaded
}

function voiceState(voiceName: string): TensorMap {
  const cached = voiceStateCache.get(voiceName)
  if (cached) return cached
  const record = voiceRecords[voiceName]
  if (!record) throw new Error(`Unknown voice: ${voiceName}`)
  const state = stateFromVoiceRecord(record)
  voiceStateCache.set(voiceName, state)
  return state
}

// ---------------------------------------------------------------------------
// generation
// ---------------------------------------------------------------------------

async function generate(text: string, voiceName: string, onSynth: (done: number, total: number) => void): Promise<Float32Array> {
  const { chunks, framesAfterEos } = splitIntoBestSentences(text)
  if (!chunks.length) throw new Error('Nothing to say — enter some text first.')

  const baseFlowState = voiceState(voiceName)
  const emptySeq = createTensor('float32', new Float32Array(0), [1, 0, latentDim])
  const emptyTextEmb = createTensor('float32', new Float32Array(0), [1, 0, conditioningDim])
  const audioParts: Float32Array[] = []

  let mimiState = initStateFromManifest(meta.mimi_state_manifest)
  let flowLmState = cloneState(baseFlowState)
  const firstChunkFrames = 3
  const normalChunkFrames = 12
  let isFirstAudioChunk = true

  for (let chunkIdx = 0; chunkIdx < chunks.length; chunkIdx++) {
    if (RESET_FLOW_STATE_EACH_CHUNK && chunkIdx > 0) flowLmState = cloneState(baseFlowState)
    if (RESET_MIMI_STATE_EACH_CHUNK && chunkIdx > 0) mimiState = initStateFromManifest(meta.mimi_state_manifest)

    const ids = tokenizer.encodeIds(chunks[chunkIdx])
    const textInput = createTensor('int64', BigInt64Array.from(ids.map((t) => BigInt(t))), [1, ids.length])
    let textEmb = (await textConditioner.run({ token_ids: textInput }))[textConditioner.outputNames[0]]
    if (textEmb.dims.length === 2) {
      textEmb = createTensor('float32', new Float32Array(textEmb.data as Float32Array), [1, textEmb.dims[0], textEmb.dims[1]])
    }

    // Prime the flow-LM with the chunk's text conditioning.
    const condResult = await flowLmMain.run({ sequence: emptySeq, text_embeddings: textEmb, ...flowLmState })
    updateStateFromManifestOutputs(flowLmState, condResult, meta.flow_lm_state_manifest)

    const chunkLatents: Float32Array[] = []
    let chunkDecodedFrames = 0
    let currentLatent = createTensor('float32', new Float32Array(latentDim).fill(NaN), [1, 1, latentDim])
    let eosStep: number | null = null

    for (let step = 0; step < MAX_FRAMES; step++) {
      // Yield to the event loop occasionally so postMessage/progress can flush.
      if (step > 0 && step % 4 === 0) await new Promise((r) => setTimeout(r, 0))

      const arResult = await flowLmMain.run({ sequence: currentLatent, text_embeddings: emptyTextEmb, ...flowLmState })
      const conditioning = arResult.conditioning
      const eosLogit = (arResult.eos_logit.data as Float32Array)[0]
      if (eosLogit > EOS_LOGIT_THRESHOLD && eosStep == null) eosStep = step
      const shouldStop = eosStep != null && step >= eosStep + framesAfterEos

      // Sample the frame latent (Box-Muller gaussian * sqrt(temperature)), then integrate the flow.
      const std = Math.sqrt(TEMPERATURE)
      const latentData = new Float32Array(latentDim)
      for (let i = 0; i < latentDim; i++) {
        let u = 0, v = 0
        while (u === 0) u = Math.random()
        while (v === 0) v = Math.random()
        latentData[i] = Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v) * std
      }
      const dt = 1.0 / LSD_STEPS
      for (let lsd = 0; lsd < LSD_STEPS; lsd++) {
        const flowResult = await flowLmFlow.run({
          c: conditioning,
          s: stTensors[lsd].s,
          t: stTensors[lsd].t,
          x: createTensor('float32', latentData, [1, latentDim]),
        })
        const flowDir = flowResult.flow_dir.data as Float32Array
        for (let i = 0; i < latentDim; i++) latentData[i] += flowDir[i] * dt
      }

      chunkLatents.push(new Float32Array(latentData))
      currentLatent = createTensor('float32', latentData, [1, 1, latentDim])
      updateStateFromManifestOutputs(flowLmState, arResult, meta.flow_lm_state_manifest)

      // Decode accumulated latents to audio in small batches (streaming-style, but collected to WAV).
      const pending = chunkLatents.length - chunkDecodedFrames
      let decodeSize = 0
      if (shouldStop) decodeSize = pending
      else if (isFirstAudioChunk && pending >= firstChunkFrames) decodeSize = firstChunkFrames
      else if (pending >= normalChunkFrames) decodeSize = normalChunkFrames

      if (decodeSize > 0) {
        const decodeLatents = new Float32Array(decodeSize * latentDim)
        for (let f = 0; f < decodeSize; f++) decodeLatents.set(chunkLatents[chunkDecodedFrames + f], f * latentDim)
        const decodeResult = await mimiDecoder.run({
          latent: createTensor('float32', decodeLatents, [1, decodeSize, latentDim]),
          ...mimiState,
        })
        for (const entry of meta.mimi_state_manifest) mimiState[entry.input_name] = decodeResult[entry.output_name]
        chunkDecodedFrames += decodeSize
        audioParts.push(new Float32Array(decodeResult[mimiDecoder.outputNames[0]].data as Float32Array))
        isFirstAudioChunk = false
      }

      if (shouldStop) break
    }

    onSynth(chunkIdx + 1, chunks.length)

    // Silence gap between sentences (but not after the last).
    if (chunkIdx < chunks.length - 1) {
      audioParts.push(new Float32Array(Math.max(1, Math.floor(CHUNK_GAP_SEC * sampleRate))))
    }
  }

  return mergeFloat32(audioParts)
}

// ---------------------------------------------------------------------------
// message protocol (matches src/lib/tts.ts): generate → progress* → result | error
// ---------------------------------------------------------------------------

type InMsg = { type: 'generate'; id: number; text: string; voice: string }

ctx.onmessage = async (e: MessageEvent<InMsg>) => {
  const msg = e.data
  if (msg.type !== 'generate') return
  const { id, text, voice } = msg
  try {
    if (!text.trim()) throw new Error('Nothing to say — enter some text first.')
    await ensureLoaded(id)
    const samples = await generate(text, voice, (done, total) => {
      ctx.postMessage({ type: 'progress', id, phase: 'synth', done, total })
    })
    const wav = encodeWav(samples, sampleRate)
    const duration = samples.length / sampleRate
    ctx.postMessage({ type: 'result', id, wav, duration, sampleRate }, [wav])
  } catch (err) {
    ctx.postMessage({ type: 'error', id, message: err instanceof Error ? err.message : String(err) })
  }
}

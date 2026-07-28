import type { TimelineObject, ArrowData, TextData, FreehandData, PhotoData, VideoData, ObjectStyle, CameraState, ResolvedEffect, VignetteParams, ChromaticParams, LightLeakParams } from '../types'
import {
  drawArrow,
  drawText,
  drawRectangle,
  drawCircle,
  drawFreehand,
} from './annotations'
import { resolveRenderPose } from './keyframes'
import { isIdentityCamera } from './camera'
import { effectsToFilterString } from './effects'
import { applyShaderEffects, isShaderEffect } from './glEffects'
import { clamp01 } from './easing'

export type EditorOptions = {
  editorMode?: boolean
  activeDrawingObjectId?: string | null
  camera?: CameraState   // spec 13: applied as a global transform around the object loop
  effects?: ResolvedEffect[]  // spec 23: render-wide colour/overlay post-process applied after the object loop
}

const GHOST_ALPHA = 0.25

/**
 * Render a single frame at the given global time.
 * Composites all visible objects sorted by lane (lowest = background).
 */
export function renderFrame(
  ctx: CanvasRenderingContext2D,
  objects: TimelineObject[],
  globalTime: number,
  options: { width: number; height: number },
  imageCache: Map<string, HTMLImageElement | HTMLVideoElement | ImageBitmap | VideoFrame | OffscreenCanvas>,
  editorOptions?: EditorOptions,
) {
  const { width: w, height: h } = options
  const editorMode = editorOptions?.editorMode ?? false
  const activeDrawingObjectId = editorOptions?.activeDrawingObjectId ?? null
  const camera = editorOptions?.camera

  // Black background (drawn un-zoomed so the letterbox stays black under any camera)
  ctx.fillStyle = '#000000'
  ctx.fillRect(0, 0, w, h)

  // Filter to visible objects and sort by lane ascending (low = back).
  // `!obj.hidden` (spec 14 R11): hidden objects stay in the project/timeline but are
  // skipped in every render path — this single filter covers preview AND export.
  const visible = objects
    .filter((obj) => !obj.hidden && globalTime >= obj.startTime && globalTime < obj.startTime + obj.duration)
    .sort((a, b) => a.lane - b.lane)

  // Camera transform (spec 13): a translate/scale applied PER OBJECT (not once around the whole
  // loop) so an object can opt out via `ignoreCamera` and stay pinned to the full frame while its
  // neighbors zoom — and lane/z-order is still preserved because we walk the sorted list once.
  // Composes over every object for free since object coords are normalized 0–1. Absent or identity
  // camera => no transform => pixel-identical to pre-spec-13 output (R3/R11).
  const cam = camera != null && !isIdentityCamera(camera) ? camera : null

  for (const rawObj of visible) {
    const elapsed = globalTime - rawObj.startTime
    const progress = rawObj.animateIn > 0
      ? Math.min(1, elapsed / rawObj.animateIn)
      : 1

    // Resolve keyframes + enter/exit transitions (identity when the object has neither)
    const obj = resolveRenderPose(rawObj, globalTime)

    ctx.save()
    if (cam && !rawObj.ignoreCamera) {
      ctx.translate(w / 2, h / 2)
      ctx.scale(cam.scale, cam.scale)
      ctx.translate(-cam.x * w, -cam.y * h)
    }

    // Active drawing object: full opacity, no ghost
    if (activeDrawingObjectId === obj.id) {
      drawObject(ctx, obj, 1.0, w, h, imageCache, elapsed)
    } else if (editorMode && progress < 1 && obj.type !== 'photo') {
      // Ghost preview: two-pass rendering for editor mode.
      // Pass 1: ghost of full shape at reduced opacity
      const ghostStyle = { ...obj.style, opacity: obj.style.opacity * GHOST_ALPHA }
      drawObject(ctx, obj, 1.0, w, h, imageCache, elapsed, ghostStyle)
      // Pass 2: animated portion at full opacity
      drawObject(ctx, obj, progress, w, h, imageCache, elapsed)
    } else {
      drawObject(ctx, obj, progress, w, h, imageCache, elapsed)
    }

    ctx.restore()
  }

  // Render-wide effects (spec 23): a full-frame post-process applied AFTER the object loop, so it
  // grades the entire composited frame (camera zoom already baked in). Two branches, in order:
  //   (a) colour-grade filters → one ctx.filter string, applied via a self-composited redraw
  //   (b) overlay effects (vignette) → drawn on top with the filter reset
  // No active effects ⇒ this whole block is skipped ⇒ output is pixel-identical to pre-spec-23.
  const fx = editorOptions?.effects
  if (fx && fx.length > 0) {
    // (a) colour-grade branch — all CSS-filter kinds batched into one self-composited redraw.
    const filter = effectsToFilterString(fx, globalTime)
    if (filter) {
      ctx.save()
      ctx.filter = filter
      ctx.globalCompositeOperation = 'copy' // replace pixels 1:1 (no double-exposure)
      ctx.drawImage(ctx.canvas, 0, 0)       // re-draw the frame through the filter
      ctx.restore()
    }
    // (b) overlay branch — drawn on top of the graded frame (with the filter reset)
    for (const e of fx) {
      if (e.kind === 'vignette' && e.vignette) {
        ctx.save()
        ctx.filter = 'none' // don't let (a)'s filter leak onto the overlay
        drawVignette(ctx, w, h, e.intensity, e.vignette)
        ctx.restore()
      } else if (e.kind === 'grain') {
        ctx.save()
        ctx.filter = 'none'
        drawGrain(ctx, w, h, e.intensity, globalTime)
        ctx.restore()
      } else if (e.kind === 'oldfilm') {
        ctx.save()
        ctx.filter = 'none'
        drawOldFilm(ctx, w, h, e.intensity, e.oldfilm?.wobble ?? 0, globalTime)
        ctx.restore()
      } else if (e.kind === 'chromatic' && e.chromatic) {
        ctx.save()
        ctx.filter = 'none'
        drawChromatic(ctx, w, h, e.intensity, e.chromatic)
        ctx.restore()
      } else if (e.kind === 'pixelate') {
        ctx.save()
        ctx.filter = 'none'
        drawPixelate(ctx, w, h, e.intensity)
        ctx.restore()
      } else if (e.kind === 'lightleak' && e.lightleak) {
        ctx.save()
        ctx.filter = 'none'
        drawLightLeak(ctx, w, h, e.intensity, e.lightleak, globalTime)
        ctx.restore()
      }
    }
    // (c) WebGL shader branch (spec 25) — per-pixel effects run as GPU fragment passes over the
    // already-composited + 2D-graded frame, then the result is drawn back onto the 2D canvas. No
    // getImageData readback. Runs after (a)+(b) (hybrid, decision D1). If WebGL is unavailable/lost,
    // applyShaderEffects returns null and we leave the 2D frame untouched (graceful fallback).
    const shaderFx = fx.filter((e) => isShaderEffect(e.kind))
    if (shaderFx.length > 0) {
      const glCanvas = applyShaderEffects(ctx.canvas, shaderFx, globalTime, { width: w, height: h })
      if (glCanvas) {
        ctx.save()
        ctx.filter = 'none'
        ctx.globalCompositeOperation = 'copy'
        ctx.drawImage(glCanvas as CanvasImageSource, 0, 0)
        ctx.restore()
      }
    }
  }
}

/**
 * Draw a vignette overlay (spec 23): a black darkening that's transparent through a central shape
 * and opaque toward the frame edges, composited on top of the (already graded) frame with source-over.
 * `intensity` = peak black alpha; `size` = clear-region extent (0–1); `feather` = fade softness (0–1).
 * All lengths derive from w/h, so it scales with project dims and is identical in preview and export.
 */
function drawVignette(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  intensity: number,
  params: VignetteParams,
) {
  const alpha = clamp01(intensity)
  if (alpha <= 0) return
  const s = clamp01(params.size)
  const f = clamp01(params.feather)

  if (params.shape === 'circle') {
    // Radial gradient: clear out to size·maxR, fading to full black by (size+feather)·maxR; beyond
    // the outer stop the gradient holds its last colour (black), so the corners darken fully.
    const cx = w / 2
    const cy = h / 2
    const maxR = 0.5 * Math.hypot(w, h)
    const innerR = s * maxR
    const outerR = Math.min(maxR, innerR + Math.max(f * maxR, 1))
    const grad = ctx.createRadialGradient(cx, cy, innerR, cx, cy, Math.max(outerR, innerR + 1))
    grad.addColorStop(0, 'rgba(0,0,0,0)')
    grad.addColorStop(1, `rgba(0,0,0,${alpha})`)
    ctx.fillStyle = grad
    ctx.fillRect(0, 0, w, h)
    return
  }

  // rectangle ("screen size"): a feathered dark border around a clear inner rect matching the frame
  // aspect. Fill the border-ring (outer expanded rect minus inner clear rect, evenodd) and blur it so
  // the inner edge feathers; the outer rect is padded beyond the canvas so the blur keeps the frame
  // edge fully dark.
  const blurPx = f * 0.35 * Math.min(w, h)
  const innerW = s * w
  const innerH = s * h
  const ix = (w - innerW) / 2
  const iy = (h - innerH) / 2
  const pad = blurPx * 3 + 2
  ctx.filter = blurPx > 0.01 ? `blur(${blurPx}px)` : 'none'
  ctx.fillStyle = `rgba(0,0,0,${alpha})`
  ctx.beginPath()
  ctx.rect(-pad, -pad, w + pad * 2, h + pad * 2) // outer (expanded beyond canvas)
  ctx.rect(ix, iy, innerW, innerH)               // inner clear region (evenodd hole)
  ctx.fill('evenodd')
}

// === Film grain (spec 23, first time-animated effect) ===
// A cached monochrome-noise tile is composited over the frame with an 'overlay' blend; each frame it
// shifts by a per-frame offset derived DETERMINISTICALLY from the time, so the grain animates and
// preview + export match at the same instant. SVG feTurbulence would need async rasterization and
// doesn't run in the OffscreenCanvas export worker, so we synthesize the noise on a canvas instead.

const GRAIN_TILE = 128       // px; a repeating noise tile
const GRAIN_FPS = 24         // grain updates ~24×/sec (film-like), independent of render fps
const GRAIN_MAX_ALPHA = 0.55 // cap so intensity=1 stays tasteful

let grainTile: OffscreenCanvas | HTMLCanvasElement | null = null

/** Deterministic 32-bit hash of an integer (for per-frame grain offsets). */
function hashInt(n: number): number {
  let t = (n ^ 0x9e3779b9) >>> 0
  t = Math.imul(t ^ (t >>> 15), 1 | t)
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
  return (t ^ (t >>> 14)) >>> 0
}

/** Build (once) and cache a GRAIN_TILE² monochrome-noise tile. Seeded, so it's stable across renders. */
function getGrainTile(): OffscreenCanvas | HTMLCanvasElement | null {
  if (grainTile) return grainTile
  const canvas: OffscreenCanvas | HTMLCanvasElement =
    typeof OffscreenCanvas !== 'undefined'
      ? new OffscreenCanvas(GRAIN_TILE, GRAIN_TILE)
      : Object.assign(document.createElement('canvas'), { width: GRAIN_TILE, height: GRAIN_TILE })
  const g = canvas.getContext('2d') as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null
  if (!g) return null
  const img = g.createImageData(GRAIN_TILE, GRAIN_TILE)
  let seed = 0x1a2b3c4d
  const rnd = () => {
    // mulberry32 — a tiny seeded PRNG so the tile is identical in preview and export contexts.
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  for (let i = 0; i < img.data.length; i += 4) {
    const v = Math.max(0, Math.min(255, 128 + (rnd() - 0.5) * 190)) // grey centred at mid, moderate spread
    img.data[i] = v
    img.data[i + 1] = v
    img.data[i + 2] = v
    img.data[i + 3] = 255
  }
  g.putImageData(img, 0, 0)
  grainTile = canvas
  return canvas
}

/**
 * Draw animated film grain (spec 23): tile the cached noise across the frame with an 'overlay' blend,
 * shifted by a time-derived offset so it moves. `intensity` scales the opacity; `time` (global
 * seconds) picks the per-frame offset, quantized to GRAIN_FPS so it steps like real film grain.
 */
function drawGrain(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  intensity: number,
  time: number,
) {
  const alpha = clamp01(intensity)
  if (alpha <= 0) return
  const tile = getGrainTile()
  if (!tile) return
  const pattern = ctx.createPattern(tile, 'repeat')
  if (!pattern) return

  const frame = Math.floor(time * GRAIN_FPS)
  const ox = hashInt(frame) % GRAIN_TILE
  const oy = hashInt(frame + 9973) % GRAIN_TILE

  ctx.globalCompositeOperation = 'overlay'
  ctx.globalAlpha = alpha * GRAIN_MAX_ALPHA
  ctx.fillStyle = pattern
  ctx.translate(ox, oy)
  // Fill a rect padded by a full tile on every side so the offset never leaves a gap.
  ctx.fillRect(-ox - GRAIN_TILE, -oy - GRAIN_TILE, w + GRAIN_TILE * 2, h + GRAIN_TILE * 2)
}

// === Old-film damage (spec 23, second time-animated effect) ===
// Procedural vintage-projector artifacts drawn per frame, seeded DETERMINISTICALLY by the frame index
// so preview + export match: gate-weave jitter (the whole frame hops a few px), vertical scratch
// lines that flicker/drift, dust & specks, the odd hair, and a subtle exposure flicker. Compose with
// a vignette + sepia for an "old cowboy film" look.

const OLDFILM_FPS = 24
let scratchCanvas: OffscreenCanvas | HTMLCanvasElement | null = null

/** A seeded mulberry32 PRNG — stable within a frame, varies across frames (deterministic per time). */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** A frame-sized scratch canvas (for the gate-weave copy), reallocated only when the size changes. */
function getScratchCanvas(w: number, h: number): OffscreenCanvas | HTMLCanvasElement | null {
  if (!scratchCanvas || scratchCanvas.width !== w || scratchCanvas.height !== h) {
    scratchCanvas =
      typeof OffscreenCanvas !== 'undefined'
        ? new OffscreenCanvas(w, h)
        : Object.assign(document.createElement('canvas'), { width: w, height: h })
    scratchCanvas.width = w
    scratchCanvas.height = h
  }
  return scratchCanvas
}

function drawOldFilm(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  intensity: number,
  wobble: number,
  time: number,
) {
  const amt = clamp01(intensity)
  const wob = clamp01(wobble)
  if (amt <= 0 && wob <= 0) return
  const frame = Math.floor(time * OLDFILM_FPS)
  const rand = mulberry32(hashInt(frame) || 1)
  const minDim = Math.min(w, h)

  // 1) Gate weave / jitter: hop the whole frame a few px (more vertical than horizontal), filling the
  //    revealed edge black like a mis-registered film gate. Driven by `wobble` (NOT intensity), so
  //    grain strength and frame steadiness are independent. Uses a scratch copy so the image moves
  //    cleanly instead of ghosting.
  const r1 = rand()
  const r2 = rand() // always consume both so toggling wobble doesn't reshuffle the dust/scratches below
  const jAmp = wob * 14
  const jx = jAmp > 0 ? Math.round((r1 - 0.5) * jAmp) : 0
  const jy = jAmp > 0 ? Math.round((r2 - 0.5) * jAmp * 1.6) : 0
  if (jx !== 0 || jy !== 0) {
    const scratch = getScratchCanvas(w, h)
    const sctx = scratch?.getContext('2d') as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null
    if (sctx) {
      sctx.clearRect(0, 0, w, h)
      sctx.drawImage(ctx.canvas, 0, 0)
      ctx.fillStyle = '#000'
      ctx.fillRect(0, 0, w, h)
      ctx.drawImage(scratch as CanvasImageSource, jx, jy)
    }
  }

  ctx.globalCompositeOperation = 'source-over'

  // 2) Exposure flicker: a faint whole-frame darken/brighten that changes each frame.
  const flick = (rand() - 0.5) * 0.18 * amt
  if (flick !== 0) {
    ctx.fillStyle = flick < 0 ? `rgba(0,0,0,${-flick})` : `rgba(255,255,255,${flick})`
    ctx.fillRect(0, 0, w, h)
  }

  // 3) Vertical scratch lines — mostly bright, occasionally dark; flicker in count each frame.
  const scratches = Math.round(rand() * (1 + amt * 4))
  for (let i = 0; i < scratches; i++) {
    const x = Math.round(rand() * w)
    const lineW = rand() < 0.8 ? 1 : 2
    const a = 0.25 + rand() * 0.5
    const bright = rand() < 0.85
    ctx.fillStyle = bright ? `rgba(255,255,255,${a})` : `rgba(0,0,0,${a})`
    // Some scratches don't span the full height (partial vertical run).
    const top = rand() < 0.7 ? 0 : rand() * h * 0.5
    const bottom = rand() < 0.7 ? h : h - rand() * h * 0.5
    ctx.fillRect(x, top, lineW, Math.max(1, bottom - top))
  }

  // 4) Dust & specks — density scales with area and intensity; mostly tiny, some larger blotches.
  const specks = Math.round((w * h / 28000) * amt * (0.5 + rand()))
  for (let i = 0; i < specks; i++) {
    const x = rand() * w
    const y = rand() * h
    const r = rand() < 0.9 ? 0.6 + rand() * 1.6 : 2 + rand() * 3
    const bright = rand() < 0.6
    const a = 0.3 + rand() * 0.6
    ctx.fillStyle = bright ? `rgba(255,255,255,${a})` : `rgba(0,0,0,${a})`
    ctx.beginPath()
    ctx.arc(x, y, r, 0, Math.PI * 2)
    ctx.fill()
  }

  // 5) Occasional "hair" — a thin dark squiggle caught in the gate.
  if (rand() < 0.12 * (0.5 + amt)) {
    const hx = rand() * w
    const hy = rand() * h
    const len = minDim * (0.05 + rand() * 0.15)
    ctx.strokeStyle = `rgba(0,0,0,${0.4 + rand() * 0.4})`
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.moveTo(hx, hy)
    ctx.bezierCurveTo(
      hx + (rand() - 0.5) * len, hy + len * 0.4,
      hx + (rand() - 0.5) * len, hy + len * 0.7,
      hx + (rand() - 0.5) * len, hy + len,
    )
    ctx.stroke()
  }
}

// === spec 24 overlay effects ===

type AnyCanvas = OffscreenCanvas | HTMLCanvasElement
type AnyCtx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D

function makeCanvas(w: number, h: number): AnyCanvas {
  return typeof OffscreenCanvas !== 'undefined'
    ? new OffscreenCanvas(w, h)
    : Object.assign(document.createElement('canvas'), { width: w, height: h })
}

// Dedicated scratch canvases for the chromatic split (it holds a frame snapshot while building three
// channel-tinted copies, so it needs two buffers that don't clash with the shared oldfilm scratch).
let chromaSnap: AnyCanvas | null = null
let chromaTint: AnyCanvas | null = null
function getChromaCanvases(w: number, h: number): { snap: AnyCanvas; tint: AnyCanvas } | null {
  if (!chromaSnap || chromaSnap.width !== w || chromaSnap.height !== h) {
    chromaSnap = makeCanvas(w, h); chromaSnap.width = w; chromaSnap.height = h
  }
  if (!chromaTint || chromaTint.width !== w || chromaTint.height !== h) {
    chromaTint = makeCanvas(w, h); chromaTint.width = w; chromaTint.height = h
  }
  return { snap: chromaSnap, tint: chromaTint }
}

/** Parse a #rgb / #rrggbb hex into [r,g,b] (defaults to white on a bad value). */
function hexToRgb(hex: string): [number, number, number] {
  let h = hex.replace('#', '').trim()
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2]
  const n = parseInt(h, 16)
  if (h.length !== 6 || Number.isNaN(n)) return [255, 255, 255]
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

/**
 * RGB channel split / chromatic aberration (spec 24). Draws the frame three times — one per colour
 * channel, isolated via a `multiply` tint and offset along `angle` — then recombines them with the
 * `lighter` (additive) blend, so the red/blue fringes pull apart. Pure blend-mode work, no per-pixel.
 */
function drawChromatic(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  intensity: number,
  params: ChromaticParams,
) {
  const offset = params.offset * clamp01(intensity)
  if (offset < 0.5) return
  const rad = (params.angle * Math.PI) / 180
  const dx = Math.cos(rad) * offset
  const dy = Math.sin(rad) * offset

  const bufs = getChromaCanvases(w, h)
  if (!bufs) return
  const snapCtx = bufs.snap.getContext('2d') as AnyCtx | null
  const tintCtx = bufs.tint.getContext('2d') as AnyCtx | null
  if (!snapCtx || !tintCtx) return

  // Snapshot the current frame.
  snapCtx.globalCompositeOperation = 'source-over'
  snapCtx.clearRect(0, 0, w, h)
  snapCtx.drawImage(ctx.canvas, 0, 0)

  // Reset the main canvas to black, then additively add each isolated, offset channel.
  ctx.fillStyle = '#000'
  ctx.fillRect(0, 0, w, h)
  ctx.globalCompositeOperation = 'lighter'

  const channels: Array<{ tint: string; ox: number; oy: number }> = [
    { tint: '#ff0000', ox: dx, oy: dy },   // red pulls one way
    { tint: '#00ff00', ox: 0, oy: 0 },     // green stays centred
    { tint: '#0000ff', ox: -dx, oy: -dy }, // blue pulls the other
  ]
  for (const ch of channels) {
    // Isolate the channel: draw the snapshot, then multiply by a pure-channel fill.
    tintCtx.globalCompositeOperation = 'source-over'
    tintCtx.clearRect(0, 0, w, h)
    tintCtx.drawImage(bufs.snap, 0, 0)
    tintCtx.globalCompositeOperation = 'multiply'
    tintCtx.fillStyle = ch.tint
    tintCtx.fillRect(0, 0, w, h)
    ctx.drawImage(bufs.tint as CanvasImageSource, ch.ox, ch.oy)
  }
}

/**
 * Pixelate (spec 24): downscale the frame to a small buffer then draw it back up with smoothing off,
 * so pixels grow into blocks. Cell size grows with intensity (fine → chunky). No per-pixel scan.
 */
function drawPixelate(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  intensity: number,
) {
  const MAX_CELL = 64
  const cell = 1 + clamp01(intensity) * MAX_CELL
  if (cell <= 1.5) return
  const sw = Math.max(1, Math.round(w / cell))
  const sh = Math.max(1, Math.round(h / cell))
  const scratch = getScratchCanvas(w, h)
  const sctx = scratch?.getContext('2d') as AnyCtx | null
  if (!sctx) return
  sctx.globalCompositeOperation = 'source-over'
  sctx.imageSmoothingEnabled = false
  sctx.clearRect(0, 0, w, h)
  sctx.drawImage(ctx.canvas, 0, 0, w, h, 0, 0, sw, sh) // downscale into the top-left
  ctx.imageSmoothingEnabled = false
  ctx.globalCompositeOperation = 'copy'
  ctx.drawImage(scratch as CanvasImageSource, 0, 0, sw, sh, 0, 0, w, h) // upscale back over the frame
}

/**
 * Light leak (spec 24): a drifting coloured glow composited in `screen` blend, like light bleeding
 * onto the film. The glow centre drifts on a looping path driven by `globalTime` (deterministic ⇒
 * preview == export). `intensity` scales the whole overlay's opacity so it fades with the envelope.
 */
function drawLightLeak(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  intensity: number,
  params: LightLeakParams,
  time: number,
) {
  const a = clamp01(intensity)
  if (a <= 0) return
  const [r, g, b] = hexToRgb(params.color)
  const rad = (params.angle * Math.PI) / 180
  const t = time * params.speed
  // Drifting centre — a slow looping path across the frame, phase-shifted by the leak angle.
  const cx = w * (0.5 + 0.45 * Math.sin(t * Math.PI * 2))
  const cy = h * (0.5 + 0.45 * Math.cos(t * Math.PI * 2 * 0.6 + rad))
  const R = Math.hypot(w, h) * 0.55
  const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, R)
  grad.addColorStop(0, `rgba(${r},${g},${b},0.9)`)
  grad.addColorStop(0.5, `rgba(${r},${g},${b},0.35)`)
  grad.addColorStop(1, `rgba(${r},${g},${b},0)`)
  ctx.globalCompositeOperation = 'screen'
  ctx.globalAlpha = a
  ctx.fillStyle = grad
  ctx.fillRect(0, 0, w, h)
}

function drawObject(
  ctx: CanvasRenderingContext2D,
  obj: TimelineObject,
  progress: number,
  w: number,
  h: number,
  imageCache: Map<string, HTMLImageElement | HTMLVideoElement | ImageBitmap | VideoFrame | OffscreenCanvas>,
  time: number,   // clip-relative seconds (globalTime - startTime); only drawText uses it (spec 19)
  styleOverride?: ObjectStyle,
) {
  const style = styleOverride ?? obj.style
  // Compute bounding box in pixel space
  const bx = obj.x * w
  const by = obj.y * h
  const bw = obj.width * w
  const bh = obj.height * h
  const cx = bx + bw / 2
  const cy = by + bh / 2

  // Scale factor for lineWidth/fontSize: based on canvas resolution (not object bbox)
  // so that all objects at the same lineWidth render at the same visual thickness
  const REF_AREA = 1920 * 1080
  const scaleFactor = Math.sqrt((w * h) / REF_AREA)

  ctx.save()

  // Apply rotation around bounding box center
  if (obj.rotation !== 0) {
    ctx.translate(cx, cy)
    ctx.rotate(obj.rotation)
    ctx.translate(-cx, -cy)
  }

  switch (obj.type) {
    case 'photo': {
      const data = obj.data as PhotoData
      // Animated images (spec 28) write their current frame under the OBJECT id, so two
      // clips of the same GIF can sit at different points in the animation — exactly the
      // keying `case 'video'` uses below. Stills are only ever cached by asset id, so
      // they fall through to the same lookup as before.
      const img = imageCache.get(obj.id) ?? imageCache.get(data.assetId)
      if (img) {
        ctx.globalAlpha = style.opacity * progress
        drawImageCover(ctx, img, bx, by, bw, bh)
      }
      break
    }
    case 'arrow':
      drawArrow(ctx, obj.data as ArrowData, style, progress, bx, by, bw, bh, scaleFactor)
      break
    case 'text':
      drawText(ctx, obj.data as TextData, style, progress, bx, by, bw, bh, scaleFactor, time)
      break
    case 'rectangle':
      drawRectangle(ctx, style, progress, bx, by, bw, bh, scaleFactor)
      break
    case 'circle':
      drawCircle(ctx, style, progress, bx, by, bw, bh, scaleFactor)
      break
    case 'freehand':
      drawFreehand(ctx, obj.data as FreehandData, style, progress, bx, by, bw, bh, scaleFactor)
      break
    case 'video': {
      const vdata = obj.data as VideoData
      // Export keys decoded frames per object id (per-object decoders); preview
      // keys HTMLVideoElements by asset id. Prefer object id, fall back to asset id.
      const videoEl = imageCache.get(obj.id) ?? imageCache.get(vdata.assetId)
      if (videoEl) {
        ctx.globalAlpha = style.opacity * progress
        drawImageCover(ctx, videoEl, bx, by, bw, bh)
      }
      break
    }
    case 'audio':
      // Audio has no visual representation on canvas
      break
  }

  ctx.restore()
}

/**
 * Draw image with object-fit: cover behaviour into a target rectangle.
 */
function drawImageCover(
  ctx: CanvasRenderingContext2D,
  img: HTMLImageElement | HTMLVideoElement | ImageBitmap | VideoFrame | OffscreenCanvas,
  dx: number,
  dy: number,
  dw: number,
  dh: number,
) {
  // Use duck-typing for DOM types so this works in Web Workers too
  const imgW = img instanceof VideoFrame ? img.displayWidth
    : 'videoWidth' in img ? (img as HTMLVideoElement).videoWidth
    : img.width
  const imgH = img instanceof VideoFrame ? img.displayHeight
    : 'videoHeight' in img ? (img as HTMLVideoElement).videoHeight
    : img.height
  if (imgW === 0 || imgH === 0) return
  const imgRatio = imgW / imgH
  const targetRatio = dw / dh

  let sx = 0, sy = 0, sw = imgW, sh = imgH

  if (imgRatio > targetRatio) {
    sw = imgH * targetRatio
    sx = (imgW - sw) / 2
  } else {
    sh = imgW / targetRatio
    sy = (imgH - sh) / 2
  }

  ctx.drawImage(img, sx, sy, sw, sh, dx, dy, dw, dh)
}

export async function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = reject
    img.src = src
  })
}

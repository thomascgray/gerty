import type { ArrowData, TextData, FreehandData, ObjectStyle, TextEffect } from '../types'

/** Compute the quadratic bezier control point for a segment with curvature */
function segmentControlPoint(
  ax: number, ay: number, bxx: number, by: number, curvature: number,
): { x: number; y: number } {
  const mx = (ax + bxx) / 2
  const my = (ay + by) / 2
  const dx = bxx - ax
  const dy = by - ay
  const len = Math.sqrt(dx * dx + dy * dy)
  if (len === 0) return { x: mx, y: my }
  // Perpendicular (rotated 90° clockwise = right of travel direction)
  const px = dy / len
  const py = -dx / len
  const offset = curvature * len * 0.5
  return { x: mx + px * offset, y: my + py * offset }
}

/** Approximate length of a quadratic bezier by sampling */
function quadBezierLength(
  ax: number, ay: number, cpx: number, cpy: number, bx: number, by: number,
): number {
  const STEPS = 16
  let length = 0
  let prevX = ax, prevY = ay
  for (let i = 1; i <= STEPS; i++) {
    const t = i / STEPS
    const u = 1 - t
    const x = u * u * ax + 2 * u * t * cpx + t * t * bx
    const y = u * u * ay + 2 * u * t * cpy + t * t * by
    const dx = x - prevX, dy = y - prevY
    length += Math.sqrt(dx * dx + dy * dy)
    prevX = x
    prevY = y
  }
  return length
}

/** Evaluate a point on a quadratic bezier at parameter t */
function quadBezierAt(
  ax: number, ay: number, cpx: number, cpy: number, bx: number, by: number, t: number,
): { x: number; y: number } {
  const u = 1 - t
  return {
    x: u * u * ax + 2 * u * t * cpx + t * t * bx,
    y: u * u * ay + 2 * u * t * cpy + t * t * by,
  }
}

/** Tangent angle of a quadratic bezier at parameter t */
function quadBezierAngleAt(
  ax: number, ay: number, cpx: number, cpy: number, bx: number, by: number, t: number,
): number {
  const u = 1 - t
  // Derivative: 2(1-t)(CP-A) + 2t(B-CP)
  const tx = 2 * u * (cpx - ax) + 2 * t * (bx - cpx)
  const ty = 2 * u * (cpy - ay) + 2 * t * (by - cpy)
  return Math.atan2(ty, tx)
}

export function drawArrow(
  ctx: CanvasRenderingContext2D,
  data: ArrowData,
  style: ObjectStyle,
  progress: number,
  bx: number,
  by: number,
  bw: number,
  bh: number,
  scaleFactor: number,
) {
  const points = data.points.map((p) => ({ x: bx + p.x * bw, y: by + p.y * bh }))
  if (points.length < 2) return

  const curvature = data.curvature ?? 0

  ctx.save()
  ctx.strokeStyle = style.color
  ctx.lineWidth = style.lineWidth * scaleFactor
  ctx.globalAlpha = style.opacity
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'

  // Build segments with control points and lengths
  const segments: { ax: number; ay: number; cpx: number; cpy: number; bxx: number; by: number; len: number }[] = []
  let totalLength = 0
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1], b = points[i]
    if (curvature !== 0) {
      const cp = segmentControlPoint(a.x, a.y, b.x, b.y, curvature)
      const len = quadBezierLength(a.x, a.y, cp.x, cp.y, b.x, b.y)
      segments.push({ ax: a.x, ay: a.y, cpx: cp.x, cpy: cp.y, bxx: b.x, by: b.y, len })
      totalLength += len
    } else {
      const dx = b.x - a.x, dy = b.y - a.y
      const len = Math.sqrt(dx * dx + dy * dy)
      segments.push({ ax: a.x, ay: a.y, cpx: 0, cpy: 0, bxx: b.x, by: b.y, len })
      totalLength += len
    }
  }

  const drawLength = totalLength * progress

  // Draw path up to drawLength
  ctx.beginPath()
  ctx.moveTo(points[0].x, points[0].y)

  let accumulated = 0
  let endPoint = points[0]
  let endAngle = 0

  for (const seg of segments) {
    if (accumulated + seg.len <= drawLength) {
      if (curvature !== 0) {
        ctx.quadraticCurveTo(seg.cpx, seg.cpy, seg.bxx, seg.by)
        endAngle = quadBezierAngleAt(seg.ax, seg.ay, seg.cpx, seg.cpy, seg.bxx, seg.by, 1)
      } else {
        ctx.lineTo(seg.bxx, seg.by)
        endAngle = Math.atan2(seg.by - seg.ay, seg.bxx - seg.ax)
      }
      accumulated += seg.len
      endPoint = { x: seg.bxx, y: seg.by }
    } else {
      const remaining = drawLength - accumulated
      const t = seg.len > 0 ? remaining / seg.len : 0
      if (curvature !== 0) {
        // Split bezier at t and draw the first portion
        // De Casteljau split: draw up to parameter t
        const pt = quadBezierAt(seg.ax, seg.ay, seg.cpx, seg.cpy, seg.bxx, seg.by, t)
        // Control point for the first half: lerp(A, CP, t)
        const cp1x = seg.ax + (seg.cpx - seg.ax) * t
        const cp1y = seg.ay + (seg.cpy - seg.ay) * t
        ctx.quadraticCurveTo(cp1x, cp1y, pt.x, pt.y)
        endPoint = pt
        endAngle = quadBezierAngleAt(seg.ax, seg.ay, seg.cpx, seg.cpy, seg.bxx, seg.by, t)
      } else {
        const x = seg.ax + (seg.bxx - seg.ax) * t
        const y = seg.ay + (seg.by - seg.ay) * t
        ctx.lineTo(x, y)
        endPoint = { x, y }
        endAngle = Math.atan2(seg.by - seg.ay, seg.bxx - seg.ax)
      }
      break
    }
  }

  ctx.stroke()

  // Draw arrowhead
  const showHead = data.progressiveHead ? progress > 0 : progress > 0.95
  if (showHead) {
    const headSize = data.headSize * (style.lineWidth * scaleFactor / 4)
    ctx.beginPath()
    ctx.moveTo(endPoint.x, endPoint.y)
    ctx.lineTo(
      endPoint.x - headSize * Math.cos(endAngle - Math.PI / 6),
      endPoint.y - headSize * Math.sin(endAngle - Math.PI / 6),
    )
    ctx.moveTo(endPoint.x, endPoint.y)
    ctx.lineTo(
      endPoint.x - headSize * Math.cos(endAngle + Math.PI / 6),
      endPoint.y - headSize * Math.sin(endAngle + Math.PI / 6),
    )
    ctx.stroke()
  }

  ctx.restore()
}

/** Export curve helpers for use in overlay drawing */
export { segmentControlPoint, quadBezierAt }

const TEXT_LINE_RATIO = 1.25
const FIT_MIN_PX = 6
const FIT_MAX_PX = 400

type WrappedLine = { text: string; paragraphEnd: boolean }

/**
 * Greedy word-wrap `content` (honoring explicit \n) to `maxWidth` at the ctx's CURRENT font.
 * `paragraphEnd` marks the last visual line of each \n-delimited paragraph (used to skip
 * justifying a paragraph's final line). A single word wider than maxWidth is left to overflow.
 */
function wrapText(ctx: CanvasRenderingContext2D, content: string, maxWidth: number): WrappedLine[] {
  const out: WrappedLine[] = []
  for (const para of content.split('\n')) {
    const words = para.split(' ')
    let line = ''
    for (const word of words) {
      const candidate = line === '' ? word : `${line} ${word}`
      if (line !== '' && ctx.measureText(candidate).width > maxWidth) {
        out.push({ text: line, paragraphEnd: false })
        line = word
      } else {
        line = candidate
      }
    }
    out.push({ text: line, paragraphEnd: true })
  }
  return out
}

/**
 * Find the largest font size (px) whose wrapped layout fits within maxW × maxH, then return that
 * size and its wrapped lines. Binary search over integer sizes — ~9 iterations.
 */
export function fitText(
  ctx: CanvasRenderingContext2D,
  content: string,
  fontOf: (size: number) => string,
  maxW: number,
  maxH: number,
): { fontSize: number; lines: WrappedLine[] } {
  const fits = (size: number): boolean => {
    ctx.font = fontOf(size)
    const lines = wrapText(ctx, content, maxW)
    let widest = 0
    for (const l of lines) widest = Math.max(widest, ctx.measureText(l.text).width)
    return widest <= maxW && lines.length * size * TEXT_LINE_RATIO <= maxH
  }
  let lo = FIT_MIN_PX
  const hi0 = FIT_MAX_PX
  if (!fits(lo)) {
    ctx.font = fontOf(lo)
    return { fontSize: lo, lines: wrapText(ctx, content, maxW) }
  }
  let hi = hi0
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2)
    if (fits(mid)) lo = mid
    else hi = mid - 1
  }
  ctx.font = fontOf(lo)
  return { fontSize: lo, lines: wrapText(ctx, content, maxW) }
}

export function drawText(
  ctx: CanvasRenderingContext2D,
  data: TextData,
  style: ObjectStyle,
  progress: number,
  bx: number,
  by: number,
  bw: number,
  bh: number,
  scaleFactor: number,
  time = 0,   // clip-relative seconds; drives Tier 2 animated effects (spec 19). 0 = static.
) {
  const full = data.content ?? ''
  const fontFamily = style.fontFamily ?? 'sans-serif'
  const fontWeight = style.fontWeight ?? 'bold'
  const fontStyle = style.fontStyle ?? 'normal'
  const align = data.align ?? 'center'
  const autoSize = data.autoSize !== false // default ON: text fills its box
  const padding = (data.padding ?? 8) * scaleFactor
  const fontOf = (size: number) => `${fontStyle} ${fontWeight} ${size}px ${fontFamily}`

  ctx.save()
  ctx.globalAlpha = style.opacity
  ctx.textBaseline = 'middle'
  ctx.textAlign = 'left' // horizontal alignment is done manually so it composes with wrapping/reveal

  const availW = Math.max(1, bw - padding * 2)
  const availH = Math.max(1, bh - padding * 2)

  // Layout is computed from the FULL text (independent of the reveal), so letters type on in
  // place without the block reflowing/jumping.
  let fontSize: number
  let lines: WrappedLine[]
  if (autoSize) {
    ({ fontSize, lines } = fitText(ctx, full, fontOf, availW, availH))
  } else {
    fontSize = (style.fontSize ?? 32) * scaleFactor
    ctx.font = fontOf(fontSize)
    lines = wrapText(ctx, full, availW)
  }
  ctx.font = fontOf(fontSize)
  const lineHeight = fontSize * TEXT_LINE_RATIO

  const leftX = bx + padding
  const rightX = bx + bw - padding
  const centerX = bx + bw / 2
  const boxCenterY = by + bh / 2
  const totalH = lines.length * lineHeight
  const firstLineY = boxCenterY - totalH / 2 + lineHeight / 2

  // Typewriter reveal: round so progress=1 shows everything and progress=0 shows nothing.
  const totalChars = lines.reduce((s, l) => s + l.text.length, 0)
  const revealChars = Math.max(0, Math.min(totalChars, Math.round(progress * totalChars)))

  // Background fills the whole object box (its full bbox), not just the glyphs — so it reads as a
  // solid panel behind the text regardless of the text's length or alignment.
  if (data.background) {
    ctx.fillStyle = data.background
    const r = Math.max(0, Math.min((data.cornerRadius ?? 0) * scaleFactor, bw / 2, bh / 2))
    if (r > 0) {
      ctx.beginPath()
      ctx.roundRect(bx, by, bw, bh, r)
      ctx.fill()
    } else {
      ctx.fillRect(bx, by, bw, bh)
    }
  }

  // --- Text effects (spec 19) ---------------------------------------------------------------
  // Effects wrap the glyph fill loop and are a pure fn of (data, clip-relative `time`), so preview
  // and export stay pixel-identical (R-DET). The background panel above already drew; effects only
  // touch the glyphs. Everything is fully reset by the outer ctx.restore() below (all state is set
  // inside this save scope), so nothing leaks to later objects.
  const effect = data.effect

  // Fill style: solid style.color by default; gradient/rainbow/shimmer override it spatially/over time.
  let fillStyle: string | CanvasGradient = style.color
  // Outline draws a stroke under each glyph fill; null = no outline.
  let outline: { color: string; width: number } | null = null
  // Wave: per-glyph vertical offset keyed by the glyph's index in the full text (so it doesn't
  // shift as the typewriter reveal advances). null = flat baseline (whole-substring fillText).
  let waveFn: ((charIndex: number) => number) | null = null
  // Number of times to repaint every glyph — glow stacks passes to intensify the blur halo.
  let passes = 1

  if (effect) {
    switch (effect.kind) {
      case 'glow':
        ctx.shadowColor = effect.color
        ctx.shadowBlur = effect.blur * scaleFactor
        ctx.shadowOffsetX = 0
        ctx.shadowOffsetY = 0
        passes = 3 // repaint to deepen the halo
        break
      case 'outline':
        outline = { color: effect.color, width: effect.width * scaleFactor }
        break
      case 'shadow':
        ctx.shadowColor = effect.color
        ctx.shadowBlur = effect.blur * scaleFactor
        ctx.shadowOffsetX = effect.dx * scaleFactor
        ctx.shadowOffsetY = effect.dy * scaleFactor
        break
      case 'gradient':
        fillStyle = buildGradient(ctx, effect, bx, by, bw, bh)
        break
      case 'rainbow': {
        // Full hue sweep every (4 / speed) seconds; deterministic from clip time.
        const hue = (((time * effect.speed * 90) % 360) + 360) % 360
        fillStyle = `hsl(${hue}, 90%, 60%)`
        break
      }
      case 'wave': {
        const amp = effect.amplitude * scaleFactor
        waveFn = (i) => amp * Math.sin(time * effect.speed * 3 - i * 0.5)
        break
      }
      case 'shimmer':
        fillStyle = buildShimmer(ctx, style.color, effect, time, bx, bw)
        break
      case 'pulse': {
        // Scale + opacity oscillation about the text-box center, wrapping the whole glyph loop.
        const osc = Math.sin(2 * Math.PI * effect.speed * time)
        const k = 1 + effect.amount * 0.15 * osc
        const cx = bx + bw / 2
        const cy = by + bh / 2
        ctx.translate(cx, cy)
        ctx.scale(k, k)
        ctx.translate(-cx, -cy)
        ctx.globalAlpha *= 1 - effect.amount * 0.25 * (0.5 - 0.5 * osc)
        break
      }
      case 'warble': {
        // Faux-3D axis wobble about the text-box center. Two oscillators 90° out of phase drive a
        // Y-tilt (θy) and X-tilt (θx), so the "near" edge precesses left→top→right→bottom in a loop.
        // Perspective is faked with an affine matrix — foreshorten each axis by cos(θ) and add a
        // matching skew — which reads convincingly for a *slight* wobble without offscreen projection.
        const cx = bx + bw / 2
        const cy = by + bh / 2
        const phase = 2 * Math.PI * effect.speed * time
        const tilt = effect.amount * 0.3 // max tilt in radians (~17° at amount=1) → "slight"
        const thy = tilt * Math.sin(phase)
        const thx = tilt * Math.cos(phase)
        const K = 0.4 // skew strength that sells the pseudo-perspective
        ctx.translate(cx, cy)
        ctx.transform(Math.cos(thy), Math.sin(thy) * K, Math.sin(thx) * K, Math.cos(thx), 0, 0)
        ctx.translate(-cx, -cy)
        break
      }
      case 'glitch':
        // Handled after layout in the paint tail (needs multiple full-text passes); no per-glyph
        // setup here. Falls through to the default fill loop being replaced by drawGlitchText below.
        break
    }
  }

  if (outline) {
    ctx.lineJoin = 'round'
    ctx.lineWidth = outline.width
    ctx.strokeStyle = outline.color
  }

  // Paint one run of text at (x, baseY). Per-glyph when waving; a single fillText otherwise.
  // `charBase` is the run's first glyph index within the full text (for wave phase continuity).
  const paintRun = (text: string, x: number, baseY: number, charBase: number): number => {
    if (waveFn) {
      let cx = x
      for (let i = 0; i < text.length; i++) {
        const ch = text[i]
        const gy = baseY + waveFn(charBase + i)
        if (outline) ctx.strokeText(ch, cx, gy)
        ctx.fillText(ch, cx, gy)
        cx += ctx.measureText(ch).width
      }
      return cx
    }
    if (outline) ctx.strokeText(text, x, baseY)
    ctx.fillText(text, x, baseY)
    return x + ctx.measureText(text).width
  }

  const renderLines = () => {
    let remaining = revealChars
    let lineStart = 0 // running glyph index at the start of each line (full text)
    lines.forEach((l, i) => {
      const y = firstLineY + i * lineHeight
      const take = Math.max(0, Math.min(remaining, l.text.length))
      remaining -= l.text.length
      const thisLineStart = lineStart
      lineStart += l.text.length
      if (take <= 0) return

      // Justify only fully-revealed, non-final lines that actually have gaps.
      if (align === 'justify' && !l.paragraphEnd && take >= l.text.length && l.text.includes(' ')) {
        const words = l.text.split(' ')
        const wordsWidth = words.reduce((s, w) => s + ctx.measureText(w).width, 0)
        const gaps = words.length - 1
        const extra = gaps > 0 ? (rightX - leftX - wordsWidth) / gaps : 0
        let x = leftX
        let charAt = thisLineStart
        for (const w of words) {
          paintRun(w, x, y, charAt)
          x += ctx.measureText(w).width + extra
          charAt += w.length + 1 // + the space that split() consumed
        }
        return
      }

      // Align by the FULL line width so revealing letters stay put; draw the visible substring.
      const fullWidth = ctx.measureText(l.text).width
      const sx = align === 'right' ? rightX - fullWidth : align === 'center' ? centerX - fullWidth / 2 : leftX
      paintRun(l.text.slice(0, take), sx, y, thisLineStart)
    })
  }

  ctx.fillStyle = fillStyle
  if (effect?.kind === 'glitch') {
    drawGlitchText(ctx, effect, time, scaleFactor, bx, by, bw, bh, fillStyle, renderLines)
  } else {
    for (let p = 0; p < passes; p++) renderLines()
  }
  ctx.restore()
}

// --- Glitch text effect (spec 19 extension) -------------------------------------------------
// A deterministic pure fn of clip `time` (like grain/old-film in renderer.ts) so preview and export
// match frame-for-frame. Small hashInt/mulberry32 are duplicated locally on purpose to keep this
// module dependency-free.

function hashInt(n: number): number {
  let t = (n ^ 0x9e3779b9) >>> 0
  t = Math.imul(t ^ (t >>> 15), 1 | t)
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
  return (t ^ (t >>> 14)) >>> 0
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const GLITCH_BANDS = 9

/**
 * Render the text with a glitch look: horizontal bands that tear sideways + drop out, over an RGB
 * chromatic-aberration split. `time` is quantized to a glitch "tick" so the artifacts step (film-
 * style) rather than smear, and every random draw is seeded from that tick → reproducible in export.
 *
 * Each band clips a vertical slice and redraws the full text translated, so every pixel row is
 * painted exactly once (no black-fill holes over whatever's behind the text). Per band we draw an
 * additive red + cyan copy (they sum to white where they overlap, leaving coloured fringes on each
 * side) and then the real body fill on top.
 */
function drawGlitchText(
  ctx: CanvasRenderingContext2D,
  effect: Extract<TextEffect, { kind: 'glitch' }>,
  time: number,
  scaleFactor: number,
  bx: number, by: number, bw: number, bh: number,
  bodyFill: string | CanvasGradient,
  renderLines: () => void,
) {
  const amt = effect.amount
  const fps = 6 + effect.speed * 8         // glitch update rate; speed scales how frantic it is
  const rnd = mulberry32(hashInt(Math.floor(time * fps)) || 1)

  const split = (2 + amt * 5) * scaleFactor * (0.7 + 0.6 * rnd()) // chromatic offset, px
  const sy = (rnd() - 0.5) * amt * 2 * scaleFactor
  const jx = (rnd() - 0.5) * amt * 3 * scaleFactor               // whole-block jitter
  const jy = (rnd() - 0.5) * amt * 1.5 * scaleFactor

  const bandH = bh / GLITCH_BANDS
  const clipX = bx - bw   // generous horizontal clip so torn slices aren't cut early
  const clipW = bw * 3

  for (let i = 0; i < GLITCH_BANDS; i++) {
    const r = rnd()
    if (r < 0.04 * amt) continue                       // dropout: band blanks out ("bits disappear")
    const torn = rnd() < 0.22 * amt                    // only a few bands slide each tick
    const offset = torn ? (rnd() - 0.5) * amt * 26 * scaleFactor : 0

    ctx.save()
    ctx.beginPath()
    ctx.rect(clipX, by + i * bandH, clipW, bandH + 0.5) // +0.5 avoids hairline seams between bands
    ctx.clip()
    ctx.translate(offset + jx, jy)

    ctx.globalCompositeOperation = 'lighter'
    ctx.fillStyle = '#ff2233'
    ctx.save(); ctx.translate(split, sy); renderLines(); ctx.restore()
    ctx.fillStyle = '#22ffff'
    ctx.save(); ctx.translate(-split, -sy); renderLines(); ctx.restore()

    ctx.globalCompositeOperation = 'source-over'
    ctx.fillStyle = bodyFill
    renderLines()
    ctx.restore()
  }
  ctx.globalCompositeOperation = 'source-over'
}

/** Build a linear-gradient fill across the text box along `effect.angle` (degrees). */
function buildGradient(
  ctx: CanvasRenderingContext2D,
  effect: Extract<TextEffect, { kind: 'gradient' }>,
  bx: number, by: number, bw: number, bh: number,
): CanvasGradient {
  const a = (effect.angle * Math.PI) / 180
  const cx = bx + bw / 2
  const cy = by + bh / 2
  const half = Math.sqrt(bw * bw + bh * bh) / 2
  const dx = Math.cos(a) * half
  const dy = Math.sin(a) * half
  const g = ctx.createLinearGradient(cx - dx, cy - dy, cx + dx, cy + dy)
  g.addColorStop(0, effect.from)
  g.addColorStop(1, effect.to)
  return g
}

/** Build a horizontal gradient with a bright band that sweeps left→right over clip time. */
function buildShimmer(
  ctx: CanvasRenderingContext2D,
  base: string,
  effect: Extract<TextEffect, { kind: 'shimmer' }>,
  time: number, bx: number, bw: number,
): CanvasGradient {
  const g = ctx.createLinearGradient(bx, 0, bx + bw, 0)
  const clamp01 = (v: number) => Math.max(0, Math.min(1, v))
  // Band center travels from -0.2 to 1.2 (off-edge to off-edge) each loop.
  const phase = ((time * effect.speed) % 1 + 1) % 1
  const center = phase * 1.4 - 0.2
  const band = 0.15
  g.addColorStop(0, base)
  g.addColorStop(clamp01(center - band), base)
  g.addColorStop(clamp01(center), effect.color)
  g.addColorStop(clamp01(center + band), base)
  g.addColorStop(1, base)
  return g
}

export function drawRectangle(
  ctx: CanvasRenderingContext2D,
  style: ObjectStyle,
  progress: number,
  bx: number,
  by: number,
  bw: number,
  bh: number,
  scaleFactor: number,
) {
  ctx.save()
  ctx.strokeStyle = style.color
  ctx.lineWidth = style.lineWidth * scaleFactor
  ctx.globalAlpha = style.opacity * progress

  const rw = bw * progress
  const rh = bh * progress

  ctx.strokeRect(bx, by, rw, rh)
  ctx.restore()
}

export function drawCircle(
  ctx: CanvasRenderingContext2D,
  style: ObjectStyle,
  progress: number,
  bx: number,
  by: number,
  bw: number,
  bh: number,
  scaleFactor: number,
) {
  ctx.save()
  ctx.strokeStyle = style.color
  ctx.lineWidth = style.lineWidth * scaleFactor
  ctx.globalAlpha = style.opacity * progress

  const cx = bx + bw / 2
  const cy = by + bh / 2
  const rx = bw / 2
  const ry = bh / 2

  ctx.beginPath()
  ctx.ellipse(cx, cy, rx * progress, ry * progress, 0, 0, Math.PI * 2)
  ctx.stroke()
  ctx.restore()
}

export function drawFreehand(
  ctx: CanvasRenderingContext2D,
  data: FreehandData,
  style: ObjectStyle,
  progress: number,
  bx: number,
  by: number,
  bw: number,
  bh: number,
  scaleFactor: number,
) {
  const totalPoints = data.strokes.reduce((sum, s) => sum + s.length, 0)
  if (totalPoints < 2) return

  const drawCount = Math.max(2, Math.floor(totalPoints * progress))

  ctx.save()
  ctx.strokeStyle = style.color
  ctx.lineWidth = style.lineWidth * scaleFactor
  ctx.globalAlpha = style.opacity
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'

  let drawn = 0
  for (const stroke of data.strokes) {
    if (drawn >= drawCount) break
    if (stroke.length === 0) continue

    const pts = stroke.map((p) => ({ x: bx + p.x * bw, y: by + p.y * bh }))
    const canDraw = Math.min(pts.length, drawCount - drawn)

    ctx.beginPath()
    ctx.moveTo(pts[0].x, pts[0].y)
    for (let i = 1; i < canDraw; i++) {
      ctx.lineTo(pts[i].x, pts[i].y)
    }
    ctx.stroke()
    drawn += canDraw
  }

  ctx.restore()
}

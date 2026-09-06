import type { LoopEffect } from '../types'

/**
 * Per-object continuous "loop" animation (spec 36). Applies an ambient, always-running modulation on
 * top of the already-resolved pose, as Canvas-2D ctx transforms (+ an optional filter). Called inside
 * `drawObject` right after the base rotation and before the type dispatch, all within the existing
 * ctx.save()/restore() so nothing leaks to later objects.
 *
 * Every kind is a DETERMINISTIC pure fn of clip-relative `time` (R-DET): no wall clock, no
 * `Math.random`. So preview and export are pixel-identical and animation plays in sync at any fps.
 *
 * Returns `{ alpha, filter }` (spec 37): `alpha` is an OPACITY multiplier (1 = unchanged) the caller
 * folds into the object's effective opacity — `pulse` is the only kind that dims; `filter` is a CSS
 * filter fragment (only `rainbow` sets one, else ''). The caller stacks these across a LIST of loop
 * effects: transforms compose on `ctx` as they are applied here; alphas multiply; filter fragments are
 * concatenated into one `ctx.filter` string (a single assignment, so multiple filters don't clobber).
 *
 * `bx,by,bw,bh` are the object's pixel-space bbox (so displacement scales with the object and the
 * transforms pivot about its centre).
 */
export type LoopEffectResult = { alpha: number; filter: string }

const NO_MOD: LoopEffectResult = { alpha: 1, filter: '' }

export function applyLoopEffect(
  ctx: CanvasRenderingContext2D,
  loop: LoopEffect,
  time: number,
  bx: number,
  by: number,
  bw: number,
  bh: number,
): LoopEffectResult {
  const cx = bx + bw / 2
  const cy = by + bh / 2

  switch (loop.kind) {
    case 'zoom': {
      // Scale oscillates ±(amount*25%) about the centre.
      const k = 1 + loop.amount * 0.25 * Math.sin(2 * Math.PI * loop.speed * time)
      ctx.translate(cx, cy)
      ctx.scale(k, k)
      ctx.translate(-cx, -cy)
      return NO_MOD
    }
    case 'spin': {
      // Continuous rotation about the centre; speed = revolutions per second.
      const ang = 2 * Math.PI * loop.speed * time
      ctx.translate(cx, cy)
      ctx.rotate(ang)
      ctx.translate(-cx, -cy)
      return NO_MOD
    }
    case 'sway': {
      // Bounded rotation back-and-forth; ~20° max tilt at amount=1.
      const ang = loop.amount * 0.35 * Math.sin(2 * Math.PI * loop.speed * time)
      ctx.translate(cx, cy)
      ctx.rotate(ang)
      ctx.translate(-cx, -cy)
      return NO_MOD
    }
    case 'bob': {
      // Vertical float; amplitude scales with the object height so it reads the same at any size.
      const dy = loop.amount * bh * 0.15 * Math.sin(2 * Math.PI * loop.speed * time)
      ctx.translate(0, dy)
      return NO_MOD
    }
    case 'warble': {
      // Faux-3D axis wobble — lifted from the spec-19 text `warble`. Two oscillators 90° out of phase
      // drive a Y-tilt and X-tilt, so the "near" edge precesses L→T→R→B. Perspective is faked with an
      // affine matrix (foreshorten each axis by cos(θ) + a matching skew), convincing for a slight tilt.
      const phase = 2 * Math.PI * loop.speed * time
      const tilt = loop.amount * 0.3 // max tilt in radians (~17° at amount=1)
      const thy = tilt * Math.sin(phase)
      const thx = tilt * Math.cos(phase)
      const K = 0.4 // skew strength that sells the pseudo-perspective
      ctx.translate(cx, cy)
      ctx.transform(Math.cos(thy), Math.sin(thy) * K, Math.sin(thx) * K, Math.cos(thx), 0, 0)
      ctx.translate(-cx, -cy)
      return NO_MOD
    }
    case 'pulse': {
      // Scale + opacity oscillation about the centre (the object-level twin of the text pulse).
      const osc = Math.sin(2 * Math.PI * loop.speed * time)
      const k = 1 + loop.amount * 0.15 * osc
      ctx.translate(cx, cy)
      ctx.scale(k, k)
      ctx.translate(-cx, -cy)
      return { alpha: 1 - loop.amount * 0.25 * (0.5 - 0.5 * osc), filter: '' }
    }
    case 'shake': {
      // Deterministic jitter: smooth value-noise sampled at time*speed, seeded so preview==export.
      // Displacement scales with the smaller bbox dimension so it looks proportional at any size.
      const mag = loop.amount * Math.min(bw, bh) * 0.06
      const t = time * loop.speed * 14
      const dx = (valueNoise(t) - 0.5) * 2 * mag
      const dy = (valueNoise(t + 47.3) - 0.5) * 2 * mag
      ctx.translate(dx, dy)
      return NO_MOD
    }
    case 'rainbow': {
      // Hue cycles over time — a full 360° sweep every (4 / speed) seconds. Returned as a filter
      // fragment so it stacks with other loop effects (the caller concatenates + assigns ctx.filter
      // once). Scoped to this object's ctx.save(); independent of the render-wide spec-23 effects filter.
      const deg = (((time * loop.speed * 90) % 360) + 360) % 360
      return { alpha: 1, filter: `hue-rotate(${deg}deg)` }
    }
  }
}

/** Deterministic 0–1 hash of an integer-ish seed (fract of a big sine). No Math.random. */
function hash(n: number): number {
  const s = Math.sin(n * 127.1) * 43758.5453
  return s - Math.floor(s)
}

/** Smooth 1-D value noise in [0,1] — hash at integer lattice points, smoothstep-interpolated. */
function valueNoise(x: number): number {
  const i = Math.floor(x)
  const f = x - i
  const u = f * f * (3 - 2 * f)
  return hash(i) + (hash(i + 1) - hash(i)) * u
}

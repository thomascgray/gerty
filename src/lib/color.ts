/**
 * Colour interpolation for keyframed colour channels (spec 29 R4 `color` rule).
 *
 * Deliberately plain sRGB component lerp — no OKLab/HSL — because it is dependency-free, pure, and
 * worker-safe, matching the determinism rule the renderer relies on (preview === export).
 *
 * Alpha carries the "optional colour" case: `text.background` is `string | undefined` (undefined =
 * no panel at all), and there is no natural midpoint between "nothing" and a colour. Treating an
 * absent side as the OTHER colour at alpha 0 makes a background keyframe read as a fade-in rather
 * than a pop (spec 29 Q5).
 */

type RGBA = { r: number; g: number; b: number; a: number }

/** Parse '#rgb', '#rrggbb', '#rrggbbaa', 'rgb(...)' or 'rgba(...)'. Returns null if unparseable. */
export function parseColor(c: string): RGBA | null {
  const s = c.trim()
  if (s.startsWith('#')) {
    const h = s.slice(1)
    const x = (i: number, n: number) => parseInt(n === 1 ? h[i] + h[i] : h.slice(i * 2, i * 2 + 2), 16)
    if (h.length === 3) return { r: x(0, 1), g: x(1, 1), b: x(2, 1), a: 1 }
    if (h.length === 6) return { r: x(0, 2), g: x(1, 2), b: x(2, 2), a: 1 }
    if (h.length === 8) return { r: x(0, 2), g: x(1, 2), b: x(2, 2), a: x(3, 2) / 255 }
    return null
  }
  const m = s.match(/^rgba?\(([^)]+)\)$/i)
  if (m) {
    const p = m[1].split(',').map((v) => parseFloat(v))
    if (p.length >= 3 && p.every((v) => !isNaN(v))) {
      return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 }
    }
  }
  return null
}

const hex2 = (n: number) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0')

/** Serialize back to '#rrggbb' when fully opaque, 'rgba(...)' otherwise (both valid fillStyles). */
export function formatColor({ r, g, b, a }: RGBA): string {
  if (a >= 0.999) return `#${hex2(r)}${hex2(g)}${hex2(b)}`
  return `rgba(${Math.round(r)}, ${Math.round(g)}, ${Math.round(b)}, ${Math.round(a * 1000) / 1000})`
}

/**
 * Force a colour to an opaque '#rrggbb' for `<input type="color">`, which rejects rgba(). A colour
 * mid-fade (a keyframed text background ramping its alpha) is exactly that case.
 */
export function toHexColor(c: string | undefined, fallback: string): string {
  if (!c) return fallback
  const p = parseColor(c)
  return p ? formatColor({ ...p, a: 1 }) : fallback
}

/**
 * Interpolate two colours at `u` ∈ [0,1]. Either side may be `undefined` ("no colour"), in which
 * case the other colour's alpha is ramped instead — so "no background → red" fades the panel up.
 * Unparseable input falls back to a hard step at u ≥ 0.5 so a bad hex can never crash a render.
 */
export function lerpColor(a: string | undefined, b: string | undefined, u: number): string | undefined {
  if (a === b) return a
  if (a == null && b == null) return undefined
  const ca = a == null ? null : parseColor(a)
  const cb = b == null ? null : parseColor(b)

  // Absent side → the other colour at alpha 0 (fade in / fade out).
  if (ca == null && cb != null) {
    if (a != null) return u >= 0.5 ? b : a  // `a` was set but unparseable → step
    return formatColor({ ...cb, a: cb.a * u })
  }
  if (cb == null && ca != null) {
    if (b != null) return u >= 0.5 ? b : a  // `b` was set but unparseable → step
    return formatColor({ ...ca, a: ca.a * (1 - u) })
  }
  if (ca == null || cb == null) return u >= 0.5 ? b : a

  const m = (x: number, y: number) => x + (y - x) * u
  return formatColor({ r: m(ca.r, cb.r), g: m(ca.g, cb.g), b: m(ca.b, cb.b), a: m(ca.a, cb.a) })
}

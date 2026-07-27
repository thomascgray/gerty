import createREGL from 'regl'
import type { ResolvedEffect, VideoEffectKind, GradientMapPreset, ChannelSwapMapping } from '../types'

/**
 * WebGL fragment-shader effect pipeline (spec 25).
 *
 * Per-pixel effects are unviable on Canvas 2D — a getImageData/putImageData readback every frame
 * stalls the app (spec 24 D3). This module runs them as GPU shader passes instead, with NO readback:
 * the already-composited 2D frame is uploaded as a texture, each active shader effect is a fullscreen
 * pass (ping-ponged through framebuffers so they stack), and the caller draws the GL canvas back onto
 * the 2D context with `drawImage` (a GPU→GPU copy). See SPECS/25-webgl-effects.md.
 *
 * HYBRID (decision D1): the existing spec-23/24 Canvas-2D effects are untouched; this runs AFTER them,
 * only for the shader kinds below. Additive: no shader effects ⇒ this is never invoked.
 *
 * Uses `regl` (decision D2) over a module-scoped OffscreenCanvas WebGL context, so the SAME code path
 * runs on the main thread (preview) and in the export worker (`exportWorker.ts`). All calls are
 * synchronous, so `renderFrame` stays sync. On any failure / context loss, `applyShaderEffects`
 * returns null and the caller keeps the 2D-composited frame (graceful fallback, R9).
 */

// The effect kinds implemented as GLSL passes. Extend this + REGISTRY to add more.
export const SHADER_EFFECT_KINDS = [
  'gradientmap', 'posterize', 'threshold', 'channelswap', 'colorisolate', 'dither',
  'crt', 'vhs', 'halftone', 'comic',
] as const
export type ShaderEffectKind = (typeof SHADER_EFFECT_KINDS)[number]

const SHADER_KIND_SET = new Set<string>(SHADER_EFFECT_KINDS)
export function isShaderEffect(kind: VideoEffectKind): kind is ShaderEffectKind {
  return SHADER_KIND_SET.has(kind)
}

// --- regl types (derived to avoid `export =` / verbatimModuleSyntax namespace-import friction) ---
type Regl = ReturnType<typeof createREGL>
type Texture2D = ReturnType<Regl['texture']>
type Framebuffer2D = ReturnType<Regl['framebuffer']>
type DrawCommand = ReturnType<Regl>
type AnyCanvas = OffscreenCanvas | HTMLCanvasElement

// --- module-scoped GL state (lazy, cached across frames) ---
let glCanvas: AnyCanvas | null = null
let regl: Regl | null = null
let srcTex: Texture2D | null = null
let texA: Texture2D | null = null
let texB: Texture2D | null = null
let fboA: Framebuffer2D | null = null
let fboB: Framebuffer2D | null = null
let positionBuffer: ReturnType<Regl['buffer']> | null = null
const commands = new Map<ShaderEffectKind, DrawCommand>()

let unavailable = false // set once if WebGL/regl can't init — don't retry every frame
let contextLost = false

function makeCanvas(w: number, h: number): AnyCanvas {
  return typeof OffscreenCanvas !== 'undefined'
    ? new OffscreenCanvas(w, h)
    : Object.assign(document.createElement('canvas'), { width: w, height: h })
}

/** Lazily create (and resize) the GL context + ping-pong targets. Returns false if unusable. */
function ensureInit(w: number, h: number): boolean {
  if (unavailable || contextLost) return false
  if (!regl) {
    try {
      glCanvas = makeCanvas(w, h)
      glCanvas.width = w
      glCanvas.height = h
      const gl = glCanvas.getContext('webgl', {
        premultipliedAlpha: false, // frame is opaque (alpha=1) — avoid any premultiply colour shift
        preserveDrawingBuffer: true, // we drawImage(glCanvas) back after rendering
        antialias: false,
        depth: false,
        stencil: false,
      }) as WebGLRenderingContext | null
      if (!gl) { unavailable = true; return false }
      regl = createREGL(gl)
      regl.on('lost', () => { contextLost = true })
      regl.on('restore', () => { contextLost = false; resetGl() })
      positionBuffer = regl.buffer([-1, -1, 3, -1, -1, 3]) // fullscreen triangle
      const texOpts = { min: 'nearest' as const, mag: 'nearest' as const, width: w, height: h }
      texA = regl.texture(texOpts)
      texB = regl.texture(texOpts)
      srcTex = regl.texture({ ...texOpts, flipY: true })
      fboA = regl.framebuffer({ color: texA, depth: false, stencil: false })
      fboB = regl.framebuffer({ color: texB, depth: false, stencil: false })
    } catch {
      unavailable = true
      resetGl()
      return false
    }
  }
  if (glCanvas && (glCanvas.width !== w || glCanvas.height !== h)) {
    glCanvas.width = w
    glCanvas.height = h
    texA?.resize(w, h)
    texB?.resize(w, h)
    srcTex?.resize(w, h)
    fboA?.resize(w, h)
    fboB?.resize(w, h)
  }
  return !!regl
}

function resetGl() {
  regl = null
  srcTex = texA = texB = null
  fboA = fboB = null
  positionBuffer = null
  commands.clear()
}

// --- shaders ---

const VERT = `
precision mediump float;
attribute vec2 position;
varying vec2 vUv;
void main() {
  vUv = position * 0.5 + 0.5;
  gl_Position = vec4(position, 0.0, 1.0);
}`

// Gradient map / false colour: luminance → a preset colour ramp, blended by intensity.
// Ramps mirror the (removed) Canvas-2D LUT from spec 24 (thermal/nightvision/infrared/risograph),
// as piecewise-linear stops selected by uPreset (0..3).
const FRAG_GRADIENTMAP = `
precision mediump float;
varying vec2 vUv;
uniform sampler2D uSrc;
uniform float uIntensity;
uniform float uPreset;

float ls(float a, float b, float t) { return clamp((t - a) / (b - a), 0.0, 1.0); }

vec3 thermal(float t) {
  vec3 c = mix(vec3(0.0), vec3(0.078, 0.0, 0.471), ls(0.0, 0.2, t));
  c = mix(c, vec3(0.627, 0.0, 0.627), ls(0.2, 0.4, t));
  c = mix(c, vec3(0.902, 0.157, 0.078), ls(0.4, 0.6, t));
  c = mix(c, vec3(1.0, 0.667, 0.0), ls(0.6, 0.8, t));
  c = mix(c, vec3(1.0, 1.0, 0.863), ls(0.8, 1.0, t));
  return c;
}
vec3 nightvision(float t) {
  vec3 c = mix(vec3(0.0, 0.031, 0.0), vec3(0.078, 0.471, 0.118), ls(0.0, 0.5, t));
  c = mix(c, vec3(0.471, 1.0, 0.471), ls(0.5, 0.85, t));
  c = mix(c, vec3(0.863, 1.0, 0.863), ls(0.85, 1.0, t));
  return c;
}
vec3 infrared(float t) {
  vec3 c = mix(vec3(0.039, 0.0, 0.0), vec3(0.588, 0.039, 0.118), ls(0.0, 0.4, t));
  c = mix(c, vec3(1.0, 0.353, 0.157), ls(0.4, 0.7, t));
  c = mix(c, vec3(1.0, 0.961, 0.824), ls(0.7, 1.0, t));
  return c;
}
vec3 risograph(float t) {
  vec3 c = mix(vec3(0.078, 0.094, 0.322), vec3(0.922, 0.157, 0.471), ls(0.0, 0.55, t));
  c = mix(c, vec3(0.980, 0.941, 0.824), ls(0.55, 1.0, t));
  return c;
}
// Cinematic teal-and-orange: teal shadows → neutral warm mids → orange → warm cream highlights.
// Designed to be blended at partial intensity so original hue survives (a colour grade, not a LUT).
vec3 cinematic(float t) {
  vec3 c = mix(vec3(0.043, 0.114, 0.133), vec3(0.129, 0.278, 0.290), ls(0.0, 0.32, t));
  c = mix(c, vec3(0.463, 0.435, 0.384), ls(0.32, 0.58, t));
  c = mix(c, vec3(0.855, 0.596, 0.337), ls(0.58, 0.82, t));
  c = mix(c, vec3(1.0, 0.914, 0.792), ls(0.82, 1.0, t));
  return c;
}
// Cinematic cool: deep blue shadows → slate-blue mids → cool white highlights (moody night grade).
vec3 cinemacool(float t) {
  vec3 c = mix(vec3(0.031, 0.055, 0.118), vec3(0.114, 0.180, 0.298), ls(0.0, 0.4, t));
  c = mix(c, vec3(0.353, 0.427, 0.522), ls(0.4, 0.7, t));
  c = mix(c, vec3(0.847, 0.882, 0.941), ls(0.7, 1.0, t));
  return c;
}

void main() {
  vec4 src = texture2D(uSrc, vUv);
  float lum = dot(src.rgb, vec3(0.299, 0.587, 0.114));
  vec3 mapped;
  if (uPreset < 0.5) mapped = thermal(lum);
  else if (uPreset < 1.5) mapped = nightvision(lum);
  else if (uPreset < 2.5) mapped = infrared(lum);
  else if (uPreset < 3.5) mapped = risograph(lum);
  else if (uPreset < 4.5) mapped = cinematic(lum);
  else mapped = cinemacool(lum);
  gl_FragColor = vec4(mix(src.rgb, mapped, uIntensity), src.a);
}`

// Posterize: quantize each channel to N bands.
const FRAG_POSTERIZE = `
precision mediump float;
varying vec2 vUv;
uniform sampler2D uSrc;
uniform float uIntensity;
uniform float uLevels;
void main() {
  vec4 src = texture2D(uSrc, vUv);
  float L = max(uLevels, 2.0);
  vec3 q = floor(src.rgb * (L - 1.0) + 0.5) / (L - 1.0);
  gl_FragColor = vec4(mix(src.rgb, q, uIntensity), src.a);
}`

// Threshold / duotone: luminance split into two colours (soft edge).
const FRAG_THRESHOLD = `
precision mediump float;
varying vec2 vUv;
uniform sampler2D uSrc;
uniform float uIntensity;
uniform vec3 uDark;
uniform vec3 uLight;
uniform float uThreshold;
void main() {
  vec4 src = texture2D(uSrc, vUv);
  float lum = dot(src.rgb, vec3(0.299, 0.587, 0.114));
  vec3 duo = mix(uDark, uLight, smoothstep(uThreshold - 0.03, uThreshold + 0.03, lum));
  gl_FragColor = vec4(mix(src.rgb, duo, uIntensity), src.a);
}`

// Channel swap: permute RGB (selected by uMapping index).
const FRAG_CHANNELSWAP = `
precision mediump float;
varying vec2 vUv;
uniform sampler2D uSrc;
uniform float uIntensity;
uniform float uMapping;
void main() {
  vec4 s = texture2D(uSrc, vUv);
  vec3 c = s.rgb;
  vec3 o;
  if (uMapping < 0.5) o = c.rbg;
  else if (uMapping < 1.5) o = c.grb;
  else if (uMapping < 2.5) o = c.brg;
  else if (uMapping < 3.5) o = c.bgr;
  else o = c.gbr;
  gl_FragColor = vec4(mix(c, o, uIntensity), s.a);
}`

// Colour isolation: keep pixels near a target hue, desaturate the rest.
const FRAG_COLORISOLATE = `
precision mediump float;
varying vec2 vUv;
uniform sampler2D uSrc;
uniform float uIntensity;
uniform float uHue;        // degrees 0-360
uniform float uTolerance;  // degrees
vec3 rgb2hsv(vec3 c) {
  vec4 K = vec4(0.0, -1.0 / 3.0, 2.0 / 3.0, -1.0);
  vec4 p = mix(vec4(c.bg, K.wz), vec4(c.gb, K.xy), step(c.b, c.g));
  vec4 q = mix(vec4(p.xyw, c.r), vec4(c.r, p.yzx), step(p.x, c.r));
  float d = q.x - min(q.w, q.y);
  float e = 1.0e-10;
  return vec3(abs(q.z + (q.w - q.y) / (6.0 * d + e)), d / (q.x + e), q.x);
}
void main() {
  vec4 src = texture2D(uSrc, vUv);
  vec3 hsv = rgb2hsv(src.rgb);
  float hueDeg = hsv.x * 360.0;
  float dist = abs(hueDeg - uHue);
  dist = min(dist, 360.0 - dist); // hue wraps at 360
  float keep = 1.0 - smoothstep(uTolerance, uTolerance + 15.0, dist);
  float lum = dot(src.rgb, vec3(0.299, 0.587, 0.114));
  vec3 isolated = mix(vec3(lum), src.rgb, keep);
  gl_FragColor = vec4(mix(src.rgb, isolated, uIntensity), src.a);
}`

// Ordered (Bayer) dithering while quantizing to N levels; uScale = px per dither cell.
const FRAG_DITHER = `
precision mediump float;
varying vec2 vUv;
uniform sampler2D uSrc;
uniform float uIntensity;
uniform float uLevels;
uniform float uScale;
float bayer2(vec2 a) { a = floor(a); return fract(a.x / 2.0 + a.y * a.y * 0.75); }
float bayer4(vec2 a) { return bayer2(0.5 * a) * 0.25 + bayer2(a); }
void main() {
  vec4 src = texture2D(uSrc, vUv);
  float L = max(uLevels, 2.0);
  vec2 cell = floor(gl_FragCoord.xy / max(uScale, 1.0));
  float t = bayer4(cell);
  vec3 q = clamp(floor(src.rgb * (L - 1.0) + t) / (L - 1.0), 0.0, 1.0);
  gl_FragColor = vec4(mix(src.rgb, q, uIntensity), src.a);
}`

// CRT: barrel-distorted UV, scanlines, RGB phosphor mask, subtle flicker + a Zoom that crops the
// black bezel the curvature creates. Intensity does NOT crossfade with the source (that ghosts a
// distorted image over an undistorted one) — instead it scales the effect params, so it fades to a
// clean identity at 0 and reaches full strength at 1, with no doubling. uResolution → pixel-space
// scanlines/mask; uTime → flicker.
const FRAG_CRT = `
precision mediump float;
varying vec2 vUv;
uniform sampler2D uSrc;
uniform float uIntensity;
uniform float uTime;
uniform vec2 uResolution;
uniform float uCurvature;
uniform float uScanline;
uniform float uZoom;
vec2 barrel(vec2 uv, float amt) {
  vec2 cc = uv - 0.5;
  float d = dot(cc, cc);
  return uv + cc * d * amt;
}
void main() {
  float amt = uIntensity;
  float zoom = uZoom * amt;
  // Zoom in toward the centre first (crops the bezel), then barrel-distort.
  vec2 uv = (vUv - 0.5) * (1.0 - zoom * 0.5) + 0.5;
  uv = barrel(uv, uCurvature * amt * 0.6);
  vec3 crt;
  if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) {
    crt = vec3(0.0); // bezel
  } else {
    crt = texture2D(uSrc, uv).rgb;
    float line = 0.5 + 0.5 * sin(uv.y * uResolution.y * 3.14159);
    crt *= 1.0 - uScanline * amt * 0.6 * line;
    float col = mod(uv.x * uResolution.x, 3.0);
    vec3 mask = col < 1.0 ? vec3(1.0, 0.7, 0.7) : col < 2.0 ? vec3(0.7, 1.0, 0.7) : vec3(0.7, 0.7, 1.0);
    crt *= mix(vec3(1.0), mask, 0.5 * amt);
    crt *= 1.0 + 0.03 * amt * sin(uTime * 12.0); // flicker
    crt *= 1.0 + 0.15 * amt;                      // compensate mask/scanline darkening
  }
  gl_FragColor = vec4(crt, texture2D(uSrc, vUv).a);
}`

// VHS: horizontal chroma bleed + per-line wobble + MANY random flickering tracking lines + a wide
// scrolling tracking band + subtle grain + mild desaturation. All jitter is hashed off row + a
// time-step (deterministic ⇒ preview==export). Multiple randomised lines read far more organic than
// a single band.
const FRAG_VHS = `
precision mediump float;
varying vec2 vUv;
uniform sampler2D uSrc;
uniform float uIntensity;
uniform float uTime;
uniform vec2 uResolution;
uniform float uBleed;
uniform float uNoise;
float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
void main() {
  float rows = uResolution.y;
  float ry = floor(vUv.y * rows);
  float tState = floor(uTime * 20.0);

  // Per-line wobble for every row + a slow wave.
  float wobble = (hash(vec2(ry, tState)) - 0.5) * 0.008 * uNoise
               + sin(vUv.y * 8.0 + uTime * 2.0) * 0.0015 * uNoise;

  // Random tracking lines: a scattered subset of rows (more with Tracking) get a strong extra shift.
  float lineRand = hash(vec2(ry * 0.37, tState));
  float isLine = step(1.0 - uNoise * 0.08, lineRand);
  float lineShift = isLine * (hash(vec2(ry, tState + 3.0)) - 0.5) * 0.06 * uNoise;

  vec2 uv = vec2(vUv.x + wobble + lineShift, vUv.y);

  // Chroma bleed: pull R and B apart horizontally.
  float o = uBleed * 0.01;
  float r = texture2D(uSrc, uv + vec2(o, 0.0)).r;
  float g = texture2D(uSrc, uv).g;
  float b = texture2D(uSrc, uv - vec2(o, 0.0)).b;
  vec3 col = vec3(r, g, b);

  // Bright/dark noise smeared along the tracking lines.
  float streak = isLine * (hash(vec2(vUv.x * 60.0, ry) + tState) - 0.4);
  col += streak * uNoise * 1.2;

  // A wide scrolling tracking band (drifting head-switch region).
  float band = fract(vUv.y + uTime * 0.15);
  float bandMask = smoothstep(0.9, 0.95, band) * (1.0 - smoothstep(0.97, 1.0, band));
  float bandNoise = hash(vec2(vUv.x * rows * 0.3, ry) + tState);
  col = mix(col, vec3(bandNoise), bandMask * 0.4 * uNoise);

  // Subtle static grain everywhere.
  col += (hash(vUv * rows + tState) - 0.5) * 0.05 * uNoise;

  // Mild VHS desaturation.
  float lum = dot(col, vec3(0.299, 0.587, 0.114));
  col = mix(col, vec3(lum), 0.15);

  gl_FragColor = vec4(mix(texture2D(uSrc, vUv).rgb, col, uIntensity), texture2D(uSrc, vUv).a);
}`

// Halftone: comic dot screen. Dot radius grows as local luminance drops; grid rotated by uAngle.
const FRAG_HALFTONE = `
precision mediump float;
varying vec2 vUv;
uniform sampler2D uSrc;
uniform float uIntensity;
uniform vec2 uResolution;
uniform float uCell;
uniform float uAngle;
void main() {
  vec4 src = texture2D(uSrc, vUv);
  float lum = dot(src.rgb, vec3(0.299, 0.587, 0.114));
  vec2 px = vUv * uResolution;
  float a = radians(uAngle);
  mat2 R = mat2(cos(a), -sin(a), sin(a), cos(a));
  vec2 rp = R * px;
  float cell = max(uCell, 2.0);
  vec2 c = mod(rp, cell) - cell * 0.5;
  float d = length(c) / (cell * 0.5);
  float radius = sqrt(clamp(1.0 - lum, 0.0, 1.0));
  float ink = 1.0 - smoothstep(radius - 0.15, radius + 0.15, d);
  vec3 col = mix(vec3(1.0), vec3(0.0), ink); // paper white, ink black
  gl_FragColor = vec4(mix(src.rgb, col, uIntensity), src.a);
}`

// Comic ink: Sobel edge detection over a posterized base → dark ink lines on flat colour.
const FRAG_COMIC = `
precision mediump float;
varying vec2 vUv;
uniform sampler2D uSrc;
uniform float uIntensity;
uniform vec2 uResolution;
uniform float uLevels;
uniform float uThickness;
float lumAt(vec2 uv) { return dot(texture2D(uSrc, uv).rgb, vec3(0.299, 0.587, 0.114)); }
void main() {
  vec4 src = texture2D(uSrc, vUv);
  vec2 tx = uThickness / uResolution;
  // Sobel
  float tl = lumAt(vUv + tx * vec2(-1.0, -1.0));
  float tc = lumAt(vUv + tx * vec2( 0.0, -1.0));
  float tr = lumAt(vUv + tx * vec2( 1.0, -1.0));
  float ml = lumAt(vUv + tx * vec2(-1.0,  0.0));
  float mr = lumAt(vUv + tx * vec2( 1.0,  0.0));
  float bl = lumAt(vUv + tx * vec2(-1.0,  1.0));
  float bc = lumAt(vUv + tx * vec2( 0.0,  1.0));
  float br = lumAt(vUv + tx * vec2( 1.0,  1.0));
  float gx = -tl - 2.0 * ml - bl + tr + 2.0 * mr + br;
  float gy = -tl - 2.0 * tc - tr + bl + 2.0 * bc + br;
  float edge = clamp(length(vec2(gx, gy)), 0.0, 1.0);
  float ink = smoothstep(0.3, 0.6, edge);
  // Posterized base
  float L = max(uLevels, 2.0);
  vec3 base = floor(src.rgb * (L - 1.0) + 0.5) / (L - 1.0);
  vec3 col = mix(base, vec3(0.0), ink);
  gl_FragColor = vec4(mix(src.rgb, col, uIntensity), src.a);
}`

/** Parse a #rgb / #rrggbb hex into a [r,g,b] triple in 0..1 (white on a bad value). */
function hexToRgb01(hex: string): [number, number, number] {
  let h = hex.replace('#', '').trim()
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2]
  const n = parseInt(h, 16)
  if (h.length !== 6 || Number.isNaN(n)) return [1, 1, 1]
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255]
}

const CHANNELSWAP_INDEX: Record<ChannelSwapMapping, number> = {
  rbg: 0, grb: 1, brg: 2, bgr: 3, gbr: 4,
}

// Per-kind definitions: the fragment shader + how to pull extra uniforms from a ResolvedEffect.
type PropValue = number | number[]
type EffectDef = {
  frag: string
  extraUniforms: Record<string, unknown>
  props: (e: ResolvedEffect) => Record<string, PropValue>
}

const GRADIENT_PRESET_INDEX: Record<GradientMapPreset, number> = {
  thermal: 0, nightvision: 1, infrared: 2, risograph: 3, cinematic: 4, cinemacool: 5,
}

// Helper: a uniform that reads a named prop passed to the draw command.
const fromProp = (key: string) => (_ctx: unknown, props: Record<string, PropValue>) => props[key]
// uTime (animated shaders) reads the `time` prop; uResolution reads the regl viewport (for
// pixel-space / neighbour sampling — CRT scanlines, VHS, halftone, Sobel).
const uTime = { uTime: fromProp('time') }
const uResolution = {
  uResolution: (ctx: { viewportWidth: number; viewportHeight: number }) => [ctx.viewportWidth, ctx.viewportHeight],
}

const REGISTRY: Record<ShaderEffectKind, EffectDef> = {
  gradientmap: {
    frag: FRAG_GRADIENTMAP,
    extraUniforms: { uPreset: fromProp('preset') },
    props: (e) => ({ preset: GRADIENT_PRESET_INDEX[e.gradientmap?.preset ?? 'thermal'] }),
  },
  posterize: {
    frag: FRAG_POSTERIZE,
    extraUniforms: { uLevels: fromProp('levels') },
    props: (e) => ({ levels: e.posterize?.levels ?? 5 }),
  },
  threshold: {
    frag: FRAG_THRESHOLD,
    extraUniforms: { uDark: fromProp('dark'), uLight: fromProp('light'), uThreshold: fromProp('threshold') },
    props: (e) => ({
      dark: hexToRgb01(e.threshold?.dark ?? '#000000'),
      light: hexToRgb01(e.threshold?.light ?? '#ffffff'),
      threshold: e.threshold?.threshold ?? 0.5,
    }),
  },
  channelswap: {
    frag: FRAG_CHANNELSWAP,
    extraUniforms: { uMapping: fromProp('mapping') },
    props: (e) => ({ mapping: CHANNELSWAP_INDEX[e.channelswap?.mapping ?? 'brg'] }),
  },
  colorisolate: {
    frag: FRAG_COLORISOLATE,
    extraUniforms: { uHue: fromProp('hue'), uTolerance: fromProp('tolerance') },
    props: (e) => ({ hue: e.colorisolate?.hue ?? 0, tolerance: e.colorisolate?.tolerance ?? 30 }),
  },
  dither: {
    frag: FRAG_DITHER,
    extraUniforms: { uLevels: fromProp('levels'), uScale: fromProp('scale') },
    props: (e) => ({ levels: e.dither?.levels ?? 3, scale: e.dither?.scale ?? 2 }),
  },
  crt: {
    frag: FRAG_CRT,
    extraUniforms: {
      ...uTime, ...uResolution,
      uCurvature: fromProp('curvature'), uScanline: fromProp('scanline'), uZoom: fromProp('zoom'),
    },
    props: (e) => ({
      curvature: e.crt?.curvature ?? 0.3,
      scanline: e.crt?.scanline ?? 0.5,
      zoom: e.crt?.zoom ?? 0.3,
    }),
  },
  vhs: {
    frag: FRAG_VHS,
    extraUniforms: { ...uTime, ...uResolution, uBleed: fromProp('bleed'), uNoise: fromProp('noise') },
    props: (e) => ({ bleed: e.vhs?.bleed ?? 0.5, noise: e.vhs?.noise ?? 0.4 }),
  },
  halftone: {
    frag: FRAG_HALFTONE,
    extraUniforms: { ...uResolution, uCell: fromProp('cell'), uAngle: fromProp('angle') },
    props: (e) => ({ cell: e.halftone?.cell ?? 6, angle: e.halftone?.angle ?? 45 }),
  },
  comic: {
    frag: FRAG_COMIC,
    extraUniforms: { ...uResolution, uLevels: fromProp('levels'), uThickness: fromProp('thickness') },
    props: (e) => ({ levels: e.comic?.levels ?? 4, thickness: e.comic?.thickness ?? 1 }),
  },
}

function getCommand(kind: ShaderEffectKind): DrawCommand | null {
  const cached = commands.get(kind)
  if (cached) return cached
  if (!regl || !positionBuffer) return null
  const def = REGISTRY[kind]
  const cmd = regl({
    vert: VERT,
    frag: def.frag,
    attributes: { position: positionBuffer },
    uniforms: {
      uSrc: regl.prop<{ src: Texture2D }, 'src'>('src'),
      uIntensity: regl.prop<{ intensity: number }, 'intensity'>('intensity'),
      ...def.extraUniforms,
    },
    framebuffer: regl.prop<{ dst: Framebuffer2D | null }, 'dst'>('dst'),
    depth: { enable: false },
    count: 3,
  })
  commands.set(kind, cmd)
  return cmd
}

/**
 * Run the active shader effects over `srcCanvas` and return the GL canvas holding the result
 * (draw it back onto the 2D context with `drawImage`). Returns null when there are no shader effects
 * or WebGL is unavailable/lost — in which case the caller leaves the 2D frame as-is.
 *
 * `shaderFx` must already be filtered to shader kinds, in resolved (compose) order.
 */
export function applyShaderEffects(
  srcCanvas: AnyCanvas,
  shaderFx: ResolvedEffect[],
  globalTime: number,
  size: { width: number; height: number },
): AnyCanvas | null {
  if (shaderFx.length === 0) return null
  if (!ensureInit(size.width, size.height)) return null
  try {
    // Upload the composited frame. flipY so the texture orientation matches drawImage's top-down read.
    // regl's `data` type omits OffscreenCanvas (stale types) but accepts any canvas at runtime.
    srcTex!({
      data: srcCanvas as unknown as HTMLCanvasElement,
      flipY: true,
      min: 'nearest',
      mag: 'nearest',
      premultiplyAlpha: false,
    })

    let input = srcTex!
    for (let i = 0; i < shaderFx.length; i++) {
      const e = shaderFx[i]
      const cmd = getCommand(e.kind as ShaderEffectKind)
      if (!cmd) return null
      const last = i === shaderFx.length - 1
      const dst = last ? null : i % 2 === 0 ? fboA! : fboB!
      const def = REGISTRY[e.kind as ShaderEffectKind]
      cmd({ src: input, dst, intensity: e.intensity, time: globalTime, ...def.props(e) })
      input = i % 2 === 0 ? texA! : texB!
    }
    return glCanvas
  } catch {
    return null
  }
}

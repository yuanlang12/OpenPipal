/**
 * Agent Mark 的几何底座 —— 纯函数，无 DOM、无 React，可以在 node 里单测。
 *
 * 两个图元撑起整套标识：
 *   1. 身体 = 圆角方的径向剖面 r(θ)。所有形态（方块 / 圆点）采样在同一组角度上，
 *      所以任意两个形状的点一一对应，morph 退化成半径的线性插值 —— 不需要 path морф 库。
 *   2. 眼睛 = 一条带圆头的描边线段。bend=0 时它**精确**等于素材包那个
 *      `rect(10, 22, rx=5)`（总高 L+w、宽 w、端头半径 w/2 三项逐项相等），
 *      bend≠0 就弯成笑眼。六个参数全可线性插值，所以表情之间是连续变形而不是切换。
 *
 * 坐标系：viewBox "-32 -32 64 64"，瓷砖半边 HALF=32、圆角 CORNER=4，与
 * resources/brand 的 agent-icon-atlas-mark.svg 同一套数。
 */

export const SAMPLES = 64
export const HALF = 32
export const CORNER = 4
const TAU = Math.PI * 2

const ANGLES = Array.from({ length: SAMPLES }, (_, i) => (i / SAMPLES) * TAU)
const COS = ANGLES.map(Math.cos)
const SIN = ANGLES.map(Math.sin)

export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t
export const clamp = (v: number, lo = 0, hi = 1): number => (v < lo ? lo : v > hi ? hi : v)
const r2 = (n: number): number => Math.round(n * 100) / 100

/**
 * 圆角方的解析剖面：射线打在 4 条直边和 4 段角弧上，取最远的那个交点。
 * 解析解而不是拟合 —— 换 rx 只要改 corner，不用重新量。
 */
export function roundedSquareProfile(half = HALF, corner = CORNER): number[] {
  const s = half - corner
  return ANGLES.map((_, i) => {
    const c = COS[i]
    const sn = SIN[i]
    let best = 0
    for (const [nx, ny] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const den = c * nx + sn * ny
      if (den <= 1e-9) continue
      const t = half / den
      const tangent = nx !== 0 ? Math.abs(t * sn) : Math.abs(t * c)
      if (tangent <= s + 1e-9) best = Math.max(best, t)
    }
    for (const [cx, cy] of [[s, s], [s, -s], [-s, s], [-s, -s]] as const) {
      const b = c * cx + sn * cy
      const disc = b * b - (cx * cx + cy * cy - corner * corner)
      if (disc < 0) continue
      const t = b + Math.sqrt(disc)
      if (t <= 0) continue
      const px = t * c - cx
      const py = t * sn - cy
      if (px * Math.sign(cx) >= -1e-9 && py * Math.sign(cy) >= -1e-9) best = Math.max(best, t)
    }
    return best
  })
}

export const circleProfile = (radius: number): number[] => new Array(SAMPLES).fill(radius)

export const blendProfile = (a: number[], b: number[], t: number): number[] =>
  a.map((v, i) => lerp(v, b[i], t))

/** 剖面 → 闭合三次贝塞尔。64 个点用居中切线已经在 512px 下看不出折线。 */
export function profilePath(radii: number[]): string {
  const pts = radii.map((r, i) => ({ x: r * COS[i], y: r * SIN[i] }))
  const n = pts.length
  const k = 1 / 6
  let d = `M${r2(pts[0].x)} ${r2(pts[0].y)}`
  for (let i = 0; i < n; i++) {
    const p0 = pts[(i - 1 + n) % n]
    const p1 = pts[i]
    const p2 = pts[(i + 1) % n]
    const p3 = pts[(i + 2) % n]
    d += `C${r2(p1.x + (p2.x - p0.x) * k)} ${r2(p1.y + (p2.y - p0.y) * k)}`
      + ` ${r2(p2.x - (p3.x - p1.x) * k)} ${r2(p2.y - (p3.y - p1.y) * k)}`
      + ` ${r2(p2.x)} ${r2(p2.y)}`
  }
  return `${d}Z`
}

/** 眼睛：cx/cy 中心，L 直段长，w 描边宽（= 总宽），tilt 倾角(度)，bend 弯曲量 */
export interface Eye {
  cx: number
  cy: number
  L: number
  w: number
  tilt: number
  bend: number
}

export const eye = (cx: number, cy: number, L: number, w: number, tilt: number, bend = 0): Eye =>
  ({ cx, cy, L, w, tilt, bend })

export const eyePath = (e: Eye): string => `M0 ${r2(-e.L / 2)}Q${r2(e.bend)} 0 0 ${r2(e.L / 2)}`

export const eyeTransform = (e: Eye, squash: number, shift: number): string =>
  `translate(${r2(e.cx + shift)} ${r2(e.cy)}) rotate(${r2(e.tilt)}) scale(1 ${r2(squash)})`

/** 倾角走最短路：从 -11° 到 +20° 不能绕 349°，否则眼睛会整圈翻过去。 */
export function blendEye(a: Eye, b: Eye, t: number): Eye {
  let dTilt = b.tilt - a.tilt
  while (dTilt > 180) dTilt -= 360
  while (dTilt < -180) dTilt += 360
  return {
    cx: lerp(a.cx, b.cx, t),
    cy: lerp(a.cy, b.cy, t),
    L: lerp(a.L, b.L, t),
    w: lerp(a.w, b.w, t),
    tilt: a.tilt + dTilt * t,
    bend: lerp(a.bend, b.bend, t),
  }
}

export const easeOutQuint = (t: number): number => 1 - Math.pow(1 - t, 5)
export const easeOutCubic = (t: number): number => 1 - Math.pow(1 - t, 3)

/** 剖面上某个方向的半径 —— 判断贴在身体上的东西会不会被 mask 裁掉时用。 */
export function radiusAtAngle(radii: number[], angle: number): number {
  const t = ((((angle / TAU) % 1) + 1) % 1) * SAMPLES
  const i = Math.floor(t)
  return lerp(radii[i % SAMPLES], radii[(i + 1) % SAMPLES], t - i)
}

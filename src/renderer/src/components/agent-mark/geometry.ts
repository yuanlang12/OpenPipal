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
/** 路径数字统一两位小数：字符串短、同一帧比较稳定 */
export const r2 = (n: number): number => Math.round(n * 100) / 100

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

// ---- 轮廓：身体的形状 ----
//
// 所有形状都是同一套 64 根射线上的半径，所以任意两个形状之间照样能 morph（blendProfile），
// 思考态"身体缩成一颗点"的动画对每种形状都成立。角度按 ANGLES：0 在右、π/2 在下（SVG y 朝下）、
// 3π/2 在上。眼睛是 mask 挖在身体上的洞，换轮廓不用动眼睛。

export const MARK_SHAPES = ['square', 'circle', 'drop', 'hexagon', 'cloud', 'triangle'] as const
export type MarkShape = (typeof MARK_SHAPES)[number]

export const isMarkShape = (value: unknown): value is MarkShape =>
  typeof value === 'string' && (MARK_SHAPES as readonly string[]).includes(value)

const TOP = (3 * Math.PI) / 2
const BOTTOM = Math.PI / 2

/** 正 n 边形的极坐标半径：circumradius 是顶点到中心的距离，vertexAt 是第一个顶点的角度 */
function polygonRadius(theta: number, sides: number, circumradius: number, vertexAt: number): number {
  const step = (2 * Math.PI) / sides
  const local = (((theta - vertexAt) % step) + step) % step
  return (circumradius * Math.cos(step / 2)) / Math.cos(local - step / 2)
}

/** 相对"顶部"的角差，折到 [0, π]：0 = 正上方，π = 正下方 */
function fromTop(theta: number): number {
  const d = Math.abs((((theta - TOP) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI))
  return d > Math.PI ? 2 * Math.PI - d : d
}

export function shapeProfile(shape: MarkShape): number[] {
  switch (shape) {
    case 'circle':
      return circleProfile(HALF - 1)
    case 'drop': {
      // 盾牌 / 倒水滴：上圆下尖。眼睛固定在上半身（右眼还上翘），窄的一头只能朝下——
      // 尖朝上的水滴无论怎么放宽，右眼角都会从斜边露出去（两轮截图都露）
      return ANGLES.map((theta) => {
        const s = (1 - Math.cos(fromTop(theta))) / 2   // 0 = 顶，1 = 底
        return HALF * (1 - 0.42 * Math.pow(s, 1.6))
      })
    }
    case 'hexagon':
      return ANGLES.map((theta) => polygonRadius(theta, 6, HALF + 1, TOP))
    case 'cloud':
      // 五个鼓包：|cos(2.5θ)| 一圈正好五个峰，贝塞尔平滑后就是云边
      // 相位对准顶部：一个鼓包正对上方，左右才对称
      return ANGLES.map((theta) => HALF * (0.84 + 0.14 * Math.abs(Math.cos(2.5 * (theta - TOP)))))
    case 'triangle':
      // 顶点朝下：同上，眼睛在上半身，宽的一边得在上面
      return ANGLES.map((theta) => polygonRadius(theta, 3, HALF + 6, BOTTOM))
    case 'square':
    default:
      return roundedSquareProfile()
  }
}

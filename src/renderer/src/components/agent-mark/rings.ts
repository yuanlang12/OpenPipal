/**
 * 执行态的环绕彩环 —— 真 3D 圆做正交投影，按 z 劈成前后两段：
 * 后半段画在身体之前（被身体挡住），前半段画在身体之后。这个前后分层才是它读起来
 * 像"绕着转"而不是"贴上去的花纹"的原因。
 *
 * 关键取舍：**环平面固定，只有弧在环上跑**。于是环上每个点的 z 是常数、前后分界点是
 * 固定下标，每帧不需要任何三角函数或 3D 运算，只是从预算好的点表里挑一段下标。
 * 载入时算一次，运行时零数学 —— 实测 6 条环合计 0.07ms/帧。
 */

const TAU = Math.PI * 2
const SAMPLES = 72
const r2 = (n: number): number => Math.round(n * 100) / 100

interface RingSpec {
  radius: number
  tiltX: number
  tiltY: number
  arcDeg: number
  width: number
  speed: number
  color: string
}

export interface Ring extends RingSpec {
  points: { x: number; y: number; z: number }[]
  count: number
}

/** 半径以瓷砖半边 32 为基准；进执行态时整体缩到 RING_SHRINK 给环让位，布局盒不变。 */
export const RING_SHRINK = 0.62

const SPECS: RingSpec[] = [
  { radius: 44, tiltX: 0.35, tiltY: 0.9, arcDeg: 200, width: 3.6, speed: 0.22, color: '#5BC8AF' },
  { radius: 47, tiltX: -0.5, tiltY: 0.3, arcDeg: 170, width: 3.2, speed: -0.18, color: '#4FA8E8' },
  { radius: 41, tiltX: 1.2, tiltY: 0.5, arcDeg: 220, width: 3.8, speed: 0.27, color: '#A66DE0' },
  { radius: 50, tiltX: 0.15, tiltY: -0.7, arcDeg: 150, width: 3.4, speed: -0.24, color: '#E8629E' },
  { radius: 43, tiltX: -1.0, tiltY: -0.35, arcDeg: 190, width: 4.0, speed: 0.2, color: '#E8735C' },
  { radius: 46, tiltX: 0.75, tiltY: 1.35, arcDeg: 160, width: 3.4, speed: -0.3, color: '#E0B84F' },
]

export const RINGS: Ring[] = SPECS.map((spec) => {
  const ca = Math.cos(spec.tiltX)
  const sa = Math.sin(spec.tiltX)
  const cb = Math.cos(spec.tiltY)
  const sb = Math.sin(spec.tiltY)
  const points: Ring['points'] = []
  for (let i = 0; i < SAMPLES; i++) {
    const th = (i / SAMPLES) * TAU
    let x = Math.cos(th) * spec.radius
    let y = Math.sin(th) * spec.radius
    let z = 0
    ;[y, z] = [y * ca - z * sa, y * sa + z * ca]
    ;[x, z] = [x * cb + z * sb, -x * sb + z * cb]
    points.push({ x: r2(x), y: r2(y), z })
  }
  return { ...spec, points, count: Math.round((spec.arcDeg / 360) * SAMPLES) }
})

/**
 * 取环上一段弧，按 z 正负劈成 [前, 后] 两条折线。
 * 换面时两段共用那个点，接缝才不会断出一个缺口。
 */
export function ringPaths(ring: Ring, phase: number): [string, string] {
  const start = Math.floor((((phase % 1) + 1) % 1) * SAMPLES)
  let front = ''
  let back = ''
  let sign = 0
  for (let k = 0; k <= ring.count; k++) {
    const p = ring.points[(start + k) % SAMPLES]
    const s = p.z >= 0 ? 1 : -1
    if (s !== sign) {
      if (sign !== 0) {
        if (s > 0) back += ` L${p.x} ${p.y}`
        else front += ` L${p.x} ${p.y}`
      }
      if (s > 0) front += ` M${p.x} ${p.y}`
      else back += ` M${p.x} ${p.y}`
      sign = s
    } else if (s > 0) front += ` L${p.x} ${p.y}`
    else back += ` L${p.x} ${p.y}`
  }
  return [front, back]
}

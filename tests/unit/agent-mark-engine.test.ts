import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  blendEye, circleProfile, eye, profilePath, radiusAtAngle, roundedSquareProfile, HALF, CORNER,
} from '../../src/renderer/src/components/agent-mark/geometry'
import { blendExpression, EXPRESSIONS, NEUTRAL } from '../../src/renderer/src/components/agent-mark/expressions'
import { RINGS, ringPaths } from '../../src/renderer/src/components/agent-mark/rings'
import { sample, staticFrame, STATE_EXPRESSION, type MarkClock } from '../../src/renderer/src/components/agent-mark/engine'

/**
 * 这份测试钉的是「换实现不许换外观」：中性态必须逐项等于品牌素材包那两个 rect。
 * 它**解析 resources/brand/agent-mark-source.svg 本身**，不抄一份期望值 ——
 * 谁动了那个文件而没同步代码，这里就会红。
 */
const BRAND_SVG = 'resources/brand/agent-mark-source.svg'

interface SourceRect { x: number; y: number; w: number; h: number; rx: number; deg: number }

function parseBrandEyes(): SourceRect[] {
  const svg = readFileSync(resolve(BRAND_SVG), 'utf8')
  const out: SourceRect[] = []
  const re = /<rect\s+x="([\d.]+)"\s+y="([\d.]+)"\s+width="([\d.]+)"\s+height="([\d.]+)"\s+rx="([\d.]+)"\s+transform="rotate\((-?[\d.]+)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(svg)) !== null) {
    out.push({ x: +m[1], y: +m[2], w: +m[3], h: +m[4], rx: +m[5], deg: +m[6] })
  }
  return out
}

/** rect 绕左上角转 → 中心坐标（相对瓷砖中心） */
function brandEyeCenter(r: SourceRect) {
  const rad = (r.deg * Math.PI) / 180
  const dx = r.w / 2
  const dy = r.h / 2
  return {
    cx: r.x + dx * Math.cos(rad) - dy * Math.sin(rad) - HALF,
    cy: r.y + dx * Math.sin(rad) + dy * Math.cos(rad) - HALF,
  }
}

describe('Agent Mark 几何', () => {
  it('中性眼逐项等于素材包 SVG 里的两个 rect', () => {
    const rects = parseBrandEyes()
    expect(rects).toHaveLength(2)
    for (const [i, e] of [NEUTRAL.l, NEUTRAL.r].entries()) {
      const r = rects[i]
      const c = brandEyeCenter(r)
      expect(e.cx).toBeCloseTo(c.cx, 9)
      expect(e.cy).toBeCloseTo(c.cy, 9)
      expect(e.L + e.w).toBe(r.h)   // 描边总高 = rect 高
      expect(e.w).toBe(r.w)         // 描边宽 = rect 宽
      expect(e.w / 2).toBe(r.rx)    // 圆头半径 = rx，所以是精确的胶囊不是近似
      expect(e.bend).toBe(0)
      expect(e.tilt).toBe(r.deg)
    }
  })

  it('圆角方外切于内接圆，所以眼睛永远不会被 mask 裁掉', () => {
    const profile = roundedSquareProfile()
    expect(Math.min(...profile)).toBeCloseTo(HALF, 4)
    expect(Math.max(...profile)).toBeCloseTo(Math.hypot(HALF - CORNER, HALF - CORNER) + CORNER, 3)
    // 每只眼的四角都要落在轮廓内（>1 即穿出）
    let worst = 0
    for (const e of [NEUTRAL.l, NEUTRAL.r]) {
      const a = (e.tilt * Math.PI) / 180
      for (const [sx, sy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
        const lx = (sx * e.w) / 2
        const ly = (sy * (e.L + e.w)) / 2
        const x = e.cx + lx * Math.cos(a) - ly * Math.sin(a)
        const y = e.cy + lx * Math.sin(a) + ly * Math.cos(a)
        worst = Math.max(worst, Math.hypot(x, y) / radiusAtAngle(profile, Math.atan2(y, x)))
      }
    }
    expect(worst).toBeLessThan(1)
  })

  it('剖面路径是闭合的，且圆形剖面退化成正圆', () => {
    expect(profilePath(roundedSquareProfile()).endsWith('Z')).toBe(true)
    const circle = circleProfile(10)
    expect(Math.max(...circle) - Math.min(...circle)).toBe(0)
  })
})

describe('表情插值', () => {
  it('两端点分别落回 from 与 to', () => {
    expect(blendExpression('neutral', 'happy', 0).l).toEqual(EXPRESSIONS.neutral.l)
    expect(blendExpression('neutral', 'happy', 1).r).toEqual(EXPRESSIONS.happy.r)
  })

  it('倾角走最短路，不绕远', () => {
    // 右眼 -18° → +20°：应该走 38°，不是 322°
    const mid = blendEye(EXPRESSIONS.neutral.r, EXPRESSIONS.angry.r, 0.5)
    expect(mid.tilt).toBeCloseTo(1, 4)
    // 反向也一样
    const back = blendEye(EXPRESSIONS.angry.r, EXPRESSIONS.neutral.r, 0.5)
    expect(back.tilt).toBeCloseTo(1, 4)
  })

  it('愤怒是内侧压低、难过是内侧抬高（曾经写反过）', () => {
    expect(EXPRESSIONS.angry.l.tilt).toBeLessThan(0)     // 左眼 \
    expect(EXPRESSIONS.angry.r.tilt).toBeGreaterThan(0)  // 右眼 /
    expect(EXPRESSIONS.sad.l.tilt).toBeGreaterThan(0)    // 左眼 /
    expect(EXPRESSIONS.sad.r.tilt).toBeLessThan(0)       // 右眼 \
  })

  it('发呆和专注落在两个不同的轴上，不靠几个单位区分', () => {
    const sleepy = EXPRESSIONS.sleepy.l
    const focused = EXPRESSIONS.focused.l
    expect(Math.abs(sleepy.tilt)).toBeGreaterThan(80)    // 横着
    expect(Math.abs(focused.tilt)).toBeLessThan(30)      // 竖着
    expect(focused.L).toBeLessThan(sleepy.L)             // 而且更短
  })

  it('每个状态都映射到一个已存在的表情', () => {
    for (const expr of Object.values(STATE_EXPRESSION)) expect(EXPRESSIONS[expr]).toBeDefined()
  })
})

describe('sample 是时间的纯函数', () => {
  const clock: MarkClock = {
    state: 'thinking', prevState: 'idle', expression: null, prevExpression: null, since: 0,
  }

  it('同一个 t 永远给同一帧（可重放，截图与单测不用和动画赛跑）', () => {
    expect(sample(1.37, clock)).toEqual(sample(1.37, clock))
    expect(sample(9.02, clock)).toEqual(sample(9.02, clock))
  })

  it('先跑到 t=5 再回读 t=1.37，结果不变（没有藏内部状态）', () => {
    const early = sample(1.37, clock)
    sample(5, clock)
    expect(sample(1.37, clock)).toEqual(early)
  })

  it('思考态中途身体不是方块，回到周期起点又是方块', () => {
    expect(sample(1.4, clock).body).not.toBe(sample(0, clock).body)
    expect(sample(2.8, clock).body).toBe(sample(0, clock).body)
  })

  it('执行态会缩一档给彩环让位', () => {
    const gen: MarkClock = { ...clock, state: 'generating', since: 0 }
    expect(sample(0, gen).scale).toBeCloseTo(1, 3)
    expect(sample(2, gen).scale).toBeLessThan(0.7)
    expect(sample(2, gen).ringAlpha).toBeCloseTo(1, 3)
  })

  it('静止帧不带任何动效', () => {
    const f = staticFrame()
    expect(f.dots).toHaveLength(0)
    expect(f.ringAlpha).toBe(0)
    expect(f.eyeSquash).toBe(1)
  })
})

describe('彩环', () => {
  it('每条环都被 z 劈成前后两段，合起来盖满整段弧', () => {
    for (const ring of RINGS) {
      const [front, back] = ringPaths(ring, 0.3)
      const pts = (s: string): number => (s.match(/[ML]/g) ?? []).length
      // 接缝点被两段共用，所以总点数 = 弧上点数 + 换面次数
      expect(pts(front) + pts(back)).toBeGreaterThanOrEqual(ring.count + 1)
      expect(front.length + back.length).toBeGreaterThan(0)
    }
  })

  it('环点表在载入时算好，z 是常数（每帧零三角函数的前提）', () => {
    for (const ring of RINGS) {
      expect(ring.points).toHaveLength(72)
      expect(ring.points.some((p) => p.z > 0)).toBe(true)
      expect(ring.points.some((p) => p.z < 0)).toBe(true)
    }
  })
})

/**
 * 头像轮廓与导出取景框：
 *   六种轮廓都是同一套 64 根射线上的半径（形状之间照样能 morph），左右对称，都装得进合理的盒子；
 *   engine 按 clock.shape 出不同的身体路径，方是老样子（品牌素材不变）；
 *   导出取景框按实际边界撑成正方形——配饰挂在身体外沿，固定 ±32 会裁掉（所有者实撞）。
 */
import { describe, expect, it } from 'vitest'
import {
  HALF, MARK_SHAPES, SAMPLES, isMarkShape, profilePath, roundedSquareProfile, shapeProfile,
} from '../../src/renderer/src/components/agent-mark/geometry'
import { neutralBody, sample, staticFrame } from '../../src/renderer/src/components/agent-mark/engine'
import { exportViewBox } from '../../src/renderer/src/components/agent-mark/AgentMarkStudio'

describe('轮廓剖面', () => {
  it('六种轮廓各 64 个半径，都在 (0, 1.5·HALF] 内（圆角方的对角就到 41），左右对称', () => {
    for (const shape of MARK_SHAPES) {
      const radii = shapeProfile(shape)
      expect(radii, shape).toHaveLength(SAMPLES)
      for (const r of radii) {
        expect(r, shape).toBeGreaterThan(0)
        expect(r, shape).toBeLessThanOrEqual(HALF * 1.5)
      }
      // 射线 i 与 (SAMPLES - i) 关于 x 轴对称；上下不必对称（水滴、三角本来就上下不同）
      for (let i = 1; i < SAMPLES / 2; i++) {
        const mirrored = radii[SAMPLES - i]
        // 关于 x 轴对称 = 上下镜像；这里要的是左右镜像：i ↔ SAMPLES/2 - i（关于 y 轴）
        const leftRight = radii[(SAMPLES / 2 - i + SAMPLES) % SAMPLES]
        expect(Math.abs(radii[i] - leftRight), `${shape}@${i}`).toBeLessThan(1e-6)
        void mirrored
      }
    }
  })

  it('方就是原来的圆角方（品牌素材不变）；别的轮廓路径各不相同', () => {
    expect(shapeProfile('square')).toEqual(roundedSquareProfile())
    const paths = new Set(MARK_SHAPES.map((shape) => profilePath(shapeProfile(shape))))
    expect(paths.size).toBe(MARK_SHAPES.length)
    // 盾牌上宽下窄（眼睛固定在上半身，窄的一头只能朝下）；三角同理顶点朝下
    const drop = shapeProfile('drop')
    const top = drop[Math.round(SAMPLES * 3 / 4)]
    const bottom = drop[Math.round(SAMPLES / 4)]
    expect(top).toBeGreaterThan(bottom)
    const tri = shapeProfile('triangle')
    expect(tri[Math.round(SAMPLES / 4)]).toBeGreaterThan(tri[Math.round(SAMPLES * 3 / 4)])
  })

  it('isMarkShape 只认六个名字', () => {
    for (const shape of MARK_SHAPES) expect(isMarkShape(shape)).toBe(true)
    expect(isMarkShape('blob')).toBe(false)
    expect(isMarkShape(undefined)).toBe(false)
  })
})

describe('engine 按轮廓出身体', () => {
  it('静止帧与动画帧都跟着 clock.shape 走；不给就是方', () => {
    expect(staticFrame('neutral').body).toBe(neutralBody('square'))
    expect(staticFrame('neutral', 'circle').body).toBe(neutralBody('circle'))
    const cloud = sample(3.3, { state: 'idle', prevState: 'idle', expression: null, prevExpression: null, since: 0, shape: 'cloud' })
    expect(cloud.body).toBe(neutralBody('cloud'))
    // 思考态身体缩成一颗点：从云朵出发也能 morph（同一套采样角度）
    const thinking = sample(1.2, { state: 'thinking', prevState: 'idle', expression: null, prevExpression: null, since: 0, shape: 'cloud' })
    expect(thinking.body).not.toBe(neutralBody('cloud'))
    expect(thinking.body.startsWith('M')).toBe(true)
  })
})

describe('导出取景框', () => {
  it('按实际边界撑成正方形并留边；没配饰时不小于 ±32', () => {
    expect(exportViewBox({ x: -32, y: -32, width: 64, height: 64 })).toBe('-35 -35 70 70')
    // 配饰挂在右上：边界 -32..46 × -40..32 → 以中心 (7, -4) 撑成 84 的正方形
    expect(exportViewBox({ x: -32, y: -40, width: 78, height: 72 })).toBe('-35 -46 84 84')
    // 比本体还小的边界（理论上不会）也不缩到 64 以下
    expect(exportViewBox({ x: -10, y: -10, width: 20, height: 20 })).toBe('-35 -35 70 70')
  })
})

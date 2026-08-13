/**
 * 通用宽度适配纯计算——单测求值与 BRIDGE_SCRIPT 注入完全同一份源码字符串,
 * 锁定:响应式免缩、宽内容等比缩宽、0.25 下限、1 上限、±0.01 迟滞、零值守卫。
 */
import { describe, it, expect } from 'vitest'
import { PREVIEW_FIT_SOURCE } from '../../src/renderer/src/components/artifacts/previewFitSource'

const computeFitZoom = new Function(`${PREVIEW_FIT_SOURCE}; return __computeFitZoom`)() as
  (sw: number, iw: number, cur: number) => number

describe('__computeFitZoom', () => {
  it('响应式内容(scrollWidth≈innerWidth)恒 1', () => {
    expect(computeFitZoom(480, 480, 1)).toBe(1)
    expect(computeFitZoom(486, 480, 1)).toBe(1) // +8px 容差内
  })

  it('固定宽内容按宽度等比缩,封顶 1 下限 0.25', () => {
    expect(computeFitZoom(1600, 480, 1)).toBeCloseTo(0.3, 5)
    expect(computeFitZoom(10000, 480, 1)).toBe(0.25) // 下限
    expect(computeFitZoom(300, 480, 1)).toBe(1) // 内容比容器窄不放大
  })

  it('面板拉宽后恢复 100%', () => {
    expect(computeFitZoom(1600, 1700, 0.3)).toBe(1)
  })

  it('±0.01 迟滞:近似值返回当前 zoom 不写样式', () => {
    const cur = 0.3
    expect(computeFitZoom(1600, 483, cur)).toBe(cur) // 483/1600≈0.302,差 <0.01
  })

  it('零值守卫:测量不可用时维持现状', () => {
    expect(computeFitZoom(0, 480, 0.5)).toBe(0.5)
    expect(computeFitZoom(1600, 0, 0.7)).toBe(0.7)
  })
})

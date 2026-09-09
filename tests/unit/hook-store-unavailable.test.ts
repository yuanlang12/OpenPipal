/**
 * 规则清单在拿不到清单的端（浏览器插件：没有 /api/hooks，listHooks 返回 null）不能停在转圈：
 * 评审抓到——插件里点胶囊上的「查看」跳到规则页，页面永远是加载态。store 要把"拿不到"记成一个明确状态。
 */
import { describe, expect, it, vi } from 'vitest'

describe('hookStore：拿不到清单的端', () => {
  it('listHooks 返回 null → unavailable，不算 loaded；之后拿到数组则恢复', async () => {
    let answer: unknown = null
    ;(globalThis as any).window = { api: { listHooks: vi.fn(async () => answer) } }
    const { useHookStore } = await import('../../src/renderer/src/stores/hookStore')
    await useHookStore.getState().refresh()
    expect(useHookStore.getState()).toMatchObject({ loaded: false, unavailable: true, loading: false })

    answer = []
    await useHookStore.getState().refresh()
    expect(useHookStore.getState()).toMatchObject({ loaded: true, unavailable: false, entries: [] })
  })

  it('preload 根本没有 listHooks → 也是 unavailable', async () => {
    vi.resetModules()
    ;(globalThis as any).window = { api: {} }
    const { useHookStore } = await import('../../src/renderer/src/stores/hookStore')
    await useHookStore.getState().refresh()
    expect(useHookStore.getState().unavailable).toBe(true)
  })
})

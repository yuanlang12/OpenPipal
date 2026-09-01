/**
 * 上下文预留跟随真实提示词长度（Phase 0）
 *
 * 修的是：MAX_RESERVE_TOKENS = 32000 是编译期常量，`reserve = min(32000, window/2)`
 * **与实际 systemPrompt 长度完全脱钩**。提示词一旦变大（典型来源：注入项目的
 * AGENTS.md、大量 MCP 工具 schema），真实占用越过 32k 之后压缩器仍以为历史预算充足、
 * 于是不压缩——直到实测用量或 stopReason=length 才反应过来，那时整轮已经废了。
 *
 * 方向是**只增不减**：实测开销小于固定预留时维持原值，避免把历史预算抬到没验证过的范围。
 */
import { describe, expect, it, vi } from 'vitest'
import { getContextBudget } from '../../src/main/history-compactor'

const W = 200_000

describe('getContextBudget 的预留', () => {
  it('不传实测开销时行为不变（回归基线）', () => {
    expect(getContextBudget({ contextWindow: W })).toEqual({ contextWindow: W, budget: W - 32_000 })
    // 低上下文模型仍然按窗口一半封顶
    expect(getContextBudget({ contextWindow: 32_000 })).toEqual({ contextWindow: 32_000, budget: 16_000 })
    expect(getContextBudget({ contextWindow: 8_000 })).toEqual({ contextWindow: 8_000, budget: 4_000 })
  })

  it('实测开销小于固定预留时不缩水——只增不减', () => {
    const { budget } = getContextBudget({ contextWindow: W }, 5_000)
    expect(budget).toBe(W - 32_000)
  })

  it('实测开销越过固定预留时，预留跟着涨、历史预算跟着缩', () => {
    // 一份 ~15000 token 的 AGENTS.md + 工具 schema
    const overhead = 40_000
    const { budget } = getContextBudget({ contextWindow: W }, overhead)
    expect(budget).toBe(W - (overhead + 8_192))
    // 关键不变量：比不传时更保守，绝不更乐观
    expect(budget).toBeLessThan(getContextBudget({ contextWindow: W }).budget)
  })

  it('提示词吃掉半个窗口时钳到一半，并把证据打出来', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const { budget } = getContextBudget({ contextWindow: W }, 150_000)
      expect(budget).toBe(W - W / 2)
      // 压缩再狠也救不回来——这种情况必须留下可行动的日志，不能静默钳完了事
      expect(warn).toHaveBeenCalled()
      expect(String(warn.mock.calls[0][0])).toContain('超过模型窗口')
    } finally {
      warn.mockRestore()
    }
  })

  it('非法/零/负数的实测值被忽略，回落固定预留', () => {
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(getContextBudget({ contextWindow: W }, bad as number).budget).toBe(W - 32_000)
    }
  })
})

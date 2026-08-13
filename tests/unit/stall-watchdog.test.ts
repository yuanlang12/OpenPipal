/**
 * 静默看门狗语义锁。
 *
 * 这三条是"别把正常等待误杀"和"别让停摆无声"的分界线，改动前先想清楚：
 *   ① 模型事件续命 → 长回答/长推理不被误杀
 *   ② 工具执行期间撤弦 → bash/subagent/权限气泡的正常静默不算停摆
 *   ③ 触发后上锁 → 迟到事件复活不了已判定停摆的一轮
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  createStallWatchdog,
  DEFAULT_MODEL_STALL_TIMEOUT_MS,
  resolveModelStallTimeoutMs
} from '../../src/main/stall-watchdog'

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('静默看门狗', () => {
  it('两个 Runtime 共享 60 秒默认值，且保留环境变量覆盖/关闭语义', () => {
    expect(DEFAULT_MODEL_STALL_TIMEOUT_MS).toBe(60_000)
    expect(resolveModelStallTimeoutMs(undefined)).toBe(60_000)
    expect(resolveModelStallTimeoutMs('75000')).toBe(75_000)
    expect(resolveModelStallTimeoutMs('0')).toBe(0)
    expect(resolveModelStallTimeoutMs('-1')).toBe(0)
    expect(resolveModelStallTimeoutMs('invalid')).toBe(60_000)
  })

  it('超时无事件 → 触发', () => {
    const onStall = vi.fn()
    const wd = createStallWatchdog(1000, onStall)
    wd.arm()
    vi.advanceTimersByTime(999)
    expect(onStall).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(onStall).toHaveBeenCalledTimes(1)
    expect(wd.fired).toBe(true)
  })

  it('持续来事件 → 一直续命，永不触发（长回答不被误杀）', () => {
    const onStall = vi.fn()
    const wd = createStallWatchdog(1000, onStall)
    wd.arm()
    for (let i = 0; i < 10; i++) {
      vi.advanceTimersByTime(900)
      wd.arm()
    }
    expect(onStall).not.toHaveBeenCalled()
  })

  it('工具执行期间撤弦 → 跑多久都不算停摆', () => {
    const onStall = vi.fn()
    const wd = createStallWatchdog(1000, onStall)
    wd.arm()
    wd.disarm()                      // tool_execution_start
    vi.advanceTimersByTime(60_000)   // 一分钟的 bash / 等权限
    expect(onStall).not.toHaveBeenCalled()
    wd.arm()                         // tool_execution_end 后重新上弦
    vi.advanceTimersByTime(1000)
    expect(onStall).toHaveBeenCalledTimes(1)
  })

  it('触发后上锁：arm 不再续命，也不会重复触发', () => {
    const onStall = vi.fn()
    const wd = createStallWatchdog(1000, onStall)
    wd.arm()
    vi.advanceTimersByTime(1000)
    expect(onStall).toHaveBeenCalledTimes(1)
    wd.arm()
    vi.advanceTimersByTime(10_000)
    expect(onStall).toHaveBeenCalledTimes(1)
  })

  it('timeoutMs<=0 → 看门狗关闭（环境变量旋钮）', () => {
    const onStall = vi.fn()
    const wd = createStallWatchdog(0, onStall)
    wd.arm()
    vi.advanceTimersByTime(600_000)
    expect(onStall).not.toHaveBeenCalled()
    expect(wd.fired).toBe(false)
  })
})

/**
 * 规则借助手的工具（ctx.callTool）——宿主实现的四条保证：
 *   1. 参数按工具 schema 校验，不合法直接抛，不碰安全员也不碰工具
 *   2. 走同一个 authorizeToolCall（同一份授权选项、同一个信号），拒绝就抛错并留日志
 *   3. 放行才 execute；工具抛错折成 isError 结果（同 Agent 循环的口径）
 *   4. 信号已 abort 时不执行
 */
import { Type } from 'typebox'
import type { AgentTool } from '@earendil-works/pi-agent-core'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const security = vi.hoisted(() => ({ authorizeToolCall: vi.fn() }))
vi.mock('../../src/main/pi-security', () => ({ authorizeToolCall: security.authorizeToolCall }))

import { createHookToolCaller } from '../../src/main/hooks/hook-tool-bridge'

function bashTool(execute: AgentTool['execute']): AgentTool {
  return {
    name: 'bash',
    label: 'Bash',
    description: 'run',
    parameters: Type.Object({ command: Type.String(), timeout: Type.Optional(Type.Number()) }),
    execute
  } as unknown as AgentTool
}

describe('createHookToolCaller', () => {
  const authorization = { conversationId: 'conv', tier: 'auto' as const }
  beforeEach(() => {
    security.authorizeToolCall.mockReset()
    security.authorizeToolCall.mockResolvedValue(undefined)
  })

  it('放行 → 执行 → 结果原样回；审核拿到的是校验后的参数和同一个信号', async () => {
    const execute = vi.fn(async () => ({ content: [{ type: 'text', text: 'ok' }], details: { code: 0 } }))
    const logs: unknown[] = []
    const call = createHookToolCaller({ tools: [bashTool(execute)], authorization, onCall: (l) => logs.push(l) })
    const signal = new AbortController().signal
    const result = await call('bash', { command: 'pytest -q' }, signal)
    expect(result).toEqual({ content: [{ type: 'text', text: 'ok' }], details: { code: 0 }, isError: false })
    expect(security.authorizeToolCall).toHaveBeenCalledWith('bash', { command: 'pytest -q' }, authorization, signal)
    expect(execute).toHaveBeenCalledWith(expect.stringMatching(/^hook-\d+-1$/), { command: 'pytest -q' }, signal, expect.any(Function))
    expect(logs).toEqual([expect.objectContaining({ toolName: 'bash' })])
  })

  it('参数不合法：抛错，安全员和工具都不被调用', async () => {
    const execute = vi.fn()
    const call = createHookToolCaller({ tools: [bashTool(execute)], authorization })
    // 注意 Agent 同款校验器会把 42 转成 "42"（Value.Convert），所以"不合法"得用缺必填字段来验
    await expect(call('bash', { timeout: 5 }, new AbortController().signal)).rejects.toThrow(/参数不合法/)
    await expect(call('bash', [] as unknown as Record<string, unknown>, new AbortController().signal)).rejects.toThrow(/必须是对象/)
    expect(security.authorizeToolCall).not.toHaveBeenCalled()
    expect(execute).not.toHaveBeenCalled()
  })

  it('没有这个工具：抛错点名', async () => {
    const call = createHookToolCaller({ tools: [], authorization })
    await expect(call('bash', { command: 'ls' }, new AbortController().signal)).rejects.toThrow(/没有叫「bash」的工具/)
  })

  it('安全员拒绝：抛错带原因、留日志、不执行', async () => {
    security.authorizeToolCall.mockResolvedValue({ block: true, reason: '越界' })
    const execute = vi.fn()
    const logs: Array<{ blocked?: string }> = []
    const call = createHookToolCaller({ tools: [bashTool(execute)], authorization, onCall: (l) => logs.push(l) })
    await expect(call('bash', { command: 'cat ~/.ssh/id_rsa' }, new AbortController().signal)).rejects.toThrow(/被安全员拒绝：越界/)
    expect(execute).not.toHaveBeenCalled()
    expect(logs[0]?.blocked).toBe('越界')
  })

  it('参数按 Agent 同一套校验器转换（"30" → 30），且执行拿到的是克隆，规则之后再改自己那份也无妨', async () => {
    const execute = vi.fn(async () => ({ content: [], details: {} }))
    const call = createHookToolCaller({ tools: [bashTool(execute)], authorization })
    const input: Record<string, unknown> = { command: 'ls', timeout: '30' }
    await call('bash', input, new AbortController().signal)
    const executed = execute.mock.calls[0][1] as Record<string, unknown>
    expect(executed).toEqual({ command: 'ls', timeout: 30 })
    expect(executed).not.toBe(input)
  })

  it('工具用 details 说"其实失败了"（isError/error/subagent）时，规则看到的 isError 与 Agent 口径一致', async () => {
    const call = createHookToolCaller({ tools: [bashTool(async () => ({ content: [{ type: 'text', text: '[错误] x' }], details: { isError: true } }))], authorization })
    const result = await call('bash', { command: 'false' }, new AbortController().signal)
    expect(result.isError).toBe(true)
    const sub = createHookToolCaller({ tools: [bashTool(async () => ({ content: [], details: { subagent: { status: 'error' } } }))], authorization })
    expect((await sub('bash', { command: 'x' }, new AbortController().signal)).isError).toBe(true)
  })

  it('工具抛错折成 isError 结果，不向规则抛', async () => {
    const call = createHookToolCaller({ tools: [bashTool(async () => { throw new Error('exit 1') })], authorization })
    const result = await call('bash', { command: 'false' }, new AbortController().signal)
    expect(result).toEqual({ content: [{ type: 'text', text: 'exit 1' }], details: undefined, isError: true })
  })

  it('信号已 abort：不审也不执行', async () => {
    const execute = vi.fn()
    const call = createHookToolCaller({ tools: [bashTool(execute)], authorization })
    const aborted = new AbortController()
    aborted.abort()
    await expect(call('bash', { command: 'ls' }, aborted.signal)).rejects.toThrow(/已取消/)
    expect(security.authorizeToolCall).not.toHaveBeenCalled()
    expect(execute).not.toHaveBeenCalled()
  })
})

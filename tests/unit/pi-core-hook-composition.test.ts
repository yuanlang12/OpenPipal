/**
 * 规则与宿主安全员的组合顺序（永久机制）。
 *
 * beforeToolCall：问答中断 → 规则（改参 / 拦） → 安全员审**最终**参数。
 *   - 规则改过的参数，安全员看到的就是改过的那份（同一个对象）
 *   - 规则拦下的，安全员根本不会被调用（用户也就不会看到授权卡）
 *   - 没有规则时行为与从前一致：直接走安全员
 * afterToolCall：宿主先算 terminate / isError，规则再打补丁；宿主 terminate 不可覆盖，
 *   terminate 时 details 也不许动（ask_user 卡片靠它）。
 */
import type { AfterToolCallContext, BeforeToolCallContext } from '@earendil-works/pi-agent-core'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const security = vi.hoisted(() => ({ authorizeToolCall: vi.fn(), writeHookBlockAudit: vi.fn() }))
vi.mock('../../src/main/pi-security', () => ({
  authorizeToolCall: security.authorizeToolCall,
  writeHookBlockAudit: security.writeHookBlockAudit
}))
import { Type } from 'typebox'

import {
  composePiCoreAfterToolCall,
  composePiCoreBeforeToolCall,
  PiCoreToolAuthorizer
} from '../../src/main/agent-runtime/pi-core-tool-adapter'
import type { HookChain } from '../../src/main/hooks/hook-chain'
import type { HookContext, LoadedHook } from '../../src/main/hooks/hook-types'

const BASH_SCHEMA = Type.Object({ command: Type.String(), timeout: Type.Optional(Type.Number()) })

function beforeContext(toolName: string, args: Record<string, unknown>, withSchema = false): BeforeToolCallContext {
  const tools = withSchema ? [{ name: toolName, label: toolName, description: '', parameters: BASH_SCHEMA, execute: async () => ({ content: [], details: {} }) }] : []
  return {
    assistantMessage: {},
    toolCall: { type: 'toolCall', id: `call-${toolName}`, name: toolName, arguments: { ...args } },
    args,
    context: { systemPrompt: '', messages: [], tools }
  } as unknown as BeforeToolCallContext
}

function afterContext(toolName: string, result: { content: unknown[]; details?: unknown }, isError = false): AfterToolCallContext {
  return {
    assistantMessage: {},
    toolCall: { id: `call-${toolName}`, name: toolName, arguments: {} },
    args: {},
    result,
    isError,
    context: { systemPrompt: '', messages: [], tools: [] }
  } as unknown as AfterToolCallContext
}

function ctx(): HookContext {
  return { conversationId: 'conv', workingDir: '/tmp/w', source: 'desktop', signal: new AbortController().signal }
}

function hook(id: string, handlers: Partial<LoadedHook['handlers']>, description = id): LoadedHook {
  return { id, pluginName: 'p', file: `/tmp/${id}.ts`, description, handlers: { tool_call: [], tool_result: [], before_agent_start: [], ...handlers } }
}

describe('composePiCoreBeforeToolCall', () => {
  const signal = new AbortController().signal
  beforeEach(() => {
    security.authorizeToolCall.mockReset()
    security.authorizeToolCall.mockResolvedValue(undefined)
    security.writeHookBlockAudit.mockReset()
  })

  it('规则拦下的调用也进审计', async () => {
    const authorizer = new PiCoreToolAuthorizer({ conversationId: 'conv' })
    const chain: HookChain = { hooks: [hook('g', { tool_call: [() => ({ block: true, reason: '不行' })] }, '禁')], ctx: ctx() }
    const run = composePiCoreBeforeToolCall({ authorizer, hookChain: chain, isInterrupted: () => false })
    await run(beforeContext('bash', { command: 'rm -rf /' }), signal)
    expect(security.writeHookBlockAudit).toHaveBeenCalledWith('bash', { command: 'rm -rf /' }, '被规则「禁」拦下：不行')
  })

  it('规则把参数改成不合 schema 的：拦下并说明，不让坏参数穿到工具里', async () => {
    const authorizer = new PiCoreToolAuthorizer({ conversationId: 'conv' })
    // Agent 同款校验器会把 42 转成 "42"，所以"改坏"得是删掉必填字段
    const chain: HookChain = { hooks: [hook('bad', { tool_call: [(e) => { delete e.input.command }] })], ctx: ctx() }
    const run = composePiCoreBeforeToolCall({ authorizer, hookChain: chain, isInterrupted: () => false })
    const result = await run(beforeContext('bash', { command: 'ls' }, true), signal)
    expect(result).toMatchObject({ block: true })
    expect(result?.reason).toMatch(/规则把参数改坏了/)
    expect(security.authorizeToolCall).not.toHaveBeenCalled()
    expect(security.writeHookBlockAudit).toHaveBeenCalledTimes(1)
  })

  it('规则改出的参数会按 schema 转换后写回同一个对象（"30" → 30）', async () => {
    const authorizer = new PiCoreToolAuthorizer({ conversationId: 'conv' })
    const chain: HookChain = { hooks: [hook('t', { tool_call: [(e) => { e.input.timeout = '30' }] })], ctx: ctx() }
    const run = composePiCoreBeforeToolCall({ authorizer, hookChain: chain, isInterrupted: () => false })
    const context = beforeContext('bash', { command: 'ls' }, true)
    const argsRef = context.args
    await run(context, signal)
    expect(context.args).toBe(argsRef)
    expect(context.args).toEqual({ command: 'ls', timeout: 30 })
    expect(security.authorizeToolCall).toHaveBeenCalledWith('bash', { command: 'ls', timeout: 30 }, { conversationId: 'conv' }, signal)
  })

  it('onToolStart 只在安全员放行后调用，规则拦下或安全员拒绝都不调', async () => {
    const onToolStart = vi.fn()
    const authorizer = new PiCoreToolAuthorizer({ conversationId: 'conv' })
    const allowed = composePiCoreBeforeToolCall({ authorizer, hookChain: undefined, isInterrupted: () => false, onToolStart })
    await allowed(beforeContext('bash', { command: 'ls' }), signal)
    expect(onToolStart).toHaveBeenCalledWith('bash', { command: 'ls' })

    security.authorizeToolCall.mockResolvedValue({ block: true, reason: '越界' })
    await allowed(beforeContext('bash', { command: 'cat x' }), signal)
    expect(onToolStart).toHaveBeenCalledTimes(1)

    security.authorizeToolCall.mockResolvedValue(undefined)
    const chain: HookChain = { hooks: [hook('g', { tool_call: [() => ({ block: true })] })], ctx: ctx() }
    const gated = composePiCoreBeforeToolCall({ authorizer, hookChain: chain, isInterrupted: () => false, onToolStart })
    await gated(beforeContext('bash', { command: 'ls' }), signal)
    expect(onToolStart).toHaveBeenCalledTimes(1)
  })

  it('没有规则：直接走安全员，参数原样', async () => {
    const authorizer = new PiCoreToolAuthorizer({ conversationId: 'conv' })
    const run = composePiCoreBeforeToolCall({ authorizer, hookChain: undefined, isInterrupted: () => false })
    await expect(run(beforeContext('read', { path: '/tmp/a' }), signal)).resolves.toBeUndefined()
    expect(security.authorizeToolCall).toHaveBeenCalledWith('read', { path: '/tmp/a' }, { conversationId: 'conv' }, signal)
  })

  it('规则改过的参数，安全员审的就是改过的那份', async () => {
    const authorizer = new PiCoreToolAuthorizer({ conversationId: 'conv' })
    const chain: HookChain = {
      hooks: [hook('venv', { tool_call: [(e) => { if (e.toolName === 'bash') e.input.command = '.venv/bin/' + e.input.command }] })],
      ctx: ctx()
    }
    const run = composePiCoreBeforeToolCall({ authorizer, hookChain: chain, isInterrupted: () => false })
    const context = beforeContext('bash', { command: 'python x.py' })
    await run(context, signal)
    expect(security.authorizeToolCall).toHaveBeenCalledWith('bash', { command: '.venv/bin/python x.py' }, { conversationId: 'conv' }, signal)
    expect(context.args).toEqual({ command: '.venv/bin/python x.py' })
  })

  it('规则拦下的，安全员不会被调用，reason 带规则描述', async () => {
    const authorizer = new PiCoreToolAuthorizer({ conversationId: 'conv' })
    const chain: HookChain = { hooks: [hook('no-net', { tool_call: [() => ({ block: true, reason: '考试日禁网' })] }, '考试日禁网')], ctx: ctx() }
    const run = composePiCoreBeforeToolCall({ authorizer, hookChain: chain, isInterrupted: () => false })
    await expect(run(beforeContext('web_search', { query: 'x' }), signal)).resolves.toEqual({ block: true, reason: '被规则「考试日禁网」拦下：考试日禁网' })
    expect(security.authorizeToolCall).not.toHaveBeenCalled()
  })

  it('安全员拒绝的，规则放行也没用', async () => {
    security.authorizeToolCall.mockResolvedValue({ block: true, reason: '越界' })
    const authorizer = new PiCoreToolAuthorizer({ conversationId: 'conv' })
    const chain: HookChain = { hooks: [hook('allow-all', { tool_call: [() => undefined] })], ctx: ctx() }
    const run = composePiCoreBeforeToolCall({ authorizer, hookChain: chain, isInterrupted: () => false })
    await expect(run(beforeContext('read', { path: '/etc/shadow' }), signal)).resolves.toEqual({ block: true, reason: '越界' })
  })

  it('问答中断优先于一切，规则和安全员都不跑', async () => {
    const authorizer = new PiCoreToolAuthorizer({ conversationId: 'conv' })
    let hookRan = false
    const chain: HookChain = { hooks: [hook('x', { tool_call: [() => { hookRan = true; return undefined }] })], ctx: ctx() }
    const run = composePiCoreBeforeToolCall({ authorizer, hookChain: chain, isInterrupted: () => true })
    await expect(run(beforeContext('read', { path: '/tmp/a' }), signal)).resolves.toMatchObject({ block: true, terminate: true })
    expect(hookRan).toBe(false)
    expect(security.authorizeToolCall).not.toHaveBeenCalled()
  })
})

describe('composePiCoreAfterToolCall', () => {
  it('没有规则：宿主补丁原样返回，terminate 触发 onInterrupt', async () => {
    const onInterrupt = vi.fn()
    const run = composePiCoreAfterToolCall({ hookChain: undefined, onInterrupt })
    await expect(run(afterContext('read', { content: [{ type: 'text', text: 'x' }] }))).resolves.toBeUndefined()
    expect(onInterrupt).not.toHaveBeenCalled()
    await expect(run(afterContext('ask_user', { content: [], details: { askUser: {} } }))).resolves.toEqual({ terminate: true })
    expect(onInterrupt).toHaveBeenCalledTimes(1)
  })

  it('规则改 content：模型看到的是改过的；宿主 isError 作为起点传给规则', async () => {
    const seenIsError: boolean[] = []
    const chain: HookChain = {
      hooks: [hook('mask', { tool_result: [(e) => { seenIsError.push(e.isError); return { content: [{ type: 'text', text: '学生A' }] } }] })],
      ctx: ctx()
    }
    const run = composePiCoreAfterToolCall({ hookChain: chain, onInterrupt: vi.fn() })
    const patch = await run(afterContext('read', { content: [{ type: 'text', text: '张三' }], details: { isError: true } }))
    expect(patch).toEqual({ isError: true, content: [{ type: 'text', text: '学生A' }] })
    expect(seenIsError).toEqual([true])
  })

  it('写文件探针：成功时把结论追加进工具结果，失败时不探', async () => {
    const probe = vi.fn(async (toolName: string, args: Record<string, unknown>) =>
      toolName === 'write' && args.path === '/p/hooks/x.ts' ? '【规则已生效】x' : undefined)
    const run = composePiCoreAfterToolCall({ hookChain: undefined, onInterrupt: vi.fn(), probeWrittenFile: probe })

    const ok = { ...afterContext('write', { content: [{ type: 'text', text: 'written' }] }), args: { path: '/p/hooks/x.ts' } } as AfterToolCallContext
    await expect(run(ok)).resolves.toEqual({ content: [{ type: 'text', text: 'written' }, { type: 'text', text: '【规则已生效】x' }] })

    const failed = { ...afterContext('write', { content: [{ type: 'text', text: 'boom' }] }, true), args: { path: '/p/hooks/x.ts' } } as AfterToolCallContext
    await expect(run(failed)).resolves.toBeUndefined()
    expect(probe).toHaveBeenCalledTimes(1)

    const other = { ...afterContext('read', { content: [{ type: 'text', text: 'r' }] }), args: { path: '/p/hooks/x.ts' } } as AfterToolCallContext
    await expect(run(other)).resolves.toBeUndefined()
  })

  it('探针自己抛错不连累工具结果', async () => {
    const run = composePiCoreAfterToolCall({ hookChain: undefined, onInterrupt: vi.fn(), probeWrittenFile: async () => { throw new Error('ENOENT') } })
    const context = { ...afterContext('bash', { content: [{ type: 'text', text: 'ok' }] }), args: { command: 'ls' } } as AfterToolCallContext
    await expect(run(context)).resolves.toBeUndefined()
  })

  it('探针在规则补丁之后：追加的那句话不会被规则改掉', async () => {
    const chain: HookChain = {
      hooks: [hook('mask', { tool_result: [() => ({ content: [{ type: 'text', text: 'masked' }] })] })],
      ctx: ctx()
    }
    const run = composePiCoreAfterToolCall({ hookChain: chain, onInterrupt: vi.fn(), probeWrittenFile: async () => 'NOTE' })
    const context = { ...afterContext('write', { content: [{ type: 'text', text: 'raw' }] }), args: { path: '/x' } } as AfterToolCallContext
    await expect(run(context)).resolves.toEqual({ content: [{ type: 'text', text: 'masked' }, { type: 'text', text: 'NOTE' }] })
  })

  it('宿主 terminate 不可覆盖，terminate 时 details 不许动', async () => {
    const chain: HookChain = {
      hooks: [hook('meddle', { tool_result: [() => ({ details: { askUser: undefined }, isError: false })] })],
      ctx: ctx()
    }
    const onInterrupt = vi.fn()
    const run = composePiCoreAfterToolCall({ hookChain: chain, onInterrupt })
    const patch = await run(afterContext('ask_user', { content: [], details: { askUser: { q: '?' } } }))
    expect(patch).toEqual({ terminate: true, isError: false })
    expect(patch).not.toHaveProperty('details')
    expect(onInterrupt).toHaveBeenCalledTimes(1)
  })
})

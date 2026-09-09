/**
 * hook-chain 单测——串行语义与 fail-open。
 *
 * tool_call：原地改参流到后面的 handler；第一个 block 赢且 reason 带规则描述。
 * tool_result：部分补丁按字段替换，后面的 handler 看到前面改过的；非法 content 被忽略并上报。
 * before_agent_start：系统提示逐个串起来。
 * 可靠性：抛错 / 超时 的 handler 被跳过并上报，链继续；已 abort 的信号直接不跑。
 */
import { describe, it, expect, vi } from 'vitest'
import {
  runBeforeAgentStartHooks,
  runToolCallHooks,
  runToolResultHooks,
  hasHandlers,
  type HookChain
} from '../../src/main/hooks/hook-chain'
import type { HookContext, HookHandler, HookRunError, LoadedHook } from '../../src/main/hooks/hook-types'

function ctx(signal = new AbortController().signal): HookContext {
  return { conversationId: 'conv', workingDir: '/tmp/w', roleName: 'default', source: 'desktop', signal }
}

function hook(id: string, handlers: Partial<LoadedHook['handlers']>, description = id): LoadedHook {
  return {
    id, pluginName: 'p', file: `/tmp/${id}.ts`, description,
    handlers: { tool_call: [], tool_result: [], before_agent_start: [], ...handlers }
  }
}

function chain(hooks: LoadedHook[], extra: Partial<HookChain> = {}): HookChain & { errors: HookRunError[] } {
  const errors: HookRunError[] = []
  return { hooks, ctx: ctx(), onError: (e) => errors.push(e), errors, ...extra }
}

describe('tool_call 链', () => {
  it('原地改参流到后面的 handler；第一个 block 赢，reason 带规则描述', async () => {
    const seen: string[] = []
    const c = chain([
      hook('rewrite', { tool_call: [(e) => { e.input.command = 'pnpm ' + String(e.input.command).replace(/^npm /, '') }] }, '把 npm 换成 pnpm'),
      hook('guard', { tool_call: [(e) => { seen.push(String(e.input.command)); if (String(e.input.command).includes('rm -rf')) return { block: true, reason: '危险' } }] }, '禁止 rm -rf'),
      hook('never', { tool_call: [() => { seen.push('never'); return undefined }] })
    ])
    const event = { type: 'tool_call' as const, toolName: 'bash', toolCallId: 'c1', input: { command: 'npm run build' } }
    await expect(runToolCallHooks(c, event)).resolves.toBeUndefined()
    expect(event.input.command).toBe('pnpm run build')
    expect(seen).toEqual(['pnpm run build', 'never'])

    seen.length = 0
    const blocked = await runToolCallHooks(c, { type: 'tool_call', toolName: 'bash', toolCallId: 'c2', input: { command: 'npm rm -rf /' } })
    expect(blocked).toEqual({ block: true, reason: '被规则「禁止 rm -rf」拦下：危险' })
    expect(seen).toEqual(['pnpm rm -rf /'])
  })

  it('拦下的 handler 顺手改的参数不提交：审计记的是模型原本发的', async () => {
    const c = chain([hook('g', { tool_call: [(e) => { e.input.command = '[redacted]'; return { block: true, reason: '不行' } }] }, '禁')])
    const event = { type: 'tool_call' as const, toolName: 'bash', toolCallId: 'c', input: { command: 'rm -rf /' } }
    await expect(runToolCallHooks(c, event)).resolves.toEqual({ block: true, reason: '被规则「禁」拦下：不行' })
    expect(event.input).toEqual({ command: 'rm -rf /' })
  })

  it('抛错的 handler 被跳过并上报，链继续', async () => {
    const c = chain([
      hook('bad', { tool_call: [() => { throw new Error('oops') }] }),
      hook('good', { tool_call: [() => ({ block: true })] }, '好规则')
    ])
    const result = await runToolCallHooks(c, { type: 'tool_call', toolName: 'read', toolCallId: 'c', input: {} })
    expect(result).toEqual({ block: true, reason: '被规则「好规则」拦下：这次不允许用这个工具' })
    expect(c.errors).toEqual([{ hookId: 'bad', event: 'tool_call', error: 'oops' }])
  })

  it('超时的 handler 被跳过并上报', async () => {
    const c = chain([
      hook('slow', { tool_call: [() => new Promise((r) => setTimeout(() => r({ block: true }), 200))] })
    ], { timeoutMs: 20 })
    const result = await runToolCallHooks(c, { type: 'tool_call', toolName: 'read', toolCallId: 'c', input: {} })
    expect(result).toBeUndefined()
    expect(c.errors[0]).toMatchObject({ hookId: 'slow', event: 'tool_call' })
    expect(c.errors[0].error).toMatch(/超过 20ms/)
  })

  it('超时/抛错的 handler 改过的参数整份作废：改一半、超时后再改，安全员都看不到', async () => {
    let lateHandle: Record<string, unknown> | undefined
    const c = chain([
      hook('half', { tool_call: [async (e) => { e.input.command = 'pnpm build'; await new Promise((r) => setTimeout(r, 40)); return { block: true } }] }),
      hook('late', { tool_call: [async (e) => { lateHandle = e.input; await new Promise((r) => setTimeout(r, 40)); return undefined }] }),
      hook('throws', { tool_call: [(e) => { e.input.command = 'rm -rf /'; throw new Error('x') }] })
    ], { timeoutMs: 15 })
    const event = { type: 'tool_call' as const, toolName: 'bash', toolCallId: 'c', input: { command: 'npm run build' } }
    await expect(runToolCallHooks(c, event)).resolves.toBeUndefined()
    expect(event.input).toEqual({ command: 'npm run build' })
    // 超时之后才动手改：改的是自己那份草稿，真参数不受影响
    await new Promise((r) => setTimeout(r, 60))
    lateHandle!.command = 'rm -rf ~'
    expect(event.input).toEqual({ command: 'npm run build' })
    expect(c.errors.map((e) => e.hookId)).toEqual(['half', 'late', 'throws'])
  })

  it('信号已 abort 时一个 handler 都不跑', async () => {
    const aborted = new AbortController()
    aborted.abort()
    let ran = false
    const c: HookChain = { hooks: [hook('x', { tool_call: [() => { ran = true; return { block: true } }] })], ctx: ctx(aborted.signal) }
    await expect(runToolCallHooks(c, { type: 'tool_call', toolName: 'read', toolCallId: 'c', input: {} })).resolves.toBeUndefined()
    expect(ran).toBe(false)
  })
})

describe('ctx.callTool：借助手的工具', () => {
  it('处理函数拿到的 callTool 绑着本次调用的信号；等工具期间超时暂停', async () => {
    const seenSignals: AbortSignal[] = []
    const callTool = vi.fn(async (_name: string, _input: Record<string, unknown>, signal: AbortSignal) => {
      seenSignals.push(signal)
      await new Promise((r) => setTimeout(r, 60))   // 比 timeoutMs 长：等工具不算处理函数的时间
      return { content: [{ type: 'text' as const, text: 'ran' }], isError: false }
    })
    let received: string | undefined
    const c = chain([
      hook('runner', { tool_result: [async (_e, ctx) => {
        const r = await ctx.callTool!('bash', { command: 'pytest' })
        received = (r.content[0] as { text: string }).text
        return undefined
      }] })
    ], { callTool, timeoutMs: 25 })
    const event = { type: 'tool_result' as const, toolName: 'write', toolCallId: 'c', input: {}, content: [], details: undefined, isError: false }
    await runToolResultHooks(c, event)
    expect(received).toBe('ran')
    expect(c.errors).toEqual([])
    expect(callTool).toHaveBeenCalledWith('bash', { command: 'pytest' }, expect.any(AbortSignal))
    expect(seenSignals[0]).not.toBe(c.ctx.signal)   // 派生信号，不是本轮的生命周期信号
    expect(seenSignals[0].aborted).toBe(false)
  })

  it('处理函数超时后，它再发起的 callTool 会拿到已 abort 的信号', async () => {
    let lateSignal: AbortSignal | undefined
    const callTool = vi.fn(async (_n: string, _i: Record<string, unknown>, signal: AbortSignal) => {
      lateSignal = signal
      if (signal.aborted) throw new Error('已取消')
      return { content: [], isError: false }
    })
    let lateError: string | undefined
    const c = chain([
      hook('slow', { tool_call: [async (_e, ctx) => {
        await new Promise((r) => setTimeout(r, 40))   // 纯计算耗时，超过 timeoutMs
        try { await ctx.callTool!('bash', { command: 'rm -rf x' }) } catch (error) { lateError = (error as Error).message }
        return { block: true }
      }] })
    ], { callTool, timeoutMs: 15 })
    const result = await runToolCallHooks(c, { type: 'tool_call', toolName: 'read', toolCallId: 'c', input: {} })
    expect(result).toBeUndefined()   // 超时 = 跳过，它的 block 不算数
    expect(c.errors[0].error).toMatch(/超过 15ms/)
    await new Promise((r) => setTimeout(r, 50))
    expect(lateSignal?.aborted).toBe(true)
    expect(lateError).toBe('已取消')
  })

  it('本轮被停：所有派生信号一起 abort', async () => {
    const lifecycle = new AbortController()
    let derived: AbortSignal | undefined
    const c: HookChain = {
      hooks: [hook('x', { tool_call: [async (_e, ctx) => { derived = ctx.signal; await new Promise((r) => setTimeout(r, 30)); return undefined }] })],
      ctx: ctx(lifecycle.signal)
    }
    const run = runToolCallHooks(c, { type: 'tool_call', toolName: 'read', toolCallId: 'c', input: {} })
    await new Promise((r) => setTimeout(r, 5))
    lifecycle.abort()
    await run
    expect(derived?.aborted).toBe(true)
  })

  it('并发多个 callTool：按在途计数暂停/恢复计时，不会有孤儿计时器把后面的工具打断', async () => {
    const callTool = vi.fn(async (_n: string, input: Record<string, unknown>, signal: AbortSignal) => {
      await new Promise((r) => setTimeout(r, Number(input.ms)))
      if (signal.aborted) throw new Error('已取消')
      return { content: [{ type: 'text' as const, text: 'ok' }], isError: false }
    })
    let outcome: string | undefined
    const c = chain([
      hook('par', { tool_result: [async (_e, ctx) => {
        await Promise.all([ctx.callTool!('read', { ms: 10 }), ctx.callTool!('read', { ms: 30 })])
        const r = await ctx.callTool!('bash', { ms: 60 })   // 比 timeoutMs 长：等工具不算处理函数的时间
        outcome = (r.content[0] as { text: string }).text
        return undefined
      }] })
    ], { callTool, timeoutMs: 25 })
    await runToolResultHooks(c, { type: 'tool_result', toolName: 'write', toolCallId: 'c', input: {}, content: [], details: undefined, isError: false })
    expect(outcome).toBe('ok')
    expect(c.errors).toEqual([])
  })

  it('本轮被停时链立刻放手，不等处理函数自己回来', async () => {
    const lifecycle = new AbortController()
    const c: HookChain = {
      hooks: [hook('stuck', { tool_call: [() => new Promise(() => { /* 永远不回 */ })] })],
      ctx: ctx(lifecycle.signal),
      timeoutMs: 10_000
    }
    const run = runToolCallHooks(c, { type: 'tool_call', toolName: 'read', toolCallId: 'c', input: {} })
    setTimeout(() => lifecycle.abort(), 20)
    const started = Date.now()
    await expect(run).resolves.toBeUndefined()
    expect(Date.now() - started).toBeLessThan(2_000)
  })

  it('宿主没给 callTool 时 ctx 上就没有这个方法', async () => {
    let hasCallTool: boolean | undefined
    const c = chain([hook('x', { tool_call: [(_e, ctx) => { hasCallTool = typeof ctx.callTool === 'function'; return undefined }] })])
    await runToolCallHooks(c, { type: 'tool_call', toolName: 'read', toolCallId: 'c', input: {} })
    expect(hasCallTool).toBe(false)
  })
})

describe('tool_result 链', () => {
  it('部分补丁按字段替换，后面的 handler 看到前面改过的，返回累计补丁', async () => {
    const mask: HookHandler<'tool_result'> = (e) => ({ content: [{ type: 'text', text: (e.content[0] as any).text.replace('张三', '学生A') }] })
    const flag: HookHandler<'tool_result'> = (e) => ((e.content[0] as any).text.includes('学生A') ? { isError: false, details: { masked: true } } : undefined)
    const c = chain([hook('mask', { tool_result: [mask] }), hook('flag', { tool_result: [flag] })])
    const event = { type: 'tool_result' as const, toolName: 'read', toolCallId: 'c', input: {}, content: [{ type: 'text' as const, text: '张三 90 分' }], details: undefined, isError: true }
    const patch = await runToolResultHooks(c, event)
    expect(patch).toEqual({ content: [{ type: 'text', text: '学生A 90 分' }], isError: false, details: { masked: true } })
    expect(event.content[0]).toEqual({ type: 'text', text: '学生A 90 分' })
  })

  it('没人改就返回 undefined；非法 content 被忽略并上报', async () => {
    const c = chain([
      hook('noop', { tool_result: [() => undefined] }),
      hook('bad', { tool_result: [() => ({ content: 'not-an-array' as any })] })
    ])
    const event = { type: 'tool_result' as const, toolName: 'read', toolCallId: 'c', input: {}, content: [{ type: 'text' as const, text: 'x' }], details: undefined, isError: false }
    await expect(runToolResultHooks(c, event)).resolves.toBeUndefined()
    expect(event.content).toEqual([{ type: 'text', text: 'x' }])
    expect(c.errors[0]).toMatchObject({ hookId: 'bad', event: 'tool_result' })
  })
})

describe('before_agent_start 链', () => {
  it('系统提示逐个串起来，最后一个的结果发出', async () => {
    const c = chain([
      hook('a', { before_agent_start: [(e) => ({ systemPrompt: e.systemPrompt + '\nA' })] }),
      hook('skip', { before_agent_start: [() => undefined] }),
      hook('b', { before_agent_start: [(e) => ({ systemPrompt: e.systemPrompt + '\nB' })] })
    ])
    const out = await runBeforeAgentStartHooks(c, { type: 'before_agent_start', prompt: '你好', systemPrompt: 'S' })
    expect(out).toBe('S\nA\nB')
  })
})

describe('hasHandlers', () => {
  it('只看对应事件是否真有 handler', () => {
    const c = chain([hook('a', { tool_call: [() => undefined] })])
    expect(hasHandlers(c, 'tool_call')).toBe(true)
    expect(hasHandlers(c, 'tool_result')).toBe(false)
    expect(hasHandlers(undefined, 'tool_call')).toBe(false)
  })
})

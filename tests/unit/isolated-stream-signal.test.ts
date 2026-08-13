import { describe, expect, it, vi } from 'vitest'
import { createAssistantMessageEventStream, type AssistantMessage } from '@earendil-works/pi-ai/compat'
import type { StreamFn } from '@earendil-works/pi-agent-core'
import { isolateAbortSignalForStream } from '../../src/main/isolated-stream-signal'

type StreamArgs = Parameters<StreamFn>

const model = {} as StreamArgs[0]
const context = {} as StreamArgs[1]
const doneMessage = {} as AssistantMessage

describe('每次模型流使用独立 AbortSignal', () => {
  it('长任务多次请求后父 signal 的监听都会解绑', async () => {
    const parentController = new AbortController()
    const parent = parentController.signal
    let adds = 0
    let removes = 0
    const originalAdd = parent.addEventListener.bind(parent)
    const originalRemove = parent.removeEventListener.bind(parent)
    parent.addEventListener = ((...args: Parameters<AbortSignal['addEventListener']>) => {
      adds++
      return originalAdd(...args)
    }) as AbortSignal['addEventListener']
    parent.removeEventListener = ((...args: Parameters<AbortSignal['removeEventListener']>) => {
      removes++
      return originalRemove(...args)
    }) as AbortSignal['removeEventListener']

    const deliberatelyLeakyProvider: StreamFn = async (_model, _context, options) => {
      // 模拟 provider 自己不移除监听；因为拿到的是每轮子 signal，不会堆到父 signal。
      options?.signal?.addEventListener('abort', () => {})
      const result = createAssistantMessageEventStream()
      result.push({ type: 'done', reason: 'stop', message: doneMessage })
      return result
    }
    const wrapped = isolateAbortSignalForStream(deliberatelyLeakyProvider)

    for (let i = 0; i < 20; i++) {
      const stream = await wrapped(model, context, { signal: parent })
      for await (const event of stream) void event
    }

    expect(adds).toBe(20)
    expect(removes).toBe(20)
  })

  it('父 signal abort 会立即转发给当前子流', async () => {
    const parent = new AbortController()
    let childAborted = false
    const provider: StreamFn = async (_model, _context, options) => {
      options?.signal?.addEventListener('abort', () => { childAborted = true }, { once: true })
      const result = createAssistantMessageEventStream()
      result.push({ type: 'done', reason: 'stop', message: doneMessage })
      return result
    }
    const stream = await isolateAbortSignalForStream(provider)(model, context, { signal: parent.signal })
    parent.abort()
    for await (const event of stream) void event
    expect(childAborted).toBe(true)
  })

  it('上游在工具调用开始后静默结束时返回明确错误，而不是留下空工具卡', async () => {
    const provider: StreamFn = async () => {
      const result = createAssistantMessageEventStream()
      result.push({ type: 'toolcall_start', contentIndex: 0, partial: doneMessage })
      result.end()
      return result
    }
    const events = []
    const stream = await isolateAbortSignalForStream(provider)(model, context)
    for await (const event of stream) events.push(event)

    expect(events.map((event) => event.type)).toEqual(['toolcall_start', 'error'])
    const error = events[1]
    expect(error.type === 'error' ? error.error.errorMessage : '').toContain('工具调用流提前结束')
  })

  it('工具调用流长时间没有参数增量时会主动超时', async () => {
    let childAborted = false
    const provider: StreamFn = async (_model, _context, options) => {
      options?.signal?.addEventListener('abort', () => { childAborted = true }, { once: true })
      const result = createAssistantMessageEventStream()
      result.push({ type: 'toolcall_start', contentIndex: 0, partial: doneMessage })
      return result
    }
    const events = []
    const stream = await isolateAbortSignalForStream(provider, { toolCallStallMs: 20 })(model, context)
    for await (const event of stream) events.push(event)

    expect(childAborted).toBe(true)
    expect(events.at(-1)?.type).toBe('error')
    const error = events.at(-1)
    expect(error?.type === 'error' ? error.error.errorMessage : '').toContain('没有继续返回参数')
  })

  it('记录本地 StreamFn/iterator 边界，但不把它们误当成上游已收到请求', async () => {
    const boundaries: Array<[string, number]> = []
    const provider: StreamFn = async () => {
      const result = createAssistantMessageEventStream()
      result.push({ type: 'done', reason: 'stop', message: doneMessage })
      return result
    }

    const stream = await isolateAbortSignalForStream(provider, {
      onStreamBoundary: (phase, attempt) => boundaries.push([phase, attempt])
    })(model, context)
    for await (const _event of stream) void _event

    expect(boundaries).toEqual([
      ['stream_fn_called', 1],
      ['stream_opened', 1],
      ['first_stream_next', 1]
    ])
  })

  it('上游尚未返回流时只记录 StreamFn 已调用，便于区分首事件前的挂起位置', async () => {
    const boundaries: Array<[string, number]> = []
    const parent = new AbortController()
    const provider: StreamFn = async (_model, _context, options) => new Promise((_, reject) => {
      options?.signal?.addEventListener('abort', () => reject(new Error('aborted upstream open')), { once: true })
    })

    const streamPromise = isolateAbortSignalForStream(provider, {
      onStreamBoundary: (phase, attempt) => boundaries.push([phase, attempt])
    })(model, context, { signal: parent.signal })

    await vi.waitFor(() => expect(boundaries).toEqual([['stream_fn_called', 1]]))
    parent.abort()
    const stream = await streamPromise
    for await (const _event of stream) void _event

    expect(boundaries).toEqual([['stream_fn_called', 1]])
  })
})

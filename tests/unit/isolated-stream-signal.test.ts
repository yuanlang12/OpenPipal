import { describe, expect, it, vi } from 'vitest'
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type AssistantMessageEvent
} from '@earendil-works/pi-ai/compat'
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

describe('瞬时断流自动重连', () => {
  const thinkingEvent = (delta: string): AssistantMessageEvent =>
    ({ type: 'thinking_delta', contentIndex: 0, delta, partial: doneMessage }) as AssistantMessageEvent
  const startEvent = (): AssistantMessageEvent =>
    ({ type: 'start', partial: doneMessage }) as AssistantMessageEvent

  /** 上游前 n 次思考到一半断流（Pi 对 "Stream ended without finish_reason" 的原生形态），第 n+1 次正常完成 */
  const flakyProvider = (failures: number): { fn: StreamFn; calls: () => number } => {
    let calls = 0
    const fn: StreamFn = async () => {
      const attempt = ++calls
      const result = createAssistantMessageEventStream()
      result.push(startEvent())
      result.push(thinkingEvent(`第 ${attempt} 次思考`))
      if (attempt <= failures) {
        result.push({
          type: 'error',
          reason: 'error',
          error: { ...doneMessage, stopReason: 'error', errorMessage: 'Stream ended without finish_reason' } as AssistantMessage
        })
      } else {
        result.push({ type: 'done', reason: 'stop', message: doneMessage })
      }
      return result
    }
    return { fn, calls: () => calls }
  }

  it('断流后自动重连，重连成功就当作正常完成', async () => {
    const provider = flakyProvider(2)
    const retries: number[] = []
    const stream = await isolateAbortSignalForStream(provider.fn, {
      streamRetryDelaysMs: [0],
      streamRetrySameReasonMax: 0,
      onStreamRetry: (info) => retries.push(info.attempt)
    })(model, context)
    const events: AssistantMessageEvent[] = []
    for await (const event of stream) events.push(event)

    expect(provider.calls()).toBe(3)
    expect(retries).toEqual([1, 2])
    expect(events.at(-1)?.type).toBe('done')
  })

  it('重连时不再放行第二个 start，避免下游多出一条 assistant 消息', async () => {
    const provider = flakyProvider(2)
    const stream = await isolateAbortSignalForStream(provider.fn, {
      streamRetryDelaysMs: [0],
      streamRetrySameReasonMax: 0
    })(model, context)
    const events: AssistantMessageEvent[] = []
    for await (const event of stream) events.push(event)

    expect(events.filter((event) => event.type === 'start')).toHaveLength(1)
  })

  it('重连次数用尽后把上游最后一条错误原样交出去', async () => {
    const provider = flakyProvider(99)
    const stream = await isolateAbortSignalForStream(provider.fn, {
      maxStreamRetries: 3,
      streamRetryDelaysMs: [0],
      streamRetrySameReasonMax: 0
    })(model, context)
    const events: AssistantMessageEvent[] = []
    for await (const event of stream) events.push(event)

    expect(provider.calls()).toBe(4)
    const last = events.at(-1)
    expect(last?.type).toBe('error')
    expect(last?.type === 'error' ? last.error.errorMessage : '').toBe('Stream ended without finish_reason')
  })

  it('同一个失败原因连撞两次就放弃，不把次数和时间窗耗光', async () => {
    const provider = flakyProvider(99)
    const retries: number[] = []
    const stream = await isolateAbortSignalForStream(provider.fn, {
      maxStreamRetries: 5,
      streamRetryDelaysMs: [0],
      onStreamRetry: (info) => retries.push(info.attempt)
    })(model, context)
    const events: AssistantMessageEvent[] = []
    for await (const event of stream) events.push(event)

    // 首发 + 1 次重连 = 2 次请求：撞不动的墙不值得再撞三次
    expect(provider.calls()).toBe(2)
    expect(retries).toEqual([1])
    expect(events.at(-1)?.type).toBe('error')
  })

  it('失败原因换了就不算连撞，仍按次数上限重连', async () => {
    let calls = 0
    const provider: StreamFn = async () => {
      const attempt = ++calls
      const result = createAssistantMessageEventStream()
      result.push(startEvent())
      result.push({
        type: 'error',
        reason: 'error',
        // 两个都在 Pi 的可重连名单里，但字面不同——交替出现就永远凑不满"连撞"
        error: {
          ...doneMessage,
          stopReason: 'error',
          errorMessage: attempt % 2 === 1 ? '503 service unavailable' : '502 bad gateway'
        } as AssistantMessage
      })
      return result
    }
    const stream = await isolateAbortSignalForStream(provider, {
      maxStreamRetries: 3,
      streamRetryDelaysMs: [0]
    })(model, context)
    const events: AssistantMessageEvent[] = []
    for await (const event of stream) events.push(event)

    expect(calls).toBe(4)
    expect(events.at(-1)?.type).toBe('error')
  })

  it('错误体里带变化的 request id 也照样算连撞——比较键抹掉数字', async () => {
    // Pi 会把网关原始响应体（最多 4000 字符）塞进 errorMessage，常带 request id / 时间戳。
    // 拿原文比就每次都"不一样"，闸门会形同虚设。
    let calls = 0
    const provider: StreamFn = async () => {
      const attempt = ++calls
      const result = createAssistantMessageEventStream()
      result.push(startEvent())
      result.push({
        type: 'error',
        reason: 'error',
        error: {
          ...doneMessage,
          stopReason: 'error',
          errorMessage: `503: {"error":"upstream timeout","request_id":"req_${attempt}9f${attempt * 7717}"}`
        } as AssistantMessage
      })
      return result
    }
    const stream = await isolateAbortSignalForStream(provider, {
      maxStreamRetries: 5,
      streamRetryDelaysMs: [0]
    })(model, context)
    const events: AssistantMessageEvent[] = []
    for await (const event of stream) events.push(event)

    expect(calls).toBe(2)
    expect(events.at(-1)?.type).toBe('error')
  })

  it('配额/账单类错误不重连——重发只会再撞一次同样的墙', async () => {
    let calls = 0
    const provider: StreamFn = async () => {
      calls++
      const result = createAssistantMessageEventStream()
      result.push({
        type: 'error',
        reason: 'error',
        error: { ...doneMessage, stopReason: 'error', errorMessage: 'Monthly usage limit reached' } as AssistantMessage
      })
      return result
    }
    const stream = await isolateAbortSignalForStream(provider, { streamRetryDelaysMs: [0] })(model, context)
    for await (const event of stream) void event

    expect(calls).toBe(1)
  })

  it('超出重连时间窗就停手，不把用户拖在那里等', async () => {
    const provider = flakyProvider(99)
    const retries: number[] = []
    const stream = await isolateAbortSignalForStream(provider.fn, {
      // 窗口为 0：第一次失败时 now - firstFailureAt 已经不小于窗口，一次都不重连
      streamRetryWindowMs: 0,
      streamRetryDelaysMs: [0],
      onStreamRetry: (info) => retries.push(info.attempt)
    })(model, context)
    for await (const event of stream) void event

    expect(retries).toEqual([])
    expect(provider.calls()).toBe(1)
  })

  it('工具参数已经开始流出就不重连——重来会在界面上画出第二张工具卡', async () => {
    let calls = 0
    const provider: StreamFn = async () => {
      calls++
      const result = createAssistantMessageEventStream()
      result.push({ type: 'toolcall_start', contentIndex: 0, partial: doneMessage })
      result.end()
      return result
    }
    const stream = await isolateAbortSignalForStream(provider, { streamRetryDelaysMs: [0] })(model, context)
    for await (const event of stream) void event

    expect(calls).toBe(1)
  })

  it('用户按停止时立刻醒来，不等满退避', async () => {
    const parent = new AbortController()
    const provider = flakyProvider(99)
    const stream = await isolateAbortSignalForStream(provider.fn, {
      streamRetryDelaysMs: [10_000, 10_000, 10_000, 10_000, 10_000],
      onStreamRetry: () => parent.abort()
    })(model, context, { signal: parent.signal })
    const events: AssistantMessageEvent[] = []
    for await (const event of stream) events.push(event)

    const last = events.at(-1)
    expect(last?.type).toBe('error')
    expect(last?.type === 'error' ? last.reason : '').toBe('aborted')
  })

  it('maxStreamRetries=0 保持旧行为：断一次就整轮报废', async () => {
    const provider = flakyProvider(1)
    const stream = await isolateAbortSignalForStream(provider.fn, { maxStreamRetries: 0 })(model, context)
    const events: AssistantMessageEvent[] = []
    for await (const event of stream) events.push(event)

    expect(provider.calls()).toBe(1)
    expect(events.at(-1)?.type).toBe('error')
  })
})

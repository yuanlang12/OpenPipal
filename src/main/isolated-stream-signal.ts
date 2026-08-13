import {
  createAssistantMessageEventStream,
  streamSimple,
  type Api,
  type AssistantMessage,
  type AssistantMessageEvent,
  type Model,
  type Usage
} from '@earendil-works/pi-ai/compat'
import type { StreamFn } from '@earendil-works/pi-agent-core'

export const DEFAULT_TOOL_CALL_STALL_MS = 45_000

/**
 * 这些阶段只描述本进程对 Provider StreamFn 的调用边界，不能证明网络数据包已离开
 * 客户端或上游服务已经收到请求。它们用于把“载荷已构造但没有模型事件”的静默拆成：
 * StreamFn 尚未返回、流已打开但尚未开始读取、或第一条读取后上游没有产出。
 */
export type StreamBoundaryPhase = 'stream_fn_called' | 'stream_opened' | 'first_stream_next'

export type StreamBoundaryObserver = (phase: StreamBoundaryPhase, attempt: number) => void

export interface IsolatedStreamOptions {
  /** toolcall_start 后多久没有任何新事件，判定兼容网关的工具流已卡死。 */
  toolCallStallMs?: number
  /** 仅观测：Provider StreamFn 与其 iterator 的本地边界，不影响正常流控制。 */
  onStreamBoundary?: StreamBoundaryObserver
}

type NextOutcome =
  | { kind: 'next'; value: IteratorResult<AssistantMessageEvent> }
  | { kind: 'aborted' }
  | { kind: 'stalled' }

const ZERO_USAGE: Usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
}

function failureMessage(model: Model<Api>, reason: string, stopReason: 'error' | 'aborted'): AssistantMessage {
  return {
    role: 'assistant',
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: ZERO_USAGE,
    stopReason,
    errorMessage: reason,
    timestamp: Date.now()
  }
}

function nextWithGuard(
  iterator: AsyncIterator<AssistantMessageEvent>,
  signal: AbortSignal,
  stallMs: number | null
): Promise<NextOutcome> {
  return new Promise<NextOutcome>((resolve, reject) => {
    let settled = false
    let timer: ReturnType<typeof setTimeout> | null = null
    const finish = (outcome: NextOutcome): void => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
      resolve(outcome)
    }
    const onAbort = (): void => finish({ kind: 'aborted' })

    signal.addEventListener('abort', onAbort, { once: true })
    if (signal.aborted) {
      finish({ kind: 'aborted' })
      return
    }
    if (stallMs !== null) timer = setTimeout(() => finish({ kind: 'stalled' }), stallMs)

    iterator.next().then(
      (value) => finish({ kind: 'next', value }),
      (error) => {
        if (settled) return
        settled = true
        if (timer) clearTimeout(timer)
        signal.removeEventListener('abort', onAbort)
        reject(error)
      }
    )
  })
}

function cancelIterator(iterator: AsyncIterator<AssistantMessageEvent>): void {
  if (!iterator.return) return
  try {
    void Promise.resolve(iterator.return()).catch(() => {})
  } catch {
    // 某些 SDK iterator 在已有 next() 挂起时不接受 return；子 signal 已负责取消网络层。
  }
}

/**
 * Pi 会在一次长 run 的每次模型请求里复用同一个 AbortSignal。部分兼容 provider/fetch 实现
 * 会在这个 signal 上注册监听却不及时移除，十几轮后触发 MaxListenersExceededWarning。
 *
 * 同时，部分 OpenAI Responses 兼容网关会发出 toolcall_start 后静默断流或永远不结束；Pi 收不到
 * terminal event，就会留下空工具卡或无限等待。这里把每次请求隔离到短生命周期子 signal，并：
 * - 上游 iterator 无 done/error terminal 就结束：合成明确 error event；
 * - toolcall_start 后长期无任何事件：限时中止并合成 error event；
 * - 无论成功、失败、abort，都确定性解绑父 signal。
 */
export function isolateAbortSignalForStream(upstream: StreamFn, config: IsolatedStreamOptions = {}): StreamFn {
  const toolCallStallMs = config.toolCallStallMs ?? DEFAULT_TOOL_CALL_STALL_MS
  const onStreamBoundary = config.onStreamBoundary
  let nextAttempt = 0
  const observeBoundary = (phase: StreamBoundaryPhase, attempt: number): void => {
    try {
      onStreamBoundary?.(phase, attempt)
    } catch {
      // 观测不能改变模型流的成功、失败或取消语义。
    }
  }

  return async (...args: Parameters<StreamFn>) => {
    const attempt = ++nextAttempt
    const options = args[2] || {}
    const parent = options.signal
    const controller = new AbortController()
    const output = createAssistantMessageEventStream()
    const forwardAbort = (): void => controller.abort(parent?.reason)

    if (parent?.aborted) forwardAbort()
    else parent?.addEventListener('abort', forwardAbort, { once: true })

    let stream: Awaited<ReturnType<StreamFn>>
    try {
      observeBoundary('stream_fn_called', attempt)
      stream = await upstream(args[0], args[1], { ...options, signal: controller.signal })
    } catch (error) {
      parent?.removeEventListener('abort', forwardAbort)
      const reason = error instanceof Error ? error.message : String(error)
      output.push({ type: 'error', reason: 'error', error: failureMessage(args[0], reason, 'error') })
      return output
    }

    const iterator = stream[Symbol.asyncIterator]()
    observeBoundary('stream_opened', attempt)
    void (async () => {
      const openToolCalls = new Set<number>()
      let sawTerminal = false
      let firstNext = true
      try {
        while (!sawTerminal) {
          if (firstNext) {
            firstNext = false
            observeBoundary('first_stream_next', attempt)
          }
          const outcome = await nextWithGuard(
            iterator,
            controller.signal,
            openToolCalls.size > 0 ? toolCallStallMs : null
          )

          if (outcome.kind === 'aborted') {
            output.push({
              type: 'error',
              reason: 'aborted',
              error: failureMessage(args[0], '请求已取消', 'aborted')
            })
            break
          }
          if (outcome.kind === 'stalled') {
            const seconds = Math.max(1, Math.round(toolCallStallMs / 1000))
            const reason = `模型已开始调用工具，但 ${seconds} 秒内没有继续返回参数。上游 Responses 流可能已中断，请重试本轮或切换模型/接口。`
            controller.abort(new Error(reason))
            cancelIterator(iterator)
            output.push({ type: 'error', reason: 'error', error: failureMessage(args[0], reason, 'error') })
            break
          }

          if (outcome.value.done) {
            const reason = openToolCalls.size > 0
              ? '模型工具调用流提前结束，尚未收到完整参数。上游 Responses 接口返回了不完整事件序列，请重试本轮。'
              : '模型响应流提前结束，未收到完成事件。请重试本轮。'
            output.push({ type: 'error', reason: 'error', error: failureMessage(args[0], reason, 'error') })
            break
          }

          const event = outcome.value.value
          if (event.type === 'toolcall_start') openToolCalls.add(event.contentIndex)
          else if (event.type === 'toolcall_end') openToolCalls.delete(event.contentIndex)
          if (event.type === 'done' || event.type === 'error') sawTerminal = true
          output.push(event)
        }
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error)
        output.push({ type: 'error', reason: 'error', error: failureMessage(args[0], reason, 'error') })
      } finally {
        parent?.removeEventListener('abort', forwardAbort)
        if (!controller.signal.aborted) controller.abort()
        if (!sawTerminal) cancelIterator(iterator)
      }
    })()

    return output
  }
}

export function createIsolatedStreamSimple(config: IsolatedStreamOptions = {}): StreamFn {
  return isolateAbortSignalForStream(streamSimple, config)
}

export const isolatedStreamSimple = createIsolatedStreamSimple()

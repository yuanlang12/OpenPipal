import {
  createAssistantMessageEventStream,
  streamSimple,
  type Api,
  type AssistantMessage,
  type AssistantMessageEvent,
  type Model,
  type Usage
} from '@earendil-works/pi-ai/compat'
import { isRetryableAssistantError } from '@earendil-works/pi-ai'
import type { StreamFn } from '@earendil-works/pi-agent-core'

const DEFAULT_TOOL_CALL_STALL_MS = 45_000

/** 断流重连次数上限（首次请求不算在内）。 */
const DEFAULT_STREAM_RETRY_MAX = 5
/** 从第一次失败起算的重连时间窗：超窗就不再重连，避免长思考模型把用户拖住半小时。 */
const DEFAULT_STREAM_RETRY_WINDOW_MS = 300_000
/**
 * 同一个失败原因最多连撞几次。撞满就放弃，不把剩余次数和时间窗耗光。
 * 判据是"重连救不救得回来"：偶发抖动换一次连接就好，所以留 1 次免费重来；
 * 而上游持续掐流这种必挂场景，实测连拨 10 次 0 次成功——多试只是把
 * "1 分钟失败"拖成"7 分钟失败"，对用户是纯亏。
 */
const DEFAULT_STREAM_RETRY_SAME_REASON_MAX = 2
/** 退避节奏。掉线不是限流，等久了没意义，短退避即可。 */
const STREAM_RETRY_DELAYS_MS = [1_000, 2_000, 4_000, 4_000, 4_000]

/**
 * 这些阶段只描述本进程对 Provider StreamFn 的调用边界，不能证明网络数据包已离开
 * 客户端或上游服务已经收到请求。它们用于把“载荷已构造但没有模型事件”的静默拆成：
 * StreamFn 尚未返回、流已打开但尚未开始读取、或第一条读取后上游没有产出。
 */
export type StreamBoundaryPhase = 'stream_fn_called' | 'stream_opened' | 'first_stream_next'

export type StreamBoundaryObserver = (phase: StreamBoundaryPhase, attempt: number) => void

export interface StreamRetryInfo {
  /** 第几次重连（1-based） */
  attempt: number
  maxRetries: number
  delayMs: number
  /** 上游给出的失败原文，用于日志；界面只显示次数 */
  reason: string
}

export type StreamRetryObserver = (info: StreamRetryInfo) => void

export interface IsolatedStreamOptions {
  /** toolcall_start 后多久没有任何新事件，判定兼容网关的工具流已卡死。 */
  toolCallStallMs?: number
  /** 仅观测：Provider StreamFn 与其 iterator 的本地边界，不影响正常流控制。 */
  onStreamBoundary?: StreamBoundaryObserver
  /** 瞬时断流的重连次数上限；0 = 关闭重连（回到"断一次就整轮报废"的旧行为）。 */
  maxStreamRetries?: number
  /** 重连时间窗，从第一次失败起算。 */
  streamRetryWindowMs?: number
  /** 退避节奏覆盖（测试用；不足次数时复用最后一档）。 */
  streamRetryDelaysMs?: number[]
  /** 同一失败原因的连撞上限；撞满即放弃。0 = 关闭这道闸，只看次数和时间窗。 */
  streamRetrySameReasonMax?: number
  /** 每次重连前回调：Runtime 据此提示用户并丢弃本次已流出的半截内容。 */
  onStreamRetry?: StreamRetryObserver
}

/**
 * 连撞判定用的比较键。不能拿 reason 原文比：Pi 会把网关返回的原始响应体（最多 4000 字符）
 * 塞进 errorMessage（utils/error-body.ts），而网关的错误体常带 request id / trace id /
 * 时间戳——原文比就每次都"不一样"，闸门形同虚设。抹掉数字再截断：请求 id 和时间戳塌成
 * 同一个键，而 "429: rate limit" 和 "502: bad gateway" 仍然分得开。
 */
function failureKey(reason: string): string {
  return reason.replace(/\d+/g, '#').slice(0, 120)
}

/**
 * 只写日志、不改流控制的断流形态观测。一次 Provider 请求结束时打一行，用来分辨两种断法：
 * 断在一段长静默之后 → 中间某一跳的空闲超时；断在连续吐字的当口 → 上游自己挂了。
 * 注意量的是解析后的模型事件间隔，不是 TCP 字节间隔——网关若发 SSE 心跳注释，
 * 事件间隔会比真实传输静默长。
 */
interface AttemptProbe {
  mark(eventType: string): void
  report(outcome: string): void
}

function createAttemptProbe(attempt: number, modelId: string): AttemptProbe {
  const startedAt = Date.now()
  let events = 0
  let lastAt = startedAt
  let lastType = 'none'
  let maxGapMs = 0
  let maxGapAfter = 'stream_open'
  return {
    mark(eventType) {
      const now = Date.now()
      const gap = now - lastAt
      if (gap > maxGapMs) {
        maxGapMs = gap
        maxGapAfter = lastType
      }
      lastAt = now
      lastType = eventType
      events += 1
    },
    report(outcome) {
      const now = Date.now()
      const line = `[StreamProbe] model=${modelId} attempt=${attempt} outcome=${outcome}`
        + ` life=${now - startedAt}ms events=${events}`
        + ` lastEvent=${lastType} sinceLast=${now - lastAt}ms maxGap=${maxGapMs}ms(after ${maxGapAfter})`
      // 正常收尾不是警告——只有断流/卡死才值得在 main.log 里显眼。
      if (outcome === 'terminal') console.log(line)
      else console.warn(line)
    }
  }
}

type NextOutcome =
  | { kind: 'next'; value: IteratorResult<AssistantMessageEvent> }
  | { kind: 'aborted' }
  | { kind: 'stalled' }

/**
 * 一次 Provider 请求的结局。`failed` 才进入重连判定：`retryable` 由 Pi 自己的
 * isRetryableAssistantError 判（断流/超时/5xx 重连，配额/鉴权/账单立刻失败），
 * `toolCallStarted` 则是本地闸门——见 shouldRetry。
 */
type AttemptEnd =
  | { kind: 'terminal'; event: AssistantMessageEvent }
  | { kind: 'aborted' }
  | { kind: 'failed'; reason: string; retryable: boolean; toolCallStarted: boolean; event?: AssistantMessageEvent }

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

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** 退避睡眠；父 signal 一断立刻醒来并返回 false，不让用户按了停止还要等满退避。 */
function sleep(ms: number, signal: AbortSignal): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    if (signal.aborted) {
      resolve(false)
      return
    }
    const onAbort = (): void => {
      clearTimeout(timer)
      resolve(false)
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve(true)
    }, ms)
    signal.addEventListener('abort', onAbort, { once: true })
  })
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
 * - 上游 iterator 无 done/error terminal 就结束：判为瞬时断流，先重连，重连用尽才报错；
 * - toolcall_start 后长期无任何事件：限时中止并合成 error event；
 * - 无论成功、失败、abort，都确定性解绑父 signal。
 *
 * 重连语义（对齐 Pi 自己的 retryAssistantCall，但我们是裸 Agent + 自带 streamFn，
 * 那条重试路径走不到，只能在这层补）：整轮请求原样重发，模型从零重想——HTTP 流断了
 * 没有断点续传，服务端也不保留半截思考。因此重连必须配 onStreamRetry 把已经流出去的
 * 半截内容丢掉，否则下游会把两次尝试的思考/正文拼在一起。
 */
export function isolateAbortSignalForStream(upstream: StreamFn, config: IsolatedStreamOptions = {}): StreamFn {
  const toolCallStallMs = config.toolCallStallMs ?? DEFAULT_TOOL_CALL_STALL_MS
  const maxStreamRetries = Math.max(0, config.maxStreamRetries ?? DEFAULT_STREAM_RETRY_MAX)
  const retryWindowMs = Math.max(0, config.streamRetryWindowMs ?? DEFAULT_STREAM_RETRY_WINDOW_MS)
  const retryDelaysMs = config.streamRetryDelaysMs?.length ? config.streamRetryDelaysMs : STREAM_RETRY_DELAYS_MS
  const sameReasonMax = Math.max(0, config.streamRetrySameReasonMax ?? DEFAULT_STREAM_RETRY_SAME_REASON_MAX)
  const onStreamBoundary = config.onStreamBoundary
  const onStreamRetry = config.onStreamRetry
  let nextAttempt = 0
  const observeBoundary = (phase: StreamBoundaryPhase, attempt: number): void => {
    try {
      onStreamBoundary?.(phase, attempt)
    } catch {
      // 观测不能改变模型流的成功、失败或取消语义。
    }
  }

  return async (...args: Parameters<StreamFn>) => {
    const options = args[2] || {}
    const parent = options.signal
    const output = createAssistantMessageEventStream()
    // lifetime 覆盖整个逻辑请求（含重连间隔），controller 每次尝试换一个：
    // 掐掉上一次的网络流不能顺手掐掉下一次，而父 signal 的监听始终只挂一份。
    const lifetime = new AbortController()
    let controller = new AbortController()
    const forwardAbort = (): void => {
      lifetime.abort(parent?.reason)
      controller.abort(parent?.reason)
    }

    if (parent?.aborted) forwardAbort()
    else parent?.addEventListener('abort', forwardAbort, { once: true })

    // 抛错转 failed 的可重连判定只此一处：写两遍迟早会分叉。
    const failedFrom = (error: unknown, toolCallStarted: boolean): AttemptEnd => {
      const reason = errorText(error)
      return {
        kind: 'failed',
        reason,
        retryable: isRetryableAssistantError(failureMessage(args[0], reason, 'error')),
        toolCallStarted
      }
    }
    const abortedTerminal = (): AssistantMessageEvent =>
      ({ type: 'error', reason: 'aborted', error: failureMessage(args[0], '请求已取消', 'aborted') })

    // 首次尝试的 start 事件放行；重连时吞掉，否则 pi-agent-core 会再 push 一条 assistant
    // 消息（它对 start 的处理就是 messages.push），一次断流变成两个气泡。
    let forwardedStart = false

    const runAttempt = async (attempt: number, probe: AttemptProbe): Promise<AttemptEnd> => {
      let toolCallStarted = false
      observeBoundary('stream_fn_called', attempt)
      let stream: Awaited<ReturnType<StreamFn>>
      try {
        stream = await upstream(args[0], args[1], { ...options, signal: controller.signal })
      } catch (error) {
        if (controller.signal.aborted) return { kind: 'aborted' }
        return failedFrom(error, toolCallStarted)
      }

      const iterator = stream[Symbol.asyncIterator]()
      observeBoundary('stream_opened', attempt)
      const openToolCalls = new Set<number>()
      let firstNext = true
      let sawTerminal = false
      try {
        while (true) {
          if (firstNext) {
            firstNext = false
            observeBoundary('first_stream_next', attempt)
          }
          const outcome = await nextWithGuard(
            iterator,
            controller.signal,
            openToolCalls.size > 0 ? toolCallStallMs : null
          )

          if (outcome.kind === 'aborted') return { kind: 'aborted' }
          if (outcome.kind === 'stalled') {
            const seconds = Math.max(1, Math.round(toolCallStallMs / 1000))
            const reason = `模型已开始调用工具，但 ${seconds} 秒内没有继续返回参数。上游 Responses 流可能已中断，请重试本轮或切换模型/接口。`
            controller.abort(new Error(reason))
            return { kind: 'failed', reason, retryable: true, toolCallStarted }
          }

          if (outcome.value.done) {
            const reason = openToolCalls.size > 0
              ? '模型工具调用流提前结束，尚未收到完整参数。上游 Responses 接口返回了不完整事件序列，请重试本轮。'
              : '模型响应流提前结束，未收到完成事件。请重试本轮。'
            // iterator 无 terminal 就结束 = 上游把响应体收了，按定义就是瞬时断流。
            return { kind: 'failed', reason, retryable: true, toolCallStarted }
          }

          const event = outcome.value.value
          probe.mark(event.type)
          if (event.type === 'toolcall_start') {
            openToolCalls.add(event.contentIndex)
            toolCallStarted = true
          } else if (event.type === 'toolcall_end') {
            openToolCalls.delete(event.contentIndex)
          } else if (event.type === 'toolcall_delta') {
            toolCallStarted = true
          }

          if (event.type === 'done') {
            sawTerminal = true
            return { kind: 'terminal', event }
          }
          if (event.type === 'error') {
            sawTerminal = true
            // 上游自己判定的取消：原样透传，别把它的原文换成我们的 '请求已取消'。
            if (event.reason === 'aborted') return { kind: 'terminal', event }
            return {
              kind: 'failed',
              reason: event.error.errorMessage || '模型服务返回错误',
              retryable: isRetryableAssistantError(event.error),
              toolCallStarted,
              event
            }
          }

          if (event.type === 'start') {
            if (forwardedStart) continue
            forwardedStart = true
          }
          output.push(event)
        }
      } catch (error) {
        if (lifetime.signal.aborted) return { kind: 'aborted' }
        return failedFrom(error, toolCallStarted)
      } finally {
        if (!controller.signal.aborted) controller.abort()
        if (!sawTerminal) cancelIterator(iterator)
      }
    }

    void (async () => {
      let retriesUsed = 0
      let firstFailureAt = 0
      let lastFailureKey = ''
      let sameReasonStreak = 0
      let terminal: AssistantMessageEvent | null = null

      while (!terminal) {
        const attempt = ++nextAttempt
        const probe = createAttemptProbe(attempt, args[0]?.id || '?')
        const end = await runAttempt(attempt, probe)
        probe.report(end.kind === 'failed' ? `failed(${end.retryable ? 'retryable' : 'fatal'})` : end.kind)

        if (end.kind === 'terminal') {
          terminal = end.event
          break
        }
        if (end.kind === 'aborted') {
          terminal = abortedTerminal()
          break
        }

        const now = Date.now()
        if (firstFailureAt === 0) firstFailureAt = now
        const key = failureKey(end.reason)
        sameReasonStreak = key === lastFailureKey ? sameReasonStreak + 1 : 1
        lastFailureKey = key
        // 工具参数已经开始流出就不重连：工具卡已经画在界面上，重来会画出第二张；
        // 而工具本身在 assistant 消息完成前不会执行，所以这里没有副作用问题，只有展示问题。
        const shouldRetry =
          end.retryable
          && !end.toolCallStarted
          && retriesUsed < maxStreamRetries
          && !lifetime.signal.aborted
          && now - firstFailureAt < retryWindowMs
          // 一直撞同一堵墙就别撞了——判据见 DEFAULT_STREAM_RETRY_SAME_REASON_MAX 的注释。
          && (sameReasonMax === 0 || sameReasonStreak < sameReasonMax)

        if (!shouldRetry) {
          terminal = end.event
            ?? { type: 'error', reason: 'error', error: failureMessage(args[0], end.reason, 'error') }
          break
        }

        const delayMs = retryDelaysMs[Math.min(retriesUsed, retryDelaysMs.length - 1)]
        retriesUsed += 1
        try {
          onStreamRetry?.({ attempt: retriesUsed, maxRetries: maxStreamRetries, delayMs, reason: end.reason })
        } catch {
          // 观测/提示失败不能改变重连本身的行为。
        }
        if (!(await sleep(delayMs, lifetime.signal))) {
          terminal = abortedTerminal()
          break
        }
        controller = new AbortController()
        if (lifetime.signal.aborted) controller.abort(lifetime.signal.reason)
      }

      // 先解绑再推 terminal：消费者的 for-await 可能在 push 后立刻结束，
      // 解绑晚一步就会被长 run 累积成 MaxListenersExceededWarning（本包装器的原始职责）。
      parent?.removeEventListener('abort', forwardAbort)
      if (!lifetime.signal.aborted) lifetime.abort()
      if (!controller.signal.aborted) controller.abort()
      output.push(terminal!)
    })()

    return output
  }
}

export function createIsolatedStreamSimple(config: IsolatedStreamOptions = {}): StreamFn {
  return isolateAbortSignalForStream(streamSimple, config)
}

export const isolatedStreamSimple = createIsolatedStreamSimple()

import type { AgentMessage } from '@earendil-works/pi-agent-core'

export const EMPTY_COMPLETION_RETRY_PROMPT =
  '[OpenPipal 自动续跑] 你上一轮已经结束，但只返回了思考过程，没有正文或工具调用。请从当前状态继续完成用户的原始请求；需要工具就调用工具，否则直接给出最终答复。不要再只返回思考。'

type EmptyCompletionGuardAgent = {
  state: { messages: AgentMessage[] }
  prompt: (message: AgentMessage) => Promise<void>
}

type AssistantContentBlock = {
  type?: unknown
  text?: unknown
}

type AssistantMessageLike = {
  role?: unknown
  stopReason?: unknown
  content?: unknown
  usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number }
}

export interface EmptyCompletionRetryResult {
  retried: boolean
  stillEmpty: boolean
  /** 仅在"判定为上下文溢出且自愈未成功"时为 true——调用方据此换用真话报错文案 */
  overflow?: boolean
}

/**
 * 判定一条 assistant 消息是否“成功结束，却没有可交付内容”。
 * thinking-only 和空 content 都算空完成；显式 error/aborted 由现有错误链路处理，
 * 有正文或 toolCall 则不能重试，避免重复执行已发起的操作。
 */
export function isEmptySuccessfulAssistantMessage(message: AgentMessage | undefined): boolean {
  const msg = message as AssistantMessageLike | undefined
  if (!msg || msg.role !== 'assistant') return false
  if (msg.stopReason === 'error' || msg.stopReason === 'aborted') return false
  if (!Array.isArray(msg.content)) return !String(msg.content ?? '').trim()

  return !(msg.content as AssistantContentBlock[]).some((block) => {
    if (block?.type === 'toolCall') return true
    return block?.type === 'text' && typeof block.text === 'string' && block.text.trim().length > 0
  })
}

/**
 * 上下文溢出判定（对齐 pi-ai utils/overflow 判据三：length + 近零输出 = 载荷已
 * 顶满窗口，max_tokens 被夹到个位数）。这类失败重试无效——每次重试都会再追加
 * 消息把窗口挤得更满，唯一出路是先压缩历史再试。
 * 两条判据取或：
 * - 输出 ≤ 64 token：pi-ai clampMaxTokensToContext 把 max_tokens 夹小后，
 *   provider 可能吐出几十个思考 token 才停，比 pi 的 output===0 判据宽容；
 * - 实报载荷 ≥ 窗口 90%：窗口配置偏大时输出可能不那么小，用载荷占比兜底。
 */
export function isContextOverflowCompletion(
  message: AgentMessage | undefined,
  contextWindow?: number
): boolean {
  const msg = message as AssistantMessageLike | undefined
  if (!msg || msg.role !== 'assistant' || msg.stopReason !== 'length') return false
  const usage = msg.usage
  if ((usage?.output ?? 0) <= 64) return true
  if (contextWindow && contextWindow > 0 && usage) {
    const promptTokens = (usage.input ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0)
    if (promptTokens >= contextWindow * 0.9) return true
  }
  return false
}

function lastAssistantSince(messages: AgentMessage[], startIndex: number): AgentMessage | undefined {
  for (let i = messages.length - 1; i >= startIndex; i--) {
    if ((messages[i] as AssistantMessageLike)?.role === 'assistant') return messages[i]
  }
  return undefined
}

function describeAssistant(message: AgentMessage | undefined): { stopReason: string; blockTypes: string } {
  const msg = message as AssistantMessageLike | undefined
  const blockTypes = Array.isArray(msg?.content)
    ? (msg.content as AssistantContentBlock[]).map((block) => String(block?.type ?? 'unknown')).join(',')
    : typeof msg?.content
  return {
    stopReason: typeof msg?.stopReason === 'string' ? msg.stopReason : 'unknown',
    blockTypes: blockTypes || 'none'
  }
}

/**
 * 执行一次 prompt；如果服务商正常结束，但最后一条 assistant 只有 thinking
 *（或完全为空），先给失败分型再决定处方：
 * - 上下文溢出（length + 近零输出）→ 调 onOverflowRecover 压缩历史重建状态后
 *   原地重试一次；压不动或重试仍空 → overflow=true，调用方报"窗口上限"真话。
 * - 其余空完成（流式抖动/只想不说）→ 追加一条不上屏的内部续跑提示重试一次。
 * 两条路径都最多只试一次，不无限重试。
 */
export async function promptWithEmptyCompletionRetry(
  agent: EmptyCompletionGuardAgent,
  message: AgentMessage,
  options: {
    signal?: AbortSignal
    onRetry?: () => void
    /** 溢出判定的窗口证据（配置口径，允许缺省——缺省时只按近零输出判） */
    contextWindow?: number
    /**
     * 溢出自愈：由调用方强制压缩历史并整体重建 agent.state.messages，
     * 返回重建后要重试的 currentMessage；返回 null 表示压不动，走真话报错。
     */
    onOverflowRecover?: () => Promise<AgentMessage | null>
  } = {}
): Promise<EmptyCompletionRetryResult> {
  const firstStart = agent.state.messages.length
  await agent.prompt(message)
  if (options.signal?.aborted) return { retried: false, stillEmpty: false }

  const firstAssistant = lastAssistantSince(agent.state.messages, firstStart)
  if (!isEmptySuccessfulAssistantMessage(firstAssistant)) {
    return { retried: false, stillEmpty: false }
  }

  // 资源耗尽型失败先于兜底重试分流：窗口满时续跑提示只会火上浇油
  if (isContextOverflowCompletion(firstAssistant, options.contextWindow) && options.onOverflowRecover) {
    console.warn('[Pi] 空完成判定为上下文溢出（stopReason=length、输出≈0）——压缩历史后原地重试')
    const recovered = await options.onOverflowRecover()
    if (options.signal?.aborted) return { retried: false, stillEmpty: false }
    if (!recovered) {
      console.error('[Pi] 溢出自愈放弃：历史无可压空间或压缩失败')
      return { retried: false, stillEmpty: true, overflow: true }
    }
    options.onRetry?.()
    const retryStart = agent.state.messages.length
    await agent.prompt(recovered)
    if (options.signal?.aborted) return { retried: true, stillEmpty: false }
    const retryAssistant = lastAssistantSince(agent.state.messages, retryStart)
    const stillEmpty = isEmptySuccessfulAssistantMessage(retryAssistant)
    if (stillEmpty) {
      const retry = describeAssistant(retryAssistant)
      console.error(`[Pi] 溢出压缩重试后仍无正文/工具: stopReason=${retry.stopReason} blocks=${retry.blockTypes}`)
      return { retried: true, stillEmpty: true, overflow: true }
    }
    // 状态已被 onOverflowRecover 整体重建，没有脚手架消息需要拆除
    return { retried: true, stillEmpty: false }
  }

  const first = describeAssistant(firstAssistant)
  console.warn(`[Pi] 检测到空完成，自动续跑一次: stopReason=${first.stopReason} blocks=${first.blockTypes}`)

  options.onRetry?.()
  const retryStart = agent.state.messages.length
  await agent.prompt({
    role: 'user',
    content: [{ type: 'text', text: EMPTY_COMPLETION_RETRY_PROMPT }],
    timestamp: Date.now()
  } as AgentMessage)
  if (options.signal?.aborted) return { retried: true, stillEmpty: false }

  const retryAssistant = lastAssistantSince(agent.state.messages, retryStart)
  const stillEmpty = isEmptySuccessfulAssistantMessage(retryAssistant)
  if (stillEmpty) {
    const retry = describeAssistant(retryAssistant)
    console.error(`[Pi] 空完成自动续跑后仍无正文/工具: stopReason=${retry.stopReason} blocks=${retry.blockTypes}`)
  } else {
    // 续跑成功后把内部脚手架从 agent 状态里拆掉：空 assistant + 注入的续跑提示都不该
    // 留给 goal-loop 后续每次请求（以及 GoalChecker）复读。拆完序列回到
    // [user(原始), assistant(有效回复)]，user/assistant 交替不被破坏。
    const messages = agent.state.messages
    const retryPromptIdx = messages.findIndex((msg, i) => {
      if (i < retryStart || (msg as AssistantMessageLike).role !== 'user') return false
      return JSON.stringify((msg as AssistantMessageLike).content ?? '').includes('[OpenPipal 自动续跑]')
    })
    if (retryPromptIdx >= 0) messages.splice(retryPromptIdx, 1)
    const emptyIdx = firstAssistant ? messages.indexOf(firstAssistant) : -1
    if (emptyIdx >= 0) messages.splice(emptyIdx, 1)
  }
  return { retried: true, stillEmpty }
}

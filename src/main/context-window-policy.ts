/**
 * Model-facing context policy.
 *
 * Keep the active conversation append-only. Do not rewrite old tool results or
 * remove old images because a later assistant message exists or because they
 * crossed a message-count window. Whole-history compaction is owned by
 * history-compactor.ts and is triggered only by the model's token budget.
 *
 * The only per-message guard is a deterministic cap on one tool result. This
 * mirrors the boundary used by coding agents such as Codex/Pi: a pathological
 * command or connector response must not consume the entire context window in
 * one step. The cap is applied from the first model-visible projection and
 * never changes with message age, so it remains prompt-cache friendly.
 */

import type { AgentMessage } from '@earendil-works/pi-agent-core'
import type { ToolResultMessage } from '@earendil-works/pi-ai/compat'

/** Codex's documented example uses 12k tokens; Pi's built-ins use a similar 50KB ceiling. */
export const MAX_TOOL_RESULT_TOKENS = 12_000

/**
 * Pi 0.83 的上下文估算器会读取每条 assistant 消息的 usage.totalTokens。
 * OpenPipal 从本地会话回放出的 assistant/toolCall 消息没有服务商 usage（这是正常的，
 * 磁盘历史不保存它），所以在进入 Pi 的 provider 边界前补一个零值即可。usage 不会
 * 序列化进模型请求，也不会改变模型看到的消息或缓存前缀。
 */
function zeroAssistantUsage(): Record<string, unknown> {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
  }
}

function normalizeAssistantUsage(message: AgentMessage): AgentMessage {
  if ((message as any).role !== 'assistant' || (message as any).usage) return message
  return { ...(message as any), usage: zeroAssistantUsage() } as AgentMessage
}

export function estimateContextTextTokens(text: string): number {
  let ascii = 0
  let other = 0
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) < 128) ascii++
    else other++
  }
  return Math.ceil(ascii / 4 + other / 1.6)
}

function takeWithinTokenBudget(text: string, budget: number, fromEnd: boolean): string {
  if (budget <= 0 || !text) return ''
  if (estimateContextTextTokens(text) <= budget) return text

  let low = 0
  let high = text.length
  while (low < high) {
    const mid = Math.ceil((low + high) / 2)
    const candidate = fromEnd ? text.slice(text.length - mid) : text.slice(0, mid)
    if (estimateContextTextTokens(candidate) <= budget) low = mid
    else high = mid - 1
  }
  return fromEnd ? text.slice(text.length - low) : text.slice(0, low)
}

/**
 * Keep both the beginning (commands, headings, file paths) and the end (errors,
 * totals, final status). Returns the original string object when no cap is
 * needed, avoiding needless byte changes.
 */
export function capToolResultText(
  text: string,
  maxTokens = MAX_TOOL_RESULT_TOKENS
): string {
  const estimated = estimateContextTextTokens(text)
  if (estimated <= maxTokens) return text

  const marker = `\n\n…[单条工具结果已确定性限长：原 ${text.length} 字符，约 ${estimated} tokens；保留头尾]…\n\n`
  const available = Math.max(0, maxTokens - estimateContextTextTokens(marker))
  const headBudget = Math.floor(available * 0.6)
  const tailBudget = available - headBudget
  const head = takeWithinTokenBudget(text, headBudget, false)
  const tail = takeWithinTokenBudget(text, tailBudget, true)
  return head + marker + tail
}

function isToolResultMessage(message: AgentMessage): message is ToolResultMessage {
  return (message as any).role === 'toolResult'
}

function capToolResultMessage(message: ToolResultMessage): ToolResultMessage {
  const content = (message as any).content
  if (typeof content === 'string') {
    const capped = capToolResultText(content)
    return capped === content ? message : { ...(message as any), content: capped }
  }
  if (!Array.isArray(content)) return message

  const textBlocks = content.filter((block: any) => block?.type === 'text' && typeof block.text === 'string')
  if (textBlocks.length === 0) return message
  const joined = textBlocks.map((block: any) => block.text).join('\n')
  const capped = capToolResultText(joined)
  if (capped === joined) return message

  let wroteText = false
  const nextContent = content.flatMap((block: any) => {
    if (block?.type !== 'text' || typeof block.text !== 'string') return [block]
    if (wroteText) return []
    wroteText = true
    return [{ ...block, text: capped }]
  })
  return { ...(message as any), content: nextContent }
}

/** Pure, deterministic projection used before every provider request. */
export function prepareContextForModel(messages: AgentMessage[]): AgentMessage[] {
  let changed = false
  const projected = messages.map(message => {
    const withUsage = normalizeAssistantUsage(message)
    const next = isToolResultMessage(withUsage)
      ? capToolResultMessage(withUsage)
      : withUsage
    changed = changed || next !== message
    return next
  })
  return changed ? projected : messages
}

/** Pi agent-core transform hook; deliberately independent of message age/count. */
export function createStableContextTransform(): (messages: AgentMessage[]) => Promise<AgentMessage[]> {
  return async (messages: AgentMessage[]) => prepareContextForModel(messages)
}

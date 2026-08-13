/**
 * 工具轨迹跨轮回放。
 *
 * Finalized tool calls/results are kept in their original order and restored as
 * Pi-native assistant(toolCall) + toolResult pairs. This module deliberately
 * has no age-, count-, or tool-type-based eviction. Once the complete
 * conversation approaches the model token limit, history-compactor.ts
 * summarizes the old span as a whole.
 */

export interface ToolTrailMessage {
  role: string
  content: string
  toolName?: string
  toolCallId?: string
  /** 模型实际调用时的入参 JSON；跨轮回放时恢复成 toolCall.arguments */
  toolArgs?: string
  /** 工具截图；不因消息年龄被卸载，整体压缩时才离开模型上下文。 */
  screenshot?: string
  /** 落盘消息 id。toolCallId 缺失时的稳定替身。 */
  id?: string
}

/** 与 history-compactor.estimateTokens 同口径的粗估（ASCII/4 + 其余/1.6），八行重复优于引入依赖链 */
function estimateTrailTokens(text: string): number {
  let ascii = 0
  let other = 0
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) < 128) ascii++
    else other++
  }
  return Math.ceil(ascii / 4 + other / 1.6)
}

/** finalized 的工具消息才可回放：有名字、有内容。落盘侧（conversation-store）同源引用此判据 */
export function isReplayableToolMessage(m: ToolTrailMessage): boolean {
  return m.role === 'tool' && !!m.toolName && !!(m.content && m.content.trim())
}

/**
 * 单条工具消息在载荷里的 token 成本；measureToolTrail 用它记录实际轨迹占比。
 */
function trailMessageCost(m: ToolTrailMessage): number {
  return estimateTrailTokens(m.content) + estimateTrailTokens(m.toolArgs || '') + (m.screenshot ? 1200 : 0) + 30
}

/**
 * 当前模型载荷里的工具轨迹实际占了多少 token / 多少条（用量落盘观测项）。
 */
export function measureToolTrail(history: ToolTrailMessage[]): { tokens: number; count: number } {
  let tokens = 0
  let count = 0
  for (const m of history) {
    if (m.role !== 'tool') continue
    count++
    tokens += trailMessageCost(m)
  }
  return { tokens, count }
}

// ---- Pi 原生消息对构造（convertHistoryToPiMessages 消费） ----

interface PiTextBlock { type: 'text'; text: string }

/**
 * 把一条 role:'tool' 的 ChatMessage 还原成 Pi 原生的 assistant(toolCall) + toolResult 消息对。
 * pendingTextBlocks：同轮里 tool 之前已流出的助手正文——并进携带 toolCall 的 assistant
 * 消息（与 Pi 运行时"assistant content = [text, toolCall]"的真实形状一致，anthropic
 * 方言的 user/assistant 交替约束因此天然满足）。
 *
 * 协议依据（transform-messages.js 逐行核验）：
 * - toolResult 必须有配对 toolCall，孤儿 result 会被网关拒 → 本函数保证成对产出
 * - assistant 不带 stopReason（undefined ≠ 'error'/'aborted'）→ 不会被整条丢弃
 * - arguments 必须是对象（序列化时才 JSON.stringify）→ 解析失败回退 {}
 */
export function buildToolPairMessages(
  msg: ToolTrailMessage,
  fallbackSeq: number,
  pendingTextBlocks: PiTextBlock[]
): [Record<string, unknown>, Record<string, unknown>] {
  let args: Record<string, unknown> = {}
  if (msg.toolArgs) {
    try {
      const parsed = JSON.parse(msg.toolArgs)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) args = parsed
    } catch { /* 老会话可能保存过非 JSON 入参；原文在结果侧保留 */ }
  }
  // 真实 toolCallId 原样用（不改既有会话的字节）；缺失时退落盘 id，下标只做最后兜底
  // ——下标随轨迹窗口吞吐前移，会让同一条老消息每轮换 id，是前缀缓存的杀手
  const callId = msg.toolCallId || (msg.id ? `hist-${msg.id}` : `hist-tool-${fallbackSeq}`)
  const toolName = msg.toolName || 'tool'
  const resultText = Object.keys(args).length === 0 && msg.toolArgs
    ? `[入参: ${msg.toolArgs}]\n${msg.content || '(无输出)'}`
    : (msg.content || '(无输出)')

  const assistantMsg = {
    role: 'assistant',
    content: [...pendingTextBlocks, { type: 'toolCall', id: callId, name: toolName, arguments: args }],
    timestamp: Date.now()
  }
  const resultContent: Array<Record<string, unknown>> = [{ type: 'text', text: resultText }]
  if (msg.screenshot) {
    const match = /^data:(image\/[a-z.+-]+);base64,([\s\S]*)$/i.exec(msg.screenshot)
    resultContent.push({
      type: 'image',
      data: match ? match[2] : msg.screenshot,
      mimeType: match?.[1] || (msg.screenshot.startsWith('iVBOR') ? 'image/png' : 'image/jpeg')
    })
  }
  const toolResultMsg = {
    role: 'toolResult',
    toolCallId: callId,
    toolName,
    content: resultContent,
    isError: false,
    timestamp: Date.now()
  }
  return [assistantMsg, toolResultMsg]
}

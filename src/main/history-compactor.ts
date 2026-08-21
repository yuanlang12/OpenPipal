/**
 * 历史压缩（保近压远）——只作用于**发给模型的载荷**，UI 消息与落盘会话完全不动，
 * 用户在界面上永远看到连续原文。
 *
 * 策略（对齐 pi-coding-agent compaction 思路）：
 * - token 估算覆盖普通正文、工具入参、工具结果和图片
 * - 触发是双信号取或：字符估算超阈值，**或**上一轮服务商实报的完整载荷超阈值
 *  （证据式锚点，见 recordMeasuredPromptTokens——估算漂移时实测值兜底）
 * - 总量 ≤ 阈值（contextWindow - RESERVE）→ 原样全量发送（现状不变）
 * - 超阈值 → 最近 KEEP_RECENT_TOKENS 的消息原文保留（在 user 消息边界切，
 *   保证助手回答总带着它的问题），更早的用一次性 LLM 压成结构化摘要，
 *   作为一条【前情提要】user 消息置顶
 * - 摘要 + 覆盖水位缓存进 conversation.config.historyCompaction：下次只把
 *   "新滑出保留窗的消息"与旧摘要增量合并，不重复摘要
 * - 摘要 LLM 失败 → 硬截断兜底（旧消息换一行占位），保证请求不超限
 *
 * contextWindow 来自 ModelConfig.contextWindow（用户可配）；不配按 131072 估——
 * 自定义端点的 Pi 模板残留值（8192）不可信，不读它。
 */

import { createHash } from 'crypto'
import { estimateTokens } from './token-estimate'
import type { ChatMessage } from './agent-runtime/contracts'
import { getEffectiveModelConfig, type ModelConfig } from './config-manager'
import { getConversation, updateConversationConfig } from './conversation-store'
import { simpleComplete } from './simple-completion'

const DEFAULT_CONTEXT_WINDOW = 131072
const MAX_RESERVE_TOKENS = 32000    // 系统提示 + 工具 schema + 本轮输出的最大预留
const KEEP_RECENT_TOKENS = 20000    // 对齐 Pi 默认：最近 20k 原文保留
const MIN_KEEP_MESSAGES = 4         // 极短会话不值得触发摘要
const MAX_SUMMARY_TOKENS = 2048     // 给摘要（含前情提要壳）留出的上限
const IMAGE_TOKENS = 1200
const SUMMARIZE_TIMEOUT_MS = 45000

/**
 * 证据式预算锚点：服务商每轮实报的 prompt tokens（input+cacheRead+cacheWrite）。
 * 字符估算只覆盖历史消息，且对代码密集/中文内容有系统性偏差；实测值覆盖发出去的
 * 完整载荷（system + tools + 历史 + 各类注入），是唯一不漂移的信号。对齐 pi-ai
 * estimateContextTokens 的"usage 锚点优先、估算只补空档"思路。
 * 进程内 Map 即可：压缩判断只在 main 进程发生；重启后首轮回落到估算，属可接受冷启动。
 * 模型切换后分词器不同，锚点按 model 校验，不跨模型沿用。
 */
const measuredPromptAnchors = new Map<string, { model: string; promptTokens: number }>()

export function recordMeasuredPromptTokens(
  conversationId: string | undefined,
  model: string | undefined,
  promptTokens: number
): void {
  if (!conversationId || !model || !Number.isFinite(promptTokens) || promptTokens <= 0) return
  measuredPromptAnchors.set(conversationId, { model, promptTokens })
}

/** contextWindow/budget 同口径计算——供 agentChat 的 context_usage 观测事件复用，避免两处算法漂移 */
/** mc 可选：会话专属模型场景传解析后的配置（contextWindow 按实际发往的模型算）；缺省用全局。 */
export function getContextBudget(mc?: Pick<ModelConfig, 'contextWindow'>): { contextWindow: number; budget: number } {
  const configured = (mc ?? getEffectiveModelConfig())?.contextWindow
  const contextWindow = Number.isFinite(configured) && (configured as number) > 0
    ? Math.floor(configured as number)
    : DEFAULT_CONTEXT_WINDOW
  // 低上下文模型不能继续沿用固定 32k 预留，更不能把预算抬回 16k。
  // 最多占模型窗口的一半，始终确保 history budget 不会宣称超过真实窗口。
  const reserve = Math.min(MAX_RESERVE_TOKENS, Math.floor(contextWindow / 2))
  const budget = Math.max(1, contextWindow - reserve)
  return { contextWindow, budget }
}

export function estimateHistoryMessageTokens(m: ChatMessage): number {
  // renderer 对普通图片消息会同时填 images 与 screenshot=images[0]，两者是同一份视觉输入，
  // 不能重复计费；工具截图通常只有 screenshot。
  const imgs = m.images?.length || (m.screenshot || m.screenshotRef ? 1 : 0)
  return estimateTokens(m.content || '') + estimateTokens(m.toolArgs || '') + imgs * IMAGE_TOKENS + 8
}

function estimateHistoryTokens(messages: ChatMessage[]): number {
  return messages.reduce((sum, message) => sum + estimateHistoryMessageTokens(message), 0)
}

/**
 * 摘要缓存只代表历史某个精确前缀。编辑、重新生成、删图等都会改变这份摘要的事实基础，
 * 因此不能只凭 coveredCount 复用；同条数不同内容必须重新摘要。
 */
export function digestHistoryPrefix(history: ChatMessage[], count: number): string {
  const hash = createHash('sha256')
  for (const message of history.slice(0, Math.max(0, count))) {
    hash.update(JSON.stringify([
      message.role,
      message.content,
      message.screenshot,
      message.screenshotRef,
      message.images,
      message.imagePaths,
      message.fileAttachments,
      message.toolName,
      message.toolCallId,
      message.toolArgs
    ]))
    hash.update('\u0000')
  }
  return hash.digest('hex')
}

function takeWithinTokenBudget(text: string, budget: number, fromEnd: boolean): string {
  if (budget <= 0 || !text) return ''
  if (estimateTokens(text) <= budget) return text
  let low = 0
  let high = text.length
  while (low < high) {
    const mid = Math.ceil((low + high) / 2)
    const candidate = fromEnd ? text.slice(text.length - mid) : text.slice(0, mid)
    if (estimateTokens(candidate) <= budget) low = mid
    else high = mid - 1
  }
  return fromEnd ? text.slice(text.length - low) : text.slice(0, low)
}

function buildSummaryPreamble(summary: string, summarizedCount: number): string {
  return `【前情提要】以下是本会话更早 ${summarizedCount} 条消息的压缩摘要（原文已省略，最近的对话在后面原样保留）：\n\n${summary}`
}

/** 将异常长的摘要确定性地压回为它预留的空间，防止摘要本身挤爆低上下文模型。 */
function fitSummaryPreamble(summary: string, summarizedCount: number, tokenBudget: number): string {
  const shell = buildSummaryPreamble('', summarizedCount)
  const textBudget = Math.max(0, tokenBudget - estimateTokens(shell))
  if (estimateTokens(summary) <= textBudget) return buildSummaryPreamble(summary, summarizedCount)

  const marker = '\n…[前情提要因上下文窗口缩短，保留首尾]…\n'
  const available = Math.max(0, textBudget - estimateTokens(marker))
  const head = takeWithinTokenBudget(summary, Math.ceil(available * 0.7), false)
  const tail = takeWithinTokenBudget(summary, Math.floor(available * 0.3), true)
  return buildSummaryPreamble(`${head}${marker}${tail}`, summarizedCount)
}

function capSummaryToolField(text: string, limit = 2000): string {
  if (text.length <= limit) return text
  const head = Math.floor(limit * 0.6)
  const tail = limit - head
  return `${text.slice(0, head)}\n…[压缩摘要取材时省略 ${text.length - limit} 字符]…\n${text.slice(-tail)}`
}

export function serializeForSummary(msgs: ChatMessage[]): string {
  return msgs.map(m => {
    const imageCount = m.images?.length || (m.screenshot || m.screenshotRef ? 1 : 0)
    const images = imageCount ? `[附 ${imageCount} 张图片] ` : ''
    if (m.role === 'tool') {
      const args = m.toolArgs ? `\n[工具入参]\n${capSummaryToolField(m.toolArgs)}` : ''
      return `工具 ${m.toolName || 'unknown'}:${args}\n[工具结果]\n${images}${capSummaryToolField(m.content || '')}`
    }
    const who = m.role === 'user' ? '用户' : m.role === 'assistant' ? '助手' : '系统'
    return `${who}: ${images}${m.content || ''}`
  }).join('\n---\n')
}

async function summarize(
  prevSummary: string,
  newMsgs: ChatMessage[],
  modelConfig?: ModelConfig,
  signal?: AbortSignal
): Promise<string> {
  const base = prevSummary
    ? `已有的前情摘要：\n${prevSummary}\n\n新滑出窗口的对话（把它合并进摘要，输出更新后的完整摘要）：`
    : `以下是一段对话的较早部分（请压缩成摘要）：`
  const prompt = `${base}\n\n${serializeForSummary(newMsgs)}\n\n输出要求：中文结构化摘要，≤1500 字，按【目标】【约束与偏好】【已完成】【进行中】【未决事项】【关键决定】【关键证据与引用】组织。必须保留工具已经做过的事情、失败原因，以及精确标识（artifact id、文件路径、链接、命令、数字）；不要把尚未完成的事写成已完成。只输出摘要本身。`
  let timeoutId: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<string>((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error('summarize timeout')), SUMMARIZE_TIMEOUT_MS)
  })
  let onAbort: (() => void) | undefined
  const aborted = new Promise<string>((_, reject) => {
    onAbort = () => reject(new Error('summarize aborted'))
    if (signal?.aborted) onAbort()
    else signal?.addEventListener('abort', onAbort, { once: true })
  })
  try {
    return await Promise.race([
      simpleComplete({ prompt, systemPrompt: '你是对话摘要引擎，只输出摘要正文。', modelConfig, signal }),
      timeout,
      aborted
    ])
  } finally {
    if (timeoutId) clearTimeout(timeoutId)
    if (onAbort) signal?.removeEventListener('abort', onAbort)
  }
}

/**
 * 入口：agentChat 在 convertHistoryToPiMessages 之前调用。
 * 返回给模型的历史投影；不修改传入数组。
 */
export async function compactHistoryForModel(
  history: ChatMessage[],
  conversationId?: string,
  mc?: ModelConfig,
  opts?: { force?: boolean; signal?: AbortSignal }
): Promise<ChatMessage[]> {
  if (opts?.signal?.aborted) throw new Error('history compaction aborted')
  if (history.length <= MIN_KEEP_MESSAGES) return history
  const { budget } = getContextBudget(mc)
  // 只需要"是否超预算"，累加过线即停（长会话逐字符估算不便宜）
  let total = 0
  for (const m of history) {
    total += estimateHistoryMessageTokens(m)
    if (total > budget) break
  }
  // 证据式预算：估算之外，上一轮实报的完整载荷超预算同样触发。估算漏报
  // （代码密集内容低估、窗口配大、system/tools 不在历史估算范围内）时，
  // 这条实测线兜底。force 供溢出自愈使用——撞墙事实本身就是证据，无条件压。
  const anchor = conversationId ? measuredPromptAnchors.get(conversationId) : undefined
  const measuredOver = !!anchor && anchor.model === mc?.model && anchor.promptTokens > budget
  if (measuredOver && total <= budget) {
    console.log(`[Compactor] 实测载荷 ${anchor!.promptTokens}t 超预算 ${budget}t（历史估算 ${total}t 未报警）——按实测触发压缩`)
  }
  if (total <= budget && !measuredOver && !opts?.force) return history

  // 从末尾回溯圈定"保留区"，再对齐到 user 消息边界。
  // 摘要也占输入窗口，因此最近原文必须从总 budget 中扣出摘要空间。
  const summaryBudget = Math.min(MAX_SUMMARY_TOKENS, Math.max(1, Math.floor(budget / 4)))
  const recentBudget = Math.min(KEEP_RECENT_TOKENS, Math.max(1, budget - summaryBudget))
  let keepStart = history.length
  let acc = 0
  for (let i = history.length - 1; i >= 0; i--) {
    const messageTokens = estimateHistoryMessageTokens(history[i])
    if (acc + messageTokens > recentBudget && keepStart < history.length) break
    acc += messageTokens
    keepStart = i
  }
  while (keepStart < history.length && history[keepStart].role !== 'user') keepStart++
  // 一条异常大的最新消息无法再切半；保留它是比静默丢弃更安全的降级。
  if (keepStart >= history.length) keepStart = history.length - 1
  const olderCount = keepStart
  if (olderCount === 0) return history

  // 摘要：命中缓存直接用；水位落后少量（滞回带内）→ 沿用旧摘要 + 未覆盖消息保留原文，
  // 避免压缩激活后每一轮都调一次 LLM 增量合并；落后超过滞回带才真正重摘
  const HYSTERESIS_MSGS = 6
  const HYSTERESIS_TOKENS = 8000
  const conv = conversationId ? getConversation(conversationId) : null
  const cached = (conv?.config as any)?.historyCompaction as {
    summary: string
    coveredCount: number
    coveredDigest?: string
  } | undefined
  let summary = ''
  let summarizedCount = olderCount
  const cachePrefixMatches = !!(
    cached?.summary
    && cached.coveredCount <= olderCount
    && cached.coveredDigest
    && cached.coveredDigest === digestHistoryPrefix(history, cached.coveredCount)
  )
  const drift = cachePrefixMatches ? olderCount - cached!.coveredCount : Infinity
  const driftTokens = drift > 0 && drift !== Infinity
    ? history.slice(cached!.coveredCount, olderCount).reduce((s, m) => s + estimateHistoryMessageTokens(m), 0)
    : 0
  const cachedProjection = cachePrefixMatches
    ? estimateTokens(fitSummaryPreamble(cached!.summary, cached!.coveredCount, summaryBudget))
      + estimateHistoryTokens(history.slice(cached!.coveredCount))
    : Infinity
  if (drift < HYSTERESIS_MSGS && driftTokens < HYSTERESIS_TOKENS && cachedProjection <= budget) {
    summary = cached!.summary
    summarizedCount = cached!.coveredCount
  } else {
    const fromIdx = cachePrefixMatches && cached!.coveredCount < olderCount ? cached!.coveredCount : 0
    const prev = fromIdx > 0 ? cached!.summary : ''
    try {
      summary = (await summarize(prev, history.slice(fromIdx, olderCount), mc, opts?.signal)).trim()
    } catch (err: any) {
      if (opts?.signal?.aborted) throw err
      console.warn('[Compactor] 摘要失败，走硬截断兜底:', err?.message)
    }
    if (summary && conv && conversationId) {
      try {
        await updateConversationConfig(conversationId, {
          ...(conv.config || {}),
          historyCompaction: {
            summary,
            coveredCount: olderCount,
            coveredDigest: digestHistoryPrefix(history, olderCount)
          }
        } as any)
      } catch { /* 缓存写失败不影响本轮 */ }
    }
  }

  // 滞回命中时 summarizedCount < keepStart：摘要与保留窗之间的原文一并保留
  const recent = history.slice(summary ? summarizedCount : keepStart)
  const preamble: ChatMessage = summary
    ? { role: 'user', content: fitSummaryPreamble(summary, summarizedCount, summaryBudget) }
    : { role: 'user', content: `（本会话更早的 ${olderCount} 条消息因长度限制已省略）` }
  console.log(`[Compactor] 历史压缩: ${history.length} 条 → 摘要 + ${recent.length} 条原文 (超过预算 ${budget}t)`)
  return [preamble, ...recent]
}

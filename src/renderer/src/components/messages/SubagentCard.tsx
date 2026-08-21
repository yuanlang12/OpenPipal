/**
 * SubagentCard —— 主对话流里 subagent 工具调用的卡片（inline 折叠 / 展开）
 *
 * 设计原则（用户决策迭代后）：
 * - subagent 本质是"一个嵌套的对话流"，跟主对话一样的范式，只是层级被收起
 * - 不造新概念（无 "👤 user"/"🤖 assistant" 标签 / 无 border-l-2 树状缩进 / 无 section header）
 * - 内部消息流直接复用主对话的 MessageBubble 渲染——主对话样式升级会自动同步
 * - 折叠态对齐 OpenPipal thinking 模块"完成即收起"交互
 *
 * 数据流：
 * - message.toolArgs = JSON 序列化的 cardData（profile/modelId/usage/task/messages/...）
 * - 展开时 piMessagesToChatMessages() 把 Pi Message[] 转 ChatMessage[]，用 MessageBubble 渲染
 *
 * 关键约束：
 * - finalText 不展示给用户（它是给主 agent 的工具返回值，主 agent 消化后自己出一条 assistant message 给用户）
 * - child messages 经 toolArgs 序列化进 conversation.json（每次调用 KB 级，可接受）
 */

import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Sparkles, CheckCircle2, AlertCircle, ChevronDown } from 'lucide-react'
import type { ChatMessage } from '../../types'
import { MessageBubble } from '../MessageBubble'

import { parseSubagentMaxTurnsNotice } from '../../../../shared/runtime-notice'

/** maxTurns 中止是本进程自造的提示，落盘时是语言中立哨兵，展示时才翻译 */
function localizeSubagentError(
  t: (key: string, values?: Record<string, unknown>) => string,
  message: string
): string {
  const maxTurns = parseSubagentMaxTurnsNotice(message)
  return maxTurns === null ? message : t('chat.subagent.maxTurnsReached', { maxTurns })
}

interface ChildMessage {
  role: 'user' | 'assistant' | 'toolResult' | string
  content?: any
  toolCallId?: string
  toolName?: string
  timestamp?: number
}

interface CardData {
  profile?: string
  modelId?: string
  usage?: {
    input?: number
    output?: number
    cacheRead?: number
    cacheWrite?: number
    cost?: number
    turns?: number
  }
  task?: string
  persona?: string
  messages?: ChildMessage[]
  finalText?: string
  stopReason?: string
  errorMessage?: string
}

function fmtTokens(n?: number): string {
  if (!n) return '0'
  if (n < 1000) return String(n)
  if (n < 10000) return `${(n / 1000).toFixed(1)}k`
  return `${Math.round(n / 1000)}k`
}

function fmtCost(c?: number): string {
  if (!c || c < 0.0001) return ''
  if (c < 0.01) return `$${c.toFixed(4)}`
  return `$${c.toFixed(3)}`
}

function tryParseCardData(msg: ChatMessage): CardData {
  if (!msg.toolArgs) return {}
  try {
    const parsed = JSON.parse(msg.toolArgs)
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

/**
 * Pi Message[] → OpenPipal ChatMessage[] 转换
 *
 * Pi 的 assistant message 可能包含多个 content blocks（text / toolCall / thinking）
 * 拆成多条 ChatMessage 后用 MessageBubble 各自渲染（跟主对话流处理一致）。
 *
 * toolResult message 通过 toolCallId 反向匹配上面的 tool message 合并 content
 * （这样 ToolCallCard 在 result 字段渲染工具结果，跟主对话 tool 卡片行为一致）。
 */
export function piMessagesToChatMessages(
  messages: ChildMessage[],
  noOutput: string,
  parentMessageId: string,
  parentTimestamp: number
): ChatMessage[] {
  const result: ChatMessage[] = []
  const fallbackTimestamp = Number.isFinite(parentTimestamp) ? parentTimestamp : 0
  let idx = 0

  const extractText = (content: any): string => {
    if (typeof content === 'string') return content
    if (!Array.isArray(content)) return ''
    return content
      .filter(c => c?.type === 'text' && c.text)
      .map(c => c.text)
      .join('\n')
  }

  // 第一遍：建主消息
  for (let messageIndex = 0; messageIndex < messages.length; messageIndex++) {
    const m = messages[messageIndex]
    if (!m || typeof m !== 'object') continue
    const sourceTimestamp = typeof m.timestamp === 'number' && Number.isFinite(m.timestamp)
      ? m.timestamp
      : fallbackTimestamp + messageIndex

    if (m.role === 'user') {
      const sequence = idx++
      result.push({
        id: `sub-${parentMessageId}-${sequence}`,
        role: 'user',
        content: extractText(m.content),
        timestamp: sourceTimestamp,
      })
    } else if (m.role === 'assistant') {
      if (Array.isArray(m.content)) {
        for (const block of m.content) {
          if (!block || typeof block !== 'object') continue
          if (block.type === 'text' && block.text) {
            const sequence = idx++
            result.push({
              id: `sub-${parentMessageId}-${sequence}`,
              role: 'assistant',
              content: block.text,
              timestamp: sourceTimestamp,
            })
          } else if (block.type === 'toolCall') {
            // 用 toolCallId 关联后续 toolResult；content 待填
            const sequence = idx++
            result.push({
              id: `sub-${parentMessageId}-${sequence}`,
              role: 'tool',
              content: '',
              toolName: block.name,
              toolArgs: block.arguments ? JSON.stringify(block.arguments) : undefined,
              timestamp: sourceTimestamp,
              // 额外字段，用于第二遍匹配
              ...(block.id ? { _toolCallId: block.id } : {}),
            } as ChatMessage & { _toolCallId?: string })
          }
          // thinking blocks 忽略——child agent 的思考不需要在 subagent 展开里再展示
        }
      } else if (typeof m.content === 'string' && m.content) {
        const sequence = idx++
        result.push({
          id: `sub-${parentMessageId}-${sequence}`,
          role: 'assistant',
          content: m.content,
          timestamp: sourceTimestamp,
        })
      }
    } else if (m.role === 'toolResult') {
      // 通过 toolCallId 找到对应 tool message 合并 content
      const resultText = extractText(m.content)
      const targetId = m.toolCallId
      let matched = false
      if (targetId) {
        for (let i = result.length - 1; i >= 0; i--) {
          const rm = result[i] as ChatMessage & { _toolCallId?: string }
          if (rm.role === 'tool' && rm._toolCallId === targetId && !rm.content) {
            result[i] = { ...rm, content: resultText || noOutput }
            matched = true
            break
          }
        }
      }
      // 兜底：找最近一条无 content 的 tool message
      if (!matched) {
        for (let i = result.length - 1; i >= 0; i--) {
          if (result[i].role === 'tool' && !result[i].content) {
            result[i] = { ...result[i], content: resultText || noOutput }
            break
          }
        }
      }
    }
  }

  // 清理临时字段（避免泄漏到 MessageBubble）
  return result.map(m => {
    const clone = { ...m } as any
    delete clone._toolCallId
    return clone as ChatMessage
  })
}

export function SubagentCard({ message }: { message: ChatMessage }) {
  const { t } = useTranslation()
  const [expanded, setExpanded] = useState(false)

  const data = useMemo(() => tryParseCardData(message), [message.toolArgs])
  const isError = !!data.errorMessage || data.stopReason === 'error' || data.stopReason === 'aborted'

  const u = data.usage || {}
  const tokenParts: string[] = []
  if (u.turns) tokenParts.push(t('chat.subagent.turns', { count: u.turns }))
  if (u.input) tokenParts.push(`↑${fmtTokens(u.input)}`)
  if (u.output) tokenParts.push(`↓${fmtTokens(u.output)}`)
  const cost = fmtCost(u.cost)
  if (cost) tokenParts.push(cost)

  const childMessages = data.messages || []
  const hasHistory = childMessages.length > 0
  const noOutput = t('chat.subagent.noOutput')
  const chatMessages = useMemo(
    () => expanded
      ? piMessagesToChatMessages(childMessages, noOutput, message.id, message.timestamp)
      : [],
    [childMessages, expanded, message.id, message.timestamp, noOutput]
  )

  return (
    <div className="flex justify-start mb-msg animate-fade-in">
      <div className="group/sub max-w-msg w-full rounded-lg border border-brand-200/60 dark:border-brand-700/60 bg-brand-50/40 dark:bg-brand-900/20 overflow-hidden">
        {/* 顶部：profile + status + via modelId */}
        <div className="min-w-0 flex items-center gap-2 px-3 py-2 border-b border-brand-100/60 dark:border-brand-800/60">
          <Sparkles className="w-3.5 h-3.5 text-brand-500 shrink-0" />
          <span className="text-chat-label font-semibold text-brand-700 dark:text-brand-300 shrink-0">{t('chat.subagent.label')}</span>
          <span
            className="min-w-0 truncate text-chat-label text-surface-700 font-medium"
            title={data.profile}
          >
            {data.profile || t('chat.subagent.unknownProfile')}
          </span>
          {isError ? (
            <AlertCircle
              role="img"
              aria-label={t('chat.subagent.status.failed')}
              className="w-3.5 h-3.5 text-red-500 shrink-0"
            />
          ) : (
            <CheckCircle2
              role="img"
              aria-label={t('chat.subagent.status.completed')}
              className="w-3.5 h-3.5 text-emerald-500 shrink-0"
            />
          )}
          {data.modelId && (
            <span
              className="min-w-0 max-w-[45%] truncate text-chat-small text-surface-400 ml-auto"
              title={data.modelId}
            >
              {t('chat.subagent.via')} {data.modelId}
            </span>
          )}
        </div>

        {/* 展开态：嵌套对话流——直接用 MessageBubble 渲染 child messages */}
        {expanded && (
          <div className="px-3 py-3 max-h-[600px] overflow-auto">
            {chatMessages.length > 0 ? (
              chatMessages.map(m => (
                <MessageBubble key={m.id} message={m} />
              ))
            ) : (
              <div className="text-chat-label text-surface-400">{t('chat.subagent.noHistory')}</div>
            )}
          </div>
        )}

        {/* 折叠时显示错误提示——让用户知道失败了 */}
        {!expanded && isError && data.errorMessage && (
          <div className="px-3 py-1.5 text-chat-meta text-red-500 bg-red-50/50 dark:bg-red-900/20 break-words">
            {t('chat.subagent.errorLabel')}: {localizeSubagentError(t, data.errorMessage)}
          </div>
        )}

        {/* 底部：token 统计 + 展开/收起按钮 */}
        <div className="flex items-center gap-2 px-3 py-1.5 bg-surface-50/50 dark:bg-surface-50/40 border-t border-brand-100/40 dark:border-brand-800/40">
          <div className="flex items-center gap-2 text-chat-small text-surface-400 flex-wrap">
            {tokenParts.length > 0
              ? tokenParts.map((p, i) => <span key={i}>{p}</span>)
              : <span>{t('chat.subagent.noUsage')}</span>}
            {data.stopReason && data.stopReason !== 'stop' && data.stopReason !== 'end_turn' && (
              <span className="max-w-full truncate text-amber-500" title={data.stopReason}>
                {t('chat.subagent.stopReasonLabel')}: {data.stopReason}
              </span>
            )}
          </div>
          {hasHistory && (
            <button
              onClick={() => setExpanded(!expanded)}
              aria-expanded={expanded}
              className={`ml-auto flex items-center gap-1 px-2 py-0.5 text-chat-meta font-medium text-brand-600 dark:text-brand-400 hover:bg-brand-100/60 dark:hover:bg-brand-900/40 rounded transition-all opacity-0 group-hover/sub:opacity-100 group-has-[:focus-visible]/sub:opacity-100`}
              title={expanded ? t('chat.subagent.collapseTitle') : t('chat.subagent.expandTitle')}
            >
              <ChevronDown
                className={`w-3 h-3 transition-transform duration-200 ${expanded ? 'rotate-180' : ''}`}
              />
              {expanded ? t('chat.subagent.collapse') : t('chat.subagent.expand')}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

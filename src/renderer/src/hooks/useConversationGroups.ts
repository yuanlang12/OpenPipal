import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { useChatStore, ConversationSummary } from '../stores/chatStore'
import { getConversationDisplayTitle } from '../utils/conversationDisplayTitle'

// 会话历史的分组/过滤逻辑——Sidebar 与浏览器顶栏 HistoryPopover 共用，避免两份漂移。
export type DateGroup = '今天' | '昨天' | '本周' | '更早'
const DATE_GROUP_ORDER: DateGroup[] = ['今天', '昨天', '本周', '更早']

export function timeAgo(ts: number): string {
  const diff = Date.now() - ts
  const minutes = Math.floor(diff / 60000)
  if (minutes < 1) return '刚刚'
  if (minutes < 60) return `${minutes}分钟前`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}小时前`
  const days = Math.floor(hours / 24)
  if (days < 7) return `${days}天前`
  return new Date(ts).toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' })
}

export interface ConversationGroup {
  label: DateGroup
  items: ConversationSummary[]
}

export interface GroupedConversations {
  /** 用户在 App 内创建的会话，按日期分组 */
  groups: ConversationGroup[]
  /** ACP 等外部客户端产生的会话——默认折叠展示，按 updatedAt 降序（沿用列表原序） */
  external: ConversationSummary[]
}

// ACP 会话没有独立的 source 落盘字段，openpipal-acp 适配器无条件给标题加此前缀
// （openpipal-acp/src/agent.ts），标题前缀即持久标记；用户手动改名 = 主动收编进主列表。
export function isAcpConversation(conv: ConversationSummary): boolean {
  return conv.title.startsWith('[ACP]')
}

export function groupConversations(
  conversations: ConversationSummary[],
  query: string,
  displayTitle: (conversation: ConversationSummary) => string = conversation => conversation.title,
): GroupedConversations {
  const q = query.trim().toLowerCase()
  const filtered = q
    ? conversations.filter(c => (
        c.title.toLowerCase().includes(q)
        || displayTitle(c).toLowerCase().includes(q)
      ))
    : conversations
  const external = filtered.filter(isAcpConversation)
  const own = filtered.filter(c => !isAcpConversation(c))
  const now = new Date()
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  const yesterdayStart = todayStart - 86400000
  const dayOfWeek = now.getDay() || 7
  const weekStart = todayStart - (dayOfWeek - 1) * 86400000
  const groupMap = new Map<DateGroup, ConversationSummary[]>()
  for (const conv of own) {
    const ts = conv.updatedAt
    const group: DateGroup = ts >= todayStart ? '今天' : ts >= yesterdayStart ? '昨天' : ts >= weekStart ? '本周' : '更早'
    if (!groupMap.has(group)) groupMap.set(group, [])
    groupMap.get(group)!.push(conv)
  }
  return {
    groups: DATE_GROUP_ORDER.filter(l => groupMap.has(l)).map(label => ({ label, items: groupMap.get(label)! })),
    external
  }
}

// 直接从 chatStore 读 conversations，调用方只需传入（已 debounce 的）查询串。
export function useConversationGroups(query: string): GroupedConversations {
  const conversations = useChatStore(s => s.conversations)
  const { t } = useTranslation()
  return useMemo(
    () => groupConversations(conversations, query, conversation => getConversationDisplayTitle(conversation, t)),
    [conversations, query, t],
  )
}

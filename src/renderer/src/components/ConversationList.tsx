import { useState, useMemo, useCallback, useRef, useEffect } from 'react'
import { Plus, X, Trash2, Search, Download } from 'lucide-react'
import { ChatMessage } from '../types'
import { getTranscriptText, shouldIncludeInTranscriptExport } from '../chat/messages'
import { useAgentStore } from '../stores/agentStore'
import { RoleAvatar } from './shared/RoleAvatar'
import { ConvStatusDot } from './shared/ConvStatusDot'

interface ConversationSummary {
  id: string
  title: string
  role: string
  workspaceId?: string
  createdAt: number
  updatedAt: number
  messageCount: number
  lastMessage?: string
}

interface ConversationListProps {
  conversations: ConversationSummary[]
  activeId: string | null
  onSelect: (id: string) => void
  onDelete: (id: string) => void
  onNew: () => void
  onClose: () => void
}

function timeAgo(ts: number): string {
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

type DateGroup = '今天' | '昨天' | '本周' | '更早'
const DATE_GROUP_ORDER: DateGroup[] = ['今天', '昨天', '本周', '更早']

// 格式化对话为 Markdown
async function exportConversation(conv: ConversationSummary): Promise<void> {
  const messages = await window.api.getConversationMessages(conv.id) as ChatMessage[]
  if (!messages?.length) return

  const now = new Date().toLocaleDateString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' })
  let md = `# ${conv.title}\n_导出时间: ${now}_\n\n---\n`

  for (const msg of messages) {
    if (!shouldIncludeInTranscriptExport(msg)) continue
    const label = msg.role === 'user' ? '用户' : '助手'
    md += `\n**${label}**: ${getTranscriptText(msg)}\n\n---\n`
  }

  const fileName = `${conv.title.replace(/[/\\?%*:|"<>]/g, '_')}.md`

  // 桌面模式：使用系统保存对话框
  if (window.api.saveMarkdownDialog) {
    const filePath = await window.api.saveMarkdownDialog(fileName)
    if (filePath) {
      await window.api.writeTextFile(filePath, md)
    }
  } else {
    // 浏览器模式：Blob 下载
    const blob = new Blob([md], { type: 'text/markdown;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = fileName
    a.click()
    URL.revokeObjectURL(url)
  }
}

export function ConversationList({ conversations, activeId, onSelect, onDelete, onNew, onClose }: ConversationListProps) {
  const workspaces = useAgentStore(s => s.workspaces)
  const getWorkspaceIcon = useCallback((wid?: string) => workspaces.find(w => w.id === wid), [workspaces])
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)
  const [searchQuery, setSearchQuery] = useState('')
  const [debouncedQuery, setDebouncedQuery] = useState('')
  const debounceRef = useRef<ReturnType<typeof setTimeout>>()
  const searchInputRef = useRef<HTMLInputElement>(null)

  // 300ms 防抖搜索
  const handleSearch = useCallback((value: string) => {
    setSearchQuery(value)
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => setDebouncedQuery(value), 300)
  }, [])

  // 自动聚焦搜索框
  useEffect(() => {
    searchInputRef.current?.focus()
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current) }
  }, [])

  // 过滤 + 按日期分组（日期边界只计算一次）
  const groupedConversations = useMemo(() => {
    const query = debouncedQuery.trim().toLowerCase()
    const filtered = query
      ? conversations.filter(c => c.title.toLowerCase().includes(query))
      : conversations

    const now = new Date()
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
    const yesterdayStart = todayStart - 86400000
    const dayOfWeek = now.getDay() || 7
    const weekStart = todayStart - (dayOfWeek - 1) * 86400000

    const groupMap = new Map<DateGroup, ConversationSummary[]>()
    for (const conv of filtered) {
      const ts = conv.updatedAt
      const group: DateGroup = ts >= todayStart ? '今天' : ts >= yesterdayStart ? '昨天' : ts >= weekStart ? '本周' : '更早'
      if (!groupMap.has(group)) groupMap.set(group, [])
      groupMap.get(group)!.push(conv)
    }

    return DATE_GROUP_ORDER.filter(l => groupMap.has(l)).map(label => ({ label, items: groupMap.get(label)! }))
  }, [conversations, debouncedQuery])

  const totalFiltered = groupedConversations.reduce((s, g) => s + g.items.length, 0)

  return (
    <div className="fixed inset-0 z-50 bg-black/20 dark:bg-black/40" onClick={onClose}>
      <div
        className="absolute top-10 left-2 right-2 bg-surface-0 dark:bg-surface-50 rounded-xl shadow-xl border border-surface-100 max-h-[70vh] overflow-hidden animate-fade-in"
        onClick={e => e.stopPropagation()}
      >
        {/* 头部 */}
        <div className="flex items-center justify-between px-3 py-2.5 border-b border-surface-100">
          <h2 className="text-xs font-semibold text-surface-700">对话历史</h2>
          <div className="flex items-center gap-1">
            <button
              onClick={onNew}
              className="flex items-center gap-1 text-sw-sm text-brand-600 dark:text-brand-400 hover:text-brand-700 dark:hover:text-brand-300 px-2 py-1 rounded-md hover:bg-brand-50 dark:hover:bg-brand-900/30 transition-colors"
            >
              <Plus className="w-3 h-3" />
              新建
            </button>
            <button
              onClick={onClose}
              className="text-surface-400 hover:text-surface-600 transition-colors p-1"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>

        {/* 搜索框 */}
        <div className="px-3 py-2 border-b border-surface-100">
          <div className="relative">
            <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3 h-3 text-surface-300" />
            <input
              ref={searchInputRef}
              type="text"
              value={searchQuery}
              onChange={e => handleSearch(e.target.value)}
              placeholder="搜索对话..."
              className="w-full pl-7 pr-2 py-1.5 text-sw-sm rounded-md bg-surface-50 border border-surface-100 text-surface-700 placeholder:text-surface-300 focus:outline-none focus:ring-1 focus:ring-brand-400 dark:focus:ring-brand-500 transition-colors"
            />
            {searchQuery && (
              <button
                onClick={() => { setSearchQuery(''); setDebouncedQuery('') }}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-surface-300 hover:text-surface-500"
              >
                <X className="w-3 h-3" />
              </button>
            )}
          </div>
        </div>

        {/* 对话列表（按日期分组） */}
        <div className="overflow-y-auto max-h-[55vh]">
          {totalFiltered === 0 ? (
            <div className="text-center py-8">
              <p className="text-xs text-surface-300">
                {debouncedQuery ? '没有匹配的对话' : '还没有对话记录'}
              </p>
            </div>
          ) : (
            <div className="py-1">
              {groupedConversations.map(({ label, items }) => (
                <div key={label}>
                  {/* 分组标题 */}
                  <div className="px-3 pt-2.5 pb-1 flex items-center gap-2">
                    <span className="text-sw-xs font-medium text-surface-300 uppercase tracking-wider">
                      {label}
                    </span>
                    <div className="flex-1 h-px bg-surface-100" />
                  </div>
                  {/* 分组内的对话项 */}
                  {items.map((conv) => (
                    <div
                      key={conv.id}
                      className={`group flex items-start gap-2 px-3 py-2 mx-1 rounded-lg cursor-pointer transition-colors ${
                        conv.id === activeId
                          ? 'bg-brand-50 dark:bg-brand-900/30 border border-brand-200/60 dark:border-brand-700'
                          : 'hover:bg-surface-50 border border-transparent'
                      }`}
                      onClick={() => onSelect(conv.id)}
                    >
                      <span className="mt-0.5 shrink-0 flex items-center">
                        {conv.workspaceId
                          ? <span className="text-sm">{getWorkspaceIcon(conv.workspaceId)?.icon || '🤖'}</span>
                          : <RoleAvatar role={{ name: conv.role }} size={15} className="text-surface-400" />}
                      </span>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-1.5">
                          <span className={`text-sw-base font-medium truncate ${
                            conv.id === activeId ? 'text-brand-700 dark:text-brand-300' : 'text-surface-700'
                          }`}>
                            {conv.title}
                          </span>
                          <ConvStatusDot id={conv.id} />
                          {conv.workspaceId && (
                            <span className="shrink-0 text-sw-xs px-1.5 py-0.5 rounded-full bg-brand-50 dark:bg-brand-900/30 text-brand-500 dark:text-brand-400 border border-brand-100 dark:border-brand-800">
                              {getWorkspaceIcon(conv.workspaceId)?.name || 'Agent'}
                            </span>
                          )}
                        </div>
                        <div className="flex items-center gap-2 mt-0.5">
                          <span className="text-sw-xs text-surface-300">
                            {conv.messageCount}条消息
                          </span>
                          <span className="text-sw-xs text-surface-300">
                            {timeAgo(conv.updatedAt)}
                          </span>
                        </div>
                        {conv.lastMessage && (
                          <p className="text-sw-sm text-surface-400 truncate mt-0.5">
                            {conv.lastMessage}
                          </p>
                        )}
                      </div>
                      {/* 操作按钮 */}
                      <div className="shrink-0 flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                        {/* 导出按钮 */}
                        <button
                          onClick={(e) => {
                            e.stopPropagation()
                            exportConversation(conv)
                          }}
                          className="text-surface-300 hover:text-brand-500 dark:hover:text-brand-400 p-0.5 rounded transition-colors"
                          title="导出 Markdown"
                        >
                          <Download className="w-3 h-3" />
                        </button>
                        {/* 删除按钮 */}
                        {confirmDeleteId === conv.id ? (
                          <button
                            onClick={(e) => {
                              e.stopPropagation()
                              onDelete(conv.id)
                              setConfirmDeleteId(null)
                            }}
                            className="text-sw-xs text-red-500 hover:text-red-600 px-1.5 py-0.5 rounded bg-red-50 dark:bg-red-900/30 border border-red-200 dark:border-red-700"
                          >
                            确认
                          </button>
                        ) : (
                          <button
                            onClick={(e) => {
                              e.stopPropagation()
                              setConfirmDeleteId(conv.id)
                              setTimeout(() => setConfirmDeleteId(null), 3000)
                            }}
                            className="text-surface-300 hover:text-red-400 p-0.5 rounded transition-colors"
                          >
                            <Trash2 className="w-3 h-3" />
                          </button>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

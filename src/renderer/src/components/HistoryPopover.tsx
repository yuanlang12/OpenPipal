import { useState, useRef, useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { Clock, Search, X, Trash2, ChevronRight } from 'lucide-react'
import { useChatStore, ConversationSummary } from '../stores/chatStore'
import { useAgentStore } from '../stores/agentStore'
import { useAppStore } from '../stores/appStore'
import { useConversationGroups } from '../hooks/useConversationGroups'
import { getConversationDisplayTitle } from '../utils/conversationDisplayTitle'
import {
  getConversationGroupKey,
  getConversationTimeDescriptor,
} from '../../../shared/i18n/resources'
import { RoleAvatar } from './shared/RoleAvatar'

/**
 * 历史记录浮层 —— 浏览器顶栏专用。把 Sidebar 的"搜索 + 分组对话列表 + 删除"
 * 收进一个下拉，复用 useConversationGroups（与 Sidebar 同一份分组逻辑）。
 */
export function HistoryPopover() {
  const { t, i18n } = useTranslation()
  const activeConversationId = useChatStore(s => s.activeConversationId)
  const switchConversation = useChatStore(s => s.switchConversation)
  const deleteConversation = useChatStore(s => s.deleteConversation)
  const streamingConvIds = useChatStore(s => s.streamingConvIds)
  const isThinking = useChatStore(s => s.isThinking)
  const activeView = useAppStore(s => s.activeView)
  const setActiveView = useAppStore(s => s.setActiveView)
  const workspaces = useAgentStore(s => s.workspaces)

  const [open, setOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [debouncedQuery, setDebouncedQuery] = useState('')
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)
  const debounceRef = useRef<ReturnType<typeof setTimeout>>()
  const rootRef = useRef<HTMLDivElement>(null)

  const { groups, external: acpConversations } = useConversationGroups(debouncedQuery)
  const workspaceMap = new Map(workspaces.map(w => [w.id, { icon: w.icon, name: w.name }]))

  // ACP 外部会话默认折叠；搜索时自动展开（有匹配却藏着会让人以为搜不到），
  // 清空搜索后回到用户手动设定的状态而不是无条件收起
  const [acpOpen, setAcpOpen] = useState(false)
  const manualAcpOpen = useRef(false)
  useEffect(() => { setAcpOpen(debouncedQuery ? true : manualAcpOpen.current) }, [debouncedQuery])
  const toggleAcp = useCallback(() => {
    setAcpOpen(v => { manualAcpOpen.current = !v; return !v })
  }, [])

  const handleSearch = useCallback((value: string) => {
    setSearchQuery(value)
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => setDebouncedQuery(value), 300)
  }, [])
  useEffect(() => () => { if (debounceRef.current) clearTimeout(debounceRef.current) }, [])

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false)
    }
    window.addEventListener('mousedown', onDown)
    return () => window.removeEventListener('mousedown', onDown)
  }, [open])

  const pick = useCallback((id: string) => {
    setActiveView('chat')
    switchConversation(id)
    setOpen(false)
  }, [setActiveView, switchConversation])

  const statusForConversation = (id: string) => {
    if (!streamingConvIds[id]) return 'idle' as const
    return id === activeConversationId && isThinking ? 'thinking' as const : 'generating' as const
  }

  const formatConversationTime = (timestamp: number): string => {
    const descriptor = getConversationTimeDescriptor(timestamp)
    if (descriptor.kind === 'relative') {
      return 'count' in descriptor
        ? t(descriptor.key, { count: descriptor.count })
        : t(descriptor.key)
    }
    return new Intl.DateTimeFormat(i18n.resolvedLanguage === 'en' ? 'en' : 'zh-CN', {
      month: 'short',
      day: 'numeric',
    }).format(new Date(descriptor.timestamp))
  }

  const formatGroupLabel = (label: string): string => {
    const key = getConversationGroupKey(label)
    return key ? t(key) : label
  }

  const renderConvRow = (conv: ConversationSummary) => (
    <button
      key={conv.id}
      onClick={() => pick(conv.id)}
      className={`group w-full text-left px-2.5 py-2 rounded-md mb-0.5 transition-colors ${
        conv.id === activeConversationId && activeView === 'chat'
          ? 'bg-sidebar-active dark:bg-surface-50 text-surface-700'
          : 'text-surface-500 hover:bg-sidebar-hover dark:hover:bg-surface-50'
      }`}
    >
      <div className="flex items-center gap-2">
        <span className="shrink-0 flex items-center">
          {conv.workspaceId
            ? <span className="text-xs">{workspaceMap.get(conv.workspaceId)?.icon || '🤖'}</span>
            : <RoleAvatar
                role={{ name: conv.role }}
                status={statusForConversation(conv.id)}
                animated={conv.id === activeConversationId}
                size={18}
              />}
        </span>
        <span className="text-[12px] truncate flex-1">{getConversationDisplayTitle(conv, t)}</span>
        <div className="opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
          {confirmDeleteId === conv.id ? (
            <span onClick={(e) => { e.stopPropagation(); deleteConversation(conv.id); setConfirmDeleteId(null) }}
              className="text-[10px] text-red-500 px-1 cursor-pointer">{t('shell.history.confirmDelete')}</span>
          ) : (
            <Trash2 className="w-3 h-3 text-surface-300 hover:text-red-400 cursor-pointer"
              aria-label={t('shell.history.deleteConversation')}
              onClick={(e) => { e.stopPropagation(); setConfirmDeleteId(conv.id); setTimeout(() => setConfirmDeleteId(null), 3000) }} />
          )}
        </div>
      </div>
      <div className="flex items-center gap-2 mt-0.5 pl-5">
        <span className="text-[10px] text-surface-300">{t('shell.history.messageCount', { count: conv.messageCount })}</span>
        <span className="text-[10px] text-surface-300">{formatConversationTime(conv.updatedAt)}</span>
      </div>
    </button>
  )

  return (
    <div ref={rootRef} className="relative" style={{ WebkitAppRegion: 'no-drag' } as any}>
      <button
        onClick={() => setOpen(v => !v)}
        title={t('shell.history.title')}
        className="flex items-center gap-1.5 px-2 py-1.5 rounded-md text-[13px] text-surface-500 hover:bg-sidebar-hover dark:hover:bg-surface-50 transition-colors"
      >
        <Clock className="w-4 h-4" />
        <span className="hidden sm:inline">{t('shell.history.shortTitle')}</span>
      </button>

      {open && (
        <div className="op-menu absolute right-0 top-full mt-1 w-72 max-h-[70vh] flex flex-col z-50">
          {/* 搜索 */}
          <div className="p-2 border-b border-surface-100">
            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3 h-3 text-surface-300" />
              <input
                type="text" value={searchQuery} onChange={e => handleSearch(e.target.value)}
                placeholder={t('shell.history.searchPlaceholder')} autoFocus
                className="w-full pl-7 pr-3 py-1.5 text-[12px] rounded-md bg-surface-50 border border-surface-100 text-surface-600 placeholder:text-surface-300 focus:outline-none focus:border-brand-300 focus:ring-1 focus:ring-brand-100 transition-colors"
              />
              {searchQuery && (
                <button
                  onClick={() => { setSearchQuery(''); setDebouncedQuery('') }}
                  aria-label={t('shell.history.clearSearch')}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-surface-300 hover:text-surface-500"
                >
                  <X className="w-3 h-3" />
                </button>
              )}
            </div>
          </div>

          {/* 列表 */}
          <div className="flex-1 overflow-y-auto p-1.5">
            {groups.length === 0 && acpConversations.length === 0 ? (
              <div className="text-center py-8">
                <p className="text-[11px] text-surface-300">
                  {t(debouncedQuery ? 'shell.history.noMatches' : 'shell.history.noConversations')}
                </p>
              </div>
            ) : (
              <>
                {groups.map(({ label, items }) => (
                  <div key={label} className="mb-1">
                    <div className="px-2 pt-2 pb-1">
                      <span className="text-[10px] font-semibold text-surface-300 uppercase tracking-wider">{formatGroupLabel(label)}</span>
                    </div>
                    {items.map(renderConvRow)}
                  </div>
                ))}
                {acpConversations.length > 0 && (
                  <div className="mb-1">
                    <button
                      onClick={toggleAcp}
                      className="w-full flex items-center gap-1 px-2 pt-2 pb-1 text-surface-300 hover:text-surface-500 transition-colors"
                    >
                      <ChevronRight className={`w-3 h-3 transition-transform ${acpOpen ? 'rotate-90' : ''}`} />
                      <span className="text-[10px] font-semibold uppercase tracking-wider">
                        {t('shell.history.acpSessions', { count: acpConversations.length })}
                      </span>
                    </button>
                    {acpOpen && acpConversations.map(renderConvRow)}
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

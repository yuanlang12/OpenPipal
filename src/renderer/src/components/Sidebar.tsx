import { useState, useMemo, useCallback, useRef, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { Plus, Search, X, Trash2, Puzzle, Clock, Settings, ChevronRight, Bot, FolderOutput } from 'lucide-react'
import { useChatStore, ConversationSummary } from '../stores/chatStore'
import { useAgentStore } from '../stores/agentStore'
import { useAppStore, ActiveView } from '../stores/appStore'
import { useConversationGroups } from '../hooks/useConversationGroups'
import { getConversationDisplayTitle } from '../utils/conversationDisplayTitle'
import {
  getConversationGroupKey,
  getConversationTimeDescriptor,
} from '../../../shared/i18n/resources'
import { ConvStatusDot } from './shared/ConvStatusDot'
import { RoleAvatar } from './shared/RoleAvatar'
import { OpenPipalLogo } from './shared/OpenPipalLogo'

interface SidebarProps { collapsed: boolean }

export function Sidebar({ collapsed }: SidebarProps) {
  const { t, i18n } = useTranslation()
  const { activeView, setActiveView } = useAppStore()
  const {
    activeConversationId,
    newConversation,
    switchConversation,
    deleteConversation,
    streamingConvIds,
    isThinking,
  } = useChatStore()
  const workspaces = useAgentStore(s => s.workspaces)
  const loadWorkspaces = useAgentStore(s => s.loadWorkspaces)
  const workspaceMap = useMemo(() => {
    const m = new Map<string, { icon: string; name: string }>()
    for (const w of workspaces) m.set(w.id, { icon: w.icon, name: w.name })
    return m
  }, [workspaces])
  // 确保侧边栏打开时就加载 workspaces（AgentsPanel 可能还没打开过）
  useEffect(() => { loadWorkspaces() }, [])

  const navTo = (view: ActiveView) => setActiveView(view)

  const [searchQuery, setSearchQuery] = useState('')
  const [debouncedQuery, setDebouncedQuery] = useState('')
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)
  const debounceRef = useRef<ReturnType<typeof setTimeout>>()

  const handleSearch = useCallback((value: string) => {
    setSearchQuery(value)
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => setDebouncedQuery(value), 300)
  }, [])

  useEffect(() => () => { if (debounceRef.current) clearTimeout(debounceRef.current) }, [])

  const handleNew = useCallback(async () => {
    // 所见即所得：新建对话与 WelcomePage 复位后的通用头像页一致，固定 general——
    // 继承全局 currentRole 曾导致默认会话串成 design 人格（欢迎页可切换角色）
    await newConversation('general')
    navTo('chat')
  }, [newConversation])

  const { groups: groupedConversations, external: acpConversations } = useConversationGroups(debouncedQuery)

  // ACP 外部会话默认折叠；搜索时自动展开（有匹配却藏着会让人以为搜不到），
  // 清空搜索后回到用户手动设定的状态而不是无条件收起
  const [acpOpen, setAcpOpen] = useState(false)
  const manualAcpOpen = useRef(false)
  useEffect(() => { setAcpOpen(debouncedQuery ? true : manualAcpOpen.current) }, [debouncedQuery])
  const toggleAcp = useCallback(() => {
    setAcpOpen(v => { manualAcpOpen.current = !v; return !v })
  }, [])

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
      onClick={() => { navTo('chat'); switchConversation(conv.id) }}
      className={`group w-full text-left px-2.5 py-2 rounded-md mb-0.5 transition-colors ${
        conv.id === activeConversationId && activeView === 'chat'
          ? 'bg-sidebar-active text-surface-700'
          : 'text-surface-500 hover:bg-sidebar-hover'
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
        <span className="text-sw-base truncate flex-1">{getConversationDisplayTitle(conv, t)}</span>
        <ConvStatusDot id={conv.id} />
        <div className="opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
          {confirmDeleteId === conv.id ? (
            <span onClick={(e) => { e.stopPropagation(); deleteConversation(conv.id); setConfirmDeleteId(null) }}
              className="text-sw-xs text-red-500 px-1 cursor-pointer">{t('shell.history.confirmDelete')}</span>
          ) : (
            <Trash2 className="w-3 h-3 text-surface-300 hover:text-red-400 cursor-pointer"
              aria-label={t('shell.history.deleteConversation')}
              onClick={(e) => { e.stopPropagation(); setConfirmDeleteId(conv.id); setTimeout(() => setConfirmDeleteId(null), 3000) }} />
          )}
        </div>
      </div>
      <div className="flex items-center gap-2 mt-0.5 pl-5">
        <span className="text-sw-xs text-surface-300">{t('shell.history.messageCount', { count: conv.messageCount })}</span>
        <span className="text-sw-xs text-surface-300">{formatConversationTime(conv.updatedAt)}</span>
      </div>
    </button>
  )

  const navItemClass = (view: ActiveView) =>
    `w-full flex items-center gap-3 px-3 py-2 rounded-md text-sw-base font-medium transition-colors ${
      activeView === view
        ? 'text-brand-600 dark:text-brand-400 bg-brand-50 dark:bg-brand-900/30'
        : 'text-surface-500 hover:text-surface-700 hover:bg-sidebar-hover'
    }`

  if (collapsed) {
    const iconBtn = (view: ActiveView) =>
      `p-2.5 rounded-md transition-colors ${
        activeView === view
          ? 'text-brand-600 dark:text-brand-400 bg-brand-50 dark:bg-brand-900/30'
          : 'text-surface-400 hover:text-surface-600 hover:bg-sidebar-hover'
      }`
    return (
      <div data-testid="sidebar" className="op-sidebar w-12 flex flex-col items-center py-3 gap-1 border-r border-sidebar-border shrink-0">
        <OpenPipalLogo variant="mark" size={22} className="mb-1" />
        <button
          onClick={handleNew}
          title={t('shell.navigation.newConversation')}
          className="p-2.5 rounded-md bg-brand-500 text-ink-on-accent shadow-sm transition-transform active:scale-95"
        >
          <Plus className="w-4 h-4" />
        </button>
        {/* 收起态的导航跟着「新建」走,和展开态顺序一致;弹性留白放在导航之后,
            只把「设置」压到底部。原来 flex-1 在导航之前,收起后整组图标掉到最下面,
            和展开态对不上。 */}
        <button onClick={() => navTo('agents')} className={iconBtn('agents')} title={t('shell.navigation.myAgents')}><Bot className="w-4 h-4" /></button>
        <button onClick={() => navTo('tools')} className={iconBtn('tools')} title={t('shell.navigation.plugins')}><Puzzle className="w-4 h-4" /></button>
        <button onClick={() => navTo('tasks')} className={iconBtn('tasks')} title={t('shell.navigation.tasks')}><Clock className="w-4 h-4" /></button>
        <button onClick={() => navTo('artifacts')} className={iconBtn('artifacts')} title={t('shell.navigation.artifacts')}><FolderOutput className="w-4 h-4" /></button>
        <div className="flex-1" />
        <div className="my-1.5 w-5 h-px bg-sidebar-border" />
        <button onClick={() => navTo('settings')} className={iconBtn('settings')} title={t('shell.navigation.settings')}><Settings className="w-4 h-4" /></button>
      </div>
    )
  }

  return (
    <div data-testid="sidebar" className="op-sidebar w-60 flex flex-col border-r border-sidebar-border shrink-0">
      {/* Logo */}
      <div className="flex items-center justify-between px-4 pt-4 pb-3">
        <OpenPipalLogo size={24} />
      </div>

      {/* 新建 */}
      <div className="px-3 pb-3">
        <button onClick={handleNew} className="w-full py-2 px-4 rounded-md bg-brand-500 text-ink-on-accent font-medium text-sw-base flex items-center justify-center gap-2 transition-all active:scale-[0.98] shadow-sm hover:bg-brand-600">
          <Plus className="w-4 h-4" />
          {t('shell.navigation.newConversation')}
        </button>
      </div>

      {/* 导航 */}
      <nav className="px-2 space-y-0.5 pb-2">
        <button onClick={() => navTo('agents')} className={navItemClass('agents')}>
          <Bot className="w-4 h-4" /> {t('shell.navigation.myAgents')}
        </button>
        <button onClick={() => navTo('tools')} className={navItemClass('tools')}>
          <Puzzle className="w-4 h-4" /> {t('shell.navigation.plugins')}
        </button>
        <button onClick={() => navTo('tasks')} className={navItemClass('tasks')}>
          <Clock className="w-4 h-4" /> {t('shell.navigation.tasks')}
        </button>
        <button onClick={() => navTo('artifacts')} className={navItemClass('artifacts')}>
          <FolderOutput className="w-4 h-4" /> {t('shell.navigation.artifacts')}
        </button>
      </nav>

      {/* 历史 */}
      <div className="px-4 pt-2 pb-1.5">
        <p className="text-sw-xs font-semibold text-surface-300 uppercase tracking-wider">{t('shell.history.title')}</p>
      </div>

      <div className="px-3 pb-2">
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3 h-3 text-surface-300" />
          <input
            type="text" value={searchQuery} onChange={e => handleSearch(e.target.value)}
            placeholder={t('shell.history.searchPlaceholder')}
            className="w-full pl-7 pr-3 py-1.5 text-sw-sm rounded-md bg-surface-0 border border-surface-100 text-surface-600 placeholder:text-surface-300 focus:outline-none focus:border-brand-300 focus:ring-1 focus:ring-brand-100 transition-colors"
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

      <div className="flex-1 overflow-y-auto px-2">
        {groupedConversations.length === 0 && acpConversations.length === 0 ? (
          <div className="text-center py-8">
            <p className="text-sw-sm text-surface-300">
              {t(debouncedQuery ? 'shell.history.noMatches' : 'shell.history.noConversations')}
            </p>
          </div>
        ) : (
          <>
            {groupedConversations.map(({ label, items }) => (
              <div key={label} className="mb-1">
                <div className="px-2 pt-2.5 pb-1">
                  <span className="text-sw-xs font-semibold text-surface-300 uppercase tracking-wider">{formatGroupLabel(label)}</span>
                </div>
                {items.map(renderConvRow)}
              </div>
            ))}
            {acpConversations.length > 0 && (
              <div className="mb-1">
                <button
                  onClick={toggleAcp}
                  className="w-full flex items-center gap-1 px-2 pt-2.5 pb-1 text-surface-300 hover:text-surface-500 transition-colors"
                >
                  <ChevronRight className={`w-3 h-3 transition-transform ${acpOpen ? 'rotate-90' : ''}`} />
                  <span className="text-sw-xs font-semibold uppercase tracking-wider">
                    {t('shell.history.acpSessions', { count: acpConversations.length })}
                  </span>
                </button>
                {acpOpen && acpConversations.map(renderConvRow)}
              </div>
            )}
          </>
        )}
      </div>

      {/* 设置 */}
      <div className="p-2 mt-auto border-t border-sidebar-border">
        <button onClick={() => navTo('settings')} className={navItemClass('settings')}>
          <Settings className="w-4 h-4" /> {t('shell.navigation.settings')}
        </button>
      </div>
    </div>
  )
}

import { useState, useMemo, useCallback, useRef, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { Plus, Search, X, Trash2, Puzzle, Clock, Settings, ChevronRight, Bot, FolderOutput } from 'lucide-react'
import { useChatStore, ConversationSummary } from '../stores/chatStore'
import { useAgentStore, type TeamSummary } from '../stores/agentStore'
import { useAppStore, ActiveView } from '../stores/appStore'
import { useConversationGroups, type TeamThreadGroup } from '../hooks/useConversationGroups'
import { getConversationDisplayTitle } from '../utils/conversationDisplayTitle'
import { getConversationTimeDescriptor } from '../../../shared/i18n/resources'
import { ConvGroupStatusDot, ConvStatusDot } from './shared/ConvStatusDot'
import { ConversationAvatar } from './shared/ConversationAvatar'
import { OpenPipalLogo } from './shared/OpenPipalLogo'
import { TeamAvatar, WorkspaceAvatar } from './agent-mark'

/** 左栏「团队」分组里的一行：有话题的团队带 threads；只建了还没话题的团队也列出来（＋ 得有地方点） */
interface TeamRow {
  id: string
  team?: TeamSummary
  threads?: TeamThreadGroup
}

interface SidebarProps { collapsed: boolean }

export function Sidebar({ collapsed }: SidebarProps) {
  const { t, i18n } = useTranslation()
  const { activeView, setActiveView } = useAppStore()
  const {
    activeConversationId,
    newConversation,
    newConversationInTeam,
    switchConversation,
    deleteConversation,
    streamingConvIds,
    isThinking,
  } = useChatStore()
  const workspaces = useAgentStore(s => s.workspaces)
  const loadWorkspaces = useAgentStore(s => s.loadWorkspaces)
  const teams = useAgentStore(s => s.teams)
  const loadTeams = useAgentStore(s => s.loadTeams)
  const teamMap = useMemo(() => new Map(teams.map(team => [team.id, team])), [teams])
  // 团队行的展开状态：没手动点过的，含当前会话的那个团队自动展开，其余收起；搜索时全部展开
  const [teamOpen, setTeamOpen] = useState<Record<string, boolean>>({})
  // 「团队」分组常在（所有者定的）：还没团队时是一行空态，分组标题旁的 ＋ 直接组建——
  // 不弹窗：主进程造好默认组长，这里开一条跟组长的话题，名字、章程、成员都在话题里聊出来
  const foundTeam = useAgentStore(s => s.foundTeam)
  const [founding, setFounding] = useState(false)
  const workspaceMap = useMemo(() => {
    const m = new Map<string, { icon: string; name: string }>()
    for (const w of workspaces) m.set(w.id, { icon: w.icon, name: w.name })
    return m
  }, [workspaces])
  // 确保侧边栏打开时就加载 workspaces 与团队（AgentsPanel 可能还没打开过）
  useEffect(() => { loadWorkspaces(); loadTeams() }, [])

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

  const { teams: teamThreads, groups: groupedConversations, external: acpConversations } = useConversationGroups(debouncedQuery)
  // 团队分组：有话题的按最近活动在前；还没话题的团队排后面（搜索时只列命中的话题所在团队）
  const teamRows = useMemo<TeamRow[]>(() => {
    const rows: TeamRow[] = teamThreads.map(g => ({ id: g.teamId, team: teamMap.get(g.teamId), threads: g }))
    if (!debouncedQuery) {
      for (const team of teams) if (!rows.some(r => r.id === team.id)) rows.push({ id: team.id, team })
    }
    return rows
  }, [teamThreads, teams, teamMap, debouncedQuery])

  const openThread = useCallback(async (teamId: string, channel?: string) => {
    await newConversationInTeam(teamId, channel)
    navTo('chat')
  }, [newConversationInTeam])

  const startFounding = useCallback(async () => {
    if (founding) return
    setFounding(true)
    try {
      const team = await foundTeam()
      await newConversationInTeam(team.id, undefined, t('shell.history.foundingTitle'))
      navTo('chat')
    } finally {
      setFounding(false)
    }
  }, [founding, foundTeam, newConversationInTeam, t])

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

  // 三级层次（所有者 2026-09-16 按参考图重定：分组标题是「标签」，条目是「内容」，两者不能长得像）：
  //   分组标题与上面的导航项（我的 Pal / 自动化 / 作品）同一级：sw-base / 中等字重 / 400（浅一档，衬出下面深色的条目），上方留大空 →
  //   子分组（频道）11px / 300 紧贴条目 → 条目 sw-sm / 700 常规字重。三层各差一档字号，任何两层放一起都分得出谁是谁。
  //   单对话不再按日期分小组（所有者 2026-09-16 去掉的）：按最近更新排一列，时间悬停才出。
  // 条目只留一行标题；时间悬停才出，"N 条消息"不再占一行（不影响决定）。
  // 团队下的话题不画头像：它永远由这个团队的组长跑，头像只会重复团队行那一个；单对话的头像是"哪个 Pal"，得留
  // 悬停才出的时间 / 删除 / 开话题：以前透明地占着行尾的宽度，标题明明有地方也被省略（所有者 2026-09-16）。
  // 现在绝对定位盖在行尾、垫一层行底色、左侧一小段渐变收边——标题铺满整行，悬停时控件从底色里浮出来盖住标题尾巴。
  const renderConvRow = (conv: ConversationSummary, opts: { inTeam?: boolean } = {}) => {
    const active = conv.id === activeConversationId && activeView === 'chat'
    return (
    <button
      key={conv.id}
      onClick={() => { navTo('chat'); switchConversation(conv.id) }}
      className={`group relative w-full text-left px-3 py-2 rounded-md mb-0.5 transition-colors ${
        active ? 'bg-sidebar-active text-surface-800' : 'text-surface-700 hover:bg-sidebar-hover'
      }`}
    >
      <div className="flex items-center gap-2">
        {!opts.inTeam && (
          <span className="shrink-0 flex items-center">
            <ConversationAvatar
              workspaceId={conv.workspaceId}
              role={conv.role}
              status={statusForConversation(conv.id)}
              animated={conv.id === activeConversationId}
              size={16}
              className="text-[12px]"
            />
          </span>
        )}
        <span className="text-sw-base truncate flex-1" data-testid="conv-title">{getConversationDisplayTitle(conv, t)}</span>
        <ConvStatusDot id={conv.id} />
      </div>
      <div className="absolute inset-y-0 right-0 flex items-stretch rounded-r-md opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
        <span className={`w-5 bg-gradient-to-r from-transparent ${active ? 'to-sidebar-active' : 'to-sidebar-hover'}`} />
        <span className={`flex items-center gap-1.5 pr-2 ${active ? 'bg-sidebar-active' : 'bg-sidebar-hover'}`}>
          <span className="text-sw-xs text-surface-300 shrink-0">{formatConversationTime(conv.updatedAt)}</span>
          {confirmDeleteId === conv.id ? (
            <span onClick={(e) => { e.stopPropagation(); deleteConversation(conv.id); setConfirmDeleteId(null) }}
              className="text-sw-xs text-red-500 px-1 cursor-pointer">{t('shell.history.confirmDelete')}</span>
          ) : (
            <Trash2 className="w-3 h-3 text-surface-300 hover:text-red-400 cursor-pointer"
              aria-label={t('shell.history.deleteConversation')}
              onClick={(e) => { e.stopPropagation(); setConfirmDeleteId(conv.id); setTimeout(() => setConfirmDeleteId(null), 3000) }} />
          )}
        </span>
      </div>
    </button>
    )
  }

  const renderChannelHeader = (teamId: string, teamName: string, channel: string, count: number) => (
    <div key={`chan:${channel}`} className="group/chan flex items-center gap-1 pr-1" data-testid="sidebar-channel" data-channel={channel}>
      <span className="flex-1 min-w-0 flex items-center gap-1.5 px-3 pt-2.5 pb-1 text-sw-sm text-surface-300">
        <span className="truncate">{channel}</span>
        {count > 0 && <span>{count}</span>}
      </span>
      <button
        onClick={() => { void openThread(teamId, channel) }}
        title={t('shell.history.newThreadIn', { name: `${teamName} › ${channel}` })}
        aria-label={t('shell.history.newThreadIn', { name: `${teamName} › ${channel}` })}
        data-testid="channel-new-thread"
        className="p-1 rounded text-surface-300 hover:text-surface-600 hover:bg-surface-100 opacity-0 group-hover/chan:opacity-100 focus:opacity-100 transition-opacity"
      >
        <Plus className="w-3 h-3" />
      </button>
    </div>
  )

  const renderTeam = ({ id, team, threads }: TeamRow) => {
    const lanes = threads?.channels ?? []
    const threadIds = lanes.flatMap(l => l.items.map(c => c.id))
    const containsActive = threadIds.includes(activeConversationId || '')
    const open = !!debouncedQuery || (teamOpen[id] ?? containsActive)
    const name = team?.name ?? t('shell.history.deletedTeam')
    const laneNames = new Set(lanes.map(l => l.channel))
    const emptyChannels = (team?.channels ?? []).filter(c => !laneNames.has(c))
    const teamActive = containsActive && activeView === 'chat' && !open
    return (
      <div key={id} className="mb-1" data-testid="sidebar-team" data-team-id={id} data-open={open ? 'true' : 'false'}>
        {/* --sw-mark-halo 跟着这一行的底色走：叠放的成员头像用它抠缝，悬停 / 选中时底色变了缝也跟着变 */}
        <div className={`group/team relative flex items-center rounded-md transition-colors hover:bg-sidebar-hover hover:[--sw-mark-halo:var(--sw-list-hover)] ${
          teamActive ? 'bg-sidebar-active [--sw-mark-halo:var(--sw-list-active)]' : '[--sw-mark-halo:var(--sw-bg-sidebar)]'}`}>
          <button
            onClick={() => setTeamOpen(s => ({ ...s, [id]: !open }))}
            aria-expanded={open}
            aria-label={t(open ? 'shell.history.collapseTeam' : 'shell.history.expandTeam')}
            data-testid="team-toggle"
            className="w-full min-w-0 flex items-center gap-2 px-3 py-2 text-left text-surface-700"
          >
            {/* 整行就是开关，不画展开箭头（所有者 2026-09-16）。团队行画成员（≥2 人才画）：像人排排站——最多三个，后一个叠在前一个身后露出六成，Lead 站最前面；
                每个头像和对话行的头像同一个 16px（所有者 2026-09-16：团队和对话的头像不能两个尺寸）。
                超过三人不加"更多"遮罩也不写 +N（遮罩既看不清数也看不清人）；人数在团队面板里看。
                单人团队（刚组建）画团队自己的 mark */}
            {team && team.members.length >= 2 ? (
              <span className="shrink-0 flex items-center" data-testid="team-member-stack">
                {[team.lead, ...team.members.filter(m => m !== team.lead)].slice(0, 3).map((memberId, index, shown) => (
                  <span key={memberId} className={`relative inline-flex ${index > 0 ? '-ml-1.5' : ''}`} style={{ zIndex: shown.length - index }} data-member-id={memberId}>
                    <WorkspaceAvatar workspaceId={memberId} size={16} halo className="text-[12px] leading-none" />
                  </span>
                ))}
              </span>
            ) : (
              <TeamAvatar teamId={id} size={16} className="shrink-0" />
            )}
            <span className="text-sw-base truncate flex-1" data-testid="team-name">{name}</span>
            {/* 状态只在一处亮（所有者 2026-09-18）：展开时看各条话题行，团队行不重复转；收起时几条在跑也只在团队行转一个 */}
            {!open && <ConvGroupStatusDot ids={threadIds} />}
          </button>
          {team && team.channels.length === 0 && (
            <div className="absolute inset-y-0 right-0 flex items-stretch rounded-r-md opacity-0 group-hover/team:opacity-100 focus-within:opacity-100 transition-opacity">
              <span className={`w-5 bg-gradient-to-r from-transparent ${teamActive ? 'to-sidebar-active' : 'to-sidebar-hover'}`} />
              {/* 悬停条盖住了行尾的状态点，就在条里把它再画一遍：＋ 站到状态点左边，位置不打架 */}
              <span className={`flex items-center gap-1.5 pr-3 ${teamActive ? 'bg-sidebar-active' : 'bg-sidebar-hover'}`}>
                <button
                  onClick={() => { void openThread(id) }}
                  title={t('shell.history.newThreadIn', { name })}
                  aria-label={t('shell.history.newThreadIn', { name })}
                  data-testid="team-new-thread"
                  className="p-1 rounded text-surface-300 hover:text-surface-600 hover:bg-surface-100"
                >
                  <Plus className="w-3.5 h-3.5" />
                </button>
                {!open && <ConvGroupStatusDot ids={threadIds} />}
              </span>
            </div>
          )}
        </div>
        {open && (
          <div className="pl-5" data-testid="team-threads">
            {lanes.map(lane => (
              <div key={lane.channel ?? '__root'}>
                {lane.channel && renderChannelHeader(id, name, lane.channel, lane.items.length)}
                {lane.items.map(conv => renderConvRow(conv, { inTeam: true }))}
              </div>
            ))}
            {emptyChannels.map(channel => renderChannelHeader(id, name, channel, 0))}
            {lanes.length === 0 && emptyChannels.length === 0 && (
              <p className="px-3 py-2 text-sw-sm text-surface-300">{t('shell.history.noThreads')}</p>
            )}
          </div>
        )}
      </div>
    )
  }

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
        <p className="text-sw-xs text-surface-300">{t('shell.history.title')}</p>
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

      {/* 左边线统一：导航项、分组标题、团队行、对话行都是 px-2 + px-3 = 20px 起（所有者 2026-09-16：以前行是 px-2.5，比标题偏左 2px） */}
      <div className="flex-1 overflow-y-auto px-2">
        {/* 团队分组常在：标题旁的 ＋ 建团队；一组一组可折叠，有频道再分一层。搜索时没命中的团队不列 */}
        {(!debouncedQuery || teamRows.length > 0) && (
          <div className="mb-1" data-testid="sidebar-teams">
            <div className="group/teams flex items-center gap-1 px-3 pt-2.5 pb-1.5">
              <span className="flex-1 text-sw-base font-medium text-surface-400">{t('shell.history.teams')}</span>
              <button
                onClick={() => { void startFounding() }}
                disabled={founding}
                title={t('shell.history.createTeam')}
                aria-label={t('shell.history.createTeam')}
                data-testid="sidebar-create-team"
                className="p-0.5 rounded text-surface-300 hover:text-surface-600 hover:bg-surface-100 transition-colors disabled:opacity-50"
              >
                <Plus className="w-3.5 h-3.5" />
              </button>
            </div>
            {teamRows.length === 0 ? (
              <p className="px-3 py-1 text-sw-sm text-surface-300" data-testid="sidebar-teams-empty">{t('shell.history.noTeams')}</p>
            ) : teamRows.map(renderTeam)}
          </div>
        )}
        {groupedConversations.length === 0 && acpConversations.length === 0 ? (
          <div className="text-center py-8">
            <p className="text-sw-sm text-surface-300">
              {t(debouncedQuery ? 'shell.history.noMatches' : 'shell.history.noConversations')}
            </p>
          </div>
        ) : (
          <>
            {/* 单对话在团队下面按最近更新排一列，不分日期小组 */}
            {groupedConversations.length > 0 && (
              <div className="px-3 pt-5 pb-1" data-testid="sidebar-conversations-header">
                <span className="text-sw-base font-medium text-surface-400">{t('shell.history.conversations')}</span>
              </div>
            )}
            {groupedConversations.flatMap(g => g.items).map(conv => renderConvRow(conv))}
            {acpConversations.length > 0 && (
              <div className="mb-1">
                <button
                  onClick={toggleAcp}
                  className="w-full flex items-center gap-1 px-2 pt-2.5 pb-1 text-surface-300 hover:text-surface-500 transition-colors"
                >
                  <ChevronRight className={`w-3 h-3 transition-transform ${acpOpen ? 'rotate-90' : ''}`} />
                  <span className="text-sw-xs font-medium tracking-wider">
                    {t('shell.history.acpSessions', { count: acpConversations.length })}
                  </span>
                </button>
                {acpOpen && acpConversations.map(conv => renderConvRow(conv))}
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

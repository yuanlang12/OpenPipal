import { useEffect, useMemo, useState } from 'react'
import { Plus, Trash2, Copy, Search, Users } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import { useAgentStore, type TeamSummary, type WorkspaceSummary } from '../stores/agentStore'
import { useChatStore } from '../stores/chatStore'
import { useAppStore } from '../stores/appStore'
import { useAgentMarkStudio, MarkStudioAffordance, TeamAvatar, WorkspaceAvatar } from './agent-mark'
import { AgentAvatar } from './shared/AgentAvatar'
import { resolveRoleMark } from './shared/RoleAvatar'
import { DEFAULT_AGENT_ID } from '../../../shared/agent-identity'
import { builtinDisplayName } from '../../../shared/i18n/resources'
import { startConversationWith } from '../utils/startConversationWith'
import type { AgentSummary } from '../types'

/** 「创建」去的是通用助手：在那里聊完点"保存为 Pal"就是新建的路 */
const CREATE_ROLE = DEFAULT_AGENT_ID

/** 一行的检索面：名字 + 介绍（内置的介绍是 tagline） */
interface Searchable { name: string; description?: string }

/**
 * 我的 Pals —— 一份列表按分类分组（顶部只有一个搜索框 + 分组标题），每行：头像 · 名字 · 一句描述 · 悬停出「试一下」。
 * 只有两种：内置和 Pal（模板已并入 Pal，改人设去 Pal 面板里的 agent.md）。
 * 「OpenPipal 官方」是来源分组（出厂自带的几个，和 Pal 是同一种东西，只是不能改、不能删）。行上不打任何标签——名字本身够清楚；
 * 我的 Pal 按 meta.json 的 category 分组，没分类的落在最后。搜索框对名字和介绍做包含匹配。
 */
export function AgentsPanel() {
  const { t: translate } = useTranslation()
  const { workspaces, teams, loading, loadWorkspaces, loadTeams, deleteWorkspace, deleteTeam, foundTeam } = useAgentStore()
  const { setActiveView } = useAppStore()
  const agents = useAppStore(s => s.agents)
  const loadAgents = useAppStore(s => s.loadAgents)
  const { openMarkStudio, markStudio } = useAgentMarkStudio()

  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)
  const [query, setQuery] = useState('')

  useEffect(() => { loadWorkspaces(); loadTeams(); void loadAgents() }, [])
  const builtins = useMemo(() => agents.filter(a => a.kind === 'builtin'), [agents])
  const builtinName = (agent: AgentSummary): string => builtinDisplayName(translate, agent.id, agent.name)
  const builtinTagline = (agent: AgentSummary): string | undefined => {
    const text = translate(`roles.${agent.id}.tagline`, { defaultValue: '' })
    return text || undefined
  }
  /** 分类的显示名：内置键有译文，用户自己的词原样显示 */
  const categoryLabel = (value: string): string => translate(`agents.category.${value}`, { defaultValue: value })

  // 分组顺序：内置的分类按内置顺序在前，我的 Pal 里才有的分类按出现顺序在后
  const categories = useMemo(() => {
    const seen: string[] = []
    for (const value of [...builtins.map(a => a.category), ...workspaces.map(w => w.category)]) {
      if (value && !seen.includes(value)) seen.push(value)
    }
    return seen
  }, [builtins, workspaces])
  const q = query.trim().toLowerCase()
  const matches = (row: Searchable): boolean =>
    !q || row.name.toLowerCase().includes(q) || (row.description || '').toLowerCase().includes(q)

  // 内置的不能改、不能删；想在它基础上改就复制一份成自己的 Pal（人设 + 它声明的行为 + 点名它的专属技能）
  const handleCopyBuiltin = async (agent: AgentSummary) => {
    const created = await window.api.copyBuiltinAsPal?.(agent.id)
    if (created) { await loadWorkspaces(); await loadAgents() }
  }

  const handleCreate = async () => {
    const { newConversation } = useChatStore.getState()
    await newConversation(CREATE_ROLE)
    setActiveView('chat')
  }
  const armDelete = (id: string): void => {
    setConfirmDeleteId(id)
    setTimeout(() => setConfirmDeleteId(current => (current === id ? null : current)), 3000)
  }

  const hasMine = workspaces.length > 0

  // 团队：成员名连成一句介绍（Lead 标出来），第二行是成员数与频道数
  const workspaceName = (id: string): string => workspaces.find(w => w.id === id)?.name ?? id.slice(0, 8)
  const teamMembersLine = (team: TeamSummary): string =>
    team.members.map(id => (id === team.lead ? `${workspaceName(id)}（${translate('agents.team.leadTag')}）` : workspaceName(id))).join('、')
  const openThread = async (team: TeamSummary): Promise<void> => {
    await useChatStore.getState().newConversationInTeam(team.id)
    setActiveView('chat')
  }
  // 组建团队不弹窗：造好默认组长就开一条跟它的话题，名字、章程、成员在话题里聊出来
  const startFounding = async (): Promise<void> => {
    const team = await foundTeam()
    await useChatStore.getState().newConversationInTeam(team.id, undefined, translate('shell.history.foundingTitle'))
    setActiveView('chat')
  }

  // ---- 行 ----
  const builtinRow = (agent: AgentSummary) => (
    <AgentRow
      key={`builtin:${agent.id}`}
      name={builtinName(agent)}
      description={builtinTagline(agent)}
      kind="builtin"
      avatar={(
        <span className="relative grid h-9 w-9 place-items-center">
          <AgentAvatar agent={agent} size={34} />
          <MarkStudioAffordance size={16} label={translate('agentMark.entry')} onClick={() => openMarkStudio({ roleName: agent.id, displayName: builtinName(agent), initial: resolveRoleMark({ name: agent.id, mark: agent.mark }) })} />
        </span>
      )}
      confirming={false}
      onTry={() => { void startConversationWith(agent) }}
      onCopy={() => { void handleCopyBuiltin(agent) }}
    />
  )
  const workspaceRow = (w: WorkspaceSummary) => (
    <AgentRow
      key={`ws:${w.id}`}
      name={w.name}
      description={w.description}
      meta={workspaceMeta(w, translate)}
      avatar={(
        <span className="relative grid h-9 w-9 place-items-center">
          <WorkspaceAvatar workspaceId={w.id} icon={w.icon} size={34} />
          <MarkStudioAffordance size={16} label={translate('agentMark.entry')} onClick={() => openMarkStudio({ scope: 'agent', roleName: w.id, displayName: w.name })} />
        </span>
      )}
      confirming={confirmDeleteId === w.id}
      onTry={() => { void startConversationWith({ id: w.id, kind: 'pal', name: w.name }) }}
      onDelete={() => { deleteWorkspace(w.id); setConfirmDeleteId(null) }}
      onArmDelete={() => armDelete(w.id)}
    />
  )
  const teamRow = (team: TeamSummary) => (
    <AgentRow
      key={`team:${team.id}`}
      name={team.name}
      description={teamMembersLine(team)}
      meta={[
        translate('agents.metrics.members', { count: team.members.length }),
        ...(team.channels.length ? [translate('agents.metrics.channels', { count: team.channels.length })] : [])
      ].join(' · ')}
      kind="team"
      tryLabel={translate('agents.actions.openThread')}
      avatar={(
        <span className="relative grid h-9 w-9 place-items-center">
          <TeamAvatar teamId={team.id} size={34} />
          <MarkStudioAffordance size={16} label={translate('agentMark.entry')} onClick={() => openMarkStudio({ scope: 'team', roleName: team.id, displayName: team.name })} />
        </span>
      )}
      confirming={confirmDeleteId === team.id}
      onTry={() => { void openThread(team) }}
      onDelete={() => { void deleteTeam(team.id); setConfirmDeleteId(null) }}
      onArmDelete={() => armDelete(team.id)}
    />
  )
  // ---- 分组 ----
  // 内置：按来源一组（像市场里的"官方出品"）；我的 Pal 按分类分组，没分类的落最后；团队在最后一组
  const shownBuiltins = builtins.filter(a => matches({ name: builtinName(a), description: builtinTagline(a) }))
  const shownWorkspaces = workspaces.filter(w => matches(w))
  const sections: Array<{ key: string; label: string; rows: React.ReactNode[] }> = []
  if (shownBuiltins.length) sections.push({ key: 'builtin', label: translate('agents.sections.builtin'), rows: shownBuiltins.map(builtinRow) })
  const groups = new Map<string, React.ReactNode[]>()
  for (const w of shownWorkspaces) {
    const key = w.category || ''
    groups.set(key, [...(groups.get(key) ?? []), workspaceRow(w)])
  }
  const categorised = categories.filter(c => groups.has(c))
  for (const c of categorised) sections.push({ key: `category:${c}`, label: categoryLabel(c), rows: groups.get(c)! })
  if (groups.has('')) sections.push({ key: 'mine', label: translate(categorised.length ? 'agents.sections.other' : 'agents.sections.mine'), rows: groups.get('')! })
  const shownTeams = teams.filter(team => matches({ name: team.name, description: teamMembersLine(team) }))
  if (shownTeams.length) sections.push({ key: 'teams', label: translate('agents.sections.teams'), rows: shownTeams.map(teamRow) })

  return (
    <div className="flex flex-col h-full">
      <div className="shrink-0 pt-6 px-8 pb-4 border-b border-surface-100">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div className="min-w-0">
            <h1 className="text-xl font-bold text-surface-700 tracking-tight">
              {translate('agents.title')}
            </h1>
            <p className="text-[13px] text-surface-400 mt-1 break-words">
              {translate('agents.description')}
            </p>
          </div>
          <div className="shrink-0 flex items-center gap-2">
            <button type="button" onClick={() => { void startFounding() }} data-testid="teams-create" className="flex items-center gap-1.5 px-4 py-2 rounded-md border border-surface-200 text-surface-700 font-medium text-[13px] hover:border-brand-400 hover:text-brand-600 transition-colors">
              <Users className="w-4 h-4" /> {translate('agents.actions.createTeam')}
            </button>
            <button type="button" onClick={handleCreate} data-testid="agents-create" className="flex items-center gap-1.5 px-4 py-2 rounded-md bg-brand-500 text-ink-on-accent font-medium text-[13px] shadow-sm hover:bg-brand-600 transition-colors">
              <Plus className="w-4 h-4" /> {translate('agents.actions.create')}
            </button>
          </div>
        </div>
        <div className="relative mt-4">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-surface-400" />
          <input
            value={query}
            onChange={event => setQuery(event.target.value)}
            placeholder={translate('agents.search.placeholder')}
            aria-label={translate('agents.search.placeholder')}
            data-testid="agents-search"
            className="w-full rounded-lg border border-surface-200 bg-surface-0 dark:bg-surface-50 pl-8 pr-3 py-1.5 text-[13px] text-surface-700 outline-none focus:border-brand-300 focus:ring-1 focus:ring-brand-100"
          />
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-8 py-6">
        {loading ? (
          <div className="py-16 text-center text-surface-300 text-[13px]">
            {translate('agents.loading')}
          </div>
        ) : (
          <>
          {sections.map(section => (
            <section key={section.key} className="mb-8" data-testid={section.key === 'builtin' ? 'agents-builtin' : 'agents-section'} data-section={section.key}>
              <h2 className="text-[11px] font-semibold text-surface-400 tracking-wider mb-2">{section.label}</h2>
              <ul className="grid grid-cols-1 lg:grid-cols-2 gap-x-10 gap-y-1" data-testid={section.key === 'builtin' ? undefined : 'agents-list'}>
                {section.rows}
              </ul>
            </section>
          ))}
          {/* 空态：还没有自己的 Pal（没在搜索）→ 引导去创建；否则是"搜索下没有" */}
          {!hasMine && !q ? (
            <>
              <h2 className="text-[11px] font-semibold text-surface-400 tracking-wider mb-2">{translate('agents.sections.mine')}</h2>
              <div className="py-10 text-center" data-testid="agents-mine-empty">
                <p className="text-[14px] text-surface-500 font-medium mb-2">
                  {translate('agents.empty.title')}
                </p>
                <p className="text-[13px] text-surface-300 max-w-sm mx-auto leading-relaxed">
                  {translate('agents.empty.fromConversation')}<br />
                  {translate('agents.empty.capabilities')}
                </p>
                <button type="button" onClick={handleCreate} className="mt-4 px-4 py-2 rounded-md bg-brand-500 text-ink-on-accent font-medium text-[13px] hover:bg-brand-600 transition-colors">
                  {translate('agents.actions.create')}
                </button>
              </div>
            </>
          ) : sections.length === 0 ? (
            <div className="py-14 text-center text-[13px] text-surface-400" data-testid="agents-search-empty">
              {translate('agents.search.empty')}
            </div>
          ) : null}
          </>
        )}
      </div>
      {markStudio}
    </div>
  )
}

function workspaceMeta(w: WorkspaceSummary, translate: TFunction): string | undefined {
  const parts: string[] = []
  if (w.memoryCount > 0) parts.push(translate('agents.metrics.memories', { count: w.memoryCount }))
  if (w.taskCount > 0) parts.push(translate('agents.metrics.tasks', { count: w.taskCount }))
  return parts.length ? parts.join(' · ') : undefined
}

// ---- 一行一个 Pal ----

function AgentRow({ name, description, meta, kind = 'pal', tryLabel, avatar, confirming, onTry, onCopy, onDelete, onArmDelete }: {
  name: string
  description?: string
  /** 第二行灰字：记忆条数、自动化个数或模板的工作目录 */
  meta?: string
  kind?: 'builtin' | 'pal' | 'team'
  /** 悬停按钮的文字；默认"试一下"，团队是"开个话题" */
  tryLabel?: string
  avatar: React.ReactNode
  confirming: boolean
  onTry: () => void
  /** 内置：复制成自己的 Pal */
  onCopy?: () => void
  /** 没有 = 不可删（内置） */
  onDelete?: () => void
  onArmDelete?: () => void
}) {
  const { t: translate } = useTranslation()
  return (
    <li className="group flex items-center gap-3 px-3 py-2.5 -mx-3 rounded-lg hover:bg-surface-50 transition-colors" data-testid="agent-row" data-agent-kind={kind}>
      <span className="shrink-0">{avatar}</span>
      <div className="flex-1 min-w-0">
        <h3 className="text-[13.5px] font-semibold text-surface-700 truncate">{name}</h3>
        {description && <p className="text-[12px] text-surface-400 truncate" title={description}>{description}</p>}
        {meta && <p className="text-[11px] text-surface-300 truncate">{meta}</p>}
      </div>
      {/* 整行的动作都藏在悬停里（试一下也是）：列表安静，鼠标到哪一行哪一行亮 */}
      <div className="flex items-center gap-1 shrink-0">
        <span className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 transition-opacity">
          {onCopy && (
            <button
              type="button"
              onClick={onCopy}
              data-testid="agent-copy"
              aria-label={translate('agents.actions.copyAsPalNamed', { name })}
              title={translate('agents.actions.copyAsPalNamed', { name })}
              className="p-1.5 rounded-md text-surface-400 hover:text-surface-600 hover:bg-surface-100 transition-colors"
            >
              <Copy className="w-3.5 h-3.5" />
            </button>
          )}
          {!onDelete ? null : confirming ? (
            <button
              type="button"
              onClick={onDelete}
              aria-label={translate('agents.actions.confirmDeleteNamed', { name })}
              className="px-2 py-1 text-[10px] text-red-500 rounded bg-red-50 font-medium"
            >
              {translate('agents.actions.confirmDelete')}
            </button>
          ) : (
            <button
              type="button"
              onClick={onArmDelete}
              aria-label={translate('agents.actions.deleteNamed', { name })}
              title={translate('agents.actions.deleteNamed', { name })}
              className="p-1.5 rounded-md text-surface-300 hover:text-red-400 transition-colors"
            >
              <Trash2 className="w-3.5 h-3.5" />
            </button>
          )}
        </span>
        <button
          type="button"
          onClick={onTry}
          data-testid="agent-try"
          className="px-3.5 py-1.5 rounded-full border border-surface-200 text-[12.5px] font-medium text-surface-700 hover:border-brand-400 hover:text-brand-600 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 transition-opacity"
        >
          {tryLabel ?? translate('agents.actions.tryIt')}
        </button>
      </div>
    </li>
  )
}

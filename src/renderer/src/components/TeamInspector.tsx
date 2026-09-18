/**
 * TeamInspector — 团队目录面板（中栏，与 Pal 的 AgentWorkspaceInspector 同一个位置）。
 *
 * 话题带 teamId 时替换 Pal 面板：所见即磁盘——team.md（声明 + 章程）、成员、频道、memory/、rules/、shared/、自动化。
 * 章程在这里改（只有人能改；Pal 只能写 memory/ 与 shared/，见 pi-security 的团队写边界）。
 */
import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Brain, Clock, ExternalLink, FileText, FolderOpen, Hash, Plus, Shield, Users, X } from 'lucide-react'
import { Markdown } from './shared/Markdown'
import { MarkStudioAffordance, TeamAvatar, WorkspaceAvatar, useAgentMarkStudio } from './agent-mark'
import { parseFrontmatter } from '../../../shared/frontmatter'
import { useChatStore } from '../stores/chatStore'
import { useAgentStore } from '../stores/agentStore'
import type { Task } from '../types'

interface TeamMember { id: string; name: string; description?: string }
interface TeamDetail {
  id: string
  name: string
  lead: string
  members: string[]
  tier: string
  channels: string[]
  teamMd: string
  charter: string
  dir: string
  sharedDir: string
  memberProfiles: TeamMember[]
  memories: Array<{ name: string; content: string }>
  rules: string[]
  sharedFiles: string[]
  tasks: Task[]
}

type Selected =
  | { kind: 'team-md' }
  | { kind: 'memory'; name: string }
  | { kind: 'file'; rel: string; name: string }
  | { kind: 'task'; id: string }

const TEXT_EXT = /\.(md|txt|json|ts|js|mjs|cjs|yml|yaml|csv|html|css|py|sh)(\.off)?$/i

function splitFrontmatter(content: string): { declarations: string[]; body: string } {
  const { frontmatter, body } = parseFrontmatter(content)
  return { declarations: Object.entries(frontmatter).map(([k, v]) => `${k}: ${v}`), body }
}

export function TeamInspector({ teamId, channel, onClose }: { teamId: string; channel?: string | null; onClose?: () => void }) {
  const { t } = useTranslation()
  const [team, setTeam] = useState<TeamDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [selected, setSelected] = useState<Selected>({ kind: 'team-md' })
  const [fileContent, setFileContent] = useState<string | null>(null)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [saving, setSaving] = useState(false)
  const { openMarkStudio, markStudio } = useAgentMarkStudio()

  const load = useCallback(async () => {
    setLoading(true)
    try {
      setTeam((await window.api.getTeam?.(teamId)) ?? null)
    } catch {
      setTeam(null)
    } finally {
      setLoading(false)
    }
  }, [teamId])

  useEffect(() => {
    setSelected({ kind: 'team-md' })
    setEditing(false)
    void load()
  }, [teamId, load])
  // 面板是磁盘的镜子：主进程一说"这个团队的目录变了"（组长改名 / 写章程 / 建成员、团队记忆落盘）就重读，
  // 话题跑完再兜底读一遍（成员用 write 直接放进 shared/ 的文件没有变更事件）；正在改章程时不打断
  const streaming = useChatStore(s => s.isStreaming)
  useEffect(() => {
    if (!streaming && !editing) void load()
  }, [streaming]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => window.api.onTeamChanged?.((id: string) => {
    if (id === teamId && !editing) void load()
  }), [teamId, editing, load])
  // 成员头像用 Pal 自己的 emoji（捏过头像的画 mark）：Pal 列表左栏已经拉过，不再经团队目录多传一份
  const workspaces = useAgentStore(s => s.workspaces)

  useEffect(() => {
    if (selected.kind !== 'file' || !TEXT_EXT.test(selected.name)) { setFileContent(null); return }
    let cancelled = false
    window.api.readTeamFile?.(teamId, selected.rel)
      .then((content: string | null) => { if (!cancelled) setFileContent(content) })
      .catch(() => { if (!cancelled) setFileContent(null) })
    return () => { cancelled = true }
  }, [selected, teamId])

  // 复盘是一条定时任务模板，不是新机制（设计稿 §6）：每周一 09:00 让 Lead 修剪团队记忆、把共享文件夹里值得记的写下来
  const [addingRetro, setAddingRetro] = useState(false)
  const addRetro = async (): Promise<void> => {
    if (!team) return
    setAddingRetro(true)
    try {
      await window.api.createTask?.({
        name: t('teamInspector.retro.name'),
        enabled: true,
        teamId: team.id,
        ...(channel ? { channel } : {}),
        trigger: { type: 'schedule', schedule: { type: 'fixed', time: '09:00', days: ['mon'] } },
        prompt: t('teamInspector.retro.prompt'),
        conversationMode: 'per-run',
        smartSilence: true
      })
      await load()
    } finally {
      setAddingRetro(false)
    }
  }
  const charterLines = team ? team.charter.split('\n').length : 0

  const startEdit = (): void => { setDraft(team?.teamMd ?? ''); setEditing(true) }
  const save = async (): Promise<void> => {
    if (!team) return
    setSaving(true)
    try {
      await window.api.writeTeamMd?.(team.id, draft)
      setEditing(false)
      await load()
    } finally {
      setSaving(false)
    }
  }

  if (loading) {
    return <div className="h-full flex items-center justify-center text-[12px] text-surface-400">{t('teamInspector.loading')}</div>
  }
  if (!team) {
    return <div className="h-full flex items-center justify-center text-[12px] text-surface-400">{t('teamInspector.loadError')}</div>
  }

  const isSelected = (s: Selected): boolean => JSON.stringify(s) === JSON.stringify(selected)
  const row = (s: Selected, label: string, opts: { indent?: boolean; icon?: React.ReactNode; suffix?: React.ReactNode; testId?: string } = {}) => (
    <button
      key={JSON.stringify(s)}
      onClick={() => setSelected(s)}
      data-testid={opts.testId}
      className={`w-full flex items-center gap-1.5 px-3 py-1.5 text-[11px] transition-colors text-left ${opts.indent ? 'pl-6' : ''} ${
        isSelected(s) ? 'bg-brand-50 dark:bg-brand-900/20 text-brand-600 dark:text-brand-400' : 'text-surface-500 hover:bg-surface-50'
      }`}
    >
      {opts.icon ?? <FileText className="w-3 h-3 shrink-0 opacity-60" />}
      <span className="truncate font-mono flex-1">{label}</span>
      {opts.suffix}
    </button>
  )
  const sectionHeader = (icon: React.ReactNode, label: string) => (
    <div className="px-3 py-1 flex items-center gap-1.5 text-[10px] text-surface-300 font-medium uppercase tracking-wider">{icon}{label}</div>
  )
  const emptyLine = (text: string) => <p className="pl-6 py-1 text-[10px] text-surface-300 italic">{text}</p>

  const memberOf = (id: string): TeamMember => team.memberProfiles.find(m => m.id === id) ?? { id, name: id.slice(0, 8) }
  const selectedMemory = selected.kind === 'memory' ? team.memories.find(m => m.name === selected.name) : undefined
  const selectedTask = selected.kind === 'task' ? team.tasks.find(x => x.id === selected.id) : undefined

  return (
    <div className="h-full flex flex-col bg-surface-0 dark:bg-surface-50 border-r border-surface-100" data-testid="team-inspector">
      {/* 头部：团队 mark（可捏）+ 名字 + 目录 + Finder + 关闭 */}
      <div className="shrink-0 flex items-center gap-2 px-3 py-2.5 border-b border-surface-100">
        <span className="relative grid h-7 w-7 place-items-center shrink-0">
          <TeamAvatar teamId={team.id} size={22} />
          <MarkStudioAffordance size={12} label={t('teamInspector.actions.markEntry')} onClick={() => openMarkStudio({ scope: 'team', roleName: team.id, displayName: team.name })} />
        </span>
        <div className="flex-1 min-w-0">
          <p className="text-[12px] font-semibold text-surface-700 truncate" data-testid="team-inspector-name">
            {team.name}{channel ? <span className="text-surface-400 font-normal"> › {channel}</span> : null}
          </p>
          <p className="text-[10px] text-surface-300 font-mono truncate" title={team.dir}>teams/{team.id.slice(0, 8)}…</p>
        </div>
        <button onClick={() => { void window.api.revealFile?.(`${team.dir}/team.md`) }} className="p-1.5 rounded hover:bg-surface-100 transition-colors" title={t('teamInspector.actions.revealInFinder')}>
          <ExternalLink className="w-3.5 h-3.5 text-surface-400" />
        </button>
        {onClose && (
          <button onClick={onClose} className="p-1.5 rounded hover:bg-surface-100 transition-colors" title={t('teamInspector.actions.close')}>
            <X className="w-3.5 h-3.5 text-surface-400" />
          </button>
        )}
      </div>

      {/* 目录树 */}
      <div className="shrink-0 border-b border-surface-100 py-1 max-h-72 overflow-y-auto">
        {row({ kind: 'team-md' }, 'team.md', { testId: 'team-inspector-team-md' })}

        <div className="mt-1">
          {sectionHeader(<Users className="w-3 h-3" />, t('teamInspector.sections.members'))}
          {team.members.length === 0 && emptyLine(t('teamInspector.empty.members'))}
          {team.members.map(id => {
            const m = memberOf(id)
            return (
              <div key={id} className="flex items-center gap-1.5 pl-6 pr-3 py-1 text-[11px] text-surface-500" data-testid="team-inspector-member">
                <WorkspaceAvatar workspaceId={id} size={14} className="text-xs leading-none shrink-0" />
                <span className="truncate flex-1">{m.name}</span>
                {id === team.lead && <span className="text-[9px] px-1 rounded bg-surface-700 text-surface-0 dark:bg-surface-200 dark:text-surface-700">{t('teamInspector.lead')}</span>}
              </div>
            )
          })}
        </div>

        {team.channels.length > 0 && (
          <div className="mt-1">
            {sectionHeader(<Hash className="w-3 h-3" />, t('teamInspector.sections.channels'))}
            {team.channels.map(name => (
              <div key={name} className={`flex items-center gap-1.5 pl-6 pr-3 py-1 text-[11px] ${name === channel ? 'text-brand-600 dark:text-brand-400' : 'text-surface-500'}`}>
                <span className="truncate flex-1 font-mono">{name}</span>
                {name === channel && <span className="text-[9px] text-surface-300">{t('teamInspector.current')}</span>}
              </div>
            ))}
          </div>
        )}

        <div className="mt-1">
          {sectionHeader(<Brain className="w-3 h-3" />, t('teamInspector.sections.memory'))}
          {team.memories.length === 0 && emptyLine(t('teamInspector.empty.memory'))}
          {team.memories.map(m => row({ kind: 'memory', name: m.name }, `${m.name}.md`, { indent: true }))}
        </div>

        <div className="mt-1">
          {sectionHeader(<Shield className="w-3 h-3" />, t('teamInspector.sections.rules'))}
          {team.rules.length === 0 && emptyLine(t('teamInspector.empty.rules'))}
          {team.rules.map(name => row({ kind: 'file', rel: `rules/${name}`, name }, name, { indent: true }))}
        </div>

        <div className="mt-1">
          {sectionHeader(<FolderOpen className="w-3 h-3" />, t('teamInspector.sections.shared'))}
          {team.sharedFiles.length === 0 && emptyLine(t('teamInspector.empty.shared'))}
          {team.sharedFiles.map(name => row({ kind: 'file', rel: `shared/${name}`, name }, name, { indent: true }))}
        </div>

        <div className="mt-1">
          <div className="px-3 py-1 flex items-center gap-1.5 text-[10px] text-surface-300 font-medium uppercase tracking-wider">
            <Clock className="w-3 h-3" />
            <span className="flex-1">{t('teamInspector.sections.tasks')}</span>
            {!team.tasks.some(task => task.name === t('teamInspector.retro.name')) && (
              <button
                onClick={() => { void addRetro() }}
                disabled={addingRetro}
                data-testid="team-add-retro"
                className="flex items-center gap-0.5 normal-case tracking-normal text-[10px] text-brand-500 hover:text-brand-600 disabled:opacity-50"
                title={t('teamInspector.actions.addRetro')}
              >
                <Plus className="w-3 h-3" />{t('teamInspector.actions.addRetro')}
              </button>
            )}
          </div>
          {team.tasks.length === 0 && emptyLine(t('teamInspector.empty.tasks'))}
          {team.tasks.map(task => row({ kind: 'task', id: task.id }, task.name, {
            indent: true,
            icon: <Clock className="w-3 h-3 shrink-0 opacity-60" />,
            suffix: <span className={`w-1.5 h-1.5 rounded-full ${task.enabled ? 'bg-brand-400' : 'bg-surface-200'}`} />
          }))}
        </div>
      </div>

      {/* 预览 */}
      <div className="flex-1 min-h-0 overflow-y-auto p-3">
        {selected.kind === 'team-md' && (
          <>
            <div className="flex items-center gap-1.5 mb-2 pb-2 border-b border-surface-100">
              <FileText className="w-3 h-3 text-surface-400" />
              <span className="text-[11px] font-mono text-surface-500 flex-1">team.md</span>
              {editing ? (
                <>
                  <button onClick={() => setEditing(false)} className="text-[10px] text-surface-400 hover:text-surface-600">{t('teamInspector.actions.cancel')}</button>
                  <button onClick={() => { void save() }} disabled={saving} data-testid="team-md-save" className="text-[10px] text-brand-500 hover:text-brand-600 disabled:opacity-50">{t('teamInspector.actions.save')}</button>
                </>
              ) : (
                <button onClick={startEdit} data-testid="team-md-edit" className="text-[10px] text-brand-500 hover:text-brand-600">{t('teamInspector.actions.edit')}</button>
              )}
            </div>
            {editing ? (
              <textarea
                value={draft}
                onChange={e => setDraft(e.target.value)}
                data-testid="team-md-editor"
                className="w-full h-64 rounded-md border border-surface-200 bg-surface-0 p-2 text-[11px] font-mono text-surface-700 outline-none focus:border-brand-300"
              />
            ) : (() => {
              const { declarations, body } = splitFrontmatter(team.teamMd)
              return (
                <>
                  {declarations.length > 0 && (
                    <p className="mb-2 text-[11px] font-mono text-surface-400 break-words" data-testid="team-md-declarations">{declarations.join(' · ')}</p>
                  )}
                  {charterLines > 200 && (
                    <p className="mb-2 text-[11px] text-amber-600" data-testid="team-charter-long">{t('teamInspector.charterLong', { count: charterLines })}</p>
                  )}
                  <div className="prose-light text-[12px] [&_h1]:text-[14px] [&_h2]:text-[13px] [&_h3]:text-[12px] [&_p]:text-[12px]">
                    <Markdown content={body} />
                  </div>
                </>
              )
            })()}
          </>
        )}
        {selected.kind === 'memory' && selectedMemory && (
          <>
            <div className="flex items-center gap-1.5 mb-2 pb-2 border-b border-surface-100">
              <FileText className="w-3 h-3 text-surface-400" />
              <span className="text-[11px] font-mono text-surface-500 flex-1 break-all">memory/{selectedMemory.name}.md</span>
            </div>
            <div className="prose-light text-[12px] [&_p]:text-[12px]">
              <Markdown content={splitFrontmatter(selectedMemory.content).body} />
            </div>
          </>
        )}
        {selected.kind === 'file' && (
          <>
            <div className="flex items-center gap-1.5 mb-2 pb-2 border-b border-surface-100">
              <FileText className="w-3 h-3 text-surface-400" />
              <span className="text-[11px] font-mono text-surface-500 flex-1 break-all">{selected.rel}</span>
            </div>
            {!TEXT_EXT.test(selected.name)
              ? <p className="text-[11px] text-surface-300">{t('teamInspector.notText')}</p>
              : selected.name.endsWith('.md')
                ? <div className="prose-light text-[12px] [&_p]:text-[12px]"><Markdown content={fileContent ?? ''} /></div>
                : <pre className="text-[11px] font-mono text-surface-600 whitespace-pre-wrap break-words">{fileContent ?? ''}</pre>}
          </>
        )}
        {selected.kind === 'task' && selectedTask && (
          <>
            <div className="flex items-center gap-1.5 mb-2 pb-2 border-b border-surface-100">
              <Clock className="w-3 h-3 text-surface-400" />
              <span className="text-[11px] font-mono text-surface-500 flex-1">{selectedTask.name}</span>
            </div>
            <div className="prose-light text-[12px] [&_p]:text-[12px]">
              <Markdown content={`**${selectedTask.name}**\n\n${selectedTask.enabled ? t('agentWorkspace.task.enabled') : t('agentWorkspace.task.disabled')} · ${selectedTask.conversationMode === 'persistent' ? t('agentWorkspace.task.persistent') : t('agentWorkspace.task.perRun')}\n\n**${t('agentWorkspace.task.prompt')}:**\n${selectedTask.prompt}`} />
            </div>
          </>
        )}
      </div>
      {markStudio}
    </div>
  )
}

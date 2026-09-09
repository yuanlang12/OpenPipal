import { useEffect, useState } from 'react'
import { Plus, Trash2, Edit2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import { useAgentStore, type AgentTemplate, type WorkspaceSummary } from '../stores/agentStore'
import { useChatStore } from '../stores/chatStore'
import { useAppStore } from '../stores/appStore'
import { AgentTemplateEditor } from './AgentTemplateEditor'
import { useAgentMarkStudio, MarkStudioAffordance, WorkspaceAvatar } from './agent-mark'
import { PAL_BASE_ROLE } from '../../../shared/pal-contract'

/** 「创建」去的是通用助手：在那里聊完点"保存为 Pal"就是新建的路 */
const CREATE_ROLE = PAL_BASE_ROLE

/**
 * 我的 Pals —— 两栏列表，每行：头像 · 名字 · 一句描述 · 右侧「试一下」。
 * 没有分类和作者，所以没有分组标题和 "by 某某"；从对话保存的在前、手动建的模板在后，各按主进程给的顺序，
 * 模板行多一个编辑入口。删除藏在悬停里，不抢"试一下"。
 */
export function AgentsPanel() {
  const { t: translate } = useTranslation()
  const { templates, workspaces, loading, loadTemplates, loadWorkspaces, updateTemplate, deleteTemplate, deleteWorkspace } = useAgentStore()
  const { newConversationFromAgent, newConversationFromWorkspace } = useChatStore()
  const { setActiveView } = useAppStore()
  const { openMarkStudio, markStudio } = useAgentMarkStudio()

  const [editing, setEditing] = useState<AgentTemplate | null>(null)
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)

  useEffect(() => { loadTemplates(); loadWorkspaces() }, [])

  const handleUpdate = async (data: Omit<AgentTemplate, 'id' | 'createdAt' | 'updatedAt'>) => {
    if (editing) {
      await updateTemplate(editing.id, data)
      setEditing(null)
    }
  }
  const handleStartTemplate = async (agentId: string, agentName: string) => {
    // Pal 的人设在它自己的目录里；role 槽位一律给中性值，不借 App 当前选中的全局角色（见 pal-contract）
    await newConversationFromAgent(PAL_BASE_ROLE, agentId, agentName)
    setActiveView('chat')
  }
  const handleStartWorkspace = async (w: WorkspaceSummary) => {
    await newConversationFromWorkspace(PAL_BASE_ROLE, w.id, w.name)
    setActiveView('chat')
  }
  const handleCreate = async () => {
    const { newConversation } = useChatStore.getState()
    await newConversation(CREATE_ROLE)
    setActiveView('chat')
  }
  const handleEdit = async (id: string) => {
    const full = await window.api.getAgentTemplate!(id)
    if (full) setEditing(full)
  }
  const armDelete = (id: string): void => {
    setConfirmDeleteId(id)
    setTimeout(() => setConfirmDeleteId(current => (current === id ? null : current)), 3000)
  }

  if (editing) {
    return (
      <div className="flex flex-col h-full">
        <div className="shrink-0 pt-6 px-8 pb-4 border-b border-surface-100">
          <h1 className="text-xl font-bold text-surface-700 tracking-tight">
            {translate('agents.editor.editTitle')}
          </h1>
        </div>
        <div className="flex-1 overflow-y-auto px-8 py-4">
          <AgentTemplateEditor initial={editing} onSave={handleUpdate} onCancel={() => setEditing(null)} />
        </div>
      </div>
    )
  }

  const hasAny = templates.length > 0 || workspaces.length > 0

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
          <button type="button" onClick={handleCreate} data-testid="agents-create" className="shrink-0 flex items-center gap-1.5 px-4 py-2 rounded-md bg-brand-500 text-ink-on-accent font-medium text-[13px] shadow-sm hover:bg-brand-600 transition-colors">
            <Plus className="w-4 h-4" /> {translate('agents.actions.create')}
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-8 py-6">
        {loading ? (
          <div className="py-16 text-center text-surface-300 text-[13px]">
            {translate('agents.loading')}
          </div>
        ) : !hasAny ? (
          <div className="py-16 text-center">
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
        ) : (
          <ul className="grid grid-cols-1 lg:grid-cols-2 gap-x-10 gap-y-1" data-testid="agents-list">
            {workspaces.map(w => (
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
                onTry={() => { void handleStartWorkspace(w) }}
                onDelete={() => { deleteWorkspace(w.id); setConfirmDeleteId(null) }}
                onArmDelete={() => armDelete(w.id)}
              />
            ))}
            {templates.map(template => (
              <AgentRow
                key={`tpl:${template.id}`}
                name={template.name}
                description={template.description}
                meta={template.workingDir ? `📂 ${template.workingDir.split('/').pop()}` : undefined}
                avatar={<span className="grid h-9 w-9 place-items-center text-2xl">{template.icon}</span>}
                confirming={confirmDeleteId === template.id}
                onTry={() => { void handleStartTemplate(template.id, template.name) }}
                onEdit={() => { void handleEdit(template.id) }}
                onDelete={() => { deleteTemplate(template.id); setConfirmDeleteId(null) }}
                onArmDelete={() => armDelete(template.id)}
              />
            ))}
          </ul>
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

function AgentRow({ name, description, meta, avatar, confirming, onTry, onEdit, onDelete, onArmDelete }: {
  name: string
  description?: string
  /** 第二行灰字：记忆条数、自动化个数或模板的工作目录 */
  meta?: string
  avatar: React.ReactNode
  confirming: boolean
  onTry: () => void
  onEdit?: () => void
  onDelete: () => void
  onArmDelete: () => void
}) {
  const { t: translate } = useTranslation()
  return (
    <li className="group flex items-center gap-3 px-3 py-2.5 -mx-3 rounded-lg hover:bg-surface-50 transition-colors" data-testid="agent-row">
      <span className="shrink-0">{avatar}</span>
      <div className="flex-1 min-w-0">
        <h3 className="text-[13.5px] font-semibold text-surface-700 truncate">{name}</h3>
        {description && <p className="text-[12px] text-surface-400 truncate" title={description}>{description}</p>}
        {meta && <p className="text-[11px] text-surface-300 truncate">{meta}</p>}
      </div>
      <div className="flex items-center gap-1 shrink-0">
        <span className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 transition-opacity">
          {onEdit && (
            <button
              type="button"
              onClick={onEdit}
              aria-label={translate('agents.actions.editNamed', { name })}
              title={translate('agents.actions.editNamed', { name })}
              className="p-1.5 rounded-md text-surface-400 hover:text-surface-600 hover:bg-surface-100 transition-colors"
            >
              <Edit2 className="w-3.5 h-3.5" />
            </button>
          )}
          {confirming ? (
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
          className="px-3.5 py-1.5 rounded-full border border-surface-200 text-[12.5px] font-medium text-surface-700 hover:border-brand-400 hover:text-brand-600 transition-colors"
        >
          {translate('agents.actions.tryIt')}
        </button>
      </div>
    </li>
  )
}

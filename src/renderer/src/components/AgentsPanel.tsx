import { useEffect, useState } from 'react'
import { Plus, Trash2, Edit2, MessageSquare, Brain, FileText, Clock } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import { useAgentStore, type AgentTemplate, type WorkspaceSummary } from '../stores/agentStore'
import { useChatStore } from '../stores/chatStore'
import { useAppStore } from '../stores/appStore'
import { AgentTemplateEditor } from './AgentTemplateEditor'
import { formatLocaleDate } from '../i18n/formatters'
import { useAgentMarkStudio, MarkStudioAffordance, WorkspaceAvatar } from './agent-mark'

export function AgentsPanel() {
  const { t: translate, i18n } = useTranslation()
  const locale = i18n.resolvedLanguage || i18n.language
  const { templates, workspaces, loading, loadTemplates, loadWorkspaces, updateTemplate, deleteTemplate, deleteWorkspace } = useAgentStore()
  const { newConversationFromAgent, newConversationFromWorkspace } = useChatStore()
  const { setActiveView } = useAppStore()
  const roleName = useAppStore(s => s.currentRole?.name || 'learner')
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
  const handleStartChat = async (agentId: string, agentName: string) => {
    await newConversationFromAgent(roleName, agentId, agentName)
    setActiveView('chat')
  }
  const handleNewChat = async () => {
    const { newConversation } = useChatStore.getState()
    await newConversation(roleName)
    setActiveView('chat')
  }
  const handleEdit = async (id: string) => {
    const full = await window.api.getAgentTemplate!(id)
    if (full) setEditing(full)
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
          <button type="button" onClick={handleNewChat} className="shrink-0 flex items-center gap-1.5 px-4 py-2 rounded-md bg-brand-500 text-ink-on-accent font-medium text-[13px] shadow-sm hover:bg-brand-600 transition-colors">
            <Plus className="w-4 h-4" /> {translate('agents.actions.newConversation')}
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
            <button type="button" onClick={handleNewChat} className="mt-4 px-4 py-2 rounded-md bg-brand-500 text-ink-on-accent font-medium text-[13px] hover:bg-brand-600 transition-colors">
              {translate('agents.actions.startConversation')}
            </button>
          </div>
        ) : (
          <div className="space-y-6">
            {/* Workspace Agents — 从对话中提取的 */}
            {workspaces.length > 0 && (
              <div>
                <h2 className="text-[12px] font-medium text-surface-400 uppercase tracking-wider mb-3">
                  {translate('agents.sections.generated')}
                </h2>
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                  {workspaces.map(w => (
                    <WorkspaceCard
                      key={w.id}
                      workspace={w}
                      confirmDeleteId={confirmDeleteId}
                      translate={translate}
                      locale={locale}
                      onStartChat={async () => {
                        await newConversationFromWorkspace(roleName, w.id, w.name)
                        setActiveView('chat')
                      }}
                      onDelete={() => deleteWorkspace(w.id)}
                      onConfirmDelete={() => { setConfirmDeleteId(w.id); setTimeout(() => setConfirmDeleteId(null), 3000) }}
                      onCustomizeMark={() => openMarkStudio({ scope: 'agent', roleName: w.id, displayName: w.name })}
                    />
                  ))}
                </div>
              </div>
            )}

            {/* 旧 Agent 模板 */}
            {templates.length > 0 && (
              <div>
                <h2 className="text-[12px] font-medium text-surface-400 uppercase tracking-wider mb-3">
                  {translate('agents.sections.templates')}
                </h2>
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                  {templates.map(template => (
                    <div key={template.id} className="group flex flex-col p-5 rounded-lg border border-surface-100 hover:border-brand-200 dark:hover:border-brand-700 transition-colors">
                      <div className="flex items-start gap-3 mb-3">
                        <span className="text-2xl">{template.icon}</span>
                        <div className="flex-1 min-w-0">
                          <h3 className="text-[14px] font-semibold text-surface-700 break-words">{template.name}</h3>
                          {template.description && <p className="text-[12px] text-surface-400 mt-0.5 line-clamp-2 break-words">{template.description}</p>}
                        </div>
                      </div>
                      {template.workingDir && <p title={template.workingDir} className="text-[11px] text-surface-300 mb-3 truncate">📂 {template.workingDir.split('/').pop()}</p>}
                      <div className="mt-auto pt-3 border-t border-surface-100 flex flex-wrap items-center justify-end gap-1.5 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 transition-opacity">
                        <button type="button" onClick={() => handleStartChat(template.id, template.name)} className="flex items-center gap-1 px-2.5 py-1.5 rounded-md text-[11px] font-medium text-brand-600 hover:bg-brand-50 transition-colors">
                          <MessageSquare className="w-3.5 h-3.5" /> {translate('agents.actions.chat')}
                        </button>
                        <button
                          type="button"
                          onClick={() => handleEdit(template.id)}
                          aria-label={translate('agents.actions.editNamed', { name: template.name })}
                          title={translate('agents.actions.editNamed', { name: template.name })}
                          className="p-1.5 rounded-md text-surface-400 hover:text-surface-600 hover:bg-surface-100 transition-colors"
                        >
                          <Edit2 className="w-3.5 h-3.5" />
                        </button>
                        {confirmDeleteId === template.id ? (
                          <button
                            type="button"
                            onClick={() => { deleteTemplate(template.id); setConfirmDeleteId(null) }}
                            aria-label={translate('agents.actions.confirmDeleteNamed', { name: template.name })}
                            className="px-2 py-1 text-[10px] text-red-500 rounded bg-red-50 font-medium"
                          >
                            {translate('agents.actions.confirmDelete')}
                          </button>
                        ) : (
                          <button
                            type="button"
                            onClick={() => { setConfirmDeleteId(template.id); setTimeout(() => setConfirmDeleteId(null), 3000) }}
                            aria-label={translate('agents.actions.deleteNamed', { name: template.name })}
                            title={translate('agents.actions.deleteNamed', { name: template.name })}
                            className="p-1.5 rounded-md text-surface-300 hover:text-red-400 transition-colors"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
      {markStudio}
    </div>
  )
}

// ---- Workspace 卡片组件 ----

function WorkspaceCard({ workspace: w, confirmDeleteId, translate, locale, onStartChat, onDelete, onConfirmDelete, onCustomizeMark }: {
  workspace: WorkspaceSummary
  confirmDeleteId: string | null
  translate: TFunction
  locale: string
  onStartChat: () => void
  onDelete: () => void
  onConfirmDelete: () => void
  /** 捏头像入口 —— 改的是这张卡所属角色的标识，不动 workspace 自己的 emoji 图标 */
  onCustomizeMark: () => void
}) {
  return (
    <div className="group flex flex-col p-5 rounded-lg border border-brand-100 dark:border-brand-800 bg-brand-50/30 dark:bg-brand-900/10 hover:border-brand-300 dark:hover:border-brand-600 transition-colors cursor-pointer" onClick={onStartChat}>
      <div className="flex items-start gap-3 mb-3">
        <span className="relative shrink-0 grid h-7 w-7 place-items-center text-2xl">
          <WorkspaceAvatar workspaceId={w.id} icon={w.icon} size={26} />
          <MarkStudioAffordance
            size={18}
            label={translate('agentMark.entry')}
            onClick={onCustomizeMark}
          />
        </span>
        <div className="flex-1 min-w-0">
          <h3 className="text-[14px] font-semibold text-surface-700 break-words">{w.name}</h3>
          {w.description && <p className="text-[12px] text-surface-400 mt-0.5 line-clamp-2 break-words">{w.description}</p>}
        </div>
      </div>

      {/* 能力指标 */}
      <div className="flex flex-wrap items-center gap-3 text-[11px] text-surface-300 mb-3">
        {w.hasAgentMd && (
          <span className="flex items-center gap-1">
            <FileText className="w-3 h-3" /> agent.md
          </span>
        )}
        {w.memoryCount > 0 && (
          <span className="flex items-center gap-1">
            <Brain className="w-3 h-3" /> {translate('agents.metrics.memories', { count: w.memoryCount })}
          </span>
        )}
        {w.taskCount > 0 && (
          <span className="flex items-center gap-1">
            <Clock className="w-3 h-3" /> {translate('agents.metrics.tasks', { count: w.taskCount })}
          </span>
        )}
      </div>

      <div className="mt-auto pt-3 border-t border-brand-100 dark:border-brand-800 flex items-center justify-between">
        <span className="text-[10px] text-surface-300">
          {formatLocaleDate(w.createdAt, locale)}
        </span>
        <div className="flex flex-wrap items-center justify-end gap-1.5 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 transition-opacity">
          <button type="button" onClick={(e) => { e.stopPropagation(); onStartChat() }} className="flex items-center gap-1 px-2.5 py-1.5 rounded-md text-[11px] font-medium text-brand-600 hover:bg-brand-50 transition-colors">
            <MessageSquare className="w-3.5 h-3.5" /> {translate('agents.actions.chat')}
          </button>
          {confirmDeleteId === w.id ? (
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); onDelete() }}
              aria-label={translate('agents.actions.confirmDeleteNamed', { name: w.name })}
              className="px-2 py-1 text-[10px] text-red-500 rounded bg-red-50 font-medium"
            >
              {translate('agents.actions.confirmDelete')}
            </button>
          ) : (
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); onConfirmDelete() }}
              aria-label={translate('agents.actions.deleteNamed', { name: w.name })}
              title={translate('agents.actions.deleteNamed', { name: w.name })}
              className="p-1.5 rounded-md text-surface-300 hover:text-red-400 transition-colors"
            >
              <Trash2 className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

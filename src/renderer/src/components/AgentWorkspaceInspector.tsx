/**
 * AgentWorkspaceInspector — Agent 工作空间文件结构面板
 *
 * 作为三栏布局的中间一列，独立于对话区显示 Agent 背后的完整文件结构。
 * 让用户能直观看到 Agent 的"大脑"由哪些文件构成。
 *
 * 设计原则：
 * - 文件系统透明 — 所见即磁盘上的真实结构
 * - 可点击查看内容 — 点击文件节点在下方内联展示 Markdown 渲染
 * - 可打开真实位置 — 一键在 Finder 中定位
 * - 未来云端同步时 UI 不变 — 文件结构对等
 */

import { useState, useEffect, useCallback } from 'react'
import { FileText, Brain, ExternalLink, X, Zap, User, Wrench, Clock, Plus } from 'lucide-react'
import { Workspace, useAgentStore } from '../stores/agentStore'
import { useTaskStore } from '../stores/taskStore'
import { Markdown } from './shared/Markdown'
import { TaskEditor } from './TaskEditor'
import type { Task } from '../types'
import { useTranslation } from 'react-i18next'
import { formatLocaleDateTime } from '../i18n/formatters'

interface Props {
  workspaceId: string
  onClose?: () => void
}

type FileNode = {
  kind: 'agent-md' | 'me-md' | 'memory' | 'skill' | 'tools' | 'task'
  path: string
  name: string
  content: string
}

export function AgentWorkspaceInspector({ workspaceId, onClose }: Props) {
  const { t: translate, i18n } = useTranslation()
  const locale = i18n.resolvedLanguage || i18n.language
  const [workspace, setWorkspace] = useState<Workspace | null>(null)
  const [selectedFile, setSelectedFile] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [editingTask, setEditingTask] = useState<Task | null>(null)
  const [showTaskEditor, setShowTaskEditor] = useState(false)
  const [tasks, setTasks] = useState<Task[]>([])

  const { workspaces } = useAgentStore()
  const { createTask, updateTask, deleteTask, toggleTask } = useTaskStore()

  const loadTasks = useCallback(async () => {
    try {
      const list = await window.api.listTasks?.({ workspaceId }) || []
      setTasks(list)
    } catch {
      setTasks([])
    }
  }, [workspaceId])

  const loadWorkspace = useCallback(() => {
    setLoading(true)
    window.api.getAgentWorkspace?.(workspaceId)
      .then((ws: Workspace | null) => {
        setWorkspace(ws)
        if (ws?.agentMd) setSelectedFile(current => current || 'agent.md')
        setLoading(false)
      })
      .catch(() => setLoading(false))
  }, [workspaceId])

  useEffect(() => {
    setSelectedFile(null)
    loadWorkspace()
    loadTasks()
  }, [workspaceId, loadWorkspace, loadTasks])

  const fileNodes: FileNode[] = workspace ? [
    ...(workspace.agentMd ? [{
      kind: 'agent-md' as const,
      path: 'agent.md',
      name: 'agent.md',
      content: workspace.agentMd
    }] : []),
    ...(workspace.meMd ? [{
      kind: 'me-md' as const,
      path: 'me.md',
      name: 'me.md',
      content: workspace.meMd
    }] : []),
    ...workspace.memories.map(m => ({
      kind: 'memory' as const,
      path: `memory/${m.name}.md`,
      name: `${m.name}.md`,
      content: m.content
    })),
    ...(workspace.skills || []).map(s => ({
      kind: 'skill' as const,
      path: `skills/${s.name}/SKILL.md`,
      name: `${s.name}`,
      content: s.content
    })),
    ...(workspace.toolsConfig ? [{
      kind: 'tools' as const,
      path: 'tools/config.json',
      name: 'config.json',
      content: JSON.stringify(workspace.toolsConfig, null, 2)
    }] : []),
    ...tasks.map(task => ({
      kind: 'task' as const,
      path: `tasks/${task.id}`,
      name: task.name,
      content: `**${task.name}**\n\n${task.enabled
        ? translate('agentWorkspace.task.enabled')
        : translate('agentWorkspace.task.disabled')} · ${task.conversationMode === 'persistent'
        ? translate('agentWorkspace.task.persistent')
        : translate('agentWorkspace.task.perRun')}\n\n**${translate('agentWorkspace.task.prompt')}:**\n${task.prompt}${task.lastResult
        ? `\n\n**${translate('agentWorkspace.task.lastRun')}:** ${translate(`agentWorkspace.task.result.${task.lastResult.status}`)} — ${formatLocaleDateTime(task.lastResult.timestamp, locale)}`
        : ''}`
    }))
  ] : []

  const handleRevealInFinder = useCallback(async () => {
    if (!workspace?.dir) return
    const target = workspace.agentMd ? `${workspace.dir}/agent.md` : workspace.dir
    await window.api.revealFile?.(target)
  }, [workspace])

  const handleSaveTask = async (data: Omit<Task, 'id' | 'createdAt' | 'updatedAt'>): Promise<void> => {
    if (editingTask) {
      await updateTask(editingTask.id, data)
    } else {
      await createTask(data)
    }
    setShowTaskEditor(false)
    setEditingTask(null)
    await loadTasks()
  }

  const handleDeleteTask = async (): Promise<void> => {
    if (!editingTask) return
    await deleteTask(editingTask.id)
    setShowTaskEditor(false)
    setEditingTask(null)
    await loadTasks()
  }

  const handleToggleTask = async (task: Task): Promise<void> => {
    await toggleTask(task.id, !task.enabled)
    await loadTasks()
  }

  if (loading) {
    return (
      <div className="h-full flex items-center justify-center text-[12px] text-surface-400">
        {translate('agentWorkspace.loading')}
      </div>
    )
  }

  if (!workspace) {
    return (
      <div className="h-full flex items-center justify-center text-[12px] text-surface-400">
        {translate('agentWorkspace.loadError')}
      </div>
    )
  }

  const selectedNode = fileNodes.find(f => f.path === selectedFile)

  return (
    <div className="h-full flex flex-col bg-surface-0 dark:bg-surface-50 border-r border-surface-100">
      {/* 头部：标题 + Finder 按钮 + 关闭按钮 */}
      <div className="shrink-0 flex items-center gap-2 px-3 py-2.5 border-b border-surface-100">
        <span className="text-base">{workspace.meta.icon}</span>
        <div className="flex-1 min-w-0">
          <p className="text-[12px] font-semibold text-surface-700 truncate">
            {workspace.meta.name}
          </p>
          <p className="text-[10px] text-surface-300 font-mono truncate" title={workspace.dir}>
            {workspace.dir?.replace(/^.*\/agents\//, 'agents/') || ''}
          </p>
        </div>
        {workspace.dir && (
          <button
            onClick={handleRevealInFinder}
            className="p-1.5 rounded hover:bg-surface-100 transition-colors"
            title={translate('agentWorkspace.actions.revealInFinder')}
          >
            <ExternalLink className="w-3.5 h-3.5 text-surface-400" />
          </button>
        )}
        {onClose && (
          <button
            onClick={onClose}
            className="p-1.5 rounded hover:bg-surface-100 transition-colors"
            title={translate('agentWorkspace.actions.close')}
          >
            <X className="w-3.5 h-3.5 text-surface-400" />
          </button>
        )}
      </div>

      {/* 文件树 */}
      <div className="shrink-0 border-b border-surface-100 py-1 max-h-64 overflow-y-auto">
        {fileNodes.length === 0 ? (
          <p className="px-3 py-2 text-[11px] text-surface-300">{translate('agentWorkspace.empty.workspace')}</p>
        ) : (
          <>
            {fileNodes.filter(f => f.kind === 'agent-md').map(f => (
              <FileTreeItem key={f.path} node={f} selected={selectedFile === f.path} onClick={() => setSelectedFile(f.path)} />
            ))}
            {fileNodes.filter(f => f.kind === 'me-md').map(f => (
              <FileTreeItem key={f.path} node={f} selected={selectedFile === f.path} onClick={() => setSelectedFile(f.path)} />
            ))}
            {fileNodes.some(f => f.kind === 'memory') && (
              <div className="mt-1">
                <div className="px-3 py-1 flex items-center gap-1.5 text-[10px] text-surface-300 font-medium uppercase tracking-wider">
                  <Brain className="w-3 h-3" />
                  memory/
                </div>
                {fileNodes.filter(f => f.kind === 'memory').map(f => (
                  <FileTreeItem key={f.path} node={f} selected={selectedFile === f.path} onClick={() => setSelectedFile(f.path)} indent />
                ))}
              </div>
            )}
            {fileNodes.some(f => f.kind === 'skill') && (
              <div className="mt-1">
                <div className="px-3 py-1 flex items-center gap-1.5 text-[10px] text-surface-300 font-medium uppercase tracking-wider">
                  <Zap className="w-3 h-3" />
                  skills/
                </div>
                {fileNodes.filter(f => f.kind === 'skill').map(f => (
                  <FileTreeItem key={f.path} node={f} selected={selectedFile === f.path} onClick={() => setSelectedFile(f.path)} indent />
                ))}
              </div>
            )}
            {fileNodes.some(f => f.kind === 'tools') && (
              <div className="mt-1">
                <div className="px-3 py-1 flex items-center gap-1.5 text-[10px] text-surface-300 font-medium uppercase tracking-wider">
                  <Wrench className="w-3 h-3" />
                  tools/
                </div>
                {fileNodes.filter(f => f.kind === 'tools').map(f => (
                  <FileTreeItem key={f.path} node={f} selected={selectedFile === f.path} onClick={() => setSelectedFile(f.path)} indent />
                ))}
              </div>
            )}
            {/* Tasks section */}
            <div className="mt-1">
              <div className="px-3 py-1 flex items-center gap-1.5 text-[10px] text-surface-300 font-medium uppercase tracking-wider">
                <Clock className="w-3 h-3" />
                <span className="flex-1">tasks/</span>
                <button
                  onClick={() => { setEditingTask(null); setShowTaskEditor(true) }}
                  className="p-0.5 rounded hover:bg-surface-100 transition-colors"
                  title={translate('agentWorkspace.actions.addTask')}
                >
                  <Plus className="w-3 h-3" />
                </button>
              </div>
              {tasks.map(task => (
                <div
                  key={task.id}
                  className={`w-full flex items-center text-[11px] transition-colors ${
                    selectedFile === `tasks/${task.id}`
                      ? 'bg-brand-50 dark:bg-brand-900/20 text-brand-600 dark:text-brand-400'
                      : 'text-surface-500 hover:bg-surface-50'
                  }`}
                >
                  <button
                    onClick={() => setSelectedFile(`tasks/${task.id}`)}
                    onDoubleClick={() => { setEditingTask(task); setShowTaskEditor(true) }}
                    className="min-w-0 flex-1 flex items-center gap-1.5 px-3 py-1.5 pl-6 text-left"
                  >
                    <Clock className="w-3 h-3 shrink-0 opacity-60" />
                    <span className="truncate font-mono flex-1">{task.name}</span>
                  </button>
                  <button
                    onClick={(e) => { e.stopPropagation(); handleToggleTask(task) }}
                    className={`shrink-0 w-6 h-3.5 mr-3 rounded-full transition-colors relative ${task.enabled ? 'bg-brand-400' : 'bg-surface-200'}`}
                    title={task.enabled ? translate('agentWorkspace.actions.disableTask') : translate('agentWorkspace.actions.enableTask')}
                    aria-pressed={task.enabled}
                  >
                    <span className={`absolute top-0.5 w-2.5 h-2.5 rounded-full bg-white transition-transform ${task.enabled ? 'left-3' : 'left-0.5'}`} />
                  </button>
                </div>
              ))}
              {tasks.length === 0 && (
                <p className="pl-6 py-1 text-[10px] text-surface-300 italic">{translate('agentWorkspace.empty.tasks')}</p>
              )}
            </div>
          </>
        )}
      </div>

      {/* 文件内容预览 — 占据剩余空间 */}
      <div className="flex-1 min-h-0 overflow-y-auto p-3">
        {selectedNode ? (
          <>
            <div className="flex items-center gap-1.5 mb-2 pb-2 border-b border-surface-100">
              {selectedNode.kind === 'task' ? <Clock className="w-3 h-3 text-surface-400" /> : <FileText className="w-3 h-3 text-surface-400" />}
              <span className="text-[11px] font-mono text-surface-500 flex-1 min-w-0 break-all">{selectedNode.kind === 'task' ? selectedNode.name : selectedNode.path}</span>
              {selectedNode.kind === 'task' && (
                <button
                  onClick={() => {
                    const t = tasks.find(tr => `tasks/${tr.id}` === selectedFile)
                    if (t) { setEditingTask(t); setShowTaskEditor(true) }
                  }}
                  className="text-[10px] text-brand-500 hover:text-brand-600 transition-colors"
                >
                  {translate('agentWorkspace.actions.edit')}
                </button>
              )}
            </div>
            <div className="prose-light text-[12px] [&_h1]:text-[14px] [&_h2]:text-[13px] [&_h3]:text-[12px] [&_p]:text-[12px]">
              <Markdown content={selectedNode.content} />
            </div>
          </>
        ) : (
          <p className="text-[11px] text-surface-300 text-center py-8">
            {translate('agentWorkspace.empty.selectFile')}
          </p>
        )}
      </div>
      {/* Task Editor Modal */}
      {showTaskEditor && (
        <TaskEditor
          task={editingTask || undefined}
          lockedWorkspaceId={workspaceId}
          workspaces={workspaces}
          onSave={handleSaveTask}
          onCancel={() => { setShowTaskEditor(false); setEditingTask(null) }}
          onDelete={editingTask ? handleDeleteTask : undefined}
        />
      )}
    </div>
  )
}

function FileTreeItem({ node, selected, onClick, indent }: {
  node: FileNode
  selected: boolean
  onClick: () => void
  indent?: boolean
}) {
  return (
    <button
      onClick={onClick}
      className={`w-full flex items-center gap-1.5 px-3 py-1.5 text-[11px] transition-colors text-left ${
        indent ? 'pl-6' : ''
      } ${
        selected
          ? 'bg-brand-50 dark:bg-brand-900/20 text-brand-600 dark:text-brand-400'
          : 'text-surface-500 hover:bg-surface-50'
      }`}
    >
      <FileText className="w-3 h-3 shrink-0 opacity-60" />
      <span className="truncate font-mono">{node.name}</span>
    </button>
  )
}

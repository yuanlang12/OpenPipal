import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { ListChecks, Clock, CircleCheck, CircleX, CircleAlert } from 'lucide-react'
import { useTaskStore } from '../../../stores/taskStore'
import { useChatStore } from '../../../stores/chatStore'
import { useWorkspaceStore } from '../../../stores/workspaceStore'

/**
 * 任务区块 — 只读快捷列表，不做 CRUD（完整管理走 activeView='tasks' 视图）。
 * 过滤：workspace 上下文 → 只显示该 agent 的任务；全局 → 显示所有全局任务。
 */
export function TasksSection() {
  const { t } = useTranslation()
  const workspaceId = useChatStore(s => s.activeWorkspaceId)
  const tasks = useTaskStore(s => s.tasks)
  const loadTasks = useTaskStore(s => s.loadTasks)

  useEffect(() => {
    loadTasks(workspaceId ? { workspaceId } : undefined)
  }, [workspaceId, loadTasks])

  const filtered = workspaceId
    ? tasks.filter((t: any) => t.workspaceId === workspaceId)
    : tasks.filter((t: any) => !t.workspaceId)

  if (filtered.length === 0) {
    return <div className="text-sw-sm text-surface-400 px-3 py-2 leading-relaxed">{t('shell.workspace.sectionEmpty.tasks')}<br /><span className="opacity-70">{t('shell.workspace.sectionEmpty.tasksHint')}</span></div>
  }

  return (
    <div className="py-0.5">
      {filtered.map((task: any) => {
        const resultStatus = task.lastResult?.status
        const StatusIcon = resultStatus === 'success' ? CircleCheck : resultStatus === 'error' ? CircleX : task.enabled ? Clock : CircleAlert
        const statusColor = resultStatus === 'success' ? 'text-emerald-500' : resultStatus === 'error' ? 'text-rose-500' : task.enabled ? 'text-brand-500' : 'text-surface-400'
        return (
          <button
            key={task.id}
            onClick={() => useWorkspaceStore.getState().openTab({
              kind: 'task',
              title: task.name || '',
              ...(!task.name ? { titleKey: 'shell.workspace.fallback.untitledTask' } : {}),
              taskId: task.id
            })}
            className="w-full flex items-center gap-2 px-3 py-1.5 text-left text-sw-base text-surface-700 hover:bg-surface-100 dark:hover:bg-surface-100/50 transition-colors group"
            title={task.name || t('shell.workspace.fallback.untitledTask')}
          >
            <StatusIcon size={13} className={`shrink-0 ${statusColor}`} />
            <span className="truncate flex-1">{task.name || t('shell.workspace.fallback.untitledTask')}</span>
            <ListChecks size={11} className="shrink-0 text-surface-400 opacity-60" />
          </button>
        )
      })}
    </div>
  )
}

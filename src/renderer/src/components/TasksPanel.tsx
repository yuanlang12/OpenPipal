/**
 * TasksPanel — 主导航的"任务"面板
 *
 * 展示所有任务（全局 + workspace），统一入口创建/编辑。
 * 取代旧的 ScheduledTasksPanel。
 */

import { useEffect, useMemo, useState } from 'react'
import { Plus, Clock, Play, Pause, Edit2, Trash2, CheckCircle, AlertCircle, Moon, Zap } from 'lucide-react'
import type { Task } from '../types'
import { useTaskStore } from '../stores/taskStore'
import { useAgentStore } from '../stores/agentStore'
import { TaskEditor } from './TaskEditor'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import { formatLocaleDate, getCalendarTimeParts } from '../i18n/formatters'

const WEEKDAY_KEYS: Record<string, string> = {
  mon: 'tasks.weekdays.mon',
  tue: 'tasks.weekdays.tue',
  wed: 'tasks.weekdays.wed',
  thu: 'tasks.weekdays.thu',
  fri: 'tasks.weekdays.fri',
  sat: 'tasks.weekdays.sat',
  sun: 'tasks.weekdays.sun',
}
const WORKDAY_IDS = ['mon', 'tue', 'wed', 'thu', 'fri'] as const

export function isExactWorkdaySet(days: readonly unknown[]): boolean {
  const normalized = new Set(days.flatMap(day => (
    typeof day === 'string' ? [day.toLowerCase()] : []
  )))
  return normalized.size === WORKDAY_IDS.length && WORKDAY_IDS.every(day => normalized.has(day))
}

export function taskTriggerLabel(task: Task, t: TFunction, locale: string): string {
  if (task.trigger.type === 'webhook') return t('tasks.trigger.webhook')
  if (task.trigger.type === 'gate') return t('tasks.trigger.gate')
  const s = task.trigger.schedule
  if (s.type === 'fixed') {
    const days: readonly unknown[] = Array.isArray(s.days) ? s.days : []
    if (days.length === 0) return t('tasks.trigger.dailyAt', { time: s.time })
    if (isExactWorkdaySet(days)) return t('tasks.trigger.weekdaysAt', { time: s.time })
    const labels = days.flatMap(day => {
      if (typeof day !== 'string') return []
      const key = WEEKDAY_KEYS[day.toLowerCase()]
      return [key ? t(key) : day]
    }).join('/')
    return t('tasks.trigger.selectedDaysAt', { days: labels, time: s.time })
  }
  if (s.type === 'interval') {
    const minutes = new Intl.NumberFormat(locale).format(Math.round((s.intervalMs || 60000) / 60000))
    return t('tasks.trigger.intervalMinutes', { minutes })
  }
  return t('tasks.trigger.cron', { cron: s.cron })
}

function statusBadge(task: Task, t: TFunction): JSX.Element | null {
  if (!task.lastResult) return null
  if (task.lastResult.status === 'success') {
    return <CheckCircle role="img" aria-label={t('tasks.status.success')} className="w-3 h-3 text-green-500" />
  }
  return <AlertCircle role="img" aria-label={t('tasks.status.error')} className="w-3 h-3 text-red-400" />
}

export function TasksPanel() {
  const { t: translate, i18n } = useTranslation()
  const locale = i18n.resolvedLanguage || i18n.language
  const { tasks, loading, loadTasks, createTask, updateTask, deleteTask, toggleTask, triggerNow, patchTask } = useTaskStore()
  const { workspaces, templates, loadWorkspaces, loadTemplates } = useAgentStore()

  const [editing, setEditing] = useState<Task | null>(null)
  const [showCreate, setShowCreate] = useState(false)
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)
  const [expandedLogId, setExpandedLogId] = useState<string | null>(null)
  const [triggeringId, setTriggeringId] = useState<string | null>(null)

  const handleTrigger = async (id: string): Promise<void> => {
    if (triggeringId) return
    setTriggeringId(id)
    const result = await triggerNow(id)
    setTimeout(() => setTriggeringId(null), 1500)
    if (!result.ok && result.error) {
      console.warn(`[Task] 立即触发: ${result.error}`)
    }
  }

  const formatAuditTime = (ts: number): string => {
    const parts = getCalendarTimeParts(ts, locale)
    if (parts.kind === 'today') return parts.time
    if (parts.kind === 'yesterday') return translate('tasks.time.yesterday', { time: parts.time })
    return parts.dateTime
  }

  useEffect(() => {
    loadTasks()
    loadWorkspaces()
    loadTemplates()

    // 订阅任务执行事件，实时更新 UI
    if (!window.api?.onTaskExecuted) return
    const unsub = window.api.onTaskExecuted((taskId: string, result: any, silent?: boolean) => {
      if (silent) {
        // 静默触发：silentLog 变了，全量刷新
        loadTasks()
      } else {
        patchTask(taskId, { lastResult: result, lastRun: result.timestamp })
      }
    })
    return unsub
  }, [])

  const workspaceNameMap = useMemo(() => {
    const m = new Map<string, string>()
    for (const w of workspaces) m.set(w.id, w.name)
    return m
  }, [workspaces])

  const agentNameMap = useMemo(() => {
    const m = new Map<string, string>()
    for (const a of templates) m.set(a.id, a.name)
    return m
  }, [templates])

  const scopeLabel = (t: Task): string => {
    if (t.workspaceId) return `🤖 ${workspaceNameMap.get(t.workspaceId) || t.workspaceId.slice(0,8)}`
    if (t.agentId) return `📋 ${agentNameMap.get(t.agentId) || t.agentId.slice(0,8)}`
    return `🌐 ${translate('tasks.scope.global')}`
  }

  const handleCreate = async (data: Omit<Task, 'id' | 'createdAt' | 'updatedAt'>): Promise<void> => {
    await createTask(data)
    setShowCreate(false)
  }

  const handleUpdate = async (data: Omit<Task, 'id' | 'createdAt' | 'updatedAt'>): Promise<void> => {
    if (!editing) return
    await updateTask(editing.id, data)
    setEditing(null)
  }

  const handleDelete = async (id: string): Promise<void> => {
    await deleteTask(id)
    setEditing(null)
    setConfirmDeleteId(null)
  }

  return (
    <div className="h-full flex flex-col bg-surface-0 dark:bg-surface-50">
      {/* 头部 */}
      <div className="shrink-0 flex items-center gap-2 px-5 py-4 border-b border-surface-100">
        <Clock className="w-5 h-5 text-brand-500" />
        <h1 className="flex-1 text-[16px] font-semibold text-surface-700">{translate('tasks.title')}</h1>
        <button
          onClick={() => setShowCreate(true)}
          className="flex items-center gap-1.5 px-3 py-1.5 text-[12px] font-medium rounded-md bg-brand-500 text-ink-on-accent hover:bg-brand-600 transition-colors"
        >
          <Plus className="w-3.5 h-3.5" /> {translate('tasks.actions.create')}
        </button>
      </div>

      {/* 列表 */}
      <div className="flex-1 min-h-0 overflow-y-auto p-5">
        {loading ? (
          <div className="text-center py-20 text-[13px] text-surface-400">{translate('tasks.loading')}</div>
        ) : tasks.length === 0 ? (
          <div className="text-center py-20">
            <Clock className="w-12 h-12 mx-auto text-surface-200 mb-3" />
            <p className="text-[13px] text-surface-400 mb-4">{translate('tasks.empty.title')}</p>
            <button
              onClick={() => setShowCreate(true)}
              className="px-4 py-2 text-[12px] rounded-md bg-brand-500 text-ink-on-accent hover:bg-brand-600 transition-colors"
            >
              {translate('tasks.empty.action')}
            </button>
          </div>
        ) : (
          <div className="space-y-2">
            {tasks.map(t => (
              <div key={t.id}>
              <div
                className="group flex items-center gap-3 p-3 rounded-lg border border-surface-100 hover:border-brand-200 dark:hover:border-brand-700 transition-colors"
              >
                <button
                  onClick={() => toggleTask(t.id, !t.enabled)}
                  className={`shrink-0 p-1.5 rounded-full transition-colors ${
                    t.enabled
                      ? 'bg-brand-50 dark:bg-brand-900/20 text-brand-500 hover:bg-brand-100'
                      : 'bg-surface-100 text-surface-400 hover:bg-surface-200'
                  }`}
                  title={t.enabled ? translate('tasks.actions.pause') : translate('tasks.actions.enable')}
                  aria-pressed={t.enabled}
                >
                  {t.enabled ? <Play className="w-3.5 h-3.5 fill-current" /> : <Pause className="w-3.5 h-3.5 fill-current" />}
                </button>

                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <p className="text-[13px] font-medium text-surface-700 truncate">
                      {t.name}
                    </p>
                    {statusBadge(t, translate)}
                    {t.silentLog && t.silentLog.length > 0 && (
                      <button
                        onClick={(e) => {
                          e.stopPropagation()
                          setExpandedLogId(prev => prev === t.id ? null : t.id)
                        }}
                        title={translate('tasks.silent.historyTitle', {
                          count: t.silentLog.length,
                          action: expandedLogId === t.id
                            ? translate('tasks.silent.collapse')
                            : translate('tasks.silent.viewHistory'),
                        })}
                        className={`inline-flex items-center gap-0.5 text-[10px] px-1.5 py-0.5 rounded-full transition-colors ${
                          expandedLogId === t.id
                            ? 'bg-indigo-100 dark:bg-indigo-900/40 text-indigo-700 dark:text-indigo-300'
                            : 'bg-indigo-50 dark:bg-indigo-900/20 text-indigo-500 hover:bg-indigo-100'
                        }`}
                      >
                        <Moon className="w-2.5 h-2.5" /> {t.silentLog.length}
                      </button>
                    )}
                  </div>
                  <div className="flex items-center gap-x-3 gap-y-0.5 mt-0.5 text-[11px] text-surface-400 flex-wrap">
                    <span>{scopeLabel(t)}</span>
                    <span>•</span>
                    <span>{taskTriggerLabel(t, translate, locale)}</span>
                    {t.nextRun && t.enabled && (
                      <>
                        <span>•</span>
                        <span>{translate('tasks.nextRun', {
                          date: formatLocaleDate(t.nextRun, locale, {
                            month: 'short',
                            day: 'numeric',
                            hour: '2-digit',
                            minute: '2-digit',
                          }),
                        })}</span>
                      </>
                    )}
                  </div>
                </div>

                <div className="shrink-0 flex items-center gap-1 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 transition-opacity">
                  <button
                    onClick={() => handleTrigger(t.id)}
                    disabled={!t.enabled || triggeringId === t.id}
                    className="p-1.5 rounded hover:bg-amber-50 dark:hover:bg-amber-900/20 text-surface-400 hover:text-amber-500 disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent disabled:hover:text-surface-400"
                    title={!t.enabled
                      ? translate('tasks.actions.disabled')
                      : triggeringId === t.id
                        ? translate('tasks.actions.running')
                        : translate('tasks.actions.runNow')}
                  >
                    <Zap className={`w-3.5 h-3.5 ${triggeringId === t.id ? 'fill-current animate-pulse' : ''}`} />
                  </button>
                  <button
                    onClick={() => setEditing(t)}
                    className="p-1.5 rounded hover:bg-surface-100 text-surface-400 hover:text-brand-500"
                    title={translate('tasks.actions.edit')}
                  >
                    <Edit2 className="w-3.5 h-3.5" />
                  </button>
                  {confirmDeleteId === t.id ? (
                    <button
                      onClick={() => handleDelete(t.id)}
                      className="px-2 py-1 rounded bg-red-50 text-red-500 text-[10px] font-medium"
                    >
                      {translate('tasks.actions.confirmDelete')}
                    </button>
                  ) : (
                    <button
                      onClick={() => setConfirmDeleteId(t.id)}
                      className="p-1.5 rounded hover:bg-surface-100 text-surface-400 hover:text-red-400"
                      title={translate('tasks.actions.delete')}
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  )}
                </div>
              </div>
              {/* 静默审计日志展开面板 */}
              {expandedLogId === t.id && t.silentLog && t.silentLog.length > 0 && (
                <div className="mt-1 ml-10 border border-indigo-100 dark:border-indigo-900/40 rounded-md bg-indigo-50/40 dark:bg-indigo-900/10 overflow-hidden">
                  <div className="px-3 py-1.5 text-[10px] text-indigo-600 dark:text-indigo-400 uppercase tracking-wider flex items-start gap-1.5 border-b border-indigo-100 dark:border-indigo-900/40">
                    <Moon className="w-3 h-3" />
                    <span className="min-w-0 break-words">
                      {translate('tasks.silent.header', { count: t.silentLog.length })}
                    </span>
                  </div>
                  <div className="max-h-48 overflow-y-auto">
                    {[...t.silentLog].reverse().map((entry, i) => (
                      <div key={i} className="flex items-start gap-2 px-3 py-1.5 text-[11px] hover:bg-indigo-100/40 dark:hover:bg-indigo-900/20 border-t border-indigo-50 dark:border-indigo-900/20 first:border-t-0">
                        <span className="shrink-0 font-mono text-indigo-400 dark:text-indigo-500">{formatAuditTime(entry.timestamp)}</span>
                        {entry.source && (
                          <span className="shrink-0 text-indigo-500 dark:text-indigo-400 font-medium">[{entry.source}]</span>
                        )}
                        <span className="min-w-0 text-surface-600 break-words" title={entry.reason}>{entry.reason}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* 创建/编辑 Modal */}
      {showCreate && (
        <TaskEditor
          workspaces={workspaces}
          agents={templates}
          onSave={handleCreate}
          onCancel={() => setShowCreate(false)}
        />
      )}
      {editing && (
        <TaskEditor
          task={editing}
          workspaces={workspaces}
          agents={templates}
          onSave={handleUpdate}
          onCancel={() => setEditing(null)}
          onDelete={() => handleDelete(editing.id)}
        />
      )}
    </div>
  )
}

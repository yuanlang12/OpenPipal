/**
 * TaskEditor — Codex 风格的任务编辑器
 *
 * 设计：
 * - 顶部：标题输入 + "使用模板" 按钮
 * - 主区：prompt textarea（占主要空间）
 * - 底部：pill 按钮（作用域 / 时间 / 会话模式）
 *
 * 支持创建/编辑全局任务或 workspace 任务。
 */

import { useState } from 'react'
import type { TFunction } from 'i18next'
import { X, FolderOpen, Clock, MessageSquare, BookOpen, Webhook, Copy, Check, Moon } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { Task, TaskTrigger, ScheduleConfig } from '../types'
import type { WorkspaceSummary, AgentTemplateSummary } from '../stores/agentStore'
import { TaskTemplates } from './TaskTemplates'

interface Props {
  task?: Task
  /** 预填：workspace 内创建任务时锁死 workspaceId */
  lockedWorkspaceId?: string
  /** 可选的 workspace 列表（用于全局模式下切换作用域） */
  workspaces?: WorkspaceSummary[]
  /** 可选的 agent 模板列表 */
  agents?: AgentTemplateSummary[]
  onSave: (data: Omit<Task, 'id' | 'createdAt' | 'updatedAt'>) => void
  onCancel: () => void
  onDelete?: () => void
}

type ScheduleMode = 'daily' | 'weekdays' | 'weekly' | 'interval' | 'cron'

const WEEKDAY_KEYS: Record<string, string> = {
  mon: 'tasks.weekdays.mon',
  tue: 'tasks.weekdays.tue',
  wed: 'tasks.weekdays.wed',
  thu: 'tasks.weekdays.thu',
  fri: 'tasks.weekdays.fri',
  sat: 'tasks.weekdays.sat',
  sun: 'tasks.weekdays.sun',
}

const SCHEDULE_MODE_KEYS: Record<ScheduleMode, string> = {
  daily: 'tasks.editor.schedule.modes.daily',
  weekdays: 'tasks.editor.schedule.modes.weekdays',
  weekly: 'tasks.editor.schedule.modes.weekly',
  interval: 'tasks.editor.schedule.modes.interval',
  cron: 'tasks.editor.schedule.modes.cron',
}

function translatedWeekday(day: string, t: TFunction): string {
  const key = WEEKDAY_KEYS[day]
  return key ? t(key) : day
}

function scheduleFromConfig(cfg?: ScheduleConfig): ScheduleMode {
  if (!cfg) return 'daily'
  if (cfg.type === 'cron') return 'cron'
  if (cfg.type === 'interval') return 'interval'
  // fixed
  const days = cfg.days || []
  if (days.length === 0) return 'daily'
  if (days.length === 5 && ['mon','tue','wed','thu','fri'].every(d => days.includes(d))) return 'weekdays'
  return 'weekly'
}

type TriggerKind = 'schedule' | 'webhook'

export function TaskEditor({ task, lockedWorkspaceId, workspaces = [], agents = [], onSave, onCancel, onDelete }: Props) {
  const { t } = useTranslation()
  const existingSchedule = task?.trigger.type === 'schedule' ? task.trigger.schedule : undefined
  const existingWebhookSecret = task?.trigger.type === 'webhook' ? task.trigger.secret : undefined

  const [name, setName] = useState(task?.name || '')
  const [prompt, setPrompt] = useState(task?.prompt || '')
  const [workspaceId, setWorkspaceId] = useState<string | undefined>(lockedWorkspaceId || task?.workspaceId)
  const [agentId, setAgentId] = useState<string | undefined>(task?.agentId)
  const [convMode, setConvMode] = useState<'persistent' | 'per-run'>(task?.conversationMode || 'per-run')

  const [triggerKind, setTriggerKind] = useState<TriggerKind>(task?.trigger.type === 'webhook' ? 'webhook' : 'schedule')
  const [scheduleMode, setScheduleMode] = useState<ScheduleMode>(scheduleFromConfig(existingSchedule))
  const [time, setTime] = useState(existingSchedule?.time || '09:00')
  const [weekday, setWeekday] = useState(existingSchedule?.days?.[0] || 'mon')
  const [intervalMin, setIntervalMin] = useState(existingSchedule?.intervalMs ? Math.round(existingSchedule.intervalMs / 60000) : 30)
  const [cron, setCron] = useState(existingSchedule?.cron || '0 9 * * *')
  const [webhookSecret, setWebhookSecret] = useState(existingWebhookSecret || '')
  const [copiedWebhook, setCopiedWebhook] = useState(false)
  // 智能免打扰：undefined/true = 开启，false = 关闭
  const [smartSilence, setSmartSilence] = useState<boolean>(task?.smartSilence !== false)

  const [showScopeMenu, setShowScopeMenu] = useState(false)
  const [showScheduleMenu, setShowScheduleMenu] = useState(false)
  const [showConvMenu, setShowConvMenu] = useState(false)
  const [showTemplates, setShowTemplates] = useState(false)

  const buildTrigger = (): TaskTrigger => {
    if (triggerKind === 'webhook') {
      return { type: 'webhook', secret: webhookSecret.trim() || undefined }
    }
    const schedule: ScheduleConfig = scheduleMode === 'cron'
      ? { type: 'cron', cron }
      : scheduleMode === 'interval'
      ? { type: 'interval', intervalMs: intervalMin * 60000 }
      : scheduleMode === 'daily'
      ? { type: 'fixed', time }
      : scheduleMode === 'weekdays'
      ? { type: 'fixed', time, days: ['mon','tue','wed','thu','fri'] }
      : { type: 'fixed', time, days: [weekday] }
    return { type: 'schedule', schedule }
  }

  const webhookUrl = task?.id ? `http://localhost:3031/webhook/task/${task.id}` : ''

  const copyWebhookCurl = async (): Promise<void> => {
    if (!webhookUrl || !webhookSecret.trim()) return
    const curl = `curl -X POST -H 'X-OpenPipal-Secret: ${webhookSecret.trim()}' '${webhookUrl}'`
    await navigator.clipboard.writeText(curl)
    setCopiedWebhook(true)
    setTimeout(() => setCopiedWebhook(false), 2000)
  }

  const handleSave = (): void => {
    if (!name.trim() || !prompt.trim()) return
    if (triggerKind === 'webhook' && !webhookSecret.trim()) return
    onSave({
      name: name.trim(),
      enabled: task?.enabled ?? true,
      workspaceId: workspaceId || undefined,
      agentId: workspaceId ? undefined : agentId,
      trigger: buildTrigger(),
      prompt: prompt.trim(),
      conversationMode: convMode,
      smartSilence,  // 开启时存 true、关闭时存 false（都显式写入）
      boundConversationId: task?.boundConversationId,
      silentLog: task?.silentLog,
      lastRun: task?.lastRun,
      lastResult: task?.lastResult,
      nextRun: undefined
    })
  }

  const scheduleLabel = (): string => {
    switch (scheduleMode) {
      case 'daily': return t('tasks.trigger.dailyAt', { time })
      case 'weekdays': return t('tasks.trigger.weekdaysAt', { time })
      case 'weekly': return t('tasks.editor.schedule.weeklyAt', {
        day: translatedWeekday(weekday, t),
        time,
      })
      case 'interval': return t('tasks.trigger.intervalMinutes', { minutes: intervalMin })
      case 'cron': return t('tasks.trigger.cron', { cron })
    }
  }

  const scopeLabel = (): string => {
    if (lockedWorkspaceId) {
      const ws = workspaces.find(w => w.id === lockedWorkspaceId)
      return ws ? `${ws.icon || '🤖'} ${ws.name}` : t('tasks.editor.scope.currentAgent')
    }
    if (workspaceId) {
      const ws = workspaces.find(w => w.id === workspaceId)
      return ws ? `${ws.icon || '🤖'} ${ws.name}` : 'Workspace'
    }
    if (agentId) {
      const a = agents.find(x => x.id === agentId)
      return a ? `${a.icon || '🤖'} ${a.name}` : t('tasks.editor.scope.agentTemplate')
    }
    return t('tasks.editor.scope.selectAgent')
  }

  const convModeLabel = (): string =>
    convMode === 'persistent'
      ? t('tasks.editor.conversation.persistentShort')
      : t('tasks.editor.conversation.perRunShort')

  const applyTemplate = (tpl: { name: string; prompt: string }): void => {
    setName(tpl.name)
    setPrompt(tpl.prompt)
    setShowTemplates(false)
  }

  const canSave = name.trim() && prompt.trim() && (triggerKind !== 'webhook' || webhookSecret.trim())

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={onCancel}>
      <div
        className="relative bg-surface-0 dark:bg-surface-50 rounded-2xl shadow-2xl w-[640px] max-h-[85vh] flex flex-col overflow-hidden"
        onClick={e => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={task ? t('tasks.editor.editTitle') : t('tasks.editor.createTitle')}
      >
        {/* 顶部：标题 + 模板入口 + 关闭 */}
        <div className="shrink-0 px-5 pt-5 pb-3 flex items-center gap-2">
          <input
            value={name}
            onChange={e => setName(e.target.value)}
            placeholder={t('tasks.editor.namePlaceholder')}
            className="flex-1 text-[18px] font-semibold bg-transparent border-none outline-none text-surface-700 placeholder:text-surface-300"
          />
          <button
            onClick={() => setShowTemplates(true)}
            className="flex items-center gap-1.5 px-3 py-1.5 text-[12px] rounded-full border border-surface-200 text-surface-500 hover:border-brand-400 hover:text-brand-600 transition-colors"
          >
            <BookOpen className="w-3.5 h-3.5" /> {t('tasks.editor.useTemplate')}
          </button>
          <button
            onClick={onCancel}
            className="p-1.5 rounded-full hover:bg-surface-100 text-surface-400"
            aria-label={t('common.actions.close')}
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* 主区：prompt textarea */}
        <div className="flex-1 min-h-0 px-5 py-2 overflow-y-auto">
          <textarea
            value={prompt}
            onChange={e => setPrompt(e.target.value)}
            placeholder={t('tasks.editor.promptPlaceholder')}
            className="w-full h-[280px] resize-none bg-transparent border-none outline-none text-[14px] text-surface-600 placeholder:text-surface-300 leading-relaxed"
          />
        </div>

        {/* 底部：pills + 操作 */}
        <div className="shrink-0 border-t border-surface-100 px-5 py-3">
          <div className="flex items-center justify-between gap-2">
            {/* pills */}
            <div className="flex items-center gap-2 flex-1 min-w-0 flex-wrap">
              {/* 作用域 pill */}
              {!lockedWorkspaceId && (
                <div className="relative">
                  <button
                    onClick={() => { setShowScopeMenu(v => !v); setShowScheduleMenu(false); setShowConvMenu(false) }}
                    className="flex items-center gap-1.5 px-3 py-1.5 text-[12px] rounded-full bg-surface-50 text-surface-600 hover:bg-surface-100 transition-colors"
                  >
                    <FolderOpen className="w-3.5 h-3.5" /> {scopeLabel()}
                  </button>
                  {showScopeMenu && (
                    <ScopeMenu
                      workspaces={workspaces}
                      agents={agents}
                      selectedWs={workspaceId}
                      selectedAgent={agentId}
                      onPickGlobal={() => { setWorkspaceId(undefined); setAgentId(undefined); setShowScopeMenu(false) }}
                      onPickWs={(id) => { setWorkspaceId(id); setAgentId(undefined); setShowScopeMenu(false) }}
                      onPickAgent={(id) => { setAgentId(id); setWorkspaceId(undefined); setShowScopeMenu(false) }}
                    />
                  )}
                </div>
              )}
              {lockedWorkspaceId && (
                <div className="flex items-center gap-1.5 px-3 py-1.5 text-[12px] rounded-full bg-surface-50 text-surface-400">
                  <FolderOpen className="w-3.5 h-3.5" /> {scopeLabel()}
                </div>
              )}

              {/* 触发 pill — 定时 / Webhook */}
              <div className="relative">
                <button
                  onClick={() => { setShowScheduleMenu(v => !v); setShowScopeMenu(false); setShowConvMenu(false) }}
                  className="flex items-center gap-1.5 px-3 py-1.5 text-[12px] rounded-full bg-surface-50 text-surface-600 hover:bg-surface-100 transition-colors"
                >
                  {triggerKind === 'webhook'
                    ? <><Webhook className="w-3.5 h-3.5" /> {t('tasks.trigger.webhook')}{webhookSecret ? ' 🔒' : ''}</>
                    : <><Clock className="w-3.5 h-3.5" /> {scheduleLabel()}</>}
                </button>
                {showScheduleMenu && (
                  <TriggerMenu
                    kind={triggerKind} setKind={setTriggerKind}
                    mode={scheduleMode} setMode={setScheduleMode}
                    time={time} setTime={setTime}
                    weekday={weekday} setWeekday={setWeekday}
                    intervalMin={intervalMin} setIntervalMin={setIntervalMin}
                    cron={cron} setCron={setCron}
                    webhookSecret={webhookSecret} setWebhookSecret={setWebhookSecret}
                    webhookUrl={webhookUrl}
                    copyWebhookCurl={copyWebhookCurl}
                    copiedWebhook={copiedWebhook}
                    onClose={() => setShowScheduleMenu(false)}
                  />
                )}
              </div>

              {/* 会话模式 pill */}
              <div className="relative">
                <button
                  onClick={() => { setShowConvMenu(v => !v); setShowScopeMenu(false); setShowScheduleMenu(false) }}
                  className="flex items-center gap-1.5 px-3 py-1.5 text-[12px] rounded-full bg-surface-50 text-surface-600 hover:bg-surface-100 transition-colors"
                >
                  <MessageSquare className="w-3.5 h-3.5" /> {convModeLabel()}
                </button>
                {showConvMenu && (
                  <div className="absolute bottom-full mb-1 left-0 w-52 bg-surface-0 dark:bg-surface-50 rounded-lg shadow-xl border border-surface-100 py-1 z-10">
                    {(['per-run', 'persistent'] as const).map(m => (
                      <button
                        key={m}
                        onClick={() => { setConvMode(m); setShowConvMenu(false) }}
                        className={`w-full px-3 py-2 text-left text-[12px] hover:bg-surface-50 dark:hover:bg-surface-100 ${convMode === m ? 'text-brand-600' : 'text-surface-600'}`}
                      >
                        <div className="font-medium">
                          {m === 'per-run'
                            ? t('tasks.editor.conversation.perRunTitle')
                            : t('tasks.editor.conversation.persistentTitle')}
                        </div>
                        <div className="text-[10px] text-surface-300 mt-0.5">
                          {m === 'per-run'
                            ? t('tasks.editor.conversation.perRunDescription')
                            : t('tasks.editor.conversation.persistentDescription')}
                        </div>
                      </button>
                    ))}
                  </div>
                )}
              </div>

              {/* 智能免打扰 pill */}
              <button
                onClick={() => setSmartSilence(v => !v)}
                title={smartSilence
                  ? t('tasks.editor.smartSilence.enabledTitle')
                  : t('tasks.editor.smartSilence.disabledTitle')
                }
                className={`flex items-center gap-1.5 px-3 py-1.5 text-[12px] rounded-full transition-colors ${
                  smartSilence
                    ? 'bg-indigo-50 dark:bg-indigo-900/20 text-indigo-600 dark:text-indigo-400 hover:bg-indigo-100'
                    : 'bg-surface-50 text-surface-400 line-through hover:bg-surface-100'
                }`}
              >
                <Moon className="w-3.5 h-3.5" />
                {smartSilence
                  ? t('tasks.editor.smartSilence.enabledLabel')
                  : t('tasks.editor.smartSilence.disabledLabel')}
              </button>
            </div>

            {/* 操作按钮 */}
            <div className="flex items-center gap-2 shrink-0">
              {task && onDelete && (
                <button
                  onClick={onDelete}
                  className="px-3 py-1.5 text-[12px] text-red-400 hover:text-red-500 transition-colors"
                >
                  {t('tasks.actions.delete')}
                </button>
              )}
              <button
                onClick={onCancel}
                className="px-3 py-1.5 text-[12px] text-surface-500 hover:text-surface-700 transition-colors"
              >
                {t('common.actions.cancel')}
              </button>
              <button
                onClick={handleSave}
                disabled={!canSave}
                className="px-4 py-1.5 text-[12px] rounded-md bg-brand-500 text-ink-on-accent font-medium disabled:opacity-40 hover:bg-brand-600 transition-colors"
              >
                {task ? t('common.actions.save') : t('tasks.actions.create')}
              </button>
            </div>
          </div>
        </div>

        {/* 模板选择弹窗 */}
        {showTemplates && (
          <TaskTemplates
            onPick={applyTemplate}
            onClose={() => setShowTemplates(false)}
          />
        )}
      </div>
    </div>
  )
}

// ---- 子组件：作用域选择菜单 ----

function ScopeMenu({
  workspaces, agents, selectedWs, selectedAgent,
  onPickGlobal, onPickWs, onPickAgent
}: {
  workspaces: WorkspaceSummary[]
  agents: AgentTemplateSummary[]
  selectedWs?: string
  selectedAgent?: string
  onPickGlobal: () => void
  onPickWs: (id: string) => void
  onPickAgent: (id: string) => void
}) {
  const { t } = useTranslation()

  return (
    <div className="absolute bottom-full mb-1 left-0 w-60 max-h-72 overflow-y-auto bg-surface-0 dark:bg-surface-50 rounded-lg shadow-xl border border-surface-100 py-1 z-10">
      <button
        onClick={onPickGlobal}
        className={`w-full px-3 py-2 text-left text-[12px] hover:bg-surface-50 dark:hover:bg-surface-100 ${!selectedWs && !selectedAgent ? 'text-brand-600' : 'text-surface-600'}`}
      >
        <div className="font-medium">🌐 {t('tasks.editor.scope.globalCurrentRole')}</div>
      </button>
      {workspaces.length > 0 && (
        <>
          <div className="px-3 py-1 text-[10px] uppercase tracking-wider text-surface-300">
            {t('tasks.editor.scope.workspaceAgents')}
          </div>
          {workspaces.map(w => (
            <button
              key={w.id}
              onClick={() => onPickWs(w.id)}
              className={`w-full px-3 py-1.5 text-left text-[12px] hover:bg-surface-50 dark:hover:bg-surface-100 ${selectedWs === w.id ? 'text-brand-600' : 'text-surface-600'}`}
            >
              <span className="mr-1.5">{w.icon || '🤖'}</span>{w.name}
            </button>
          ))}
        </>
      )}
      {agents.length > 0 && (
        <>
          <div className="px-3 py-1 text-[10px] uppercase tracking-wider text-surface-300 mt-1">
            {t('tasks.editor.scope.agentTemplates')}
          </div>
          {agents.map(a => (
            <button
              key={a.id}
              onClick={() => onPickAgent(a.id)}
              className={`w-full px-3 py-1.5 text-left text-[12px] hover:bg-surface-50 dark:hover:bg-surface-100 ${selectedAgent === a.id ? 'text-brand-600' : 'text-surface-600'}`}
            >
              <span className="mr-1.5">{a.icon || '🤖'}</span>{a.name}
            </button>
          ))}
        </>
      )}
    </div>
  )
}

// ---- 子组件：时间配置菜单 ----

function TriggerMenu({
  kind, setKind,
  mode, setMode, time, setTime, weekday, setWeekday,
  intervalMin, setIntervalMin, cron, setCron,
  webhookSecret, setWebhookSecret, webhookUrl, copyWebhookCurl, copiedWebhook,
  onClose
}: {
  kind: TriggerKind; setKind: (k: TriggerKind) => void
  mode: ScheduleMode; setMode: (m: ScheduleMode) => void
  time: string; setTime: (v: string) => void
  weekday: string; setWeekday: (v: string) => void
  intervalMin: number; setIntervalMin: (v: number) => void
  cron: string; setCron: (v: string) => void
  webhookSecret: string; setWebhookSecret: (v: string) => void
  webhookUrl: string
  copyWebhookCurl: () => Promise<void>
  copiedWebhook: boolean
  onClose: () => void
}) {
  const { t } = useTranslation()

  return (
    <div className="absolute bottom-full mb-1 left-0 w-80 bg-surface-0 dark:bg-surface-50 rounded-lg shadow-xl border border-surface-100 p-3 z-10">
      {/* 触发类型切换：定时 / Webhook */}
      <div className="flex gap-1 mb-3 p-0.5 bg-surface-50 rounded-md">
        <button
          onClick={() => setKind('schedule')}
          className={`flex-1 py-1 text-[11px] rounded transition-colors ${kind === 'schedule' ? 'bg-surface-0 dark:bg-surface-50 text-brand-600 shadow-sm' : 'text-surface-400'}`}
        >
          <Clock className="w-3 h-3 inline mr-1" /> {t('tasks.editor.trigger.schedule')}
        </button>
        <button
          onClick={() => setKind('webhook')}
          className={`flex-1 py-1 text-[11px] rounded transition-colors ${kind === 'webhook' ? 'bg-surface-0 dark:bg-surface-50 text-brand-600 shadow-sm' : 'text-surface-400'}`}
        >
          <Webhook className="w-3 h-3 inline mr-1" /> {t('tasks.trigger.webhook')}
        </button>
      </div>

      {/* Webhook 配置 */}
      {kind === 'webhook' && (
        <div className="space-y-2">
          {webhookUrl ? (
            <>
              <div>
                <label className="text-[10px] text-surface-400">{t('tasks.editor.trigger.webhookUrlLabel')}</label>
                <div className="mt-1 flex items-center gap-1">
                  <input readOnly value={webhookUrl}
                    className="flex-1 px-2 py-1.5 text-[11px] font-mono rounded border border-surface-200 bg-surface-50 dark:bg-surface-50/50 text-surface-500" />
                  <button onClick={copyWebhookCurl} title={t('tasks.editor.trigger.copyCurl')}
                    className="p-1.5 rounded hover:bg-surface-100 text-surface-400">
                    {copiedWebhook ? <Check className="w-3.5 h-3.5 text-green-500" /> : <Copy className="w-3.5 h-3.5" />}
                  </button>
                </div>
              </div>
              <div>
                <label className="text-[10px] text-surface-400">{t('tasks.editor.trigger.secretLabel')}</label>
                <input value={webhookSecret} onChange={e => setWebhookSecret(e.target.value)}
                  placeholder={t('tasks.editor.trigger.secretPlaceholder')}
                  className="w-full mt-1 px-2 py-1.5 text-[12px] rounded border border-surface-200 bg-transparent text-surface-600" />
              </div>
            </>
          ) : (
            <p className="text-[11px] text-surface-400 py-4 text-center">
              {t('tasks.editor.trigger.webhookPending')}
            </p>
          )}
        </div>
      )}

      {/* 定时配置 */}
      {kind === 'schedule' && <>
      <div className="flex flex-wrap gap-1 mb-3">
        {(Object.keys(SCHEDULE_MODE_KEYS) as ScheduleMode[]).map(m => (
          <button
            key={m}
            onClick={() => setMode(m)}
            className={`px-2.5 py-1 text-[11px] rounded-md border transition-colors ${
              mode === m
                ? 'border-brand-400 bg-brand-50 dark:bg-brand-900/20 text-brand-600'
                : 'border-surface-200 text-surface-400 hover:border-surface-300'
            }`}
          >
            {t(SCHEDULE_MODE_KEYS[m])}
          </button>
        ))}
      </div>

      {(mode === 'daily' || mode === 'weekdays') && (
        <div>
          <label className="text-[10px] text-surface-400">{t('tasks.editor.schedule.time')}</label>
          <input type="time" value={time} onChange={e => setTime(e.target.value)}
            className="w-full mt-1 px-2 py-1.5 text-[12px] rounded border border-surface-200 bg-transparent text-surface-600" />
        </div>
      )}
      {mode === 'weekly' && (
        <div className="space-y-2">
          <div>
            <label className="text-[10px] text-surface-400">{t('tasks.editor.schedule.weekday')}</label>
            <div className="flex gap-1 mt-1">
              {['mon','tue','wed','thu','fri','sat','sun'].map(d => (
                <button
                  key={d} onClick={() => setWeekday(d)}
                  className={`w-7 h-7 text-[10px] rounded border transition-colors ${
                    weekday === d
                      ? 'border-brand-400 bg-brand-50 text-brand-600'
                      : 'border-surface-200 text-surface-400'
                  }`}
                >{translatedWeekday(d, t)}</button>
              ))}
            </div>
          </div>
          <div>
            <label className="text-[10px] text-surface-400">{t('tasks.editor.schedule.time')}</label>
            <input type="time" value={time} onChange={e => setTime(e.target.value)}
              className="w-full mt-1 px-2 py-1.5 text-[12px] rounded border border-surface-200 bg-transparent text-surface-600" />
          </div>
        </div>
      )}
      {mode === 'interval' && (
        <div className="flex items-center gap-2">
          <span className="text-[12px] text-surface-400">{t('tasks.editor.schedule.intervalPrefix')}</span>
          <input type="number" min={1} value={intervalMin} onChange={e => setIntervalMin(Number(e.target.value))}
            className="w-20 px-2 py-1.5 text-[12px] rounded border border-surface-200 bg-transparent text-surface-600" />
          <span className="text-[12px] text-surface-400">{t('tasks.editor.schedule.intervalSuffix')}</span>
        </div>
      )}
      {mode === 'cron' && (
        <div>
          <label className="text-[10px] text-surface-400">{t('tasks.editor.schedule.cronLabel')}</label>
          <input value={cron} onChange={e => setCron(e.target.value)} placeholder="0 9 * * 1-5"
            className="w-full mt-1 px-2 py-1.5 text-[12px] font-mono rounded border border-surface-200 bg-transparent text-surface-600" />
        </div>
      )}
      </>}

      <div className="mt-3 flex justify-end">
        <button onClick={onClose}
          className="px-3 py-1 text-[11px] text-brand-600 hover:text-brand-700">
          {t('common.actions.confirm')}
        </button>
      </div>
    </div>
  )
}

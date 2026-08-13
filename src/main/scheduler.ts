/**
 * Scheduler Engine — 统一任务调度器
 *
 * 基于 task-store 的单一数据源；全局任务和 Workspace 任务走同一套调度/执行路径，
 * 通过 task.workspaceId / task.agentId 在执行时分支构建 Agent overrides。
 *
 * setTimeout 链（非 setInterval）：macOS 睡眠唤醒后，过期的 setTimeout 会立即触发，
 * 而 setInterval 会漂移。
 */

import { BrowserWindow } from 'electron'
import { randomUUID } from 'crypto'
import {
  listTasks, getTask, updateTask, recordTaskExecution,
  migrateLegacyTasks,
  type Task, type ScheduleConfig, type TaskTrigger, type TaskResult, type SilentLogEntry
} from './task-store'
import { getAgentRuntime } from './agent-runtime'
import type { ChatMessage, AgentOverrides } from './agent-runtime/contracts'
import { resolveAgentOverrides } from './agent-overrides'
import { getAgentTemplate } from './agent-template-manager'
import {
  appendMessages,
  createConversation,
  deleteConversation,
  getConversation,
  getConversationMessagesSerialized,
  shouldReplayStoredMessage,
  type StoredMessage
} from './conversation-store'
import { createTranscriptCollector } from './pi-event-adapter'
import {
  getWorkspace,
  readAllWorkspaceTriggers,
  clearWorkspaceTriggers
} from './agent-workspace-store'
import { getCurrentRole } from './role-manager'
import { registerTaskSchedulerControl } from './task-scheduler-control'
import { acquireConversationExecution } from './conversation-execution-coordinator'
import { isWebhookSecretValid } from './local-http-auth'
import { tMain } from './main-i18n'

// ---- 状态 ----

const timers = new Map<string, NodeJS.Timeout>()
const runningControllers = new Map<string, AbortController>()
let schedulerShuttingDown = false
let _getWindow: (() => BrowserWindow | null) | null = null

// Agent Runtime 全栈懒加载（同 ipc-handlers.ts），由 router 统一缓存与失败重试。
const agentService = getAgentRuntime

// ---- Cron 解析器 ----

interface CronField {
  values: Set<number>
  any: boolean
}

function parseCronField(field: string, min: number, max: number): CronField {
  if (field === '*') return { values: new Set(), any: true }

  const values = new Set<number>()

  for (const part of field.split(',')) {
    if (part.includes('/')) {
      const [range, stepStr] = part.split('/')
      const step = parseInt(stepStr, 10)
      let start = min
      let end = max
      if (range !== '*') {
        if (range.includes('-')) {
          const [s, e] = range.split('-').map(Number)
          start = s
          end = e
        } else {
          start = parseInt(range, 10)
        }
      }
      for (let i = start; i <= end; i += step) values.add(i)
    } else if (part.includes('-')) {
      const [start, end] = part.split('-').map(Number)
      for (let i = start; i <= end; i++) values.add(i)
    } else {
      const num = parseInt(part, 10)
      if (isNaN(num) || num < min || num > max) {
        throw new Error(`Cron value ${part} out of range [${min}-${max}]`)
      }
      values.add(num)
    }
  }

  return { values, any: false }
}

interface ParsedCron {
  minute: CronField
  hour: CronField
  dayOfMonth: CronField
  month: CronField
  dayOfWeek: CronField
}

function parseCron(expr: string): ParsedCron {
  const parts = expr.trim().split(/\s+/)
  if (parts.length !== 5) throw new Error(`Invalid cron expression: "${expr}" (expected 5 fields)`)

  return {
    minute: parseCronField(parts[0], 0, 59),
    hour: parseCronField(parts[1], 0, 23),
    dayOfMonth: parseCronField(parts[2], 1, 31),
    month: parseCronField(parts[3], 1, 12),
    dayOfWeek: parseCronField(parts[4], 0, 6)
  }
}

function cronFieldMatches(field: CronField, value: number): boolean {
  return field.any || field.values.has(value)
}

export function computeNextCronTime(expr: string, after: Date = new Date()): Date {
  const cron = parseCron(expr)
  const next = new Date(after.getTime())
  next.setSeconds(0, 0)
  next.setMinutes(next.getMinutes() + 1)

  const maxIterations = 366 * 24 * 60
  for (let i = 0; i < maxIterations; i++) {
    const month = next.getMonth() + 1
    const dayOfMonth = next.getDate()
    const dayOfWeek = next.getDay()
    const hour = next.getHours()
    const minute = next.getMinutes()

    if (
      cronFieldMatches(cron.month, month) &&
      cronFieldMatches(cron.dayOfMonth, dayOfMonth) &&
      cronFieldMatches(cron.dayOfWeek, dayOfWeek) &&
      cronFieldMatches(cron.hour, hour) &&
      cronFieldMatches(cron.minute, minute)
    ) {
      return next
    }

    next.setMinutes(next.getMinutes() + 1)
  }

  throw new Error(`No matching time found for cron "${expr}" within 366 days`)
}

// ---- 触发时间计算 ----

function fixedToCron(sched: ScheduleConfig): string {
  const [hour, minute] = (sched.time || '09:00').split(':').map(Number)

  if (!sched.days || sched.days.length === 0 || sched.days.length === 7) {
    return `${minute} ${hour} * * *`
  }

  const dayMap: Record<string, number> = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 }
  const dayNums = sched.days.map(d => dayMap[d.toLowerCase()] ?? 0)
  return `${minute} ${hour} * * ${dayNums.join(',')}`
}

/** 根据 trigger 计算下一次运行时间（仅 schedule 类型；webhook/gate 返回 undefined） */
export function computeNextRunTime(trigger: TaskTrigger, after?: Date): number | undefined {
  if (trigger.type !== 'schedule') return undefined
  const sched = trigger.schedule
  switch (sched.type) {
    case 'interval':
      return (after?.getTime() ?? Date.now()) + (sched.intervalMs || 60000)
    case 'fixed':
      return computeNextCronTime(fixedToCron(sched), after).getTime()
    case 'cron':
      return computeNextCronTime(sched.cron || '0 * * * *', after).getTime()
    default:
      return Date.now() + 60000
  }
}

// ---- 任务执行 ----

interface EnsuredConversation {
  conversationId: string
  /** 本轮是否刚创建了一个尚未持久化消息的空会话。 */
  createdNow: boolean
}

/**
 * 确保会话存在并返回本轮是否刚创建。
 * persistent + 已绑定 → 复用；否则新建（per-run 或首次 persistent）。
 */
function ensureConversation(task: Task): EnsuredConversation {
  if (task.conversationMode === 'persistent' && task.boundConversationId) {
    if (!getConversation(task.boundConversationId)) {
      throw new Error(`任务绑定的会话 ${task.boundConversationId} 不存在，已停止执行`)
    }
    return { conversationId: task.boundConversationId, createdNow: false }
  }
  // 新建会话：使用任务记录的 role，缺失则 fallback 到当前活跃 role
  const role = task.role || getCurrentRole()?.name || 'learner'
  const conv = createConversation(role, `[任务] ${task.name}`, task.agentId, task.workspaceId)

  // persistent 模式首次执行：绑定会话
  if (task.conversationMode === 'persistent') {
    updateTask(task.id, { boundConversationId: conv.id })
  }

  return { conversationId: conv.id, createdNow: true }
}

/**
 * 把 webhook payload 拼接进 prompt — Agent-first：让 Agent 看到原始数据自己解析
 * Body 大于 8KB 会截断（避免 token 浪费）
 */
function buildPromptWithPayload(basePrompt: string, payload?: WebhookPayload): string {
  if (!payload?.body) return basePrompt
  const MAX_BODY = 8192
  let body = payload.body
  let truncated = false
  if (body.length > MAX_BODY) {
    body = body.substring(0, MAX_BODY)
    truncated = true
  }
  // 尝试 JSON 美化
  let formatted = body
  try {
    formatted = JSON.stringify(JSON.parse(body), null, 2)
  } catch { /* 非 JSON，保留原文 */ }

  // 关键 headers（过滤敏感的 / 噪音的）
  const headerSection = payload.headers ? Object.entries(payload.headers)
    .filter(([k]) => /^(content-type|user-agent|x-.*-event|x-.*-signature|x-.*-delivery)$/i.test(k))
    .map(([k, v]) => `${k}: ${v}`).join('\n') : ''

  return `${basePrompt}\n\n---\n## Webhook 事件数据\n${headerSection ? `\n**Headers:**\n\`\`\`\n${headerSection}\n\`\`\`\n` : ''}\n**Body:**\n\`\`\`json\n${formatted}\n\`\`\`${truncated ? '\n\n_（body 超过 8KB 已截断）_' : ''}`
}

/**
 * 智能免打扰 — 注入到 prompt 末尾的指令，授予 Agent 主动沉默的权力。
 * 格式约定：
 *   NO_REPLY: [来源] 一句话理由
 * 或不带来源：
 *   NO_REPLY: 一句话理由
 *
 * 解析侧：对话层不持久化此次回复，但系统会记录到 silentLog 供用户审计。
 */
const SMART_SILENCE_INSTRUCTION = `

---
## 智能免打扰

你现在扮演用户的"私人助理"。并非所有触发事件都值得打扰用户——噪音、
与用户无关的消息、已经自动处理的事件、另一 Agent 发来的例行同步等，
都应该被你拦截在门外。

**判断准则：**
- 这件事用户需要**立刻知道**吗？不需要 → 静默
- 这是用户**真正关心**的领域吗？不是 → 静默
- 这是例行/已处理/重复的事件吗？是 → 静默

**静默格式（第一行）：**
\`NO_REPLY: [来源] 一句话理由（30 字内）\`

示例：
- \`NO_REPLY: [github] 忽略 dependabot 的依赖更新评论\`
- \`NO_REPLY: [飞书] 与用户任务无关的群闲聊\`
- \`NO_REPLY: [stripe] 正常订阅续费，无需关注\`

如果**值得打扰用户**，就正常回复，不要输出 NO_REPLY。`

/** 从 Agent 回复里解析静默标记；返回 null 表示不是静默回复 */
function parseSilentReply(response: string): { reason: string; source?: string } | null {
  const match = response.match(/^\s*NO_REPLY\s*:\s*(?:\[([^\]]+)\]\s*)?(.+?)(?:\n|$)/i)
  if (!match) return null
  return {
    source: match[1]?.trim() || undefined,
    reason: (match[2] || '').trim().substring(0, 100)  // 硬约束 100 字
  }
}

/** 追加到 task.silentLog，滚动保留最近 50 条 */
function appendSilentLog(taskId: string, entry: SilentLogEntry): void {
  const task = getTask(taskId)
  if (!task) return
  const log = (task.silentLog || []).slice(-49)
  log.push(entry)
  updateTask(taskId, { silentLog: log })
}

/** runTask 的结果：区分"正常回复"和"静默处理" */
interface RunResult {
  silent: boolean
  message: string              // 静默时为理由，否则为 response 的前 200 字
  silentEntry?: SilentLogEntry
}

/**
 * 会话存储是持久历史的唯一真值。Scheduler 只在每轮开始时读取可回放投影，
 * 不在 Runtime 内再建第二份持久会话。工具轨迹的映射口径与 ACP 保持一致。
 */
function storedMessageToChatMessage(message: StoredMessage): ChatMessage {
  if (message.role === 'tool') {
    return {
      id: message.id,
      role: 'tool',
      content: message.content,
      toolName: message.toolName,
      toolCallId: message.toolCallId,
      toolArgs: message.modelToolArgs ?? message.toolArgs
    }
  }

  return {
    id: message.id,
    role: message.role,
    content: message.content,
    screenshot: message.screenshot,
    screenshotRef: message.screenshotRef,
    images: message.images,
    imagePaths: message.imagePaths,
    fileAttachments: message.fileAttachments
  }
}

function taskAbortError(message: string): Error {
  const error = new Error(message)
  error.name = 'AbortError'
  return error
}

function throwIfTaskAborted(signal: AbortSignal): void {
  if (!signal.aborted) return
  if (signal.reason instanceof Error) throw signal.reason
  throw taskAbortError('任务已取消')
}

/**
 * 执行一个任务：决定 overrides + 跑 agentChat + 持久化消息
 * 若启用智能免打扰且 Agent 判定静默，不 append 消息到 conversation，
 * 而是把理由写进 task.silentLog 供审计。
 */
async function runTask(task: Task, signal: AbortSignal, payload?: WebhookPayload): Promise<RunResult> {
  const { conversationId, createdNow } = ensureConversation(task)
  const execution = await acquireConversationExecution({
    conversationId,
    owner: { entrypoint: 'scheduler', ownerId: task.id },
    policy: 'wait',
    signal
  })
  try {
    // A conversation can be deleted while this task is queued behind another
    // owner. Re-check after acquiring the shared lease so a stale binding can
    // never reach Agent Runtime/model/tool execution.
    const conversation = getConversation(conversationId)
    if (!conversation) {
      throw new Error(`任务绑定的会话 ${conversationId} 不存在，已停止执行`)
    }
    return await runTaskInConversation(
      task,
      execution.signal,
      conversationId,
      createdNow,
      conversation,
      payload
    )
  } finally {
    execution.release()
  }
}

async function runTaskInConversation(
  task: Task,
  signal: AbortSignal,
  conversationId: string,
  createdNow: boolean,
  conversation: NonNullable<ReturnType<typeof getConversation>>,
  payload?: WebhookPayload
): Promise<RunResult> {

  // Keep the scheduler's previous fail-closed behavior for stale task targets;
  // resolveAgentOverrides deliberately falls back for interactive entry points.
  if (task.workspaceId && !getWorkspace(task.workspaceId)) {
    throw new Error(`Workspace ${task.workspaceId} 未找到`)
  }
  if (task.agentId && !getAgentTemplate(task.agentId)) {
    throw new Error(`Agent 模板 ${task.agentId} 未找到`)
  }

  // Use the same persisted conversation config and Agent/workspace resolution
  // as desktop, HTTP and realtime entry points. This preserves the pinned
  // model, working directory, thinking controls, role brief and goal.
  let overrides: AgentOverrides = resolveAgentOverrides({
    agentId: task.agentId,
    workspaceId: task.workspaceId,
    conversationId,
    conversationConfig: conversation.config
  }) ?? { systemPrompt: '', conversationId }

  const now = Date.now()
  // 智能免打扰默认开启；false 时强制关闭
  const smartSilenceEnabled = task.smartSilence !== false
  // 用户 prompt 只含任务说明 + webhook 数据（不污染对话记录里的 user message）
  const finalPrompt = buildPromptWithPayload(task.prompt || '请执行任务', payload)
  // 静默指令作为 systemPrompt 注入（用户看不到，但 Agent 能读到）
  if (smartSilenceEnabled && overrides) {
    const existingSys = overrides.systemPrompt || ''
    overrides = {
      ...overrides,
      systemPrompt: existingSys + SMART_SILENCE_INSTRUCTION
    }
  }

  const currentMessage: ChatMessage = {
    id: randomUUID(),
    role: 'user',
    content: finalPrompt
  }

  // persistent 任务的下一轮从已有会话继续；serialized 读会先等待在飞的 append。
  const messages: ChatMessage[] = task.conversationMode === 'persistent'
    ? (await getConversationMessagesSerialized(conversationId))
        .filter(shouldReplayStoredMessage)
        .map(storedMessageToChatMessage)
        .concat(currentMessage)
    : [currentMessage]

  const collector = createTranscriptCollector()
  try {
    const { agentChat } = await agentService()
    throwIfTaskAborted(signal)
    for await (const event of agentChat(messages, signal, 'scheduler', overrides)) {
      // AgentEvent.error 是 Runtime 终止信号，不是可被当成空回复忽略的普通事件。
      if (event.type === 'error') {
        throw new Error(event.content.trim() || 'Agent Runtime 执行失败')
      }
      collector.feed(event)
    }
    // 某些 Runtime 会在收到 abort 后安静结束 generator，这里仍必须把本轮标为失败。
    throwIfTaskAborted(signal)
  } catch (err) {
    if (signal.aborted) throwIfTaskAborted(signal)
    throw err
  }

  const fullResponse = collector.finish()
  const transcript = collector.finishTranscript()

  if (!fullResponse.trim() && transcript.length === 0) {
    throw new Error('Agent Runtime 未返回文本或工具结果')
  }

  // 静默检测：首段匹配 NO_REPLY 格式 → 不 append 到对话，删除空会话，仅记审计日志
  if (smartSilenceEnabled) {
    const silent = parseSilentReply(fullResponse)
    if (silent) {
      const entry: SilentLogEntry = {
        timestamp: Date.now(),
        reason: silent.reason,
        source: silent.source
      }
      appendSilentLog(task.id, entry)

      // 只清理本轮刚创建的空壳。已绑定会话即使本轮静默，也必须
      // 保留既有历史与任务绑定；否则一次 NO_REPLY 会删掉整段持久会话。
      if (createdNow) {
        let deleted = false
        try { deleted = await deleteConversation(conversationId) } catch { /* ignore */ }

        // persistent 首次执行刚绑定的空会话：仅在删除成功且
        // 绑定未被并发更改时清空，下次再创建。
        if (
          deleted &&
          task.conversationMode === 'persistent' &&
          getTask(task.id)?.boundConversationId === conversationId
        ) {
          updateTask(task.id, { boundConversationId: undefined })
        }
      }

      console.log(`[Task] 🤫 静默: ${task.name} — [${silent.source || '?'}] ${silent.reason}`)
      return { silent: true, message: silent.reason, silentEntry: entry }
    }
  }

  if (conversationId && transcript.length > 0) {
    const toAppend: StoredMessage[] = [
      {
        id: randomUUID(),
        role: 'user',
        content: finalPrompt,
        timestamp: now,
        messageKind: 'task-trigger'  // 让 UI 识别：任务触发产生的"系统内部消息"，可隐藏/折叠
      }
    ]
    for (const entry of transcript) {
      const timestamp = Date.now()
      toAppend.push(entry.kind === 'tool'
        ? {
          id: randomUUID(),
          role: 'tool',
          content: entry.content,
          timestamp,
          toolName: entry.toolName,
          toolCallId: entry.toolCallId,
          toolArgs: entry.toolArgs,
          ...(entry.searchResults ? { searchResults: entry.searchResults } : {})
        }
        : {
          id: randomUUID(),
          role: 'assistant',
          content: entry.content,
          timestamp
        })
    }
    const persisted = await appendMessages(conversationId, toAppend)
    if (!persisted) throw new Error(`会话 ${conversationId} 不存在，任务结果未能保存`)
  }

  const resultMessage = fullResponse.trim() || transcript
    .filter((entry) => entry.kind === 'tool')
    .map((entry) => `${entry.toolName}: ${entry.content}`)
    .join('\n')

  return {
    silent: false,
    message: fullResponse.trim()
      ? resultMessage.substring(0, 200)
      : `[仅工具结果] ${resultMessage}`.substring(0, 200)
  }
}

interface ExecuteOptions {
  webhookPayload?: WebhookPayload
}

/**
 * Resolve the next run from the task's current persisted state, not the
 * snapshot captured when execution started. A schedule can be edited while an
 * Agent turn is in flight; using the old snapshot here would overwrite the new
 * trigger's nextRun. Deleted, disabled, and non-scheduled tasks deliberately
 * receive no nextRun update.
 */
function computeFreshNextRun(taskId: string): number | undefined {
  const fresh = getTask(taskId)
  if (!fresh?.enabled || fresh.trigger.type !== 'schedule') return undefined
  return computeNextRunTime(fresh.trigger)
}

/**
 * 执行任务 + 记录结果 + 重新调度
 */
export async function executeTask(taskId: string, options?: ExecuteOptions): Promise<void> {
  if (schedulerShuttingDown) {
    console.log(`[Task] 调度器已关闭，跳过执行: ${taskId}`)
    return
  }
  if (runningControllers.has(taskId)) {
    console.log(`[Task] ${taskId} 正在执行中，跳过`)
    return
  }

  const task = getTask(taskId)
  if (!task || !task.enabled) return

  const abort = new AbortController()
  runningControllers.set(taskId, abort)
  const scope = task.workspaceId ? `ws=${task.workspaceId.slice(0,8)}`
              : task.agentId ? `agent=${task.agentId.slice(0,8)}`
              : 'global'

  try {
    throwIfTaskAborted(abort.signal)
    console.log(`[Task] 开始执行: ${task.name} (${scope})`)

    const run = await runTask(task, abort.signal, options?.webhookPayload)
    // runTask 完成与 executeTask 记录成功之间仍可能收到 disable/shutdown。
    throwIfTaskAborted(abort.signal)
    const result: TaskResult = {
      status: 'success',
      message: run.silent ? `${tMain('tasks.silentPrefix')} ${run.message}` : run.message,
      timestamp: Date.now()
    }
    const nextRun = computeFreshNextRun(taskId)
    recordTaskExecution(taskId, result, nextRun)
    notifyRenderer(taskId, result, run.silent)
    console.log(`[Task] ${run.silent ? '静默完成' : '执行成功'}: ${task.name}`)
  } catch (err: any) {
    const result: TaskResult = { status: 'error', message: err.message, timestamp: Date.now() }
    const nextRun = computeFreshNextRun(taskId)
    recordTaskExecution(taskId, result, nextRun)
    notifyRenderer(taskId, result, false)
    console.warn(`[Task] 执行失败: ${task.name} — ${err.message}`)
  } finally {
    if (runningControllers.get(taskId) === abort) runningControllers.delete(taskId)
    // 重新调度
    try {
      const fresh = getTask(taskId)
      if (!schedulerShuttingDown && fresh && fresh.enabled && fresh.trigger.type === 'schedule') {
        scheduleTask(fresh)
      }
    } catch (err) {
      console.error(`[Task] 重新调度失败: ${taskId}`, err)
    }
  }
}

function notifyRenderer(taskId: string, result: TaskResult, silent: boolean): void {
  if (!_getWindow) {
    console.warn(`[Task] notifyRenderer 跳过: _getWindow 未设置`)
    return
  }
  const win = _getWindow()
  if (win && !win.isDestroyed()) {
    win.webContents.send('task:executed', taskId, result, silent)
    console.log(`[Task] IPC 事件已发送: task:executed ${taskId.slice(0,8)}${silent ? ' (silent)' : ''}`)
  } else {
    console.warn(`[Task] notifyRenderer 跳过: window 不存在或已销毁`)
  }
}

// ---- 调度管理 ----

export function scheduleTask(task: Task): void {
  if (schedulerShuttingDown || !task || !task.enabled) return
  // 仅 schedule 类型需要 timer（webhook/gate 由其他机制触发）
  if (task.trigger.type !== 'schedule') return

  clearTaskTimer(task.id)

  let nextRun = task.nextRun
  if (!nextRun) {
    const computed = computeNextRunTime(task.trigger)
    if (!computed) return
    nextRun = computed
    updateTask(task.id, { nextRun })
  }

  const delay = Math.max(nextRun - Date.now(), 1000)

  const timer = setTimeout(async () => {
    // This handle has fired. Remove it before execution so executeTask's
    // finally may register the next handle without the old callback deleting
    // that new registration after it resolves.
    if (timers.get(task.id) === timer) timers.delete(task.id)
    try {
      await executeTask(task.id)
    } catch (err) {
      console.error(`[Task] 执行异常: ${task.name}`, err)
    }
  }, delay)

  timers.set(task.id, timer)

  const nextDate = new Date(nextRun).toLocaleString('zh-CN')
  console.log(`[Task] 已调度: ${task.name} → ${nextDate} (${Math.round(delay / 1000)}s 后)`)
}

/** Webhook 触发时携带的 payload — 注入到 Agent 的 prompt */
export interface WebhookPayload {
  body: string                          // 请求 body 原文
  headers?: Record<string, string>      // 请求 headers（用于 Agent 看签名等元数据）
}

export function authorizeTaskWebhook(
  taskId: string,
  providedSecret?: string,
): { ok: boolean; status: number; error?: string } {
  const task = getTask(taskId)
  if (!task) return { ok: false, status: 404, error: 'task not found' }
  if (!task.enabled) return { ok: false, status: 409, error: 'task disabled' }
  if (task.trigger.type !== 'webhook') return { ok: false, status: 400, error: 'task trigger is not webhook' }
  if (!task.trigger.secret) return { ok: false, status: 401, error: 'webhook secret is not configured' }
  if (!isWebhookSecretValid(task.trigger.secret, providedSecret)) return { ok: false, status: 401, error: 'invalid secret' }
  return { ok: true, status: 200 }
}

/**
 * 通过 webhook 触发任务 — 由 http-server 的 webhook 路由调用
 * 返回 { ok, error? } 供 HTTP 层决定响应状态码
 */
export async function triggerTaskByWebhook(
  taskId: string,
  providedSecret?: string,
  payload?: WebhookPayload
): Promise<{ ok: boolean; status: number; error?: string }> {
  const authorization = authorizeTaskWebhook(taskId, providedSecret)
  if (!authorization.ok) return authorization
  const task = getTask(taskId)
  if (!task) return { ok: false, status: 404, error: 'task not found' }

  // 后台执行（不阻塞 HTTP 响应）
  executeTask(taskId, { webhookPayload: payload }).catch(err => {
    console.error(`[Task] Webhook 触发执行异常: ${task.name}`, err)
  })
  console.log(`[Task] Webhook 触发: ${task.name}${payload?.body ? ` (body ${payload.body.length} 字符)` : ''}`)
  return { ok: true, status: 202 }  // 202 Accepted
}

function clearTaskTimer(taskId: string): void {
  const timer = timers.get(taskId)
  if (timer) {
    clearTimeout(timer)
    timers.delete(taskId)
  }
}

function abortRunningTask(taskId: string, reason: string): void {
  const controller = runningControllers.get(taskId)
  if (controller && !controller.signal.aborted) {
    controller.abort(taskAbortError(reason))
  }
}

/** disable/delete 的现有入口：同时清除尚未触发的 timer 并中止正在执行的同一任务。 */
export function unscheduleTask(taskId: string): void {
  clearTaskTimer(taskId)
  abortRunningTask(taskId, '任务已禁用或删除，执行已取消')
}

export function rescheduleTask(taskId: string): void {
  const task = getTask(taskId)
  if (!task) {
    unscheduleTask(taskId)
    return
  }

  updateTask(taskId, { nextRun: undefined })
  const fresh = getTask(taskId)
  if (!fresh?.enabled) {
    unscheduleTask(taskId)
    return
  }
  scheduleTask(fresh)
}

registerTaskSchedulerControl({
  schedule: scheduleTask,
  unschedule: unscheduleTask,
  reschedule: rescheduleTask
})

// ---- 生命周期 ----

export function initScheduler(getWindow?: () => BrowserWindow | null): void {
  schedulerShuttingDown = false
  _getWindow = getWindow || null

  // 1. 迁移旧数据（幂等）
  try {
    migrateLegacyTasks(
      () => readAllWorkspaceTriggers(),
      (workspaceId) => clearWorkspaceTriggers(workspaceId)
    )
  } catch (err: any) {
    console.warn('[Task] 迁移旧数据失败:', err.message)
  }

  // 2. 加载所有启用的任务
  const all = listTasks({ enabledOnly: true })
  console.log(`[Task] 初始化: ${all.length} 个启用任务`)

  const now = Date.now()
  for (const task of all) {
    if (task.trigger.type !== 'schedule') continue  // 仅调度 schedule 类型

    // 补执行错过的任务（nextRun 已过但不超过 24 小时）
    if (task.nextRun && task.nextRun < now && (now - task.nextRun) < 24 * 3600 * 1000) {
      console.log(`[Task] 补执行错过的任务: ${task.name} (原定 ${new Date(task.nextRun).toLocaleString('zh-CN')})`)
      executeTask(task.id).catch(err => {
        console.error(`[Task] 补执行异常: ${task.name}`, err)
      })
    } else {
      scheduleTask(task)
    }
  }
}

export function shutdownScheduler(): void {
  schedulerShuttingDown = true
  console.log(`[Task] 关闭调度器: 清除 ${timers.size} 个 timer，中止 ${runningControllers.size} 个运行中任务`)
  timers.forEach((timer) => clearTimeout(timer))
  timers.clear()
  runningControllers.forEach((_controller, taskId) => {
    abortRunningTask(taskId, '调度器已关闭，任务执行已取消')
  })
}

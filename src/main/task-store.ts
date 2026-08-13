/**
 * Task Store — 统一的任务抽象
 *
 * 合并了原 ScheduledTask（独立定时任务）和 WorkspaceTrigger（workspace 触发器）。
 * 存储路径: ~/.openpipal/tasks/{id}.json
 *
 * 设计原则：
 * - 任务 = 触发条件 × 执行目标 × prompt
 * - 触发条件可扩展：schedule / webhook / gate
 * - 执行目标通过 workspaceId（workspace 任务）或 agentId（全局任务）指定
 * - 向量化迁移：启动时自动把 scheduled-tasks/ 和 meta.json.triggers 迁进来
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, unlinkSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { randomUUID } from 'crypto'
import { dataPath } from './data-root'
import { getTasksRootPath } from './credential-paths'

const TASKS_DIR = getTasksRootPath()
const LEGACY_SCHEDULED_DIR = dataPath('scheduled-tasks')

// ---- 类型定义 ----

export interface ScheduleConfig {
  type: 'fixed' | 'interval' | 'cron'
  /** fixed: 时间 "HH:MM" */
  time?: string
  /** fixed: 星期几 ["mon","tue",...]，留空 = 每天 */
  days?: string[]
  /** interval: 毫秒 */
  intervalMs?: number
  /** cron: 5 字段表达式 */
  cron?: string
}

/** 触发条件 — discriminated union */
export type TaskTrigger =
  | { type: 'schedule'; schedule: ScheduleConfig }
  | { type: 'webhook'; secret?: string }  // URL 由 task.id 决定：/webhook/task/{id}
  | { type: 'gate'; metric: string; threshold: number }  // 预留

export interface TaskResult {
  status: 'success' | 'error'
  message?: string
  timestamp: number
}

/** 智能免打扰的单条审计记录 */
export interface SilentLogEntry {
  timestamp: number
  reason: string       // Agent 一句话理由（建议 30 字内）
  source?: string      // 事件来源简标签，如 "github" / "飞书"
}

export interface Task {
  id: string
  name: string
  enabled: boolean

  /** 任务所属角色（创建时记录，决定执行时生成的对话归属哪个角色视图） */
  role?: string

  /** 作用域 — 二选一或都不选（纯全局任务用当前角色） */
  workspaceId?: string  // 挂在 Workspace Agent 下
  agentId?: string      // 指定 Agent 模板（全局任务用）

  /** 触发条件 */
  trigger: TaskTrigger

  /** 要执行的 prompt */
  prompt: string

  /** 会话模式 */
  conversationMode: 'persistent' | 'per-run'
  boundConversationId?: string

  /** 智能免打扰：Agent 收到事件后可以判断是否打扰用户（默认启用）。
   *  开启后，Agent 在回复首行输出 `NO_REPLY: <理由>` 则该次执行被静默。
   */
  smartSilence?: boolean  // undefined = 启用（默认），false = 强制每次都通知

  /** 静默审计日志 — 每 Task 最多保留最近 50 条，自动滚动 */
  silentLog?: SilentLogEntry[]

  /** 执行记录 */
  lastRun?: number
  nextRun?: number
  lastResult?: TaskResult

  createdAt: number
  updatedAt: number
}

// ---- 内部工具 ----

function ensureDir(): void {
  if (!existsSync(TASKS_DIR)) mkdirSync(TASKS_DIR, { recursive: true })
}

function filePath(id: string): string {
  if (!/^[\w-]+$/.test(id)) throw new Error(`Invalid task ID: ${id}`)
  return join(TASKS_DIR, `${id}.json`)
}

function readTaskFile(id: string): Task | null {
  const fp = filePath(id)
  if (!existsSync(fp)) return null
  try {
    return JSON.parse(readFileSync(fp, 'utf-8'))
  } catch {
    return null
  }
}

function writeTaskFile(task: Task): void {
  ensureDir()
  writeFileSync(filePath(task.id), JSON.stringify(task, null, 2))
}

// ---- 导出 CRUD ----

export function listTasks(filter?: { workspaceId?: string; enabledOnly?: boolean }): Task[] {
  ensureDir()
  const files = readdirSync(TASKS_DIR).filter(f => f.endsWith('.json'))
  const tasks: Task[] = []

  for (const file of files) {
    try {
      const task: Task = JSON.parse(readFileSync(join(TASKS_DIR, file), 'utf-8'))
      if (filter?.workspaceId !== undefined && task.workspaceId !== filter.workspaceId) continue
      if (filter?.enabledOnly && !task.enabled) continue
      tasks.push(task)
    } catch {
      // skip corrupted
    }
  }

  return tasks.sort((a, b) => b.updatedAt - a.updatedAt)
}

export function getTask(id: string): Task | null {
  return readTaskFile(id)
}

export function createTask(data: Omit<Task, 'id' | 'createdAt' | 'updatedAt'>): Task {
  const now = Date.now()
  const task: Task = {
    ...data,
    id: randomUUID(),
    createdAt: now,
    updatedAt: now
  }
  writeTaskFile(task)
  const scope = task.workspaceId ? `ws=${task.workspaceId.slice(0,8)}` : (task.agentId ? `agent=${task.agentId}` : 'global')
  console.log(`[Task] 创建: ${task.name} (${scope})`)
  return task
}

export function updateTask(id: string, updates: Partial<Task>): Task | null {
  const existing = readTaskFile(id)
  if (!existing) return null

  const updated: Task = {
    ...existing,
    ...updates,
    id: existing.id,
    createdAt: existing.createdAt,
    updatedAt: Date.now()
  }

  writeTaskFile(updated)
  return updated
}

export function deleteTask(id: string): boolean {
  const fp = filePath(id)
  if (!existsSync(fp)) return false
  try {
    unlinkSync(fp)
    console.log(`[Task] 删除: ${id}`)
    return true
  } catch {
    return false
  }
}

export function recordTaskExecution(id: string, result: TaskResult, nextRun?: number): void {
  const task = readTaskFile(id)
  if (!task) return
  task.lastRun = result.timestamp
  task.lastResult = result
  if (nextRun !== undefined) task.nextRun = nextRun
  task.updatedAt = Date.now()
  writeTaskFile(task)
}

// ---- 迁移：从 scheduled-tasks/ 和 workspace triggers 迁入 ----

/**
 * 一次性迁移旧数据。幂等——已迁移的 workspace 会留下 _triggersMigrated 标记。
 */
export function migrateLegacyTasks(
  readWorkspaceTriggers: () => Array<{ workspaceId: string; triggers: any[] }>,
  markWorkspaceTriggersMigrated: (workspaceId: string) => void
): void {
  ensureDir()

  // 1. 迁移 scheduled-tasks/
  if (existsSync(LEGACY_SCHEDULED_DIR)) {
    const files = readdirSync(LEGACY_SCHEDULED_DIR).filter(f => f.endsWith('.json'))
    for (const file of files) {
      try {
        const legacyPath = join(LEGACY_SCHEDULED_DIR, file)
        const legacy = JSON.parse(readFileSync(legacyPath, 'utf-8'))
        // 只迁移 agent-chat 类型（notify/run-command 旧类型不再支持）
        if (legacy.action?.type !== 'agent-chat' || !legacy.action.prompt) {
          console.log(`[Task Migration] 跳过非 agent-chat 旧任务: ${legacy.name}`)
          continue
        }
        const newTask: Task = {
          id: legacy.id,
          name: legacy.name,
          enabled: legacy.enabled ?? true,
          agentId: legacy.action.agentId,
          trigger: { type: 'schedule', schedule: legacy.trigger },
          prompt: legacy.action.prompt,
          conversationMode: legacy.action.conversationId ? 'persistent' : 'per-run',
          boundConversationId: legacy.action.conversationId,
          lastRun: legacy.lastRun,
          nextRun: legacy.nextRun,
          lastResult: legacy.lastResult,
          createdAt: legacy.createdAt || Date.now(),
          updatedAt: legacy.updatedAt || Date.now()
        }
        // 如果目标文件已存在，跳过（幂等）
        if (!existsSync(filePath(newTask.id))) {
          writeTaskFile(newTask)
          console.log(`[Task Migration] 迁入独立任务: ${newTask.name}`)
        }
      } catch (err: any) {
        console.warn(`[Task Migration] 迁移文件失败 ${file}:`, err.message)
      }
    }
  }

  // 2. 迁移 workspace triggers
  const wsTriggers = readWorkspaceTriggers()
  for (const { workspaceId, triggers } of wsTriggers) {
    for (const trigger of triggers) {
      try {
        const newTask: Task = {
          id: trigger.id,
          name: trigger.name,
          enabled: trigger.enabled ?? true,
          workspaceId,
          trigger: { type: 'schedule', schedule: trigger.schedule },
          prompt: trigger.prompt,
          conversationMode: trigger.conversationMode || 'per-run',
          boundConversationId: trigger.boundConversationId,
          lastRun: trigger.lastRun,
          nextRun: trigger.nextRun,
          lastResult: trigger.lastResult,
          createdAt: trigger.createdAt || Date.now(),
          updatedAt: trigger.updatedAt || Date.now()
        }
        if (!existsSync(filePath(newTask.id))) {
          writeTaskFile(newTask)
          console.log(`[Task Migration] 迁入 workspace 触发器: ${newTask.name} → ws=${workspaceId.slice(0,8)}`)
        }
      } catch (err: any) {
        console.warn(`[Task Migration] 迁移触发器失败:`, err.message)
      }
    }
    markWorkspaceTriggersMigrated(workspaceId)
  }
}

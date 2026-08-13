/**
 * Memory Dreamer — 定期记忆整理（Auto Dreaming）
 *
 * 类似人脑的睡眠记忆巩固机制：
 * - extractMemories 是"白天"的即时记录（每轮对话后）
 * - autoDream 是"夜间"的深度整理（定期触发）
 *
 * 触发条件（最廉价先检查）：
 *   1. 时间门控：距上次整理 ≥ minHours（默认 24h）
 *   2. 会话门控：期间有 ≥ minSessions 次对话（默认 5 次）
 *   3. 锁门控：无其他进程在整理
 *
 * 四阶段整理流程：
 *   Phase 1 Orient     — 扫描现有记忆
 *   Phase 2 Gather     — 收集对话中的新信号
 *   Phase 3 Consolidate — 合并重复、更新过时、对话→全局提升
 *   Phase 4 Prune      — 精简索引、删除空文件
 *
 * 参考 CC-Source 的 autoDream.ts 设计。
 */

import { readFileSync, writeFileSync, existsSync, statSync, readdirSync, utimesSync } from 'fs'
import { join } from 'path'
import { isAutoMemoryEnabled } from './config-manager'
import {
  getMemoryRoot,
  getGlobalMemoryDir,
  getConversationMemoryDir,
  scanMemoryFiles,
  formatMemoryManifest,
  ensureMemoryDir,
  archiveStaleMemories,
  type MemoryHeader,
} from './memory-store'
import { dataPath } from './data-root'

// ---- Config ----

interface DreamConfig {
  minHours: number
  minSessions: number
}

const DEFAULTS: DreamConfig = {
  minHours: 24,
  minSessions: 5
}

const CONVERSATIONS_DIR = dataPath('conversations')
const LOCK_FILE = '.consolidate-lock'

// ---- Lock Mechanism ----

function getLockPath(): string {
  return join(getMemoryRoot(), LOCK_FILE)
}

/**
 * 读取上次整理完成的时间戳。
 * 锁文件的 mtime 就是 lastConsolidatedAt。文件不存在返回 0。
 */
function readLastConsolidatedAt(): number {
  const lockPath = getLockPath()
  if (!existsSync(lockPath)) return 0
  try {
    return statSync(lockPath).mtimeMs
  } catch {
    return 0
  }
}

/**
 * 尝试获取整理锁。成功返回 priorMtime（用于失败回滚），失败返回 null。
 */
function tryAcquireLock(): number | null {
  const lockPath = getLockPath()
  ensureMemoryDir(getMemoryRoot())

  const priorMtime = readLastConsolidatedAt()

  // 如果锁文件存在且不超过 1 小时，说明有其他进程在整理
  if (existsSync(lockPath)) {
    try {
      const content = readFileSync(lockPath, 'utf-8').trim()
      const lockTime = statSync(lockPath).mtimeMs
      const ageMs = Date.now() - lockTime
      if (ageMs < 3600_000 && content !== '') {
        console.log('[Dreamer] 锁被其他进程持有，跳过')
        return null
      }
    } catch { /* 锁文件损坏，可以覆盖 */ }
  }

  // 写入锁
  writeFileSync(lockPath, `${process.pid}`, 'utf-8')

  // 验证是否是自己拿到的锁（防竞争）
  try {
    const content = readFileSync(lockPath, 'utf-8').trim()
    if (content !== `${process.pid}`) {
      console.log('[Dreamer] 锁竞争失败')
      return null
    }
  } catch {
    return null
  }

  return priorMtime
}

/**
 * 回滚锁到之前的状态（失败时调用）
 */
function rollbackLock(priorMtime: number): void {
  const lockPath = getLockPath()
  try {
    if (priorMtime === 0) {
      // 之前没有锁，清除内容但保留文件
      writeFileSync(lockPath, '', 'utf-8')
    } else {
      // 恢复 mtime
      const time = new Date(priorMtime)
      utimesSync(lockPath, time, time)
    }
  } catch {
    // best effort
  }
}

/**
 * 整理完成，更新锁的 mtime 为当前时间
 */
function completeLock(): void {
  const lockPath = getLockPath()
  writeFileSync(lockPath, `${process.pid}:done`, 'utf-8')
  // mtime 自动更新为当前时间
}

// ---- Session Counting ----

/**
 * 统计上次整理后有多少次对话（按文件 mtime 判断）
 */
function countSessionsSince(sinceMs: number): string[] {
  if (!existsSync(CONVERSATIONS_DIR)) return []
  try {
    const files = readdirSync(CONVERSATIONS_DIR).filter((f) => f.endsWith('.json'))
    const touched: string[] = []
    for (const file of files) {
      try {
        const stat = statSync(join(CONVERSATIONS_DIR, file))
        if (stat.mtimeMs > sinceMs) {
          touched.push(file.replace('.json', ''))
        }
      } catch { /* skip */ }
    }
    return touched
  } catch {
    return []
  }
}

// ---- Dream Execution (via Evolver Agent) ----

async function executeDream(
  globalHeaders: MemoryHeader[],
  conversationData: { convId: string; headers: MemoryHeader[] }[]
): Promise<{ actionsApplied: number; summary: string }> {
  // 用 Evolver Agent 替代单次 LLM 调用。
  // Agent 直接用 read/write/grep/edit 工具操作 memory 文件，不需要 JSON 中间层。
  const globalManifest = formatMemoryManifest(globalHeaders)
  const conversationManifests = conversationData
    .filter((c) => c.headers.length > 0)
    .map((c) => `### 对话 ${c.convId.slice(0, 8)}...\n${formatMemoryManifest(c.headers)}`)
    .join('\n\n')

  const globalDir = getGlobalMemoryDir()

  // 组装上下文传给 Evolver（作为 "recent conversations" 部分）
  const contextMessages = [{
    role: 'user' as const,
    content: `自上次整理以来有 ${conversationData.length} 次对话。\n\n全局记忆目录: ${globalDir}\n\n## 现有全局记忆\n${globalManifest || '暂无'}\n\n## 对话级记忆\n${conversationManifests || '暂无'}`
  }]

  const { evolverDream } = await import('./evolver-agent') // 动态 import:不进 boot 解析路径
  // Dream only needs the memory tree; do not hand an unattended model the
  // whole application data root as its assignment.
  const result = await evolverDream(getMemoryRoot(), contextMessages)

  if (!result.success) {
    console.warn(`[Dreamer] Evolver 失败: ${result.error}`)
    return { actionsApplied: 0, summary: result.error || 'Evolver 执行失败' }
  }

  return { actionsApplied: 1, summary: 'Evolver Agent 完成记忆整理' }
}

// ---- Adaptive Forgetting (降级归档) ----

/**
 * 整理时的自适应遗忘:把全局记忆里过期的非核心记忆降级归档(可逆,移到 archive/)。
 *
 * 设计要点:
 * - 在 Evolver dream(语义合并/更新)之后运行——agent 刚刚 edit 过的文件 mtime 被刷新,
 *   不会被误归档;只有真正长期没人碰、也没在整理中被更新的过期记忆才会被降级。
 * - 只扫全局层:全局记忆是"每次对话都注入上下文"的那层,清理它收益最高。
 *   对话级记忆只在各自对话激活时加载,膨胀代价低,暂不在此处归档(引擎已支持,留待后续)。
 *
 * 对应睡眠科学的"突触降级"(Tononi & Cirelli 2014):整理 = 合并(agent) + 按比例修剪(此处)。
 */
function runArchivePass(baseSummary: string): { count: number; summary: string } {
  let count = 0
  try {
    const archived = archiveStaleMemories(getGlobalMemoryDir(), 'global')
    count = archived.length
    if (count > 0) {
      console.log(`[Dreamer] 归档 ${count} 条过期记忆: ${archived.map((a) => a.filename).join(', ')}`)
    }
  } catch (err: any) {
    console.warn(`[Dreamer] 归档失败: ${err.message}`)
  }
  const summary = count > 0 ? `${baseSummary}(归档 ${count} 条过期记忆)` : baseSummary
  return { count, summary }
}

// ---- Closure-scoped State ----

let dreamer: ((onComplete?: DreamCompleteCallback) => Promise<void>) | null = null

type DreamCompleteCallback = (result: { actionsApplied: number; summary: string }) => void
type DreamStatusCallback = (status: 'started' | 'completed' | 'failed', detail?: string) => void

let _onStatus: DreamStatusCallback | null = null

/** 注入状态通知回调（由 index.ts 在启动时调用） */
export function setDreamStatusCallback(cb: DreamStatusCallback): void {
  _onStatus = cb
}

// 扫描节流：时间门控通过但会话门控未通过时，防止每轮都重新扫描
const SCAN_THROTTLE_MS = 10 * 60 * 1000

/**
 * 初始化 Auto Dream 系统。应用启动时调用一次。
 */
export function initMemoryDreamer(): void {
  let lastScanAt = 0

  dreamer = async function runDream(onComplete) {
    if (!isAutoMemoryEnabled()) return

    // --- 时间门控 ---
    const lastAt = readLastConsolidatedAt()
    const hoursSince = (Date.now() - lastAt) / 3_600_000
    if (hoursSince < DEFAULTS.minHours) return

    // --- 扫描节流 ---
    if (Date.now() - lastScanAt < SCAN_THROTTLE_MS) return
    lastScanAt = Date.now()

    // --- 会话门控 ---
    const touchedSessions = countSessionsSince(lastAt)
    if (touchedSessions.length < DEFAULTS.minSessions) {
      console.log(
        `[Dreamer] 跳过 — ${touchedSessions.length} 次对话，需要 ${DEFAULTS.minSessions} 次`
      )
      return
    }

    // --- 锁门控 ---
    const priorMtime = tryAcquireLock()
    if (priorMtime === null) return

    console.log(
      `[Dreamer] 开始 — ${hoursSince.toFixed(1)}h 自上次整理，${touchedSessions.length} 次对话`
    )

    const startTime = Date.now()
    try {
      // Phase 1: Orient — 扫描所有记忆
      const globalHeaders = scanMemoryFiles(getGlobalMemoryDir())
      const conversationData: { convId: string; headers: MemoryHeader[] }[] = []

      for (const convId of touchedSessions) {
        const convDir = getConversationMemoryDir(convId)
        if (existsSync(convDir)) {
          const headers = scanMemoryFiles(convDir)
          if (headers.length > 0) {
            conversationData.push({ convId, headers })
          }
        }
      }

      const totalMemories = globalHeaders.length + conversationData.reduce((s, c) => s + c.headers.length, 0)
      if (totalMemories === 0) {
        console.log('[Dreamer] 无记忆可整理')
        completeLock()
        return
      }

      // Evolver Agent 整理(语义合并/更新)
      _onStatus?.('started', `分析 ${totalMemories} 条记忆...`)
      const result = await executeDream(globalHeaders, conversationData)

      // 自适应遗忘:整理后把过期非核心记忆降级归档(可逆)
      const { count: archivedCount, summary } = runArchivePass(result.summary)

      completeLock()
      const durationMs = Date.now() - startTime
      console.log(
        `[Dreamer] 完成 — ${result.actionsApplied} 操作, 归档 ${archivedCount} 条, ${durationMs}ms: ${result.summary}`
      )
      _onStatus?.('completed', summary)

      onComplete?.({ ...result, summary })
    } catch (err: any) {
      console.warn(`[Dreamer] 整理失败: ${err.message}`)
      _onStatus?.('failed', err.message)
      rollbackLock(priorMtime)
    }
  }

  console.log('[Dreamer] 已初始化')
}

// ---- Public API ----

/**
 * 尝试执行一次 Dream。由 chat 结束钩子调用（fire-and-forget）。
 * 门控条件不满足时为空操作。
 */
export async function executeAutoDream(
  onComplete?: DreamCompleteCallback
): Promise<void> {
  await dreamer?.(onComplete)
}

/**
 * 强制执行一次 Dream（忽略时间和会话门控，仅检查锁）。
 * 可由用户手动触发（如设置页的"立即整理"按钮）。
 */
export async function forceAutoDream(
  onComplete?: DreamCompleteCallback
): Promise<void> {
  if (!isAutoMemoryEnabled()) return

  const priorMtime = tryAcquireLock()
  if (priorMtime === null) {
    console.log('[Dreamer] 锁被持有，无法强制执行')
    return
  }

  console.log('[Dreamer] 强制执行 Dream')
  const startTime = Date.now()

  try {
    // 扫描所有对话（不限时间）
    const allSessions = countSessionsSince(0)
    const globalHeaders = scanMemoryFiles(getGlobalMemoryDir())
    const conversationData: { convId: string; headers: MemoryHeader[] }[] = []

    for (const convId of allSessions.slice(0, 20)) {
      const convDir = getConversationMemoryDir(convId)
      if (existsSync(convDir)) {
        const headers = scanMemoryFiles(convDir)
        if (headers.length > 0) {
          conversationData.push({ convId, headers })
        }
      }
    }

    const result = await executeDream(globalHeaders, conversationData)

    // 自适应遗忘:整理后把过期非核心记忆降级归档(可逆)
    const { count: archivedCount, summary } = runArchivePass(result.summary)

    completeLock()

    console.log(`[Dreamer] 强制完成 — ${result.actionsApplied} 操作, 归档 ${archivedCount} 条, ${Date.now() - startTime}ms`)
    onComplete?.({ ...result, summary })
  } catch (err: any) {
    console.warn(`[Dreamer] 强制执行失败: ${err.message}`)
    rollbackLock(priorMtime)
  }
}

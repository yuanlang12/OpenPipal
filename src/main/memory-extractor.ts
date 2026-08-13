/**
 * Memory Extractor — 自动记忆提取引擎（v2，forked-agent 模式）
 *
 * 对话结束后自动分析最近 N 条消息，由 evolver agent（带 read/write/edit 工具）
 * 决定要不要写记忆、写到哪。和 v1 的单轮 JSON 调用相比，关键区别：
 *
 *   v1: LLM 只看到记忆 manifest（文件名+一行描述）→ 凭文件名瞎判断要不要建新文件
 *   v2: agent 真去 read 候选重叠文件全文 → 看清内容后决定 create vs edit-merge
 *
 * 这把"多文件设计"的另一只脚补上：先看再写，自然防重复、能合并同主题信号。
 * 参考 CC-Source 的 forked agent 提取模式（runForkedAgent + memdir）。
 *
 * 状态隔离：
 * - 闭包游标 lastProcessedIndex
 * - 重叠保护：运行中不重叠，暂存最新上下文做尾随执行
 * - drainer：优雅关闭时等待进行中的提取
 */

import type { ChatMessage } from './agent-runtime/contracts'
import {
  getGlobalMemoryDir,
  getConversationMemoryDir,
  scanMemoryFiles,
  readMemoryFile,
  ensureMemoryDir,
  fixMemoryFrontmatterDate,
  type MemoryHeader
} from './memory-store'
import { existsSync } from 'fs'

// ---- Types ----

interface ExtractionContext {
  history: ChatMessage[]
  conversationId: string | null
  roleName: string
}

interface SavedMemory {
  name: string
  type: string
  scope: 'global' | 'conversation'
}

type OnCompleteCallback = (savedMemories: SavedMemory[]) => void

// ---- Snapshot / Diff Helpers ----
//
// agent 直接操作文件，没法像 v1 那样收集"哪些条被写入"。
// 我们用 mtime 快照 + 事后 diff 拿到"这次跑动了哪些文件"，
// 转成 SavedMemory[] 喂给 UI 通知。

interface DirSnapshot {
  // filename -> { mtimeMs, created }（created 用于编辑已有文件时保留原创建时间）
  files: Map<string, { mtimeMs: number; created?: string }>
}

function snapshotDir(dir: string): DirSnapshot {
  const files = new Map<string, { mtimeMs: number; created?: string }>()
  if (!existsSync(dir)) return { files }
  const headers = scanMemoryFiles(dir)
  for (const h of headers) {
    const full = readMemoryFile(h.filePath)
    files.set(h.filename, { mtimeMs: h.mtimeMs, created: full?.created })
  }
  return { files }
}

/**
 * 找出快照之后被 create/update 的 memory 文件。
 * 不返回纯删除——UI 通知里"已记住 X"更直观，删除事件交给 dream 摘要。
 *
 * 顺带修复 frontmatter 的 created/updated 日期——evolver agent 直接用 write/edit 工具
 * 写文件，日期完全由模型自由生成（曾出现幻觉未来日期）。这里用代码强制覆盖为真实时间，
 * 已有文件保留 diff 前快照到的旧 created，新文件 created=updated=现在。
 */
function diffChangedMemories(
  beforeSnap: DirSnapshot,
  afterHeaders: MemoryHeader[],
  scope: 'global' | 'conversation',
  startTime: number
): SavedMemory[] {
  const changes: SavedMemory[] = []
  for (const h of afterHeaders) {
    const prev = beforeSnap.files.get(h.filename)
    // 新文件 OR mtime 推进
    if (prev === undefined || h.mtimeMs > prev.mtimeMs) {
      // 防御：mtime 可能因其他进程恰好动过，加 startTime 下限
      if (h.mtimeMs >= startTime - 1000) {
        fixMemoryFrontmatterDate(h.filePath, prev?.created)
        const full = readMemoryFile(h.filePath)
        if (full) {
          changes.push({ name: full.name, type: full.type, scope })
        }
      }
    }
  }
  return changes
}

// ---- Closure-scoped State ----

let extractor: ((ctx: ExtractionContext, onComplete?: OnCompleteCallback) => Promise<void>) | null = null
let drainer: (timeoutMs?: number) => Promise<void> = async () => {}

/**
 * 初始化记忆提取系统。创建闭包隔离的可变状态。
 * 应用启动时调用一次。
 */
export function initMemoryExtractor(): void {
  const inFlightExtractions = new Set<Promise<void>>()
  // 每会话独立游标:避免文字/语音/切换会话之间互相错位(单一全局游标会让新会话 length-staleCursor<0 → 永远跳过)
  const lastProcessedByConv = new Map<string, number>()
  let inProgress = false
  let pendingContext: { ctx: ExtractionContext; onComplete?: OnCompleteCallback } | undefined

  async function runExtraction(
    ctx: ExtractionContext,
    onComplete?: OnCompleteCallback
  ): Promise<void> {
    const { history, conversationId, roleName } = ctx
    const cursorKey = conversationId || '__global__'
    const lastProcessedIndex = lastProcessedByConv.get(cursorKey) || 0

    // 门控：最少 2 条新消息
    const newMessageCount = history.length - lastProcessedIndex
    if (newMessageCount < 2) return

    inProgress = true
    const startTime = Date.now()

    try {
      const globalDir = getGlobalMemoryDir()
      const convDir = conversationId ? getConversationMemoryDir(conversationId) : null

      ensureMemoryDir(globalDir)
      if (convDir) ensureMemoryDir(convDir)

      // 快照：记下 agent 跑之前的目录状态
      const beforeGlobal = snapshotDir(globalDir)
      const beforeConv: DirSnapshot = convDir ? snapshotDir(convDir) : { files: new Map() }

      // 推进游标（在 agent 跑之前先推，避免重入时重复处理同一段历史）
      // 即使 agent 失败也不回滚——下一轮 LLM 会从新消息开始，避免无限重试卡死的对话
      lastProcessedByConv.set(cursorKey, history.length)

      // 调用 forked-agent 做提取(动态 import:evolver 链不进 boot 解析路径)
      const { evolverExtract } = await import('./evolver-agent')
      const result = await evolverExtract(
        globalDir,
        convDir,
        history,
        roleName,
        conversationId || undefined
      )

      if (!result.success) {
        console.warn(`[Memory Extractor] Evolver 失败: ${result.error || '未知错误'}`)
        return
      }

      // Diff：扫两个目录，找 mtime 推进 / 新增的文件
      const afterGlobal = scanMemoryFiles(globalDir)
      const afterConv = convDir ? scanMemoryFiles(convDir) : []

      const saved: SavedMemory[] = [
        ...diffChangedMemories(beforeGlobal, afterGlobal, 'global', startTime),
        ...diffChangedMemories(beforeConv, afterConv, 'conversation', startTime)
      ]

      const durationMs = Date.now() - startTime
      if (saved.length > 0) {
        console.log(
          `[Memory Extractor] 完成 — ${saved.length} 条记忆变更 (${durationMs}ms)`
        )
        onComplete?.(saved)
      } else {
        console.log(`[Memory Extractor] 完成 — 无新记忆 (${durationMs}ms)`)
      }
    } catch (err: any) {
      console.warn(`[Memory Extractor] 提取异常: ${err.message}`)
    } finally {
      inProgress = false

      // 尾随执行：处理运行期间暂存的上下文
      const trailing = pendingContext
      pendingContext = undefined
      if (trailing) {
        console.log('[Memory Extractor] 执行尾随提取')
        await runExtraction(trailing.ctx, trailing.onComplete)
      }
    }
  }

  // 公共入口
  extractor = async (ctx, onComplete) => {
    if (inProgress) {
      // 暂存最新上下文，等当前提取完成后尾随执行
      pendingContext = { ctx, onComplete }
      return
    }

    const p = runExtraction(ctx, onComplete)
    inFlightExtractions.add(p)
    try {
      await p
    } finally {
      inFlightExtractions.delete(p)
    }
  }

  drainer = async (timeoutMs = 60_000) => {
    if (inFlightExtractions.size === 0) return
    await Promise.race([
      Promise.all(inFlightExtractions).catch(() => {}),
      new Promise<void>((r) => setTimeout(r, timeoutMs))
    ])
  }

  console.log('[Memory Extractor] 已初始化 (v2: forked-agent mode)')
}

// ---- Public API ----

/**
 * 对话结束后调用。Fire-and-forget，不阻塞主流程。
 * initMemoryExtractor() 未调用前为空操作。
 */
export async function executeExtraction(
  history: ChatMessage[],
  conversationId: string | null,
  roleName: string,
  onComplete?: OnCompleteCallback
): Promise<void> {
  await extractor?.({ history, conversationId, roleName }, onComplete)
}

/**
 * 等待所有进行中的提取完成。优雅关闭时调用。
 */
export async function drainPendingExtraction(timeoutMs?: number): Promise<void> {
  await drainer(timeoutMs)
}

import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'fs'
import { join, extname } from 'path'
import { homedir } from 'os'
import { getAgentOutputsDir, listWorkspaces } from './agent-workspace-store'
import { getDataRoot } from './data-root'

export interface MemoryEntry {
  ts: number
  topic: string
  summary: string
  questions?: string[]
  tags: string[]
}

const OPENPIPAL_DIR = getDataRoot()
const MEMORY_DIR = join(OPENPIPAL_DIR, 'memory')

function getMemoryFile(role: string): string {
  const dir = join(MEMORY_DIR, role)
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
  return join(dir, 'memories.jsonl')
}

export function saveMemory(role: string, entry: Omit<MemoryEntry, 'ts'>): MemoryEntry {
  const full: MemoryEntry = { ts: Date.now(), ...entry }
  const file = getMemoryFile(role)
  appendFileSync(file, JSON.stringify(full) + '\n')
  console.log(`[Memory] 保存记忆: ${entry.topic} (${role})`)
  return full
}

export function loadAllMemories(role: string): MemoryEntry[] {
  const file = getMemoryFile(role)
  if (!existsSync(file)) return []
  try {
    const lines = readFileSync(file, 'utf-8').trim().split('\n').filter(Boolean)
    return lines.map((line) => JSON.parse(line))
  } catch {
    return []
  }
}

export function recallMemory(role: string, query: string, limit = 10): MemoryEntry[] {
  const all = loadAllMemories(role)
  if (!query.trim()) {
    // 没有关键词，返回最近的记忆
    return all.slice(-limit)
  }

  const keywords = query.toLowerCase().split(/\s+/).filter(Boolean)

  // 简单文本匹配打分
  const scored = all.map((entry) => {
    const text = `${entry.topic} ${entry.summary} ${(entry.tags || []).join(' ')} ${(entry.questions || []).join(' ')}`.toLowerCase()
    let score = 0
    for (const kw of keywords) {
      if (text.includes(kw)) score++
    }
    return { entry, score }
  })

  return scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score || b.entry.ts - a.entry.ts)
    .slice(0, limit)
    .map((s) => s.entry)
}

export function getRecentMemories(role: string, count = 5): MemoryEntry[] {
  const all = loadAllMemories(role)
  return all.slice(-count)
}

export function formatMemoriesForPrompt(memories: MemoryEntry[]): string {
  if (memories.length === 0) return ''

  const lines = memories.map((m) => {
    const date = new Date(m.ts).toLocaleDateString('zh-CN')
    const questions = m.questions?.length ? ` | 待解决：${m.questions.join('、')}` : ''
    return `- [${date}] ${m.topic}：${m.summary}${questions}`
  })

  return `\n\n你的记忆（近期与用户的交互摘要）：\n${lines.join('\n')}\n如果用户提到相关话题，可以基于这些记忆提供连续性的帮助。`
}

const GLOBAL_OUTPUTS_DIR = join(OPENPIPAL_DIR, 'outputs')

export interface OutputHistoryEntry {
  name: string
  path: string
  size: number
  updatedAt: number
  ext: string
  scope: 'global' | 'agent'
  workspaceId?: string
  workspaceName?: string
}

function listOutputFiles(
  dir: string,
  scope: OutputHistoryEntry['scope'],
  workspace?: { id: string; name: string }
): OutputHistoryEntry[] {
  if (!existsSync(dir)) return []
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter(entry => entry.isFile() && !entry.name.startsWith('.'))
      .flatMap(entry => {
        const filePath = join(dir, entry.name)
        try {
          const stat = statSync(filePath)
          return [{
            name: entry.name,
            path: filePath,
            size: stat.size,
            updatedAt: stat.mtimeMs,
            ext: extname(entry.name).slice(1).toLowerCase(),
            scope,
            workspaceId: workspace?.id,
            workspaceName: workspace?.name
          }]
        } catch {
          return []
        }
      })
  } catch {
    return []
  }
}

/**
 * 全局作品的文件索引。它只用于用户主动打开的全局入口，绝不回灌到某个会话的上下文或右侧摘要。
 * 它只在用户主动打开的全局入口调用，不会进入模型上下文或当前会话摘要。
 */
export function listOutputHistory(): OutputHistoryEntry[] {
  const entries = listOutputFiles(GLOBAL_OUTPUTS_DIR, 'global')
  try {
    for (const workspace of listWorkspaces()) {
      entries.push(...listOutputFiles(
        getAgentOutputsDir(workspace.id),
        'agent',
        { id: workspace.id, name: workspace.name }
      ))
    }
  } catch (err: any) {
    console.warn('[Output] 读取 Agent 产物索引失败:', err?.message)
  }
  return entries.sort((a, b) => b.updatedAt - a.updatedAt)
}

/**
 * 保存文档产物。
 * - 传 workspaceId → 写入 ~/.openpipal/agents/{id}/outputs/
 * - 不传 → 全局会话，写入 ~/.openpipal/outputs/
 * 按 Agent 隔离产物，避免跨 Agent 的文件混淆。
 */
export function saveOutput(title: string, content: string, workspaceId?: string): string {
  const outputsDir = workspaceId
    ? join(OPENPIPAL_DIR, 'agents', workspaceId, 'outputs')
    : GLOBAL_OUTPUTS_DIR
  if (!existsSync(outputsDir)) {
    mkdirSync(outputsDir, { recursive: true })
  }
  const date = new Date().toISOString().slice(0, 10)
  const safeTitle = title.replace(/[/\\:*?"<>|]/g, '_').slice(0, 50)
  const filename = `${date}_${safeTitle}.md`
  const filepath = join(outputsDir, filename)
  writeFileSync(filepath, content)
  console.log(`[Output] 已保存: ${filepath}`)
  return filepath
}

export function deleteMemory(role: string, timestamp: number): boolean {
  const all = loadAllMemories(role)
  const filtered = all.filter((m) => m.ts !== timestamp)
  if (filtered.length === all.length) return false
  const file = getMemoryFile(role)
  writeFileSync(file, filtered.map((m) => JSON.stringify(m)).join('\n') + (filtered.length ? '\n' : ''))
  console.log(`[Memory] 删除记忆: ts=${timestamp} (${role})`)
  return true
}

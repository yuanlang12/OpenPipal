/**
 * Agent Workspace Store
 *
 * 管理基于文件系统的 Agent 工作空间。
 * 每个 Agent 是一个目录，不同文件构成不同能力：
 *   agent.md  → 人格 / system prompt
 *   memory/   → 领域知识
 *   skills/   → 专属技能（Phase 3）
 *   tools/    → MCP 工具配置（Phase 3）
 *   tasks/    → 定时任务（Phase 3）
 *   artifacts/→ 产出物（Phase 3）
 *
 * 存储路径: ~/.openpipal/agents/{id}/
 * 历史路径: ~/.openpipal/workspaces/{id}/ (已自动迁移)
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, renameSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { randomUUID } from 'crypto'
import { listTasks } from './task-store'
import { dataPath } from './data-root'

/**
 * 旧 TaskTrigger 类型（用于迁移读取 meta.json.triggers 数组）。
 * 新任务系统使用 task-store.ts 的 TaskTrigger（discriminated union）。
 */
interface LegacyScheduleTrigger {
  type: 'fixed' | 'interval' | 'cron'
  cron?: string
  intervalMs?: number
  time?: string
  days?: string[]
}

const WORKSPACES_DIR = dataPath('agents')
const LEGACY_WORKSPACES_DIR = dataPath('workspaces')

/**
 * 从旧路径迁移：把 ~/.openpipal/workspaces/{id}/ 搬到 ~/.openpipal/agents/{id}/
 * 幂等 — 同名目录已存在则跳过
 * 依赖：必须在 migrateLegacyTemplates() 之后执行，否则 ~/.openpipal/agents/ 可能还混着 JSON 文件
 */
export function migrateLegacyWorkspaces(): void {
  if (!existsSync(LEGACY_WORKSPACES_DIR)) return
  try {
    const entries = readdirSync(LEGACY_WORKSPACES_DIR, { withFileTypes: true })
    const dirs = entries.filter(e => e.isDirectory())
    if (dirs.length === 0) return

    if (!existsSync(WORKSPACES_DIR)) mkdirSync(WORKSPACES_DIR, { recursive: true })
    let migrated = 0
    for (const entry of dirs) {
      const src = join(LEGACY_WORKSPACES_DIR, entry.name)
      const dst = join(WORKSPACES_DIR, entry.name)
      if (!existsSync(dst)) {
        renameSync(src, dst)
        migrated++
      }
    }
    if (migrated > 0) {
      console.log(`[Migration] 迁移 ${migrated} 个 Agent workspace: workspaces/ → agents/`)
    }
  } catch (err: any) {
    console.error('[Migration] 迁移 workspaces 失败:', err.message)
  }
}

// ---- Types ----

export interface WorkspaceTrigger {
  id: string
  type: 'schedule'                    // 未来扩展: 'webhook' | 'event'
  enabled: boolean
  name: string
  schedule: LegacyScheduleTrigger
  prompt: string
  conversationMode: 'persistent' | 'per-run'
  boundConversationId?: string
  lastRun?: number
  lastResult?: { status: 'success' | 'error'; message?: string; timestamp: number }
  nextRun?: number
  createdAt: number
  updatedAt: number
}

export interface WorkspaceMeta {
  id: string
  name: string
  icon: string
  description: string
  sourceConversationId?: string
  triggers?: WorkspaceTrigger[]
  createdAt: number
  updatedAt: number
}

export interface WorkspaceSummary {
  id: string
  name: string
  icon: string
  description: string
  createdAt: number
  updatedAt: number
  hasAgentMd: boolean
  memoryCount: number
  skillCount: number
  taskCount: number
}

export interface WorkspaceSkillInfo {
  name: string
  description: string
  content: string
}

export interface Workspace {
  meta: WorkspaceMeta
  agentMd: string
  meMd: string
  memories: { name: string; content: string }[]
  skills: WorkspaceSkillInfo[]
  toolsConfig: AgentToolsConfig
  dir: string
}

// ---- Helpers ----

function ensureDir(dir: string): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
}

function workspaceDir(id: string): string {
  return join(WORKSPACES_DIR, id)
}

/** 获取 workspace 目录的绝对路径（供 UI 展示和 reveal in Finder 使用） */
export function getWorkspaceDir(id: string): string {
  return workspaceDir(id)
}

function metaPath(id: string): string {
  return join(workspaceDir(id), 'meta.json')
}

function toolsDir(id: string): string {
  return join(workspaceDir(id), 'tools')
}

function toolsConfigPath(id: string): string {
  return join(toolsDir(id), 'config.json')
}

function meMdPath(id: string): string {
  return join(workspaceDir(id), 'me.md')
}

// ---- Tools config ----

export interface AgentToolsConfig {
  workingDir?: string
  mcpServers?: string[]        // 白名单：只允许这些 MCP server 的工具（空数组 = 全部允许）
  disabledTools?: string[]     // 黑名单：禁用这些内置工具
}

const DEFAULT_TOOLS_CONFIG: AgentToolsConfig = {}

export function readToolsConfig(id: string): AgentToolsConfig {
  const p = toolsConfigPath(id)
  if (!existsSync(p)) return { ...DEFAULT_TOOLS_CONFIG }
  try {
    return { ...DEFAULT_TOOLS_CONFIG, ...JSON.parse(readFileSync(p, 'utf-8')) }
  } catch (err: any) {
    console.warn(`[Workspace] tools/config.json 解析失败 (${id.slice(0, 8)}): ${err.message}`)
    return { ...DEFAULT_TOOLS_CONFIG }
  }
}

export function readMeMd(id: string): string {
  const p = meMdPath(id)
  if (!existsSync(p)) return ''
  try { return readFileSync(p, 'utf-8') } catch { return '' }
}

function agentMdPath(id: string): string {
  return join(workspaceDir(id), 'agent.md')
}

function memoryDir(id: string): string {
  return join(workspaceDir(id), 'memory')
}

function skillsDir(id: string): string {
  return join(workspaceDir(id), 'skills')
}

/** 每个 Agent 独立的产物目录 ~/.openpipal/agents/{id}/outputs/ */
export function getAgentOutputsDir(id: string): string {
  return join(workspaceDir(id), 'outputs')
}

/**
 * 为历史 Agent 补建 outputs/ 目录（幂等）。
 * 老 Agent 创建时没这目录，启动时扫一遍补齐。
 */
export function ensureAgentOutputsDirs(): void {
  if (!existsSync(WORKSPACES_DIR)) return
  try {
    const entries = readdirSync(WORKSPACES_DIR, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const outputsDir = join(WORKSPACES_DIR, entry.name, 'outputs')
      if (!existsSync(outputsDir)) mkdirSync(outputsDir, { recursive: true })
    }
  } catch (err: any) {
    console.error('[Migration] 补建 outputs 目录失败:', err.message)
  }
}

/** 解析 SKILL.md 的 YAML frontmatter */
function parseSkillFrontmatter(content: string): { name?: string; description?: string } {
  const match = content.match(/^---\n([\s\S]*?)\n---/)
  if (!match) return {}
  const result: Record<string, string> = {}
  for (const line of match[1].split('\n')) {
    const idx = line.indexOf(':')
    if (idx > 0) result[line.slice(0, idx).trim()] = line.slice(idx + 1).trim()
  }
  return result
}

/** 扫描 workspace 的 skills 目录，返回所有 skill 的内容和元数据 */
function scanWorkspaceSkills(id: string): WorkspaceSkillInfo[] {
  const dir = skillsDir(id)
  if (!existsSync(dir)) return []
  const result: WorkspaceSkillInfo[] = []
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const skillFile = join(dir, entry.name, 'SKILL.md')
      if (!existsSync(skillFile)) continue
      try {
        const content = readFileSync(skillFile, 'utf-8')
        const meta = parseSkillFrontmatter(content)
        result.push({
          name: meta.name || entry.name,
          description: meta.description || '',
          content
        })
      } catch { /* skip broken skills */ }
    }
  } catch { /* skip */ }
  return result
}

// ---- CRUD ----

export function createWorkspace(data: {
  name: string
  icon: string
  description: string
  sourceConversationId?: string
}): WorkspaceMeta {
  ensureDir(WORKSPACES_DIR)
  const now = Date.now()
  const meta: WorkspaceMeta = {
    id: randomUUID(),
    name: data.name,
    icon: data.icon,
    description: data.description,
    sourceConversationId: data.sourceConversationId,
    createdAt: now,
    updatedAt: now
  }

  const dir = workspaceDir(meta.id)
  mkdirSync(dir, { recursive: true })
  mkdirSync(join(dir, 'memory'), { recursive: true })
  mkdirSync(join(dir, 'skills'), { recursive: true })
  mkdirSync(join(dir, 'tools'), { recursive: true })
  mkdirSync(join(dir, 'workspace'), { recursive: true })
  mkdirSync(join(dir, 'outputs'), { recursive: true })

  writeFileSync(metaPath(meta.id), JSON.stringify(meta, null, 2))
  // 默认 workingDir 指向 Agent 自己的 workspace/ 目录
  const defaultConfig: AgentToolsConfig = { workingDir: join(dir, 'workspace') }
  writeFileSync(toolsConfigPath(meta.id), JSON.stringify(defaultConfig, null, 2))
  console.log(`[Workspace] 创建: ${meta.name} (${meta.id.substring(0, 8)})`)
  return meta
}

export function listWorkspaces(): WorkspaceSummary[] {
  ensureDir(WORKSPACES_DIR)
  const entries = readdirSync(WORKSPACES_DIR, { withFileTypes: true })
  const summaries: WorkspaceSummary[] = []

  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const mp = join(WORKSPACES_DIR, entry.name, 'meta.json')
    if (!existsSync(mp)) continue

    try {
      const meta: WorkspaceMeta = JSON.parse(readFileSync(mp, 'utf-8'))
      const amdPath = join(WORKSPACES_DIR, entry.name, 'agent.md')
      const memDir = join(WORKSPACES_DIR, entry.name, 'memory')

      let memoryCount = 0
      if (existsSync(memDir)) {
        memoryCount = readdirSync(memDir).filter(f => f.endsWith('.md') && f !== 'MEMORY.md').length
      }

      // 统计 skills 数量（每个 skill 是一个子目录，含 SKILL.md）
      const skDir = join(WORKSPACES_DIR, entry.name, 'skills')
      let skillCount = 0
      if (existsSync(skDir)) {
        try {
          for (const e of readdirSync(skDir, { withFileTypes: true })) {
            if (e.isDirectory() && existsSync(join(skDir, e.name, 'SKILL.md'))) skillCount++
          }
        } catch { /* skip */ }
      }

      // task-store 不依赖 workspace store，可以静态导入并让构建器纳入产物。
      let taskCount = 0
      try {
        taskCount = listTasks({ workspaceId: meta.id, enabledOnly: true }).length
      } catch { /* task-store 还未初始化或迁移未完成 */ }

      summaries.push({
        id: meta.id,
        name: meta.name,
        icon: meta.icon,
        description: meta.description,
        createdAt: meta.createdAt,
        updatedAt: meta.updatedAt,
        hasAgentMd: existsSync(amdPath),
        memoryCount,
        skillCount,
        taskCount
      })
    } catch { /* skip broken entries */ }
  }

  return summaries.sort((a, b) => b.updatedAt - a.updatedAt)
}

export function getWorkspace(id: string): Workspace | null {
  const mp = metaPath(id)
  if (!existsSync(mp)) return null

  try {
    const meta: WorkspaceMeta = JSON.parse(readFileSync(mp, 'utf-8'))
    const amdPath = agentMdPath(id)
    const agentMd = existsSync(amdPath) ? readFileSync(amdPath, 'utf-8') : ''

    const memories: { name: string; content: string }[] = []
    const mDir = memoryDir(id)
    if (existsSync(mDir)) {
      for (const f of readdirSync(mDir)) {
        if (f.endsWith('.md') && f !== 'MEMORY.md') {
          memories.push({
            name: f.replace(/\.md$/, ''),
            content: readFileSync(join(mDir, f), 'utf-8')
          })
        }
      }
    }

    const skills = scanWorkspaceSkills(id)

    return { meta, agentMd, meMd: readMeMd(id), memories, skills, toolsConfig: readToolsConfig(id), dir: workspaceDir(id) }
  } catch {
    return null
  }
}

export function deleteWorkspace(id: string): boolean {
  const dir = workspaceDir(id)
  if (!existsSync(dir)) return false

  rmSync(dir, { recursive: true, force: true })
  console.log(`[Workspace] 删除: ${id.substring(0, 8)}`)
  return true
}

export function writeAgentMd(id: string, content: string): void {
  const path = agentMdPath(id)
  writeFileSync(path, content)
  // 更新 meta.updatedAt
  touchMeta(id)
}

export function writeMeMd(id: string, content: string): void {
  if (!content) return
  writeFileSync(meMdPath(id), content)
  touchMeta(id)
}

export function writeWorkspaceMemory(id: string, fileName: string, content: string): void {
  const dir = memoryDir(id)
  ensureDir(dir)
  writeFileSync(join(dir, fileName.endsWith('.md') ? fileName : `${fileName}.md`), content)
  // 更新 MEMORY.md 索引
  rebuildMemoryIndex(id)
  touchMeta(id)
}

// ---- Legacy Workspace Triggers（仅供 task-store 一次性迁移使用） ----

/**
 * 读取所有 workspace 下 meta.json 里的 triggers 数组（用于迁移到 task-store）
 * 迁移完成后应调用 clearWorkspaceTriggers() 清理
 */
export function readAllWorkspaceTriggers(): Array<{ workspaceId: string; triggers: WorkspaceTrigger[] }> {
  ensureDir(WORKSPACES_DIR)
  const result: Array<{ workspaceId: string; triggers: WorkspaceTrigger[] }> = []
  try {
    for (const entry of readdirSync(WORKSPACES_DIR, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const mp = join(WORKSPACES_DIR, entry.name, 'meta.json')
      if (!existsSync(mp)) continue
      try {
        const meta: WorkspaceMeta = JSON.parse(readFileSync(mp, 'utf-8'))
        if (meta.triggers && meta.triggers.length > 0) {
          result.push({ workspaceId: meta.id, triggers: meta.triggers })
        }
      } catch { /* skip broken */ }
    }
  } catch { /* skip */ }
  return result
}

/** 从 meta.json 里清除 triggers 字段（迁移完成后调用，避免重复迁移） */
export function clearWorkspaceTriggers(workspaceId: string): void {
  const mp = metaPath(workspaceId)
  if (!existsSync(mp)) return
  try {
    const meta: WorkspaceMeta = JSON.parse(readFileSync(mp, 'utf-8'))
    if (meta.triggers) {
      delete meta.triggers
      meta.updatedAt = Date.now()
      writeFileSync(mp, JSON.stringify(meta, null, 2))
    }
  } catch { /* ignore */ }
}

// ---- Internal helpers ----

function touchMeta(id: string): void {
  const mp = metaPath(id)
  if (!existsSync(mp)) return
  try {
    const meta: WorkspaceMeta = JSON.parse(readFileSync(mp, 'utf-8'))
    meta.updatedAt = Date.now()
    writeFileSync(mp, JSON.stringify(meta, null, 2))
  } catch { /* ignore */ }
}

function rebuildMemoryIndex(id: string): void {
  const dir = memoryDir(id)
  if (!existsSync(dir)) return

  const files = readdirSync(dir).filter(f => f.endsWith('.md') && f !== 'MEMORY.md')
  const lines: string[] = []

  for (const f of files) {
    try {
      const content = readFileSync(join(dir, f), 'utf-8')
      // 从 YAML frontmatter 提取 description
      const descMatch = content.match(/^---[\s\S]*?description:\s*(.+)[\s\S]*?---/m)
      const desc = descMatch?.[1]?.trim() || f.replace(/\.md$/, '')
      const name = f.replace(/\.md$/, '')
      lines.push(`- [${name}](${f}) -- ${desc}`)
    } catch { /* skip */ }
  }

  writeFileSync(join(dir, 'MEMORY.md'), lines.join('\n') + '\n')
}

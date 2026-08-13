/**
 * Agent Template Manager
 * 管理用户手动创建的 Agent 模板（平面 JSON 文件）
 * 存储路径：~/.openpipal/agent-templates/{id}.json
 *
 * 历史路径：~/.openpipal/agents/{id}.json（已迁移到新路径）
 * 新的主概念 Agent 使用 ~/.openpipal/agents/{id}/（目录结构），见 agent-workspace-store.ts
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, unlinkSync, renameSync, statSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { randomUUID } from 'crypto'
import { dataPath } from './data-root'

const AGENTS_DIR = dataPath('agent-templates')
const LEGACY_AGENTS_DIR = dataPath('agents')

/**
 * 从旧路径迁移：把 ~/.openpipal/agents/*.json 搬到 ~/.openpipal/agent-templates/
 * 幂等 — 只搬 .json 文件，目录不动（workspace 使用）
 */
export function migrateLegacyTemplates(): void {
  if (!existsSync(LEGACY_AGENTS_DIR)) return
  try {
    const entries = readdirSync(LEGACY_AGENTS_DIR)
    const jsonFiles = entries.filter(f => {
      if (!f.endsWith('.json')) return false
      try { return statSync(join(LEGACY_AGENTS_DIR, f)).isFile() } catch { return false }
    })
    if (jsonFiles.length === 0) return

    if (!existsSync(AGENTS_DIR)) mkdirSync(AGENTS_DIR, { recursive: true })
    for (const file of jsonFiles) {
      const src = join(LEGACY_AGENTS_DIR, file)
      const dst = join(AGENTS_DIR, file)
      if (!existsSync(dst)) {
        renameSync(src, dst)
      }
    }
    console.log(`[Migration] 迁移 ${jsonFiles.length} 个 agent template: agents/*.json → agent-templates/`)
  } catch (err: any) {
    console.error('[Migration] 迁移 agent templates 失败:', err.message)
  }
}

export interface AgentTemplate {
  id: string
  name: string
  description: string
  icon: string
  systemPrompt: string
  workingDir?: string
  tools?: string[]
  createdAt: number
  updatedAt: number
}

export interface AgentTemplateSummary {
  id: string
  name: string
  description: string
  icon: string
  workingDir?: string
  createdAt: number
  updatedAt: number
}

function ensureDir(): void {
  if (!existsSync(AGENTS_DIR)) {
    mkdirSync(AGENTS_DIR, { recursive: true })
  }
}

function filePath(id: string): string {
  return join(AGENTS_DIR, `${id}.json`)
}

function readTemplate(id: string): AgentTemplate | null {
  const fp = filePath(id)
  if (!existsSync(fp)) return null
  try {
    return JSON.parse(readFileSync(fp, 'utf-8'))
  } catch {
    return null
  }
}

function writeTemplate(template: AgentTemplate): void {
  ensureDir()
  writeFileSync(filePath(template.id), JSON.stringify(template, null, 2))
}

export function listAgentTemplates(): AgentTemplateSummary[] {
  ensureDir()
  const files = readdirSync(AGENTS_DIR).filter(f => f.endsWith('.json'))
  const summaries: AgentTemplateSummary[] = []

  for (const file of files) {
    try {
      const t: AgentTemplate = JSON.parse(readFileSync(join(AGENTS_DIR, file), 'utf-8'))
      summaries.push({
        id: t.id,
        name: t.name,
        description: t.description,
        icon: t.icon,
        workingDir: t.workingDir,
        createdAt: t.createdAt,
        updatedAt: t.updatedAt
      })
    } catch {}
  }

  return summaries.sort((a, b) => b.updatedAt - a.updatedAt)
}

export function getAgentTemplate(id: string): AgentTemplate | null {
  return readTemplate(id)
}

export function createAgentTemplate(data: Omit<AgentTemplate, 'id' | 'createdAt' | 'updatedAt'>): AgentTemplate {
  const now = Date.now()
  const template: AgentTemplate = {
    ...data,
    id: randomUUID(),
    createdAt: now,
    updatedAt: now
  }
  writeTemplate(template)
  console.log(`[Agent] 创建模板: ${template.name} (${template.id.substring(0, 8)})`)
  return template
}

export function updateAgentTemplate(id: string, data: Partial<AgentTemplate>): AgentTemplate | null {
  const existing = readTemplate(id)
  if (!existing) return null
  const updated = { ...existing, ...data, id, updatedAt: Date.now() }
  writeTemplate(updated)
  return updated
}

export function deleteAgentTemplate(id: string): boolean {
  const fp = filePath(id)
  if (!existsSync(fp)) return false
  try {
    unlinkSync(fp)
    console.log(`[Agent] 删除模板: ${id}`)
    return true
  } catch {
    return false
  }
}

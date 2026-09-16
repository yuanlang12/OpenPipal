/**
 * 模板迁移（只剩迁移，没有 CRUD 了）：
 *   1. migrateLegacyTemplates：最早的 agents/*.json → agent-templates/*.json（腾出 agents/ 给目录式 Pal）
 *   2. migrateTemplatesIntoPals：agent-templates/*.json → agents/<id>/（统一身份第 5 段，第三种身份消失）
 * 两步都幂等，启动时按这个顺序跑一次；顺序见 index.ts。
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, renameSync, statSync } from 'fs'
import { join } from 'path'
import { dataPath } from './data-root'
import { createWorkspace, writeAgentMd } from './agent-workspace-store'

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

/** 模板文件的形状（平面 JSON）；只在迁移时读一次 */
interface AgentTemplate {
  id: string
  name: string
  description: string
  icon: string
  systemPrompt: string
  workingDir?: string
}

/**
 * 模板并入 Pal（统一身份第 5 段）：每个 agent-templates/<id>.json 迁成 agents/<id>/（meta.json + agent.md + tools/config.json），
 * id 不变，所以老会话 / 老任务里的 agentId 还能认出同一个 Pal。迁完把原文件改名成 .migrated 留底（不再当模板读）。
 * 幂等：agents/<id>/meta.json 已存在的跳过（用户后来删了这个 Pal 也不会被复活——文件已经改名）。
 */
export function migrateTemplatesIntoPals(): void {
  if (!existsSync(AGENTS_DIR)) return
  let migrated = 0
  for (const file of readdirSync(AGENTS_DIR)) {
    if (!file.endsWith('.json')) continue
    const src = join(AGENTS_DIR, file)
    try {
      if (!statSync(src).isFile()) continue
      const template = JSON.parse(readFileSync(src, 'utf-8')) as AgentTemplate
      if (!template || typeof template.id !== 'string' || !/^[A-Za-z0-9_-]+$/.test(template.id)) continue
      const palDir = join(LEGACY_AGENTS_DIR, template.id)
      if (!existsSync(join(palDir, 'meta.json'))) {
        const meta = createWorkspace({ id: template.id, name: template.name || '未命名 Pal', icon: template.icon || '🤖', description: template.description || '' })
        writeAgentMd(meta.id, (template.systemPrompt || '').trimEnd() + '\n')
        if (template.workingDir) writeFileSync(join(palDir, 'tools', 'config.json'), JSON.stringify({ workingDir: template.workingDir }, null, 2))
      }
      renameSync(src, `${src}.migrated`)
      migrated += 1
    } catch (err: any) {
      console.error(`[Migration] 模板 ${file} 并入 Pal 失败:`, err.message)
    }
  }
  if (migrated > 0) console.log(`[Migration] ${migrated} 个模板并入 Pal: agent-templates/*.json → agents/<id>/`)
}

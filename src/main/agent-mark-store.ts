import fs from 'fs'
import { join, sep } from 'path'
import { dataPath } from './data-root'
import { readRoleManifest, writeRoleManifest } from './role-manager'

/**
 * 捏头像的落盘 —— 两种 Agent，两个根目录，同一条文件式约定（文件存在即生效）。
 *
 *   role  → ~/.openpipal/system-agents/<role>/mark.json   （内置六角色，同 layout.json）
 *   agent → ~/.openpipal/agents/<uuid>/mark.json          （用户自建的 Agent workspace）
 *
 * 两边都不给各自的配置 schema 加字段：内置角色不动 agent.md，自建 Agent 不动 meta.json。
 * 删掉 mark.json 就回落默认，这是"默认 opt-in、不启用时代码路径走不到"的具体形态。
 */

export type MarkScope = 'role' | 'agent'

const MARK_FILE = 'mark.json'
const SLUG = /^[a-z][a-z0-9-]{0,31}$/
/** workspace id 是 randomUUID()，用严格 UUID 卡住，路径穿越无从谈起 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** 值只做形状校验：认不认得出这个配饰归渲染层判，主进程只保证是短 slug。 */
function sanitize(value: unknown): Record<string, string> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const clean: Record<string, string> = {}
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (!SLUG.test(k)) return null
    if (typeof v !== 'string' || !SLUG.test(v)) return null
    clean[k] = v
  }
  return clean
}

function agentMarkPath(id: string): string | null {
  if (!UUID.test(id)) return null
  const root = dataPath('agents')
  const dir = join(root, id)
  try {
    if (!fs.existsSync(dir)) return null
    const realRoot = fs.realpathSync(root)
    const realDir = fs.realpathSync(dir)
    // 目录被软链接指到别处就拒绝——和 readRoleManifest 同一道闸
    if (realDir !== join(realRoot, id) || !realDir.startsWith(realRoot + sep)) return null
    return join(realDir, MARK_FILE)
  } catch {
    return null
  }
}

export function readMark(scope: MarkScope, id: string): Record<string, string> | null {
  if (scope === 'role') return readRoleManifest(id, MARK_FILE)
  const path = agentMarkPath(id)
  if (!path) return null
  try {
    if (!fs.existsSync(path)) return null
    const info = fs.lstatSync(path)
    if (!info.isFile() || info.isSymbolicLink()) return null
    return sanitize(JSON.parse(fs.readFileSync(path, 'utf8')))
  } catch (err) {
    console.warn(`[Mark] 读 agents/${id}/${MARK_FILE} 失败:`, (err as Error)?.message)
    return null
  }
}

export function writeMark(scope: MarkScope, id: string, value: unknown): boolean {
  const clean = sanitize(value)
  if (!clean) return false
  if (scope === 'role') return writeRoleManifest(id, MARK_FILE, clean)
  const path = agentMarkPath(id)
  if (!path) return false
  try {
    fs.writeFileSync(path, `${JSON.stringify(clean, null, 2)}\n`, 'utf8')
    return true
  } catch (err) {
    console.warn(`[Mark] 写 agents/${id}/${MARK_FILE} 失败:`, (err as Error)?.message)
    return false
  }
}

import fs from 'fs'
import { join, sep } from 'path'
import { dataPath } from './data-root'

/**
 * agents/<uuid>/mark.json 与 teams/<uuid>/mark.json 的读写——文件式约定（文件存在即生效）的落盘一处。
 *
 * 从 agent-mark-store 里拆出来，是因为那边还管内置角色（走 role-manager，连着整个角色加载器），
 * 而团队 store 建成员时也要写这个文件：它只需要这个文件的格式与路径闸，不该把角色加载器整个拖进来。
 */

export type FileMarkScope = 'agent' | 'team'

const MARK_FILE = 'mark.json'
const SLUG = /^[a-z][a-z0-9-]{0,31}$/
/** workspace / team id 是 randomUUID()，用严格 UUID 卡住，路径穿越无从谈起 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** 值只做形状校验：认不认得出这个配饰归渲染层判，主进程只保证是短 slug。 */
export function sanitizeMark(value: unknown): Record<string, string> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const clean: Record<string, string> = {}
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (!SLUG.test(k)) return null
    if (typeof v !== 'string' || !SLUG.test(v)) return null
    clean[k] = v
  }
  return clean
}

/** agent / team 同一条闸：uuid 目录名、目录真在根下、不是软链接指出去的 */
function markPath(scope: FileMarkScope, id: string): string | null {
  if (!UUID.test(id)) return null
  const root = dataPath(scope === 'team' ? 'teams' : 'agents')
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

export function readMarkFile(scope: FileMarkScope, id: string): Record<string, string> | null {
  const path = markPath(scope, id)
  if (!path) return null
  try {
    if (!fs.existsSync(path)) return null
    const info = fs.lstatSync(path)
    if (!info.isFile() || info.isSymbolicLink()) return null
    return sanitizeMark(JSON.parse(fs.readFileSync(path, 'utf8')))
  } catch (err) {
    console.warn(`[Mark] 读 ${scope}s/${id}/${MARK_FILE} 失败:`, (err as Error)?.message)
    return null
  }
}

export function writeMarkFile(scope: FileMarkScope, id: string, value: unknown): boolean {
  const clean = sanitizeMark(value)
  if (!clean) return false
  const path = markPath(scope, id)
  if (!path) return false
  try {
    fs.writeFileSync(path, `${JSON.stringify(clean, null, 2)}\n`, 'utf8')
    return true
  } catch (err) {
    console.warn(`[Mark] 写 ${scope}s/${id}/${MARK_FILE} 失败:`, (err as Error)?.message)
    return false
  }
}

import { readRoleManifest, writeRoleManifest } from './role-manager'
import { readMarkFile, sanitizeMark, writeMarkFile } from './agent-mark-file'

/**
 * 捏头像的落盘 —— 三种作用域，同一条文件式约定（文件存在即生效）。
 *
 *   role  → ~/.openpipal/system-agents/<role>/mark.json   （内置六角色，同 layout.json）
 *   agent → ~/.openpipal/agents/<uuid>/mark.json          （用户自建的 Agent workspace）
 *   team  → ~/.openpipal/teams/<uuid>/mark.json
 *
 * 各边都不给各自的配置 schema 加字段：内置角色不动 agent.md，自建 Agent 不动 meta.json。
 * 删掉 mark.json 就回落默认，这是"默认 opt-in、不启用时代码路径走不到"的具体形态。
 * agent / team 的路径闸与格式在 agent-mark-file（团队 store 建成员时直接写那边，不经这里、不拖角色加载器）。
 */

export type MarkScope = 'role' | 'agent' | 'team'

const MARK_FILE = 'mark.json'

export function readMark(scope: MarkScope, id: string): Record<string, string> | null {
  if (scope === 'role') return readRoleManifest(id, MARK_FILE)
  return readMarkFile(scope, id)
}

export function writeMark(scope: MarkScope, id: string, value: unknown): boolean {
  if (scope === 'role') {
    const clean = sanitizeMark(value)
    return clean ? writeRoleManifest(id, MARK_FILE, clean) : false
  }
  return writeMarkFile(scope, id, value)
}

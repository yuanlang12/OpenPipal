/**
 * "这个 id 是不是一个 Pal"——只看 agents/<id>/meta.json 在不在，不读内容。
 * 单独一个小模块：conversation-store / task-store / agent-workspace-store 都要用，而它们之间有引用环。
 *
 * 老记录里的 `agentId` 曾经指"模板"（agent-templates/<id>.json）；模板并入 Pal 后（统一身份第 5 段）同一个 id 就是
 * agents/<id>/，读侧用 palIdOf 把它当 workspaceId 看，文件不改。
 */
import { existsSync } from 'fs'
import { join } from 'path'
import { dataPath } from './data-root'

export function isPalId(id: unknown): id is string {
  return typeof id === 'string' && /^[A-Za-z0-9_-]+$/.test(id) && existsSync(join(dataPath('agents'), id, 'meta.json'))
}

/** 记录属于哪个 Pal：workspaceId 优先；老的 agentId（模板已并入 Pal）能认出是 Pal 就算 */
export function palIdOf(record: { workspaceId?: string; agentId?: string }): string | undefined {
  if (record.workspaceId) return record.workspaceId
  return isPalId(record.agentId) ? record.agentId : undefined
}

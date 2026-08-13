import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import { listMcpSkillDirs } from './mcp-manager'
import { listPluginSkillDirs } from './plugin-manager'
import { dataPath } from './data-root'

export const DEFAULT_DISABLED_BUILTINS = ['doc', 'slides', 'spreadsheet', 'pdf']

export function getBuiltInSkillsDir(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'skills')
    : join(app.getAppPath(), 'resources', 'skills')
}

export function getBuiltInRoleSkillsDir(roleName: string): string | null {
  if (!/^[a-z0-9_-]+$/i.test(roleName)) return null
  return app.isPackaged
    ? join(process.resourcesPath, 'system-agents', roleName, 'skills')
    : join(app.getAppPath(), 'resources', 'system-agents', roleName, 'skills')
}

export function getUserSkillsDir(): string {
  return dataPath('skills')
}

export function getAgentSkillsDir(workspaceId: string): string {
  return dataPath('agents', workspaceId, 'skills')
}

export function getSkillsConfigPath(): string {
  return dataPath('skills.config.json')
}

export function readDisabledSkillNames(): string[] {
  const configPath = getSkillsConfigPath()
  if (!existsSync(configPath)) return [...DEFAULT_DISABLED_BUILTINS]
  try {
    const parsed = JSON.parse(readFileSync(configPath, 'utf8'))
    return Array.isArray(parsed?.disabled)
      ? parsed.disabled.filter((value: unknown): value is string => typeof value === 'string')
      : [...DEFAULT_DISABLED_BUILTINS]
  } catch {
    return [...DEFAULT_DISABLED_BUILTINS]
  }
}

export function listGlobalSkillDirs(): string[] {
  return [
    getBuiltInSkillsDir(),
    getUserSkillsDir(),
    ...listPluginSkillDirs(),
    ...listMcpSkillDirs()
  ]
}

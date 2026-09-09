import { existsSync, readFileSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
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

/**
 * 技能自己在 SKILL.md 里声明 `metadata.agent-scope: all` = 每个独立智能体都看得见（文件式，不加配置字段）。
 * 给的是"产品能力说明"这类技能（hook-creator：怎么把规则递交给 set_rule）——它讲的是每个 Agent 都有的工具，
 * 不是某个领域的做事方法，隔离到各自目录里反而让独立智能体不会用自己已有的工具。
 * 两条运行时（pi-core 的 loadPiCoreSkillCatalog、legacy 的 skill-manager）都从这里判，模型看到的才是同一份。
 * 只认 frontmatter 里 `metadata:` 块下缩进的 `agent-scope: all` 这一种写法：这里在 pi-core 的源码图里，
 * 不能引 pi-coding-agent 的 YAML 解析器，一个键不值得再拖一个解析器进来。
 */
export function isAgentWideSkillFile(skillFilePath: string): boolean {
  // 只有产品自带的和用户自己写的技能可以这样声明：插件带的、MCP 服务器同步下来的（skills/_mcp/）是第三方内容，
  // 不许凭 frontmatter 一句话把自己塞进每个独立智能体的系统提示
  if (!isFirstPartyOrUserSkill(skillFilePath)) return false
  let source: string
  try {
    source = readFileSync(skillFilePath, 'utf8')
  } catch {
    return false
  }
  const frontmatter = source.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  if (!frontmatter) return false
  let inMetadata = false
  for (const line of frontmatter[1].split(/\r?\n/)) {
    if (!line.trim()) continue                                  // 空行不算离开块（YAML 里合法）
    if (/^metadata:\s*$/.test(line)) { inMetadata = true; continue }
    if (!/^\s/.test(line)) { inMetadata = false; continue }   // 回到顶层键就离开了 metadata 块
    if (inMetadata && /^\s+agent-scope:\s*all\s*$/.test(line)) return true
  }
  return false
}

const under = (file: string, dir: string): boolean => resolve(file).startsWith(resolve(dir) + sep)

/** 产品自带（resources/skills）或用户自己的技能目录里、且不在 MCP 同步区（_mcp/）的 */
function isFirstPartyOrUserSkill(skillFilePath: string): boolean {
  if (under(skillFilePath, getBuiltInSkillsDir())) return true
  const userDir = getUserSkillsDir()
  return under(skillFilePath, userDir) && !under(skillFilePath, join(userDir, '_mcp'))
}

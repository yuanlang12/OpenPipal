/**
 * 全局 Agent（built-in role）文件化加载器
 *
 * 真相来源：~/.openpipal/system-agents/<role>/agent.md
 * 格式：YAML frontmatter（元数据）+ markdown body（system prompt）
 *
 * 示例：
 *   ---
 *   name: design
 *   displayName: 设计助手
 *   icon: 🎨
 *   tools: ask_user, questions_v2, web_search, create_artifact
 *   ---
 *   [prompt 正文]
 *
 * 特殊值：
 *   tools: *            → 继承 COMMON_TOOLS
 *   tools: *, new_tool  → 继承 COMMON_TOOLS 再加 new_tool
 *   tools: a, b, c      → 只这三个
 *   memory: off         → 关闭该角色的记忆注入 + 自动抽取（缺省/其它值 = 开）
 *
 * 行为：
 *   - 首次启动 / 文件缺失 → seedSystemAgents() 把代码里的 BUILTIN_ROLES 种子写到磁盘
 *   - 读取时：先尝试文件；解析失败 / 文件不存在 → fallback 到代码种子
 *   - 这样改文件立即生效、删文件也能自愈
 */

import * as fs from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { app } from 'electron'
import type { RoleConfig } from './role-manager'
import { dataPath } from './data-root'

const SYSTEM_AGENTS_DIR = dataPath('system-agents')

/**
 * resources/system-agents/<role>/ —— 角色的 seed 资源目录
 * 用于装 agent.md 之外的辅助文件（layout.json、cave-prompt.md 等）
 * 生产：process.resourcesPath/system-agents/<role>
 * 开发：<repo>/resources/system-agents/<role>
 */
function getRoleSeedDir(roleName: string): string | null {
  const candidates = [
    process.resourcesPath ? join(process.resourcesPath, 'system-agents', roleName) : null,
    join(app.getAppPath(), 'resources', 'system-agents', roleName)
  ].filter(Boolean) as string[]
  for (const dir of candidates) {
    if (fs.existsSync(dir)) return dir
  }
  return null
}

interface ParsedMd {
  frontmatter: Record<string, string>
  body: string
}

/**
 * 极简 YAML frontmatter 解析——只支持 `key: value` 和 `key: a, b, c` 形式
 * 不支持嵌套、列表字面量（[a,b]）、引号转义等复杂语法——我们用不到
 */
function parseFrontmatter(content: string): ParsedMd {
  const lines = content.split('\n')
  if (lines[0]?.trim() !== '---') {
    return { frontmatter: {}, body: content }
  }
  const frontmatter: Record<string, string> = {}
  let endIdx = -1
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') { endIdx = i; break }
    const m = lines[i].match(/^([a-zA-Z_][\w-]*)\s*:\s*(.*)$/)
    if (m) {
      const key = m[1].trim()
      let value = m[2].trim()
      // 去掉可能的首尾引号
      if ((value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1)
      }
      frontmatter[key] = value
    }
  }
  if (endIdx === -1) return { frontmatter: {}, body: content }
  const body = lines.slice(endIdx + 1).join('\n').replace(/^\n+/, '')
  return { frontmatter, body }
}

/**
 * 解析 tools 字段。支持 `*`（继承 common）和 `*, a, b`（继承 common 再加 a b）
 */
function parseTools(raw: string | undefined, commonTools: string[]): string[] {
  if (!raw) return commonTools.slice()
  const items = raw.split(',').map(s => s.trim()).filter(Boolean)
  if (items.length === 0) return commonTools.slice()
  const set = new Set<string>()
  for (const item of items) {
    if (item === '*') {
      for (const t of commonTools) set.add(t)
    } else {
      set.add(item)
    }
  }
  return Array.from(set)
}

function agentMdPath(roleName: string): string {
  return join(SYSTEM_AGENTS_DIR, roleName, 'agent.md')
}

/**
 * 解析 frontmatter `memory` 字段 → memoryEnabled。
 * 'off' / 'false' / 'disabled'（大小写不敏感）→ false；缺省/其它值 → true
 * 纯函数，供单测直接覆盖 off/缺省/怪值三种输入
 */
export function parseMemoryEnabled(raw: string | undefined): boolean {
  if (!raw) return true
  const v = raw.trim().toLowerCase()
  return v !== 'off' && v !== 'false' && v !== 'disabled'
}

/**
 * 把一个 RoleConfig 序列化成 agent.md 文件内容（种子时用）
 */
function roleConfigToMd(role: RoleConfig, commonTools: string[]): string {
  // 如果 tools 等于 common → 写 `*`；否则尝试算差集压缩
  let toolsLine = ''
  const roleSet = new Set(role.tools)
  const commonSet = new Set(commonTools)
  const isSupersetOfCommon = commonTools.every(t => roleSet.has(t))
  if (isSupersetOfCommon) {
    const extra = role.tools.filter(t => !commonSet.has(t))
    toolsLine = extra.length > 0 ? `*, ${extra.join(', ')}` : '*'
  } else {
    toolsLine = role.tools.join(', ')
  }
  // memoryEnabled === false 才写这行——其它角色输出保持不变（不多一行整洁度）
  const memoryLine = role.memoryEnabled === false ? [`memory: off`] : []
  return [
    '---',
    `name: ${role.name}`,
    `displayName: ${role.displayName}`,
    `icon: ${role.icon}`,
    `tools: ${toolsLine}`,
    ...memoryLine,
    '---',
    '',
    role.systemPrompt
  ].join('\n')
}

/**
 * 从磁盘读取角色——失败返回 null 由调用方 fallback
 */
export function loadRoleFromDisk(
  roleName: string,
  commonTools: string[]
): RoleConfig | null {
  const p = agentMdPath(roleName)
  if (!fs.existsSync(p)) return null
  try {
    const raw = fs.readFileSync(p, 'utf8')
    const { frontmatter, body } = parseFrontmatter(raw)
    if (!body.trim()) {
      console.warn(`[RoleLoader] ${roleName}/agent.md body 为空，放弃`)
      return null
    }
    return {
      name: frontmatter.name || roleName,
      displayName: frontmatter.displayName || roleName,
      icon: frontmatter.icon || '🤖',
      systemPrompt: body.trim(),
      tools: parseTools(frontmatter.tools, commonTools),
      memoryEnabled: parseMemoryEnabled(frontmatter.memory)
    }
  } catch (err: any) {
    console.warn(`[RoleLoader] 读取 ${roleName}/agent.md 失败:`, err?.message)
    return null
  }
}

/** SHA-256 摘要（种子对账用） */
function sha256(s: string): string {
  return require('crypto').createHash('sha256').update(s).digest('hex')
}

/**
 * 种子文件写入/自愈升级三态（agent.md 与辅助文件共用一套语义）：
 * 不存在 → 写入+记 hash；有 hash 且未被用户改过 → 新种子自动覆盖升级；
 * 无 hash 的存量文件内容恰好等于当前种子 → 补记 hash 打通后续升级通路；其余 → 用户权威不动。
 */
function seedFileWithSelfHeal(seedContent: string, dstPath: string, hashPath: string, logLabel: string): void {
  if (!fs.existsSync(dstPath)) {
    fs.writeFileSync(dstPath, seedContent, 'utf8')
    fs.writeFileSync(hashPath, sha256(seedContent), 'utf8')
    console.log(`[RoleLoader] 种子: ${logLabel} 已写入`)
    return
  }
  const current = fs.readFileSync(dstPath, 'utf8')
  if (fs.existsSync(hashPath)) {
    const recorded = fs.readFileSync(hashPath, 'utf8').trim()
    if (sha256(current) === recorded && current !== seedContent) {
      fs.writeFileSync(dstPath, seedContent, 'utf8')
      fs.writeFileSync(hashPath, sha256(seedContent), 'utf8')
      console.log(`[RoleLoader] 种子升级: ${logLabel}（未被用户修改，已更新到新版）`)
    }
  } else if (current === seedContent) {
    fs.writeFileSync(hashPath, sha256(seedContent), 'utf8')
  }
}

function seedRoleExtraFiles(roleName: string, targetDir: string): void {
  const seedDir = getRoleSeedDir(roleName)
  if (!seedDir) return
  try {
    const files = fs.readdirSync(seedDir)
    for (const f of files) {
      if (f === 'agent.md') continue  // agent.md 由 seedSystemAgents 主流程处理
      const src = join(seedDir, f)
      try {
        if (!fs.statSync(src).isFile()) continue
        // hash 自愈升级（与 agent.md 同一套 seedFileWithSelfHeal，2026-07-22 补齐——此前
        // "存在即跳过"导致 preflow.json 等辅助文件的种子更新永远到不了存量安装）
        seedFileWithSelfHeal(fs.readFileSync(src, 'utf8'), join(targetDir, f), join(targetDir, `.${f}.seedhash`), `${roleName}/${f}`)
      } catch (err: any) {
        console.warn(`[RoleLoader] 种子 ${roleName}/${f} 失败:`, err?.message)
      }
    }
  } catch (err: any) {
    console.warn(`[RoleLoader] 读取 ${roleName} 种子目录失败:`, err?.message)
  }
}

/**
 * 首次启动把代码种子写到磁盘——已存在的文件不覆盖（保留用户修改）
 * 1) agent.md：来自代码里的 BUILTIN_ROLES
 * 2) 其他辅助文件（layout.json 等）：来自 resources/system-agents/<role>/
 */
export function seedSystemAgents(
  builtinRoles: Record<string, RoleConfig>,
  commonTools: string[]
): void {
  try {
    fs.mkdirSync(SYSTEM_AGENTS_DIR, { recursive: true })
  } catch {}

  for (const [name, role] of Object.entries(builtinRoles)) {
    const targetDir = join(SYSTEM_AGENTS_DIR, name)
    try {
      fs.mkdirSync(targetDir, { recursive: true })
    } catch {}

    // 1) agent.md：与辅助文件共用 seedFileWithSelfHeal 三态（收敛前两处逻辑已分裂——
    //    agent.md 缺"存量文件内容==种子→补记 hash"的收养分支，老安装永远进不了自愈通路）
    try {
      seedFileWithSelfHeal(roleConfigToMd(role, commonTools), agentMdPath(name), join(targetDir, '.agent.md.seedhash'), `${name}/agent.md`)
    } catch (err: any) {
      console.warn(`[RoleLoader] 种子 ${name}/agent.md 失败:`, err?.message)
    }

    // 2) 辅助文件（layout.json 等）
    seedRoleExtraFiles(name, targetDir)
  }
}

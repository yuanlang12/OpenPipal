/**
 * Skill Manager — Stage 1 refactor: 薄包装，内部使用 Pi 框架的 loadSkills() 和 formatSkillsForPrompt()
 *
 * 历史背景：
 * - Stage 0（初始实现）：自写的 scanDir + 自定义中文索引格式 + 专用 load_skill 工具
 * - Stage 1（当前）：内部改用 Pi API，索引格式升级为 Anthropic XML 规范，
 *                    对外 API 签名保持不变，零回归风险
 * - Stage 2（计划中）：参见 memory/pi_skills_refactor.md — 删除 load_skill/create_*_skill 工具，
 *                      让 AI 完全用通用 read/write 操作
 *
 * 对外 API 全部保持原样，供 pi-tools.ts、pi-agent-service.ts、ipc-handlers.ts 调用。
 */

import { readFileSync, readdirSync, existsSync, writeFileSync, mkdirSync, statSync } from 'fs'
import { join, dirname } from 'path'
import { app } from 'electron'
import {
  formatSkillsForPrompt as piFormatSkillsForPrompt,
  loadSkills as piLoadSkills,
  type Skill as PiSkill
// Legacy Runtime 仅取技能实现本身，避免在主进程启动时带入交互式 CLI。
// pi-core Runtime 的新代码会改用 @earendil-works/pi-agent-core 包根公开 API。
} from '../../node_modules/@earendil-works/pi-coding-agent/dist/core/skills.js'

// 同名缓存维持同步调用点和既有初始化顺序；initSkills 前仍必须先 await preloadSkillEngine()。
let loadSkills!: typeof piLoadSkills
let formatSkillsForPrompt!: typeof piFormatSkillsForPrompt
export async function preloadSkillEngine(): Promise<void> {
  if (!loadSkills) {
    loadSkills = piLoadSkills
    formatSkillsForPrompt = piFormatSkillsForPrompt
  }
}
import { extractPluginNameFromSkillDir } from './plugin-manager'
import {
  DEFAULT_DISABLED_BUILTINS,
  getAgentSkillsDir,
  getBuiltInRoleSkillsDir,
  getBuiltInSkillsDir,
  getSkillsConfigPath,
  getUserSkillsDir,
  listGlobalSkillDirs
} from './openpipal-skill-sources'
import { SKILL_USAGE_NUDGE } from './skill-prompt-policy'
import { getDataRoot } from './data-root'

export { getUserSkillsDir } from './openpipal-skill-sources'
export { SKILL_USAGE_NUDGE } from './skill-prompt-policy'

export interface SkillMeta {
  name: string
  description: string
  category?: string
  dir: string
  builtIn: boolean
  /** 如果该 skill 由 MCP server 提供(`~/.openpipal/skills/_mcp/<serverName>/<skill>/`),记录来源 server 名 */
  mcpServer?: string
  /** 如果该 skill 由 Agent Plugins 插件提供(`~/.openpipal/plugins/<name>/skills/`),记录插件名 */
  pluginName?: string
  /** 技能来源分类：内置 / 用户目录 / 插件包 / MCP 建议——供技能导入功能判断可删除性与冲突提示 */
  source: 'builtin' | 'user' | 'plugin' | 'mcp'
}

interface SkillsConfig {
  disabled: string[]
}

// 全局 skills 缓存（Pi 的原生 Skill 对象）
// 在 initSkills() 时一次扫描，writeGlobalSkill() 后重新扫描
let piSkills: PiSkill[] = []
// Before startup initialization finishes, fail closed to the same defaults as
// the public pi-core loader. This keeps every synchronous legacy projection
// consistent even in tests or auxiliary entry points that query it early.
let skillsConfig: SkillsConfig = { disabled: [...DEFAULT_DISABLED_BUILTINS] }

// 日志去重签名——listSkillsMeta/buildSkillIndexForContext 现在每次调用都重扫，
// 不加去重的话每轮对话/每次 UI 刷新都会刷屏
let lastSkillsLogSignature = ''
let lastDiagnosticsLogSignature = ''

// ---- 路径 helpers ----

function getConfigPath(): string {
  return getSkillsConfigPath()
}

// ---- 配置文件 ----

function loadSkillsConfig(): SkillsConfig {
  const configPath = getConfigPath()
  if (!existsSync(configPath)) return { disabled: [...DEFAULT_DISABLED_BUILTINS] }
  try {
    const parsed = JSON.parse(readFileSync(configPath, 'utf-8'))
    if (!Array.isArray(parsed?.disabled)) {
      return { disabled: [...DEFAULT_DISABLED_BUILTINS] }
    }
    return {
      disabled: parsed.disabled.filter(
        (value: unknown): value is string => typeof value === 'string'
      )
    }
  } catch {
    return { disabled: [...DEFAULT_DISABLED_BUILTINS] }
  }
}

let configDirEnsured = false

function saveSkillsConfig(config: SkillsConfig): void {
  const configPath = getConfigPath()
  if (!configDirEnsured) {
    mkdirSync(dirname(configPath), { recursive: true })
    configDirEnsured = true
  }
  writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8')
}

// ---- 共享 package.json 初始化（给 skills 安装 npm 依赖用）----

function ensureSharedPackageJson(): void {
  const openpipalDir = getDataRoot()
  const pkgPath = join(openpipalDir, 'package.json')
  if (existsSync(pkgPath)) return
  mkdirSync(openpipalDir, { recursive: true })
  writeFileSync(pkgPath, JSON.stringify({
    name: 'openpipal-workspace',
    version: '1.0.0',
    private: true,
    description: 'Shared workspace for OpenPipal skill dependencies'
  }, null, 2), 'utf-8')
}

// ---- Pi Skill ↔ OpenPipal SkillMeta 转换 ----

/** 判断一个 Skill 是否来自内置 resources 目录 */
function isBuiltInSkill(skill: PiSkill): boolean {
  return skill.filePath.startsWith(getBuiltInSkillsDir())
}

/** 从 skill.baseDir 提取 MCP server 名(若 skill 在 ~/.openpipal/skills/_mcp/<serverName>/<skillName>/ 下) */
function extractMcpServer(skill: PiSkill): string | undefined {
  const mcpRoot = join(getUserSkillsDir(), '_mcp') + '/'
  if (!skill.baseDir.startsWith(mcpRoot)) return undefined
  const rest = skill.baseDir.slice(mcpRoot.length)
  const serverName = rest.split('/')[0]
  return serverName || undefined
}

/** 技能来源分类：builtin > user > plugin > mcp（与 scanAllSkills 的路径扫描优先级一致） */
function getSkillSource(skill: PiSkill): 'builtin' | 'user' | 'plugin' | 'mcp' {
  if (isBuiltInSkill(skill)) return 'builtin'
  if (extractPluginNameFromSkillDir(skill.baseDir)) return 'plugin'
  if (extractMcpServer(skill)) return 'mcp'
  return 'user'
}

/** Pi Skill → SkillMeta（供 UI 和 IPC 使用） */
function toSkillMeta(skill: PiSkill): SkillMeta {
  return {
    name: skill.name,
    description: skill.description,
    dir: skill.baseDir,
    builtIn: isBuiltInSkill(skill),
    mcpServer: extractMcpServer(skill),
    pluginName: extractPluginNameFromSkillDir(skill.baseDir),
    source: getSkillSource(skill)
  }
}

// ---- 首次安装默认禁用的 skills ----
// 这 4 个依赖 python-docx / python-pptx / openpyxl / reportlab / pdfplumber / pdf2image 等外部库，
// 用户需要先装依赖才能用，默认关闭避免"开箱就报错"。
// skill-creator 无外部依赖，默认启用。
// 2026-04 Skills 升级：从自写简化版迁移到 openai/skills 官方 Apache 2.0 版本。
// 旧名 → 新名映射，用于一次性迁移老用户的 skills.config.json disabled 列表。
const LEGACY_SKILL_RENAME: Record<string, string> = {
  'docx-generator': 'doc',
  'pptx-generator': 'slides',
  'xlsx-generator': 'spreadsheet',
  // deep-research 已删除，不做映射（旧条目在迁移时被清除）
}
const DELETED_LEGACY_SKILLS = new Set(['deep-research'])

// ==================================================================
// 公开 API
// ==================================================================

/** 初始化：扫描内置 + 用户 skills，加载 disabled 配置 */
export function initSkills(): void {
  // 首次启动：创建默认配置，禁用需要外部依赖的 skills
  if (!existsSync(getConfigPath())) {
    skillsConfig = { disabled: [...DEFAULT_DISABLED_BUILTINS] }
    saveSkillsConfig(skillsConfig)
  } else {
    skillsConfig = loadSkillsConfig()
    // 老用户迁移：把 disabled 列表里的旧 skill 名转成新名，并清除已删除的 skill
    let dirty = false
    const migrated: string[] = []
    for (const name of skillsConfig.disabled) {
      if (DELETED_LEGACY_SKILLS.has(name)) { dirty = true; continue }
      const newName = LEGACY_SKILL_RENAME[name]
      if (newName) { migrated.push(newName); dirty = true }
      else migrated.push(name)
    }
    if (dirty) {
      skillsConfig.disabled = Array.from(new Set(migrated))
      saveSkillsConfig(skillsConfig)
      console.log(`[Skills] 已迁移旧 skill 配置 → ${skillsConfig.disabled.join(', ') || '(空)'}`)
    }
  }

  scanAllSkills()
  ensureSharedPackageJson()
}

/**
 * 重新扫描 skill 目录(不重置 disabled 配置)。
 * 使用场景:MCP server 连接后提供了 suggested skills,需要刷新 piSkills 缓存。
 */
export function reloadSkills(): void {
  scanAllSkills()
}

/** 内部:统一的扫描逻辑,供 initSkills / reloadSkills 复用 */
function scanAllSkills(): void {
  // 路径顺序决定同名碰撞的优先级(Pi loadSkills: 先到先得)
  // 当前策略:built-in > user > 插件包 > MCP — 保留系统 skill 名称保留位,
  // 用户本地能覆盖插件,显式安装的插件包优先于 MCP 的"建议"技能
  const skillPaths = listGlobalSkillDirs()
  const result = loadSkills({
    cwd: process.cwd(),
    agentDir: getDataRoot(),
    skillPaths,
    includeDefaults: false  // 不使用 Pi 默认的 ~/.pi/agent/skills
  })
  piSkills = result.skills

  // 记录 Pi 的验证 diagnostics——内容不变则跳过，避免每次重扫都刷屏
  const diagSignature = result.diagnostics.map(d => `${d.type}:${d.path}:${d.message}`).join('|')
  if (diagSignature !== lastDiagnosticsLogSignature) {
    lastDiagnosticsLogSignature = diagSignature
    for (const d of result.diagnostics) {
      const prefix = d.type === 'collision' ? '[Skills collision]' : `[Skills ${d.type}]`
      console.log(`${prefix} ${d.message} — ${d.path}`)
    }
  }

  // 加载汇总日志同理去重：技能名集合（排序后）与上次相同则跳过
  const namesSignature = piSkills.map(s => s.name).sort().join(',')
  if (namesSignature !== lastSkillsLogSignature) {
    lastSkillsLogSignature = namesSignature
    if (piSkills.length > 0) {
      const builtInCount = piSkills.filter(isBuiltInSkill).length
      const userCount = piSkills.length - builtInCount
      console.log(`[Skills] 已加载 ${piSkills.length} 个（内置 ${builtInCount}，用户/MCP ${userCount}）: ${piSkills.map(s => s.name).join(', ')}`)
    }
  }
}

/**
 * 供 skill-import.ts 复用：对任意路径（用户选的文件夹 / GitHub 仓库解压目录）跑 loadSkills，
 * 返回精简候选列表。不影响 piSkills 缓存（导入前的"预览扫描"，不写入全局状态）。
 */
export async function scanSkillsInPaths(paths: string[]): Promise<{ name: string; description: string; skillDir: string }[]> {
  await preloadSkillEngine()
  const result = loadSkills({
    cwd: process.cwd(),
    agentDir: getDataRoot(),
    skillPaths: paths,
    includeDefaults: false
  })
  return result.skills.map(s => ({ name: s.name, description: s.description, skillDir: s.baseDir }))
}

/** 检查 skill 是否启用（只对全局 skill 有意义，Agent skill 默认全部启用） */
function isSkillEnabled(name: string): boolean {
  return !skillsConfig.disabled.includes(name)
}

/**
 * 扫描单个独立智能体的专属 skills 目录（`~/.openpipal/agents/<workspaceId>/skills/`）。
 * 不改 piSkills 全局缓存——这是隔离扫描，跟全局技能完全脱钩。
 * 目录不存在时返回空数组（零注入，而不是 fallback 到全局）。
 */
function scanAgentSkills(workspaceId: string): PiSkill[] {
  const agentDir = getAgentSkillsDir(workspaceId)
  if (!existsSync(agentDir)) return []
  const result = loadSkills({
    cwd: process.cwd(),
    agentDir: getDataRoot(),
    skillPaths: [agentDir],
    includeDefaults: false
  })
  return result.skills
}

/**
 * 扫描 built-in role 自带的专属技能。只供对应角色构建 system prompt 时调用，
 * 不并入 piSkills，也不出现在全局 SkillsHub；未传 roleName 就是零注入。
 */
function scanBuiltInRoleSkills(roleName: string): PiSkill[] {
  const roleDir = getBuiltInRoleSkillsDir(roleName)
  if (!roleDir || !existsSync(roleDir)) return []
  const result = loadSkills({
    cwd: process.cwd(),
    agentDir: getDataRoot(),
    skillPaths: [roleDir],
    includeDefaults: false
  })
  return result.skills
}

/**
 * 构建 skill 索引文本，用于注入系统提示词
 *
 * 三级作用域（角色专属技能只在 built-in role 主会话中追加）：
 * - 全局会话（无 workspaceId）：索引恒为全量（只受全局"禁用技能"列表影响）。
 *   用户在输入框选技能不再收窄索引，而是把强调写进那一条用户消息——
 *   system prompt 因此逐轮恒定，前缀缓存不被翻转。
 * - built-in role（无 workspaceId + roleName）：全局技能 + 对应
 *   resources/system-agents/<role>/skills；角色专属同名时优先。
 * - 独立智能体（带 workspaceId）：**只看自己的 skills 目录**，不合并全局或角色技能。
 *   目录不存在或为空 → 索引为空字符串，零注入。自有目录里的技能不受全局
 *   禁用列表影响——显式装进自己的目录 = 显式启用。想让独立智能体用上某个
 *   全局技能，就把那个技能目录复制/软链进它自己的 skills 目录（文件式而非字段式）。
 */
function resolveSkillScope(options: {
  workspaceId?: string
  roleName?: string
} = {}): Array<{ skill: PiSkill; enabled: boolean }> {
  // 每轮对话开头重扫——目录小、本地盘、几毫秒可接受；避免"放新技能文件夹后必须重启才生效"
  scanAllSkills()

  // 独立智能体：只看自己的目录，自有技能天然启用
  if (options.workspaceId) {
    return scanAgentSkills(options.workspaceId).map(skill => ({ skill, enabled: true }))
  }

  // built-in role 的专属技能既不受全局开关影响，也不进入其他角色的作用域；同名时它优先
  const roleSkills = options.roleName ? scanBuiltInRoleSkills(options.roleName) : []
  const roleNames = new Set(roleSkills.map(s => s.name))
  return [
    ...roleSkills.map(skill => ({ skill, enabled: true })),
    ...piSkills
      .filter(s => !roleNames.has(s.name))
      .map(skill => ({ skill, enabled: isSkillEnabled(skill.name) }))
  ]
}

export function buildSkillIndexForContext(options: {
  workspaceId?: string
  roleName?: string
} = {}): string {
  const merged = resolveSkillScope(options).filter(entry => entry.enabled).map(entry => entry.skill)
  if (merged.length === 0) return ''
  return formatSkillsForPrompt(merged)
}

// 技能使用引导：说明匹配与加载条件，不用恐吓式文案把可选步骤扩大成强制流程。
/**
 * 构建注入系统提示词的"技能段"：技能索引 XML + 使用引导。
 * 索引为空时返回空字符串（零影响）。
 * 供主 agent（buildSystemPrompt）与子 agent（subagent-runner）共用——保证"每个智能体都能
 * 看到技能索引并被催促去加载"。子 agent 此前完全拿不到技能索引，是 skill 加载的最大盲区。
 */
export function buildSkillPromptSection(options: {
  workspaceId?: string
  roleName?: string
} = {}): string {
  const index = buildSkillIndexForContext(options)
  return index ? index + SKILL_USAGE_NUDGE : ''
}

// ---- UI 支持 ----

/**
 * 列出技能 meta，供 SkillsHub / 输入框技能选择器 / `/api/skills` 使用。
 * 作用域规则与 `buildSkillIndexForContext` 共用 `resolveSkillScope`——**模型看到的那份
 * 和菜单里列出的那份必须是同一份**。此前这里少了 roleName 这一档，于是内置角色自带的
 * 技能（teacher 等）提示词里有、编辑器的斜杠命令里没有，`/技能名` 因此不展开。
 */
export function listSkillsMeta(
  workspaceId?: string,
  roleName?: string
): Array<SkillMeta & { enabled: boolean }> {
  return resolveSkillScope({ workspaceId, roleName }).map(entry => ({
    ...toSkillMeta(entry.skill),
    enabled: entry.enabled
  }))
}

export function setSkillDisabled(name: string, disabled: boolean): void {
  if (disabled && !skillsConfig.disabled.includes(name)) {
    skillsConfig.disabled.push(name)
  } else if (!disabled) {
    skillsConfig.disabled = skillsConfig.disabled.filter(n => n !== name)
  }
  saveSkillsConfig(skillsConfig)
}

// ---- Skill 详情（Phase B: SkillsHub 内部结构浏览） ----

export interface SkillFileNode {
  path: string       // 相对于 skill 目录的路径，如 "SKILL.md", "scripts/render_docx.py"
  name: string       // 文件名
  size: number       // 字节
  content?: string   // 文本内容（二进制文件为 undefined）
  isBinary?: boolean
}

export interface SkillDetails {
  name: string
  description: string
  dir: string
  builtIn: boolean
  enabled: boolean
  mcpServer?: string
  pluginName?: string
  source: 'builtin' | 'user' | 'plugin' | 'mcp'
  files: SkillFileNode[]
}

const TEXT_EXTENSIONS = new Set([
  '.md', '.txt', '.py', '.js', '.ts', '.json', '.yaml', '.yml', '.toml', '.cfg', '.ini', '.sh', '.bat', '.css', '.html'
])

function isTextFile(filename: string): boolean {
  const ext = filename.slice(filename.lastIndexOf('.'))
  return TEXT_EXTENSIONS.has(ext.toLowerCase())
}

function scanSkillDir(baseDir: string, relativePath = ''): SkillFileNode[] {
  const fullPath = relativePath ? join(baseDir, relativePath) : baseDir
  if (!existsSync(fullPath)) return []
  const entries = readdirSync(fullPath, { withFileTypes: true })
  const nodes: SkillFileNode[] = []
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue // 跳过隐藏文件
    const relPath = relativePath ? `${relativePath}/${entry.name}` : entry.name
    if (entry.isDirectory()) {
      nodes.push(...scanSkillDir(baseDir, relPath))
    } else if (entry.isFile()) {
      const filePath = join(baseDir, relPath)
      const stat = statSync(filePath)
      const isBinary = !isTextFile(entry.name)
      let content: string | undefined
      if (!isBinary) {
        try { content = readFileSync(filePath, 'utf-8') } catch { /* skip */ }
      }
      nodes.push({ path: relPath, name: entry.name, size: stat.size, content, isBinary })
    }
  }
  return nodes
}

/** 获取 skill 完整详情（文件树 + 文本文件内容），用于 SkillsHub 详情视图 */
export function getSkillDetails(name: string): SkillDetails | null {
  const skill = piSkills.find(s => s.name === name)
  if (!skill) return null
  return {
    name: skill.name,
    description: skill.description,
    dir: skill.baseDir,
    builtIn: isBuiltInSkill(skill),
    enabled: isSkillEnabled(skill.name),
    mcpServer: extractMcpServer(skill),
    pluginName: extractPluginNameFromSkillDir(skill.baseDir),
    source: getSkillSource(skill),
    files: scanSkillDir(skill.baseDir)
  }
}

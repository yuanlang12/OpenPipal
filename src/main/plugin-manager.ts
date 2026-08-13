/**
 * Plugin Manager — Agent Plugins 1.0.0 标准包的发现、校验与组件映射
 * 规范:https://agent-plugins.org/specification
 *
 * 一个插件 = `~/.openpipal/plugins/<name>/` 目录:
 *   plugin.json   必填 manifest($schema + name 必填,其余可选)
 *   skills/       直接子目录含 SKILL.md 即技能(喂给 skill-manager 的 loadSkills 管道)
 *   mcp.json      MCP server 配置(映射进 mcp-manager,server 名加 `<plugin>:` 前缀)
 *
 * 分层:manifest 校验/路径不出根/密钥禁嵌 属第一层永久机制(安全与数据治理)。
 * 失败边界遵循规范:manifest 无效→整包拒绝;mcp.json 无效→仅禁用该包 MCP,技能照常;
 * 单个 server 条目无效→仅跳过该条。
 */

import { existsSync, readFileSync, readdirSync, statSync, realpathSync, mkdirSync, writeFileSync, rmSync } from 'fs'
import { join, dirname, resolve, sep } from 'path'
import { homedir } from 'os'
import type { McpServerConfig } from './mcp-manager'
import { mainError, tMain, type MainErrorPayload } from './main-i18n'
import { dataPath } from './data-root'

export const PLUGIN_SCHEMA_URL = 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json'
export const MCP_SCHEMA_URL = 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json'

// ---- 类型 ----

export interface PluginManifest {
  name: string
  version?: string
  description?: string
  author?: { name?: string; email?: string; url?: string }
  homepage?: string
  repository?: string
  license?: string
  keywords?: string[]
  extensions?: Record<string, unknown>
}

export interface PluginInfo {
  name: string
  dir: string
  version?: string
  description?: string
  author?: string
  enabled: boolean
  skillNames: string[]
  mcpServerNames: string[]
  /** 非致命问题(未知字段、被跳过的 server 等),UI 提示用 */
  warnings: string[]
  /** manifest 级致命错误 → 整个插件被拒,组件一律不加载 */
  invalid?: string
}

interface PluginsConfig {
  disabled: string[]
}

// ---- 路径 ----

export function getPluginsRootDir(): string {
  return dataPath('plugins')
}

/** ${PLUGIN_DATA}:跨插件更新保留的数据目录(规范 §9.2),卸载时随插件一起删除 */
export function getPluginDataDir(pluginName: string): string {
  return dataPath('plugin-data', pluginName)
}

function getConfigPath(): string {
  return dataPath('plugins.config.json')
}

function loadPluginsConfig(): PluginsConfig {
  try {
    const raw = JSON.parse(readFileSync(getConfigPath(), 'utf-8'))
    return { disabled: Array.isArray(raw?.disabled) ? raw.disabled.filter((n: unknown) => typeof n === 'string') : [] }
  } catch {
    return { disabled: [] }
  }
}

function savePluginsConfig(config: PluginsConfig): void {
  mkdirSync(dirname(getConfigPath()), { recursive: true })
  writeFileSync(getConfigPath(), JSON.stringify(config, null, 2), 'utf-8')
}

// ---- manifest 校验(规范 §5) ----

// 1-64 字符,[a-z0-9.-],首尾字母数字,无连续 -- 或 ..
export function isValidPluginName(name: string): boolean {
  if (typeof name !== 'string' || name.length < 1 || name.length > 64) return false
  if (!/^[a-z0-9][a-z0-9.-]*$/.test(name)) return false
  if (!/[a-z0-9]$/.test(name)) return false
  if (name.includes('--') || name.includes('..')) return false
  return true
}

const KNOWN_MANIFEST_FIELDS = new Set([
  '$schema', 'name', 'version', 'description', 'author', 'homepage', 'repository', 'license', 'keywords', 'extensions'
])

export interface ManifestParseResult {
  manifest?: PluginManifest
  warnings: string[]
  /** 有值 = 致命,整包拒绝 */
  invalid?: string
}

export function parsePluginManifest(raw: string): ManifestParseResult {
  const warnings: string[] = []
  let json: Record<string, unknown>
  try {
    json = JSON.parse(raw)
  } catch {
    return { warnings, invalid: tMain('toolsHub.plugins.errors.manifestNotJson') }
  }
  if (!json || typeof json !== 'object' || Array.isArray(json)) {
    return { warnings, invalid: tMain('toolsHub.plugins.errors.manifestNotObject') }
  }
  if (json.$schema !== PLUGIN_SCHEMA_URL) {
    return { warnings, invalid: tMain('toolsHub.plugins.errors.unsupportedSchema', { value: String(json.$schema ?? tMain('toolsHub.plugins.errors.missingValue')) }) }
  }
  if (!isValidPluginName(json.name as string)) {
    return { warnings, invalid: tMain('toolsHub.plugins.errors.badPluginName', { value: String(json.name ?? tMain('toolsHub.plugins.errors.missingValue')) }) }
  }
  // 未知顶层字段:报告并忽略(非致命);已知字段类型错误:致命(规范:其余模式违反均拒绝)
  const strFields = ['version', 'description', 'homepage', 'repository', 'license'] as const
  for (const f of strFields) {
    if (f in json && typeof json[f] !== 'string') return { warnings, invalid: tMain('toolsHub.plugins.errors.fieldMustBeString', { field: f }) }
  }
  if ('keywords' in json && !(Array.isArray(json.keywords) && json.keywords.every(k => typeof k === 'string'))) {
    return { warnings, invalid: tMain('toolsHub.plugins.errors.keywordsMustBeStringArray') }
  }
  if ('author' in json) {
    const a = json.author
    if (!a || typeof a !== 'object' || Array.isArray(a)) return { warnings, invalid: tMain('toolsHub.plugins.errors.authorMustBeObject') }
    for (const k of ['name', 'email', 'url']) {
      const v = (a as Record<string, unknown>)[k]
      if (v !== undefined && typeof v !== 'string') return { warnings, invalid: tMain('toolsHub.plugins.errors.fieldMustBeString', { field: `author.${k}` }) }
    }
  }
  let extensions: Record<string, unknown> | undefined
  if ('extensions' in json) {
    if (json.extensions && typeof json.extensions === 'object' && !Array.isArray(json.extensions)) {
      extensions = json.extensions as Record<string, unknown>
    } else {
      warnings.push(tMain('toolsHub.plugins.warnings.extensionsIgnored')) // 规范:非对象 extensions 报告并忽略,非致命
    }
  }
  for (const key of Object.keys(json)) {
    if (!KNOWN_MANIFEST_FIELDS.has(key)) warnings.push(tMain('toolsHub.plugins.warnings.unknownField', { field: key }))
  }
  return {
    warnings,
    manifest: {
      name: json.name as string,
      version: json.version as string | undefined,
      description: json.description as string | undefined,
      author: json.author as PluginManifest['author'],
      homepage: json.homepage as string | undefined,
      repository: json.repository as string | undefined,
      license: json.license as string | undefined,
      keywords: json.keywords as string[] | undefined,
      extensions
    }
  }
}

// ---- 路径安全(规范 §4.1:解析后必须留在插件根内) ----

function isWithinRoot(candidate: string, root: string): boolean {
  let real: string
  try {
    real = realpathSync(candidate)
  } catch {
    return false
  }
  let realRoot: string
  try {
    realRoot = realpathSync(root)
  } catch {
    return false
  }
  return real === realRoot || real.startsWith(realRoot + sep)
}

// ---- 占位符展开(规范:仅 ${PLUGIN_ROOT}/${PLUGIN_DATA},单遍非递归,未识别的保持字面) ----

export function expandPlaceholders(value: string, pluginRoot: string, pluginData: string): string {
  return value.split('${PLUGIN_ROOT}').join(pluginRoot).split('${PLUGIN_DATA}').join(pluginData)
}

// ---- mcp.json 校验与映射(规范 §7.2) ----

export interface PluginMcpServer {
  serverName: string
  config: McpServerConfig
}

interface McpParseResult {
  servers: PluginMcpServer[]
  warnings: string[]
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]'])

function parsePluginMcp(raw: string, pluginRoot: string, pluginName: string): McpParseResult {
  const warnings: string[] = []
  let json: Record<string, unknown>
  try {
    json = JSON.parse(raw)
  } catch {
    return { servers: [], warnings: [tMain('toolsHub.plugins.warnings.mcpNotJson')] }
  }
  if (json?.$schema !== MCP_SCHEMA_URL) {
    return { servers: [], warnings: [tMain('toolsHub.plugins.warnings.mcpUnsupportedSchema')] }
  }
  const entries = json.mcpServers
  if (!entries || typeof entries !== 'object' || Array.isArray(entries)) {
    return { servers: [], warnings: [tMain('toolsHub.plugins.warnings.mcpMissingServers')] }
  }

  const pluginData = getPluginDataDir(pluginName)
  const servers: PluginMcpServer[] = []
  for (const [serverName, rawCfg] of Object.entries(entries as Record<string, unknown>)) {
    const skip = (reason: string): void => { warnings.push(tMain('toolsHub.plugins.warnings.serverSkipped', { server: serverName, reason })) }
    if (!rawCfg || typeof rawCfg !== 'object') { skip(tMain('toolsHub.plugins.mcpSkip.notAnObject')); continue }
    const cfg = rawCfg as Record<string, unknown>

    if (cfg.type === 'stdio') {
      const command = cfg.command
      if (typeof command !== 'string' || !command) { skip(tMain('toolsHub.plugins.mcpSkip.missingCommand')); continue }
      // 单令牌:裸名(走平台可执行搜索)或 ./ 插件根相对路径;其余形式拒绝
      let resolvedCommand: string
      if (command.startsWith('./')) {
        const abs = resolve(pluginRoot, command)
        if (!isWithinRoot(abs, pluginRoot)) { skip(tMain('toolsHub.plugins.mcpSkip.commandEscapedRoot')); continue }
        resolvedCommand = abs
      } else if (command.includes('/') || command.includes('\\') || command.includes(' ')) {
        skip(tMain('toolsHub.plugins.mcpSkip.commandShape'))
        continue
      } else {
        resolvedCommand = command
      }
      if (cfg.args !== undefined && !(Array.isArray(cfg.args) && cfg.args.every(a => typeof a === 'string'))) {
        skip(tMain('toolsHub.plugins.mcpSkip.argsShape')); continue
      }
      const env = cfg.env
      if (env !== undefined && (!env || typeof env !== 'object' || Array.isArray(env) || Object.values(env).some(v => typeof v !== 'string'))) {
        skip(tMain('toolsHub.plugins.mcpSkip.envShape')); continue
      }
      if (env && ('PLUGIN_ROOT' in (env as object) || 'PLUGIN_DATA' in (env as object))) {
        skip(tMain('toolsHub.plugins.mcpSkip.envReserved')); continue
      }
      // cwd:'./..' | ${PLUGIN_ROOT}[/...] | ${PLUGIN_DATA}[/...];省略 = 插件根
      let cwd = pluginRoot
      if (cfg.cwd !== undefined) {
        if (typeof cfg.cwd !== 'string') { skip(tMain('toolsHub.plugins.mcpSkip.cwdShape')); continue }
        const expanded = cfg.cwd.startsWith('./')
          ? resolve(pluginRoot, cfg.cwd)
          : expandPlaceholders(cfg.cwd, pluginRoot, pluginData)
        const inRoot = expanded === pluginRoot || expanded.startsWith(pluginRoot + sep)
        const inData = expanded === pluginData || expanded.startsWith(pluginData + sep)
        if (!inRoot && !inData) { skip(tMain('toolsHub.plugins.mcpSkip.cwdOutside')); continue }
        cwd = expanded
      }
      const expandedArgs = ((cfg.args as string[] | undefined) || []).map(a => expandPlaceholders(a, pluginRoot, pluginData))
      const expandedEnv: Record<string, string> = {}
      for (const [k, v] of Object.entries((env as Record<string, string> | undefined) || {})) {
        expandedEnv[k] = expandPlaceholders(v, pluginRoot, pluginData)
      }
      servers.push({ serverName, config: { command: resolvedCommand, args: expandedArgs, env: expandedEnv, cwd } })
      continue
    }

    if (cfg.type === 'streamable-http' || cfg.type === 'sse') {
      if (cfg.type === 'sse') { skip(tMain('toolsHub.plugins.mcpSkip.sseUnsupported')); continue }
      let url: URL
      try {
        url = new URL(String(cfg.url ?? ''))
      } catch { skip(tMain('toolsHub.plugins.mcpSkip.urlInvalid')); continue }
      if (url.username || url.password || url.hash) { skip(tMain('toolsHub.plugins.mcpSkip.urlCredentials')); continue }
      if (url.protocol !== 'https:' && url.protocol !== 'http:') { skip(tMain('toolsHub.plugins.mcpSkip.urlScheme')); continue }
      if (url.protocol === 'http:' && !LOOPBACK_HOSTS.has(url.hostname)) { skip(tMain('toolsHub.plugins.mcpSkip.urlRequiresHttps')); continue }
      const headers = cfg.headers
      if (headers !== undefined && (!headers || typeof headers !== 'object' || Array.isArray(headers) || Object.values(headers).some(v => typeof v !== 'string'))) {
        skip(tMain('toolsHub.plugins.mcpSkip.headersShape')); continue
      }
      // 规范:headers 值不做占位符展开,原样传递
      servers.push({ serverName, config: { url: url.toString(), headers: headers as Record<string, string> | undefined } })
      continue
    }

    skip(tMain('toolsHub.plugins.mcpSkip.unknownTransport', { value: String(cfg.type ?? tMain('toolsHub.plugins.errors.missingValue')) }))
  }
  return { servers, warnings }
}

// ---- 插件发现 ----

export interface ScannedPlugin {
  info: PluginInfo
  skillsDir?: string
  mcpServers: PluginMcpServer[]
}

/** 规范 §7.1:skills/ 只扫直接子目录,含 SKILL.md 的算一个技能 */
function listPluginSkillNames(skillsDir: string): string[] {
  try {
    return readdirSync(skillsDir, { withFileTypes: true })
      .filter(e => {
        if (!e.isDirectory()) return false
        try { return statSync(join(skillsDir, e.name, 'SKILL.md')).isFile() } catch { return false }
      })
      .map(e => e.name)
  } catch {
    return []
  }
}

/** 单个插件目录的完整发现流程(manifest 校验→skills 枚举→mcp.json 解析)。导出供单测以 fixture 目录直测。 */
export function scanPluginDir(dir: string, dirName: string, disabled: Set<string>): ScannedPlugin {
  const rejected = (reason: string, warnings: string[] = []): ScannedPlugin => ({
    info: { name: dirName, dir, enabled: false, skillNames: [], mcpServerNames: [], warnings, invalid: reason },
    mcpServers: []
  })

  const manifestPath = join(dir, 'plugin.json')
  if (!existsSync(manifestPath)) return rejected('缺少 plugin.json')
  let parsed: ManifestParseResult
  try {
    parsed = parsePluginManifest(readFileSync(manifestPath, 'utf-8'))
  } catch (err: any) {
    return rejected(`读取 plugin.json 失败:${err?.message || err}`)
  }
  if (!parsed.manifest) return rejected(parsed.invalid || tMain('toolsHub.plugins.errors.manifestInvalid'), parsed.warnings)
  const manifest = parsed.manifest
  const warnings = [...parsed.warnings]
  if (manifest.name !== dirName) {
    warnings.push(tMain('toolsHub.plugins.warnings.dirNameMismatch', { dirName, manifestName: manifest.name }))
  }

  const enabled = !disabled.has(manifest.name)

  // skills/(缺失 = 无技能组件,非错误;存在但逃出根 = 该组件无效)
  let skillsDir: string | undefined
  let skillNames: string[] = []
  const skillsCandidate = join(dir, 'skills')
  if (existsSync(skillsCandidate) && statSync(skillsCandidate).isDirectory()) {
    if (isWithinRoot(skillsCandidate, dir)) {
      skillsDir = skillsCandidate
      skillNames = listPluginSkillNames(skillsCandidate)
    } else {
      warnings.push(tMain('toolsHub.plugins.warnings.skillsEscapedRoot'))
    }
  }

  // mcp.json(缺失 = 无 MCP 组件,非错误)
  let mcpServers: PluginMcpServer[] = []
  const mcpPath = join(dir, 'mcp.json')
  if (existsSync(mcpPath)) {
    try {
      const result = parsePluginMcp(readFileSync(mcpPath, 'utf-8'), dir, manifest.name)
      mcpServers = result.servers
      warnings.push(...result.warnings)
    } catch (err: any) {
      warnings.push(tMain('toolsHub.plugins.warnings.mcpReadFailed', { detail: err?.message || String(err) }))
    }
  }

  return {
    info: {
      name: manifest.name,
      dir,
      version: manifest.version,
      description: manifest.description,
      author: manifest.author?.name,
      enabled,
      skillNames,
      mcpServerNames: mcpServers.map(s => s.serverName),
      warnings
    },
    skillsDir,
    mcpServers
  }
}

function scanAllPlugins(): ScannedPlugin[] {
  const root = getPluginsRootDir()
  if (!existsSync(root)) return []
  const disabled = new Set(loadPluginsConfig().disabled)
  const results: ScannedPlugin[] = []
  const seen = new Set<string>()
  try {
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue
      const scanned = scanPluginDir(join(root, entry.name), entry.name, disabled)
      if (seen.has(scanned.info.name)) {
        scanned.info.invalid = tMain('toolsHub.plugins.errors.duplicateName', { name: scanned.info.name })
      } else {
        seen.add(scanned.info.name)
      }
      results.push(scanned)
    }
  } catch { /* 根目录不可读按无插件处理 */ }
  return results
}

// ==================================================================
// 公开 API
// ==================================================================

export function listPlugins(): PluginInfo[] {
  return scanAllPlugins().map(p => p.info)
}

/** 供 skill-manager 注入 loadSkills 的 skillPaths(仅启用且有效的插件) */
export function listPluginSkillDirs(): string[] {
  return scanAllPlugins()
    .filter(p => !p.info.invalid && p.info.enabled && p.skillsDir)
    .map(p => p.skillsDir!)
}

/** 技能来源反查:该目录路径属于哪个插件的 skills/(供 SkillMeta 标注来源徽章) */
export function extractPluginNameFromSkillDir(skillBaseDir: string): string | undefined {
  const root = getPluginsRootDir() + sep
  if (!skillBaseDir.startsWith(root)) return undefined
  return skillBaseDir.slice(root.length).split(sep)[0] || undefined
}

/** 供 mcp-manager 连接的插件 MCP server 清单(仅启用且有效的插件),server 名带 `<plugin>:` 前缀 */
export function getPluginMcpServers(): { name: string; pluginName: string; config: McpServerConfig }[] {
  const result: { name: string; pluginName: string; config: McpServerConfig }[] = []
  for (const p of scanAllPlugins()) {
    if (p.info.invalid || !p.info.enabled) continue
    for (const s of p.mcpServers) {
      result.push({ name: `${p.info.name}:${s.serverName}`, pluginName: p.info.name, config: s.config })
    }
  }
  return result
}

export function setPluginDisabled(name: string, disabled: boolean): void {
  const config = loadPluginsConfig()
  if (disabled && !config.disabled.includes(name)) {
    config.disabled.push(name)
  } else if (!disabled) {
    config.disabled = config.disabled.filter(n => n !== name)
  }
  savePluginsConfig(config)
}

export function removePlugin(name: string): { ok: true } | ({ ok: false } & MainErrorPayload) {
  const root = getPluginsRootDir()
  const target = scanAllPlugins().find(p => p.info.name === name)
  if (!target) return { ok: false, ...mainError('toolsHub.plugins.errors.pluginNotFound', { name }) }
  if (!isWithinRoot(target.info.dir, root)) return { ok: false, ...mainError('toolsHub.plugins.errors.unsafePluginDir') }
  try {
    rmSync(target.info.dir, { recursive: true, force: true })
  } catch (err: any) {
    return { ok: false, ...mainError('toolsHub.plugins.errors.removeFailed', { detail: err?.message || String(err) }) }
  }
  try { rmSync(getPluginDataDir(name), { recursive: true, force: true }) } catch { /* data 目录可能不存在 */ }
  // 从禁用列表清掉,避免同名插件将来重装时"被上辈子禁用"
  const config = loadPluginsConfig()
  if (config.disabled.includes(name)) {
    config.disabled = config.disabled.filter(n => n !== name)
    savePluginsConfig(config)
  }
  return { ok: true }
}

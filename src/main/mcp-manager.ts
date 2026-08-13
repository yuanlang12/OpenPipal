import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync, readdirSync } from 'fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'path'
import { homedir } from 'os'
import { randomUUID } from 'node:crypto'
import { app } from 'electron'
import { createOAuthProvider, awaitAuthorizationCode, hasPersistedOAuthSession, revokeOAuthSession } from './mcp-oauth'
import { dataPath } from './data-root'
import { getUserMcpConfigPath } from './credential-paths'

/**
 * MCP server 配置 — 二选一:
 * - stdio (本地子进程): 必填 command,可选 args / env
 * - remote (HTTP streamable): 必填 url,可选 headers(支持 ${ENV_VAR} 替换)
 *   可选 oauth=true → 走完整 OAuth 2.1 + PKCE 流程,token 持久化在 ~/.openpipal/oauth/
 */
export interface McpServerConfig {
  // Stdio transport
  command?: string
  args?: string[]
  env?: Record<string, string>
  /** 子进程工作目录(目前仅插件 stdio server 使用,规范要求默认插件根) */
  cwd?: string
  // Remote HTTP transport
  url?: string
  headers?: Record<string, string>
  oauth?: boolean
}

export interface McpServerStatus {
  name: string
  config: McpServerConfig
  connected: boolean
  toolCount: number
  builtIn: boolean
  error?: string
  /** OAuth 状态(仅当 config.oauth=true 时有意义) */
  oauthState?: 'authorized' | 'needs-auth'
  /** 由 Agent Plugins 插件提供时为插件名——UI 不给删除入口(生命周期随插件) */
  pluginName?: string
}

/**
 * MCP Apps Extension 中 server 可在 tool 的 `_meta.ui` 里声明交互式 UI:
 * - resourceUri: 指向 ui:// 资源,包含可在 iframe 渲染的 HTML
 * - permissions: 可选的 iframe 能力请求 (microphone 等)
 * - csp: 可选的外源白名单
 * 详细协议见 docs/claude/mcp-apps-protocol.md
 */
interface McpToolUiMeta {
  resourceUri: string
  html: string  // 预拉取的 ui:// 资源内容
  permissions?: string[]
  csp?: Record<string, unknown>
  visibility?: string[]
}

interface McpToolInfo {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  ui?: McpToolUiMeta
}

interface ConnectedServer {
  /** Opaque per-connection identity. Reconnect/replacement always gets a new value. */
  connectionId: string
  name: string
  config: McpServerConfig
  builtIn: boolean
  client: Client
  transport: Transport
  tools: McpToolInfo[]
  /**
   * 仅当该 server 由 ACP client 通过 session/new.mcpServers 临时注入时填充。
   * 全局 server（mcp-servers.json / 用户配置）此字段为 undefined。
   * consumer 函数传入相同 sessionId 才能看到这些 server——桌面端正常路径
   * 不传 sessionId，因此对 ACP 注入完全无感（默认可选 opt-in）。
   */
  sessionId?: string
  /** 由 Agent Plugins 插件提供时为插件名 */
  pluginName?: string
}

const servers: ConnectedServer[] = []
const failedServers: { name: string; config: McpServerConfig; builtIn: boolean; error: string; pluginName?: string }[] = []

/** 该 server 在给定 sessionId 上下文下是否可见。全局 server 永远可见。 */
function isVisible(server: ConnectedServer, sessionId?: string): boolean {
  if (!server.sessionId) return true
  return sessionId !== undefined && server.sessionId === sessionId
}

/** 全局 + 当前 session 的 server 视图（保持插入顺序）。 */
function visibleServers(sessionId?: string): ConnectedServer[] {
  return servers.filter(s => isVisible(s, sessionId))
}

/**
 * Final MCP resolution scope. Discovery is not an authorization boundary, so
 * every describe/UI/call path must apply this scope again immediately before
 * selecting a connected server.
 */
export interface McpToolAccessScope {
  /** Empty/undefined preserves the historical "all visible servers" behavior. */
  serverFilter?: readonly string[]
  /** Exact server selected from tools.search(); avoids first-match ambiguity. */
  serverName?: string
  /** Exact connected-server identity; reconnects/replacements never retain it. */
  serverBinding?: string
  /** Hide tools whose MCP Apps visibility is app-only. */
  modelVisibleOnly?: boolean
}

function isModelVisibleTool(tool: McpToolInfo): boolean {
  const visibility = tool.ui?.visibility || []
  return !visibility.includes('app') || visibility.includes('model')
}

function scopedVisibleServers(
  sessionId?: string,
  scope: McpToolAccessScope = {}
): ConnectedServer[] {
  const allowed = scope.serverFilter && scope.serverFilter.length > 0
    ? new Set(scope.serverFilter)
    : null
  return visibleServers(sessionId).filter((server) => (
    (!allowed || allowed.has(server.name))
    && (!scope.serverName || server.name === scope.serverName)
    && (!scope.serverBinding || server.connectionId === scope.serverBinding)
  ))
}

function resolveMcpTool(
  toolName: string,
  sessionId?: string,
  scope: McpToolAccessScope = {}
): { server: ConnectedServer; tool: McpToolInfo } | null {
  for (const server of scopedVisibleServers(sessionId, scope)) {
    const tool = server.tools.find((candidate) => candidate.name === toolName)
    if (!tool) continue
    if (scope.modelVisibleOnly && !isModelVisibleTool(tool)) continue
    return { server, tool }
  }
  return null
}

export interface McpToolServerIdentity {
  serverName: string
  serverBinding: string
}

/** Resolve the exact connected-server identity used before authorization. */
export function resolveMcpToolServerIdentity(
  toolName: string,
  sessionId?: string,
  scope: McpToolAccessScope = {}
): McpToolServerIdentity | null {
  const resolved = resolveMcpTool(toolName, sessionId, scope)
  return resolved ? {
    serverName: resolved.server.name,
    serverBinding: resolved.server.connectionId,
  } : null
}

/** Backward-compatible name projection for non-capability callers. */
export function resolveMcpToolServerName(
  toolName: string,
  sessionId?: string,
  scope: McpToolAccessScope = {}
): string | null {
  return resolveMcpToolServerIdentity(toolName, sessionId, scope)?.serverName || null
}

function loadConfig(): Record<string, McpServerConfig> {
  const configPath = app.isPackaged
    ? join(process.resourcesPath, 'mcp-servers.json')
    : join(__dirname, '../../mcp-servers.json')
  try {
    return JSON.parse(readFileSync(configPath, 'utf-8'))
  } catch {
    return {}
  }
}

function resolveEnv(env: Record<string, string>): Record<string, string> {
  const resolved: Record<string, string> = {}
  for (const [key, value] of Object.entries(env)) {
    // 空值时从 process.env 读取（.env 文件已通过 dotenv 加载）
    resolved[key] = value || process.env[key] || ''
  }
  return resolved
}

/**
 * 解析 headers 里的 ${VAR} 占位符为 process.env.VAR。
 * 例:{ Authorization: "Bearer ${GITHUB_PAT}" } → { Authorization: "Bearer <实际值>" }
 * 未定义的环境变量替换为空字符串。
 */
function resolveHeaders(headers: Record<string, string>): Record<string, string> {
  const resolved: Record<string, string> = {}
  for (const [key, value] of Object.entries(headers)) {
    resolved[key] = value.replace(/\$\{([A-Z_][A-Z0-9_]*)\}/gi, (_, name) => process.env[name] || '')
  }
  return resolved
}

function isRemoteConfig(config: McpServerConfig): boolean {
  return typeof config.url === 'string' && config.url.length > 0
}

function isOAuthConfig(config: McpServerConfig): boolean {
  return isRemoteConfig(config) && config.oauth === true
}

/**
 * 构造 transport。
 * @param config server 配置
 * @param serverName OAuth 模式下必填,用于绑定持久化 session 文件
 * @param allowOAuthRedirect true=允许打开外部浏览器(用户主动 Connect 时);false=禁止(启动期)
 */
function createTransport(
  config: McpServerConfig,
  serverName?: string,
  allowOAuthRedirect = false
): Transport {
  if (isRemoteConfig(config)) {
    const headers = resolveHeaders(config.headers || {})
    const opts: any = {}
    if (Object.keys(headers).length > 0) opts.requestInit = { headers }
    if (isOAuthConfig(config)) {
      if (!serverName) throw new Error('OAuth transport 需要 serverName 用于持久化 session')
      opts.authProvider = createOAuthProvider(serverName, { allowRedirect: allowOAuthRedirect })
    }
    return new StreamableHTTPClientTransport(new URL(config.url!), opts)
  }
  // Stdio fallback
  const resolvedEnv = resolveEnv(config.env || {})
  return new StdioClientTransport({
    command: config.command!,
    args: config.args || [],
    env: { ...process.env, ...resolvedEnv } as Record<string, string>,
    ...(config.cwd ? { cwd: config.cwd } : {})
  })
}

function loadUserConfig(): Record<string, McpServerConfig> {
  const p = getUserMcpConfigPath()
  if (!existsSync(p)) return {}
  try { return JSON.parse(readFileSync(p, 'utf-8')) } catch { return {} }
}

function saveUserConfig(config: Record<string, McpServerConfig>): void {
  const dir = dirname(getUserMcpConfigPath())
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  writeFileSync(getUserMcpConfigPath(), JSON.stringify(config, null, 2), 'utf-8')
}

async function connectServer(
  name: string,
  serverConfig: McpServerConfig,
  builtIn: boolean,
  opts: { allowOAuthRedirect?: boolean; pluginName?: string } = {}
): Promise<void> {
  // OAuth server 启动期一律 short-circuit —— 连接需要读 token(safeStorage 同步解密钥匙串)，
  // 钥匙串弹授权框会把主线程锁死(实案：整 App 冻结)。钥匙串只允许在用户主动点
  // "授权/连接"(allowOAuthRedirect=true，用户在场、弹框是预期交互)时被访问。
  if (isOAuthConfig(serverConfig) && !opts.allowOAuthRedirect) {
    const hasSaved = hasPersistedOAuthSession(name)
    failedServers.push({
      name, config: serverConfig, builtIn,
      error: hasSaved
        ? '已保存授权会话——在 Tools Hub 点 "授权/连接" 恢复(启动期不自动访问钥匙串)'
        : '需要 OAuth 授权(在 Tools Hub 点 "授权" 完成)'
    })
    console.log(`[MCP] ${name} 跳过自动连接 — ${hasSaved ? '已有会话,等用户主动连接' : '等待用户 OAuth 授权'}`)
    return
  }
  try {
    const client = new Client({ name: `openpipal-${name}`, version: '1.0.0' })
    const transport = createTransport(serverConfig, name, opts.allowOAuthRedirect === true)
    await client.connect(transport)
    const { tools } = await client.listTools()
    const kind = isRemoteConfig(serverConfig) ? 'remote' : 'stdio'

    // 预拉取 MCP Apps UI 资源(tool._meta.ui.resourceUri → HTML)
    const toolInfos: McpToolInfo[] = []
    for (const t of tools) {
      const info: McpToolInfo = {
        name: t.name,
        description: t.description || '',
        inputSchema: (t.inputSchema as Record<string, unknown>) || { type: 'object', properties: {} }
      }
      const uiMeta = (t as any)._meta?.ui as { resourceUri?: string; permissions?: string[]; csp?: Record<string, unknown>; visibility?: string[] } | undefined
      if (uiMeta?.resourceUri) {
        try {
          const read = await client.readResource({ uri: uiMeta.resourceUri })
          const html = (read.contents || [])
            .filter((c): c is { type?: string; text: string; uri: string; mimeType?: string } => typeof (c as { text?: unknown }).text === 'string')
            .map((c) => c.text)
            .join('')
          if (html) {
            info.ui = { resourceUri: uiMeta.resourceUri, html, permissions: uiMeta.permissions, csp: uiMeta.csp, visibility: uiMeta.visibility }
          }
        } catch (err) {
          console.warn(`[MCP] ${name}.${t.name} UI resource 拉取失败:`, err)
        }
      } else if (uiMeta?.visibility) {
        info.ui = { resourceUri: '', html: '', visibility: uiMeta.visibility }
      }
      toolInfos.push(info)
    }

    servers.push({ connectionId: randomUUID(), name, config: serverConfig, builtIn, client, transport, tools: toolInfos, pluginName: opts.pluginName })
    const uiCount = toolInfos.filter(t => t.ui?.resourceUri).length
    const uiSuffix = uiCount > 0 ? ` (${uiCount} 个带 UI)` : ''
    console.log(`[MCP] ${name} 已连接 (${kind})${uiSuffix}，工具: ${tools.map((t) => t.name).join(', ')}`)
    // server 可能额外提供 skill:// resources,同步到磁盘供 skill-manager 加载
    await syncMcpSkillsToDisk(name, client)
  } catch (err) {
    // OAuth 启动期 redirect 被禁(OAUTH_NON_INTERACTIVE)→ 标记 needs-auth,不当作硬错
    if (isOAuthConfig(serverConfig) && String(err).includes('OAUTH_NON_INTERACTIVE')) {
      failedServers.push({ name, config: serverConfig, builtIn, error: '需要重新授权(token 失效)' })
      console.log(`[MCP] ${name} OAuth token 已失效,等待用户重新授权`)
      return
    }
    console.error(`[MCP] ${name} 连接失败:`, err)
    failedServers.push({ name, config: serverConfig, builtIn, error: String(err), pluginName: opts.pluginName })
  }
}

const MCP_CONNECT_TIMEOUT_MS = 8000

type McpServersUpdatedCallback = (status: McpServerStatus[]) => void
let mcpServersUpdatedCallback: McpServersUpdatedCallback | null = null

/**
 * 注册"MCP server 状态变化"回调——每个 server 连接完成(成败都算)后触发一次，
 * 供 index.ts 转发给 renderer(渐进就绪推送)。仿照 window-tracker 的 onStatusChange 模式。
 */
export function onMcpServersUpdated(callback: McpServersUpdatedCallback): void {
  mcpServersUpdatedCallback = callback
}

function notifyMcpServersUpdated(): void {
  mcpServersUpdatedCallback?.(getMcpServerStatus())
}

/**
 * 给单个 connectServer 调用包一层超时——防止某个 server 卡死拖慢启动/并行批次。
 * connectServer 自身从不 reject(内部已 try/catch 兜底)，这里 catch 到的只会是超时，
 * 按现有失败路径记录日志，不向上抛穿。
 */
async function connectServerWithTimeout(
  name: string,
  serverConfig: McpServerConfig,
  builtIn: boolean,
  opts: { pluginName?: string } = {}
): Promise<void> {
  try {
    await Promise.race([
      connectServer(name, serverConfig, builtIn, opts),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`连接超时(${MCP_CONNECT_TIMEOUT_MS}ms)`)), MCP_CONNECT_TIMEOUT_MS)
      )
    ])
  } catch (err) {
    console.error(`[MCP] ${name} 连接超时:`, err)
    failedServers.push({ name, config: serverConfig, builtIn, error: String(err), pluginName: opts.pluginName })
  } finally {
    notifyMcpServersUpdated()
  }
}

/**
 * 用户主动触发 OAuth 授权流程 — 打开浏览器,等回调,把 server 转为已连接状态。
 * 调用约定:UI 确保该 server 已存在配置(在 mcp-servers.json 中)。
 */
export async function authorizeMcpServer(name: string): Promise<{ ok: boolean; error?: string }> {
  // 找到该 server 的配置 — 既可能在已连接,也可能在 failed,也可能两边都有
  const builtInConfig = loadConfig()
  const userConfig = loadUserConfig()
  const config = userConfig[name] || builtInConfig[name]
  const builtIn = name in builtInConfig
  if (!config) return { ok: false, error: `server "${name}" 配置不存在` }
  if (!isOAuthConfig(config)) return { ok: false, error: `server "${name}" 未启用 OAuth(config.oauth ≠ true)` }

  // 把任何残留的失败/连接状态清掉,准备重连
  const fidx = failedServers.findIndex(f => f.name === name)
  if (fidx !== -1) failedServers.splice(fidx, 1)
  const sidx = servers.findIndex(s => s.name === name)
  if (sidx !== -1) {
    try { await servers[sidx].client.close() } catch {}
    servers.splice(sidx, 1)
  }

  // 触发交互式 connect — SDK 会:
  //  1. 调 provider.redirectToAuthorization → 打开浏览器(allowRedirect=true)
  //  2. 抛 UnauthorizedError
  // 我们捕获后等回调 code,调 transport.finishAuth(code),再次 connect
  let client: Client | null = null
  let transport: ReturnType<typeof createTransport> | null = null
  try {
    client = new Client({ name: `openpipal-${name}`, version: '1.0.0' })
    transport = createTransport(config, name, true)
    try {
      await client.connect(transport)
    } catch (err) {
      if (!(err instanceof UnauthorizedError)) throw err
      // 浏览器已打开,等用户授权完成
      const code = await awaitAuthorizationCode()
      // SDK 在 transport 上挂载了 finishAuth 方法
      await (transport as any).finishAuth(code)
      // 重建 client + transport,带新 token 重连
      try { await client.close() } catch {}
      client = new Client({ name: `openpipal-${name}`, version: '1.0.0' })
      transport = createTransport(config, name, true)
      await client.connect(transport)
    }

    // 连接成功 — 完成 tool listing + skill 同步,登记到 servers
    const { tools } = await client.listTools()
    const toolInfos: McpToolInfo[] = []
    for (const t of tools) {
      const info: McpToolInfo = {
        name: t.name,
        description: t.description || '',
        inputSchema: (t.inputSchema as Record<string, unknown>) || { type: 'object', properties: {} }
      }
      const uiMeta = (t as any)._meta?.ui as { resourceUri?: string; permissions?: string[]; csp?: Record<string, unknown>; visibility?: string[] } | undefined
      if (uiMeta?.resourceUri) {
        try {
          const read = await client.readResource({ uri: uiMeta.resourceUri })
          const html = (read.contents || [])
            .filter((c): c is { type?: string; text: string; uri: string; mimeType?: string } => typeof (c as { text?: unknown }).text === 'string')
            .map((c) => c.text)
            .join('')
          if (html) info.ui = { resourceUri: uiMeta.resourceUri, html, permissions: uiMeta.permissions, csp: uiMeta.csp, visibility: uiMeta.visibility }
        } catch (err) {
          console.warn(`[MCP] ${name}.${t.name} UI resource 拉取失败:`, err)
        }
      } else if (uiMeta?.visibility) {
        info.ui = { resourceUri: '', html: '', visibility: uiMeta.visibility }
      }
      toolInfos.push(info)
    }
    servers.push({ connectionId: randomUUID(), name, config, builtIn, client, transport, tools: toolInfos })
    console.log(`[MCP] ${name} OAuth 授权完成,工具: ${tools.map(t => t.name).join(', ')}`)
    await syncMcpSkillsToDisk(name, client)
    return { ok: true }
  } catch (err) {
    if (client) { try { await client.close() } catch {} }
    const msg = String(err)
    failedServers.push({ name, config, builtIn, error: msg })
    return { ok: false, error: msg }
  }
}

/** 撤销某 server 的 OAuth 授权 — 删 token + 清连接状态 */
export async function revokeMcpServerAuth(name: string): Promise<void> {
  const sidx = servers.findIndex(s => s.name === name)
  if (sidx !== -1) {
    try { await servers[sidx].client.close() } catch {}
    servers.splice(sidx, 1)
  }
  const fidx = failedServers.findIndex(f => f.name === name)
  if (fidx !== -1) failedServers.splice(fidx, 1)
  revokeOAuthSession(name)
  // 不重连 — 用户下次主动 authorize 时再走完整流程
  failedServers.push({ name, config: loadUserConfig()[name] || loadConfig()[name] || {}, builtIn: name in loadConfig(), error: '已撤销授权' })
}

// ---- Suggested Skills from MCP server ----
// 约定:server 暴露 uri 以 skill:// 开头的 resource,内容为 SKILL.md(YAML frontmatter + Markdown)
// 写入 ~/.openpipal/skills/_mcp/<serverName>/<skillName>/SKILL.md,由 skill-manager 统一扫描

function getMcpSkillsRootDir(): string {
  return dataPath('skills', '_mcp')
}

function isSafeMcpSkillPathSegment(segment: string): boolean {
  return segment.length > 0
    && segment !== '.'
    && segment !== '..'
    && !segment.includes('/')
    && !segment.includes('\\')
    && !segment.includes('\0')
}

function getMcpServerSkillsDir(serverName: string): string | null {
  if (!isSafeMcpSkillPathSegment(serverName)) return null
  return join(getMcpSkillsRootDir(), serverName)
}

/**
 * Resolve a server-provided skill:// URI to its only permitted write target.
 * Decode before validating so encoded dot segments and separators cannot turn
 * into traversal after a later URL/filesystem interpretation.
 */
export function resolveMcpSkillResourceTarget(serverName: string, uri: string): string | null {
  const serverDir = getMcpServerSkillsDir(serverName)
  if (!serverDir || !uri.startsWith('skill://')) return null

  const rawSegments = uri.slice('skill://'.length).split('/')
  if (rawSegments.length === 0 || rawSegments.some((segment) => segment.length === 0)) return null

  let segments: string[]
  try {
    segments = rawSegments.map((segment) => decodeURIComponent(segment))
  } catch {
    return null
  }
  if (segments.some((segment) => !isSafeMcpSkillPathSegment(segment))) return null
  if (segments.length === 1) segments.push('SKILL.md')

  const targetPath = resolve(serverDir, ...segments)
  const relativeTarget = relative(serverDir, targetPath)
  if (
    relativeTarget.length === 0
    || isAbsolute(relativeTarget)
    || relativeTarget === '..'
    || relativeTarget.startsWith(`..${sep}`)
  ) return null
  return targetPath
}

/** 列出所有 MCP 提供的 skill 目录,供 skill-manager 注入 loadSkills() 的 skillPaths */
export function listMcpSkillDirs(): string[] {
  const root = getMcpSkillsRootDir()
  if (!existsSync(root)) return []
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => join(root, e.name))
  } catch {
    return []
  }
}

async function syncMcpSkillsToDisk(serverName: string, client: Client): Promise<void> {
  const serverDir = getMcpServerSkillsDir(serverName)
  if (!serverDir) {
    console.warn(`[MCP] ${serverName} 的名称不能安全映射为 suggested skill 目录,跳过同步`)
    return
  }
  // 每次同步前清空该 server 的 skill 目录,避免残留已下线的 skill
  if (existsSync(serverDir)) {
    try { rmSync(serverDir, { recursive: true, force: true }) } catch {}
  }

  let resources: { uri: string; mimeType?: string; name?: string }[] = []
  try {
    const res = await client.listResources()
    resources = (res.resources || []) as typeof resources
  } catch {
    // server 不支持 resources/list — 这是可选能力,静默跳过
    return
  }

  const skillResources = resources.filter((r) => r.uri?.startsWith('skill://'))
  if (skillResources.length === 0) return

  let writtenCount = 0
  for (const r of skillResources) {
    const targetPath = resolveMcpSkillResourceTarget(serverName, r.uri)
    if (!targetPath) {
      console.warn(`[MCP] ${serverName} 拒绝不安全的 skill resource URI: ${r.uri}`)
      continue
    }

    try {
      const read = await client.readResource({ uri: r.uri })
      const content = (read.contents || [])
        .filter((c): c is { type?: string; text: string; uri: string; mimeType?: string } => typeof (c as { text?: unknown }).text === 'string')
        .map((c) => c.text)
        .join('')
      if (!content) continue

      mkdirSync(dirname(targetPath), { recursive: true })
      writeFileSync(targetPath, content, 'utf-8')
      writtenCount++
    } catch (err) {
      console.warn(`[MCP] ${serverName} 读取 skill resource ${r.uri} 失败:`, err)
    }
  }

  if (writtenCount > 0) {
    console.log(`[MCP] ${serverName} 同步 ${writtenCount} 个 suggested skill 到 ${serverDir}`)
  }
}

export async function initMcpServers(): Promise<void> {
  // 内置 servers（来自 app bundle 的 mcp-servers.json）—— 并行连接，互不阻塞
  const builtInConfig = loadConfig()
  const builtInTasks: Promise<void>[] = []
  for (const [name, serverConfig] of Object.entries(builtInConfig)) {
    // stdio server 如果声明了 env 但全部值都空,跳过(防止无凭证连接失败刷屏)
    // remote server 的凭证在 headers 里走 ${VAR} 占位符,空值由 server 侧返回 401 处理
    if (!isRemoteConfig(serverConfig)) {
      const resolvedEnv = resolveEnv(serverConfig.env || {})
      const envVals = Object.values(resolvedEnv)
      if (envVals.length > 0 && envVals.every((v) => !v)) {
        console.log(`[MCP] 跳过 ${name}: 未配置凭证，请在 .env 中设置`)
        failedServers.push({ name, config: serverConfig, builtIn: true, error: '未配置凭证' })
        notifyMcpServersUpdated()
        continue
      }
    }
    builtInTasks.push(connectServerWithTimeout(name, serverConfig, true))
  }
  await Promise.allSettled(builtInTasks)

  // 用户添加的 servers（来自 ~/.openpipal/mcp-servers.json）—— 并行连接
  // 去重检查放在 builtIn 批次全部结束之后做，确保能看到 builtIn 的最终连接结果
  const userConfig = loadUserConfig()
  const userTasks: Promise<void>[] = []
  for (const [name, serverConfig] of Object.entries(userConfig)) {
    if (servers.some(s => s.name === name) || failedServers.some(f => f.name === name)) continue
    userTasks.push(connectServerWithTimeout(name, serverConfig, false))
  }
  await Promise.allSettled(userTasks)

  // Agent Plugins 插件声明的 servers(mcp.json)——名字自带 `<plugin>:` 前缀,天然与上两批隔离;
  // 单个 server 失败不影响其他组件(规范失败边界),生命周期随插件启停/卸载走 reloadMcpServers
  const { getPluginMcpServers } = await import('./plugin-manager')
  const pluginTasks: Promise<void>[] = []
  for (const entry of getPluginMcpServers()) {
    if (servers.some(s => s.name === entry.name) || failedServers.some(f => f.name === entry.name)) continue
    pluginTasks.push(connectServerWithTimeout(entry.name, entry.config, false, { pluginName: entry.pluginName }))
  }
  await Promise.allSettled(pluginTasks)
}

// 递归解析 $ref 并清除 LLM API 不支持的 JSON Schema 关键字
function resolveRefs(schema: Record<string, unknown>): Record<string, unknown> {
  // 先提取顶层 $defs
  const defs = (schema['$defs'] || schema['definitions']) as Record<string, unknown> | undefined
  return _resolve(schema, defs || {})
}

function _resolve(node: unknown, defs: Record<string, unknown>): any {
  if (!node || typeof node !== 'object') return node
  if (Array.isArray(node)) return node.map((item) => _resolve(item, defs))

  const obj = node as Record<string, unknown>

  // 解析 $ref
  if (typeof obj['$ref'] === 'string') {
    const ref = obj['$ref'] as string
    const refName = ref.replace('#/$defs/', '').replace('#/definitions/', '')
    const resolved = defs[refName]
    if (resolved && typeof resolved === 'object') {
      return _resolve({ ...(resolved as Record<string, unknown>) }, defs)
    }
    // 无法解析的 $ref，替换为宽松类型
    return { type: 'string', description: `(ref: ${refName})` }
  }

  const cleaned: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(obj)) {
    // 跳过 LLM API 不支持的关键字
    if (key === '$defs' || key === 'definitions' || key === '$schema') continue
    cleaned[key] = _resolve(value, defs)
  }
  return cleaned
}

export function getMcpTools(
  sessionId?: string,
  scope: McpToolAccessScope = {}
): { name: string; description: string; parameters: Record<string, unknown> }[] {
  const result: { name: string; description: string; parameters: Record<string, unknown> }[] = []
  for (const server of scopedVisibleServers(sessionId, scope)) {
    for (const tool of server.tools) {
      if (scope.modelVisibleOnly && !isModelVisibleTool(tool)) continue
      result.push({
        name: tool.name,
        description: tool.description,
        parameters: resolveRefs(tool.inputSchema)
      })
    }
  }
  return result
}

/** 从 MCP ContentBlock 数组里把所有 text block 拼成字符串 — 跨多处复用 */
export function extractTextFromContentBlocks(blocks: unknown): string {
  if (!Array.isArray(blocks)) return ''
  const texts: string[] = []
  for (const item of blocks) {
    if (item?.type === 'text' && typeof item.text === 'string') texts.push(item.text)
  }
  return texts.join('\n')
}

function abortError(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) return signal.reason
  const error = new Error(
    typeof signal.reason === 'string' && signal.reason.length > 0
      ? signal.reason
      : 'Operation aborted'
  )
  error.name = 'AbortError'
  return error
}

function throwIfSignalAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw abortError(signal)
}

export async function callMcpTool(
  toolName: string,
  args: Record<string, unknown>,
  sessionId?: string,
  signal?: AbortSignal,
  scope: McpToolAccessScope = {}
): Promise<string> {
  throwIfSignalAborted(signal)
  const resolved = resolveMcpTool(toolName, sessionId, scope)
  if (!resolved) return `工具 ${toolName} 未找到`

  throwIfSignalAborted(signal)
  const result = await resolved.server.client.callTool(
    { name: toolName, arguments: args },
    undefined,
    signal ? { signal } : undefined
  )
  throwIfSignalAborted(signal)
  return extractTextFromContentBlocks(result.content) || JSON.stringify(result.content)
}

/**
 * 结构化版本 — 同时返回 MCP tool result 的 content(ContentBlock 数组,人/图)
 * 和 structuredContent(typed object,程序读)。MCP Apps 协议把这两个字段都传给
 * iframe 的 ui/notifications/tool-result,Budget Allocator 等应用主要用 structuredContent。
 */
export async function callMcpToolStructured(
  toolName: string,
  args: Record<string, unknown>,
  sessionId?: string,
  signal?: AbortSignal,
  scope: McpToolAccessScope = {}
): Promise<{ content: any[]; structuredContent?: any } | null> {
  throwIfSignalAborted(signal)
  const resolved = resolveMcpTool(toolName, sessionId, scope)
  if (!resolved) return null
  throwIfSignalAborted(signal)
  const result = await resolved.server.client.callTool(
    { name: toolName, arguments: args },
    undefined,
    signal ? { signal } : undefined
  ) as any
  throwIfSignalAborted(signal)
  return {
    content: Array.isArray(result.content) ? result.content : [],
    structuredContent: result.structuredContent
  }
}

function resolveBoundMcpServer(
  serverBinding: string,
  serverName: string,
  sessionId?: string
): ConnectedServer | null {
  return servers.find(server => (
    server.connectionId === serverBinding
    && server.name === serverName
    && isVisible(server, sessionId)
  )) || null
}

/** Whether an opaque connection identity is currently visible in one session view. */
export function isMcpServerBindingVisible(
  serverBinding: string,
  serverName: string,
  sessionId?: string
): boolean {
  return !!resolveBoundMcpServer(serverBinding, serverName, sessionId)
}

/**
 * Check membership against the exact connection that produced an MCP App
 * view. Server names are not identities: different sessions may use the same
 * name, and reconnecting a server must not inherit an earlier view's grant.
 */
export function isMcpToolFromBoundServer(
  serverBinding: string,
  serverName: string,
  toolName: string,
  sessionId?: string
): boolean {
  const server = resolveBoundMcpServer(serverBinding, serverName, sessionId)
  return !!server?.tools.some(tool => tool.name === toolName)
}

/**
 * Exact-bound structured sink for MCP Apps reverse calls. The lookup and call
 * use one ConnectedServer object, so global/session same-name servers and a
 * replacement connection cannot be selected by a fresh name-only search.
 */
export async function callMcpToolStructuredFromBoundServer(
  serverBinding: string,
  serverName: string,
  toolName: string,
  args: Record<string, unknown>,
  sessionId?: string
): Promise<{ content: any[]; structuredContent?: any } | null> {
  const server = resolveBoundMcpServer(serverBinding, serverName, sessionId)
  if (!server?.tools.some(tool => tool.name === toolName)) return null
  const result = await server.client.callTool({ name: toolName, arguments: args }) as any
  return {
    content: Array.isArray(result.content) ? result.content : [],
    structuredContent: result.structuredContent
  }
}

export function isMcpTool(name: string, sessionId?: string): boolean {
  return visibleServers(sessionId).some((s) => s.tools.some((t) => t.name === name))
}

/** 返回某个 MCP 工具的 UI metadata(若声明了 MCP Apps Extension)。pi-mcp-bridge 用于在 call 后触发 artifact 创建 */
export function getMcpToolUi(
  toolName: string,
  sessionId?: string,
  scope: McpToolAccessScope = {}
): (McpToolUiMeta & { serverName: string; serverBinding: string; toolName: string }) | null {
  const resolved = resolveMcpTool(toolName, sessionId, scope)
  if (resolved?.tool.ui?.resourceUri && resolved.tool.ui.html) {
    return {
      ...resolved.tool.ui,
      serverName: resolved.server.name,
      serverBinding: resolved.server.connectionId,
      toolName
    }
  }
  return null
}

// ---- ToolSearch: 渐进式工具披露 ----

interface McpToolMatch {
  name: string
  server: string
  description: string
  inputSchema: Record<string, unknown>
}

/**
 * 关键词搜索可用的 MCP 工具。
 * 匹配工具名（权重 3）、server 名（权重 2）、描述（权重 1）。
 */
export function searchMcpTools(query: string, maxResults = 5, serverFilter?: string[], skipSchema = false, sessionId?: string): McpToolMatch[] {
  const filteredServers = scopedVisibleServers(sessionId, {
    serverFilter,
    modelVisibleOnly: true
  })
  const buildMatch = (s: ConnectedServer, t: ConnectedServer['tools'][0]): McpToolMatch => ({
    name: t.name, server: s.name, description: t.description,
    inputSchema: skipSchema ? {} : resolveRefs(t.inputSchema)
  })

  const keywords = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (keywords.length === 0) {
    const all: McpToolMatch[] = []
    for (const s of filteredServers) {
      for (const t of s.tools) {
        if (!isModelVisibleTool(t)) continue
        all.push(buildMatch(s, t))
      }
    }
    return all.slice(0, maxResults)
  }

  const scored: { tool: McpToolMatch; score: number }[] = []
  for (const s of filteredServers) {
    for (const t of s.tools) {
      if (!isModelVisibleTool(t)) continue
      const nameLower = t.name.toLowerCase()
      const descLower = (t.description || '').toLowerCase()
      const serverLower = s.name.toLowerCase()
      let score = 0
      for (const kw of keywords) {
        if (nameLower.includes(kw)) score += 3
        if (serverLower.includes(kw)) score += 2
        if (descLower.includes(kw)) score += 1
      }
      if (score > 0) scored.push({ tool: buildMatch(s, t), score })
    }
  }

  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, maxResults)
    .map(s => s.tool)
}

/**
 * 格式化单个 MCP 工具的 schema 为 TypeScript 风格描述。
 * 用于 mcp_execute 沙箱内的 tools.describe() 返回值。
 */
export function describeMcpTool(
  toolName: string,
  sessionId?: string,
  scope: McpToolAccessScope = {}
): string | null {
  const resolved = resolveMcpTool(toolName, sessionId, scope)
  if (resolved) {
    const { server, tool } = resolved

    const schema = resolveRefs(tool.inputSchema)
    const props = (schema.properties || {}) as Record<string, any>
    const required = new Set((schema.required as string[]) || [])

    const params = Object.entries(props).map(([name, prop]) => {
      const type = prop.type || 'any'
      const req = required.has(name) ? '' : '?'
      const desc = prop.description ? ` // ${prop.description}` : ''
      return `  ${name}${req}: ${type}${desc}`
    }).join('\n')

    return [
      `${tool.name} (${server.name})`,
      tool.description,
      '',
      `参数:`,
      params || '  (无参数)',
    ].join('\n')
  }
  return null
}

/**
 * 生成 MCP 工具索引（用于 system prompt 注入）。
 * 紧凑格式：按 server 分组，只列工具名，不含 schema。
 */
/**
 * 本会话是否真的挂载了某个 MCP 服务。
 * 用于「只有工具在场时才把相关凭据/标识写进系统提示词」—— 见 openpipal-prompt-core
 * 里的 ClassIn UID 注入:光看环境变量有没有值是不够的,那会让完全无关的会话
 * 也拿到用户标识。
 */
export function hasVisibleMcpServer(name: string, sessionId?: string): boolean {
  const target = name.trim().toLowerCase()
  if (!target) return false
  return visibleServers(sessionId).some(s => s.name.trim().toLowerCase() === target)
}

export function getMcpToolIndex(sessionId?: string): string {
  const visible = visibleServers(sessionId)
  if (visible.length === 0) return ''
  const lines = visible.map(s => {
    const toolNames = s.tools.map(t => t.name).join(', ')
    const scope = s.sessionId ? ' (本会话)' : ''
    return `- **${s.name}**${scope}: ${toolNames}`
  })
  return `\n\n## MCP 工具\n\n已连接的外部工具服务：\n${lines.join('\n')}\n\n使用 mcp_execute 工具，编写 JavaScript 代码调用外部工具。API: tools.search(query), tools.describe(name), tools.call(name, args)（同步调用，不需要 await）。用 console.log 输出。`
}

export function getMcpServerStatus(): McpServerStatus[] {
  const result: McpServerStatus[] = []
  for (const s of servers) {
    const status: McpServerStatus = {
      name: s.name, config: s.config, connected: true, toolCount: s.tools.length, builtIn: s.builtIn, pluginName: s.pluginName
    }
    if (isOAuthConfig(s.config)) status.oauthState = 'authorized'
    result.push(status)
  }
  for (const f of failedServers) {
    const status: McpServerStatus = {
      name: f.name, config: f.config, connected: false, toolCount: 0, builtIn: f.builtIn, error: f.error, pluginName: f.pluginName
    }
    // 文件级判断，不解密——状态广播每次连接变化都会跑，绝不能反复撞钥匙串
    if (isOAuthConfig(f.config)) status.oauthState = hasPersistedOAuthSession(f.name) ? 'authorized' : 'needs-auth'
    result.push(status)
  }
  return result
}

export async function addMcpServer(name: string, config: McpServerConfig): Promise<void> {
  const userConfig = loadUserConfig()
  userConfig[name] = config
  saveUserConfig(userConfig)
  // 移除旧的失败记录（如果存在），重新连接
  const fidx = failedServers.findIndex(f => f.name === name)
  if (fidx !== -1) failedServers.splice(fidx, 1)
  const sidx = servers.findIndex(s => s.name === name)
  if (sidx !== -1) {
    try { await servers[sidx].client.close() } catch {}
    servers.splice(sidx, 1)
  }
  await connectServer(name, config, false)
}

export async function removeMcpServer(name: string): Promise<void> {
  const userConfig = loadUserConfig()
  delete userConfig[name]
  saveUserConfig(userConfig)
  const idx = servers.findIndex(s => s.name === name)
  if (idx !== -1) {
    try { await servers[idx].client.close() } catch {}
    servers.splice(idx, 1)
  }
  const fidx = failedServers.findIndex(f => f.name === name)
  if (fidx !== -1) failedServers.splice(fidx, 1)
  // 清掉该 server 同步过的 suggested skills
  const serverSkillDir = getMcpServerSkillsDir(name)
  if (serverSkillDir && existsSync(serverSkillDir)) {
    try { rmSync(serverSkillDir, { recursive: true, force: true }) } catch {}
  }
}

export async function reloadMcpServers(): Promise<void> {
  for (const s of servers) { try { await s.client.close() } catch {} }
  servers.length = 0
  failedServers.length = 0
  await initMcpServers()
}

export async function testMcpConnection(config: McpServerConfig): Promise<{ ok: boolean; toolCount?: number; error?: string }> {
  let client: Client | null = null
  try {
    client = new Client({ name: 'openpipal-test', version: '1.0.0' })
    const transport = createTransport(config)
    await client.connect(transport)
    const { tools } = await client.listTools()
    await client.close()
    return { ok: true, toolCount: tools.length }
  } catch (err) {
    if (client) { try { await client.close() } catch {} }
    return { ok: false, error: String(err) }
  }
}

export async function shutdownMcp(): Promise<void> {
  for (const server of servers) {
    try {
      await server.client.close()
    } catch {
      // ignore
    }
  }
  servers.length = 0
}

// ============================================================================
// Session-scoped MCP（ACP session/new.mcpServers 注入用）
// ============================================================================
//
// 这些 API 让外部 ACP client（Zed / Claude Code / etc）通过 ACP 标准字段
// `NewSessionRequest.mcpServers` 把临时 MCP server 注入到 OpenPipal。
// 与全局 server 完全隔离：consumer 函数不传 sessionId 就看不到这些 server，
// 因此桌面端正常路径 + 其他 ACP session 都不会被污染。
//
// 生命周期：openpipal-acp 在 newSession 时调 registerSessionMcpServers，
// 在 ACP 进程退出时调 unregisterSessionMcpServers 清理。

export interface SessionMcpRegistration {
  /** 用户可读的 server 名（来自 ACP McpServer.name） */
  name: string
  config: McpServerConfig
}

export interface SessionMcpResult {
  registered: { name: string; toolCount: number }[]
  failed: { name: string; error: string }[]
}

/**
 * 注册一组 session 范围的 MCP server 并连接它们。
 *
 * 同 sessionId 多次调用 → 增量追加（不会清掉前一次注册的 server）。
 * 同 sessionId 内 name 冲突 → 先关旧的再连新的（让 client 覆盖式更新成为可能）。
 *
 * 返回的 failed 列表包含连接失败的 server。不抛错——单个 server 失败不应让
 * 整个 ACP session 创建失败。
 */
export async function registerSessionMcpServers(
  sessionId: string,
  registrations: SessionMcpRegistration[]
): Promise<SessionMcpResult> {
  const result: SessionMcpResult = { registered: [], failed: [] }

  for (const { name, config } of registrations) {
    // 同 sessionId 内重名 → 关旧的
    const existingIdx = servers.findIndex(s => s.sessionId === sessionId && s.name === name)
    if (existingIdx !== -1) {
      try { await servers[existingIdx].client.close() } catch {}
      servers.splice(existingIdx, 1)
    }

    try {
      const client = new Client({ name: `openpipal-acp-${sessionId}-${name}`, version: '1.0.0' })
      const transport = createTransport(config, name, false)
      await client.connect(transport)
      const { tools } = await client.listTools()

      // 预拉 MCP Apps UI 资源（同 connectServer 逻辑，复用一份精简版）
      const toolInfos: McpToolInfo[] = []
      for (const t of tools) {
        const info: McpToolInfo = {
          name: t.name,
          description: t.description || '',
          inputSchema: (t.inputSchema as Record<string, unknown>) || { type: 'object', properties: {} }
        }
        const uiMeta = (t as any)._meta?.ui as { resourceUri?: string; permissions?: string[]; csp?: Record<string, unknown>; visibility?: string[] } | undefined
        if (uiMeta?.resourceUri) {
          try {
            const read = await client.readResource({ uri: uiMeta.resourceUri })
            const html = (read.contents || [])
              .filter((c): c is { type?: string; text: string; uri: string; mimeType?: string } => typeof (c as { text?: unknown }).text === 'string')
              .map((c) => c.text)
              .join('')
            if (html) info.ui = { resourceUri: uiMeta.resourceUri, html, permissions: uiMeta.permissions, csp: uiMeta.csp, visibility: uiMeta.visibility }
          } catch (err) {
            console.warn(`[MCP/acp] ${name}.${t.name} UI resource 拉取失败:`, err)
          }
        } else if (uiMeta?.visibility) {
          info.ui = { resourceUri: '', html: '', visibility: uiMeta.visibility }
        }
        toolInfos.push(info)
      }

      servers.push({ connectionId: randomUUID(), name, config, builtIn: false, client, transport, tools: toolInfos, sessionId })
      const kind = isRemoteConfig(config) ? 'remote' : 'stdio'
      console.log(`[MCP/acp] session=${sessionId} server="${name}" 已连接 (${kind})，工具: ${toolInfos.map(t => t.name).join(', ')}`)
      result.registered.push({ name, toolCount: toolInfos.length })
    } catch (err) {
      const msg = String(err)
      console.error(`[MCP/acp] session=${sessionId} server="${name}" 连接失败:`, msg)
      result.failed.push({ name, error: msg })
    }
  }

  return result
}

/** 注销并关闭某 sessionId 下所有 server。ACP 进程退出 / session 显式结束时调。 */
export async function unregisterSessionMcpServers(sessionId: string): Promise<void> {
  const toClose: ConnectedServer[] = []
  for (let i = servers.length - 1; i >= 0; i--) {
    if (servers[i].sessionId === sessionId) {
      toClose.push(servers[i])
      servers.splice(i, 1)
    }
  }
  for (const s of toClose) {
    try { await s.client.close() } catch {}
  }
  if (toClose.length > 0) {
    console.log(`[MCP/acp] session=${sessionId} 已注销 ${toClose.length} 个 server`)
  }
}

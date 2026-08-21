import { createServer, IncomingMessage, ServerResponse } from 'http'
import { readFileSync, existsSync } from 'fs'
import { join, extname } from 'path'
import { getAgentRuntime } from './agent-runtime'
import type { ChatMessage, ChatSource } from './agent-runtime/contracts'
import { resolveAgentOverrides } from './agent-overrides'
import { executeExtraction } from './memory-extractor'
import { listArchivedMemories, restoreArchivedMemory, getGlobalMemoryDir, isWithinMemoryRoot } from './memory-store'
import { isAutoMemoryEnabled } from './config-manager'
import { initRoles, switchRole, getAllRoles, getCurrentRole, getRoleConfig, getRoleAssetsDir, getDisabledApps, getDetectedApps, isAppFollowingEnabled, setAppFollowingEnabled, setDisabledApps } from './role-manager'
import { getWorkspace, listWorkspaces } from './agent-workspace-store'
import { BROWSER_APPS } from './app-detector'
import { getExtensionPageHtml } from './extension-page'
import { attachBrowserControlWss } from './browser-control'
import { setActiveBrowserUrl } from './browser-policy-store'
import { resolvePdfIntoCache, fillPdfPageContentFromCache } from './pdf-context'
import { homedir } from 'os'
import { randomUUID } from 'crypto'
import { createTranscriptCollector } from './pi-event-adapter'
import {
  listConversations, createConversation, getConversationMessages, getConversationMessagesSerialized, getConversation,
  appendMessages, deleteConversation, updateConversationTitle, updateConversationRole, updateConversationConfig, replaceMessages,
  shouldReplayStoredMessage, StoredMessage, ConversationConfig, updateConversationWorkspace,
  mutateConversationConfig
} from './conversation-store'
import {
  getEffectiveModelConfigForDisplay, saveModelConfig, getProviders, testConnection, hasApiKey, isUserCustomConfig, clearModelConfig,
  ModelConfig
} from './config-manager'
import {
  registerSessionMcpServers, unregisterSessionMcpServers,
  type SessionMcpRegistration, type McpServerConfig
} from './mcp-manager'
import { ensureAcpMcpToken } from './acp-auth'
import { clearConversationGoal, readConversationGoal, setConversationGoal } from './conversation-goal'
import { subscribeConversationChanges } from './conversation-events'
import {
  endAcpStream,
  forgetAcpSession,
  noteAcpActivity,
  noteAcpHandshake,
  startAcpStream
} from './acp-session-registry'
import {
  getBrowserContext,
  markExtensionActive,
  setBrowserContext,
  type BrowserContext
} from './browser-context-store'
import {
  acquireConversationExecution,
  ConversationExecutionBusyError,
  getConversationExecution,
  type ConversationExecutionLease
} from './conversation-execution-coordinator'
import {
  isDurableHttpTurn,
  normalizeHttpConversationId,
  validateHttpChatBodySource
} from './http-chat-boundary'
import { isSafeConversationStorageId } from './attachment-store'
import {
  BROWSER_AUTH_HEADER,
  LocalHttpAuthBoundary,
  canUseUnboundExtensionCors,
  isBrowserRouteAllowed,
  isExactChromeExtensionOrigin,
  isPublicRendererPath,
  isStrictLoopbackHost,
  type LocalHttpPrincipal,
} from './local-http-auth'
import {
  ARTIFACT_COMPLETION_REQUEST_BODY_MAX_BYTES,
  CONTEXT_REQUEST_BODY_MAX_BYTES,
  isRequestBodyTooLargeError,
  readBoundedRequestBody as readBody,
  WEBHOOK_REQUEST_BODY_MAX_BYTES,
} from './http-request-body'
import {
  buildDesignSystemPreviewContentSecurityPolicy,
  getDesignSystemResourceCapability,
  parseDesignSystemStaticCapabilityPath,
  readDesignSystemJsonResource,
  readDesignSystemResource,
  readDesignSystemStaticResource,
  type DesignSystemResourceFailure,
} from './design-system-resource'
import { getLocaleState, updateLocalePreference } from './locale-manager'
import { isLocalePreference } from '../shared/i18n/contract'

// Agent Runtime 全栈懒加载（同 ipc-handlers.ts），由 router 统一缓存与失败重试。
const agentService = getAgentRuntime

const PORT = 3031
const RENDERER_DIR = join(__dirname, '../renderer')
const LOCALE_REQUEST_BODY_MAX_BYTES = 256
const APP_FOLLOWING_REQUEST_BODY_MAX_BYTES = 256

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ico': 'image/x-icon'
}

// ---- HTTP 模式权限通道（与桌面 IPC 对称）----
// 当前正在跑的 /chat/stream 响应,按 conversationId 索引。权限确认气泡需要写进"正在
// 流式的那条响应",浏览器侧栏才看得到(桌面走 webContents.send,这里走 SSE)。
// ACP 同理:适配器收到这条事件后反向调客户端的 session/request_permission,
// 编辑器里就地确认——此前 ACP 被挡在这里,弹窗只能落到桌面窗口,编辑器干等。
const activeStreams = new Map<string, {
  response: ServerResponse
  executionId: string
  source: ChatSource
}>()

// 把内联权限请求写进对应会话的活动 SSE 流。命中并写成功返回 true(此时无需再发桌面 IPC)。
export function writePermissionToStream(conversationId: string | undefined, request: Record<string, unknown>): boolean {
  if (!conversationId) return false
  const stream = activeStreams.get(conversationId)
  const execution = getConversationExecution(conversationId)
  if (
    !stream ||
    stream.response.destroyed ||
    (stream.source !== 'extension' && stream.source !== 'acp') ||
    execution?.owner.entrypoint !== 'http' ||
    execution.aborted ||
    execution.executionId !== stream.executionId ||
    request.executionId !== stream.executionId ||
    request.conversationId !== conversationId
  ) return false
  try {
    stream.response.write(`data: ${JSON.stringify({ type: 'permission', request, conversationId })}\n\n`)
    return true
  } catch {
    return false
  }
}

/**
 * ACP 适配器持的是 native 令牌（能力比浏览器令牌宽），所以它的权限回传必须钉死在
 * "它自己那条还活着的流"上：会话有 ACP 活动流、流未销毁、executionId 与本轮一致，
 * 三者缺一即拒。少了这层，任何本机 native 调用方都能替别的会话点"允许"。
 */
export function isAcpPermissionResponder(
  conversationId: string | undefined,
  executionId: string | undefined
): boolean {
  if (!conversationId || !executionId) return false
  const stream = activeStreams.get(conversationId)
  return (
    !!stream &&
    !stream.response.destroyed &&
    stream.source === 'acp' &&
    stream.executionId === executionId
  )
}

// POST /api/permission 的解析器(由 index.ts 注入 ipc-handlers.resolveInlinePermission,避免循环依赖)
let inlinePermissionResolver: ((
  requestId: string,
  approved: boolean,
  sessionApprove?: boolean,
  executionId?: string,
  conversationId?: string
) => boolean) | null = null
export function setInlinePermissionResolver(fn: typeof inlinePermissionResolver): void {
  inlinePermissionResolver = fn
}

function applySecurityHeaders(res: ServerResponse): void {
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('Referrer-Policy', 'no-referrer')
  res.setHeader('Cross-Origin-Resource-Policy', 'same-site')
}

function applyExtensionCors(req: IncomingMessage, res: ServerResponse, auth: LocalHttpAuthBoundary, allowUnbound = false): boolean {
  const origin = req.headers.origin
  const allowed = auth.isBoundExtensionOrigin(origin) || (allowUnbound && isExactChromeExtensionOrigin(origin))
  if (!allowed || typeof origin !== 'string') return false
  res.setHeader('Access-Control-Allow-Origin', origin)
  res.setHeader('Vary', 'Origin')
  return true
}

function json(res: ServerResponse, status: number, data: unknown): void {
  applySecurityHeaders(res)
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(data))
}

function requestErrorStatus(error: unknown, fallback: number): number {
  return isRequestBodyTooLargeError(error) ? 413 : fallback
}

async function readJsonBody(req: IncomingMessage, maxBytes: number): Promise<unknown> {
  return JSON.parse(await readBody(req, maxBytes))
}

/** Decode exactly one URL path segment, then apply the storage-id boundary. */
function decodeConversationRouteId(segment: string): string | null {
  try {
    const decoded = decodeURIComponent(segment)
    return isSafeConversationStorageId(decoded) ? decoded : null
  } catch {
    return null
  }
}

function designSystemResourceStatus(result: DesignSystemResourceFailure): number {
  if (result.code === 'invalid-name' || result.code === 'invalid-path') return 400
  if (result.code === 'forbidden') return 403
  if (result.code === 'not-found' || result.code === 'not-file') return 404
  if (result.code === 'too-large') return 413
  return 415
}

// 只注入轻量提示（页面标题），详细内容通过工具按需获取
function injectLightContext(messages: ChatMessage[], ctx: any): void {
  if (!ctx) return
  const lastMsg = messages[messages.length - 1]
  if (lastMsg?.role !== 'user') return

  let hint = ''
  if (ctx.title) hint += `\n\n[用户当前浏览的页面: ${ctx.title}]`
  if (ctx.selectedText) hint += `\n[用户选中的文本: ${ctx.selectedText.substring(0, 200)}]`
  // 不注入 pageContent、subtitles — 这些通过 read_page_content 工具按需获取

  if (hint) lastMsg.content += hint
}

// 解析请求中的上下文并注入到消息中
function resolveAndInjectContext(body: any, messages: ChatMessage[]): void {
  if (body.context) {
    // 只做同步缓存回填、不做网络/解析——这是聊天关键路径。web-api-shim.ts 每次发消息都带
    // renderer 侧空 pageContent 的 context，若不在此回填会把 /context 已解析好的 PDF 正文覆盖掉。
    fillPdfPageContentFromCache(body.context)
    // 纵深防御：正常链路（web-api-shim）从不带 pdfBase64，但 ACP/第三方 HTTP 客户端可能在
    // chat body 的 context 里带上这个字段——顺手清掉，不让它有机会混进 browserContext。
    delete (body.context as any)?.pdfBase64
    setBrowserContext(body.context as BrowserContext)
  }
  const ctx = body.context || getBrowserContext()
  if (ctx) {
    injectLightContext(messages, ctx)
  }
}

// 静态文件服务
function serveStatic(urlPath: string, res: ServerResponse): boolean {
  // 安全检查：不允许路径遍历
  const safePath = urlPath.replace(/\.\./g, '').replace(/\/\//g, '/')
  let filePath = join(RENDERER_DIR, safePath === '/' ? 'index.html' : safePath)

  if (!existsSync(filePath)) {
    // SPA fallback：非文件路径返回 index.html
    filePath = join(RENDERER_DIR, 'index.html')
  }

  if (!existsSync(filePath)) return false

  try {
    const ext = extname(filePath)
    const mime = MIME_TYPES[ext] || 'application/octet-stream'
    const content = readFileSync(filePath)
    applySecurityHeaders(res)
    // HTML 不缓存（确保插件加载最新版），资源文件有 hash 可缓存
    const cacheControl = ext === '.html' ? 'no-cache, no-store' : 'public, max-age=3600'
    res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': cacheControl })
    res.end(content)
    return true
  } catch {
    return false
  }
}

// 当前监听中的 server（设置页要如实回答"服务开着吗"，不能拿常量 PORT 冒充）
let activeServer: ReturnType<typeof createServer> | null = null

/** 正在监听的端口；没起来（或端口被占用）时为 null。 */
export function getHttpListeningPort(): number | null {
  const address = activeServer?.address()
  return typeof address === 'object' && address ? address.port : null
}

export function startHttpServer(port: number = PORT): ReturnType<typeof createServer> {
  // The adapter gets this local-only token from a 0600 file. Never expose it
  // through an HTTP route; a browser cannot satisfy this custom CORS header.
  const acpMcpToken = ensureAcpMcpToken()
  const auth = new LocalHttpAuthBoundary(acpMcpToken)
  const server = createServer((req, res) => {
    // Node does not await an async request listener. Keep every route rejection
    // inside this boundary so a failed dynamic import, socket write, or handler
    // cannot escape as an unhandled rejection and take down the desktop process.
    void (async () => {
      const address = server.address()
      const actualPort = typeof address === 'object' && address ? address.port : port

      // Validate the browser-controlled Host header before URL parsing, CORS,
      // body parsing or route dispatch. Besides DNS rebinding, this prevents a
      // malformed request-target from reaching URL construction for an
      // untrusted host.
      if (!isStrictLoopbackHost(req.headers.host, actualPort)) {
        json(res, 421, { error: 'Loopback Host and active OpenPipal port required' })
        return
      }

      const url = req.url || ''
      let pathname: string
      try {
        pathname = new URL(url, 'http://openpipal.local').pathname
      } catch {
        json(res, 400, { error: 'Malformed request target' })
        return
      }

    if (req.method === 'OPTIONS') {
      const requestedMethod = req.headers['access-control-request-method'] as string | undefined
      const allowUnbound = canUseUnboundExtensionCors(
        auth.getBoundExtensionOrigin(), req.headers.origin, requestedMethod, pathname
      )
      const corsAllowed = applyExtensionCors(req, res, auth, allowUnbound)
      const bootstrapRoute =
        (pathname === '/extension/session' && requestedMethod === 'POST') ||
        (pathname === '/health' && requestedMethod === 'GET')
      if (!corsAllowed || (!bootstrapRoute && !isBrowserRouteAllowed(requestedMethod, pathname))) {
        json(res, 403, { error: 'CORS origin or route is not allowed' })
        return
      }
      applySecurityHeaders(res)
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS')
      res.setHeader('Access-Control-Allow-Headers', `Content-Type, ${BROWSER_AUTH_HEADER}`)
      res.setHeader('Access-Control-Max-Age', '600')
      res.writeHead(204)
      res.end()
      return
    }

    // ==================== API 路由 ====================

    // 健康检查
    if (url === '/health' && req.method === 'GET') {
      applyExtensionCors(req, res, auth, true)
      json(res, 200, { status: 'ok', app: 'openpipal', processNonce: auth.getProcessNonce() })
      return
    }

    // The browser token is process-lifetime and never persists or reaches a
    // URL. The first exact extension origin is pinned for this process.
    if (pathname === '/extension/session' && req.method === 'POST') {
      const session = auth.bindExtensionSession(req.headers.origin)
      if (!session.ok) {
        json(res, session.status, { error: session.error })
        return
      }
      applyExtensionCors(req, res, auth)
      res.setHeader('Cache-Control', 'no-store')
      json(res, 200, { token: session.token })
      return
    }

    // ---- Webhook 触发任务 ----
    // POST /webhook/task/:id
    // Header: X-OpenPipal-Secret（必需；旧的无 secret 任务 fail closed）
    // Body: 任意 JSON / 文本，会拼接到 task.prompt 之后传给 Agent
    const webhookMatch = url.match(/^\/webhook\/task\/([\w-]+)$/)
    if (webhookMatch && req.method === 'POST') {
      const taskId = webhookMatch[1]
      const providedSecret = req.headers['x-openpipal-secret'] as string | undefined
      const { authorizeTaskWebhook, triggerTaskByWebhook } = await import('./scheduler')
      const authorization = authorizeTaskWebhook(taskId, providedSecret)
      if (!authorization.ok) {
        json(res, authorization.status, { ok: false, error: authorization.error })
        return
      }
      let rawBody: string
      try {
        rawBody = await readBody(req, WEBHOOK_REQUEST_BODY_MAX_BYTES)
      } catch (error) {
        json(res, requestErrorStatus(error, 400), { ok: false, error: (error as Error)?.message || 'invalid body' })
        return
      }
      const forwardedHeaders: Record<string, string> = {}
      for (const [name, value] of Object.entries(req.headers)) {
        if (
          name === 'x-openpipal-secret' ||
          name === 'authorization' ||
          name === 'x-openpipal-acp-token' ||
          name === 'x-openpipal-local-token' ||
          name === 'x-openpipal-browser-token'
        ) continue
        if (typeof value === 'string') forwardedHeaders[name] = value
        else if (Array.isArray(value)) forwardedHeaders[name] = value.join(', ')
      }
      const result = await triggerTaskByWebhook(taskId, providedSecret, {
        body: rawBody,
        headers: forwardedHeaders
      })
      json(res, result.status, { ok: result.ok, error: result.error })
      return
    }

    let principal: LocalHttpPrincipal | undefined
    if (!isPublicRendererPath(req.method, pathname)) {
      const authentication = auth.authenticate(req.headers)
      if (!authentication.ok) {
        if (req.headers[BROWSER_AUTH_HEADER] !== undefined) {
          applyExtensionCors(req, res, auth, canUseUnboundExtensionCors(
            auth.getBoundExtensionOrigin(), req.headers.origin, req.method, pathname
          ))
        }
        json(res, authentication.status, { error: authentication.error })
        return
      }
      principal = authentication.principal
      if (principal === 'browser') {
        if (!isBrowserRouteAllowed(req.method, pathname)) {
          json(res, 403, { error: 'Route is outside browser authorization scope' })
          return
        }
        applyExtensionCors(req, res, auth)
      }
    }

    // 插件注册（启动时调一次）
    if (url === '/extension/register' && req.method === 'POST') {
      markExtensionActive()
      console.log('[HTTP] 浏览器插件已注册')
      json(res, 200, { ok: true })
      return
    }

    // 接收浏览器上下文
    if (url === '/context' && req.method === 'POST') {
      try {
        const ctx = JSON.parse(await readBody(req, CONTEXT_REQUEST_BODY_MAX_BYTES))
        // 字节先剥离：browserContext 全程不持有 pdfBase64（哪怕只是异步解析期间的瞬时状态）
        const pdfB64 = ctx.pdfBase64
        delete ctx.pdfBase64
        fillPdfPageContentFromCache(ctx)
        setBrowserContext(ctx as BrowserContext)
        markExtensionActive()
        // 喂给站点轴策略:click/fill/scroll 等写操作据此判断"当前在哪个站点"——必须与赋值同步先行，
        // 不能等 PDF 解析完才更新：慢请求（fetch 超时/大文件解析）若晚于后续快请求完成，会把
        // 旧页面的 URL 倒灌回站点轴，而 activeBrowserUrl 正是写操作放行判定的依据
        setActiveBrowserUrl(ctx?.url, ctx?.tabId)
        json(res, 200, { ok: true }) // 先响应，不占住扩展端连接；PDF 解析放后台继续跑
        try {
          await resolvePdfIntoCache({ url: ctx.url, meta: ctx.meta, pageContent: ctx.pageContent, pdfBase64: pdfB64 })
          // 解析完成时页面可能已经切走——仅当仍是当前上下文（对象同一性）才回填，防止旧页正文倒灌新页
          if (getBrowserContext() === ctx) fillPdfPageContentFromCache(ctx)
        } catch {
          // 后台解析失败不影响已发出的响应；失败原因已由 resolvePdfIntoCache 落进负缓存
        }
      } catch (err: any) {
        json(res, requestErrorStatus(err, 400), { error: err.message })
      }
      return
    }

    // ---- Role API ----
    if (url === '/role/init-state' && req.method === 'GET') {
      json(res, 200, initRoles())
      return
    }
    if (url === '/role/all' && req.method === 'GET') {
      json(res, 200, getAllRoles())
      return
    }
    if (url === '/role/current' && req.method === 'GET') {
      json(res, 200, getCurrentRole())
      return
    }
    if (url === '/role/switch' && req.method === 'POST') {
      try {
        const { roleName } = JSON.parse(await readBody(req))
        const role = switchRole(roleName)
        json(res, 200, role)
      } catch (err: any) {
        json(res, requestErrorStatus(err, 400), { error: err.message })
      }
      return
    }

    // ---- Agent 列表 API（合并内置角色 + 用户保存的 Agent，给 openpipal-acp 等外部 client 用） ----
    if (url === '/api/agents/list' && req.method === 'GET') {
      // 适配器 initialize 必拉这张表——本进程"见过适配器"的唯一凭据
      if (principal === 'native') noteAcpHandshake()
      json(res, 200, {
        builtins: getAllRoles(),
        agents: listWorkspaces()
      })
      return
    }

    // ---- 技能列表（给 openpipal-acp 暴露成编辑器的斜杠命令用）----
    // 两个可选参数各管一档作用域，与模型提示词里那份索引同一套规则：
    // workspaceId → 自定义 Agent 只带它自己的技能；role → 内置角色带全局技能 + 自己的专属技能。
    if (pathname === '/api/skills' && req.method === 'GET') {
      const params = new URL(url, 'http://openpipal.local').searchParams
      const workspaceId = params.get('workspaceId') || undefined
      const role = params.get('role') || undefined
      // workspaceId 会被拼进 dataPath('agents', id, 'skills')。不校验就是路径拼接漏洞：
      // `../../..` 能把数据目录外的 <任意目录>/skills 读出来（旁边那条 PATCH 一直是校验的）。
      if (workspaceId !== undefined && !getWorkspace(workspaceId)) {
        json(res, 400, { error: 'Unknown conversation agent' })
        return
      }
      // role 同样会被拼成 resources/system-agents/<role>/skills，同样只认名单里的
      if (role !== undefined && !getAllRoles().some(item => item.name === role)) {
        json(res, 400, { error: 'Unknown role' })
        return
      }
      const { listSkillsMeta } = await import('./skill-manager')
      json(res, 200, {
        skills: listSkillsMeta(workspaceId, role)
          .filter(skill => skill.enabled)
          .map(skill => ({ name: skill.name, description: skill.description }))
      })
      return
    }

    // ---- 对话管理 API ----
    if (url === '/api/conversations' && req.method === 'GET') {
      json(res, 200, listConversations())
      return
    }
    if (url === '/api/conversations' && req.method === 'POST') {
      try {
        const body = JSON.parse(await readBody(req))
        // Stage 8: 接受 agentId / workspaceId,让 openpipal-acp 等外部 client 能创建关联自定义 Agent 的会话
        const conv = createConversation(
          body.role || getCurrentRole().name,
          body.title,
          body.agentId,
          body.workspaceId
        )
        json(res, 200, conv)
      } catch (err: any) {
        json(res, requestErrorStatus(err, 400), { error: err.message })
      }
      return
    }
    // /api/conversations/:id
    const convMatch = pathname.match(/^\/api\/conversations\/([^/]+)$/)
    if (convMatch) {
      const id = decodeConversationRouteId(convMatch[1])
      if (!id) {
        json(res, 400, { error: 'Invalid conversation id' })
        return
      }
      if (req.method === 'GET') {
        const conv = getConversation(id)
        if (conv) json(res, 200, conv)
        else json(res, 404, { error: 'Not found' })
        return
      }
      if (req.method === 'DELETE') {
        await deleteConversation(id)
        forgetAcpSession(id)
        json(res, 200, { ok: true })
        return
      }
      if (req.method === 'PATCH') {
        try {
          const body = JSON.parse(await readBody(req))
          if (!getConversation(id)) {
            json(res, 404, { error: 'Conversation not found' })
            return
          }
          // 校验全部先做完，再落第一笔——否则 `{role:'x', workspaceId:'不存在'}` 会
          // 把 role 写进磁盘之后才发现 workspaceId 非法，用户看到 400 但人格已经变了。
          if (body.role !== undefined && (typeof body.role !== 'string' || !getRoleConfig(body.role))) {
            json(res, 400, { error: 'Unknown conversation role' })
            return
          }
          // 改挂自定义 Agent（我的 Agents）。null / '' = 切回内置角色。
          const workspaceId = body.workspaceId === null || body.workspaceId === ''
            ? undefined
            : body.workspaceId
          if (
            body.workspaceId !== undefined
            && workspaceId !== undefined
            && (typeof workspaceId !== 'string' || !getWorkspace(workspaceId))
          ) {
            json(res, 400, { error: 'Unknown conversation agent' })
            return
          }

          if (body.role !== undefined && !await updateConversationRole(id, body.role)) {
            json(res, 409, { error: 'Conversation role is locked after the first message' })
            return
          }
          // 与 role 同一把锁：开聊后拒绝，编辑器那边会看到同样语义的 409。
          if (body.workspaceId !== undefined && !await updateConversationWorkspace(id, workspaceId)) {
            json(res, 409, { error: 'Conversation agent is locked after the first message' })
            return
          }
          if (body.title && !await updateConversationTitle(id, body.title)) {
            json(res, 404, { error: 'Conversation not found' })
            return
          }
          // 会话级 config（roleBrief/initialAssets/projectName 等）——浏览器插件唯一的写入口。
          // 没有它,preflow 点选的模板在 HTTP/SSE 面上永远到不了 resolveAgentOverrides(conv.config)。
          if (body.config !== undefined) {
            if (!body.config || typeof body.config !== 'object' || Array.isArray(body.config)) {
              json(res, 400, { error: 'Conversation config must be an object' })
              return
            }
            if (!await updateConversationConfig(id, body.config)) {
              json(res, 404, { error: 'Conversation not found' })
              return
            }
            // 适配器创建会话后立刻 PATCH 这个标记，等于"这条 ACP 会话刚出生"
            if ((body.config as ConversationConfig).acp?.adapter) noteAcpActivity(id)
          }
          json(res, 200, { ok: true })
        } catch (err: any) {
          json(res, requestErrorStatus(err, 400), { error: err.message })
        }
        return
      }
    }
    // ---- 会话目标（`/goal` 的 HTTP 面，给 ACP 用；桌面端走 chat:set-goal IPC）----
    // 设了目标之后每轮结束由 GoalChecker 判定有没有达成，没达成就自动继续跑（上限见
    // GOAL_MAX_TURNS）。这里只读写状态，判定循环在 pi-agent-service 里。
    const goalMatch = pathname.match(/^\/api\/conversations\/([^/]+)\/goal$/)
    if (goalMatch) {
      const id = decodeConversationRouteId(goalMatch[1])
      if (!id) {
        json(res, 400, { error: 'Invalid conversation id' })
        return
      }
      if (!getConversation(id)) {
        json(res, 404, { error: 'Conversation not found' })
        return
      }
      if (req.method === 'GET') {
        json(res, 200, { goal: readConversationGoal(id) })
        return
      }
      if (req.method === 'POST') {
        try {
          const body = JSON.parse(await readBody(req))
          if (typeof body.text !== 'string' || !body.text.trim()) {
            json(res, 400, { error: 'Goal text is required' })
            return
          }
          const goal = await setConversationGoal(id, body.text)
          if (!goal) {
            json(res, 404, { error: 'Conversation not found' })
            return
          }
          json(res, 200, { goal })
        } catch (err: any) {
          json(res, requestErrorStatus(err, 400), { error: err.message })
        }
        return
      }
      if (req.method === 'DELETE') {
        json(res, 200, { ok: await clearConversationGoal(id) })
        return
      }
    }

    // /api/conversations/:id/messages
    const msgMatch = pathname.match(/^\/api\/conversations\/([^/]+)\/messages$/)
    if (msgMatch) {
      const id = decodeConversationRouteId(msgMatch[1])
      if (!id) {
        json(res, 400, { error: 'Invalid conversation id' })
        return
      }
      if (req.method === 'GET') {
        json(res, 200, await getConversationMessagesSerialized(id))
        return
      }
      if (req.method === 'POST') {
        try {
          const body = JSON.parse(await readBody(req))
          const messages: StoredMessage[] = body.messages || []
          await appendMessages(id, messages)
          json(res, 200, { ok: true })
        } catch (err: any) {
          json(res, requestErrorStatus(err, 400), { error: err.message })
        }
        return
      }
      if (req.method === 'PUT') {
        try {
          const body = JSON.parse(await readBody(req))
          await replaceMessages(id, body.messages || [])
          json(res, 200, { ok: true })
        } catch (err: any) {
          json(res, requestErrorStatus(err, 400), { error: err.message })
        }
        return
      }
    }

    // ---- 桌面端 → 适配器的常驻推送通道 ----
    // 此前只有"适配器主动来问"一个方向：桌面端改了人格/标题，编辑器要等下一轮开跑
    // 才更正。这条一直挂着的 SSE 让桌面端能立刻捅一下。只广播"哪条会话的哪类东西变了"，
    // 内容仍以磁盘为准，由适配器自己回读——不然同一份状态就有了两个来源。
    if (pathname === '/api/acp/events' && req.method === 'GET') {
      if (principal !== 'native') {
        json(res, 403, { error: 'ACP authorization required' })
        return
      }
      applySecurityHeaders(res)
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no'
      })
      res.socket?.setNoDelay(true)

      const write = (payload: Record<string, unknown>): void => {
        if (res.destroyed) return
        try { res.write(`data: ${JSON.stringify(payload)}\n\n`) } catch { /* 关闭中 */ }
      }
      // 先给一条 ready：适配器据此确认通道真的建起来了，而不是卡在等第一条变更
      write({ type: 'ready' })

      const unsubscribe = subscribeConversationChanges((change) => {
        write({ type: 'conversation_changed', ...change })
      })
      // 长静默会被中间层当成空闲裁掉——这条通道大部分时间就是静默的
      const heartbeat = setInterval(() => {
        if (!res.destroyed) { try { res.write(': ping\n\n') } catch { /* 关闭中 */ } }
      }, 15_000)

      res.once('close', () => {
        clearInterval(heartbeat)
        unsubscribe()
      })
      return
    }

    // ---- ACP session-scoped MCP server 注入(标准 ACP session/new.mcpServers) ----
    // POST   /api/acp/sessions/:sessionId/mcp  body: { mcpServers: McpServer[] (ACP shape) }
    // DELETE /api/acp/sessions/:sessionId/mcp
    const acpMcpMatch = url.match(/^\/api\/acp\/sessions\/([^/]+)\/mcp$/)
    if (acpMcpMatch) {
      if (principal !== 'native') {
        json(res, 403, { error: 'ACP MCP authorization required' })
        return
      }

      const sessionId = acpMcpMatch[1]
      if (req.method === 'DELETE') forgetAcpSession(sessionId)
      if (req.method === 'POST') {
        try {
          const body = JSON.parse(await readBody(req))
          const rawServers: any[] = Array.isArray(body?.mcpServers) ? body.mcpServers : []
          const regs: SessionMcpRegistration[] = rawServers.map((s) => {
            // env/headers 在 ACP 里是 Array<{name,value}>,mcp-manager 期望 Record。展平。
            const envArr: Array<{ name: string; value: string }> = Array.isArray(s?.env) ? s.env : []
            const headerArr: Array<{ name: string; value: string }> = Array.isArray(s?.headers) ? s.headers : []
            const envRecord: Record<string, string> = {}
            for (const e of envArr) if (e && typeof e.name === 'string') envRecord[e.name] = String(e.value ?? '')
            const headerRecord: Record<string, string> = {}
            for (const h of headerArr) if (h && typeof h.name === 'string') headerRecord[h.name] = String(h.value ?? '')

            const isRemote = s?.type === 'http' || s?.type === 'sse'
            const config: McpServerConfig = isRemote
              ? { url: String(s.url), headers: headerRecord }
              : { command: String(s.command), args: Array.isArray(s.args) ? s.args : [], env: envRecord }
            return { name: String(s?.name || ''), config }
          }).filter(r => r.name && (r.config.url || r.config.command))

          const result = await registerSessionMcpServers(sessionId, regs)
          json(res, 200, result)
        } catch (err: any) {
          json(res, requestErrorStatus(err, 400), { error: err.message })
        }
        return
      }
      if (req.method === 'DELETE') {
        try {
          await unregisterSessionMcpServers(sessionId)
          json(res, 200, { ok: true })
        } catch (err: any) {
          json(res, requestErrorStatus(err, 500), { error: err.message })
        }
        return
      }
    }

    // ---- 模型配置 API ----
    if (url === '/api/config/model' && req.method === 'GET') {
      // 红线出口统一走展示口径：key 恒掩码，内置凭证时 model/baseUrl 一并遮蔽
      json(res, 200, getEffectiveModelConfigForDisplay())
      return
    }
    if (url === '/api/config/model' && req.method === 'POST') {
      try {
        const body = JSON.parse(await readBody(req))
        saveModelConfig(body as ModelConfig)
        json(res, 200, { ok: true })
      } catch (err: any) {
        json(res, requestErrorStatus(err, 400), { error: err.message })
      }
      return
    }
    if (url === '/api/config/model/test' && req.method === 'POST') {
      try {
        const body = JSON.parse(await readBody(req))
        const result = await testConnection(body as ModelConfig)
        json(res, 200, result)
      } catch (err: any) {
        json(res, requestErrorStatus(err, 500), { error: err.message })
      }
      return
    }
    if (url === '/api/config/providers' && req.method === 'GET') {
      json(res, 200, getProviders())
      return
    }
    if (url === '/api/config/has-key' && req.method === 'GET') {
      json(res, 200, { hasKey: hasApiKey() })
      return
    }
    if (url === '/api/config/is-custom' && req.method === 'GET') {
      json(res, 200, { isCustom: isUserCustomConfig() })
      return
    }
    if (url === '/api/config/clear-model' && req.method === 'POST') {
      clearModelConfig()
      json(res, 200, { ok: true })
      return
    }

    // ---- 归档记忆 ----
    if (url === '/api/memory/archived' && req.method === 'GET') {
      json(res, 200, listArchivedMemories(getGlobalMemoryDir()))
      return
    }
    if (url === '/api/memory/restore' && req.method === 'POST') {
      try {
        const body = JSON.parse(await readBody(req))
        const filePath = String(body.filePath || '')
        const ok = isWithinMemoryRoot(filePath) ? restoreArchivedMemory(filePath) : false
        json(res, 200, { ok })
      } catch (err: any) {
        json(res, requestErrorStatus(err, 500), { error: err.message })
      }
      return
    }

    // ---- 内联权限确认回传(浏览器写操作 / ACP 编辑器授权:允许/拒绝)----
    // 对称于桌面 IPC permission:inline-response,落到同一个 resolver(resolveInlinePermission)。
    if (url === '/api/permission' && req.method === 'POST') {
      try {
        const body = JSON.parse(await readBody(req))
        const conversationId = normalizeHttpConversationId(body.conversationId)
        if (conversationId && !isSafeConversationStorageId(conversationId)) {
          json(res, 400, { error: 'Invalid conversation id' })
          return
        }
        const executionId = typeof body.executionId === 'string' ? body.executionId : undefined
        // 浏览器主体沿用原判据;native 主体(ACP 适配器)只能回答自己那条活着的流,
        // 否则任何本机 native 调用方都能替别的会话点"允许"。
        if (principal !== 'browser' && !isAcpPermissionResponder(conversationId, executionId)) {
          json(res, 403, { error: 'Authorized permission stream required' })
          return
        }
        const accepted = inlinePermissionResolver?.(
          String(body.requestId),
          !!body.approved,
          // A stateless HTTP turn may approve this one operation, but it can
          // never create a durable per-session tool/host grant.
          isDurableHttpTurn(conversationId) && !!body.sessionApprove,
          executionId,
          conversationId
        ) === true
        json(res, accepted ? 200 : 409, { ok: accepted })
      } catch (err: any) {
        json(res, requestErrorStatus(err, 500), { error: err.message })
      }
      return
    }

    // ---- 聊天 SSE 流式 ----
    if (url === '/chat/stream' && req.method === 'POST') {
      const abort = new AbortController()
      let lockedConversationId: string | undefined
      let execution: ConversationExecutionLease | undefined
      let heartbeat: ReturnType<typeof setInterval> | undefined

      const cleanupTransport = (): void => {
        if (heartbeat) {
          clearInterval(heartbeat)
          heartbeat = undefined
        }
        if (lockedConversationId && activeStreams.get(lockedConversationId)?.response === res) {
          activeStreams.delete(lockedConversationId)
          endAcpStream(lockedConversationId)
        }
      }

      // 客户端真正断开时马上中止 Agent，并停止向已关闭的响应写权限/心跳。
      // conversation lock 刻意留到 finally，等 transcript 写入也完全收敛后才释放。
      res.once('close', () => {
        cleanupTransport()
        abort.abort()
      })

      try {
        const body = JSON.parse(await readBody(req))
        const authenticatedSource: ChatSource = principal === 'browser' ? 'extension' : 'acp'
        const sourceError = validateHttpChatBodySource(body.source, authenticatedSource)
        if (sourceError) {
          json(res, sourceError.status, { error: sourceError.error })
          return
        }
        const messages: ChatMessage[] = body.messages || []
        const source: ChatSource = authenticatedSource
        const conversationId = normalizeHttpConversationId(body.conversationId)
        if (conversationId && !isSafeConversationStorageId(conversationId)) {
          json(res, 400, { error: 'Invalid conversation id' })
          return
        }

        // 无 conversationId 的 extension/stateless 请求维持原行为；有会话的请求则对进程内
        // 所有入口 fail closed。HTTP 保持既有 409 语义，不排队也不抢占桌面/任务执行。
        if (conversationId) {
          try {
            execution = await acquireConversationExecution({
              conversationId,
              owner: { entrypoint: 'http', ownerId: source },
              policy: 'reject',
              signal: abort.signal
            })
          } catch (error) {
            if (!(error instanceof ConversationExecutionBusyError)) throw error
            json(res, 409, { error: 'Conversation already has an active stream' })
            return
          }
          lockedConversationId = conversationId
        }

        // Browser sendChat carries the exact renderer config snapshot. Persist
        // it behind the conversation execution lease before reading the
        // conversation for role/Agent overrides, so the first turn cannot race
        // a preceding PATCH or run with stale preflow/cwd/model settings.
        if (body.conversationConfig !== undefined) {
          if (!conversationId) {
            json(res, 400, { error: 'conversationConfig requires a conversationId' })
            return
          }
          if (!body.conversationConfig || typeof body.conversationConfig !== 'object' || Array.isArray(body.conversationConfig)) {
            json(res, 400, { error: 'conversationConfig must be an object' })
            return
          }
          if (!await updateConversationConfig(conversationId, body.conversationConfig)) {
            json(res, 404, { error: 'Conversation not found' })
            return
          }
        }

        // 单次读盘同时服务 ACP 历史重建与 Stage 8 overrides——此前各读一次，
        // 热路径上对同一份线性增长的会话 JSON 每轮同步读两遍
        const conv = conversationId ? getConversation(conversationId) : null
        if (conversationId && !conv) {
          // A caller may only opt into durable history, memory, permissions,
          // and role state by naming a conversation that already exists in the
          // OpenPipal store. Arbitrary non-empty ids are not durable identities.
          json(res, 404, { error: 'Conversation not found' })
          return
        }
        // Freeze role ownership with the same conversation snapshot used for
        // overrides. A concurrent global role switch must not redirect this
        // turn's eventual memory extraction into another role.
        const turnRoleName = conv?.role || getCurrentRole().name

        // ACP 客户端是无状态的（每轮只发最新一条 user 消息）：
        // ① 先于任何注入/改写抓住"这轮真正新增了什么"供流结束后落盘（正文 + 工具轨迹）；
        // ② 历史从会话存储重建（重启后不失忆）——回放 user/assistant 文本与 finalized 工具消息。
        // extension/desktop 客户端自带全量历史，整块不走
        const isAcp = source === 'acp'
        let newUserContent = ''
        if (isAcp) {
          const latestMsg = messages[messages.length - 1]
          if (latestMsg?.role === 'user' && typeof latestMsg.content === 'string') newUserContent = latestMsg.content
          if (conv && messages.length <= 1) {
            // 取材口径交给 shouldReplayStoredMessage（主进程侧的 shouldSendMessageToModel 对等实现）：
            // 放行 finalized 工具消息，同时挡掉权限/思考/注入提示与合成错误气泡——手写 role+content
            // 判据挡不住它们（权限气泡就是 role:'assistant' + "请求执行操作：bash"），会被永久复读。
            // 工具轨迹在这里完整取材；agentChat 只在整体历史接近 token 上限时统一压缩。
            const stored = (conv.messages || [])
              .filter(shouldReplayStoredMessage)
              .map(m => m.role === 'tool'
                // id 一并带上：缺 toolCallId 的老记录靠它在轨迹里保持稳定标识（tool-trail.ts）
                ? { role: 'tool' as const, content: m.content, toolName: m.toolName, toolCallId: m.toolCallId, toolArgs: m.toolArgs, id: m.id }
                // messageKind 必须过缝：主进程据此把 runtime-context 快照原样回放（pi-message-conversion.ts）
                : { role: m.role as 'user' | 'assistant', content: m.content, messageKind: m.messageKind })
            if (stored.length) messages.unshift(...stored)
          }
        }

        resolveAndInjectContext(body, messages)

        applySecurityHeaders(res)
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
          'X-Accel-Buffering': 'no'   // 禁止 nginx/cloudflare 代理缓冲
        })
        // 禁用 Node.js socket 层的 Nagle 算法，确保每次 write 立即发送
        res.socket?.setNoDelay(true)

        // 注册为该会话的活动流(权限确认气泡写到这里);心跳防止长静默(思考/工具/权限等待)
        // 期间连接被 Chrome/中间层当成空闲而裁掉 —— 一旦被裁,前端会误判为"已结束"。
        if (conversationId && execution) {
          activeStreams.set(conversationId, {
            response: res,
            executionId: execution.executionId,
            source
          })
          if (source === 'acp') startAcpStream(conversationId)
        }
        heartbeat = setInterval(() => {
          if (!res.destroyed) { try { res.write(': ping\n\n') } catch { /* 关闭中 */ } }
        }, 12_000)

        // Stage 8: 从 conversation 读 workspaceId/agentId 构造 overrides,让 openpipal-acp
        // 创建的"自定义 Agent 会话"实际走 Agent 的 agent.md + memories + skills
        let overrides: ReturnType<typeof resolveAgentOverrides> | undefined
        if (conversationId) {
          overrides = resolveAgentOverrides({
            agentId: conv?.agentId,
            workspaceId: conv?.workspaceId,
            conversationConfig: conv?.config,
            conversationId,
          })
        }

        const { agentChat } = await agentService()
        // ACP 落盘用与 scheduler 同一个收集器（text_flush 分段 + 包含式去重——
        // Pi 会发 streaming delta + fallback 全文两份 text 事件，朴素 += 会记双份；
        // 工具轨迹一并收，scheduler 只取 finish() 的文本视图，不受影响）
        const acpCollector = isAcp ? createTranscriptCollector() : null
        const runtimeSignal = execution?.signal ?? abort.signal
        for await (const event of agentChat(messages, runtimeSignal, source, overrides)) {
          // Runtime 的 error 是本轮失败终态，不是可继续收集的普通消息。
          // 原样向 SSE 发送一次后立即结束：不把失败轮伪装成 ACP 成功 transcript，
          // 也不再追加 done。abort 让 Runtime 里仍在跑的工具/子任务同步收敛。
          if (event.type === 'error') {
            abort.abort()
            if (!res.destroyed) {
              res.write(`data: ${JSON.stringify({ ...event, conversationId: conversationId || '' })}\n\n`)
              res.end()
            }
            return
          }
          // HTTP/ACP 没有桌面 IPC 那层 goal_update 持久化逻辑；先写稳 conversationConfig
          // 再把事件发给客户端，避免 UI 看见了新状态而重启后又回到旧状态。
          if (event.type === 'goal_update' && conversationId) {
            // 必须走加锁的读改写：锁外读一份整 config 再整份写回，会把并发的
            // `/goal clear`、preflow 写入等一起盖掉（同一个 config 对象里住着好几家）。
            const persisted = await mutateConversationConfig(
              conversationId,
              (config) => ({ ...config, goal: event.goal })
            )
            if (!persisted && getConversation(conversationId)) {
              throw new Error('Failed to persist conversation goal update')
            }
          }
          acpCollector?.feed(event)
          if (res.destroyed) break
          res.write(`data: ${JSON.stringify({ ...event, conversationId: conversationId || '' })}\n\n`)
        }

        // A desktop supersede aborts the coordinator-owned signal while the
        // transport remains open. Do not persist or report that partial ACP
        // turn as success. Client disconnect retains the historical behavior
        // of persisting already-emitted evidence before releasing ownership.
        if (runtimeSignal.aborted && !abort.signal.aborted) {
          throw runtimeSignal.reason instanceof Error
            ? runtimeSignal.reason
            : new Error('Conversation execution was superseded')
        }

        // ACP 会话服务端落盘：renderer 不在场,没人替它持久化。extension/desktop 仍由渲染层落盘,零接触。
        // 正文与工具轨迹按事件顺序一起落——只落正文的话上面那段"回放工具消息"永远取不到材料，
        // ACP 会话每轮都从零重新探索（读过什么、建过什么全忘）
        if (acpCollector && conversationId) {
          const collectedTranscript = acpCollector.finishTranscript()
          // A transport disconnect can stop the model mid-sentence. Keep the
          // new user turn and finalized tool_end evidence, but never promote
          // an assistant delta fragment into durable history for next replay.
          const transcript = abort.signal.aborted
            ? collectedTranscript.filter(entry => entry.kind === 'tool')
            : collectedTranscript
          if (newUserContent || transcript.length) {
            const now = Date.now()
            const toAppend: StoredMessage[] = []
            if (newUserContent) toAppend.push({ id: randomUUID(), role: 'user', content: newUserContent, timestamp: now })
            // RC 快照紧跟本轮 user 消息落盘，位置与渲染层 chatStore 一致——下轮回放字节一致，
            // 跨回合前缀缓存才接得上。ACP 没有 renderer，不在这里存就永远没人存。
            const acpRc = acpCollector.finishRuntimeContext()
            if (acpRc) {
              toAppend.push({
                id: randomUUID(), role: 'user', content: acpRc.text,
                timestamp: acpRc.timestamp, messageKind: 'runtime-context'
              })
            }
            for (const entry of transcript) {
              toAppend.push(entry.kind === 'tool'
                ? {
                  id: randomUUID(), role: 'tool', content: entry.content, timestamp: now,
                  toolName: entry.toolName, toolCallId: entry.toolCallId, toolArgs: entry.toolArgs,
                  ...(entry.searchResults ? { searchResults: entry.searchResults } : {})
                }
                : { id: randomUUID(), role: 'assistant', content: entry.content, timestamp: now })
            }
            const persisted = await appendMessages(conversationId, toAppend)
            if (!persisted) throw new Error('Failed to persist ACP conversation transcript')
          }
        }

        if (!res.destroyed) {
          res.write(`data: ${JSON.stringify({ type: 'done' })}\n\n`)
          res.end()

          // 自动记忆提取（fire-and-forget，流已关闭，仅写磁盘）
          // 是否跳过按会话归属的角色判断（而非全局 currentRole——可能已被语音/HTTP 切走）
          if (isDurableHttpTurn(conversationId) && isAutoMemoryEnabled() && messages.length >= 2) {
            const roleCfg = getRoleConfig(turnRoleName)
            if (roleCfg?.memoryEnabled === false) {
              console.log(`[Memory] 角色 ${turnRoleName} 已关闭记忆抽取（memory: off），跳过本次 executeExtraction`)
            } else {
              executeExtraction(messages, conversationId, turnRoleName).catch(() => {})
            }
          }
        }
      } catch (err: any) {
        console.error('[HTTP] SSE streaming 错误:', err.message)
        if (!res.headersSent) {
          json(res, requestErrorStatus(err, 500), { error: err.message })
        } else if (!res.destroyed) {
          try {
            // error 后不再伪造 done：浏览器会按“未干净结束”收敛，ACP 也能收到明确错误事件。
            res.write(`data: ${JSON.stringify({ type: 'error', content: err.message || '服务端错误', conversationId: lockedConversationId || '' })}\n\n`)
            res.end()
          } catch {
            // 连接已关闭，忽略
          }
        }
      } finally {
        cleanupTransport()
        execution?.release()
      }
      return
    }

    // ---- 聊天 非流式（保留兼容） ----
    if (url === '/chat' && req.method === 'POST') {
      try {
        const body = JSON.parse(await readBody(req))
        const authenticatedSource: ChatSource = principal === 'browser' ? 'extension' : 'acp'
        const sourceError = validateHttpChatBodySource(body.source, authenticatedSource)
        if (sourceError) {
          json(res, sourceError.status, { error: sourceError.error })
          return
        }
        const messages: ChatMessage[] = body.messages || []
        const source: ChatSource = authenticatedSource

        resolveAndInjectContext(body, messages)

        let fullText = ''
        const { agentChat } = await agentService()
        for await (const event of agentChat(messages, undefined, source)) {
          if (event.type === 'text') fullText += event.content
          else if (event.type === 'error') { json(res, 500, { error: event.content }); return }
        }
        json(res, 200, { content: fullText })
      } catch (err: any) {
        json(res, requestErrorStatus(err, 500), { error: err.message })
      }
      return
    }

    // ---- 角色前置页 manifest（通用，任意角色）----
    if (url?.startsWith('/api/chat/role-preflow') && req.method === 'GET') {
      try {
        const { readRoleManifest } = await import('./role-manager')
        const roleName = new URL(req.url!, 'http://x').searchParams.get('roleName') || ''
        json(res, 200, { manifest: readRoleManifest(roleName, 'preflow.json') })
      } catch (err: any) {
        json(res, requestErrorStatus(err, 500), { error: err.message })
      }
      return
    }

    // ---- 资产库 IPC 的 HTTP 镜像 ----
    if (url === '/api/assets/upload-to-category' && req.method === 'POST') {
      try {
        const body = JSON.parse(await readBody(req))
        if (!body.sourcePath) throw new Error('缺 sourcePath')
        // 资产库按角色隔离：写到当前角色的 assets/<role>/ 子目录
        const destDir = getRoleAssetsDir()
        require('fs').mkdirSync(destDir, { recursive: true })
        const origName = require('path').basename(body.sourcePath)
        let destName = origName
        let n = 1
        while (require('fs').existsSync(join(destDir, destName))) {
          const dotIdx = origName.lastIndexOf('.')
          const stem = dotIdx > 0 ? origName.slice(0, dotIdx) : origName
          const ext = dotIdx > 0 ? origName.slice(dotIdx) : ''
          destName = `${stem}-${n}${ext}`
          n += 1
        }
        const destPath = join(destDir, destName)
        require('fs').copyFileSync(body.sourcePath, destPath)
        const stats = require('fs').statSync(destPath)
        json(res, 200, { category: body.category, fileName: destName, path: destPath, sourceType: 'upload', sizeBytes: stats.size })
      } catch (err: any) {
        json(res, requestErrorStatus(err, 400), { error: err.message })
      }
      return
    }

    if (url === '/api/assets/list-tree' && req.method === 'GET') {
      try {
        const { listRoleAssets } = await import('./role-manager')
        json(res, 200, listRoleAssets())
      } catch (err: any) {
        json(res, requestErrorStatus(err, 500), { error: err.message })
      }
      return
    }

    if (url === '/api/assets/list-design-systems' && req.method === 'GET') {
      try {
        const { listDesignSystems } = await import('./role-manager')
        json(res, 200, { items: listDesignSystems() })
      } catch (err: any) {
        json(res, requestErrorStatus(err, 500), { items: [], error: err.message })
      }
      return
    }

    if (url.startsWith('/api/assets/design-system-manifest') && req.method === 'GET') {
      try {
        const { getDesignSystemManifest } = await import('./role-manager')
        const name = new URL(req.url!, 'http://x').searchParams.get('name') || ''
        json(res, 200, getDesignSystemManifest(name))
      } catch (err: any) {
        json(res, requestErrorStatus(err, 500), { error: err.message })
      }
      return
    }

    if (pathname === '/api/assets/design-system-resource' && req.method === 'GET') {
      const params = new URL(url, 'http://openpipal.local').searchParams
      const result = readDesignSystemResource(params.get('name'), params.get('rel'))
      json(res, result.ok ? 200 : designSystemResourceStatus(result), result)
      return
    }

    if (pathname === '/api/assets/design-system-capability' && req.method === 'GET') {
      const name = new URL(url, 'http://openpipal.local').searchParams.get('name')
      const capability = getDesignSystemResourceCapability(name)
      if (!capability) {
        json(res, 404, { error: 'Design system not found' })
        return
      }
      res.setHeader('Cache-Control', 'no-store')
      json(res, 200, { capability })
      return
    }

    // 已编译新格式 manifest（_ds_manifest.json）——只读；未编译/legacy/非法 name/出错一律返回 null
    if (url.startsWith('/api/assets/compiled-ds-manifest') && req.method === 'GET') {
      const name = new URL(req.url!, 'http://x').searchParams.get('name') || ''
      json(res, 200, readDesignSystemJsonResource(name, '_ds_manifest.json'))
      return
    }

    if (url === '/api/assets/delete' && req.method === 'POST') {
      try {
        const body = JSON.parse(await readBody(req))
        const root = getRoleAssetsDir()
        if (!body.path || !body.path.startsWith(root)) throw new Error('拒绝删除当前角色资产目录外的文件')
        require('fs').unlinkSync(body.path)
        json(res, 200, { ok: true })
      } catch (err: any) {
        json(res, requestErrorStatus(err, 400), { error: err.message })
      }
      return
    }

    // ---- Artifact 持久化（浏览器模式） ----
    if (url === '/api/artifact/save' && req.method === 'POST') {
      try {
        const { saveArtifact } = await import('./artifact-store')
        const body = JSON.parse(await readBody(req))
        const ref = saveArtifact(body.conversationId, body.artifact)
        json(res, 200, { ok: true, ref })
      } catch (err: any) {
        json(res, requestErrorStatus(err, 400), { ok: false, error: err?.message || 'save failed' })
      }
      return
    }
    if (url === '/api/artifact/load' && req.method === 'POST') {
      try {
        const { loadArtifact } = await import('./artifact-store')
        const body = JSON.parse(await readBody(req))
        if (typeof body.conversationId !== 'string' || !body.conversationId) {
          throw new Error('conversationId 必填')
        }
        const data = loadArtifact(body.ref, body.conversationId)
        if (!data) { json(res, 404, { ok: false, error: 'not found' }); return }
        json(res, 200, { ok: true, artifact: data })
      } catch (err: any) {
        json(res, requestErrorStatus(err, 400), { ok: false, error: err?.message || 'load failed' })
      }
      return
    }
    if (url === '/api/artifact/load-compiled' && req.method === 'POST') {
      try {
        const { loadCompiledArtifact } = await import('./artifact-store')
        const body = JSON.parse(await readBody(req))
        const text = loadCompiledArtifact(body.conversationId, body.artifactId)
        json(res, 200, { text })
      } catch (err: any) {
        json(res, requestErrorStatus(err, 400), { text: null, error: err?.message || 'load failed' })
      }
      return
    }
    if (url?.startsWith('/api/artifact/list-history') && req.method === 'GET') {
      try {
        const { listArtifactHistory } = await import('./artifact-store')
        const params = new URL(req.url!, 'http://x').searchParams
        const role = params.get('role') || undefined
        const limit = Number(params.get('limit')) || undefined
        json(res, 200, { items: listArtifactHistory({ role, limit }) })
      } catch (err: any) {
        json(res, requestErrorStatus(err, 500), { items: [], error: err?.message })
      }
      return
    }
    if (url === '/api/workspace/list-output-history' && req.method === 'GET') {
      try {
        const { listOutputHistory } = await import('./memory-manager')
        json(res, 200, { items: listOutputHistory() })
      } catch (err: any) {
        json(res, requestErrorStatus(err, 500), { items: [], error: err?.message })
      }
      return
    }
    if (url === '/api/artifact/export-dc' && req.method === 'POST') {
      try {
        const { exportDcBundle } = await import('./dc-export')
        const body = JSON.parse(await readBody(req))
        json(res, 200, exportDcBundle(body.projectName, body.artifacts || []))
      } catch (err: any) {
        json(res, requestErrorStatus(err, 400), { ok: false, error: err?.message || 'export failed' })
      }
      return
    }
    if (url === '/api/artifact/export-pdf' && req.method === 'POST') {
      try {
        const { exportArtifactPdf } = await import('./dc-export')
        const body = JSON.parse(await readBody(req))
        json(res, 200, await exportArtifactPdf(body.title || 'document', body.content || ''))
      } catch (err: any) {
        json(res, requestErrorStatus(err, 400), { ok: false, error: err?.message || 'export failed' })
      }
      return
    }
    if (url === '/api/artifact/export-zip' && req.method === 'POST') {
      try {
        const { exportZip } = await import('./dc-export')
        const body = JSON.parse(await readBody(req))
        json(res, 200, await exportZip(body.sourceDir || '', body.outName || 'share'))
      } catch (err: any) {
        json(res, requestErrorStatus(err, 400), { ok: false, error: err?.message || 'export failed' })
      }
      return
    }

    // ---- Artifact 内 LLM 调用桥（浏览器模式下 window.openpipal.complete 走这里） ----
    if (url === '/api/openpipal/complete' && req.method === 'POST') {
      try {
        const { completeInArtifact } = await import('./simple-completion')
        const body = JSON.parse(await readBody(req, ARTIFACT_COMPLETION_REQUEST_BODY_MAX_BYTES))
        const content = await completeInArtifact(body.prompt, body.systemPrompt)
        json(res, 200, { ok: true, content })
      } catch (err: any) {
        json(res, requestErrorStatus(err, 500), { ok: false, error: err.message || 'completion failed' })
      }
      return
    }

    // ---- 设置 API ----
    if (pathname === '/api/locale' && req.method === 'GET') {
      res.setHeader('Cache-Control', 'no-store')
      json(res, 200, getLocaleState())
      return
    }
    if (pathname === '/api/locale' && req.method === 'PUT') {
      res.setHeader('Cache-Control', 'no-store')
      let body: unknown
      try {
        body = await readJsonBody(req, LOCALE_REQUEST_BODY_MAX_BYTES)
      } catch (error) {
        const status = requestErrorStatus(error, 400)
        json(res, status, {
          error: status === 413 ? 'Locale request body is too large' : 'Invalid locale request body'
        })
        return
      }
      if (
        typeof body !== 'object' ||
        body === null ||
        Array.isArray(body)
      ) {
        json(res, 400, { error: 'Locale preference must be system, zh-CN, or en' })
        return
      }
      const preference = (body as { preference?: unknown }).preference
      if (Object.keys(body).length !== 1 || !isLocalePreference(preference)) {
        json(res, 400, { error: 'Locale preference must be system, zh-CN, or en' })
        return
      }
      try {
        const state = updateLocalePreference(preference)
        json(res, 200, state)
      } catch {
        json(res, 500, { error: 'Unable to save locale preference' })
      }
      return
    }
    if (url === '/settings/apps' && req.method === 'GET') {
      json(res, 200, { enabled: isAppFollowingEnabled(), detected: getDetectedApps(), disabled: getDisabledApps(), browsers: Array.from(BROWSER_APPS) })
      return
    }
    if (url === '/settings/disabled-apps' && req.method === 'POST') {
      try {
        const body = JSON.parse(await readBody(req))
        if (typeof body !== 'object' || body === null || Array.isArray(body) || Object.keys(body).length !== 1 ||
          !Array.isArray(body.apps) || !body.apps.every((appName: unknown) => typeof appName === 'string')) {
          throw new TypeError('Disabled apps must be an array of strings')
        }
        const { apps } = body
        setDisabledApps(apps)
        json(res, 200, { ok: true })
      } catch (err: any) {
        json(res, requestErrorStatus(err, 400), { error: err.message })
      }
      return
    }
    if (url === '/settings/app-following' && req.method === 'POST') {
      let body: unknown
      try {
        body = await readJsonBody(req, APP_FOLLOWING_REQUEST_BODY_MAX_BYTES)
      } catch (err: unknown) {
        json(res, requestErrorStatus(err, 400), {
          error: err instanceof Error ? err.message : 'Invalid request body'
        })
        return
      }
      if (typeof body !== 'object' || body === null || Array.isArray(body) ||
        Object.keys(body).length !== 1 || typeof (body as { enabled?: unknown }).enabled !== 'boolean') {
        json(res, 400, { error: 'App following enabled must be a boolean' })
        return
      }
      const enabled = (body as { enabled: boolean }).enabled
      try {
        setAppFollowingEnabled(enabled)
        json(res, 200, { ok: true, enabled })
      } catch {
        json(res, 500, { error: 'Unable to save app following setting' })
      }
      return
    }

    // ---- 插件安装引导页 ----
    if (url === '/extension' && req.method === 'GET') {
      const page = getExtensionPageHtml(getLocaleState().locale)
      applySecurityHeaders(res)
      res.writeHead(200, {
        'Cache-Control': 'no-store',
        'Content-Type': 'text/html; charset=utf-8'
      })
      res.end(page)
      return
    }

    // ==================== 设计系统静态资源（只读伺服 ~/.openpipal/design-systems/） ====================
    // 只供 sandbox iframe 导航；文本/图片正文由已认证的 window.api 读取。
    const designSystemStaticTarget = parseDesignSystemStaticCapabilityPath(pathname)
    if (designSystemStaticTarget && req.method === 'GET') {
      try {
        const resource = readDesignSystemStaticResource(designSystemStaticTarget.name, designSystemStaticTarget.rel)
        if (!resource.ok) {
          json(res, designSystemResourceStatus(resource), { error: resource.error })
          return
        }
        applySecurityHeaders(res)
        // Relative subresources retain the same unguessable process capability in their path.
        // cross-origin lets opaque sandbox iframes load CSS/images/scripts without making a
        // predictable local resource URL public to arbitrary web pages.
        res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin')
        res.setHeader('Referrer-Policy', 'no-referrer')
        const previewCsp = buildDesignSystemPreviewContentSecurityPolicy(
          `http://${String(req.headers.host)}`,
          designSystemStaticTarget.capability,
          designSystemStaticTarget.name,
        )
        if (!previewCsp) {
          json(res, 403, { error: 'Invalid design system preview capability' })
          return
        }
        res.setHeader('Content-Security-Policy', previewCsp)
        res.writeHead(200, {
          'Content-Type': resource.contentType,
          'Content-Length': resource.size,
          'Cache-Control': 'no-cache',
        })
        res.end(resource.data)
      } catch (err: any) {
        json(res, requestErrorStatus(err, 400), { error: err?.message || 'invalid design system resource path' })
      }
      return
    }

    // ==================== 静态文件（React 渲染器） ====================
    if (req.method === 'GET') {
      if (serveStatic(url, res)) return
    }

      json(res, 404, { error: 'Not found' })
    })().catch((error: unknown) => {
      // Do not surface route failures as unhandled rejections. Avoid exposing
      // implementation details to a browser client, and avoid a second write
      // after a streaming response has already started.
      console.error('[HTTP] Request handler failed:', error instanceof Error ? error.message : String(error))
      if (!res.headersSent && !res.destroyed) {
        json(res, requestErrorStatus(error, 500), { error: 'Internal server error' })
      } else if (!res.destroyed) {
        res.end()
      }
    })
  })

  // 反向控制通道:桌面 → 扩展(chrome.debugger 命令走这条 WS)
  attachBrowserControlWss(server, auth, () => {
    const address = server.address()
    return typeof address === 'object' && address ? address.port : port
  })

  server.listen(port, '127.0.0.1', () => {
    activeServer = server
    console.log(`[HTTP] API server + 静态文件: http://127.0.0.1:${port}`)
  })
  server.on('close', () => {
    if (activeServer === server) activeServer = null
  })

  server.on('error', (err: any) => {
    if (activeServer === server) activeServer = null
    if (err.code === 'EADDRINUSE') {
      console.log(`[HTTP] 端口 ${port} 被占用，跳过 HTTP server`)
    } else {
      console.error('[HTTP] Server 错误:', err.message)
    }
  })

  return server
}

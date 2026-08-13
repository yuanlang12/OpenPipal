/**
 * MCP Remote OAuth — Streamable HTTP transport 的 OAuth 2.1 + PKCE 鉴权
 *
 * 责任分工:
 * - SDK 内部完成 RFC 9728 / 8414 metadata 发现、PKCE 生成、token 交换 / 刷新
 * - 本模块只提供 SDK 要求的存储 + 浏览器跳转 + 回调捕获三件事
 *
 * 安全:
 * - Token 用 electron.safeStorage 加密(macOS Keychain),不可用时降级明文 + 警告日志
 * - 单端口(3033)固定回调,简化 redirect_uri 注册;端口冲突时整个流程失败
 * - 回调 server 仅在 OAuth 流程进行时存在,完成后保留以应对 token refresh / re-auth
 */

import { shell, safeStorage } from 'electron'
import { join } from 'path'
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, renameSync } from 'fs'
import { createServer } from 'http'
import type { Server } from 'http'
import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js'
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js'
import { tMain } from './main-i18n'
import { getMcpOAuthRootPath } from './credential-paths'

// 固定本地回调端口 — 简化 redirect_uri 注册。冲突时 OAuth 失败,提示用户。
export const OAUTH_PORT = 3033
const OAUTH_PATH = '/oauth/callback'
const REDIRECT_URI = `http://127.0.0.1:${OAUTH_PORT}${OAUTH_PATH}`

const oauthDir = getMcpOAuthRootPath
const sessionFile = (serverName: string): string => join(oauthDir(), `${sanitizeName(serverName)}.bin`)

function sanitizeName(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, '_')
}

interface PersistedSession {
  clientInfo?: OAuthClientInformationMixed
  tokens?: OAuthTokens
  codeVerifier?: string
}

/**
 * 进程内 session 缓存 —— safeStorage.decryptString 是同步钥匙串调用：
 * 钥匙串弹系统授权框时会把主线程锁死（实案：dev 重编译签名变化 → 弹框被主窗口挡住 →
 * 整个 App 冻结、Cmd+Q 无效）。缓存保证每个 server 一个进程周期最多解密一次，
 * 且解密只发生在用户主动授权/连接的交互流里（见 hasPersistedOAuthSession 的启动期用法）。
 */
const sessionCache = new Map<string, PersistedSession>()

/**
 * 只判断"是否有已保存的授权会话文件"——纯文件系统操作，绝不触碰钥匙串。
 * 启动期/状态广播必须用它，不能用会解密的 loadSession/hasOAuthTokens。
 */
export function hasPersistedOAuthSession(serverName: string): boolean {
  return existsSync(sessionFile(serverName))
}

function loadSession(serverName: string): PersistedSession {
  const cached = sessionCache.get(serverName)
  if (cached) return cached
  const f = sessionFile(serverName)
  if (!existsSync(f)) return {}
  let session: PersistedSession = {}
  try {
    const raw = readFileSync(f)
    let json: string
    if (safeStorage.isEncryptionAvailable()) {
      json = safeStorage.decryptString(raw)
    } else {
      json = raw.toString('utf-8')
    }
    session = JSON.parse(json)
  } catch (err) {
    console.warn(`[OAuth] 读取 ${serverName} session 失败,将以空状态启动:`, err)
    // 解不开的密文（典型：重编译后加密 key 失效）永远解不开——原地隔离，
    // 避免每次启动都重复撞钥匙串 + 刷报错；用户重新授权时会写入新文件。
    try { renameSync(f, `${f}.corrupt`) } catch { /* 隔离失败下次再试 */ }
  }
  sessionCache.set(serverName, session)
  return session
}

function saveSession(serverName: string, session: PersistedSession): void {
  mkdirSync(oauthDir(), { recursive: true })
  const json = JSON.stringify(session, null, 2)
  const data = safeStorage.isEncryptionAvailable()
    ? safeStorage.encryptString(json)
    : Buffer.from(json, 'utf-8')
  if (!safeStorage.isEncryptionAvailable()) {
    console.warn(`[OAuth] safeStorage 不可用,token 以明文存储到 ${sessionFile(serverName)}`)
  }
  writeFileSync(sessionFile(serverName), data, { mode: 0o600 })
  sessionCache.set(serverName, session)
}

function clearSession(serverName: string): void {
  const f = sessionFile(serverName)
  if (existsSync(f)) try { unlinkSync(f) } catch {}
  sessionCache.delete(serverName)
}

// ---- 回调 server (单例,首次需要时启) ----

let callbackServer: Server | null = null
let pendingResolve: ((code: string) => void) | null = null
let pendingReject: ((err: Error) => void) | null = null

function ensureCallbackServer(): Promise<void> {
  if (callbackServer) return Promise.resolve()
  return new Promise((resolve, reject) => {
    const srv = createServer((req, res) => {
      if (!req.url) { res.writeHead(404).end(); return }
      const u = new URL(req.url, `http://127.0.0.1:${OAUTH_PORT}`)
      if (u.pathname !== OAUTH_PATH) { res.writeHead(404).end(); return }

      const code = u.searchParams.get('code')
      const error = u.searchParams.get('error')
      const errorDesc = u.searchParams.get('error_description')
      const headers = { 'Content-Type': 'text/html; charset=utf-8' }

      if (code && pendingResolve) {
        res.writeHead(200, headers).end(`<!doctype html><html><body style="font-family:system-ui;text-align:center;padding:60px;color:#444"><h2>✓ 已授权</h2><p>可以关闭此窗口,回到 OpenPipal 继续操作。</p></body></html>`)
        const r = pendingResolve
        pendingResolve = null; pendingReject = null
        r(code)
      } else {
        const errMsg = `${error || 'no_code'}: ${errorDesc || '无 authorization code'}`
        res.writeHead(400, headers).end(`<!doctype html><html><body style="font-family:system-ui;text-align:center;padding:60px;color:#a33"><h2>授权失败</h2><pre>${escapeHtml(errMsg)}</pre></body></html>`)
        if (pendingReject) {
          const rj = pendingReject
          pendingResolve = null; pendingReject = null
          rj(new Error(errMsg))
        }
      }
    })
    srv.once('error', (err) => {
      console.error(`[OAuth] 回调端口 ${OAUTH_PORT} 启动失败:`, err)
      reject(err)
    })
    srv.listen(OAUTH_PORT, '127.0.0.1', () => {
      callbackServer = srv
      console.log(`[OAuth] 回调服务器已启动 ${REDIRECT_URI}`)
      resolve()
    })
  })
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!))
}

/** 注册一个 pending 等待,SDK 会在浏览器回调到达时通过 ensureCallbackServer 解析它 */
function waitForCode(timeoutMs = 180000): Promise<string> {
  return new Promise((resolve, reject) => {
    if (pendingResolve) {
      reject(new Error('已有 OAuth 授权进行中,请等其完成或重试'))
      return
    }
    pendingResolve = resolve
    pendingReject = reject
    setTimeout(() => {
      if (pendingResolve === resolve) {
        pendingResolve = null; pendingReject = null
        reject(new Error(`OAuth 等待超时(${timeoutMs / 1000}s) — 用户可能未完成授权`))
      }
    }, timeoutMs)
  })
}

/** 创建 SDK 兼容的 OAuthClientProvider,绑定到指定 serverName 的持久化 session */
export function createOAuthProvider(
  serverName: string,
  opts: { allowRedirect?: boolean } = {}
): OAuthClientProvider & { resetSession: () => void } {
  // allowRedirect=false (默认) — 启动期 connectServer 用,redirect 时抛错以免无声打开浏览器
  // allowRedirect=true — 用户主动点 "Connect" 时用,允许打开外部浏览器
  const allowRedirect = opts.allowRedirect === true
  let cached = loadSession(serverName)
  const update = (patch: Partial<PersistedSession>): void => {
    cached = { ...cached, ...patch }
    saveSession(serverName, cached)
  }

  return {
    get redirectUrl() { return REDIRECT_URI },
    get clientMetadata(): OAuthClientMetadata {
      return {
        client_name: `OpenPipal (${serverName})`,
        redirect_uris: [REDIRECT_URI],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none', // public client + PKCE
      }
    },
    clientInformation() { return cached.clientInfo },
    saveClientInformation(info) { update({ clientInfo: info }) },
    tokens() { return cached.tokens },
    saveTokens(tokens) { update({ tokens }) },
    saveCodeVerifier(v) { update({ codeVerifier: v }) },
    codeVerifier() {
      if (!cached.codeVerifier) throw new Error(tMain('toolsHub.mcp.errors.missingCodeVerifier'))
      return cached.codeVerifier
    },
    async redirectToAuthorization(authUrl) {
      if (!allowRedirect) {
        // 启动期场景:不要无声开浏览器,让 SDK 抛 UnauthorizedError → connectServer 标记 needs-auth
        throw new Error('OAUTH_NON_INTERACTIVE')
      }
      await ensureCallbackServer()
      console.log(`[OAuth] ${serverName} 打开浏览器授权: ${authUrl.toString()}`)
      await shell.openExternal(authUrl.toString())
    },
    invalidateCredentials(scope) {
      if (scope === 'all') update({ clientInfo: undefined, tokens: undefined, codeVerifier: undefined })
      else if (scope === 'tokens') update({ tokens: undefined })
      else if (scope === 'client') update({ clientInfo: undefined })
      else if (scope === 'verifier') update({ codeVerifier: undefined })
    },
    resetSession() {
      clearSession(serverName)
      cached = {}
    },
  }
}

/** SDK 抛 UnauthorizedError 后,等待用户在浏览器完成授权并把 code 回送 */
export async function awaitAuthorizationCode(): Promise<string> {
  await ensureCallbackServer()
  return waitForCode()
}

/** 检查某 server 是否已经持有 token(用于 UI 显示"已授权"状态) */
export function hasOAuthTokens(serverName: string): boolean {
  return !!loadSession(serverName).tokens?.access_token
}

/** 撤销某 server 的 OAuth session(token + clientInfo + verifier 全清) */
export function revokeOAuthSession(serverName: string): void {
  clearSession(serverName)
}

/** App 退出时关闭回调 server */
export function shutdownOAuth(): void {
  if (callbackServer) {
    try { callbackServer.close() } catch {}
    callbackServer = null
  }
  pendingResolve = null
  pendingReject = null
}

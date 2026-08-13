/**
 * 浏览器控制 —— 桌面端 ⇄ Chrome 扩展的反向 WebSocket 通道(Phase 1)
 *
 * 背景:OpenPipal 现有「扩展 → 桌面」是单向 HTTP POST。要让 AI agent 控制用户
 * 真实 Chrome(chrome.debugger/CDP),需要一条「桌面 → 扩展」的长连接命令通道。
 *
 * 为什么是 WebSocket 而不是 SSE:控制逻辑只能跑在扩展的 service worker 里
 * (只有 SW 能调 chrome.debugger),而 MV3 SW 全局里 `EventSource` 不可用、
 * `WebSocket` 可用。所以协议被运行上下文锁死成 WS。活跃 WS 流量还能让 Chrome
 * 116+ 重置 SW 的 30s idle 计时,顺带保活。
 *
 * 往返模式抄现有权限确认流(pi-security 的 requestId + resolver + 超时):
 *   桌面 sendBrowserCommand → {type:'command', commandId} → 扩展执行 →
 *   {type:'result', commandId, ok, result|error} → resolve/reject 对应 Promise。
 */
import { WebSocketServer, WebSocket } from 'ws'
import type { Server } from 'http'
import { LocalHttpAuthBoundary, isStrictLoopbackHost } from './local-http-auth'

const WS_PATH = '/ws/browser-control'
const KEEPALIVE_MS = 15_000 // 每 15s ping 一次,保活 MV3 SW(留足 <30s idle 上限的余量)
const RECONNECT_GRACE_MS = 2_500 // 命令发出时若 SW 短暂断开,最多等这么久它重连,而非立刻失败
const AUTH_TIMEOUT_MS = 5_000
export const BROWSER_CONTROL_MAX_PAYLOAD_BYTES = 16 * 1024 * 1024

interface PendingCommand {
  resolve: (result: unknown) => void
  reject: (err: Error) => void
  timer: NodeJS.Timeout
  action: string
}

// 实践中同一时刻只有一个扩展实例连着;后连的顶替先连的。
let extSocket: WebSocket | null = null
let extCdpCapable = false // 扩展是否声明了 CDP 能力(0.3.8+ 在 register 里报 cdp:true)
let keepaliveTimer: NodeJS.Timeout | null = null
const pending = new Map<string, PendingCommand>()
let cmdCounter = 0

export function isBrowserControlConnected(): boolean {
  return extSocket !== null && extSocket.readyState === WebSocket.OPEN
}

// 连上 *且* 扩展声明了 CDP 能力(0.3.8+)。旧版 0.3.7 stub 不报 cdp →
// 不暴露浏览器工具,避免 AI 调了一堆只会回"未实现"的工具(更丝滑、更诚实)。
export function isBrowserControlReady(): boolean {
  return isBrowserControlConnected() && extCdpCapable
}

/** 在已有的 http.Server 上挂 WS server(同端口,走 upgrade) */
export function attachBrowserControlWss(
  server: Server,
  auth: LocalHttpAuthBoundary,
  getPort: () => number,
): () => Promise<void> {
  const wss = new WebSocketServer({
    server,
    path: WS_PATH,
    // Screenshots can legitimately be several MiB, but the ws default is
    // 100 MiB and would be copied again by toString()+JSON.parse in main.
    maxPayload: BROWSER_CONTROL_MAX_PAYLOAD_BYTES,
  })

  // ws 库会把底层 http.Server 的 'error'(如多实例 EADDRINUSE)转发到 wss 自己的 emitter;
  // 无监听器时 EventEmitter 直接 throw → 主进程未捕获异常弹窗(EPIPE 同类:环境冲突只该降级)。
  // http-server.ts 已对同一错误做了日志与跳过,这里静默即可,不重复报。
  wss.on('error', () => {})

  wss.on('connection', (ws, req) => {
    const origin = req.headers.origin || ''
    if (!isStrictLoopbackHost(req.headers.host, getPort()) || !auth.isBoundExtensionOrigin(origin)) {
      console.warn('[browser-control] 拒绝 Host 或扩展来源不匹配的 WS 连接')
      try { ws.close(1008, 'forbidden transport') } catch { /* ignore */ }
      return
    }

    let authenticated = false
    const authTimer = setTimeout(() => {
      if (!authenticated) { try { ws.close(1008, 'registration required') } catch { /* ignore */ } }
    }, AUTH_TIMEOUT_MS)

    ws.on('message', (data) => {
      let msg: { type?: string; commandId?: string; ok?: boolean; result?: unknown; error?: string; cdp?: boolean; token?: string }
      try { msg = JSON.parse(data.toString()) } catch { return }

      // The first application message is the authentication boundary. An
      // Origin-only socket is never installed as extSocket and cannot receive
      // browser commands, pings, or replace a working extension.
      if (!authenticated) {
        if (msg.type !== 'register' || !auth.isBrowserTokenValid(msg.token)) {
          try { ws.close(1008, 'browser authorization required') } catch { /* ignore */ }
          return
        }
        authenticated = true
        clearTimeout(authTimer)
        const thisCdp = !!msg.cdp
        const activeCdp = extSocket !== null && extSocket !== ws && extSocket.readyState === WebSocket.OPEN && extCdpCapable
        if (!activeCdp) {
          if (extSocket && extSocket !== ws) { try { extSocket.close() } catch { /* ignore */ } }
          extSocket = ws
          extCdpCapable = thisCdp
          startKeepalive(ws)
          console.log('[browser-control] 扩展已认证并连接')
        } else if (thisCdp) {
          if (extSocket) { try { extSocket.close() } catch { /* ignore */ } }
          extSocket = ws
          extCdpCapable = true
          startKeepalive(ws)
          console.log('[browser-control] 扩展已认证并连接(CDP 取代旧连接)')
        } else {
          try { ws.close(1000, 'superseded by active cdp extension') } catch { /* ignore */ }
        }
        send(ws, { type: 'hello', server: 'openpipal' })
        return
      }

      if (ws === extSocket) handleExtensionMessage(msg)
    })

    ws.on('close', () => {
      clearTimeout(authTimer)
      if (extSocket === ws) {
        extSocket = null
        extCdpCapable = false
        stopKeepalive()
        console.log('[browser-control] 扩展断开')
        // 活动连接断了,挂起命令全部 reject,避免 AI 永久卡住
        // (用 forEach 而非 for...of —— 本 tsconfig target 下迭代 Map 需 downlevelIteration)
        pending.forEach((p) => {
          clearTimeout(p.timer)
          p.reject(new Error('浏览器扩展连接已断开'))
        })
        pending.clear()
      }
      // 被拒/挂起的连接关闭 → 静默(不刷日志、不影响活动连接)
    })

    ws.on('error', (e) => {
      console.error('[browser-control] WS 错误:', (e as Error)?.message)
    })
  })

  console.log(`[browser-control] WebSocket server 挂载于 ${WS_PATH}`)

  let disposed = false
  const dispose = async (): Promise<void> => {
    if (disposed) return
    disposed = true
    stopKeepalive()

    // A closed HTTP listener does not necessarily close already-upgraded
    // WebSockets. Terminate them explicitly so application shutdown and test
    // teardown cannot leave the Electron/Vitest process alive indefinitely.
    wss.clients.forEach((client) => {
      try { client.terminate() } catch { /* already closed */ }
    })
    extSocket = null
    extCdpCapable = false
    pending.forEach((entry) => {
      clearTimeout(entry.timer)
      entry.reject(new Error('浏览器控制服务已关闭'))
    })
    pending.clear()

    await new Promise<void>((resolve) => {
      try { wss.close(() => resolve()) } catch { resolve() }
    })
  }

  // Production callers normally close only the shared HTTP server. Tie the
  // upgraded transport to that lifecycle while still returning an awaitable
  // disposer for deterministic tests and explicit shutdown paths.
  server.once('close', () => { void dispose() })
  return dispose
}

function handleExtensionMessage(msg: {
  type?: string
  commandId?: string
  ok?: boolean
  result?: unknown
  error?: string
  cdp?: boolean
}): void {
  if (msg.type === 'register') { extCdpCapable = !!msg.cdp; return }
  if (msg.type === 'pong') return
  if (msg.type === 'result' && msg.commandId) {
    const p = pending.get(msg.commandId)
    if (!p) return
    clearTimeout(p.timer)
    pending.delete(msg.commandId)
    if (msg.ok) p.resolve(msg.result)
    else p.reject(new Error(msg.error || `浏览器命令失败: ${p.action}`))
  }
}

function startKeepalive(ws: WebSocket): void {
  stopKeepalive()
  keepaliveTimer = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) send(ws, { type: 'ping' })
  }, KEEPALIVE_MS)
}

function stopKeepalive(): void {
  if (keepaliveTimer) {
    clearInterval(keepaliveTimer)
    keepaliveTimer = null
  }
}

function send(ws: WebSocket, obj: unknown): void {
  try { ws.send(JSON.stringify(obj)) } catch { /* socket 可能正在关闭 */ }
}

// 轮询等待扩展(重新)连上,最多 maxMs;已连接立即 true,超时 false
function waitForConnection(maxMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    if (isBrowserControlConnected()) { resolve(true); return }
    let waited = 0
    const iv = setInterval(() => {
      if (isBrowserControlConnected()) { clearInterval(iv); resolve(true) }
      else if ((waited += 50) >= maxMs) { clearInterval(iv); resolve(false) }
    }, 50)
  })
}

/**
 * 给扩展发一条命令并 await 结果(browser_* 工具走这里)。
 * 未连接时给一段重连宽限期(MV3 SW 可能短暂挂起),而非立刻失败;仍连不上才 reject。
 * signal:用户点「停止」时 agent 会 abort —— 在飞的命令立刻清 pending 并 reject,
 *        而不是傻等 WS 往返到超时(否则 UI 表现为"停不掉")。
 */
export function sendBrowserCommand(
  action: string,
  params: Record<string, unknown> = {},
  timeoutMs = 15_000,
  signal?: AbortSignal
): Promise<unknown> {
  const dispatch = (resolve: (v: unknown) => void, reject: (e: Error) => void): void => {
    const commandId = `bc_${++cmdCounter}_${Date.now()}`
    let abortHandler: (() => void) | null = null
    const finalize = (): void => {
      const p = pending.get(commandId)
      if (p) clearTimeout(p.timer)
      pending.delete(commandId)
      if (signal && abortHandler) signal.removeEventListener('abort', abortHandler)
    }
    const timer = setTimeout(() => {
      finalize()
      reject(new Error(`浏览器命令超时(${timeoutMs}ms): ${action}`))
    }, timeoutMs)
    pending.set(commandId, {
      resolve: (v) => { finalize(); resolve(v) },
      reject: (e) => { finalize(); reject(e) },
      timer,
      action
    })
    if (signal) {
      abortHandler = () => { finalize(); reject(new Error(`浏览器命令已取消: ${action}`)) }
      signal.addEventListener('abort', abortHandler, { once: true })
    }
    send(extSocket!, { type: 'command', commandId, action, params })
  }

  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new Error(`浏览器命令已取消: ${action}`)); return }
    if (isBrowserControlConnected()) { dispatch(resolve, reject); return }
    // SW 可能被 MV3 短暂挂起/正在重连 —— 给一段宽限期等它回来,而非立刻失败(更丝滑)
    const grace = Math.min(RECONNECT_GRACE_MS, timeoutMs)
    waitForConnection(grace).then((ok) => {
      if (signal?.aborted) { reject(new Error(`浏览器命令已取消: ${action}`)); return }
      if (ok) dispatch(resolve, reject)
      else reject(new Error('浏览器扩展未连接(请确认 Chrome 已装 OpenPipal 扩展且桌面端在运行)'))
    })
  })
}

/**
 * Phase 1 单测 —— 浏览器控制反向通道(WS server 侧往返 + Origin 校验)
 *
 * 不需要真实 Chrome:用一个 mock ws client 冒充扩展 service worker,验证
 * 桌面半边(browser-control.ts)的连接管理、命令/结果往返、Origin 拒绝、
 * 未连接即 reject 都成立。扩展半边(background.js)逻辑与此 mock 对称。
 */
import { test, beforeAll, afterAll } from 'vitest'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { WebSocket } from 'ws'
import {
  attachBrowserControlWss,
  BROWSER_CONTROL_MAX_PAYLOAD_BYTES,
  sendBrowserCommand,
  isBrowserControlConnected,
  isBrowserControlReady
} from '../../src/main/browser-control.ts'
import { LocalHttpAuthBoundary } from '../../src/main/local-http-auth'

function waitFor(pred: () => boolean, timeoutMs = 2000): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now()
    const t = setInterval(() => {
      if (pred()) { clearInterval(t); resolve() }
      else if (Date.now() - start > timeoutMs) { clearInterval(t); reject(new Error('waitFor 超时')) }
    }, 10)
  })
}

const server = createServer()
const browserToken = 'b'.repeat(43)
const extensionOrigin = `chrome-extension://${'a'.repeat(32)}`
const auth = new LocalHttpAuthBoundary('n'.repeat(43), browserToken)
auth.bindExtensionSession(extensionOrigin)
let port = 0
const disposeBrowserControl = attachBrowserControlWss(server, auth, () => port)
let WS_URL = ''

beforeAll(async () => {
  const listening = once(server, 'listening')
  server.listen(0, '127.0.0.1')
  await listening

  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Browser control test server did not bind a TCP port')
  port = address.port
  WS_URL = `ws://127.0.0.1:${port}/ws/browser-control`
})

afterAll(async () => {
  await disposeBrowserControl()
  if (!server.listening) return
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

test('WS payload cap remains bounded while allowing normal screenshots', () => {
  assert.equal(BROWSER_CONTROL_MAX_PAYLOAD_BYTES, 16 * 1024 * 1024)
})

test('未连接扩展时 sendBrowserCommand 直接 reject(AI 不会无限等)', async () => {
  assert.equal(isBrowserControlConnected(), false)
  await assert.rejects(() => sendBrowserCommand('ping', {}, 500), /未连接/)
})

test('非 chrome-extension Origin 的连接被拒绝', async () => {
  const bad = new WebSocket(WS_URL, { origin: 'https://evil.example.com' })
  await new Promise<void>((resolve) => {
    bad.on('close', () => resolve())
    bad.on('error', () => resolve())
  })
  // 被拒的连接绝不该把自己设成"已连接扩展"
  assert.equal(isBrowserControlConnected(), false)
})

test('受信扩展连上后,ping 命令往返成功', async () => {
  const client = new WebSocket(WS_URL, { origin: extensionOrigin })
  // mock 扩展:收到 command(action=ping)就回 result
  client.on('message', (data) => {
    const msg = JSON.parse(data.toString())
    if (msg.type === 'command' && msg.action === 'ping') {
      client.send(JSON.stringify({ type: 'result', commandId: msg.commandId, ok: true, result: { pong: true } }))
    }
  })
  await new Promise<void>((resolve) => client.on('open', () => {
    client.send(JSON.stringify({ type: 'register', token: browserToken, cdp: true }))
    resolve()
  }))
  await waitFor(() => isBrowserControlConnected())

  const res = (await sendBrowserCommand('ping')) as { pong: boolean }
  assert.equal(res.pong, true)
  client.close()
})

test('扩展回 ok:false 时,命令 Promise 被 reject 并带错误', async () => {
  const client = new WebSocket(WS_URL, { origin: extensionOrigin })
  client.on('message', (data) => {
    const msg = JSON.parse(data.toString())
    if (msg.type === 'command') {
      client.send(JSON.stringify({ type: 'result', commandId: msg.commandId, ok: false, error: '页面未就绪' }))
    }
  })
  await new Promise<void>((resolve) => client.on('open', () => {
    client.send(JSON.stringify({ type: 'register', token: browserToken, cdp: true }))
    resolve()
  }))
  await waitFor(() => isBrowserControlConnected())

  await assert.rejects(() => sendBrowserCommand('navigate', { url: 'x' }), /页面未就绪/)
  client.close()
})

test('命令发出时扩展短暂未连,宽限期内重连则成功(MV3 韧性,更丝滑)', async () => {
  // 起始未连接;先发命令(进入宽限期等待),~300ms 后扩展才连上 → 应被分派并成功,而非立刻失败
  await waitFor(() => !isBrowserControlConnected())
  const p = sendBrowserCommand('ping', {}, 5000)
  await new Promise((r) => setTimeout(r, 300))
  const client = new WebSocket(WS_URL, { origin: extensionOrigin })
  client.on('message', (data) => {
    const msg = JSON.parse(data.toString())
    if (msg.type === 'command' && msg.action === 'ping') {
      client.send(JSON.stringify({ type: 'result', commandId: msg.commandId, ok: true, result: { pong: true } }))
    }
  })
  client.on('open', () => client.send(JSON.stringify({ type: 'register', token: browserToken, cdp: true })))
  const res = (await p) as { pong: boolean }
  assert.equal(res.pong, true)
  client.close()
})

test('isBrowserControlReady:仅当扩展 register 声明 cdp 能力时为 true(旧版不暴露工具)', async () => {
  await waitFor(() => !isBrowserControlConnected())
  // 不报 cdp 的旧扩展:connected 但 NOT ready
  const oldExt = new WebSocket(WS_URL, { origin: extensionOrigin })
  await new Promise<void>((r) => oldExt.on('open', () => {
    oldExt.send(JSON.stringify({ type: 'register', token: browserToken, ua: 'old' }))
    r()
  }))
  await waitFor(() => isBrowserControlConnected())
  await new Promise((r) => setTimeout(r, 100))
  assert.equal(isBrowserControlReady(), false, '未声明 cdp → not ready(工具不暴露)')
  oldExt.close()
  await waitFor(() => !isBrowserControlConnected())

  // 报 cdp:true 的新扩展:ready
  const newExt = new WebSocket(WS_URL, { origin: extensionOrigin })
  newExt.on('open', () => newExt.send(JSON.stringify({ type: 'register', token: browserToken, ua: 'x', cdp: true })))
  await waitFor(() => isBrowserControlReady())
  assert.equal(isBrowserControlReady(), true, '声明 cdp → ready(工具暴露)')
  newExt.close()
})

test('非 CDP 扩展无法踢掉正在工作的 CDP 扩展(防 war thrash)', async () => {
  await waitFor(() => !isBrowserControlConnected())
  // 1) CDP 扩展连上并能处理命令
  const cdpExt = new WebSocket(WS_URL, { origin: extensionOrigin })
  let cdpGotCmd = false
  cdpExt.on('message', (data) => {
    const msg = JSON.parse(data.toString())
    if (msg.type === 'command' && msg.action === 'ping') {
      cdpGotCmd = true
      cdpExt.send(JSON.stringify({ type: 'result', commandId: msg.commandId, ok: true, result: { pong: true } }))
    }
  })
  cdpExt.on('open', () => cdpExt.send(JSON.stringify({ type: 'register', token: browserToken, ua: 'x', cdp: true })))
  await waitFor(() => isBrowserControlReady())

  // 2) 非 CDP 旧扩展尝试连入(register 不带 cdp)
  const intruder = new WebSocket(WS_URL, { origin: extensionOrigin })
  intruder.on('open', () => intruder.send(JSON.stringify({ type: 'register', token: browserToken, ua: 'old' })))
  await new Promise((r) => setTimeout(r, 200))

  // 3) CDP 扩展仍活动,命令仍打到它(没被闯入者抢走)
  assert.equal(isBrowserControlReady(), true, 'CDP 扩展不应被非 CDP 连接踢掉')
  const res = (await sendBrowserCommand('ping')) as { pong: boolean }
  assert.equal(res.pong, true)
  assert.equal(cdpGotCmd, true, 'ping 应由 CDP 扩展处理,而非闯入者')
  intruder.close()
  cdpExt.close()
})

test('signal abort:在飞命令立刻取消 + pending 清理(用户点停止能停掉,不傻等超时)', async () => {
  await waitFor(() => !isBrowserControlConnected())
  const client = new WebSocket(WS_URL, { origin: extensionOrigin })
  client.on('message', (data) => {
    const msg = JSON.parse(data.toString())
    // 只回 ping;navigate 故意不回 → 模拟卡住的慢操作(真实里就是整页加载/无响应)
    if (msg.type === 'command' && msg.action === 'ping') {
      client.send(JSON.stringify({ type: 'result', commandId: msg.commandId, ok: true, result: { pong: true } }))
    }
  })
  client.on('open', () => client.send(JSON.stringify({ type: 'register', token: browserToken, ua: 'x', cdp: true })))
  await waitFor(() => isBrowserControlReady())

  const ac = new AbortController()
  // timeoutMs 给 30s:若不靠 abort,本命令会傻等 30s —— 测试能在 100ms 内拿到 reject 即证明 abort 生效
  const p = sendBrowserCommand('navigate', { url: 'https://slow.example' }, 30_000, ac.signal)
  await new Promise((r) => setTimeout(r, 100))
  ac.abort()
  await assert.rejects(() => p, /已取消/)

  // abort 不污染后续:同一连接上 ping 仍正常往返(pending 已被清干净)
  const res = (await sendBrowserCommand('ping', {}, 2000)) as { pong: boolean }
  assert.equal(res.pong, true)
  client.close()
})

test('已 abort 的 signal:命令直接拒绝(不无谓发往扩展)', async () => {
  await waitFor(() => !isBrowserControlConnected())
  const client = new WebSocket(WS_URL, { origin: extensionOrigin })
  client.on('open', () => client.send(JSON.stringify({ type: 'register', token: browserToken, ua: 'x', cdp: true })))
  await waitFor(() => isBrowserControlReady())

  const ac = new AbortController()
  ac.abort()
  await assert.rejects(() => sendBrowserCommand('ping', {}, 2000, ac.signal), /已取消/)
  client.close()
})

const OPENPIPAL_HTTP = 'http://localhost:3031'
const BROWSER_TOKEN_HEADER = 'X-OpenPipal-Browser-Token'
let browserSessionPromise = null

function resetBrowserSession() {
  browserSessionPromise = null
}

function getBrowserSessionToken() {
  if (!browserSessionPromise) {
    browserSessionPromise = fetch(`${OPENPIPAL_HTTP}/extension/session`, {
      method: 'POST',
      credentials: 'omit'
    }).then(async (res) => {
      if (!res.ok) throw new Error(`OpenPipal browser session failed: ${res.status}`)
      const body = await res.json()
      if (!body || typeof body.token !== 'string') throw new Error('OpenPipal browser session token missing')
      return body.token
    }).catch((error) => {
      browserSessionPromise = null
      throw error
    })
  }
  return browserSessionPromise
}

async function openpipalFetch(path, init = {}, retry = true) {
  const token = await getBrowserSessionToken()
  const headers = new Headers(init.headers || {})
  headers.set(BROWSER_TOKEN_HEADER, token)
  const res = await fetch(`${OPENPIPAL_HTTP}${path}`, { ...init, headers, credentials: 'omit' })
  if (retry && (res.status === 401 || res.status === 403)) {
    resetBrowserSession()
    return openpipalFetch(path, init, false)
  }
  return res
}

// 点击扩展图标时打开 Side Panel
chrome.action.onClicked.addListener((tab) => {
  chrome.sidePanel.open({ tabId: tab.id })
})

// 响应桌面端的插件存活检查
chrome.runtime.onMessageExternal?.addListener((msg, sender, sendResponse) => {
  if (msg?.type === 'ping') sendResponse({ ok: true })
})

// 启动时先建立进程期 browser session，再向桌面端注册。
openpipalFetch('/extension/register', { method: 'POST' }).catch(() => {})

// ---- 右键菜单 ----
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: 'openpipal-explain',
    title: chrome.i18n.getMessage('contextMenuExplain'),
    contexts: ['selection']
  })
  chrome.contextMenus.create({
    id: 'openpipal-translate',
    title: chrome.i18n.getMessage('contextMenuTranslate'),
    contexts: ['selection']
  })
})

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (!tab?.id || !info.selectionText) return
  const action = info.menuItemId === 'openpipal-explain' ? 'explain' : 'translate'

  // 打开 side panel
  chrome.sidePanel.open({ tabId: tab.id })

  // 发送上下文 + 动作到桌面端和 side panel
  const payload = {
    type: 'CONTEXT_MENU_ACTION',
    action,
    text: info.selectionText,
    url: tab.url || '',
    title: tab.title || ''
  }

  // 通知 side panel（它会转发给 iframe）
  chrome.runtime.sendMessage(payload).catch(() => {})

  // 同时 POST 到桌面端
  openpipalFetch('/context', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      tabId: tab.id,
      url: tab.url,
      title: tab.title,
      selectedText: info.selectionText,
      action,
      pageContent: ''
    })
  }).catch(() => {})
})

// 监听来自 content script 的消息
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'GET_PAGE_CONTEXT') {
    // 转发给 side panel
    chrome.runtime.sendMessage(message)
    sendResponse({ ok: true })
  }
  return true
})

// ============================================================
// 反向控制通道(Phase 1)—— 连接桌面端 WS,接收浏览器控制命令
// 控制逻辑必须在 service worker 里:只有 SW 能调 chrome.debugger。
// MV3 SW 全局无 EventSource,故用 WebSocket;活跃 WS 流量 + alarms 兜底保活。
// ============================================================
const BC_WS_URL = 'ws://localhost:3031/ws/browser-control'
let bcSocket = null
let bcReconnectDelay = 1000

async function bcConnect() {
  if (bcSocket && (bcSocket.readyState === WebSocket.OPEN || bcSocket.readyState === WebSocket.CONNECTING)) return
  let browserToken
  try {
    browserToken = await getBrowserSessionToken()
  } catch (_e) {
    bcScheduleReconnect()
    return
  }
  try {
    bcSocket = new WebSocket(BC_WS_URL)
  } catch (_e) {
    bcScheduleReconnect()
    return
  }
  bcSocket.onopen = () => {
    bcReconnectDelay = 1000
    // cdp:true 声明本扩展具备 chrome.debugger 执行能力(0.3.8+);桌面端据此才暴露浏览器工具
    bcSend({ type: 'register', token: browserToken, ua: navigator.userAgent, cdp: true })
  }
  bcSocket.onmessage = (ev) => {
    let msg
    try { msg = JSON.parse(ev.data) } catch (_e) { return }
    bcHandle(msg)
  }
  bcSocket.onclose = () => { bcSocket = null; resetBrowserSession(); bcScheduleReconnect() }
  bcSocket.onerror = () => { try { bcSocket && bcSocket.close() } catch (_e) { /* ignore */ } }
}

function bcScheduleReconnect() {
  setTimeout(bcConnect, bcReconnectDelay)
  bcReconnectDelay = Math.min(bcReconnectDelay * 2, 30000) // 指数退避封顶 30s
}

function bcSend(obj) {
  if (bcSocket && bcSocket.readyState === WebSocket.OPEN) {
    bcSocket.send(JSON.stringify(obj))
  }
}

async function bcHandle(msg) {
  if (!msg || typeof msg !== 'object') return
  if (msg.type === 'ping') { bcSend({ type: 'pong' }); return }
  if (msg.type === 'hello') return
  if (msg.type === 'command' && msg.commandId) {
    try {
      const result = await bcExecute(msg.action, msg.params || {})
      bcSend({ type: 'result', commandId: msg.commandId, ok: true, result })
    } catch (e) {
      bcSend({ type: 'result', commandId: msg.commandId, ok: false, error: (e && e.message) || String(e) })
    }
  }
}

// ---- CDP(chrome.debugger)执行层 ----
// 作用在用户真实登录态的 Chrome profile 上。attach 后 Chrome 会显示
// "OpenPipal 正在调试此浏览器"黄条 —— 这是知情同意信号,刻意保留。
const bcAttached = new Set() // 已 attach 的 tabId

function bcCdp(tabId, method, params) {
  return new Promise((resolve, reject) => {
    chrome.debugger.sendCommand({ tabId }, method, params || {}, (result) => {
      const err = chrome.runtime.lastError
      if (err) reject(new Error(err.message))
      else resolve(result)
    })
  })
}

function bcAttach(tabId) {
  if (bcAttached.has(tabId)) return Promise.resolve()
  return new Promise((resolve, reject) => {
    chrome.debugger.attach({ tabId }, '1.3', () => {
      const err = chrome.runtime.lastError
      if (err) reject(new Error('attach 失败: ' + err.message))
      else { bcAttached.add(tabId); resolve() }
    })
  })
}

// tab 关闭 / 调试被外部接管时,清理 attach 记录
chrome.debugger.onDetach?.addListener((src) => { if (src.tabId != null) bcAttached.delete(src.tabId) })
chrome.tabs.onRemoved?.addListener((tabId) => bcAttached.delete(tabId))

async function bcActiveTabId(params) {
  if (params && params.tabId != null) return params.tabId
  const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true })
  if (!tabs[0]) throw new Error('找不到活动标签页')
  return tabs[0].id
}

function bcHostOf(url) {
  try { return new URL(url || '').hostname.toLowerCase() } catch (_) { return '' }
}

function bcTargetChangedError() {
  return new Error('目标标签页在操作期间发生了导航，已丢弃结果；请重新列出标签页后再试')
}

// 主进程按 expectedHost 完成站点授权；扩展在真实目标 tab 上再次核对，防止 tabId
// 指向另一站点，或授权后到执行前标签已导航。空/不匹配一律 fail closed。
async function bcAssertTargetHost(tabId, expectedHost) {
  const tab = await chrome.tabs.get(tabId)
  const actualHost = bcHostOf(tab && tab.url)
  const expected = String(expectedHost || '').toLowerCase()
  if (!expected || actualHost !== expected) {
    throw new Error(`目标标签页站点已变化（预期 ${expected || '未知'}，实际 ${actualHost || '未知'}），请重新列出标签页后再试`)
  }
  return tab
}

function bcMainFrameIdentity(result) {
  const frame = result && result.frameTree && result.frameTree.frame
  if (!frame || !frame.id || !frame.loaderId) throw bcTargetChangedError()
  return {
    frameId: String(frame.id),
    loaderId: String(frame.loaderId),
    url: String(frame.url || '')
  }
}

async function bcGetMainFrameIdentity(tabId) {
  await bcAttach(tabId)
  return bcMainFrameIdentity(await bcCdp(tabId, 'Page.getFrameTree', {}))
}

// 一次敏感操作必须绑定在同一个 tab、host 和主文档 loader 上。
// onUpdated 捕获短暂的「跳走又跳回」，Page.getFrameTree 则在结果返回前再校验
// CDP 真正操作的主文档。任一不稳定都 fail closed，不返回文本/像素。
async function bcOpenStableTarget(tabId, expectedHost) {
  const expected = String(expectedHost || '').toLowerCase()
  let invalidated = false
  const onUpdated = (id, changeInfo, tab) => {
    if (id !== tabId) return
    if (changeInfo && (changeInfo.status === 'loading' || Object.prototype.hasOwnProperty.call(changeInfo, 'url'))) {
      invalidated = true
    }
    const observedUrl = (changeInfo && changeInfo.url) || (tab && tab.url) || ''
    if (observedUrl && bcHostOf(observedUrl) !== expected) invalidated = true
  }
  chrome.tabs.onUpdated.addListener(onUpdated)

  try {
    const tab = await bcAssertTargetHost(tabId, expected)
    const initialFrame = await bcGetMainFrameIdentity(tabId)
    if (invalidated || bcHostOf(initialFrame.url) !== expected) throw bcTargetChangedError()

    return {
      expected,
      async assertStable(returnedUrl) {
        if (invalidated) throw bcTargetChangedError()
        const liveTab = await bcAssertTargetHost(tabId, expected)
        if (invalidated) throw bcTargetChangedError()
        const liveFrame = await bcGetMainFrameIdentity(tabId)
        if (
          invalidated ||
          bcHostOf(liveTab && liveTab.url) !== expected ||
          bcHostOf(liveFrame.url) !== expected ||
          liveFrame.frameId !== initialFrame.frameId ||
          liveFrame.loaderId !== initialFrame.loaderId ||
          (returnedUrl !== undefined && bcHostOf(returnedUrl) !== expected)
        ) {
          throw bcTargetChangedError()
        }
        return liveTab
      },
      close() {
        chrome.tabs.onUpdated.removeListener(onUpdated)
      }
    }
  } catch (error) {
    chrome.tabs.onUpdated.removeListener(onUpdated)
    throw error
  }
}

function bcAssertNavigationHost(url, expectedHost) {
  const actualHost = bcHostOf(url)
  const expected = String(expectedHost || '').toLowerCase()
  if (!expected || actualHost !== expected) {
    throw new Error('导航目标与已授权站点不一致')
  }
}

// 读某个 tab 的 document.readyState(用 scripting,不 attach debugger → 无黄条闪烁)
async function bcTabReadyState(tabId) {
  try {
    const res = await chrome.scripting.executeScript({ target: { tabId }, func: () => document.readyState })
    return res && res[0] ? res[0].result : null
  } catch (_) {
    return null // 导航提交瞬间上下文切换 / 特权页 → 视为未就绪,继续轮询
  }
}

// 等导航「DOM 就绪即返回」(DOMContentLoaded):比整页 load 快得多,封顶 capMs。
// 关键:先等 onUpdated 报 'loading'(导航已提交)再轮询新页 readyState,
// 否则会读到旧页残留的 readyState:'complete' 提前误返回。
// 返回 reason:'interactive'|'complete'(就绪)| 'timeout'(已导航但仍在加载,仍算成功)。
function bcWaitNav(tabId, capMs) {
  const cap = capMs || 8000
  const start = Date.now()
  return new Promise((resolve) => {
    let settled = false
    let committed = false
    const finish = (reason) => {
      if (settled) return
      settled = true
      chrome.tabs.onUpdated.removeListener(onUpd)
      resolve(reason)
    }
    const onUpd = (id, info) => {
      if (id !== tabId) return
      if (info.status === 'loading') committed = true
      if (info.status === 'complete') finish('complete') // 轻页直接整页完成也即刻返回
    }
    chrome.tabs.onUpdated.addListener(onUpd)
    const poll = async () => {
      if (settled) return
      if (Date.now() - start >= cap) return finish('timeout')
      if (committed) {
        const rs = await bcTabReadyState(tabId)
        if (rs === 'interactive' || rs === 'complete') return finish(rs)
      }
      setTimeout(poll, 150)
    }
    setTimeout(poll, 200) // 给导航一点提交时间再首测
  })
}

// 在页面里 eval 一段表达式,returnByValue 取回 JS 值
async function bcEval(tabId, expression) {
  await bcAttach(tabId)
  const r = await bcCdp(tabId, 'Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (r && r.exceptionDetails) throw new Error('页面脚本异常: ' + (r.exceptionDetails.text || 'unknown'))
  return r && r.result ? r.result.value : undefined
}

// 解析选择器 → 元素视口中心坐标(顺带滚动到可见),找不到返回 null
async function bcCenter(tabId, selector, expectedHost) {
  const result = await bcEval(tabId, `(()=>{const host=location.hostname.toLowerCase();if(host!==${JSON.stringify(String(expectedHost || '').toLowerCase())})return {authorized:false};const el=document.querySelector(${JSON.stringify(selector)});if(!el)return {authorized:true,found:false};el.scrollIntoView({block:'center',inline:'center'});const r=el.getBoundingClientRect();return {authorized:true,found:true,x:r.left+r.width/2,y:r.top+r.height/2}})()`)
  if (!result || result.authorized !== true) throw bcTargetChangedError()
  return result.found ? { x: result.x, y: result.y } : null
}

async function bcExecute(action, params) {
  params = params || {}
  switch (action) {
    case 'ping':
      return { pong: true, ts: Date.now() }

    case 'list_tabs': {
      const tabs = await chrome.tabs.query({})
      return { tabs: tabs.map((t) => ({ id: t.id, title: t.title, url: t.url, active: !!t.active, windowId: t.windowId })) }
    }

    case 'read_page': {
      const tabId = await bcActiveTabId(params)
      const guard = await bcOpenStableTarget(tabId, params.expectedHost)
      try {
        const max = Math.max(1, Math.min(Number(params.maxChars) || 20000, 100000))
        const data = await bcEval(tabId, `(()=>{const host=location.hostname.toLowerCase();if(host!==${JSON.stringify(guard.expected)})return {authorized:false};return {authorized:true,title:document.title,url:location.href,text:((document.body&&document.body.innerText)||'').slice(0,${max})}})()`)
        if (!data || data.authorized !== true) throw bcTargetChangedError()
        await guard.assertStable(data.url)
        return { tabId, title: data.title, url: data.url, text: data.text }
      } finally {
        guard.close()
      }
    }

    case 'screenshot': {
      const tabId = await bcActiveTabId(params)
      const guard = await bcOpenStableTarget(tabId, params.expectedHost)
      try {
        // CDP Page.captureScreenshot:对 data:/http 各类页面都可用,不依赖 activeTab 手势或 host 权限
        const r = await bcCdp(tabId, 'Page.captureScreenshot', { format: 'jpeg', quality: 60 })
        const tab = await guard.assertStable()
        return { tabId, url: tab.url || '', dataUrl: 'data:image/jpeg;base64,' + (r && r.data ? r.data : '') }
      } finally {
        guard.close()
      }
    }

    case 'navigate': {
      const tabId = await bcActiveTabId(params)
      if (!params.url) throw new Error('navigate 需要 url')
      bcAssertNavigationHost(params.url, params.expectedHost)
      await chrome.tabs.update(tabId, { url: params.url })
      // DOM 就绪即返回(不阻塞整页 load);封顶 waitMs 后即便仍在加载也成功返回
      const ready = await bcWaitNav(tabId, Number(params.waitMs) || 8000)
      const tab = await chrome.tabs.get(tabId)
      return { tabId, url: tab.url, title: tab.title, ready }
    }

    case 'click': {
      const tabId = await bcActiveTabId(params)
      if (!params.selector) throw new Error('click 需要 selector')
      const guard = await bcOpenStableTarget(tabId, params.expectedHost)
      try {
        const c = await bcCenter(tabId, params.selector, guard.expected)
        if (!c) throw new Error('未找到元素: ' + params.selector)
        // 用 CDP Input 派发可信鼠标事件(isTrusted=true,过得了多数站点的校验)。每个
        // 可产生副作用的边界前都重新核对 loader，中途导航则不再发后续事件。
        await guard.assertStable()
        await bcCdp(tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: c.x, y: c.y })
        await guard.assertStable()
        await bcCdp(tabId, 'Input.dispatchMouseEvent', { type: 'mousePressed', x: c.x, y: c.y, button: 'left', clickCount: 1 })
        await guard.assertStable()
        await bcCdp(tabId, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x: c.x, y: c.y, button: 'left', clickCount: 1 })
        await guard.assertStable()
        return { clicked: params.selector }
      } finally {
        guard.close()
      }
    }

    case 'fill': {
      const tabId = await bcActiveTabId(params)
      if (!params.selector) throw new Error('fill 需要 selector')
      const guard = await bcOpenStableTarget(tabId, params.expectedHost)
      try {
        await guard.assertStable()
        const result = await bcEval(tabId, `(()=>{const host=location.hostname.toLowerCase();if(host!==${JSON.stringify(guard.expected)})return {authorized:false};const el=document.querySelector(${JSON.stringify(params.selector)});if(!el)return {authorized:true,found:false};el.focus();const d=Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el),'value');if(d&&d.set)d.set.call(el,${JSON.stringify(params.value || '')});else el.value=${JSON.stringify(params.value || '')};el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));return {authorized:true,found:true}})()`)
        if (!result || result.authorized !== true) throw bcTargetChangedError()
        if (!result.found) throw new Error('未找到输入框: ' + params.selector)
        await guard.assertStable()
        return { filled: params.selector }
      } finally {
        guard.close()
      }
    }

    case 'select': {
      const tabId = await bcActiveTabId(params)
      if (!params.selector) throw new Error('select 需要 selector')
      const guard = await bcOpenStableTarget(tabId, params.expectedHost)
      try {
        await guard.assertStable()
        const result = await bcEval(tabId, `(()=>{const host=location.hostname.toLowerCase();if(host!==${JSON.stringify(guard.expected)})return {authorized:false};const el=document.querySelector(${JSON.stringify(params.selector)});if(!el)return {authorized:true,found:false};el.value=${JSON.stringify(params.value || '')};el.dispatchEvent(new Event('change',{bubbles:true}));return {authorized:true,found:true}})()`)
        if (!result || result.authorized !== true) throw bcTargetChangedError()
        if (!result.found) throw new Error('未找到下拉框: ' + params.selector)
        await guard.assertStable()
        return { selected: params.selector, value: params.value }
      } finally {
        guard.close()
      }
    }

    case 'scroll': {
      const tabId = await bcActiveTabId(params)
      const guard = await bcOpenStableTarget(tabId, params.expectedHost)
      try {
        await guard.assertStable()
        const hostCheck = `const host=location.hostname.toLowerCase();if(host!==${JSON.stringify(guard.expected)})return {authorized:false};`
        const expr = params.selector
          ? `(()=>{${hostCheck}const el=document.querySelector(${JSON.stringify(params.selector)});if(!el)return {authorized:true,found:false};el.scrollIntoView({behavior:'smooth',block:'center'});return {authorized:true,found:true}})()`
          : `(()=>{${hostCheck}window.scrollBy({top:${Number(params.dy) || 600},left:${Number(params.dx) || 0},behavior:'smooth'});return {authorized:true,found:true}})()`
        const result = await bcEval(tabId, expr)
        if (!result || result.authorized !== true) throw bcTargetChangedError()
        if (params.selector && !result.found) throw new Error('未找到滚动目标: ' + params.selector)
        await guard.assertStable()
        return { scrolled: true }
      } finally {
        guard.close()
      }
    }

    case 'hover': {
      const tabId = await bcActiveTabId(params)
      if (!params.selector) throw new Error('hover 需要 selector')
      const guard = await bcOpenStableTarget(tabId, params.expectedHost)
      try {
        const c = await bcCenter(tabId, params.selector, guard.expected)
        if (!c) throw new Error('未找到元素: ' + params.selector)
        await guard.assertStable()
        await bcCdp(tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: c.x, y: c.y })
        await guard.assertStable()
        return { hovered: params.selector }
      } finally {
        guard.close()
      }
    }

    default:
      throw new Error('未知命令: ' + action)
  }
}

// 启动即连;SW 被唤醒/alarms 周期兜底重连
bcConnect()
chrome.alarms?.create('bc-keepalive', { periodInMinutes: 0.5 })
chrome.alarms?.onAlarm.addListener((a) => {
  if (a.name === 'bc-keepalive') bcConnect()
})

// OpenPipal Extension — 薄壳
// 职责：检测桌面端连接 + 提取页面上下文 + 转发给 iframe 中的 React App

const APP_URL = 'http://localhost:3031'
const frame = document.getElementById('app')
const errorEl = document.getElementById('error')
const statusEl = document.getElementById('error-status')
const reconnectButton = document.getElementById('reconnect-button')
const BROWSER_TOKEN_HEADER = 'X-OpenPipal-Browser-Token'

function i18nMessage(name, substitutions) {
  return chrome.i18n.getMessage(name, substitutions)
}

function localizeShell() {
  const uiLanguage = chrome.i18n.getUILanguage()
  if (uiLanguage) document.documentElement.lang = uiLanguage.replaceAll('_', '-')
  document.querySelectorAll('[data-i18n]').forEach((element) => {
    const message = i18nMessage(element.dataset.i18n)
    if (message) element.textContent = message
  })
}

localizeShell()
reconnectButton?.addEventListener('click', () => location.reload())

let browserSessionPromise = null

function resetBrowserSession() {
  browserSessionPromise = null
}

function postBrowserSession(token) {
  frame.contentWindow?.postMessage({ type: 'OPENPIPAL_BROWSER_SESSION', token }, APP_URL)
}

function getBrowserSessionToken() {
  if (!browserSessionPromise) {
    browserSessionPromise = fetch(`${APP_URL}/extension/session`, {
      method: 'POST',
      credentials: 'omit'
    }).then(async (res) => {
      if (!res.ok) throw new Error(`OpenPipal browser session failed: ${res.status}`)
      const body = await res.json()
      if (!body || typeof body.token !== 'string') throw new Error('OpenPipal browser session token missing')
      postBrowserSession(body.token)
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
  const res = await fetch(`${APP_URL}${path}`, { ...init, headers, credentials: 'omit' })
  if (retry && (res.status === 401 || res.status === 403)) {
    resetBrowserSession()
    return openpipalFetch(path, init, false)
  }
  return res
}

let failCount = 0
// PDF 检测/取字节结果 memo：Map<url, {status}>，status ∈ pending|ok|fail|notpdf，容量 20（FIFO 淘汰）。
// pending 是"在途请求"占位——切 tab/加载的密集触发（500ms/1s/4s）靠它去重，防止同一 PDF 被并发整份下载多次。
const PDF_MEMO_CAP = 20
let pdfMemo = new Map()
let desktopWasOnline = false
let desktopProcessNonce = null

// 检测桌面端是否在线
async function checkDesktop() {
  try {
    const res = await fetch(`${APP_URL}/health`, { signal: AbortSignal.timeout(2000) })
    if (res.ok) {
      const health = await res.json()
      const nextProcessNonce = typeof health?.processNonce === 'string' ? health.processNonce : null
      // A desktop restart can happen between two five-second health polls. In
      // that window the old process token would otherwise stay cached and make
      // the iframe wait for a failed request before it can recover.
      if (desktopProcessNonce && nextProcessNonce && desktopProcessNonce !== nextProcessNonce) {
        resetBrowserSession()
      }
      desktopProcessNonce = nextProcessNonce
      await getBrowserSessionToken()
      frame.style.display = 'block'
      errorEl.classList.remove('visible')
      failCount = 0
      // false→true 转变：桌面重启后内存里的 pdfTextCache 已丢，清空 memo 让上送重新触发
      if (!desktopWasOnline) pdfMemo = new Map()
      desktopWasOnline = true
      return true
    }
  } catch {}
  frame.style.display = 'none'
  errorEl.classList.add('visible')
  failCount++
  desktopWasOnline = false
  desktopProcessNonce = null
  resetBrowserSession()
  if (statusEl) {
    if (failCount <= 2) {
      statusEl.textContent = i18nMessage('connectingStatus')
    } else {
      statusEl.textContent = i18nMessage('retryStatus', [String(failCount)])
    }
  }
  return false
}

checkDesktop()
setInterval(checkDesktop, 5000)

// 发送上下文到桌面端 + iframe
function sendContext(ctx, tabId) {
  const serverCtx = { ...(ctx || {}), tabId }
  openpipalFetch('/context', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(serverCtx)
  }).catch(() => {})
  // postMessage 给 iframe 的副本剔除 pdfBase64：大字符串不该进 renderer 内存，也不该随 shim 聊天请求原样回传
  const { pdfBase64: _pdfBase64, ...iframeCtx } = ctx || {}
  getBrowserSessionToken().then(() => {
    frame.contentWindow?.postMessage({ type: 'PAGE_CONTEXT', context: iframeCtx }, APP_URL)
  }).catch(() => {})
}

// base64 编码（分块处理，避免大文件用 apply 展开触发栈溢出）
function bufToB64(buf) {
  const bytes = new Uint8Array(buf); let s = ''
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000))
  return btoa(s)
}

// 写 memo 并按容量淘汰最旧条目（Map 保插入序，删后重插=移到末尾，天然 FIFO）
function setPdfMemo(url, status) {
  pdfMemo.delete(url)
  pdfMemo.set(url, { status })
  while (pdfMemo.size > PDF_MEMO_CAP) {
    const oldest = pdfMemo.keys().next().value
    if (oldest === undefined) break
    pdfMemo.delete(oldest)
  }
}

// 把多段 Uint8Array 拼成一段定长 buffer（用于取前 1024 字节嗅探，以及读完后的整体拼接）
function concatUint8(chunks, len) {
  const out = new Uint8Array(len)
  let offset = 0
  for (const c of chunks) {
    if (offset >= len) break
    const take = Math.min(c.byteLength, len - offset)
    out.set(c.subarray(0, take), offset)
    offset += take
  }
  return out
}

// content-type 是 octet-stream/缺失时的判定：流式读取，攒够 1024 字节先查 %PDF- 魔数——
// 不中立刻 cancel，避免把一个大文件整份下载完才发现不是 PDF；命中则继续读完，
// 累积中途超 30MB 立即中止（判 notpdf，视为放弃，不是网络失败）。
// 返回值：Uint8Array（确认是 PDF）| 'notpdf' | 'fail'
async function sniffStreamForPdf(res) {
  const reader = res.body?.getReader()
  if (!reader) {
    // 极端环境不支持流式 body：退化为一次性读取 + 事后嗅探
    let buf
    try { buf = await res.arrayBuffer() } catch { return 'fail' }
    if (buf.byteLength > 30 * 1024 * 1024) return 'notpdf'
    const head = new TextDecoder('latin1').decode(new Uint8Array(buf, 0, Math.min(1024, buf.byteLength)))
    return head.includes('%PDF-') ? new Uint8Array(buf) : 'notpdf'
  }

  const chunks = []
  let total = 0
  let checkedMagic = false
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (value) { chunks.push(value); total += value.byteLength }
      if (!checkedMagic && (total >= 1024 || done)) {
        checkedMagic = true
        const head = concatUint8(chunks, Math.min(1024, total))
        if (!new TextDecoder('latin1').decode(head).includes('%PDF-')) {
          await reader.cancel().catch(() => {})
          return 'notpdf'
        }
      }
      if (total > 30 * 1024 * 1024) {
        await reader.cancel().catch(() => {})
        return 'notpdf'
      }
      if (done) break
    }
  } catch {
    return 'fail'
  }
  return concatUint8(chunks, total)
}

// content script 注入失败时的兜底（Chrome 内置 PDF 查看器不允许注入）：http(s) 页面尝试带 cookie 取字节，
// 交桌面端 pdf-parse 解析。isRefresh=true（用户发消息前触发）时才对此前失败过的 url 重试。
async function tryBuildPdfContext(tab, isRefresh) {
  const url = tab.url || ''
  if (!/^https?:\/\//i.test(url)) return null // file:// 留给桌面端本地读

  const memo = pdfMemo.get(url)
  if (memo) {
    if (memo.status === 'pending') return null // 在途请求：不并发重复下载，这次先走最小 ctx
    if (memo.status === 'ok') {
      // 已确认是 PDF 且桌面端已缓存正文，不重复取字节——fillPdfPageContentFromCache 会回填
      return { url, title: tab.title || '', selectedText: '', pageContent: '', subtitles: null, meta: { pdf: true } }
    }
    if (memo.status === 'notpdf') return null // 已确认非 PDF 或曾超过大小上限：永久放弃，不再重试
    if (memo.status === 'fail' && !isRefresh) return null // 非刷新触发不重试，走现有最小 ctx
  }

  setPdfMemo(url, 'pending')
  const looksLikePdfUrl = /\.pdf($|[?#])/i.test(url)
  const markFail = () => {
    setPdfMemo(url, 'fail')
    // 取失败但 url 形似 pdf：给出可辨识的 meta，而非静默当普通页面处理
    return looksLikePdfUrl
      ? { url, title: tab.title || '', selectedText: '', pageContent: '', subtitles: null, meta: { pdf: 'unavailable' } }
      : null
  }
  const markNotPdf = () => {
    setPdfMemo(url, 'notpdf') // 永久放弃：确认非 PDF 或超过 30MB 上限，两者都不再重试（哪怕 isRefresh）
    return null
  }

  // 外层兜底：任何未预料的异常（如 base64 编码栈溢出）都要让 pending 落到终态，绝不能卡死在 pending
  try {
    let res
    try {
      res = await fetch(url, { credentials: 'include', signal: AbortSignal.timeout(20_000) })
    } catch { return markFail() }

    const ct = res.headers.get('content-type') || ''
    let buf
    if (ct.includes('application/pdf')) {
      // content-type 明确是 pdf：直接整体读取（仍受 30MB 上限保护）
      const lenHeader = Number(res.headers.get('content-length') || 0)
      if (lenHeader > 30 * 1024 * 1024) return markNotPdf()
      try { buf = await res.arrayBuffer() } catch { return markFail() }
      if (buf.byteLength > 30 * 1024 * 1024) return markNotPdf()
    } else if (ct && !ct.includes('application/octet-stream')) {
      // content-type 明确是其他类型（text/html 等）：不读 body，直接放弃。
      // 但 text/html 恰是登录墙/WAF 挑战页的典型签名——url 形似 .pdf 时不能永久判死 notpdf，
      // 否则用户未登录时探测一次就被永久钉死，登录后也不会再试。这种情况记 'fail'：
      // isRefresh 才重试，且不读 body，重试成本只有一次请求头往返，不会退回整页重下。
      // url 本就不形似 .pdf 时才是真正"确定非 PDF"，可以永久放弃。
      await res.body?.cancel().catch(() => {})
      return looksLikePdfUrl ? markFail() : markNotPdf()
    } else {
      // content-type 缺失或 octet-stream：流式读前 1024 字节嗅探魔数，不中就 cancel，不整份下载
      const sniffed = await sniffStreamForPdf(res)
      if (sniffed === 'notpdf') return markNotPdf()
      if (sniffed === 'fail') return markFail()
      buf = sniffed
    }

    setPdfMemo(url, 'ok')
    return {
      url, title: tab.title || '', selectedText: '', pageContent: '', subtitles: null,
      meta: { pdf: true }, pdfBase64: bufToB64(buf)
    }
  } catch {
    return markFail()
  }
}

// 提取当前页面上下文
async function extractAndSendContext(isRefresh = false) {
  let tab
  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true })
    tab = tabs[0]
    if (!tab?.id) return
  } catch { return }

  // 尝试通过 content script 提取完整内容
  try {
    const ctx = await chrome.tabs.sendMessage(tab.id, { type: 'EXTRACT_CONTEXT' })
    if (ctx) {
      sendContext(ctx, tab.id)
      return
    }
  } catch {
    // content script 未就绪或无法注入（chrome:// 页、PDF 等）—— 先试 PDF 直读兜底。
    // 整体套 try/catch：tryBuildPdfContext 内部已有兜底，这里是最后一道防线——任何意外抛错
    // 都必须落到下面的最小 ctx 发送逻辑，不能让本轮上下文彻底不发、桌面端残留上一页 context。
    try {
      const pdfCtx = await tryBuildPdfContext(tab, isRefresh)
      if (pdfCtx) {
        sendContext(pdfCtx, tab.id)
        return
      }
    } catch {
      // 吞掉，走下面的最小 ctx 兜底
    }
  }

  // 兜底：用 tab 元信息生成最小上下文，确保切 tab 后不会残留旧内容
  sendContext({
    url: tab.url || '',
    title: tab.title || '',
    selectedText: '',
    pageContent: '',
    subtitles: null,
    meta: {}
  }, tab.id)
}

// 页面切换 / 加载完成时更新上下文
chrome.tabs.onActivated.addListener(() => {
  // 立即用 tab 元信息刷新一次（防止残留旧内容）
  extractAndSendContext()
  // 500ms 后再提取一次完整内容（等 content script 就绪）
  setTimeout(extractAndSendContext, 500)
})
chrome.tabs.onUpdated.addListener((_, info) => {
  if (info.status === 'complete') {
    setTimeout(extractAndSendContext, 1000)
    setTimeout(extractAndSendContext, 4000)
  }
})

// iframe 加载完成后先交付进程期 token，再发送上下文。
frame.addEventListener('load', () => {
  getBrowserSessionToken().then(postBrowserSession).catch(() => {})
  extractAndSendContext()
})

// iframe 请求刷新上下文（用户发消息前）—— isRefresh=true，允许对此前失败的 PDF url 重试取字节
window.addEventListener('message', (e) => {
  if (e.source === frame.contentWindow && e.origin === APP_URL && e.data?.type === '__OPENPIPAL_REFRESH_CONTEXT__') {
    extractAndSendContext(true)
  }
  if (e.source === frame.contentWindow && e.origin === APP_URL && e.data?.type === 'OPENPIPAL_BROWSER_SESSION_REQUEST') {
    resetBrowserSession()
    getBrowserSessionToken().then(postBrowserSession).catch(() => {})
  }
})

// 接收来自 background.js 的右键菜单动作，转发给 iframe
chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === 'CONTEXT_MENU_ACTION' && frame) {
    frame.contentWindow?.postMessage({
      type: 'CONTEXT_MENU_ACTION',
      action: msg.action,
      text: msg.text,
      url: msg.url,
      title: msg.title
    }, APP_URL)
  }
})

// 版本号显示
try {
  const manifest = chrome.runtime.getManifest()
  const verEl = document.getElementById('ver')
  if (verEl) verEl.textContent = 'v' + manifest.version
} catch {}

// 初始化
extractAndSendContext()

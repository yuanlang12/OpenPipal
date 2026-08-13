/**
 * PDF 页面正文直读管线 —— 浏览器插件读 PDF 页面时，Chrome 内置查看器不允许 content script 注入，
 * DOM 里也没有正文（PDFium 插件渲染，不在 DOM）。这里把扩展带 cookie 取到的字节（或桌面端兜底抓取）
 * 交给 pdf-parse 解析，结果按 url 缓存，供 read_page_content 工具按需分段读取。
 *
 * 独立成模块（不放进 http-server.ts）：http-server.ts 的 import 链带一串 electron 相关副作用模块，
 * 直接 import 会拖累单测；这里只依赖 fs/path/url + file-parser，纯 node 环境可测。
 */
import { readFile } from 'fs/promises'
import { fileURLToPath } from 'url'
import { parsePdfBuffer } from './file-parser'

// PDF 正文缓存：key=去掉 hash 的 url，容量 5（超出删最旧），含负缓存（仅 note）防反复取。
// at=写入时间戳；transient=true 才受下面的 TTL 约束（网络/超时类失败，换个时机可能就好了）——
// 确定性结论（扫描版/超限/魔数不符/解析失败）与 text 一样永不过期，同样的字节/同样的静态
// 属性重试也不会有不同结果，没必要每 60s 重新整份下载+解析（扫描版恰是最贵的一类）。
const pdfTextCache = new Map<string, { text?: string; note?: string; at?: number; transient?: boolean }>()
const PDF_CACHE_CAP = 5
const PDF_TEXT_CAP = 200_000
const PDF_FETCH_MAX_BYTES = 30 * 1024 * 1024
const PDF_FETCH_TIMEOUT_MS = 10_000
// 负缓存 TTL：一次网络抖动/超时不该长期钉死同一 url——60s 后允许下一次触发重新尝试。
const PDF_NEGATIVE_TTL_MS = 60_000

// 解析中标记：resolvePdfIntoCache 的慢路径（网络/读盘/CPU 解析）进行中的 key 集合。双重用途：
// ①去重并发——负缓存过期瞬间可能有多个 /context 同时命中同一 key，只留一个真正发请求/解析；
// ②供 fillPdfPageContentFromCache 在缓存未命中但解析正在进行时给模型一句"稍后再试"的证据，
// 而不是只吐标题+URL，让模型在 H1"先响应后台解析"的窗口期里误判"读不到"。
const pdfPending = new Set<string>()

/** url 是否形似 PDF：按 pathname 判断后缀；URL 解析失败（畸形串/相对路径）退化为全串正则。 */
export function isPdfLikeUrl(url: string | undefined): boolean {
  if (!url || typeof url !== 'string') return false
  try {
    return /\.pdf$/i.test(new URL(url).pathname)
  } catch {
    return /\.pdf($|[?#])/i.test(url)
  }
}

/** 缓存 key：去掉 hash（# 及之后），同一文档不同锚点/页码共用一份缓存。非字符串输入返回空串（安全兜底）。 */
export function pdfCacheKey(url: string): string {
  if (typeof url !== 'string') return ''
  const hashIdx = url.indexOf('#')
  return hashIdx === -1 ? url : url.slice(0, hashIdx)
}

/**
 * 写入缓存并按容量淘汰最旧条目（Map 保插入序，重插=移到末尾，天然 LRU）。
 * note-only 写入（没有新 text）且目标 key 已有成功正文时整条跳过——晚到的负缓存信号不该
 * 覆盖已经解析成功的结果（典型场景：带字节的慢解析成功后，另一条无字节请求的 10s 超时
 * 失败晚到；后到的失败视为过期信号，不能反过来否定已成功的正文）。
 */
function setPdfCache(key: string, entry: { text?: string; note?: string; transient?: boolean }): void {
  if (!entry.text && pdfTextCache.get(key)?.text) return
  pdfTextCache.delete(key)
  pdfTextCache.set(key, { ...entry, at: Date.now() })
  while (pdfTextCache.size > PDF_CACHE_CAP) {
    const oldest = pdfTextCache.keys().next().value
    if (oldest === undefined) break
    pdfTextCache.delete(oldest)
  }
}

/**
 * 读取缓存条目，过滤掉已过期的 transient 负缓存（网络/超时类失败超过 TTL 视为未命中，允许重试）；
 * 有正文的条目、以及非 transient 的确定性负缓存（扫描版/超限/魔数不符/解析失败）永不过期。
 */
function getPdfCacheEntry(key: string): { text?: string; note?: string; at?: number; transient?: boolean } | undefined {
  const hit = pdfTextCache.get(key)
  if (!hit) return undefined
  if (!hit.text && hit.transient && hit.at !== undefined && Date.now() - hit.at > PDF_NEGATIVE_TTL_MS) return undefined
  return hit
}

/** 解析结果入缓存：正文过短判为扫描件（无文字层），过长按上限截断并在 note 记录原始总长。 */
function cachePdfText(key: string, rawText: string): void {
  if (rawText.trim().length < 200) {
    setPdfCache(key, { note: '疑似扫描版 PDF（无文字层），建议用 browser_screenshot 配合滚动逐页阅读' })
    return
  }
  if (rawText.length > PDF_TEXT_CAP) {
    setPdfCache(key, { text: rawText.slice(0, PDF_TEXT_CAP), note: `正文超长已截断（原始共 ${rawText.length} 字符，保留前 ${PDF_TEXT_CAP} 字符）` })
    return
  }
  setPdfCache(key, { text: rawText })
}

/**
 * 同步缓存回填：ctx 存在、无 pageContent（空串/缺失）、url 命中缓存 → 有 text 填 pageContent，
 * 有 note 填 contentNote。已有非空 pageContent 时绝不覆盖——这是双写点覆盖的关键防线，
 * 两处调用方（POST /context、resolveAndInjectContext）都必须过一遍这里。
 */
export function fillPdfPageContentFromCache(ctx: any): void {
  if (!ctx || ctx.pageContent || !ctx.url) return
  const key = pdfCacheKey(ctx.url)
  const hit = getPdfCacheEntry(key)
  if (hit) {
    if (hit.text) ctx.pageContent = hit.text
    if (hit.note) ctx.contentNote = hit.note
    return
  }
  // 缓存未命中但解析正在进行（H1"先响应后台解析"留出的窗口期）：给模型一句证据，
  // 别让它只看到标题+URL 就误判"读不到"。
  if (pdfPending.has(key)) ctx.contentNote = 'PDF 正在解析中，请稍后再次调用 read_page_content 获取正文'
}

/** 头 1024 字节含 %PDF- 才认作真 PDF 内容（防登录跳转页/错误页伪装成 .pdf 结尾的 URL）。 */
function looksLikePdfBytes(buf: Buffer): boolean {
  return buf.subarray(0, 1024).includes('%PDF-')
}

/**
 * 异步解析 PDF 入缓存。优先用扩展直传的字节（pdfBase64，带登录态抓取）；没有字节时按 url 兜底：
 * file:// 本地读，http(s) 用桌面端 fetch（不带 cookie，只救公开 PDF）。任何失败都落负缓存（note），
 * 避免 /context 高频触发（切 tab、页面加载、每条消息前）时对同一 url 反复解析/请求。
 */
export async function resolvePdfIntoCache(ctx: any): Promise<void> {
  if (!ctx) return
  // 无论后续走哪条分支/是否提前返回，都不能把字节留在 ctx 上——放在最前面，不依赖后面的
  // 控制流一定能跑到清理那一步（H1 复核后主调用点已提前剥离，这里是防御未来调用方直传的第二道防线）。
  const pdfBase64 = typeof ctx.pdfBase64 === 'string' ? ctx.pdfBase64 : undefined
  delete ctx.pdfBase64

  // 已有正文（DOM 提取成功，或调用方已用 fillPdfPageContentFromCache 从缓存回填）：无需再解析——
  // 避免 .pdf 结尾但实际服务 HTML 阅读器页面的站点被白下载一遍。
  if (ctx.pageContent) return

  if (pdfBase64) {
    const key = ctx.url ? pdfCacheKey(ctx.url) : ''
    // 同 key 缓存已有正文可跳过重复解析（省 CPU）；负缓存/新 url 都会重新解析。
    // 注意：这里不检查 pdfPending 来决定是否跳过——带字节这条路径数据质量更高（真拿到了
    // 字节，可能还带了登录态），不能因为同 key 另一条较弱的 url 兜底路径正在跑就把这次的
    // 解析结果丢掉（url 兜底路径反过来会检查 pdfPending，见下方）。解析期间仍占用 pdfPending，
    // 让 fillPdfPageContentFromCache 在这个窗口里能给出"正在解析中"证据（N2）。
    if (key && !pdfTextCache.get(key)?.text) {
      pdfPending.add(key)
      try {
        const text = await parsePdfBuffer(Buffer.from(pdfBase64, 'base64'))
        cachePdfText(key, text)
      } catch (err: any) {
        // 解析失败：同一字节重解析结果不变，是确定性结论，不设 transient（永不过期）
        setPdfCache(key, { note: `PDF 解析失败：${err?.message || err}` })
      } finally {
        pdfPending.delete(key)
      }
    }
    return
  }

  if (!isPdfLikeUrl(ctx.url)) return
  const key = pdfCacheKey(ctx.url)
  if (getPdfCacheEntry(key)) return // 含未过期负缓存，命中即返回，不重复解析/网络请求
  // 已有同 key 的解析在途就让路——可能是另一个本分支的并发请求（N6 实测同 url 并发 fetch 峰值 3，
  // 这是要消灭的重复），也可能是上面 pdfBase64 分支正在跑（数据质量更高，主动让路更合理）
  if (pdfPending.has(key)) return
  pdfPending.add(key)

  try {
    let buffer: Buffer
    try {
      if (ctx.url.startsWith('file://')) {
        buffer = await readFile(fileURLToPath(ctx.url))
      } else if (/^https?:\/\//i.test(ctx.url)) {
        const res = await fetch(ctx.url, { signal: AbortSignal.timeout(PDF_FETCH_TIMEOUT_MS) })
        if (!res.ok) {
          // meta.pdf==='unavailable' 说明 0.3.11+ 扩展已经带 cookie 试过一轮并失败了——这是桌面端
          // 无 cookie 的第二次兜底尝试，再失败没必要重复建议"升级插件"；否则按状态码区分登录墙 vs 其他错误。
          // HTTP 状态类失败换个时机可能就好了（登录/限流恢复），标 transient 走 60s TTL。
          const note = ctx.meta?.pdf === 'unavailable'
            ? '浏览器插件已带登录态尝试并失败，建议用 browser_screenshot 配合滚动逐屏阅读'
            : (res.status === 401 || res.status === 403)
              ? `PDF 获取失败(HTTP ${res.status})：登录保护的 PDF 需浏览器插件 ≥0.3.11 才能带登录态读取`
              : `PDF 获取失败：文件不存在或服务端错误(HTTP ${res.status})`
          setPdfCache(key, { note, transient: true })
          return
        }
        const lenHeader = Number(res.headers.get('content-length') || 0)
        if (lenHeader > PDF_FETCH_MAX_BYTES) {
          setPdfCache(key, { note: 'PDF 获取失败：文件超过 30MB 上限' }) // 确定性：同一资源大小不会变，不设 transient
          return
        }
        const ab = await res.arrayBuffer()
        if (ab.byteLength > PDF_FETCH_MAX_BYTES) {
          setPdfCache(key, { note: 'PDF 获取失败：文件超过 30MB 上限' })
          return
        }
        buffer = Buffer.from(ab)
        if (!looksLikePdfBytes(buffer)) {
          setPdfCache(key, { note: 'PDF 获取失败：响应内容不是有效 PDF（可能是登录跳转页）' }) // 魔数不符：确定性
          return
        }
      } else {
        return // 非 file:// / http(s) 协议，不处理
      }
    } catch (err: any) {
      // 读盘/网络层失败（超时、连接错误等）：换个时机可能就好了，标 transient 走 60s TTL
      setPdfCache(key, { note: `PDF 获取失败：${err?.message || err}`, transient: true })
      return
    }
    try {
      cachePdfText(key, await parsePdfBuffer(buffer))
    } catch (err: any) {
      // 解析失败：同一字节重解析结果不变，是确定性结论，不设 transient
      setPdfCache(key, { note: `PDF 解析失败：${err?.message || err}` })
    }
  } finally {
    pdfPending.delete(key)
  }
}

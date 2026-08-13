/**
 * PDF 页面正文直读管线 —— isPdfLikeUrl / pdfCacheKey / fillPdfPageContentFromCache 单测。
 * parsePdfBuffer 走 mock：真实 pdf-parse 需要合法 PDF 字节，这里只关心缓存回填的分支逻辑，
 * 用 mock 精确控制返回文本长度（触发"正常正文" vs "疑似扫描版"两条分支）。
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'

vi.mock('../../src/main/file-parser', () => ({
  parsePdfBuffer: vi.fn()
}))

const { parsePdfBuffer } = await import('../../src/main/file-parser')
const { isPdfLikeUrl, pdfCacheKey, fillPdfPageContentFromCache, resolvePdfIntoCache } = await import('../../src/main/pdf-context')

const mockedParse = vi.mocked(parsePdfBuffer)
let seq = 0
const uniqueUrl = (name: string) => `https://example.com/${name}-${Date.now()}-${seq++}.pdf`

describe('isPdfLikeUrl', () => {
  it('pathname 以 .pdf 结尾 → true', () => {
    expect(isPdfLikeUrl('https://example.com/dir/a.pdf')).toBe(true)
  })
  it('大写后缀 + query + hash → true（大小写不敏感、pathname 判断不受 query/hash 干扰）', () => {
    expect(isPdfLikeUrl('https://example.com/A.PDF?x=1#p2')).toBe(true)
  })
  it('非 pdf 页面 → false', () => {
    expect(isPdfLikeUrl('https://example.com/article.html')).toBe(false)
    expect(isPdfLikeUrl('https://example.com/pdf-viewer')).toBe(false)
  })
  it('不可解析串退化为全串正则', () => {
    expect(isPdfLikeUrl('not-a-url-but-ends-with-a.pdf')).toBe(true)
    expect(isPdfLikeUrl('not-a-url-at-all')).toBe(false)
  })
  it('undefined → false', () => {
    expect(isPdfLikeUrl(undefined)).toBe(false)
  })
})

describe('pdfCacheKey', () => {
  it('去掉 hash 及之后部分', () => {
    expect(pdfCacheKey('https://example.com/a.pdf#page=3')).toBe('https://example.com/a.pdf')
  })
  it('无 hash 原样返回（含 query）', () => {
    expect(pdfCacheKey('https://example.com/a.pdf?x=1')).toBe('https://example.com/a.pdf?x=1')
  })
})

describe('fillPdfPageContentFromCache', () => {
  beforeEach(() => {
    mockedParse.mockReset()
  })

  it('命中正缓存 → 填 pageContent，不带 note', async () => {
    const fullText = '正文内容。'.repeat(50) // 250 字符，越过 200 门槛
    mockedParse.mockResolvedValue(fullText)
    const url = uniqueUrl('hit-text')
    await resolvePdfIntoCache({ url, pdfBase64: Buffer.from('fake-pdf-bytes').toString('base64') })

    const ctx: any = { url, pageContent: '' }
    fillPdfPageContentFromCache(ctx)
    expect(ctx.pageContent).toBe(fullText)
    expect(ctx.contentNote).toBeUndefined()
  })

  it('命中负缓存（疑似扫描版）→ 填 note，pageContent 保持空', async () => {
    mockedParse.mockResolvedValue('太短') // trim 后 < 200 字符 → 判为扫描版，落负缓存
    const url = uniqueUrl('hit-note')
    await resolvePdfIntoCache({ url, pdfBase64: Buffer.from('fake-pdf-bytes').toString('base64') })

    const ctx: any = { url, pageContent: '' }
    fillPdfPageContentFromCache(ctx)
    expect(ctx.pageContent).toBe('')
    expect(ctx.contentNote).toContain('扫描版')
  })

  it('未命中缓存 → ctx 原样不动', () => {
    const ctx: any = { url: uniqueUrl('never-cached'), pageContent: '' }
    fillPdfPageContentFromCache(ctx)
    expect(ctx.pageContent).toBe('')
    expect(ctx.contentNote).toBeUndefined()
  })

  it('已有非空 pageContent → 绝不覆盖（即使命中缓存）', async () => {
    mockedParse.mockResolvedValue('正文内容。'.repeat(50))
    const url = uniqueUrl('preserve')
    await resolvePdfIntoCache({ url, pdfBase64: Buffer.from('fake-pdf-bytes').toString('base64') })

    const ctx: any = { url, pageContent: '已有的页面正文' }
    fillPdfPageContentFromCache(ctx)
    expect(ctx.pageContent).toBe('已有的页面正文')
    expect(ctx.contentNote).toBeUndefined()
  })
})

describe('resolvePdfIntoCache 清理 pdfBase64（回归锁）', () => {
  beforeEach(() => {
    mockedParse.mockReset()
  })

  it('解析成功后 ctx 不再持有 pdfBase64', async () => {
    mockedParse.mockResolvedValueOnce('正文内容。'.repeat(50))
    const ctx: any = { url: uniqueUrl('cleanup-ok'), pdfBase64: Buffer.from('fake-pdf-bytes').toString('base64') }
    await resolvePdfIntoCache(ctx)
    expect('pdfBase64' in ctx).toBe(false)
  })

  it('解析抛错时 ctx 依然不再持有 pdfBase64（异常路径也必须清理）', async () => {
    mockedParse.mockRejectedValueOnce(new Error('parse boom'))
    const ctx: any = { url: uniqueUrl('cleanup-fail'), pdfBase64: Buffer.from('fake-pdf-bytes').toString('base64') }
    await resolvePdfIntoCache(ctx)
    expect('pdfBase64' in ctx).toBe(false)
  })
})

describe('setPdfCache 缓存策略（回归锁）', () => {
  beforeEach(() => {
    mockedParse.mockReset()
  })

  it('晚到的 note-only 失败不覆盖已经解析成功的正文（M2）', async () => {
    const url = uniqueUrl('m2-race')
    const fullText = '正文内容。'.repeat(50)

    // 模拟"慢请求"：无字节的 url 兜底路径先发起 fetch，但让它挂起（手动控制何时 resolve）
    let resolveFetch: (v: unknown) => void = () => {}
    const pendingFetch = new Promise((resolve) => { resolveFetch = resolve })
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockReturnValue(pendingFetch as any)
    const slowCall = resolvePdfIntoCache({ url }) // 挂起在 await fetch(...)

    // 与此同时，带字节的另一路请求"抢先"解析成功并写入正文
    mockedParse.mockResolvedValueOnce(fullText)
    await resolvePdfIntoCache({ url, pdfBase64: Buffer.from('fake-pdf-bytes').toString('base64') })

    // 现在让"慢请求"以 401 失败收场——此时 cache 已经有 text 了
    resolveFetch({ ok: false, status: 401 })
    await slowCall
    fetchSpy.mockRestore()

    const ctx: any = { url, pageContent: '' }
    fillPdfPageContentFromCache(ctx)
    expect(ctx.pageContent).toBe(fullText) // text 未被晚到的失败覆盖
  })

  it('容量淘汰：插入 6 个不同 url，最旧的第 1 个被挤出（cap=5）', async () => {
    mockedParse.mockResolvedValue('正文内容。'.repeat(50))
    const urls = Array.from({ length: 6 }, (_, i) => uniqueUrl(`cap-${i}`))
    for (const url of urls) {
      await resolvePdfIntoCache({ url, pdfBase64: Buffer.from('fake-pdf-bytes').toString('base64') })
    }

    const ctxFirst: any = { url: urls[0], pageContent: '' }
    fillPdfPageContentFromCache(ctxFirst)
    expect(ctxFirst.pageContent).toBe('') // 已被淘汰，缓存未命中

    const ctxLast: any = { url: urls[5], pageContent: '' }
    fillPdfPageContentFromCache(ctxLast)
    expect(ctxLast.pageContent).toBe('正文内容。'.repeat(50)) // 最新的还在
  })

  it('正文超过 200k 上限时截断，note 记录原始总长', async () => {
    const longText = 'a'.repeat(200_001) // 刚好越过 PDF_TEXT_CAP=200_000
    mockedParse.mockResolvedValueOnce(longText)
    const url = uniqueUrl('cap-200k')
    await resolvePdfIntoCache({ url, pdfBase64: Buffer.from('fake-pdf-bytes').toString('base64') })

    const ctx: any = { url, pageContent: '' }
    fillPdfPageContentFromCache(ctx)
    expect(ctx.pageContent.length).toBe(200_000)
    expect(ctx.contentNote).toContain('200001') // 原始总长
    expect(ctx.contentNote).toContain('截断')
  })
})

describe('解析中占位 note（N2）', () => {
  beforeEach(() => {
    mockedParse.mockReset()
  })

  it('慢路径进行中时 fillPdfPageContentFromCache 给出"正在解析中"证据，完成后换成真正文', async () => {
    let resolveParse: (t: string) => void = () => {}
    const pendingParse = new Promise<string>((resolve) => { resolveParse = resolve })
    mockedParse.mockReturnValueOnce(pendingParse)

    const url = uniqueUrl('n2-pending')
    const call = resolvePdfIntoCache({ url, pdfBase64: Buffer.from('fake-pdf-bytes').toString('base64') })

    // 解析还没完成（pdfPending 里还留着这个 key）：给出"正在解析中"的证据，而不是什么都不说
    const midCtx: any = { url, pageContent: '' }
    fillPdfPageContentFromCache(midCtx)
    expect(midCtx.contentNote).toContain('正在解析中')
    expect(midCtx.pageContent).toBe('')

    resolveParse('正文内容。'.repeat(50))
    await call

    // 解析完成后应该拿到真正的正文，不再是占位 note
    const doneCtx: any = { url, pageContent: '' }
    fillPdfPageContentFromCache(doneCtx)
    expect(doneCtx.pageContent).toBe('正文内容。'.repeat(50))
  })
})

describe('负缓存 TTL 只对 transient 类生效（N3）', () => {
  beforeEach(() => {
    mockedParse.mockReset()
  })

  it('确定性负缓存（疑似扫描版）超过 60s 也不过期，note 依旧命中', async () => {
    const nowSpy = vi.spyOn(Date, 'now')
    try {
      nowSpy.mockReturnValue(1_000_000)
      mockedParse.mockResolvedValueOnce('太短') // 触发"疑似扫描版"负缓存（非 transient）
      const url = uniqueUrl('n3-deterministic')
      await resolvePdfIntoCache({ url, pdfBase64: Buffer.from('fake-pdf-bytes').toString('base64') })

      nowSpy.mockReturnValue(1_000_000 + 70_000) // 70s 后，越过 60s TTL

      const ctx: any = { url, pageContent: '' }
      fillPdfPageContentFromCache(ctx)
      expect(ctx.contentNote).toContain('扫描版') // 确定性结论，依然命中，没有过期
    } finally {
      nowSpy.mockRestore()
    }
  })
})

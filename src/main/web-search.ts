import { net } from 'electron'
import { getEffectiveSearchConfig } from './config-manager'

interface SearchResult {
  title: string
  url: string
  snippet: string
}

/**
 * 搜索结果 —— 区分「成功(可能零命中)」和「硬失败(没 key / 网络 / HTTP / 解析)」。
 * 历史教训:旧实现把所有失败吞成 [],配置问题伪装成"零命中",模型只能脑补失败原因、
 * 日志里也查不到错误。保留可区分性,让上层如实告诉用户"搜索不可用"。
 */
export type SearchOutcome =
  | { ok: true; results: SearchResult[] }
  | { ok: false; reason: 'no_key' | 'request_failed' | 'http_error' | 'bad_response'; detail: string }

/** 单次 Tavily 检索。key 由调用方给——生效配置或设置页正在测试的临时值。 */
function runTavilySearch(apiKey: string, query: string, maxResults: number): Promise<SearchOutcome> {
  return new Promise((resolve) => {
    const request = net.request({
      url: 'https://api.tavily.com/search',
      method: 'POST'
    })
    request.setHeader('Content-Type', 'application/json')

    const body = JSON.stringify({
      api_key: apiKey,
      query,
      max_results: maxResults
    })

    let responseBody = ''
    let statusCode = 0
    request.on('response', (response) => {
      statusCode = response.statusCode || 0
      response.on('data', (chunk) => {
        responseBody += chunk.toString()
      })
      response.on('end', () => {
        // 非 2xx —— 401(key 无效)/429/432(限额)等。带状态码 + 截断响应体进日志,便于排查
        if (statusCode < 200 || statusCode >= 300) {
          console.error(`[web-search] Tavily HTTP ${statusCode}: ${responseBody.slice(0, 200)}`)
          resolve({ ok: false, reason: 'http_error', detail: `HTTP ${statusCode}` })
          return
        }
        try {
          const data = JSON.parse(responseBody)
          const results: SearchResult[] = (data.results || []).map(
            (r: { title?: string; url?: string; content?: string }) => ({
              title: r.title || '',
              url: r.url || '',
              snippet: r.content || ''
            })
          )
          resolve({ ok: true, results })
        } catch (err) {
          console.error('[web-search] Tavily 响应解析失败:', (err as Error)?.message, responseBody.slice(0, 200))
          resolve({ ok: false, reason: 'bad_response', detail: '响应解析失败' })
        }
      })
    })
    request.on('error', (err) => {
      console.error('[web-search] Tavily 请求失败:', err?.message)
      resolve({ ok: false, reason: 'request_failed', detail: err?.message || '网络错误' })
    })
    request.write(body)
    request.end()
  })
}

export async function webSearch(query: string, maxResults = 5): Promise<SearchOutcome> {
  // 每次调用现读配置:用户在设置页改完 key,下一次搜索即生效,不需重启
  const apiKey = getEffectiveSearchConfig().apiKey
  if (!apiKey) {
    console.error('[web-search] 未配置搜索服务(用户配置与内置回退均为空)—— 搜索不可用')
    return { ok: false, reason: 'no_key', detail: '未配置搜索服务' }
  }
  return runTavilySearch(apiKey, query, maxResults)
}

/**
 * 设置页的连通性测试。
 * apiKey 可传设置页里还没保存的临时值;不传则用生效配置。
 * 返回只有成败与本进程自造的 errorKey —— key 无论如何不回显。
 */
export async function testSearchConnection(
  apiKey?: string
): Promise<{ ok: boolean; errorKey?: string; errorParams?: Record<string, string> }> {
  const key = (apiKey || '').trim() || getEffectiveSearchConfig().apiKey
  if (!key) return { ok: false, errorKey: 'settings.search.errors.missingApiKey' }

  const outcome = await runTavilySearch(key, 'OpenPipal search connectivity check', 1)
  if (outcome.ok) return { ok: true }
  switch (outcome.reason) {
    case 'http_error':
      return { ok: false, errorKey: 'settings.search.errors.httpError', errorParams: { detail: outcome.detail } }
    case 'request_failed':
      return { ok: false, errorKey: 'settings.search.errors.requestFailed', errorParams: { detail: outcome.detail } }
    default:
      return { ok: false, errorKey: 'settings.search.errors.badResponse' }
  }
}

export function formatSearchResults(outcome: SearchOutcome): string {
  if (!outcome.ok) {
    // 硬失败 —— 明确告诉模型工具不可用,禁止编造检索结果/失败原因(否则会瞎说"检索源受限")
    const hint =
      outcome.reason === 'no_key'
        ? '未配置搜索服务——在 设置 → 搜索服务 里填入你的 Tavily API Key。'
        : `搜索服务暂不可用(${outcome.detail})。`
    return `${hint}请如实告知用户当前无法联网搜索,不要编造检索结果或失败原因。`
  }
  if (outcome.results.length === 0) return '未找到相关搜索结果。'

  return outcome.results
    .map((r, i) => `${i + 1}. **${r.title}**\n   ${r.url}\n   ${r.snippet}`)
    .join('\n\n')
}

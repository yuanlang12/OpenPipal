/**
 * 向服务商本人要一份模型清单。
 *
 * 为什么是我们写而不是 Pi 提供：pi-ai 只给了机制（createProvider({ fetchModels })），
 * 0.84.1 里没有任何内置 provider 用它——pi 自己的编码 agent 走的是另一条路，每 4 小时
 * 带 ETag 去 https://pi.dev/api/models/providers/{id} 刷新它那份静态目录
 * （pi-coding-agent/core/remote-catalog-provider.js），刷的是"目录"，不是"这把 key 能用什么"。
 * 后者只有服务商自己知道，所以这一段是我们的活。
 *
 * 分工沿用目录那套：**远端决定"有哪些"，Pi 目录决定"是什么"**。
 * 远端 /models 的标准 schema 只有 id，能力位基本靠不住；命中 Pi 目录的 id 一律借目录的
 * 元数据（当前服务商优先，其次跨服务商一致才借——同一个 id 在多家目录里打架时不猜）。
 * 远端自带的扩展字段（OpenRouter 的 architecture/supported_parameters、vLLM 的
 * max_model_len 等）只在目录没有时兜底。
 *
 * 拿不到清单不是错误路径：大量网关根本没实现 /models。失败一律退回目录 + 手填。
 */

import type { ModelConfig } from './config-manager'
import { getProviders } from './config-manager'
import { pickWindow } from './context-window-detector'

export interface RemoteModelEntry {
  id: string
  name?: string
  reasoning?: boolean
  image?: boolean
  contextWindow?: number
  /** true = Pi 目录里有同名 id，能力位来自目录；false = 纯远端 id，能力位得用户自己确认 */
  known?: boolean
}

export interface RemoteModelListResult {
  ok: boolean
  models: RemoteModelEntry[]
  /** 失败原因的 i18n key（本进程自造文案，网关原文不经这里） */
  errorKey?: string
  errorParams?: Record<string, string>
}

const TIMEOUT_MS = 8000

function fail(errorKey: string, errorParams?: Record<string, string>): RemoteModelListResult {
  return { ok: false, models: [], errorKey, ...(errorParams ? { errorParams } : {}) }
}

/** OpenRouter 风格的能力位；其它网关没有这些字段就返回 undefined，交给目录 */
function sniffCapabilities(entry: Record<string, any>): { reasoning?: boolean; image?: boolean } {
  const out: { reasoning?: boolean; image?: boolean } = {}
  if (Array.isArray(entry.architecture?.input_modalities)) {
    out.image = entry.architecture.input_modalities.includes('image')
  }
  if (Array.isArray(entry.supported_parameters)) {
    out.reasoning = entry.supported_parameters.includes('reasoning') || entry.supported_parameters.includes('reasoning_effort')
  }
  return out
}

/** 各家返回体的三种形状：{data:[]} / {models:[]} / 裸数组 */
function extractEntries(payload: unknown): Record<string, any>[] | null {
  if (Array.isArray(payload)) return payload as Record<string, any>[]
  if (payload && typeof payload === 'object') {
    const obj = payload as Record<string, any>
    if (Array.isArray(obj.data)) return obj.data
    if (Array.isArray(obj.models)) return obj.models
  }
  return null
}

function projectCatalogModel(model: { id: string; name?: string; reasoning?: boolean; image?: boolean; contextWindow?: number }): RemoteModelEntry {
  return { id: model.id, name: model.name, reasoning: model.reasoning, image: model.image, contextWindow: model.contextWindow }
}

/** id → 目录元数据。同一 id 出现在多家目录且元数据打架时，该字段不借。 */
let catalogIndex: Map<string, RemoteModelEntry | null> | null = null
function getCatalogIndex(): Map<string, RemoteModelEntry | null> {
  if (catalogIndex) return catalogIndex
  const index = new Map<string, RemoteModelEntry | null>()
  for (const entry of Object.values(getProviders())) {
    for (const model of entry.models) {
      const prev = index.get(model.id)
      if (prev === undefined) {
        index.set(model.id, projectCatalogModel(model))
        continue
      }
      if (prev === null) continue
      const same =
        prev.reasoning === model.reasoning &&
        prev.image === model.image &&
        prev.contextWindow === model.contextWindow
      if (!same) index.set(model.id, null)  // 打架 → 不猜
    }
  }
  catalogIndex = index
  return index
}

/**
 * 协议从哪来：apiFormat 只在 provider==='custom' 时有值（handleProviderChange 会把目录
 * 服务商的它按回 'openai'），所以目录服务商必须问目录。少了这一步，内置 anthropic 会被
 * 当成 OpenAI 兼容去打 /models + Bearer——最显眼的那家反而报"不提供模型列表"。
 */
type Protocol = 'openai' | 'anthropic' | 'unsupported'
function resolveProtocol(mc: ModelConfig): Protocol {
  if (mc.apiFormat === 'anthropic') return 'anthropic'
  if (mc.apiFormat) return 'openai'  // 'openai' / 'openai-responses' 的 /models 形状同源
  const api = mc.provider ? getProviders()[mc.provider]?.api : undefined
  if (!api) return 'openai'
  if (api === 'anthropic-messages') return 'anthropic'
  if (api.startsWith('openai-')) return 'openai'
  // google-generative-ai 等：列举端点的鉴权方式都不一样，与其发一个必然被拒的请求，
  // 不如直接说这家不支持——错误提示才不会把"协议不对"说成"key 不被接受"
  return 'unsupported'
}

function errorKeyForStatus(status: number): string {
  if (status === 401 || status === 403) return 'settings.model.errors.remoteModelsUnauthorized'
  if (status === 404 || status === 405 || status === 501) return 'settings.model.errors.remoteModelsUnsupported'
  return 'settings.model.errors.remoteModelsFailed'
}

/**
 * 列举远端模型。Anthropic 格式的地址约定与 OpenAI 兼容协议相反（根地址不带 /v1，
 * SDK 自己拼），所以这里同样要分叉——和 testConnection 里那条排除规则同源。
 */
export async function listRemoteModels(mc: ModelConfig): Promise<RemoteModelListResult> {
  const base = (mc.baseUrl || '').trim().replace(/\/+$/, '')
  if (!base) return fail('settings.model.errors.remoteModelsFailed')

  const protocol = resolveProtocol(mc)
  if (protocol === 'unsupported') return fail('settings.model.errors.remoteModelsUnsupported')

  const anthropic = protocol === 'anthropic'
  const url = anthropic ? `${base}/v1/models?limit=1000` : `${base}/models`
  const headers: Record<string, string> = { accept: 'application/json' }
  if (mc.apiKey) {
    if (anthropic) {
      headers['x-api-key'] = mc.apiKey
      headers['anthropic-version'] = '2023-06-01'
    } else {
      headers.Authorization = `Bearer ${mc.apiKey}`
    }
  }

  let payload: unknown
  try {
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) })
    if (!res.ok) return fail(errorKeyForStatus(res.status))
    // 网关把 SPA 的 catch-all 当成 API 返回（HTTP 200 + text/html）是实测过的场景，
    // 不看 content-type 会把一篇 HTML 解析成"零个模型"。判词沿用连接测试那条：
    // 真正的原因通常是 baseUrl 少了 /v1，而不是"这家不提供列表"
    const contentType = (res.headers.get('content-type') || '').toLowerCase()
    if (contentType && !contentType.includes('json')) {
      return fail('settings.model.errors.nonApiResponse', { baseUrl: mc.baseUrl })
    }
    payload = await res.json()
  } catch {
    return fail('settings.model.errors.remoteModelsFailed')
  }

  const entries = extractEntries(payload)
  if (!entries) return fail('settings.model.errors.remoteModelsUnsupported')

  // 当前服务商自己的目录永远优先于跨服务商的一致性推断；先建索引，免得每条远端 id
  // 都在几百个目录条目里线性找一遍（openrouter 一家就是 400 × 300 次比较）
  const own = new Map((mc.provider ? getProviders()[mc.provider]?.models ?? [] : []).map((m) => [m.id, m]))
  const seen = new Set<string>()
  const models: RemoteModelEntry[] = []
  for (const entry of entries) {
    const id = typeof entry?.id === 'string' ? entry.id : ''
    if (!id || seen.has(id)) continue
    seen.add(id)
    const ownModel = own.get(id)
    const meta = ownModel ? projectCatalogModel(ownModel) : getCatalogIndex().get(id) ?? undefined
    const sniffed = sniffCapabilities(entry)
    models.push({
      id,
      name: meta?.name || (typeof entry.display_name === 'string' ? entry.display_name : undefined),
      reasoning: meta?.reasoning ?? sniffed.reasoning,
      image: meta?.image ?? sniffed.image,
      contextWindow: meta?.contextWindow ?? (pickWindow(entry) || pickWindow(entry.model_info) || undefined),
      known: !!meta
    })
  }

  if (models.length === 0) return fail('settings.model.errors.remoteModelsUnsupported')
  return { ok: true, models }
}

/**
 * 上下文窗口自动检测——"不自己维护"的阶梯（2026-07-03 对用户真机网关实测校准）：
 *
 * 1. litellm 网关 `/model/info`：有 max_input_tokens 等完整信息，但默认仅管理员 key
 *    放行（用户网关实测 403）——能通就用，403 静默降级
 * 2. `{base}/models` 的扩展字段：OpenAI 标准 schema 不含窗口，但 OpenRouter 带
 *    context_length、vLLM 带 max_model_len、部分网关带 model_info——逐字段嗅探
 * 3. pi 内置模型注册表按 id 精确匹配（大厂模型名直接命中）
 *
 * 全部落空 → 返回 null，压缩器按 131072 保守默认；用户可在模型设置手填覆盖。
 * 优先级：手填 > 检测 > 默认。
 */

import type { ModelConfig } from './config-manager'
// 静态 import 走 electron-vite 内联（externalizeDepsPlugin exclude 列表），
// 不能用运行时 require——那会迫使整个 pi-ai 包（44MB）随包分发
import { getProviders as piGetProviders, getModels as piGetModels } from '@earendil-works/pi-ai/compat'

export interface ContextWindowDetection {
  window: number
  source: string
}

async function fetchJson(url: string, apiKey?: string): Promise<any | null> {
  try {
    const res = await fetch(url, {
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : undefined,
      signal: AbortSignal.timeout(8000)
    })
    if (!res.ok) return null
    return await res.json()
  } catch {
    return null
  }
}

function pickWindow(info: any): number {
  if (!info || typeof info !== 'object') return 0
  const w = info.max_input_tokens || info.context_length || info.max_model_len || info.context_window
  return typeof w === 'number' && w > 0 ? w : 0
}

export async function detectContextWindow(mc: ModelConfig): Promise<ContextWindowDetection | null> {
  const base = (mc.baseUrl || '').replace(/\/+$/, '')
  if (base && mc.model) {
    const root = base.endsWith('/v1') ? base.slice(0, -3) : base
    // model/info（root===base 时去重）与 /models 并行发起，结果仍按原优先级取用
    const infoUrls = Array.from(new Set([`${root}/model/info`, `${base}/model/info`]))
    const settled = await Promise.allSettled([
      ...infoUrls.map((u) => fetchJson(u, mc.apiKey)),
      fetchJson(`${base}/models`, mc.apiKey)
    ])
    const data = settled.map((s) => (s.status === 'fulfilled' ? s.value : null))
    const modelsData = data[data.length - 1]
    // 1) litellm /model/info（按 URL 原顺序取用）
    for (const d of data.slice(0, infoUrls.length)) {
      for (const e of d?.data || []) {
        if ((e.model_name || e.id) === mc.model) {
          const w = pickWindow(e.model_info) || pickWindow(e)
          if (w) return { window: w, source: '网关 model/info' }
        }
      }
    }
    // 2) /models 扩展字段（OpenRouter / vLLM / 部分网关）
    for (const e of modelsData?.data || []) {
      if (e.id === mc.model) {
        const w = pickWindow(e) || pickWindow(e.model_info)
        if (w) return { window: w, source: '模型列表元数据' }
      }
    }
  }
  // 3) pi 内置注册表按 id 匹配
  try {
    const rawProviders = (piGetProviders() as any[]) || []
    const providers: string[] = rawProviders.map((p: any) => (typeof p === 'string' ? p : p?.id)).filter(Boolean)
    for (const prov of providers) {
      let models: any[] = []
      try { models = (piGetModels(prov as any) as any[]) || [] } catch { continue }
      for (const m of models) {
        if (m?.id === mc.model && typeof m.contextWindow === 'number' && m.contextWindow > 0) {
          return { window: m.contextWindow, source: `内置注册表 (${prov})` }
        }
      }
    }
  } catch { /* 注册表不可用就算了 */ }
  return null
}

/**
 * 上下文窗口自动检测——"不自己维护"的阶梯（2026-07-03 对用户真机网关实测校准）：
 *
 * 1. litellm 网关 `/model/info`：有 max_input_tokens 等完整信息，但默认仅管理员 key
 *    放行（用户网关实测 403）——能通就用，403 静默降级
 * 2. 服务商自己的模型清单（listRemoteModels）：标准 schema 不含窗口，但 OpenRouter 带
 *    context_length、vLLM 带 max_model_len、部分网关带 model_info
 * 3. Pi 目录按 id 精确匹配（大厂模型名直接命中）
 *
 * 全部落空 → 返回 null，压缩器按 131072 保守默认；用户可在模型设置手填覆盖。
 * 优先级：手填 > 检测 > 默认。
 *
 * 第 2、3 步都交给 remote-model-list：那边本来就在打同一个 `{base}/models`，而且认
 * 三种返回形状、按协议分叉鉴权、挡得住网关返回 HTML 的假成功。这里再抄一份的下场
 * 已经见过——两份字段名单分叉、`{models:[]}` 的网关上检测静默失败。
 */

import type { ModelConfig } from './config-manager'
import { listRemoteModels, catalogMetaFor, pickWindow } from './remote-model-list'

export interface ContextWindowDetection {
  window: number
  source: string
}

/** litellm 的 /model/info 是本模块独有的一步，其余请求都在 remote-model-list 里 */
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

export async function detectContextWindow(mc: ModelConfig): Promise<ContextWindowDetection | null> {
  const base = (mc.baseUrl || '').replace(/\/+$/, '')
  if (base && mc.model) {
    const root = base.endsWith('/v1') ? base.slice(0, -3) : base
    // model/info（root===base 时去重）与模型清单并行发起，结果仍按原优先级取用
    const infoUrls = Array.from(new Set([`${root}/model/info`, `${base}/model/info`]))
    const [infoResults, remote] = await Promise.all([
      Promise.all(infoUrls.map((u) => fetchJson(u, mc.apiKey))),
      listRemoteModels(mc).catch(() => null)
    ])

    // 1) litellm /model/info（按 URL 原顺序取用）
    for (const d of infoResults) {
      for (const e of d?.data || []) {
        if ((e.model_name || e.id) === mc.model) {
          const w = pickWindow(e.model_info) || pickWindow(e)
          if (w) return { window: w, source: '网关 model/info' }
        }
      }
    }

    // 2) 模型清单里的这一条。窗口的出处由清单自己标注：端点报的算"模型列表元数据"，
    //    端点没报、借的目录值算"内置注册表"——两者优先级也由那边统一决定
    const entry = remote?.models.find((m) => m.id === mc.model)
    if (entry?.contextWindow) {
      return {
        window: entry.contextWindow,
        source: entry.contextWindowSource === 'catalog' ? '内置注册表' : '模型列表元数据'
      }
    }
  }

  // 3) 清单整体不可用（网关没实现 /models、协议不支持列举、离线）时的目录兜底
  const meta = catalogMetaFor(mc.provider, mc.model)
  if (meta?.contextWindow) return { window: meta.contextWindow, source: '内置注册表' }
  return null
}

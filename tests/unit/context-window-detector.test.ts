/**
 * 上下文窗口检测（2026-08-16 收编）。
 *
 * 从前它自己打一遍 `{base}/models`、自己抄一份窗口字段名单、再自己线性重扫一遍 pi
 * 注册表。代价不是"重复"，是**重复且更弱**：它只认 `{data:[]}`，于是 `{models:[]}`
 * 或裸数组的网关上，检测静默失败而模型选择器工作正常——同一个端点，两个答案。
 * 现在第 2、3 步都交给 remote-model-list，本文件只留 litellm 的 /model/info。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { detectContextWindow } from '../../src/main/context-window-detector'
import { getProviders } from '../../src/main/config-manager'

const catalogGpt5 = getProviders().openai.models.find((m) => m.id === 'gpt-5')

function json(body: unknown, contentType = 'application/json'): any {
  return {
    ok: true,
    status: 200,
    headers: { get: (k: string) => (k.toLowerCase() === 'content-type' ? contentType : null) },
    json: async () => body
  }
}
const notFound: any = { ok: false, status: 404, headers: { get: () => null }, json: async () => ({}) }

let fetchMock: ReturnType<typeof vi.fn>
/** 按 URL 路由：/model/info 与 /models 是并行发出的两类请求 */
function route(map: { info?: unknown; models?: unknown }) {
  fetchMock.mockImplementation(async (url: string) => {
    if (url.includes('/model/info')) return map.info === undefined ? notFound : json(map.info)
    if (url.includes('/models')) return map.models === undefined ? notFound : json(map.models)
    return notFound
  })
}

beforeEach(() => {
  fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => vi.unstubAllGlobals())

describe('检测阶梯', () => {
  it('litellm 的 /model/info 优先于模型清单', async () => {
    route({
      info: { data: [{ model_name: 'gw-model', model_info: { max_input_tokens: 262144 } }] },
      models: { data: [{ id: 'gw-model', context_length: 8192 }] }
    })
    expect(await detectContextWindow({ provider: 'custom', baseUrl: 'https://gw.example.com/v1', apiKey: 'k', model: 'gw-model' } as any))
      .toEqual({ window: 262144, source: '网关 model/info' })
  })

  it('{models:[]} 形状的网关不再静默失败——这是收编前真会漏的那一类', async () => {
    route({ models: { models: [{ id: 'gw-model', max_model_len: 32768 }] } })
    expect(await detectContextWindow({ provider: 'custom', baseUrl: 'https://gw.example.com/v1', apiKey: 'k', model: 'gw-model' } as any))
      .toEqual({ window: 32768, source: '模型列表元数据' })
  })

  it('裸数组同理', async () => {
    route({ models: [{ id: 'gw-model', context_length: 65536 }] })
    expect(await detectContextWindow({ provider: 'custom', baseUrl: 'https://gw.example.com/v1', apiKey: 'k', model: 'gw-model' } as any))
      .toEqual({ window: 65536, source: '模型列表元数据' })
  })

  it('端点自己报的窗口压过目录——同一模型在不同网关上可能被截短', async () => {
    route({ models: { data: [{ id: 'gpt-5', context_length: 128000 }] } })
    expect(await detectContextWindow({ provider: 'openai', baseUrl: 'https://api.openai.com/v1', apiKey: 'k', model: 'gpt-5' } as any))
      .toEqual({ window: 128000, source: '模型列表元数据' })
  })

  it('端点只列 id 不给窗口时，借目录的值并如实标注来源', async () => {
    route({ models: { data: [{ id: 'gpt-5' }] } })
    expect(await detectContextWindow({ provider: 'openai', baseUrl: 'https://api.openai.com/v1', apiKey: 'k', model: 'gpt-5' } as any))
      .toEqual({ window: catalogGpt5!.contextWindow, source: '内置注册表' })
  })

  it('网关根本不提供清单时退回目录兜底', async () => {
    route({})  // 两类请求都 404
    expect(await detectContextWindow({ provider: 'openai', baseUrl: 'https://api.openai.com/v1', apiKey: 'k', model: 'gpt-5' } as any))
      .toEqual({ window: catalogGpt5!.contextWindow, source: '内置注册表' })
  })

  it('全落空返回 null，交给压缩器的保守默认', async () => {
    route({})
    expect(await detectContextWindow({ provider: 'custom', baseUrl: 'https://gw.example.com/v1', apiKey: 'k', model: 'nobody-knows-this' } as any))
      .toBeNull()
  })

  it('地址为空时不发请求，直接问目录', async () => {
    route({})
    expect(await detectContextWindow({ provider: 'openai', baseUrl: '', apiKey: 'k', model: 'gpt-5' } as any))
      .toEqual({ window: catalogGpt5!.contextWindow, source: '内置注册表' })
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

/**
 * 向服务商本人要模型清单（2026-08-16）。
 *
 * 分工：远端决定"有哪些"，Pi 目录决定"是什么"。远端 /models 的标准 schema 只有 id，
 * 能力位靠不住；所以命中目录的 id 一律借目录元数据，目录外的 id 老实标记 known:false
 * 交回用户确认——猜错 supportsImages 会让网关吃 400，这一条和目录路径同源。
 *
 * 这里对着**真实的 Pi 目录**验合并（只 stub fetch），元数据断言全部相对目录取值，
 * 免得 pi 升级换了窗口大小就红一片。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { listRemoteModels } from '../../src/main/remote-model-list'
import { getProviders } from '../../src/main/config-manager'

const catalogGpt5 = getProviders().openai.models.find((m) => m.id === 'gpt-5')

function jsonResponse(body: unknown, init?: { status?: number; contentType?: string }): any {
  return {
    ok: (init?.status ?? 200) < 400,
    status: init?.status ?? 200,
    headers: { get: (k: string) => (k.toLowerCase() === 'content-type' ? (init?.contentType ?? 'application/json') : null) },
    json: async () => body
  }
}

let fetchMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => vi.unstubAllGlobals())

describe('远端清单 × Pi 目录', () => {
  it('OpenAI 兼容：打 {base}/models，带 Bearer', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ object: 'list', data: [{ id: 'gpt-5' }] }))
    await listRemoteModels({ provider: 'openai', baseUrl: 'https://api.openai.com/v1/', apiKey: 'sk-x', model: '' } as any)

    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://api.openai.com/v1/models')
    expect(init.headers.Authorization).toBe('Bearer sk-x')
  })

  it('命中目录的 id 借目录元数据，known 为真', async () => {
    expect(catalogGpt5).toBeDefined()
    fetchMock.mockResolvedValue(jsonResponse({ data: [{ id: 'gpt-5' }] }))
    const result = await listRemoteModels({ provider: 'openai', baseUrl: 'https://api.openai.com/v1', apiKey: 'sk-x', model: '' } as any)

    expect(result.ok).toBe(true)
    expect(result.models[0]).toMatchObject({
      id: 'gpt-5',
      known: true,
      reasoning: catalogGpt5!.reasoning,
      image: catalogGpt5!.image,
      contextWindow: catalogGpt5!.contextWindow
    })
  })

  it('目录外的 id 不猜能力位，只标 known:false', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ data: [{ id: 'internal-preview-o9' }] }))
    const result = await listRemoteModels({ provider: 'openai', baseUrl: 'https://api.openai.com/v1', apiKey: 'sk-x', model: '' } as any)

    expect(result.models[0]).toEqual({
      id: 'internal-preview-o9',
      name: undefined,
      reasoning: undefined,
      image: undefined,
      contextWindow: undefined,
      known: false
    })
  })

  it('目录没有时才用远端自己的扩展字段兜底（OpenRouter / vLLM 那套）', async () => {
    fetchMock.mockResolvedValue(jsonResponse({
      data: [{
        id: 'some-gateway-model',
        context_length: 262144,
        architecture: { input_modalities: ['text', 'image'] },
        supported_parameters: ['reasoning', 'temperature']
      }]
    }))
    const result = await listRemoteModels({ provider: 'custom', baseUrl: 'https://gw.example.com/v1', apiKey: 'k', model: '' } as any)

    expect(result.models[0]).toMatchObject({
      id: 'some-gateway-model',
      contextWindow: 262144,
      image: true,
      reasoning: true,
      known: false
    })
  })

  it('目录服务商的协议问目录，不问 apiFormat——后者只在 custom 下有值', async () => {
    // 内置 anthropic 走的是 anthropic-messages；少了这一步它会被当成 OpenAI 兼容，
    // 打 /models + Bearer，最显眼的那家反而报"不提供模型列表"
    fetchMock.mockResolvedValue(jsonResponse({ data: [{ id: 'claude-opus-4-7' }] }))
    await listRemoteModels({ provider: 'anthropic', baseUrl: 'https://api.anthropic.com', apiKey: 'sk-ant', model: '' } as any)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://api.anthropic.com/v1/models?limit=1000')
    expect(init.headers['x-api-key']).toBe('sk-ant')
  })

  it('协议我们不会列举的（google 那套鉴权不同）直接说不支持，不发必然被拒的请求', async () => {
    const result = await listRemoteModels({ provider: 'google', baseUrl: 'https://generativelanguage.googleapis.com/v1beta', apiKey: 'k', model: '' } as any)
    expect(result.errorKey).toBe('settings.model.errors.remoteModelsUnsupported')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('Anthropic 格式的地址约定相反：根地址 + /v1/models，用 x-api-key', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ data: [{ id: 'claude-x', display_name: 'Claude X' }] }))
    const result = await listRemoteModels({ provider: 'custom', apiFormat: 'anthropic', baseUrl: 'https://gw.example.com', apiKey: 'sk-ant', model: '' } as any)

    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://gw.example.com/v1/models?limit=1000')
    expect(init.headers['x-api-key']).toBe('sk-ant')
    expect(init.headers['anthropic-version']).toBe('2023-06-01')
    expect(result.models[0].name).toBe('Claude X')
  })

  it('{models:[]} 和裸数组两种形状都认', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ models: [{ id: 'a' }, { id: 'a' }, { id: 'b' }] }))
    const wrapped = await listRemoteModels({ provider: 'custom', baseUrl: 'https://gw.example.com/v1', apiKey: 'k', model: '' } as any)
    expect(wrapped.models.map((m) => m.id)).toEqual(['a', 'b'])  // 顺带去重

    fetchMock.mockResolvedValue(jsonResponse([{ id: 'c' }]))
    const bare = await listRemoteModels({ provider: 'custom', baseUrl: 'https://gw.example.com/v1', apiKey: 'k', model: '' } as any)
    expect(bare.models.map((m) => m.id)).toEqual(['c'])
  })
})

describe('拿不到清单不是错误路径', () => {
  it('401/403 说 key 没被接受，404/405/501 说这家不提供', async () => {
    fetchMock.mockResolvedValue(jsonResponse({}, { status: 401 }))
    expect((await listRemoteModels({ baseUrl: 'https://x/v1', apiKey: 'k' } as any)).errorKey)
      .toBe('settings.model.errors.remoteModelsUnauthorized')

    fetchMock.mockResolvedValue(jsonResponse({}, { status: 404 }))
    expect((await listRemoteModels({ baseUrl: 'https://x/v1', apiKey: 'k' } as any)).errorKey)
      .toBe('settings.model.errors.remoteModelsUnsupported')
  })

  it('HTTP 200 + text/html 判词沿用连接测试那条：缺 /v1，而不是"这家不提供列表"', async () => {
    fetchMock.mockResolvedValue(jsonResponse('<!doctype html><html></html>', { contentType: 'text/html' }))
    const result = await listRemoteModels({ baseUrl: 'https://x', apiKey: 'k' } as any)
    expect(result.ok).toBe(false)
    expect(result.errorKey).toBe('settings.model.errors.nonApiResponse')
    expect(result.errorParams).toEqual({ baseUrl: 'https://x' })
  })

  it('网络抛错、地址为空都安静失败，不抛给调用方', async () => {
    fetchMock.mockRejectedValue(new Error('ECONNREFUSED'))
    expect((await listRemoteModels({ baseUrl: 'https://x/v1', apiKey: 'k' } as any)).ok).toBe(false)
    expect((await listRemoteModels({ baseUrl: '', apiKey: 'k' } as any)).ok).toBe(false)
    expect(fetchMock).toHaveBeenCalledTimes(1)  // 空地址根本不发请求
  })
})

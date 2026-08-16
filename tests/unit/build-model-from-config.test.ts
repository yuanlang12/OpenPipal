/**
 * buildModelFromConfig（config-manager.ts）—— custom provider 的 Anthropic /v1/messages
 * 及 OpenAI Responses /v1/responses 接入 + 消灭"未知 model id 静默换成另一个模型"的断点。
 *
 * 背景：
 * 1. custom + apiFormat==='anthropic' 应该走 Anthropic Messages 协议模板（createCustomAnthropicModel），
 *    custom + apiFormat==='openai-responses' 应该走 OpenAI Responses 协议模板（createCustomResponsesModel），
 *    apiFormat 未填/'openai' 时逐字节保持原有 OpenAI 兼容 completions 行为。
 * 2. 已知 provider（如官方 'anthropic'）遇到 Pi 内置表里没有的 model id 时，绝不能偷偷换成
 *    piGetModels(provider)[0] 这种跟用户输入毫不相干的模型——用户会以为在跟 A 对话实际发给了 B。
 *    实测 @earendil-works/pi-ai 当前版本的 getModel() 对未知 id 返回 undefined、不抛错，
 *    历史实现的 try/catch 回落 models[0] 分支其实是死代码（永远走不到 catch）。
 */
import { describe, it, expect } from 'vitest'
import {
  adaptModelRequestPayload,
  buildModelFromConfig,
  resolveThinkingFormat,
  type ModelConfig
} from '../../src/main/config-manager'
import { getModels as piGetModels } from '@earendil-works/pi-ai/compat'

function baseConfig(overrides: Partial<ModelConfig>): ModelConfig {
  return { provider: 'custom', baseUrl: 'https://gateway.example.com', apiKey: 'sk-test', model: 'placeholder', ...overrides }
}

describe('buildModelFromConfig — custom provider 的 apiFormat 分流', () => {
  it("custom + apiFormat='anthropic' → 走 Anthropic Messages 协议模板，id/baseUrl 按用户填的覆盖", () => {
    const mc = baseConfig({ baseUrl: 'https://my-claude-gateway.example.com', model: 'claude-test-1', apiFormat: 'anthropic' })
    const model = buildModelFromConfig(mc)
    expect(model.api).toBe('anthropic-messages')
    expect(model.id).toBe('claude-test-1')
    expect(model.baseUrl).toBe('https://my-claude-gateway.example.com')
  })

  it("anthropic 格式 + 模型名 [1m] 后缀 → 剥后缀发真实模型名 + 附 context-1m beta 头（Claude Code 约定）", () => {
    const mc = baseConfig({ model: 'claude-sonnet-4-5[1m]', apiFormat: 'anthropic' })
    const model = buildModelFromConfig(mc)
    expect(model.id).toBe('claude-sonnet-4-5')
    expect((model as any).headers?.['anthropic-beta']).toBe('context-1m-2025-08-07')
    // 上下文窗口兜底 1M（未手填 contextWindow 时）
    expect(model.contextWindow).toBe(1_000_000)
  })

  it('anthropic 格式无 [1m] 后缀 → 不附 beta 头（回归防守：默认路径零变化）', () => {
    const model = buildModelFromConfig(baseConfig({ model: 'claude-test-1', apiFormat: 'anthropic' }))
    expect((model as any).headers?.['anthropic-beta']).toBeUndefined()
  })

  it('[1m] 后缀 + 用户手填 contextWindow → 手填优先', () => {
    const mc = baseConfig({ model: 'x[1m]', apiFormat: 'anthropic', contextWindow: 500_000 })
    expect(buildModelFromConfig(mc).contextWindow).toBe(500_000)
  })

  it('custom 默认（apiFormat 未填）→ 仍走 OpenAI 兼容 completions 协议，逐字节不变', () => {
    const mc = baseConfig({ baseUrl: 'https://gateway.example.com/v1', model: 'my-model' })
    const model = buildModelFromConfig(mc)
    expect(model.api).toBe('openai-completions')
    expect(model.id).toBe('my-model')
    expect(model.baseUrl).toBe('https://gateway.example.com/v1')
  })

  it("custom + apiFormat='openai' 显式声明 → 与未填行为一致（不是第三个分支）", () => {
    const implicit = buildModelFromConfig(baseConfig({ baseUrl: 'https://gateway.example.com/v1', model: 'my-model' }))
    const explicit = buildModelFromConfig(baseConfig({ baseUrl: 'https://gateway.example.com/v1', model: 'my-model', apiFormat: 'openai' }))
    expect(explicit.api).toBe(implicit.api)
    expect(explicit.id).toBe(implicit.id)
    expect(explicit.baseUrl).toBe(implicit.baseUrl)
  })

  it('Anthropic 格式：supportsThinking/supportsImages/contextWindow 能力位按声明覆盖', () => {
    const mc = baseConfig({ model: 'claude-test-2', apiFormat: 'anthropic', supportsThinking: true, supportsImages: false, contextWindow: 64000 })
    const model = buildModelFromConfig(mc)
    expect(model.reasoning).toBe(true)
    expect(model.input).toEqual(['text'])
    expect(model.contextWindow).toBe(64000)
  })

  it("custom + apiFormat='openai-responses' → 走 OpenAI Responses 协议模板，id/baseUrl 按用户填的覆盖", () => {
    const mc = baseConfig({ baseUrl: 'https://my-responses-gateway.example.com/v1', model: 'gpt-responses-test-1', apiFormat: 'openai-responses' })
    const model = buildModelFromConfig(mc)
    expect(model.api).toBe('openai-responses')
    expect(model.id).toBe('gpt-responses-test-1')
    expect(model.baseUrl).toBe('https://my-responses-gateway.example.com/v1')
  })

  it('OpenAI Responses 格式：supportsThinking/supportsImages/contextWindow 能力位按声明覆盖', () => {
    const mc = baseConfig({ model: 'gpt-responses-test-2', apiFormat: 'openai-responses', supportsThinking: true, supportsImages: false, contextWindow: 64000 })
    const model = buildModelFromConfig(mc)
    expect(model.reasoning).toBe(true)
    expect(model.input).toEqual(['text'])
    expect(model.contextWindow).toBe(64000)
  })

  it("apiFormat='openai-responses' 与 'anthropic' 各走各的协议，互不影响（三分支互斥）", () => {
    const responsesModel = buildModelFromConfig(baseConfig({ model: 'gpt-responses-test-3', apiFormat: 'openai-responses' }))
    const anthropicModel = buildModelFromConfig(baseConfig({ model: 'claude-test-3', apiFormat: 'anthropic' }))
    expect(responsesModel.api).toBe('openai-responses')
    expect(anthropicModel.api).toBe('anthropic-messages')
  })
})

describe('buildModelFromConfig — 默认 openai completions 路径不受 openai-responses 分支影响（回归）', () => {
  it('custom 默认（apiFormat 未填）在新增 openai-responses 分支后，构造结果逐字段与改动前一致', () => {
    const mc = baseConfig({ baseUrl: 'https://gateway.example.com/v1', model: 'my-model' })
    const model = buildModelFromConfig(mc)
    expect(model.api).toBe('openai-completions')
    expect(model.id).toBe('my-model')
    expect(model.baseUrl).toBe('https://gateway.example.com/v1')
    expect(model.provider).toBe('groq')
    expect(model.compat).toMatchObject({
      supportsStore: false,
      supportsStrictMode: false,
      supportsDeveloperRole: false
    })
  })
})

describe('GLM / Z.AI 思考协议兼容', () => {
  it('custom + glm-5.2 自动识别为 zai 方言，并复用 zai 的 completions/工具流模板', () => {
    const mc = baseConfig({
      baseUrl: 'https://gateway.example.com/v1',
      model: 'glm-5.2',
      apiFormat: 'openai',
      supportsThinking: true,
      supportsImages: false
    })
    const model = buildModelFromConfig(mc)

    expect(resolveThinkingFormat(mc)).toBe('zai')
    expect(model.api).toBe('openai-completions')
    expect(model.provider).toBe('zai')
    expect(model.id).toBe('glm-5.2')
    expect(model.baseUrl).toBe('https://gateway.example.com/v1')
    expect(model.reasoning).toBe(true)
    expect(model.input).toEqual(['text'])
    expect(model.contextWindow).toBe(1_000_000)
    expect(model.compat).toMatchObject({
      thinkingFormat: 'zai',
      zaiToolStream: true,
      supportsDeveloperRole: false,
      supportsReasoningEffort: true
    })
  })

  it('显式 thinkingFormat 优先于模型名自动识别', () => {
    expect(resolveThinkingFormat(baseConfig({ model: 'glm-5.2', thinkingFormat: 'qwen' }))).toBe('qwen')
    expect(resolveThinkingFormat(baseConfig({ model: 'vendor-alias', thinkingFormat: 'zai' }))).toBe('zai')
  })

  it('OpenRouter 上的 z-ai/glm 模型保留 OpenRouter 自己的 reasoning 协议', () => {
    expect(resolveThinkingFormat({
      provider: 'openrouter',
      baseUrl: 'https://openrouter.ai/api/v1',
      apiKey: 'sk-test',
      model: 'z-ai/glm-5.2'
    })).toBe('openai')
  })

  it('把旧 Pi 的 enable_thinking 改写为新版 Z.AI thinking 对象，并开启工具参数流', () => {
    const mc = baseConfig({ model: 'glm-5.2', supportsThinking: true })
    const original = {
      model: 'glm-5.2',
      stream: true,
      enable_thinking: true,
      tools: [{ type: 'function' }]
    }
    const adapted = adaptModelRequestPayload(original, mc) as Record<string, any>

    expect(adapted).not.toBe(original)
    expect(adapted.enable_thinking).toBeUndefined()
    expect(adapted.thinking).toEqual({ type: 'enabled', clear_thinking: false })
    expect(adapted.reasoning_effort).toBe('low')
    expect(adapted.tool_stream).toBe(true)
    expect(original).toHaveProperty('enable_thinking', true)
  })

  it('关闭思考时也发送 GLM 能识别的 thinking.disabled，不遗留 reasoning_effort', () => {
    const adapted = adaptModelRequestPayload({
      stream: true,
      enable_thinking: false,
      reasoning_effort: 'low',
      tools: []
    }, baseConfig({ model: 'glm-5.2' })) as Record<string, any>

    expect(adapted.thinking).toEqual({ type: 'disabled' })
    expect(adapted.enable_thinking).toBeUndefined()
    expect(adapted.reasoning_effort).toBeUndefined()
    expect(adapted.tool_stream).toBeUndefined()
  })

  it('Qwen payload 保持原样，不被 GLM 适配误改', () => {
    const payload = { stream: true, enable_thinking: true, tools: [{ type: 'function' }] }
    expect(adaptModelRequestPayload(payload, baseConfig({ model: 'qwen3.7-max' }))).toBe(payload)
  })
})

describe('buildModelFromConfig — 已知 provider 下未知 model id 不再静默换模型', () => {
  it('已知 provider（anthropic）+ 已注册 model id → 精确映射到 Pi 内置模板', () => {
    const knownModels = piGetModels('anthropic' as any)
    const knownId = (knownModels[0] as any).id
    const mc: ModelConfig = { provider: 'anthropic', baseUrl: 'https://api.anthropic.com', apiKey: 'sk-test', model: knownId }
    const model = buildModelFromConfig(mc)
    expect(model.id).toBe(knownId)
    expect(model.provider).toBe('anthropic')
  })

  it('已知 provider + 未注册的 model id → id 必须仍是用户填的值，不是 models[0]（消灭"以为在跟 A 对话实际发给 B"）', () => {
    const knownModels = piGetModels('anthropic' as any)
    const firstKnownId = (knownModels[0] as any).id
    const unknownId = 'claude-does-not-exist-9999'
    // 先确认这个 id 真的没在 Pi 内置表里注册（否则这条测试没有意义）
    expect(knownModels.some((m: any) => m.id === unknownId)).toBe(false)

    const mc: ModelConfig = { provider: 'anthropic', baseUrl: 'https://api.anthropic.com', apiKey: 'sk-test', model: unknownId }
    const model = buildModelFromConfig(mc)

    expect(model.id).toBe(unknownId)          // 请求体里发出去的 model 字段必须是用户填的
    expect(model.id).not.toBe(firstKnownId)   // 断言原本会踩的坑：不是"偷偷换成模型 B"
    expect(model.api).toBe('anthropic-messages')  // 协议仍然对（来自同 provider 模板）
  })

  it('已知 provider + 未注册 model id + 用户自填 baseUrl → baseUrl 也按用户填的覆盖（不是模板默认值）', () => {
    const mc: ModelConfig = { provider: 'anthropic', baseUrl: 'https://my-claude-proxy.example.com', apiKey: 'sk-test', model: 'claude-unregistered-xyz' }
    const model = buildModelFromConfig(mc)
    expect(model.baseUrl).toBe('https://my-claude-proxy.example.com')
    expect(model.id).toBe('claude-unregistered-xyz')
  })

  it('已知 provider（openai）+ 未注册的 model id → 同样不静默换模型（跨 provider 复核，不是只对 anthropic 生效）', () => {
    const knownModels = piGetModels('openai' as any)
    const firstKnownId = (knownModels[0] as any).id
    const unknownId = 'gpt-does-not-exist-9999'
    expect(knownModels.some((m: any) => m.id === unknownId)).toBe(false)

    const mc: ModelConfig = { provider: 'openai', baseUrl: 'https://api.openai.com/v1', apiKey: 'sk-test', model: unknownId }
    const model = buildModelFromConfig(mc)
    expect(model.id).toBe(unknownId)
    expect(model.id).not.toBe(firstKnownId)
  })
})

/**
 * 认领层交还给 Pi 目录（2026-08-15）。
 *
 * 历史实现有两个断点：
 * 1. PROVIDER_MAP 是一张 11 条的允许名单（且全是恒等映射），Pi 目录里却有 39 个 provider。
 *    名单外的 provider 会先试 `openrouter/{provider}/{model}`，命中就 return OpenRouter 的条目
 *    ——条目自带 baseUrl=openrouter.ai，下游取的就是 model.baseUrl。于是"设置页选 DeepSeek +
 *    填 api.deepseek.com + 填 DeepSeek 的 key"把请求发去了 OpenRouter（目录里恰好有
 *    deepseek/deepseek-chat，正是下拉里的第一个模型）。拿 A 家的 key 敲 B 家的门。
 * 2. 自定义端点即使填的是官方地址+官方模型名，也一律合成条目，协议/上下文/思考档位全靠猜。
 */
describe('buildModelFromConfig — Pi 认识的 provider id 一律直接认', () => {
  it('前提复核：openrouter 目录里确有 deepseek/deepseek-chat（否则下面这条测试证明不了什么）', () => {
    const or = piGetModels('openrouter' as any)
    expect(or.some((m: any) => m.id === 'deepseek/deepseek-chat')).toBe(true)
  })

  it('provider=deepseek（旧名单外）→ 端点必须留在 DeepSeek，绝不能被换成 openrouter.ai', () => {
    const mc: ModelConfig = { provider: 'deepseek', baseUrl: 'https://api.deepseek.com', apiKey: 'sk-user-deepseek', model: 'deepseek-chat' }
    const model = buildModelFromConfig(mc)
    expect(model.baseUrl).toBe('https://api.deepseek.com')
    expect(model.baseUrl).not.toContain('openrouter')
    expect(model.id).toBe('deepseek-chat')
    expect(model.provider).toBe('deepseek')   // 走的是 Pi 原生 deepseek provider，不是合成条目
  })

  it('provider=openrouter + OpenRouter 的模型 id → 照旧命中 Pi 的 openrouter 条目', () => {
    const mc: ModelConfig = { provider: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1', apiKey: 'sk-or', model: 'deepseek/deepseek-chat' }
    const model = buildModelFromConfig(mc)
    expect(model.id).toBe('deepseek/deepseek-chat')
    expect(model.baseUrl).toBe('https://openrouter.ai/api/v1')
  })

  it('Pi 不认识的 provider（siliconflow）→ 仍走自定义兼容模型，端点是用户填的', () => {
    const mc: ModelConfig = { provider: 'siliconflow', baseUrl: 'https://api.siliconflow.cn/v1', apiKey: 'sk-sf', model: 'Qwen/Qwen2.5-72B-Instruct' }
    const model = buildModelFromConfig(mc)
    expect(model.baseUrl).toBe('https://api.siliconflow.cn/v1')
    expect(model.api).toBe('openai-completions')
  })
})

describe('buildModelFromConfig — 自定义端点的双证据认领', () => {
  const goConfig = (overrides: Partial<ModelConfig> = {}): ModelConfig => ({
    provider: 'custom', baseUrl: 'https://opencode.ai/zen/go/v1', apiKey: 'sk-zen', model: 'grok-4.5', ...overrides
  })

  it('官方地址 + 官方模型名 → 认领 Pi 条目，拿到猜不出来的元数据（协议 + off:null）', () => {
    const model = buildModelFromConfig(goConfig())
    expect(model.provider).toBe('opencode-go')
    expect(model.api).toBe('openai-responses')          // 合成条目只会给 openai-completions
    expect(model.thinkingLevelMap?.off).toBeNull()      // "这个模型不能关思考"——1210 的机器可读版
  })

  it('同域不同路径不能认错家：/zen/v1 是 opencode，/zen/go/v1 才是 opencode-go', () => {
    const model = buildModelFromConfig(goConfig({ baseUrl: 'https://opencode.ai/zen/v1' }))
    expect(model.provider).toBe('opencode')
  })

  it('地址对但模型名不在该 provider 目录里 → 不认领（单证据不够），回落自定义兼容', () => {
    const model = buildModelFromConfig(goConfig({ model: 'not-a-real-model-9999' }))
    expect(model.api).toBe('openai-completions')
    expect(model.id).toBe('not-a-real-model-9999')
    expect(model.baseUrl).toBe('https://opencode.ai/zen/go/v1')
  })

  it('用户显式声明了协议（apiFormat=anthropic）→ 尊重用户，不认领', () => {
    const model = buildModelFromConfig(goConfig({ apiFormat: 'anthropic' }))
    expect(model.api).toBe('anthropic-messages')
  })

  it('认领后用户显式填过的能力位仍然覆盖 Pi（他面对的是自己的网关）', () => {
    const model = buildModelFromConfig(goConfig({ supportsImages: false, contextWindow: 128_000, supportsThinking: false }))
    expect(model.provider).toBe('opencode-go')
    expect(model.input).toEqual(['text'])
    expect(model.contextWindow).toBe(128_000)
    expect(model.reasoning).toBe(false)
  })

  it('尾斜杠 / 大小写差异不影响认领（端点归一化）', () => {
    const model = buildModelFromConfig(goConfig({ baseUrl: 'https://OpenCode.ai/zen/go/v1/' }))
    expect(model.provider).toBe('opencode-go')
  })

  it('无关的第三方网关 → 认领不了，行为逐字节不变', () => {
    const model = buildModelFromConfig(goConfig({ baseUrl: 'https://gateway.example.com/v1', model: 'grok-4.5' }))
    expect(model.api).toBe('openai-completions')
    expect(model.baseUrl).toBe('https://gateway.example.com/v1')
  })
})

/**
 * 思考档位（reasoning effort dial）契约锁：
 * ① supportsEffortDial 能力推导——Qwen3.7 预算与 Token Plan Qwen3.8 effort 分流
 * ② GLM 5.2 适配器档位透传——pi 已生成的字段 > 用户档位 > 'low' 兜底
 *    （2026-07-28 网关实测：low/medium/high 全 200；缺省不发 = 不思考，开思考必带档位）
 * ③ Qwen thinking_budget 档位注入；关闭思考时不遗留预算
 * ④ openai 方言 compat.supportsReasoningEffort 必须显式开——否则 pi 不发档位字段，UI 成谎言
 */
import { describe, it, expect } from 'vitest'
import {
  supportsEffortDial,
  adaptModelRequestPayload,
  buildModelFromConfig,
  isGlm52Model,
  resolveQwenThinkingControl,
  resolveQwenThinkingBudgets,
  resolveThinkingFormat,
  type ModelConfig
} from '../../src/main/config-manager'
import { clampThinkingLevel, getSupportedThinkingLevels } from '@earendil-works/pi-ai/compat'

const base = { provider: 'custom' as const, baseUrl: 'https://x/v1', apiKey: 'k', supportsThinking: true }

describe('supportsEffortDial 能力推导', () => {
  it('官方 Model Studio 的 Qwen3 自动启用保守档位', () => {
    const qwen = {
      ...base,
      baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      model: 'qwen3.7-plus'
    } as ModelConfig
    expect(supportsEffortDial(qwen)).toBe(true)
    expect(resolveQwenThinkingBudgets(qwen)).toEqual({ low: 2048, medium: 8192, high: 32768 })
    expect(resolveQwenThinkingBudgets({
      ...qwen,
      baseUrl: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1'
    })).toEqual({ low: 2048, medium: 8192, high: 32768 })
  })
  it('第三方 Qwen 网关默认仍是纯开关；服务商/模型可显式开启或禁用预算', () => {
    expect(supportsEffortDial({ ...base, model: 'anything', thinkingFormat: 'qwen' } as ModelConfig)).toBe(false)
    expect(supportsEffortDial({
      ...base,
      model: 'qwen3.7-plus',
      thinkingBudgets: { low: 1024, medium: 4096, high: 16384 }
    } as ModelConfig)).toBe(true)
    expect(supportsEffortDial({
      ...base,
      baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      model: 'qwen3.7-plus',
      thinkingBudgets: null
    } as ModelConfig)).toBe(false)
  })
  it('GLM 5.2（zai 方言）支持；GLM 5.1 不支持', () => {
    expect(supportsEffortDial({ ...base, model: 'glm-5.2-free' } as ModelConfig)).toBe(true)
    expect(supportsEffortDial({ ...base, model: 'glm-5.1' } as ModelConfig)).toBe(false)
  })
  it('openai / deepseek 方言支持', () => {
    expect(supportsEffortDial({ ...base, model: 'o4-mini', thinkingFormat: 'openai' } as ModelConfig)).toBe(true)
    expect(supportsEffortDial({ ...base, model: 'deepseek-v4' } as ModelConfig)).toBe(true)
  })
  it('anthropic 协议支持（pi 映射 effort/budget）', () => {
    expect(supportsEffortDial({ ...base, model: 'claude-x', apiFormat: 'anthropic' } as any)).toBe(true)
  })
  it('模型不支持思考则一律不亮', () => {
    expect(supportsEffortDial({ ...base, supportsThinking: false, model: 'glm-5.2-free' } as ModelConfig)).toBe(false)
  })
})

describe('Qwen thinking_budget 档位透传', () => {
  const qwen = {
    ...base,
    model: 'qwen3.7-plus',
    thinkingFormat: 'qwen' as const,
    thinkingBudgets: { low: 1024, medium: 4096, high: 16384 }
  } as ModelConfig

  it('按用户档位注入 token 预算，且不修改原 payload', () => {
    const payload = { model: qwen.model, enable_thinking: true, messages: [] }
    const out = adaptModelRequestPayload(payload, qwen, { reasoningEffort: 'medium' }) as any
    expect(out.thinking_budget).toBe(4096)
    expect(payload).not.toHaveProperty('thinking_budget')
  })

  it('旧模板的 completion 上限不大于预算时，补出最小输出余量以避免网关 400', () => {
    const out = adaptModelRequestPayload(
      { model: qwen.model, enable_thinking: true, max_completion_tokens: 4096, messages: [] },
      qwen,
      { reasoningEffort: 'medium' }
    ) as any
    expect(out.thinking_budget).toBe(4096)
    expect(out.max_completion_tokens).toBe(6144)
  })

  it('辅助路径未传档位时使用 low；关闭思考时清理遗留预算', () => {
    const low = adaptModelRequestPayload(
      { model: qwen.model, enable_thinking: true, messages: [] },
      qwen
    ) as any
    expect(low.thinking_budget).toBe(1024)

    const off = adaptModelRequestPayload(
      { model: qwen.model, enable_thinking: false, thinking_budget: 16384, messages: [] },
      qwen,
      { reasoningEffort: 'high' }
    ) as any
    expect(off.enable_thinking).toBe(false)
    expect(off.thinking_budget).toBeUndefined()
  })

  it('第三方网关未声明预算时保持历史布尔载荷', () => {
    const payload = { model: 'qwen3.7-plus', enable_thinking: true, messages: [] }
    expect(adaptModelRequestPayload(payload, { ...base, model: 'qwen3.7-plus' } as ModelConfig)).toEqual(payload)
  })
})

describe('Pi 原生 Qwen Token Plan', () => {
  const qwen38 = {
    ...base,
    baseUrl: 'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1',
    model: 'qwen3.8-max-preview'
  } as ModelConfig

  it('Qwen3.7 Plus 的 DashScope 直连配置复用原生 Qwen 元数据，不再继承 Groq 的 8K 输出上限', () => {
    const model: any = buildModelFromConfig({
      ...base,
      baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      model: 'qwen3.7-plus'
    } as ModelConfig)
    expect(model.provider).toBe('qwen-token-plan-cn')
    expect(model.api).toBe('openai-completions')
    expect(model.contextWindow).toBe(1_000_000)
    expect(model.maxTokens).toBe(65_536)
    expect(model.compat?.supportsReasoningEffort).toBe(false)
  })

  it('Token Plan CN 的 Qwen3.8 使用 Pi 原生 effort 目录，而不是 Qwen3.7 的 token 预算', () => {
    const model: any = buildModelFromConfig(qwen38)
    expect(model.provider).toBe('qwen-token-plan-cn')
    expect(model.id).toBe('qwen3.8-max-preview')
    expect(model.contextWindow).toBe(1_000_000)
    expect(model.maxTokens).toBe(131_072)
    expect(model.compat?.thinkingFormat).toBe('qwen')
    expect(model.compat?.supportsReasoningEffort).toBe(true)
    expect(resolveQwenThinkingControl(qwen38)).toBe('effort')
    expect(resolveQwenThinkingBudgets(qwen38)).toBeNull()
    expect(supportsEffortDial(qwen38)).toBe(true)
    // OpenPipal 的“高”仍可保留三档 UI；Pi 会钳制到模型真正支持的 xhigh。
    expect(clampThinkingLevel(model, 'high')).toBe('xhigh')
  })

  it('Qwen3.8 的 Pi 原生 reasoning_effort 不会被适配器误加 thinking_budget', () => {
    const payload = {
      model: qwen38.model,
      enable_thinking: true,
      reasoning_effort: 'xhigh',
      max_completion_tokens: 131_072,
      messages: []
    }
    const out = adaptModelRequestPayload(payload, qwen38, { reasoningEffort: 'high' }) as any
    expect(out).toBe(payload)
    expect(out.reasoning_effort).toBe('xhigh')
    expect(out.thinking_budget).toBeUndefined()
  })
})

describe('GLM 5.2 适配器档位透传', () => {
  const glm = { ...base, model: 'glm-5.2-free' } as ModelConfig
  const enabledPayload = () => ({ model: 'glm-5.2-free', enable_thinking: true, messages: [] })

  it('用户档位注入（pi zai 分支不生成 reasoning_effort）', () => {
    const out = adaptModelRequestPayload(enabledPayload(), glm, { reasoningEffort: 'medium' }) as any
    expect(out.thinking).toEqual({ type: 'enabled', clear_thinking: false })
    expect(out.reasoning_effort).toBe('medium')
  })
  it('不传档位回落 low（与辅助路径的默认轻量思考一致）', () => {
    const out = adaptModelRequestPayload(enabledPayload(), glm) as any
    expect(out.reasoning_effort).toBe('low')
  })
  it('pi 已生成的字段优先于用户档位', () => {
    const out = adaptModelRequestPayload({ ...enabledPayload(), reasoning_effort: 'low' }, glm, { reasoningEffort: 'high' }) as any
    expect(out.reasoning_effort).toBe('low')
  })
  it('思考关闭时不带档位字段', () => {
    const out = adaptModelRequestPayload({ model: 'glm-5.2-free', enable_thinking: false, reasoning_effort: 'high', messages: [] }, glm, { reasoningEffort: 'low' }) as any
    expect(out.thinking).toEqual({ type: 'disabled' })
    expect(out.reasoning_effort).toBeUndefined()
  })
  it('isGlm52Model 判定口径（三处共用的唯一维护点）', () => {
    expect(isGlm52Model('glm-5.2-free')).toBe(true)
    expect(isGlm52Model('z-ai/glm-5.2')).toBe(true)
    expect(isGlm52Model('glm-5.1')).toBe(false)
  })
})

describe('openai 方言 compat 位', () => {
  it('thinkingFormat=openai 时 supportsReasoningEffort 显式开', () => {
    const model: any = buildModelFromConfig({ ...base, model: 'o4-mini', thinkingFormat: 'openai' } as ModelConfig)
    expect(model.compat?.supportsReasoningEffort).toBe(true)
  })
  it('qwen 方言不动 compat 位', () => {
    const model: any = buildModelFromConfig({
      ...base,
      baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      model: 'qwen3.7-plus'
    } as ModelConfig)
    expect(model.compat?.supportsReasoningEffort ?? false).toBe(false)
  })
})

/**
 * 认不出的自定义端点该说哪种方言（2026-08-15 真机：grok-4.6 经第三方网关被判成 qwen，
 * 关思考发出 enable_thinking:false → 网关 [1210] "always engages in thinking and cannot be disabled"）。
 */
describe('自定义端点的思考方言默认', () => {
  it('grok 走 openai 方言：关思考时不发字段（qwen 方言会发 enable_thinking:false 打 400）', () => {
    const grok = { ...base, model: 'grok-4.6' } as ModelConfig
    expect(resolveThinkingFormat(grok)).toBe('openai')
    expect(supportsEffortDial(grok)).toBe(true) // 档位随之解锁，不再只有一个开关
    expect(resolveThinkingFormat({ ...base, model: 'x-ai/grok-4-fast' } as ModelConfig)).toBe('openai')
  })

  it('档位表去 Pi 目录借同名模型的，不再硬编码——grok-4.5 四家 provider 的表完全一致', () => {
    const model = buildModelFromConfig({ ...base, model: 'grok-4.5' } as ModelConfig) as any
    // Pi 的生成数据（出处 models.dev）：不能关思考，合法档位 low/medium/high
    expect(model.thinkingLevelMap?.off).toBeNull()
    expect(model.thinkingLevelMap?.max).toBeNull()
    expect(clampThinkingLevel(model, 'medium')).toBe('medium')  // 旧硬编码表会挪成 high
    expect(getSupportedThinkingLevels(model)).not.toContain('off')
  })

  it('Pi 目录里没有的模型 id（grok-4.6）→ 不借表，也不猜；关思考时照样不发禁用字段', () => {
    const model = buildModelFromConfig({ ...base, model: 'grok-4.6' } as ModelConfig) as any
    expect(model.thinkingLevelMap).toBeUndefined()
    // pi 的 openai 分支：off 不是字符串就什么都不发（openai-completions.js:661），不会撞 1210
    expect(model.compat?.supportsReasoningEffort).toBe(true)
  })

  it('认不出来时说标准 OpenAI 方言，不再猜 qwen——猜错的代价是硬 400 而不是降级', () => {
    expect(resolveThinkingFormat({ ...base, model: 'some-gateway-model-v3' } as ModelConfig)).toBe('openai')
    // 逃生舱口：真是 qwen 但模型 id 不含 qwen 字样时，设置里显式选方言仍然一票否决
    expect(resolveThinkingFormat({
      ...base, model: 'some-gateway-model-v3', thinkingFormat: 'qwen'
    } as ModelConfig)).toBe('qwen')
  })

  it('既有判定不受影响：qwen / glm / deepseek / openrouter 各归各位', () => {
    expect(resolveThinkingFormat({ ...base, model: 'qwen3.8-plus' } as ModelConfig)).toBe('qwen')
    expect(resolveThinkingFormat({ ...base, model: 'glm-5.3' } as ModelConfig)).toBe('zai')
    expect(resolveThinkingFormat({ ...base, model: 'deepseek-v3.2' } as ModelConfig)).toBe('deepseek')
    expect(resolveThinkingFormat({
      ...base, provider: 'openrouter', model: 'z-ai/glm-5.3'
    } as unknown as ModelConfig)).toBe('openai')
  })
})

/**
 * 档位菜单显隐先问 Pi（2026-08-15）。
 *
 * 从前 UI 问的是我们自己的方言 if 链，请求路径问的是 Pi 的 thinkingLevelMap——两个神谕，
 * 会打架。现在：能认领到 Pi 目录条目、且档位确实由 Pi 生成字段时，以 Pi 为准。
 */
describe('档位显隐以 Pi 目录为准', () => {
  const key = { apiKey: 'sk-test', supportsThinking: true }

  it('gpt-5-pro 在 Pi 目录里只有一个档位（high）→ 不该给用户画三档', () => {
    const mc = { provider: 'openai', baseUrl: 'https://api.openai.com/v1', model: 'gpt-5-pro', ...key } as ModelConfig
    const model = buildModelFromConfig(mc) as any
    expect(getSupportedThinkingLevels(model).filter((l: string) => l !== 'off')).toEqual(['high'])
    expect(supportsEffortDial(mc)).toBe(false)   // 旧规则按 provider==='openai' 无条件 true
  })

  it('同一 provider 下档位齐全的模型仍然亮（不是把 openai 一刀切关掉）', () => {
    const mc = { provider: 'openai', baseUrl: 'https://api.openai.com/v1', model: 'gpt-5', ...key } as ModelConfig
    expect(getSupportedThinkingLevels(buildModelFromConfig(mc) as any).length).toBeGreaterThan(2)
    expect(supportsEffortDial(mc)).toBe(true)
  })

  it('自定义端点被双证据认领后，档位也由 Pi 回答', () => {
    const mc = { provider: 'custom', baseUrl: 'https://opencode.ai/zen/go/v1', model: 'grok-4.5', ...key } as ModelConfig
    expect(supportsEffortDial(mc)).toBe(true)
  })

  it('认领不到的合成条目仍走方言推导（Pi 手里只有我们喂的模板，问它等于问自己）', () => {
    const mc = { provider: 'custom', baseUrl: 'https://gateway.example.com/v1', model: 'mystery-v3', ...key } as ModelConfig
    expect(supportsEffortDial(mc)).toBe(true)   // 兜底 openai 方言 → 有 reasoning_effort
  })
})

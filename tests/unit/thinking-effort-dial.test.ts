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
  type ModelConfig
} from '../../src/main/config-manager'
import { clampThinkingLevel } from '@earendil-works/pi-ai/compat'

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

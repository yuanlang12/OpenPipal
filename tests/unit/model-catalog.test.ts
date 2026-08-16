/**
 * 服务商 + 模型目录直接来自 Pi（2026-08-15）。
 *
 * 从前设置页那张表是 5 条硬编码（每家 2-4 个模型名），Pi 目录里有 39 个 provider、1200+ 个模型。
 * 手抄表的真正代价不是"少"，是用户想用的模型不在表里就只能走自定义——协议和能力位全靠他猜。
 */
import { describe, it, expect } from 'vitest'
import { getProviders } from '../../src/main/config-manager'

describe('模型目录来自 Pi', () => {
  const catalog = getProviders()

  it('规模远超从前那张手抄表，且每条都带地址', () => {
    expect(Object.keys(catalog).length).toBeGreaterThan(20)
    const total = Object.values(catalog).reduce((n, p) => n + p.models.length, 0)
    expect(total).toBeGreaterThan(800)
    for (const entry of Object.values(catalog)) {
      expect(entry.baseUrl).toMatch(/^https?:\/\//)
      expect(entry.models.length).toBeGreaterThan(0)
    }
  })

  it('跑不了的协议不进选择器：bedrock / vertex 要整套云凭证，不是一个 key', () => {
    expect(catalog['amazon-bedrock']).toBeUndefined()
    expect(catalog['google-vertex']).toBeUndefined()
  })

  it('地址给不出的不进：Azure 目录无 baseUrl，Cloudflare 网关地址里是 {占位符}', () => {
    expect(catalog['azure-openai-responses']).toBeUndefined()
    expect(catalog['cloudflare-ai-gateway']).toBeUndefined()
    for (const entry of Object.values(catalog)) expect(entry.baseUrl).not.toMatch(/[{}]/)
  })

  it('只有 OAuth 的不进：openai-codex 填 key 也用不了', () => {
    expect(catalog['openai-codex']).toBeUndefined()
  })

  it('常用的排在前面，其余按字母序', () => {
    const ids = Object.keys(catalog)
    expect(ids[0]).toBe('openai')
    expect(ids.indexOf('anthropic')).toBeLessThan(ids.indexOf('zai') + 1)
    expect(ids.indexOf('openai')).toBeLessThan(ids.indexOf('baseten'))
  })

  it('模型条目带上能力位——设置页据此把开关变成只读展示，而不是继续问用户', () => {
    const grok = catalog['opencode-go']?.models.find((m) => m.id === 'grok-4.5')
    expect(grok).toBeDefined()
    expect(grok?.reasoning).toBe(true)
    expect(grok?.image).toBe(true)
    expect(grok?.contextWindow).toBeGreaterThan(100_000)
  })

  it('Pi 不认识但我们历史上提供过的服务商仍在（老用户的选项不能凭空消失）', () => {
    expect(catalog['siliconflow']?.baseUrl).toBe('https://api.siliconflow.cn/v1')
  })
})

/**
 * 服务商实体化（configVersion 2）契约锁：
 * ① v1→v2 惰性迁移：按 (baseUrl, apiKey) 去重建实体、预设挂接、内置打标、.bak 备份、幂等
 * ② 解析视图：服务商改 key 一处生效（旗下所有预设跟随）；providerId 悬空回落预设缓存
 * ③ 编辑语义：改单个预设的连接字段 = 重新挂接，不误伤同服务商兄弟模型
 * ④ 红线：内置服务商/预设的连接信息与模型名不出主进程（掩码/拒绝）
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'openpipal-providers-'))
process.env.HOME = TMP

const CONFIG_DIR = path.join(TMP, '.openpipal')
const CONFIG_PATH = path.join(CONFIG_DIR, 'config.json')

fs.mkdirSync(CONFIG_DIR, { recursive: true })
const V1_CONFIG = {
  modelConfig: { provider: 'custom', baseUrl: 'https://gw.a.com/v1', apiKey: 'key-A', model: 'm1' },
  activePresetId: 'p1',
  modelPresets: [
    { id: 'p1', name: 'm1', config: { provider: 'custom', baseUrl: 'https://gw.a.com/v1', apiKey: 'key-A', model: 'm1', supportsThinking: true } },
    { id: 'p2', name: 'm2', config: { provider: 'custom', baseUrl: 'https://gw.a.com/v1', apiKey: 'key-A', model: 'm2' } },
    { id: 'p3', name: 'm3', config: { provider: 'custom', baseUrl: 'https://gw.b.com/v1', apiKey: 'key-B', model: 'm3' } },
    { id: 'p4', name: 'gpt-4o (内置)', config: { provider: 'custom', baseUrl: 'https://builtin.example/v1', apiKey: 'builtin-key', model: 'gpt-4o' } }
  ]
}
fs.writeFileSync(CONFIG_PATH, JSON.stringify(V1_CONFIG, null, 2))

const cm = await import('../../src/main/config-manager')

describe('v1→v2 迁移', () => {
  it('同 (baseUrl, apiKey) 共享服务商实体，内置打标，configVersion=2，留 .bak', () => {
    const config = cm.loadConfig() // 触发惰性迁移
    expect(config.configVersion).toBe(2)
    expect(config.modelProviders).toHaveLength(3) // A(p1,p2 共享) / B / 内置
    const p1 = config.modelPresets!.find(p => p.id === 'p1')!
    const p2 = config.modelPresets!.find(p => p.id === 'p2')!
    const p3 = config.modelPresets!.find(p => p.id === 'p3')!
    const p4 = config.modelPresets!.find(p => p.id === 'p4')!
    expect(p1.providerId).toBe(p2.providerId)
    expect(p1.providerId).not.toBe(p3.providerId)
    const builtinProv = config.modelProviders!.find(x => x.id === p4.providerId)!
    expect(builtinProv.builtin).toBe(true)
    expect(builtinProv.name).toBe('内置服务')
    // custom 服务商显示名 = 域名
    const provA = config.modelProviders!.find(x => x.id === p1.providerId)!
    expect(provA.name).toBe('gw.a.com')
    expect(fs.existsSync(CONFIG_PATH + '.bak-pre-providers')).toBe(true)
  })

  it('幂等：再次 loadConfig 不增实体、不改挂接', () => {
    const again = cm.loadConfig()
    expect(again.modelProviders).toHaveLength(3)
    expect(again.configVersion).toBe(2)
  })
})

describe('解析视图与一处生效', () => {
  it('服务商改 key/网关 → 旗下所有预设的解析视图跟随；模型级字段不受影响', () => {
    const config = cm.loadConfig()
    const providerId = config.modelPresets!.find(p => p.id === 'p1')!.providerId!
    expect(cm.updateModelProvider(providerId, { baseUrl: 'https://gw.a-new.com/v1', apiKey: 'key-A2' })).toBe(true)
    const r1 = cm.getModelPresetFull('p1')!
    const r2 = cm.getModelPresetFull('p2')!
    expect(r1.config.baseUrl).toBe('https://gw.a-new.com/v1')
    expect(r1.config.apiKey).toBe('key-A2')
    expect(r2.config.apiKey).toBe('key-A2')          // 兄弟模型同步生效
    expect(r1.config.supportsThinking).toBe(true)    // 模型级字段保留
    expect(cm.getModelPresetFull('p3')!.config.apiKey).toBe('key-B') // 其他服务商不动
  })

  it('激活预设挂在被改服务商下 → modelConfig 快照同步刷新', () => {
    expect(cm.getEffectiveModelConfig().apiKey).toBe('key-A2')
  })

  it('空 key patch = 保留原值', () => {
    const providerId = cm.loadConfig().modelPresets!.find(p => p.id === 'p1')!.providerId!
    cm.updateModelProvider(providerId, { apiKey: '', name: '改个名' })
    expect(cm.getModelPresetFull('p1')!.config.apiKey).toBe('key-A2')
  })

  it('改单个预设的连接字段 → 重新挂接新服务商，兄弟不受影响', () => {
    const before = cm.loadConfig()
    const provCount = before.modelProviders!.length
    cm.updateModelPreset('p2', 'm2', { provider: 'custom', baseUrl: 'https://gw.c.com/v1', apiKey: 'key-C', model: 'm2' } as any)
    const after = cm.loadConfig()
    expect(after.modelProviders!.length).toBe(provCount + 1)             // 新实体
    const p1 = after.modelPresets!.find(p => p.id === 'p1')!
    const p2 = after.modelPresets!.find(p => p.id === 'p2')!
    expect(p2.providerId).not.toBe(p1.providerId)                        // 分家
    expect(cm.getModelPresetFull('p1')!.config.apiKey).toBe('key-A2')    // 兄弟原样
    expect(cm.getModelPresetFull('p2')!.config.apiKey).toBe('key-C')
  })

  it('服务商的 Qwen 默认值由旗下模型继承；单模型可显式覆盖为仅开关', () => {
    const providerId = cm.loadConfig().modelPresets!.find(p => p.id === 'p1')!.providerId!
    const providerBudgets = { low: 2048, medium: 8192, high: 32768 }
    expect(cm.updateModelProvider(providerId, {
      thinkingFormat: 'qwen',
      thinkingBudgets: providerBudgets
    })).toBe(true)

    const inherited = cm.getModelPresetFull('p1')!
    expect(inherited.rawConfig.thinkingFormat).toBeUndefined()
    expect(inherited.rawConfig.thinkingBudgets).toBeUndefined()
    expect(inherited.config.thinkingFormat).toBe('qwen')
    expect(inherited.config.thinkingBudgets).toEqual(providerBudgets)
    expect(cm.getEffectiveModelConfig().thinkingBudgets).toEqual(providerBudgets)
    expect(cm.updateModelProvider(providerId, {
      thinkingBudgets: { low: '1', medium: '2', high: '3' } as any
    })).toBe(false)
    expect(cm.getModelPresetFull('p1')!.config.thinkingBudgets).toEqual(providerBudgets)

    expect(cm.updateModelPreset('p1', 'm1', {
      ...inherited.rawConfig,
      provider: inherited.config.provider,
      baseUrl: inherited.config.baseUrl,
      apiKey: inherited.config.apiKey,
      apiFormat: inherited.config.apiFormat,
      thinkingFormat: 'auto',
      thinkingBudgets: null
    })).toBe(true)
    expect(cm.getModelPresetFull('p1')!.config.thinkingBudgets).toBeNull()
  })

  it('只改接口格式（baseUrl/key 不变）→ 一样重新挂接，解析视图跟随用户所选方言', () => {
    const before = cm.loadConfig()
    const provCount = before.modelProviders!.length
    const oldProviderId = before.modelPresets!.find(p => p.id === 'p1')!.providerId
    // 用户在 Settings 里只把「接口格式」从 OpenAI 改成 OpenAI-Responses
    const full = cm.getModelPresetFull('p1')!
    expect(cm.updateModelPreset('p1', 'm1', {
      ...full.rawConfig,
      provider: full.config.provider,
      baseUrl: full.config.baseUrl,
      apiKey: full.config.apiKey,
      apiFormat: 'openai-responses'
    })).toBe(true)

    const after = cm.loadConfig()
    expect(after.modelProviders!.length).toBe(provCount + 1)
    expect(after.modelPresets!.find(p => p.id === 'p1')!.providerId).not.toBe(oldProviderId)
    // 回归点：dedupe 键漏了 apiFormat 时，这里会被旧实体的 'openai' 覆盖回去
    expect(cm.getModelPresetFull('p1')!.config.apiFormat).toBe('openai-responses')
    expect(cm.getEffectiveModelConfig().apiFormat).toBe('openai-responses') // 激活快照同步
  })
})

describe('红线：内置信息不出主进程', () => {
  it('所有展示入口共用不可逆掩码，短 key 不泄露任何原字符', () => {
    for (const key of ['abcd', 'abcdefgh', 'abcdefghij']) {
      const masked = cm.maskApiKey(key)
      expect(masked).toBe('••••••')
      expect(masked).not.toContain(key)
    }
    expect(cm.maskApiKey('abcdefghijkl')).toBe('••••••')
    expect(cm.maskApiKey('')).toBe('')
  })

  it('listModelProviders：内置连接信息全掩，非内置 key 掩码', () => {
    const list = cm.listModelProviders()
    const builtin = list.find(p => p.builtin)!
    expect(builtin.baseUrl).toBe('')
    expect(builtin.apiKeyMasked).toBe('')
    expect(builtin.name).toBe('内置服务')
    const normal = list.find(p => !p.builtin && p.name === '改个名')!
    // 短 key（<12 位）必须全遮——"前6+后4"式掩码对短 key 等于全量泄露
    expect(normal.apiKeyMasked).not.toContain('key-A2')
    expect(normal.apiKeyMasked).toBe('••••••')
  })

  it('getAvailableModels：内置模型名不暴露', () => {
    const models = cm.getAvailableModels()
    const builtin = models.find(m => m.builtin)!
    expect(builtin.name).toBe('内置模型')
    expect(builtin.model).toBe('内置模型')
  })

  it('getModelPresetFull 对内置预设带 builtin 标记（IPC 边界据此拒发）；getModelProviderFull 对内置直接拒', () => {
    expect(cm.getModelPresetFull('p4')!.builtin).toBe(true)
    const builtinProvId = cm.loadConfig().modelPresets!.find(p => p.id === 'p4')!.providerId!
    expect(cm.getModelProviderFull(builtinProvId)).toBeNull()
    expect(cm.updateModelProvider(builtinProvId, { apiKey: 'hack' })).toBe(false)
  })
})

describe('红线：生效配置展示口径（config:get-model / get-model-full / HTTP 出口共用）', () => {
  let snapshot = ''
  let envKey: string | undefined
  let envModel: string | undefined

  beforeAll(() => {
    snapshot = fs.readFileSync(CONFIG_PATH, 'utf-8')
    envKey = process.env.OPENAI_API_KEY
    envModel = process.env.OPENAI_MODEL
  })

  afterAll(() => {
    fs.writeFileSync(CONFIG_PATH, snapshot)
    if (envKey === undefined) delete process.env.OPENAI_API_KEY
    else process.env.OPENAI_API_KEY = envKey
    if (envModel === undefined) delete process.env.OPENAI_MODEL
    else process.env.OPENAI_MODEL = envModel
  })

  it('内置预设生效时 model/baseUrl/key 全遮蔽并带 builtin 位', () => {
    expect(cm.switchToPreset('p4')).toBe(true)
    const display = cm.getEffectiveModelConfigForDisplay()
    expect(display.builtin).toBe(true)
    expect(display.model).toBe('内置模型')
    expect(display.baseUrl).toBe('')
    expect(display.apiKey).toBe('••••••')
  })

  it('.env 回退（内置凭证）同样遮蔽，序列化后不含任何原值', () => {
    const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'))
    delete config.modelConfig
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2))
    process.env.OPENAI_API_KEY = 'env-secret-key'
    process.env.OPENAI_MODEL = 'gpt-4o-secret'
    const display = cm.getEffectiveModelConfigForDisplay()
    expect(display.builtin).toBe(true)
    expect(display.model).toBe('内置模型')
    expect(display.baseUrl).toBe('')
    expect(display.apiKey).toBe('••••••')
    const serialized = JSON.stringify(display)
    expect(serialized).not.toContain('env-secret-key')
    expect(serialized).not.toContain('gpt-4o-secret')
  })

  it('自定义配置只掩 key，model/baseUrl 原样透出', () => {
    fs.writeFileSync(CONFIG_PATH, snapshot)
    delete process.env.OPENAI_API_KEY
    expect(cm.switchToPreset('p1')).toBe(true)
    const display = cm.getEffectiveModelConfigForDisplay()
    expect(display.builtin).toBe(false)
    expect(display.model).toBe('m1')
    expect(display.apiKey).toBe('••••••')
    expect(display.baseUrl).not.toBe('')
  })
})

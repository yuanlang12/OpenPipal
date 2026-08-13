/**
 * 会话级模型解析：会话专属预设 > 全局默认；预设已删回退全局并回填 danglingPresetId（证据式，不硬报错）。
 * 纯读取——解析永不写全局 modelConfig，会话选择不污染其他会话。
 */
import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'

// homedir() 在模块加载时拼 CONFIG_PATH——必须在导入前劫持 HOME
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'openpipal-model-resolve-'))
process.env.HOME = TMP
fs.mkdirSync(path.join(TMP, '.openpipal'), { recursive: true })

const GLOBAL_MC = { provider: 'custom', baseUrl: 'https://gw.example.com/v1', apiKey: 'k-global', model: 'global-model', contextWindow: 131072 }
const PRESET_MC = { provider: 'custom', baseUrl: 'https://gw.example.com/v1', apiKey: 'k-preset', model: 'preset-model', contextWindow: 262144, supportsThinking: true }

fs.writeFileSync(
  path.join(TMP, '.openpipal', 'config.json'),
  JSON.stringify({
    modelConfig: GLOBAL_MC,
    activePresetId: 'preset_global',
    modelPresets: [
      { id: 'preset_global', name: '全局默认', config: GLOBAL_MC },
      { id: 'preset_big', name: '大杯', config: PRESET_MC }
    ]
  })
)

const { resolveConversationModelConfig, getEffectiveModelConfig } = await import('../../src/main/config-manager')

describe('resolveConversationModelConfig', () => {
  it('未设置 presetId → 跟随全局', () => {
    const r = resolveConversationModelConfig(undefined)
    expect(r.source).toBe('global')
    expect(r.config.model).toBe('global-model')
    expect(r.danglingPresetId).toBeUndefined()
  })

  it('命中预设 → 用该预设完整配置（含 contextWindow/supportsThinking 能力位）', () => {
    const r = resolveConversationModelConfig('preset_big')
    expect(r.source).toBe('conversation')
    expect(r.config.model).toBe('preset-model')
    expect(r.config.contextWindow).toBe(262144)
    expect(r.config.supportsThinking).toBe(true)
  })

  it('预设已删 → 回退全局 + 回填 danglingPresetId', () => {
    const r = resolveConversationModelConfig('preset_deleted')
    expect(r.source).toBe('global')
    expect(r.config.model).toBe('global-model')
    expect(r.danglingPresetId).toBe('preset_deleted')
  })

  it('解析不写全局：命中会话预设后全局 modelConfig 原样不动', () => {
    resolveConversationModelConfig('preset_big')
    expect(getEffectiveModelConfig().model).toBe('global-model')
  })
})

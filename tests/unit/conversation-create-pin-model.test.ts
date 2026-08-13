/**
 * 会话出生即钉住模型（快照语义）：createConversation 把当时的全局 config.activePresetId
 * 写进 conversation.config.modelPresetId；缺省（无 activePresetId / config.json 不存在）则字段不写、
 * 会话跟随全局默认。此后全局切换永不影响这条已存在的会话。
 * HOME 劫持模式同 conversation-model-resolve.test.ts。
 */
import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'

// homedir() 在模块加载时拼 CONFIG_PATH / CONVERSATIONS_DIR——必须在导入前劫持 HOME
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'openpipal-conv-pin-'))
process.env.HOME = TMP
fs.mkdirSync(path.join(TMP, '.openpipal'), { recursive: true })

const CONFIG_PATH = path.join(TMP, '.openpipal', 'config.json')
function writeConfig(obj: unknown): void {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(obj))
}

// createConversation 每次 loadConfig() 读盘取 activePresetId，动态导入拿到劫持后的模块
const { createConversation } = await import('../../src/main/conversation-store')

describe('createConversation 出生钉住模型', () => {
  it('config 有 activePresetId → conversation.config.modelPresetId 等于它', () => {
    writeConfig({ activePresetId: 'preset_big', modelPresets: [{ id: 'preset_big', name: '大杯' }] })
    const conv = createConversation('design')
    expect(conv.config?.modelPresetId).toBe('preset_big')
  })

  it('config 无 activePresetId → 不写 modelPresetId（跟随全局默认）', () => {
    writeConfig({ modelConfig: { model: 'global-model' } })
    const conv = createConversation('design')
    expect(conv.config?.modelPresetId).toBeUndefined()
  })

  it('config.json 不存在 → 字段缺省', () => {
    if (fs.existsSync(CONFIG_PATH)) fs.unlinkSync(CONFIG_PATH)
    const conv = createConversation('general')
    expect(conv.config?.modelPresetId).toBeUndefined()
  })
})

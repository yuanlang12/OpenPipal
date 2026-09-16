/**
 * 会话用哪个模型（所有者 2026-09-10 定的规则）：
 *   用户在会话里选的 > 第一次真跑时的全局默认（从那一刻钉住）> 没跑过的空会话一直跟着全局默认走。
 * 之前是"出生即钉"：空会话钉着建它那一刻的全局预设，用户在设置页换了模型再回来发第一句，跑的还是旧端点。
 * HOME 劫持模式同 conversation-model-resolve.test.ts。
 */
import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'openpipal-model-pin-'))
process.env.HOME = TMP
process.env.OPENPIPAL_ISOLATED_HOME = TMP
const DATA_DIR = '.openpipal'
fs.mkdirSync(path.join(TMP, DATA_DIR), { recursive: true })
const CONFIG_PATH = path.join(TMP, DATA_DIR, 'config.json')
const writeConfig = (obj: unknown): void => { fs.writeFileSync(CONFIG_PATH, JSON.stringify(obj)) }
writeConfig({ activePresetId: 'preset_a', modelPresets: [{ id: 'preset_a', name: 'A' }, { id: 'preset_b', name: 'B' }] })

const store = await import('../../src/main/conversation-store')
const service = await import('../../src/main/conversation-service')
const { resolveAgentOverrides } = await import('../../src/main/agent-overrides')
const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

describe('模型钉住的时机', () => {
  it('出生不钉：老存储与 JSONL 存储建出来的会话都没有 modelPresetId', async () => {
    expect(store.createConversation('general').config?.modelPresetId).toBeUndefined()
    const jsonl = await service.createConversation('general', '新的')
    expect(jsonl.config?.modelPresetId).toBeUndefined()
  })

  it('第一次跑：没选过 → 用此刻的全局默认并落盘；之后全局切走，这条会话还是原来那个', async () => {
    const conv = store.createConversation('general')
    const first = resolveAgentOverrides({ conversationId: conv.id })
    expect(first?.modelPresetId).toBe('preset_a')
    await sleep(50)
    expect(store.getConversation(conv.id)?.config?.modelPresetId).toBe('preset_a')

    writeConfig({ activePresetId: 'preset_b', modelPresets: [{ id: 'preset_a', name: 'A' }, { id: 'preset_b', name: 'B' }] })
    const second = resolveAgentOverrides({ conversationId: conv.id })
    expect(second?.modelPresetId).toBe('preset_a')
    // 没跑过的新会话跟着新的全局默认
    const fresh = store.createConversation('general')
    expect(resolveAgentOverrides({ conversationId: fresh.id })?.modelPresetId).toBe('preset_b')
  })

  it('用户在会话里选过的优先：载荷带 modelPresetId 就用它，不被全局默认盖掉', () => {
    const conv = store.createConversation('general')
    const r = resolveAgentOverrides({ conversationId: conv.id, conversationConfig: { modelPresetId: 'preset_a' } })
    expect(r?.modelPresetId).toBe('preset_a')
  })

  it('渲染层在第一句话发出时把全局默认钉进 conversationConfig（胶囊立刻显示真相）；设置页切全局不碰会话', () => {
    const chat = fs.readFileSync('src/renderer/src/stores/chatStore.ts', 'utf8')
    expect(chat).toMatch(/if \(messages\.length === 0 && !get\(\)\.conversationConfig\?\.modelPresetId\) \{[\s\S]*?getAvailableModels[\s\S]*?setConversationModelPreset\(active\.id\)/)
    const settings = fs.readFileSync('src/renderer/src/components/ModelSettings.tsx', 'utf8')
    expect(settings).not.toContain('setConversationModelPreset')
    for (const file of ['src/main/conversation-store.ts', 'src/main/conversation-service.ts']) {
      expect(fs.readFileSync(file, 'utf8'), file).not.toContain('modelPresetId: activePresetId')
    }
  })
})

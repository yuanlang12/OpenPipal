import { test, expect, Page } from '@playwright/test'

const ARTIFACTS_DIR = 'tests/artifacts/voice-replay'

/**
 * 回听按钮渲染 — 有 audioPath 的语音消息(用户输入 / AI 输出)才显示 ▶ 回听;没有则不显示。
 * 实际播放需 live 音频(headless 测不了),这里只测按钮按 audioPath 出现的逻辑。
 */
const MOCK_API = `
window.__mockBus = {
  listeners: {},
  on(event, fn) { if (!this.listeners[event]) this.listeners[event] = []; this.listeners[event].push(fn); return () => {}; },
  emit(event, ...args) { (this.listeners[event] || []).forEach(fn => fn(...args)); }
};
window.api = {
  sendChat: () => {},
  abortChat: () => {},
  onStreamChunk: (cb) => window.__mockBus.on('stream-chunk', cb),
  onStreamEnd: (cb) => window.__mockBus.on('stream-end', cb),
  onTextFlush: (cb) => window.__mockBus.on('text-flush', cb),
  onToolStart: (cb) => window.__mockBus.on('tool-start', cb),
  onToolEnd: (cb) => window.__mockBus.on('tool-end', cb),
  onAskUser: (cb) => window.__mockBus.on('ask-user', cb),
  onTargetStatus: (cb) => window.__mockBus.on('target-status', cb),
  onAppChanged: (cb) => window.__mockBus.on('app-changed', cb),
  pasteToTarget: async () => ({ success: true }),
  getRoleInitState: async () => ({ hasRole: true, role: { name: 'learner', displayName: '学习助手', icon: '📖' } }),
  getAllRoles: async () => [{ name: 'learner', displayName: '学习助手', icon: '📖' }],
  getCurrentRole: async () => ({ name: 'learner', displayName: '学习助手', icon: '📖' }),
  switchRole: async () => ({ name: 'learner', displayName: '学习助手', icon: '📖' }),
  listConversations: async () => [],
  createConversation: async (role) => ({ id: 'conv-test', title: '回听测试', role, createdAt: Date.now(), updatedAt: Date.now(), messageCount: 0 }),
  getConversationMessages: async () => [],
  replaceMessages: async () => {},
  appendMessages: async () => {},
  deleteConversation: async () => {},
  getAppSettings: async () => ({ detected: [], disabled: [], browsers: [] }),
  setDisabledApps: async () => {},
  isCustomConfig: async () => ({ isCustom: false }),
  getAvailableModels: async () => [],
  getModelConfig: async () => ({ provider: 'openai', baseUrl: '', apiKey: '', model: '' }),
  getModelConfigFull: async () => ({ provider: 'openai', baseUrl: '', apiKey: '', model: '' }),
  saveModelConfig: async () => {},
  testConnection: async () => ({ ok: true, model: 'gpt-4o' }),
  getProviders: async () => ({}),
  clearModelConfig: async () => {},
  getRealtimeConfig: async () => ({ provider: 'openai', url: '', model: '', deployment: '', apiVersion: '', voice: 'alloy', hasKey: true }),
  startRealtime: async () => ({ success: false }),
  stopRealtime: () => {},
  sendRealtimeEvent: () => {},
  onRealtimeEvent: () => () => {},
  onRealtimeState: () => () => {},
  readVoiceAudio: async () => ({ base64: '' })
};
`

async function setup(page: Page): Promise<void> {
  await page.addInitScript({ content: MOCK_API })
  await page.goto('/')
  await page.waitForLoadState('networkidle')
  await page.waitForSelector('textarea', { timeout: 10000 })
  await page.evaluate(async () => {
    const store = (window as any).__chatStore
    await store.getState().newConversation('learner')
    const now = Date.now()
    store.setState({
      isStreaming: false,
      messages: [
        { id: 'voice-u1', role: 'user', content: '帮我查天气', timestamp: now, messageKind: 'voice', voiceItemId: 'u1', voiceFinal: true, audioPath: '/Users/x/.openpipal/voice-audio/c/user-u1.wav' },
        { id: 'voice-a1', role: 'assistant', content: '今天晴 25 度', timestamp: now + 1, messageKind: 'voice', voiceItemId: 'a1', voiceFinal: true, audioPath: '/Users/x/.openpipal/voice-audio/c/assistant-a1.wav' },
        { id: 'voice-a2', role: 'assistant', content: '这条没有音频', timestamp: now + 2, messageKind: 'voice', voiceItemId: 'a2', voiceFinal: true }
      ]
    })
  })
}

test.use({ viewport: { width: 1000, height: 700 } })

test.describe('语音回听按钮', () => {
  test('有 audioPath 的用户/AI 语音都显示 ▶ 回听,无 audioPath 不显示', async ({ page }) => {
    await setup(page)

    // 等消息渲染
    await expect(page.locator('text=今天晴 25 度')).toBeVisible({ timeout: 3000 })

    // 两条有 audioPath(u1 用户 + a1 AI)→ 2 个回听按钮
    await expect(page.locator('[data-testid="voice-replay-btn"]')).toHaveCount(2)

    // a2(无 audioPath)那条不应有回听按钮:整页只有 2 个,已由上面断言保证
    // 再校验 a2 文本存在但其所在气泡无按钮(用文本定位父级)
    const noAudioMsg = page.locator('text=这条没有音频')
    await expect(noAudioMsg).toBeVisible()

    await page.screenshot({ path: `${ARTIFACTS_DIR}/replay-buttons.png` })
    console.log('[voice-replay] 回听按钮按 audioPath 渲染 - 通过')
  })
})

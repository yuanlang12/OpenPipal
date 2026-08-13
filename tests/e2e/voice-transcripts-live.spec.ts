import { test, expect, Page } from '@playwright/test'

const ARTIFACTS_DIR = 'tests/artifacts/voice-transcripts-live'

/**
 * P3a — Voice transcripts 实时进 chat 流（不再等挂断批量补登）
 *
 * 关键验证：
 * - upsertVoiceMessage(itemId, role, content, isFinal) 流式 upsert 到 chatStore.messages
 * - 同一 itemId 多次调用 = 更新同一条消息，不会重复
 * - 用户 transcript 和 AI transcript 都作为聊天消息出现，时序正确
 *
 * 实现策略：
 * - 直接通过 window.__chatStore 调用 store action（绕开 AudioEngine 麦克风权限）
 * - 验证 chatStore.messages 状态 + UI 渲染同步
 */
const MOCK_API = `
window.__mockBus = {
  listeners: {},
  on(event, fn) {
    if (!this.listeners[event]) this.listeners[event] = [];
    this.listeners[event].push(fn);
    return () => { this.listeners[event] = this.listeners[event].filter(f => f !== fn); };
  },
  emit(event, ...args) {
    (this.listeners[event] || []).forEach(fn => fn(...args));
  }
};
window.__mockCalls = [];
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
  createConversation: async (role) => ({ id: 'conv-test', title: '语音测试', role, createdAt: Date.now(), updatedAt: Date.now(), messageCount: 0 }),
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
  startRealtime: async () => ({ success: false }),  // 不真启动，避免麦克风权限
  stopRealtime: () => {},
  sendRealtimeEvent: () => {},
  onRealtimeEvent: () => () => {},
  onRealtimeState: () => () => {}
};
`

async function setup(page: Page): Promise<void> {
  await page.addInitScript({ content: MOCK_API })
  await page.goto('/')
  await page.waitForLoadState('networkidle')
  await page.waitForSelector('textarea', { timeout: 10000 })
  // 创建一个 conversation —— ensureVoiceConversation 需要 active conversation
  await page.evaluate(async () => {
    const store = (window as any).__chatStore
    await store.getState().newConversation('learner')
  })
}

// 这组测试不测窄侧栏视口，给 chat 面板足够空间
test.use({ viewport: { width: 1000, height: 700 } })

test.describe('P3a — Voice transcripts 实时进 chat 流', () => {
  test('upsertVoiceMessage 创建新 voice 消息', async ({ page }) => {
    await setup(page)

    await page.evaluate(() => {
      const store = (window as any).__chatStore
      store.getState().upsertVoiceMessage('user-1', 'user', '今天天气怎么样', true)
    })

    const messages = await page.evaluate(() => {
      return (window as any).__chatStore.getState().messages
    })
    expect(messages.length).toBeGreaterThanOrEqual(1)
    const userMsg = messages.find((m: any) => m.voiceItemId === 'user-1')
    expect(userMsg).toBeTruthy()
    expect(userMsg.content).toBe('今天天气怎么样')
    expect(userMsg.role).toBe('user')
    expect(userMsg.voiceFinal).toBe(true)
    expect(userMsg.messageKind).toBe('voice')

    // 渲染到 chat panel
    await expect(page.locator('text=今天天气怎么样')).toBeVisible({ timeout: 3000 })

    await page.screenshot({ path: `${ARTIFACTS_DIR}/p3a-user-final.png` })
    console.log('[P3a-1] user transcript 终态写入 chat - 通过')
  })

  test('同 itemId 多次 upsert 等于更新（不重复消息）', async ({ page }) => {
    await setup(page)

    // 流式：delta → delta → done，三次 upsert 应该只生成 1 条消息
    await page.evaluate(() => {
      const store = (window as any).__chatStore
      const upsert = store.getState().upsertVoiceMessage
      upsert('ai-1', 'assistant', '今天', false)
      upsert('ai-1', 'assistant', '今天旧金山', false)
      upsert('ai-1', 'assistant', '今天旧金山 64°F 晴天', true)
    })

    const messages = await page.evaluate(() => {
      return (window as any).__chatStore.getState().messages.filter((m: any) => m.voiceItemId === 'ai-1')
    })
    expect(messages.length).toBe(1)
    expect(messages[0].content).toBe('今天旧金山 64°F 晴天')
    expect(messages[0].voiceFinal).toBe(true)

    await expect(page.locator('text=今天旧金山 64°F 晴天')).toBeVisible({ timeout: 3000 })

    await page.screenshot({ path: `${ARTIFACTS_DIR}/p3a-stream-merged.png` })
    console.log('[P3a-2] 同 itemId 流式 upsert 不重复 - 通过')
  })

  test('用户消息 + AI 消息按时序交替进入 chat 流', async ({ page }) => {
    await setup(page)

    await page.evaluate(() => {
      const store = (window as any).__chatStore
      const upsert = store.getState().upsertVoiceMessage
      upsert('u1', 'user', '帮我查 SF 天气', true)
      upsert('a1', 'assistant', '今天 SF 64°F 晴天', true)
      upsert('u2', 'user', '那适合穿什么', true)
      upsert('a2', 'assistant', '建议穿薄外套', true)
    })

    const voiceMsgs = await page.evaluate(() => {
      return (window as any).__chatStore.getState().messages
        .filter((m: any) => m.voiceItemId)
        .map((m: any) => ({ id: m.voiceItemId, role: m.role, content: m.content }))
    })

    expect(voiceMsgs).toHaveLength(4)
    expect(voiceMsgs[0]).toMatchObject({ id: 'u1', role: 'user' })
    expect(voiceMsgs[1]).toMatchObject({ id: 'a1', role: 'assistant' })
    expect(voiceMsgs[2]).toMatchObject({ id: 'u2', role: 'user' })
    expect(voiceMsgs[3]).toMatchObject({ id: 'a2', role: 'assistant' })

    // 视觉上 4 条消息按顺序渲染
    await expect(page.locator('text=帮我查 SF 天气')).toBeVisible({ timeout: 3000 })
    await expect(page.locator('text=今天 SF 64°F 晴天')).toBeVisible()
    await expect(page.locator('text=那适合穿什么')).toBeVisible()
    await expect(page.locator('text=建议穿薄外套')).toBeVisible()

    await page.screenshot({ path: `${ARTIFACTS_DIR}/p3a-alternating.png` })
    console.log('[P3a-3] 交替消息按时序进 chat - 通过')
  })

  test('流式中的 delta 立即可见（不等 done）', async ({ page }) => {
    await setup(page)

    // 只发 delta 还没 done
    await page.evaluate(() => {
      const store = (window as any).__chatStore
      store.getState().upsertVoiceMessage('ai-mid', 'assistant', '我正在思考', false)
    })

    // 即便没 done，消息应该已可见
    await expect(page.locator('text=我正在思考')).toBeVisible({ timeout: 3000 })

    const state = await page.evaluate(() => {
      const msg = (window as any).__chatStore.getState().messages.find((m: any) => m.voiceItemId === 'ai-mid')
      return { content: msg?.content, voiceFinal: msg?.voiceFinal }
    })
    expect(state.content).toBe('我正在思考')
    expect(state.voiceFinal).toBe(false)

    await page.screenshot({ path: `${ARTIFACTS_DIR}/p3a-delta-visible.png` })
    console.log('[P3a-4] delta 阶段消息已渲染（无需等 done） - 通过')
  })
})

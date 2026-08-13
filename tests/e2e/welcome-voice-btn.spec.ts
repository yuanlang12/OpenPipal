import { test, expect, Page } from '@playwright/test'

const ARTIFACTS_DIR = 'tests/artifacts/voice-inline-start'

/**
 * WelcomePage 语音按钮 —— 修复"空欢迎页看不到语音入口"
 *
 * 验证：
 * - voiceAvailable=true 时，WelcomePage（空对话）显示语音按钮
 * - voiceAvailable=false 时，不显示（未配置语音服务）
 */
function mockApi(hasKey: boolean): string {
  return `
window.__mockBus = {
  listeners: {},
  on(event, fn) { (this.listeners[event] ||= []).push(fn); return () => {}; },
  emit(event, ...args) { (this.listeners[event] || []).forEach(fn => fn(...args)); }
};
window.api = {
  getLocaleState: async () => ({ preference: 'zh-CN', locale: 'zh-CN' }),
  sendChat: () => {}, abortChat: () => {},
  onStreamChunk: (cb) => window.__mockBus.on('stream-chunk', cb),
  onStreamEnd: (cb) => window.__mockBus.on('stream-end', cb),
  onTextFlush: (cb) => window.__mockBus.on('text-flush', cb),
  onToolStart: (cb) => window.__mockBus.on('tool-start', cb),
  onToolEnd: (cb) => window.__mockBus.on('tool-end', cb),
  onAskUser: (cb) => window.__mockBus.on('ask-user', cb),
  onTargetStatus: (cb) => window.__mockBus.on('target-status', cb),
  onAppChanged: (cb) => window.__mockBus.on('app-changed', cb),
  getRoleInitState: async () => ({ hasRole: true, role: { name: 'learner', displayName: '学习助手', icon: '📖' } }),
  getAllRoles: async () => [{ name: 'learner', displayName: '学习助手', icon: '📖' }],
  getCurrentRole: async () => ({ name: 'learner', displayName: '学习助手', icon: '📖' }),
  switchRole: async () => ({ name: 'learner', displayName: '学习助手', icon: '📖' }),
  listConversations: async () => [],
  createConversation: async (role) => ({ id: 'c1', title: '新对话', role, createdAt: Date.now(), updatedAt: Date.now(), messageCount: 0 }),
  getConversationMessages: async () => [],
  replaceMessages: async () => {}, appendMessages: async () => {}, deleteConversation: async () => {},
  getAppSettings: async () => ({ detected: [], disabled: [], browsers: [] }),
  isCustomConfig: async () => ({ isCustom: false }),
  getAvailableModels: async () => [],
  getModelConfig: async () => ({ provider: 'openai', baseUrl: '', apiKey: '', model: '' }),
  getModelConfigFull: async () => ({ provider: 'openai', baseUrl: '', apiKey: '', model: 'gpt-4o' }),
  listSkills: async () => [],
  getRealtimeConfig: async () => ({ provider: 'openai', url: '', model: '', deployment: '', apiVersion: '', voice: 'alloy', hasKey: ${hasKey} }),
  startRealtime: async () => ({ success: false }),
  stopRealtime: () => {}, sendRealtimeEvent: () => {},
  onRealtimeEvent: () => () => {}, onRealtimeState: () => () => {}
};
`
}

async function boot(page: Page, hasKey: boolean): Promise<void> {
  await page.addInitScript({ content: mockApi(hasKey) })
  await page.goto('/')
  await page.waitForLoadState('networkidle')
  await page.waitForSelector('textarea', { timeout: 10000 })
}

test.use({ viewport: { width: 1000, height: 700 } })

test.describe('WelcomePage 语音按钮', () => {
  test('voiceAvailable=true 时欢迎页显示语音按钮', async ({ page }) => {
    await boot(page, true)
    const btn = page.locator('[data-testid="voice-inline-start"]')
    await expect(btn).toBeVisible({ timeout: 3000 })
    await expect(btn).toHaveAttribute('title', '语音对话')
    await page.screenshot({ path: `${ARTIFACTS_DIR}/welcome-voice-visible.png` })
    console.log('[welcome-voice-1] 配置语音后欢迎页有按钮 - 通过')
  })

  test('voiceAvailable=false 时不显示', async ({ page }) => {
    await boot(page, false)
    await expect(page.locator('[data-testid="voice-inline-start"]')).toHaveCount(0)
    console.log('[welcome-voice-2] 未配置语音时不显示 - 通过')
  })
})

import { test, expect, Page } from '@playwright/test'

/**
 * 上下文用量圆环 — InputBar 里的 16px SVG 进度环。
 *
 * 验证：
 * - 会话还没发过消息（无 context_usage 事件）：圆环不渲染
 * - main 进程发来 context_usage 事件（cid 匹配当前会话）：圆环出现，title 含用量文案
 * - compacted=true：title 追加"已压缩生效"，圆环旁出现压缩微标
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
  getLocaleState: async () => ({ preference: 'zh-CN', locale: 'zh-CN' }),
  sendChat: (...args) => { window.__mockCalls.push({ method: 'sendChat', args }); },
  abortChat: () => { window.__mockCalls.push({ method: 'abortChat' }); },
  onStreamChunk: (cb) => window.__mockBus.on('stream-chunk', cb),
  onStreamEnd: (cb) => window.__mockBus.on('stream-end', cb),
  onTextFlush: (cb) => window.__mockBus.on('text-flush', cb),
  onThinking: (cb) => window.__mockBus.on('thinking', cb),
  onThinkingEnd: (cb) => window.__mockBus.on('thinking-end', cb),
  onToolStart: (cb) => window.__mockBus.on('tool-start', cb),
  onToolProgress: (cb) => window.__mockBus.on('tool-progress', cb),
  onToolEnd: (cb) => window.__mockBus.on('tool-end', cb),
  onAskUser: (cb) => window.__mockBus.on('ask-user', cb),
  onQuestionsV2: (cb) => window.__mockBus.on('questions-v2', cb),
  onArtifact: (cb) => window.__mockBus.on('artifact', cb),
  onArtifactDelta: (cb) => window.__mockBus.on('artifact-delta', cb),
  onVisualizer: (cb) => window.__mockBus.on('visualizer', cb),
  onVisualizerDelta: (cb) => window.__mockBus.on('visualizer-delta', cb),
  onMcpAppInline: (cb) => window.__mockBus.on('mcp-app-inline', cb),
  onTargetStatus: (cb) => window.__mockBus.on('target-status', cb),
  onAppChanged: (cb) => window.__mockBus.on('app-changed', cb),
  onMemoryUpdated: (cb) => window.__mockBus.on('memory-updated', cb),
  onConvTitleUpdated: (cb) => window.__mockBus.on('conv-title-updated', cb),
  onInlinePermission: (cb) => window.__mockBus.on('inline-permission', cb),
  onPermissionRequest: (cb) => window.__mockBus.on('permission-request', cb),
  onContextUsage: (cb) => window.__mockBus.on('context-usage', cb),
  respondPermission: () => {},
  pasteToTarget: async () => ({ success: true }),
  hasApiKey: async () => ({ hasKey: true }),
  getRoleInitState: async () => ({ hasRole: true, role: { name: 'learner', displayName: '学习助手', icon: '📖' } }),
  getAllRoles: async () => [{ name: 'learner', displayName: '学习助手', icon: '📖' }],
  getCurrentRole: async () => ({ name: 'learner', displayName: '学习助手', icon: '📖' }),
  switchRole: async () => ({ name: 'learner', displayName: '学习助手', icon: '📖' }),
  listConversations: async () => [],
  createConversation: async (role) => ({ id: 'conv-ctx', title: 'Context 测试', role, createdAt: Date.now(), updatedAt: Date.now(), messageCount: 0 }),
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
  listSkills: async () => [],
  listWorkspaces: async () => [],
  listAgentTemplates: async () => [],
  getOnboardingStatus: async () => ({ completed: true }),
  setOnboardingCompleted: async () => {},
  getRealtimeConfig: async () => ({ provider: 'openai', url: '', model: '', deployment: '', apiVersion: '', voice: 'alloy', hasKey: false }),
};
`

async function setup(page: Page): Promise<void> {
  await page.addInitScript({ content: MOCK_API })
  await page.goto('/')
  await page.waitForLoadState('networkidle')
  await page.waitForSelector('textarea', { timeout: 10000 })
  // 让 view 切到 ChatPanel（InputBar 渲染处）——同 pending-messages.spec.ts 套路
  await page.evaluate(async () => {
    const store = (window as any).__chatStore
    await store.getState().newConversation('learner')
    store.setState({
      messages: [{ id: 'init', role: 'user', content: 'hi', timestamp: Date.now() }]
    })
  })
  await page.locator('textarea').waitFor({ timeout: 5000 })
}

test.use({ viewport: { width: 600, height: 700 } })

test.describe('上下文用量圆环 (context ring)', () => {
  test('会话还没发过消息：圆环不渲染', async ({ page }) => {
    await setup(page)
    await expect(page.locator('[data-testid="context-ring"]')).toHaveCount(0)
  })

  test('main 发来 context_usage → 圆环出现，title 含用量文案', async ({ page }) => {
    await setup(page)
    await page.evaluate(() => {
      ;(window as any).__mockBus.emit('context-usage', 'conv-ctx', {
        promptTokens: 42000,
        contextWindow: 131072,
        budget: 99072,
        compacted: false
      })
    })
    const ring = page.locator('[data-testid="context-ring"]')
    await expect(ring).toHaveCount(1)
    const title = await ring.getAttribute('title')
    expect(title).toContain('上下文')
    expect(title).toContain('42.0k')
    expect(title).toContain('131.1k')
    expect(title).not.toContain('已压缩生效')
    // 未压缩时不应有压缩微标
    await expect(page.locator('[data-testid="context-ring-compacted"]')).toHaveCount(0)
  })

  test('compacted=true → title 追加"已压缩生效" + 圆环旁出现压缩微标', async ({ page }) => {
    await setup(page)
    await page.evaluate(() => {
      ;(window as any).__mockBus.emit('context-usage', 'conv-ctx', {
        promptTokens: 105000,
        contextWindow: 131072,
        budget: 99072,
        compacted: true
      })
    })
    const ring = page.locator('[data-testid="context-ring"]')
    await expect(ring).toHaveCount(1)
    const title = await ring.getAttribute('title')
    expect(title).toContain('已压缩生效')
    await expect(page.locator('[data-testid="context-ring-compacted"]')).toHaveCount(1)
  })

  test('不同会话的 context_usage 事件（cid 不匹配）不影响当前圆环显示', async ({ page }) => {
    await setup(page)
    await page.evaluate(() => {
      ;(window as any).__mockBus.emit('context-usage', 'other-conv', {
        promptTokens: 1000,
        contextWindow: 131072,
        budget: 99072,
        compacted: false
      })
    })
    // 未发生在当前会话的用量事件，仍会写入 store（按 cid 隔离存储），但当前会话没有数据 → 不渲染
    await expect(page.locator('[data-testid="context-ring"]')).toHaveCount(0)
  })
})

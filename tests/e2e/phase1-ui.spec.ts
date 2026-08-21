import { test, expect, Page } from '@playwright/test'
import { bootstrapChat } from './helpers'

const ARTIFACTS_DIR = 'tests/artifacts/phase1-ui'

// ============================================================
// Mock：完整 mock 包含 Settings 所需 API
// ============================================================
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
  sendChat: (messages) => { window.__mockCalls.push({ method: 'sendChat', args: messages }); },
  abortChat: () => { window.__mockCalls.push({ method: 'abortChat' }); },
  onStreamChunk: (cb) => window.__mockBus.on('stream-chunk', cb),
  onStreamEnd: (cb) => window.__mockBus.on('stream-end', cb),
  onTextFlush: (cb) => window.__mockBus.on('text-flush', cb),
  onToolStart: (cb) => window.__mockBus.on('tool-start', cb),
  onToolEnd: (cb) => window.__mockBus.on('tool-end', cb),
  onAskUser: (cb) => window.__mockBus.on('ask-user', cb),
  onTargetStatus: (cb) => window.__mockBus.on('target-status', cb),
  onAppChanged: (cb) => window.__mockBus.on('app-changed', cb),
  pasteToTarget: async () => ({ success: true }),
  getRoleInitState: async () => ({
    hasRole: true,
    role: { name: 'learner', displayName: '学习助手', icon: '📖' }
  }),
  getAllRoles: async () => [
    { name: 'learner', displayName: '学习助手', icon: '📖' },
    { name: 'teacher', displayName: '教师助手', icon: '🎓' },
    { name: 'office', displayName: '办公助手', icon: '💼' }
  ],
  getCurrentRole: async () => ({ name: 'learner', displayName: '学习助手', icon: '📖' }),
  switchRole: async (name) => {
    const map = {
      learner: { name: 'learner', displayName: '学习助手', icon: '📖' },
      teacher: { name: 'teacher', displayName: '教师助手', icon: '🎓' },
      office: { name: 'office', displayName: '办公助手', icon: '💼' }
    };
    return map[name] || map.learner;
  },
  listConversations: async () => [],
  createConversation: async (role) => ({ id: 'mock-conv-' + Date.now(), title: '新对话', role, createdAt: Date.now(), updatedAt: Date.now(), messageCount: 0 }),
  getConversationMessages: async () => [],
  replaceMessages: async () => {},
  appendMessages: async () => {},
  deleteConversation: async () => {},
  // Settings 相关 API
  getAppSettings: async () => ({
    detected: ['Xcode', 'Notion', 'WPS Office'],
    disabled: ['WPS Office'],
    browsers: ['Google Chrome', 'Safari']
  }),
  setDisabledApps: async () => {},
  isCustomConfig: async () => ({ isCustom: false }),
  getModelConfig: async () => ({ provider: 'openai', baseUrl: 'https://api.openai.com/v1', apiKey: 'sk-***masked***', model: 'gpt-4o' }),
  getModelConfigFull: async () => ({ provider: 'openai', baseUrl: 'https://api.openai.com/v1', apiKey: 'sk-test', model: 'gpt-4o' }),
  saveModelConfig: async () => {},
  testConnection: async () => ({ ok: true, model: 'gpt-4o' }),
  getProviders: async () => ({}),
  clearModelConfig: async () => {},
  // Realtime voice
  getRealtimeConfig: async () => ({ url: '', model: '', hasKey: false }),
  startRealtime: async () => ({ success: false }),
  stopRealtime: () => {},
  sendRealtimeEvent: () => {},
  onRealtimeEvent: () => () => {},
  onRealtimeState: () => () => {},
};
`

// Mock: 慢初始化（用于骨架屏测试）
const MOCK_SLOW_INIT = `
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
  // 延迟返回以模拟加载中
  getRoleInitState: () => new Promise(resolve => setTimeout(() => resolve({
    hasRole: true,
    role: { name: 'learner', displayName: '学习助手', icon: '📖' }
  }), 1500)),
  getAllRoles: () => new Promise(resolve => setTimeout(() => resolve([
    { name: 'learner', displayName: '学习助手', icon: '📖' },
    { name: 'teacher', displayName: '教师助手', icon: '🎓' },
    { name: 'office', displayName: '办公助手', icon: '💼' }
  ]), 1500)),
  getCurrentRole: async () => ({ name: 'learner', displayName: '学习助手', icon: '📖' }),
  switchRole: async (name) => ({ name, displayName: name, icon: '📖' }),
  listConversations: async () => [],
  createConversation: async (role) => ({ id: 'c1', title: '新对话', role, createdAt: Date.now(), updatedAt: Date.now(), messageCount: 0 }),
  getConversationMessages: async () => [],
  replaceMessages: async () => {},
  appendMessages: async () => {},
  deleteConversation: async () => {},
  getRealtimeConfig: async () => ({ url: '', model: '', hasKey: false }),
  startRealtime: async () => ({ success: false }),
  stopRealtime: () => {},
  sendRealtimeEvent: () => {},
  onRealtimeEvent: () => () => {},
  onRealtimeState: () => () => {},
};
`

async function setup(page: Page) {
  await page.addInitScript({ content: MOCK_API })
  await page.goto('/')
  await page.waitForLoadState('networkidle')
  // App 启动停在 WelcomePage(messages 为空)——bootstrapChat 建会话 + 塞一条初始消息
  // 把 WelcomePage 挤掉,让 ChatPanel 挂载。
  await bootstrapChat(page, {
    role: 'learner',
    messages: [{ id: 'msg-init', role: 'user', content: '初始化', timestamp: Date.now() - 60000 }]
  })
}

// ============================================================
// 1.5 骨架屏
// ============================================================
test.describe('1.5 骨架屏', () => {
  test('初始化期间显示骨架屏', async ({ page }) => {
    await page.addInitScript({ content: MOCK_SLOW_INIT })
    await page.goto('/')

    // 骨架屏应该立刻可见
    const skeleton = page.locator('[data-testid="skeleton"]')
    await expect(skeleton).toBeVisible({ timeout: 3000 })
    await page.screenshot({ path: `${ARTIFACTS_DIR}/skeleton-visible.png` })

    // 骨架屏有 animate-pulse
    const cls = await skeleton.getAttribute('class')
    expect(cls).toContain('animate-pulse')

    // 等待初始化完成后骨架屏消失
    await page.waitForSelector('textarea', { timeout: 5000 })
    await expect(skeleton).not.toBeVisible()

    await page.screenshot({ path: `${ARTIFACTS_DIR}/skeleton-gone.png` })
    console.log('[1.5] 骨架屏测试 - 通过')
  })
})


// ============================================================
// 1.4 工具卡片默认折叠 + 摘要
// ============================================================
test.describe('1.4 工具卡片折叠与摘要', () => {
  test('工具卡片默认折叠且显示结果摘要', async ({ page }) => {
    await setup(page)

    // 发消息
    const textarea = page.locator('textarea')
    await textarea.fill('记住这个')
    const sendButton = page.locator('[data-testid="send-btn"]')
    await sendButton.click()

    // 模拟 save_memory 工具调用（普通 MCP 工具 → ToolCallCard）
    // onToolEnd 签名: (cid, name, screenshot, searchResults, mcpResult, mcpArgs)
    await page.evaluate(() => window.__mockBus.emit('tool-start', '', 'save_memory'))
    await page.waitForTimeout(200)
    await page.evaluate(() => window.__mockBus.emit('text-flush', ''))
    await page.waitForTimeout(100)
    await page.evaluate(() => window.__mockBus.emit(
      'tool-end', '', 'save_memory',
      undefined,    // screenshot
      undefined,    // searchResults
      '成功保存记忆：线性代数学习进度',  // mcpResult
      '{"topic":"线性代数","summary":"学习进度"}' // mcpArgs
    ))
    await page.waitForTimeout(200)
    await page.evaluate(() => window.__mockBus.emit('stream-chunk', '', '已记住。'))
    await page.evaluate(() => window.__mockBus.emit('stream-end', ''))
    await page.waitForTimeout(500)

    // turn 完成后过程性消息(含无交付物标记的 tool)按 focus 模式折进 ProcessGroup——
    // 先展开过程组，工具卡片标题才可见
    await page.locator('[data-testid="process-group-toggle"]').first().click()
    await page.waitForTimeout(200)

    // 工具卡片标题可见
    const toolCard = page.locator('text=保存记忆').first()
    await expect(toolCard).toBeVisible({ timeout: 3000 })

    // 默认折叠 — 展开后的 输入/输出 标签不可见(spec 锁 zh-CN,按中文文案断言)
    const outputLabel = page.locator('text=输出')
    await expect(outputLabel).toHaveCount(0)

    await page.screenshot({ path: `${ARTIFACTS_DIR}/tool-card-collapsed.png` })

    // 点击展开
    await toolCard.click()
    await page.waitForTimeout(300)

    // 展开后可见 输入/输出
    await expect(page.locator('text=输出').first()).toBeVisible()

    await page.screenshot({ path: `${ARTIFACTS_DIR}/tool-card-expanded.png` })
    console.log('[1.4] 工具卡片折叠摘要 - 通过')
  })
})


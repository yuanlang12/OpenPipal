import { test, expect, Page } from '@playwright/test'

const ARTIFACTS_DIR = 'tests/artifacts/message-order'

/**
 * 文字模式消息插入顺序 — 工具卡必须排在「触发它的 thinking」之后,不能冒到推理上面。
 *
 * 复现的 bug:
 * - onToolStart 旧逻辑把工具锚点 splice 到「最近一条 user 消息」之后(insertIdx = userIdx + 1)
 * - thinking 消息 role 是 'assistant'(不是 'user'),append 在 user 之后
 * - 于是 [user, thinking] 来了 tool-start → 工具被插到 user 之后、thinking 之前 → [user, tool, thinking]
 * - ProcessGroup 按数组序渲染 → 搜索结果卡冒到推理文字上方
 *
 * 修复:onToolStart 改为 append 到末尾(与 onThinking/onStreamEnd/onAskUser 等一致)→ [user, thinking, tool]
 */
const MOCK_API = `
window.__mockBus = {
  listeners: {},
  on(event, fn) {
    if (!this.listeners[event]) this.listeners[event] = [];
    this.listeners[event].push(fn);
    return () => { this.listeners[event] = this.listeners[event].filter(f => f !== fn); };
  },
  emit(event, ...args) { (this.listeners[event] || []).forEach(fn => fn(...args)); }
};
window.api = {
  sendChat: () => {},
  abortChat: () => {},
  onStreamChunk: (cb) => window.__mockBus.on('stream-chunk', cb),
  onStreamEnd: (cb) => window.__mockBus.on('stream-end', cb),
  onTextFlush: (cb) => window.__mockBus.on('text-flush', cb),
  onThinking: (cb) => window.__mockBus.on('thinking', cb),
  onThinkingEnd: (cb) => window.__mockBus.on('thinking-end', cb),
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
  createConversation: async (role) => ({ id: 'conv-test', title: '顺序测试', role, createdAt: Date.now(), updatedAt: Date.now(), messageCount: 0 }),
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
  getRealtimeConfig: async () => ({ provider: 'openai', url: '', model: '', deployment: '', apiVersion: '', voice: 'alloy', hasKey: false }),
  startRealtime: async () => ({ success: false }),
  stopRealtime: () => {},
  sendRealtimeEvent: () => {},
  onRealtimeEvent: () => () => {},
  onRealtimeState: () => () => {}
};
`

const THINK = '用户问 Claude 最新进展。我先尝试 web_search,可能之前是临时故障,让我再试一次。'

async function setup(page: Page): Promise<void> {
  await page.addInitScript({ content: MOCK_API })
  await page.goto('/')
  await page.waitForLoadState('networkidle')
  await page.waitForSelector('textarea', { timeout: 10000 })
  await page.evaluate(async (think) => {
    const store = (window as any).__chatStore
    await store.getState().newConversation('learner')
    const now = Date.now()
    // 前置:用户提问 + AI 已经在推理(thinking 已 append 在 user 之后)。还没调工具。
    store.setState({
      isStreaming: true,
      messages: [
        { id: 'u1', role: 'user', content: 'Claude 最近有什么新的进展', timestamp: now, messageKind: 'user' },
        { id: 't1', role: 'assistant', content: '', thinkingContent: think, timestamp: now + 100, messageKind: 'thinking' }
      ]
    })
  }, THINK)
}

test.use({ viewport: { width: 1000, height: 760 } })

test.describe('文字模式消息插入顺序', () => {
  test('tool-start 在 thinking 之后 append,不冒到推理上面', async ({ page }) => {
    await setup(page)

    // AI 推理完毕 → 调 web_search(走真实 onToolStart 处理器)
    await page.evaluate(() => {
      window.__mockBus.emit('tool-start', '', 'web_search')
    })

    const afterStart = await page.evaluate(() =>
      (window as any).__chatStore.getState().messages.map((m: any) => ({ role: m.role, kind: m.messageKind, tool: m.toolName }))
    )
    // 期望:[user, thinking, tool] —— tool 是最后一条(在 thinking 之后)
    // bug 时是:[user, tool, thinking] —— tool 冒到 thinking 前面
    expect(afterStart).toHaveLength(3)
    expect(afterStart[0]).toMatchObject({ role: 'user' })
    expect(afterStart[1]).toMatchObject({ kind: 'thinking' })
    expect(afterStart[2]).toMatchObject({ kind: 'tool', tool: 'web_search' })

    // tool-end 带结果 → 工具卡渲染,位置不变(仍在 thinking 之后)
    await page.evaluate(() => {
      window.__mockBus.emit('tool-end', '', 'web_search', undefined, '1. **Claude** 最新进展\\n   https://example.com\\n   摘要', undefined, undefined, undefined)
    })

    const finalMsgs = await page.evaluate(() =>
      (window as any).__chatStore.getState().messages.map((m: any) => ({ kind: m.messageKind, tool: m.toolName, hasSearch: !!m.searchResults }))
    )
    const thinkIdx = finalMsgs.findIndex((m: any) => m.kind === 'thinking')
    const toolIdx = finalMsgs.findIndex((m: any) => m.kind === 'tool')
    expect(thinkIdx).toBeGreaterThanOrEqual(0)
    expect(toolIdx).toBeGreaterThan(thinkIdx)  // 工具卡在推理之后
    expect(finalMsgs[toolIdx].hasSearch).toBe(true)

    // DOM:进行中(isStreaming)→ ProcessGroup 默认展开;推理文字应在搜索结果卡之上
    await expect(page.locator('[data-testid="process-thinking-flat"]')).toBeVisible({ timeout: 3000 })
    const tops = await page.evaluate(() => {
      const flat = document.querySelector('[data-testid="process-thinking-flat"]') as HTMLElement | null
      const all = Array.from(document.querySelectorAll('*')) as HTMLElement[]
      const searchEl = all.find(e => e.children.length === 0 && e.textContent?.includes('搜索结果'))
      return {
        think: flat ? flat.getBoundingClientRect().top : -1,
        search: searchEl ? searchEl.getBoundingClientRect().top : -1
      }
    })
    expect(tops.think).toBeGreaterThan(0)
    expect(tops.search).toBeGreaterThan(0)
    expect(tops.think).toBeLessThan(tops.search)  // 推理在搜索结果上方

    await page.screenshot({ path: `${ARTIFACTS_DIR}/thinking-then-tool.png` })
    console.log('[message-order] 工具卡 append 在 thinking 之后 - 通过')
  })
})

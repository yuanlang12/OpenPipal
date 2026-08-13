import { test, expect, Page } from '@playwright/test'

const ARTIFACTS_DIR = 'tests/artifacts/pending-messages'

/**
 * 消息插队（mid-loop injection）— Pi 框架 agent.steer / agent.followUp 的 UI 体验。
 *
 * 验证：
 * - Idle: 输入框上方没有挂起卡片；Enter = 直接发送
 * - Streaming: Enter = 挂起卡片（不发送）
 * - 卡片「⤴ 引导」按钮 → 调 window.api.steerChat → 卡片移除
 * - 卡片「🗑」按钮 → 直接移除，不调任何 IPC
 * - 自然 stream-end → 自动调 window.api.queueChat 把全部 pending FIFO 跟单
 * - 用户主动 abort 触发的 stream-end → pending 保留，不自动 flush
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
  steerChat: async (cid, text, images) => {
    window.__mockCalls.push({ method: 'steerChat', args: { cid, text, images } });
    return { ok: true };
  },
  queueChat: async (cid, text, images) => {
    window.__mockCalls.push({ method: 'queueChat', args: { cid, text, images } });
    return { ok: true };
  },
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
  respondPermission: () => {},
  pasteToTarget: async () => ({ success: true }),
  hasApiKey: async () => ({ hasKey: true }),
  getRoleInitState: async () => ({ hasRole: true, role: { name: 'learner', displayName: '学习助手', icon: '📖' } }),
  getAllRoles: async () => [{ name: 'learner', displayName: '学习助手', icon: '📖' }],
  getCurrentRole: async () => ({ name: 'learner', displayName: '学习助手', icon: '📖' }),
  switchRole: async () => ({ name: 'learner', displayName: '学习助手', icon: '📖' }),
  listConversations: async () => [],
  createConversation: async (role) => ({ id: 'conv-pending', title: 'Pending 测试', role, createdAt: Date.now(), updatedAt: Date.now(), messageCount: 0 }),
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
  // 让 view 切到 ChatPanel（InputBar 渲染处）
  await page.evaluate(async () => {
    const store = (window as any).__chatStore
    await store.getState().newConversation('learner')
    // 注入一条消息让 WelcomePage 让位
    store.setState({
      messages: [{ id: 'init', role: 'user', content: 'hi', timestamp: Date.now() }]
    })
  })
  await page.locator('textarea').waitFor({ timeout: 5000 })
}

/** 把 chatStore 推到"流式中"状态，模拟 agent 正在跑（不需要真实 main 进程） */
async function setStreaming(page: Page, streaming: boolean): Promise<void> {
  await page.evaluate((s) => {
    ;(window as any).__chatStore.setState({ isStreaming: s })
  }, streaming)
}

async function typeAndSend(page: Page, text: string): Promise<void> {
  const textarea = page.locator('textarea').first()
  await textarea.fill(text)
  await page.locator('[data-testid="send-btn"]').click()
}

test.use({ viewport: { width: 600, height: 700 } })

test.describe('消息插队 (pending messages)', () => {
  test('idle 状态：没有挂起卡片', async ({ page }) => {
    await setup(page)
    await expect(page.locator('[data-testid="pending-message-stack"]')).toHaveCount(0)
  })

  test('streaming 中输入 → 卡片堆叠到输入框上方', async ({ page }) => {
    await setup(page)
    await setStreaming(page, true)
    await typeAndSend(page, '第一条挂起')
    await typeAndSend(page, '第二条挂起')

    const cards = page.locator('[data-testid="pending-message-card"]')
    await expect(cards).toHaveCount(2)
    await expect(cards.first()).toContainText('第一条挂起')
    await expect(cards.nth(1)).toContainText('第二条挂起')

    // 没有真发出去（sendChat 不该被调）
    const calls = await page.evaluate(() => (window as any).__mockCalls.filter((c: any) => c.method === 'sendChat'))
    expect(calls.length).toBe(0)

    // 宽度契约：挂起卡片必须落在输入框容器（max-w-880 居中）的水平范围内，不得比输入框宽
    const rects = await page.evaluate(() => {
      const card = document.querySelector('[data-testid="pending-message-card"]')!
      const ta = document.querySelector('textarea')!
      const box = ta.closest('.rounded-xl') || ta
      const c = card.getBoundingClientRect()
      const b = box.getBoundingClientRect()
      return { cardL: c.left, cardR: c.right, boxL: b.left, boxR: b.right }
    })
    expect(rects.cardL).toBeGreaterThanOrEqual(rects.boxL - 1)
    expect(rects.cardR).toBeLessThanOrEqual(rects.boxR + 1)

    await page.screenshot({ path: `${ARTIFACTS_DIR}/01-stacked.png` })
  })

  test('点「⤴ 引导」→ 卡片消失；右侧 user bubble + 紧跟独立左侧"已引导对话"通知行', async ({ page }) => {
    await setup(page)
    await setStreaming(page, true)
    await typeAndSend(page, '立即送这一条')

    await page.evaluate(() => { (window as any).__mockCalls = [] })  // 清干净
    await page.locator('[data-testid="pending-send-now-btn"]').first().click()
    await page.waitForTimeout(100)

    const steerCalls = await page.evaluate(() =>
      (window as any).__mockCalls.filter((c: any) => c.method === 'steerChat')
    )
    expect(steerCalls.length).toBe(1)
    expect(steerCalls[0].args.text).toBe('立即送这一条')
    await expect(page.locator('[data-testid="pending-message-card"]')).toHaveCount(0)

    // messages[] 应有：(1) 普通 user message (2) 紧跟的 inject-notice
    const tail = await page.evaluate(() => {
      const msgs = (window as any).__chatStore.getState().messages
      return msgs.slice(-2)
    })
    expect(tail[0].role).toBe('user')
    expect(tail[0].content).toBe('立即送这一条')
    expect(tail[0].messageKind).toBe('user')  // 正常 user message，不混 inject 标记
    expect(tail[1].messageKind).toBe('inject-notice')
    expect(tail[1].messageSubtype).toBe('steer')
    expect(tail[1].content).toContain('已引导对话')

    // DOM：左对齐通知行可见
    const notice = page.locator('[data-testid="inject-notice"][data-subtype="steer"]')
    await expect(notice).toBeVisible()
    await expect(notice).toContainText('已引导对话')

    await page.screenshot({ path: `${ARTIFACTS_DIR}/02-steered.png` })
  })

  test('点「🗑」→ 卡片移除，不发任何 IPC', async ({ page }) => {
    await setup(page)
    await setStreaming(page, true)
    await typeAndSend(page, '想删的')

    await page.evaluate(() => { (window as any).__mockCalls = [] })
    await page.locator('[data-testid="pending-remove-btn"]').first().click()
    await page.waitForTimeout(50)

    const ipcCalls = await page.evaluate(() =>
      (window as any).__mockCalls.filter((c: any) =>
        c.method === 'sendChat' || c.method === 'steerChat' || c.method === 'queueChat'
      )
    )
    expect(ipcCalls.length).toBe(0)
    await expect(page.locator('[data-testid="pending-message-card"]')).toHaveCount(0)
  })

  test('agent 自然结束 → 自动跟单全部 pending；每条 = user bubble + 紧跟"已加入跟单队列"通知', async ({ page }) => {
    await setup(page)
    await setStreaming(page, true)
    await typeAndSend(page, '排队 A')
    await typeAndSend(page, '排队 B')

    await page.evaluate(() => { (window as any).__mockCalls = [] })
    // 模拟 main 发来 stream-end
    await page.evaluate(() => {
      ;(window as any).__mockBus.emit('stream-end', 'conv-pending', undefined)
    })
    await page.waitForTimeout(300)

    const queueCalls = await page.evaluate(() =>
      (window as any).__mockCalls.filter((c: any) => c.method === 'queueChat')
    )
    expect(queueCalls.length).toBe(2)
    expect(queueCalls[0].args.text).toBe('排队 A')
    expect(queueCalls[1].args.text).toBe('排队 B')
    await expect(page.locator('[data-testid="pending-message-card"]')).toHaveCount(0)

    // 末 4 条 = 排队A + notice + 排队B + notice
    const tail = await page.evaluate(() => {
      const msgs = (window as any).__chatStore.getState().messages
      return msgs.slice(-4)
    })
    expect(tail[0].role).toBe('user')
    expect(tail[0].content).toBe('排队 A')
    expect(tail[1].messageKind).toBe('inject-notice')
    expect(tail[1].messageSubtype).toBe('queue')
    expect(tail[2].role).toBe('user')
    expect(tail[2].content).toBe('排队 B')
    expect(tail[3].messageKind).toBe('inject-notice')

    await expect(page.locator('[data-testid="inject-notice"][data-subtype="queue"]')).toHaveCount(2)
  })

  test('用户 abort → pending 保留，不自动 flush', async ({ page }) => {
    await setup(page)
    await setStreaming(page, true)
    await typeAndSend(page, '我先挂着')

    await page.evaluate(() => { (window as any).__mockCalls = [] })
    // 用户点 Stop → 经 abortChat → 立刻发 stream-end
    await page.locator('[data-testid="stop-btn"]').click()
    await page.evaluate(() => {
      ;(window as any).__mockBus.emit('stream-end', 'conv-pending', undefined)
    })
    await page.waitForTimeout(200)

    const queueCalls = await page.evaluate(() =>
      (window as any).__mockCalls.filter((c: any) => c.method === 'queueChat')
    )
    expect(queueCalls.length).toBe(0)
    // 卡片应保留
    await expect(page.locator('[data-testid="pending-message-card"]')).toHaveCount(1)
    await expect(page.locator('[data-testid="pending-message-card"]')).toContainText('我先挂着')
  })
})

import { test, expect, Page } from '@playwright/test'

/**
 * 上下文用量信息卡 —— 输入框圆环 hover 展开。
 *
 * 验证：
 * - context_usage 带 usage/segments → hover 圆环出现卡片：总量、分区条、命中率（会话累计口径）
 * - 第二次事件数字实时刷新（每次 LLM 调用更新一次）
 * - getTodayUsage 返回 → "今日用量"列出模型与 token（有定价时附成本）
 * - runtime-context 快照事件 → store 插入隐藏消息且 UI 不渲染
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
window.__todayUsageRows = [
  { model: 'glm-5.3', prompt: 123000, output: 8000, cacheRead: 110000, calls: 24, cost: 0.0421 },
  { model: 'ds-flash', prompt: 900, output: 100, cacheRead: 0, calls: 1, cost: 0 }
];

window.api = {
  getLocaleState: async () => ({ preference: 'zh-CN', locale: 'zh-CN' }),
  sendChat: (...args) => { window.__mockCalls.push({ method: 'sendChat', args }); },
  abortChat: () => {},
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
  onRuntimeContext: (cb) => window.__mockBus.on('runtime-context', cb),
  getTodayUsage: async () => window.__todayUsageRows,
  respondPermission: () => {},
  pasteToTarget: async () => ({ success: true }),
  hasApiKey: async () => ({ hasKey: true }),
  getRoleInitState: async () => ({ hasRole: true, role: { name: 'learner', displayName: '学习助手', icon: '📖' } }),
  getAllRoles: async () => [{ name: 'learner', displayName: '学习助手', icon: '📖' }],
  getCurrentRole: async () => ({ name: 'learner', displayName: '学习助手', icon: '📖' }),
  switchRole: async () => ({ name: 'learner', displayName: '学习助手', icon: '📖' }),
  listConversations: async () => window.__stubConvs || [],
  createConversation: async (role) => ({ id: 'conv-card', title: 'Card 测试', role, createdAt: Date.now(), updatedAt: Date.now(), messageCount: 0 }),
  getConversationMessages: async (id) => id === 'conv-old'
    ? [{ id: 'm1', role: 'user', content: '早前的问题', timestamp: 1 }]
    : [],
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
  await page.evaluate(async () => {
    const store = (window as any).__chatStore
    await store.getState().newConversation('learner')
    store.setState({
      messages: [{ id: 'u1', role: 'user', content: '第一问', timestamp: Date.now() }]
    })
  })
  await page.locator('textarea').waitFor({ timeout: 5000 })
}

function emitUsage(page: Page, promptTokens: number, usage: { input: number; cacheRead: number; cacheWrite: number }) {
  return page.evaluate(({ promptTokens, usage }) => {
    ;(window as any).__mockBus.emit('context-usage', 'conv-card', {
      promptTokens,
      contextWindow: 131072,
      budget: 99072,
      compacted: false,
      usage,
      // 主进程口径：messages = promptTokens - 其余各项（余量由发射侧算好）
      segments: { systemPrompt: 900, skills: 300, toolsBuiltin: 1500, toolsMcp: 200, messages: Math.max(0, promptTokens - 2900) }
    })
  }, { promptTokens, usage })
}

test.use({ viewport: { width: 600, height: 700 } })

test.describe('上下文用量信息卡 (context usage card)', () => {
  test('hover 圆环展开卡片：总量、分区、累计命中率、今日用量', async ({ page }) => {
    await setup(page)
    await emitUsage(page, 42000, { input: 1000, cacheRead: 0, cacheWrite: 3000 })
    await emitUsage(page, 42000, { input: 1000, cacheRead: 6000, cacheWrite: 1000 })

    await page.hover('[data-testid="context-usage-indicator"]')
    const card = page.locator('[data-testid="context-usage-card"]')
    await expect(card).toBeVisible()

    // 总量：42.0k / 131.1k + 占比 32%
    await expect(card.locator('[data-testid="context-usage-card-title"]')).toContainText('42.0k / 131.1k')
    await expect(card.locator('[data-testid="context-usage-card-title"]')).toContainText('32%')

    // 分区明细：五个桶各占一行（messages 为扣减余量 42000-900-300-1500-200=39100）
    for (const key of ['messages', 'tools', 'mcpTools', 'systemPrompt', 'skills']) {
      await expect(card.locator(`[data-testid="context-usage-segment-${key}"]`)).toHaveCount(1)
    }
    const messageRow = card.locator('[data-testid="context-usage-segment-messages"]')
    await expect(messageRow).toContainText('消息')
    await expect(messageRow).toContainText('93%')
    await expect(messageRow).not.toContainText('k ·')
    const toolsRow = card.locator('[data-testid="context-usage-segment-tools"]')
    await expect(toolsRow).toContainText('4%')
    // 占用从多到少排列：首行是消息（39.1k），末类是技能（0.3k）
    const segRows = card.locator('[data-testid="context-usage-segments"] ~ div > [data-testid^="context-usage-segment-"]')
    const rowCount = await segRows.count()
    const firstRowText = await segRows.first().textContent()
    expect(firstRowText).toContain('消息')
    // 剩余空间行：131072-42000=89072 → 89.1k · 68%
    const remainingRow = card.locator('[data-testid="context-usage-segment-remaining"]')
    await expect(remainingRow).toContainText('68%')
    await expect(remainingRow).not.toContainText('k ·')

    // 累计命中率：cacheRead=6000 / (2000+6000+4000) = 50.0%
    await expect(card.locator('[data-testid="context-usage-hit"]')).toContainText('最近 75.0%')
    await expect(card.locator('[data-testid="context-usage-hit"]')).toContainText('50.0%')

    // 今日用量：两行模型 + token + 成本
    const rows = card.locator('[data-testid="context-usage-today-row"]')
    await expect(rows).toHaveCount(2)
    await expect(rows.first()).toContainText('glm-5.3')
    await expect(rows.first()).toContainText('123.0k')
    await expect(rows.first()).toContainText('¥0.042')
  })

  test('第二次 LLM 调用后数字实时刷新', async ({ page }) => {
    await setup(page)
    await emitUsage(page, 42000, { input: 1000, cacheRead: 0, cacheWrite: 3000 })
    await page.hover('[data-testid="context-usage-indicator"]')
    await expect(page.locator('[data-testid="context-usage-card-title"]')).toContainText('42.0k')
    await page.mouse.move(10, 400) // 收起卡片，模拟"继续对话"

    await emitUsage(page, 50000, { input: 500, cacheRead: 46000, cacheWrite: 500 })
    await page.hover('[data-testid="context-usage-indicator"]')
    await expect(page.locator('[data-testid="context-usage-card-title"]')).toContainText('50.0k')
    // 最近一次：46000 / (500+46000+500) = 97.9%；累计：46000 / (1500+46000+3500) = 90.2%
    await expect(page.locator('[data-testid="context-usage-hit"]')).toContainText('97.9%')
    await expect(page.locator('[data-testid="context-usage-hit"]')).toContainText('90.2%')
  })

  test('runtime-context 快照落盘为隐藏消息：store 有、UI 不渲染', async ({ page }) => {
    await setup(page)
    const snapshotText = '<runtime-context>\n当前真实时间：2026年8月16日。\n</runtime-context>'
    await page.evaluate((text) => {
      ;(window as any).__mockBus.emit('runtime-context', 'conv-card', text)
    }, snapshotText)

    const stored = await page.evaluate(() => {
      const messages = (window as any).__chatStore.getState().messages
      return messages.map((m: any) => ({ kind: m.messageKind, content: m.content }))
    })
    // 紧跟末条用户消息之后插入隐藏快照
    expect(stored[0]).toMatchObject({ kind: 'user', content: '第一问' })
    expect(stored[1]).toMatchObject({ kind: 'runtime-context', content: snapshotText })

    // UI 消息区不出现快照原文
    await expect(page.locator('text=当前真实时间')).toHaveCount(0)
  })

  test('打开旧会话：落盘的 lastContextUsage 直接点亮圆环（无需先发消息）', async ({ page }) => {
    await setup(page)
    // 直接驱动 switchConversation（侧栏列表会被启动期 init 覆盖，不经 UI 注入）
    await page.evaluate(async () => {
      ;(window as any).__stubConvs = [{
        id: 'conv-old', title: '旧会话', role: 'learner',
        config: {
          lastContextUsage: {
            promptTokens: 21000, contextWindow: 131072, budget: 99072, compacted: true,
            usage: { input: 100, cacheRead: 20000, cacheWrite: 900 },
            segments: { systemPrompt: 900, skills: 300, toolsBuiltin: 1500, toolsMcp: 200, messages: 18100 },
            stats: { input: 100, cacheRead: 20000, cacheWrite: 900, calls: 1 }
          }
        },
        createdAt: Date.now(), updatedAt: Date.now(), messageCount: 2
      }]
      const store = (window as any).__chatStore
      await store.getState().initConversations('learner')
      await store.getState().switchConversation('conv-old')
    })

    const ring = page.locator('[data-testid="context-ring"]')
    await expect(ring).toHaveCount(1)
    const title = await ring.getAttribute('title')
    expect(title).toContain('21.0k')
    // 落盘时 compacted=true → 压缩微标也随读数恢复
    await expect(page.locator('[data-testid="context-ring-compacted"]')).toHaveCount(1)

    // 卡片数字来自落盘读数：最近命中率 20000/21000 = 95.2%，平均同（单次调用累计）
    await page.hover('[data-testid="context-usage-indicator"]')
    const card = page.locator('[data-testid="context-usage-card"]')
    await expect(card).toBeVisible()
    await expect(card.locator('[data-testid="context-usage-hit"]')).toContainText('95.2%')
  })
})

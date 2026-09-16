import { test, expect, Page } from '@playwright/test'

const ARTIFACTS_DIR = 'tests/artifacts/ui-feedback-0910'

/**
 * 2026-09-10 所有者上机反馈的四处观感（纯 view 层，mock window.api）：
 *  1. 欢迎页头像一行排到底：放不下的从两侧半遮出去；点被遮住的只是滚过去，不算选中
 *  2. 我的 Pal 页「试一下」只在悬停时出现；内置分组叫「OpenPipal 官方」
 *  3. 会话简报不再顶在最上面，而是第一条用户消息下面的一行小标签（只显示值）
 */
const ROLES = [
  { name: 'general', displayName: 'OpenPipal', icon: '✦' },
  { name: 'learner', displayName: '学习助手', icon: '📖' },
  { name: 'teacher', displayName: '教师助手', icon: '🎓' },
  { name: 'office', displayName: '办公助手', icon: '💼' },
  { name: 'interpreter', displayName: '同传翻译', icon: '🎧' },
  { name: 'design', displayName: '设计助手', icon: '🎨' },
  { name: 'coding', displayName: '编码助手', icon: '💻' },
]
const MOCK_API = `
window.__mockCalls = [];
window.__mockBus = { listeners: {}, on(e, fn){ (this.listeners[e]=this.listeners[e]||[]).push(fn); return () => {} }, emit(e, ...args){ (this.listeners[e]||[]).forEach(fn => fn(...args)) } };
const ROLES = ${JSON.stringify(ROLES)};
const WORKSPACES = [
  { id: 'ws-1', name: '论文导师', icon: '📚', description: '带你改论文结构', createdAt: 1, updatedAt: 1, memoryCount: 3, skillCount: 1, taskCount: 0 },
  { id: 'ws-2', name: '海报手', icon: '🖼️', description: '活动海报一键出', category: 'design', createdAt: 1, updatedAt: 1, memoryCount: 0, skillCount: 0, taskCount: 0 },
];
window.api = {
  getLocaleState: async () => ({ preference: 'zh-CN', locale: 'zh-CN' }),
  sendChat: () => {}, abortChat: () => {},
  onStreamChunk: () => () => {}, onStreamEnd: () => () => {},
  onTextFlush: () => () => {}, onToolStart: () => () => {}, onToolEnd: () => () => {},
  onToolProgress: () => () => {}, onAskUser: () => () => {}, onQuestionsV2: () => () => {},
  onArtifact: () => () => {}, onArtifactDelta: () => () => {}, onArtifactComplete: () => () => {},
  onVisualizer: () => () => {}, onVisualizerDelta: () => () => {}, onMcpAppInline: () => () => {},
  onTargetStatus: () => () => {}, onAppChanged: () => () => {}, onMemoryUpdated: () => () => {},
  onConvTitleUpdated: () => () => {}, onInlinePermission: () => () => {}, onPermissionRequest: () => () => {},
  onThinking: () => () => {}, onThinkingEnd: () => () => {},
  respondPermission: () => {}, pasteToTarget: async () => ({ success: true }), hasApiKey: async () => ({ hasKey: true }),
  getAllRoles: async () => ROLES,
  listConversations: async () => [],
  createConversation: async (role, title, agentId, workspaceId) => { window.__mockCalls.push({ method: 'createConversation', args: { role, workspaceId } }); return { id: 'conv-' + Math.random().toString(36).slice(2), title: title || '新对话', role, workspaceId, createdAt: Date.now(), updatedAt: Date.now(), messageCount: 0 }; },
  getConversationMessages: async () => [],
  replaceMessages: async () => {}, appendMessages: async () => {}, deleteConversation: async () => {},
  updateConversationRole: async () => true, updateConversationConfig: async () => true,
  getAppSettings: async () => ({ detected: [], disabled: [], browsers: [] }), setDisabledApps: async () => {},
  getModelConfig: async () => ({ provider: 'openai', baseUrl: '', apiKey: '', model: '' }), saveModelConfig: async () => {},
  getModelConfigFull: async () => ({ provider: 'openai', baseUrl: '', apiKey: '', model: '' }),
  isCustomConfig: async () => ({ isCustom: false }), getAvailableModels: async () => [],
  testConnection: async () => ({ ok: true }), getProviders: async () => ({}), clearModelConfig: async () => {},
  getMemoryConfig: async () => ({ enabled: true }), setMemoryConfig: async () => {},
  getVersion: async () => '0.0.0-test', getAgents: async () => [], listSkills: async () => [],
  listAgents: async () => [...ROLES.map(r => ({ id: r.name, kind: 'builtin', builtin: true, name: r.displayName, icon: r.icon, category: 'general' })), ...WORKSPACES.map(w => ({ id: w.id, kind: 'pal', builtin: false, name: w.name, icon: w.icon, description: w.description, category: w.category }))],
  listAgentWorkspaces: async () => WORKSPACES,
  getOnboardingStatus: async () => ({ completed: true }), setOnboardingCompleted: async () => {},
  getRealtimeConfig: async () => ({ provider: 'openai', url: '', model: '', deployment: '', apiVersion: '', voice: 'alloy', hasKey: false }),
  steerChat: async () => ({ ok: true }), queueChat: async () => ({ ok: true }),
  getSources: async () => [], listModelPresets: async () => []
};
`

async function boot(page: Page): Promise<void> {
  await page.addInitScript({ content: MOCK_API })
  await page.goto('/')
  await page.waitForLoadState('networkidle')
  await page.waitForSelector('textarea', { timeout: 10000 })
}

test.describe('欢迎页头像条', () => {
  test('挂靠态（420 宽）：一行到底、右侧半遮；点被遮住的只是滚过去，不算选中', async ({ page }) => {
    await boot(page)
    const strip = page.getByTestId('welcome-avatar-strip')
    await expect(strip).toHaveAttribute('data-overflow-right', '1')
    const stripBox = (await strip.boundingBox())!
    const buttons = strip.locator('button.h-11')   // 头像按钮本体（不算角上的捏头像小按钮）
    const boxes = await buttons.evaluateAll(els => els.map(el => el.getBoundingClientRect().top))
    expect(new Set(boxes.map(t => Math.round(t))).size, '所有头像在同一行').toBe(1)
    await page.screenshot({ path: `${ARTIFACTS_DIR}/01-strip-420-overflow.png` })

    // 右边缘那个被半遮住的头像：直接在它露出的那点上按鼠标（不让 Playwright 先把它滚进来）→ 只滚动，角色不变、也没建会话
    const edge = stripBox.x + stripBox.width - 28
    const rects = await buttons.evaluateAll(els => els.map(el => { const r = el.getBoundingClientRect(); return { title: el.getAttribute('title'), left: r.left, right: r.right, y: r.top + r.height / 2 } }))
    const masked = rects.find(r => r.right > edge && r.left < stripBox.x + stripBox.width)!
    expect(masked, '右边缘应有一个被半遮的头像').toBeTruthy()
    const scrollBefore = await strip.evaluate(el => el.scrollLeft)
    await page.mouse.click(Math.min(masked.right - 2, stripBox.x + stripBox.width - 4), masked.y)
    await page.waitForTimeout(700)
    expect(await page.evaluate(() => (window as any).__appStore.getState().currentRole?.name)).toBe('general')
    expect((await page.evaluate(() => (window as any).__mockCalls)).filter((c: any) => c.method === 'createConversation')).toHaveLength(0)
    expect(await strip.evaluate(el => el.scrollLeft), '滚过去了').toBeGreaterThan(scrollBefore)
    await expect(strip).toHaveAttribute('data-overflow-left', '1')
    await page.screenshot({ path: `${ARTIFACTS_DIR}/02-strip-420-scrolled.png` })

    // 露出来的头像：点了才是选中
    await strip.locator(`button[title="${masked.title}"]`).click()
    await expect.poll(() => page.evaluate(() => (window as any).__appStore.getState().currentRole?.name)).not.toBe('general')
  })

  test('宽窗（1100）：内容列 ~576px 放得下七个内置，Pal 从右侧半遮出去；左边不遮', async ({ page }) => {
    await page.setViewportSize({ width: 1100, height: 760 })
    await boot(page)
    const strip = page.getByTestId('welcome-avatar-strip')
    await expect(strip).toHaveAttribute('data-overflow-right', '1')
    await expect(strip).not.toHaveAttribute('data-overflow-left', '1')
    const stripBox = (await strip.boundingBox())!
    for (const role of ROLES.slice(1)) {   // 通用助手的 title 是欢迎页自己的文案，从第二个起按显示名找
      const b = (await strip.locator(`button[title="${role.displayName}"]`).boundingBox())!
      expect(b.x + b.width, `${role.displayName} 应完整露出`).toBeLessThanOrEqual(stripBox.x + stripBox.width - 28)
    }
    await page.screenshot({ path: `${ARTIFACTS_DIR}/03-strip-1100.png` })
  })
})

test('我的 Pal 页：分组叫「OpenPipal 官方」，「试一下」悬停才出现', async ({ page }) => {
  await page.setViewportSize({ width: 1100, height: 760 })
  await boot(page)
  await page.evaluate(() => (window as any).__appStore.getState().setActiveView('agents'))
  await expect(page.getByTestId('agents-builtin').locator('h2')).toHaveText('OpenPipal 官方')
  await expect(page.getByTestId('agents-search')).toBeVisible()
  await expect(page.getByTestId('agents-filters')).toHaveCount(0)   // 顶部没有筛选片
  await expect(page.getByTestId('agents-builtin').getByText('内置', { exact: true })).toHaveCount(0)   // 行上不打"内置"徽标
  const rows = page.locator('[data-testid="agent-row"]')
  const opacityOf = (i: number) => rows.nth(i).getByTestId('agent-try').evaluate(el => getComputedStyle(el).opacity)
  expect(await opacityOf(0)).toBe('0')
  await rows.nth(1).hover()
  await expect.poll(() => opacityOf(1)).toBe('1')
  expect(await opacityOf(0)).toBe('0')
  await page.screenshot({ path: `${ARTIFACTS_DIR}/04-my-pals-hover.png` })
})

test('会话简报：不再顶在最上面，而是第一条用户消息下面的一行标签（只显示值）', async ({ page }) => {
  await page.setViewportSize({ width: 1100, height: 760 })
  await boot(page)
  await page.evaluate(async () => {
    const store = (window as any).__chatStore
    await store.getState().newConversation('design')
    const now = Date.now()
    store.setState({
      conversationConfig: { roleBrief: { design: { taskType: '原型' } }, projectName: '多邻国数学' },
      messages: [
        { id: 'u1', role: 'user', content: '帮我设计一个多邻国数学版的 APP', timestamp: now, messageKind: 'user' },
        { id: 'a1', role: 'assistant', content: '收到，我先出一版。', timestamp: now + 1000, messageKind: 'assistant' },
        { id: 'u2', role: 'user', content: '再来一版', timestamp: now + 2000, messageKind: 'user' },
      ]
    })
  })
  const chips = page.getByTestId('brief-chips')
  await expect(chips).toHaveCount(1)
  await expect(chips).toHaveText(/📁 多邻国数学/)
  await expect(chips).toContainText('原型')
  await expect(chips).not.toContainText('taskType')
  await expect(page.getByText('会话简报')).toHaveCount(0)
  // 标签紧跟在第一条用户消息的气泡下面（在第一条 assistant 回话之前）
  const chipTop = (await chips.boundingBox())!.y
  const firstUser = (await page.getByText('帮我设计一个多邻国数学版的 APP').boundingBox())!
  const reply = (await page.getByText('收到，我先出一版。').boundingBox())!
  expect(chipTop).toBeGreaterThan(firstUser.y)
  expect(chipTop).toBeLessThan(reply.y)
  await page.screenshot({ path: `${ARTIFACTS_DIR}/05-brief-chips.png` })
})

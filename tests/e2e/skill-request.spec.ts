import { test, expect, Page } from '@playwright/test'

/**
 * 技能选择 = 单条消息内的强调，输入侧是 `/` 快捷指令 token（与正文混排，没有按钮入口）。
 *
 * 验证：
 * - T1 打 / 唤起面板 → Enter 选中 → `/技能名 ` 插入输入框 → 发送时就地换 <skill-request> 标签、气泡渲染成 pill
 * - T2 行首 / 面板还给内置命令（/goal），且只有 token 没正文 → 兜底句式
 * - T3 选择不落盘：全程不调 updateConversationConfig
 * - T5 路径/URL 里的 / 不唤起面板（`src/pdf` 不是技能）
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
window.__mockCalls = [];

window.api = {
  getLocaleState: async () => ({ preference: 'zh-CN', locale: 'zh-CN' }),
  sendChat: (...args) => { window.__mockCalls.push({ method: 'sendChat', args }); },
  abortChat: () => {},
  steerChat: async () => ({ ok: true }),
  queueChat: async () => ({ ok: true }),
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
  hasApiKey: async () => ({ hasKey: true }),
  getRoleInitState: async () => ({ hasRole: true, role: { name: 'learner', displayName: '学习助手', icon: '📖' } }),
  getAllRoles: async () => [{ name: 'learner', displayName: '学习助手', icon: '📖' }],
  getCurrentRole: async () => ({ name: 'learner', displayName: '学习助手', icon: '📖' }),
  switchRole: async () => ({ name: 'learner', displayName: '学习助手', icon: '📖' }),
  listConversations: async () => [],
  createConversation: async (role) => ({ id: 'conv-skill', title: '技能强调测试', role, createdAt: Date.now(), updatedAt: Date.now(), messageCount: 0 }),
  getConversationMessages: async () => [],
  replaceMessages: async () => {},
  appendMessages: async () => {},
  deleteConversation: async () => {},
  updateConversationConfig: async (...args) => { window.__mockCalls.push({ method: 'updateConversationConfig', args }); return { ok: true }; },
  getAppSettings: async () => ({ detected: [], disabled: [], browsers: [] }),
  setDisabledApps: async () => {},
  isCustomConfig: async () => ({ isCustom: false }),
  getAvailableModels: async () => [],
  getModelConfig: async () => ({ provider: 'openai', baseUrl: '', apiKey: '', model: '' }),
  getModelConfigFull: async () => ({ provider: 'openai', baseUrl: '', apiKey: '', model: '' }),
  saveModelConfig: async () => {},
  testConnection: async () => ({ ok: true }),
  getProviders: async () => ({}),
  clearModelConfig: async () => {},
  listSkills: async () => ([
    { name: 'dataviz', description: '做图表', enabled: true },
    { name: 'pdf', description: '处理 PDF', enabled: true }
  ]),
  openFileDialog: async () => { window.__mockCalls.push({ method: 'openFileDialog', args: [] }); return null; },
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
    store.setState({ messages: [{ id: 'init', role: 'user', content: 'hi', timestamp: Date.now() }] })
  })
  await page.locator('textarea').waitFor({ timeout: 5000 })
}

/** 取最后一次 sendChat 载荷里最后一条消息的正文 */
async function lastSentText(page: Page): Promise<string> {
  return page.evaluate(() => {
    const calls = (window as any).__mockCalls.filter((c: any) => c.method === 'sendChat')
    const msgs = calls[calls.length - 1].args[0]
    return msgs[msgs.length - 1].content as string
  })
}

test.use({ viewport: { width: 600, height: 700 } })

test.describe('技能选择 = / 快捷指令 token + 单条消息强调', () => {
  test('T1 打 / 唤起面板 → Enter 选中插 token → 发送就地换标签、气泡渲染 pill', async ({ page }) => {
    await setup(page)
    const textarea = page.locator('textarea').first()
    await textarea.click()
    await page.keyboard.type('/da')

    // 补全弹层出现且过滤到 dataviz
    const popup = page.locator('[data-testid="skill-mention-popup"]')
    await expect(popup).toBeVisible()
    await expect(popup.locator('[data-testid="skill-mention-item"]')).toHaveCount(1)

    // Enter 选中 → token 以纯文本插进输入框（与正文混排，不是 chip）
    await page.keyboard.press('Enter')
    await expect(popup).toHaveCount(0)
    await expect(textarea).toHaveValue('/dataviz ')
    // token 存在时镜像层负责着色
    await expect(page.locator('[data-testid="skill-mention-mirror"]')).toBeVisible()

    await page.keyboard.type('把这组数据画成折线图')
    await page.locator('[data-testid="send-btn"]').click()

    // 发送时 token 就地换成标签，不额外加引导句
    expect(await lastSentText(page)).toBe(
      '<skill-request>dataviz</skill-request> 把这组数据画成折线图'
    )
    await expect(textarea).toHaveValue('')

    // 气泡里是 pill，不是裸标签
    await expect(page.getByTitle('本条消息指定使用技能「dataviz」')).toBeVisible()
    await expect(page.getByText('<skill-request>')).toHaveCount(0)
  })

  test('T2 行首 / 面板给内置命令；纯 token 发送走兜底句式', async ({ page }) => {
    await setup(page)
    const textarea = page.locator('textarea').first()
    await textarea.click()
    await page.keyboard.type('/')

    // 面板 = 内置命令 + 技能；命令只在行首给
    const popup = page.locator('[data-testid="skill-mention-popup"]')
    await expect(popup).toBeVisible()
    await expect(popup.locator('[data-kind="command"]')).toHaveCount(1)
    await expect(popup.locator('[data-kind="command"]')).toContainText('/goal')
    await expect(popup.locator('[data-kind="skill"]')).toHaveCount(2)
    await page.waitForTimeout(300) // 等淡入放完再截
    await page.screenshot({ path: 'tests/artifacts/slash-panel/chat-panel.png' })

    // 选技能 → 插的是 token，不是挂在上方的 chip
    await page.keyboard.type('pdf')
    await page.keyboard.press('Enter')
    await expect(textarea).toHaveValue('/pdf ')

    await expect(page.locator('[data-testid="send-btn"]')).toBeEnabled()
    await page.locator('[data-testid="send-btn"]').click()
    expect(await lastSentText(page)).toBe('请使用技能 <skill-request>pdf</skill-request> 来帮我完成')
  })

  test('T2b 技能按钮入口已经没有了：+ 是直接开文件选择器', async ({ page }) => {
    await setup(page)
    await expect(page.getByText('添加技能')).toHaveCount(0)
    await page.locator('[data-testid="inputbar-plus-btn"]').click()
    await expect(page.getByText('添加技能')).toHaveCount(0)
    expect(await page.evaluate(() =>
      (window as any).__mockCalls.filter((c: any) => c.method === 'openFileDialog').length
    )).toBe(1)
  })

  test('T3 技能选择不落盘：不调 updateConversationConfig', async ({ page }) => {
    await setup(page)
    const textarea = page.locator('textarea').first()
    await textarea.click()
    await page.keyboard.type('/pdf')
    await page.keyboard.press('Enter')
    await page.keyboard.type('/dataviz')
    await page.keyboard.press('Enter')
    const configCalls = await page.evaluate(() =>
      (window as any).__mockCalls.filter((c: any) => c.method === 'updateConversationConfig').length
    )
    expect(configCalls).toBe(0)
  })

  test('T4 Esc 关掉面板后 / 原样留在正文里，未知技能名不换标签', async ({ page }) => {
    await setup(page)
    const textarea = page.locator('textarea').first()
    await textarea.click()
    await page.keyboard.type('/da')
    await expect(page.locator('[data-testid="skill-mention-popup"]')).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.locator('[data-testid="skill-mention-popup"]')).toHaveCount(0)

    // 补完正文直接发：/data 不是已知技能名，原样发出
    await page.keyboard.type('ta 这个词帮我解释一下')
    await page.locator('[data-testid="send-btn"]').click()
    expect(await lastSentText(page)).toBe('/data 这个词帮我解释一下')
  })

  test('T5 路径和 URL 里的 / 不唤起面板，也不换标签', async ({ page }) => {
    await setup(page)
    const textarea = page.locator('textarea').first()
    await textarea.click()
    await page.keyboard.type('看下 src/pdf 这个目录')
    await expect(page.locator('[data-testid="skill-mention-popup"]')).toHaveCount(0)
    await expect(page.locator('[data-testid="skill-mention-mirror"]')).toHaveCount(0)
    await page.locator('[data-testid="send-btn"]').click()
    expect(await lastSentText(page)).toBe('看下 src/pdf 这个目录')
  })
})

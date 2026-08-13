import { test, expect, Page } from '@playwright/test'

const ARTIFACTS_DIR = 'tests/artifacts/memory-archive-ui'

/**
 * 归档记忆可见性 + 找回 — Settings 「记忆」tab E2E
 * 验证 MemorySettings 的「已归档」折叠区：
 *  - 标题显示条数
 *  - 展开后渲染各条归档记忆
 *  - 点「找回」调用 restoreMemory 并刷新（列表少一条）
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

// 归档记忆的「已找回」标记 — restoreMemory 调用后置位，listArchivedMemories 据此少返一条
window.__restoredPaths = {};

const ARCHIVED = [
  { filename: 'project_old.md', filePath: '/Users/x/.openpipal/memory/global/archive/project_old.md', mtimeMs: Date.now() - 30*24*3600*1000, name: '旧项目笔记', description: 'desc', type: 'project' },
  { filename: 'reference_old.md', filePath: '/Users/x/.openpipal/memory/global/archive/reference_old.md', mtimeMs: Date.now() - 40*24*3600*1000, name: '旧引用资料', description: 'desc', type: 'reference' }
];

window.api = {
  getLocaleState: async () => ({ preference: 'zh-CN', locale: 'zh-CN' }),
  // ── 基础启动需要的 mock ──
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
  createConversation: async (role) => ({ id: 'mock-conv', title: '新对话', role, createdAt: Date.now(), updatedAt: Date.now(), messageCount: 0 }),
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
  onRealtimeState: () => () => {},

  // ── 记忆管理 IPC ──
  listGlobalMemories: async () => ([
    { filename: 'user_self.md', filePath: '/Users/x/.openpipal/memory/global/user_self.md', mtimeMs: Date.now(), name: '关于我', description: '身份信息', type: 'user' },
    { filename: 'project_live.md', filePath: '/Users/x/.openpipal/memory/global/project_live.md', mtimeMs: Date.now(), name: '当前项目', description: '活跃项目', type: 'project' }
  ]),
  getMemoryConfig: async () => ({ autoMemoryEnabled: true, globalDir: '/Users/x/.openpipal/memory/global' }),
  setMemoryConfig: async () => ({ ok: true }),
  forceDream: async () => ({ actionsApplied: 0, summary: '无需调整' }),
  readMemory: async () => null,
  deleteMemory: async () => true,

  // ── 归档记忆（本次特性）──
  listArchivedMemories: async () => ARCHIVED.filter(m => !window.__restoredPaths[m.filePath]),
  restoreMemory: async (filePath) => {
    window.__mockCalls.push({ method: 'restoreMemory', args: filePath });
    window.__restoredPaths[filePath] = true;
    return true;
  }
};
`

async function setup(page: Page): Promise<void> {
  await page.addInitScript({ content: MOCK_API })
  await page.goto('/')
  await page.waitForLoadState('networkidle')
  await page.waitForSelector('textarea', { timeout: 10000 })
}

async function openMemoryTab(page: Page): Promise<void> {
  await page.getByRole('button', { name: '设置' }).first().click()
  await page.locator('text=记忆').first().waitFor({ timeout: 3000 })
  await page.locator('text=记忆').first().click()
  // MemorySettings 标题确认进入
  await page.locator('text=记忆管理').first().waitFor({ timeout: 3000 })
  await page.waitForTimeout(200)
}

// 与 voice-settings 同理：默认 420 宽会把 SettingsPanel 主内容区挤没，用更宽视口
test.use({ viewport: { width: 1000, height: 700 } })

test.describe('归档记忆 — 可见性 + 找回', () => {
  test('「已归档」区显示条数 + 展开渲染各条 + 找回调用并刷新', async ({ page }) => {
    await setup(page)
    await openMemoryTab(page)

    // 1) 折叠状态下，标题显示 2 条
    const header = page.locator('text=/已归档（2 条）/').first()
    await expect(header).toBeVisible({ timeout: 3000 })
    console.log('[archive-1] 已归档标题显示 2 条 - 通过')

    // 折叠时不应渲染归档行
    await expect(page.locator('text=旧项目笔记')).toHaveCount(0)

    // 2) 展开 — 点标题按钮
    await header.click()
    await expect(page.locator('text=旧项目笔记')).toBeVisible({ timeout: 3000 })
    await expect(page.locator('text=旧引用资料')).toBeVisible()
    console.log('[archive-2] 展开后渲染 2 条归档记忆 - 通过')

    await page.screenshot({ path: `${ARTIFACTS_DIR}/archived-section.png` })

    // 3) 点第一条的「找回」
    // 注意：折叠区标题按钮的描述文案以「可随时找回」结尾，会被非 exact 名称匹配命中，
    // 故行内找回按钮用 exact 匹配，只命中两条记忆行的「找回」。
    const restoreBtns = page.getByRole('button', { name: '找回', exact: true })
    await expect(restoreBtns).toHaveCount(2)
    await restoreBtns.first().click()
    await page.waitForTimeout(300)

    // restoreMemory 以正确 filePath 调用
    const calls = await page.evaluate(() => window.__mockCalls)
    const restoreCall = calls.find((c) => c.method === 'restoreMemory')
    expect(restoreCall).toBeTruthy()
    expect(restoreCall!.args).toBe('/Users/x/.openpipal/memory/global/archive/project_old.md')
    console.log('[archive-3] restoreMemory 以正确 filePath 调用 - 通过')

    // 4) 刷新后只剩 1 条 — 标题变「已归档（1 条）」，被找回的行消失
    await expect(page.locator('text=/已归档（1 条）/').first()).toBeVisible({ timeout: 3000 })
    await expect(page.locator('text=旧项目笔记')).toHaveCount(0)
    console.log('[archive-4] 找回后列表刷新为 1 条 - 通过')
  })
})

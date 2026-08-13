import { test, expect, Page } from '@playwright/test'

const ARTIFACTS_DIR = 'tests/artifacts/browser-layout'

/**
 * 浏览器模式精简布局 —— 验证：
 *  1. 桌面左侧 Sidebar 在浏览器模式（__OPENPIPAL_ENV__='browser'）下不渲染
 *  2. 顶栏 BrowserTopBar 出现：AgentSwitcher（全局角色 + 我的 Agents）/ 历史 / 新建
 *  3. 选中独立 Agent 会以 workspaceId 开新会话（createConversation 收到 workspaceId）
 *  4. 历史浮层可展开、可搜索
 *
 * 关键 setup：直接预置 window.__OPENPIPAL_ENV__='browser' + 一个 mock window.api。
 * 因为 main.tsx 仅在 window.api 缺失时才装 shim，所以预置 api 不会被覆盖，而 isBrowser
 * 只读 env 标识 → 走浏览器布局，同时用 mock 数据驱动各 store。
 */
const MOCK_API = `
window.__OPENPIPAL_ENV__ = 'browser';
window.__mockCalls = [];
window.__mockBus = {
  listeners: {},
  on(event, fn) { (this.listeners[event] ||= []).push(fn); return () => { this.listeners[event] = this.listeners[event].filter(f => f !== fn); }; },
  emit(event, ...args) { (this.listeners[event] || []).forEach(fn => fn(...args)); }
};
const ROLES = [
  { name: 'general', displayName: 'OpenPipal', icon: '✦' },
  { name: 'learner', displayName: '学习助手', icon: '📖' },
  { name: 'design', displayName: '设计助手', icon: '🎨' },
];
const WORKSPACES = [
  { id: 'ws-1', name: '论文导师', icon: '📚', description: '', createdAt: Date.now(), updatedAt: Date.now(), hasAgentMd: true, memoryCount: 3, skillCount: 1, taskCount: 0 },
  { id: 'ws-2', name: '周报助手', icon: '🗂️', description: '', createdAt: Date.now(), updatedAt: Date.now(), hasAgentMd: true, memoryCount: 0, skillCount: 0, taskCount: 0 },
];
const CONVS = [
  { id: 'c1', title: 'GTC 大会新闻资讯', role: 'learner', createdAt: Date.now(), updatedAt: Date.now(), messageCount: 22 },
  { id: 'c2', title: 'Python FastAPI 笔记', role: 'learner', createdAt: Date.now() - 86400000 * 2, updatedAt: Date.now() - 86400000 * 2, messageCount: 7 },
];
window.api = {
  getLocaleState: async () => ({ preference: 'zh-CN', locale: 'zh-CN' }),
  sendChat: () => {}, abortChat: () => {},
  onStreamChunk: (cb) => window.__mockBus.on('stream-chunk', cb),
  onStreamEnd: (cb) => window.__mockBus.on('stream-end', cb),
  onTextFlush: (cb) => window.__mockBus.on('text-flush', cb),
  onThinking: (cb) => window.__mockBus.on('thinking', cb),
  onThinkingEnd: (cb) => window.__mockBus.on('thinking-end', cb),
  onToolStart: (cb) => window.__mockBus.on('tool-start', cb),
  onToolEnd: (cb) => window.__mockBus.on('tool-end', cb),
  onAskUser: (cb) => window.__mockBus.on('ask-user', cb),
  onTargetStatus: () => () => {},
  onAppChanged: () => () => {},
  pasteToTarget: async () => ({ success: false }),
  getRoleInitState: async () => ({ hasRole: true, role: ROLES.find(r => r.name === 'learner') }),
  getAllRoles: async () => ROLES,
  getCurrentRole: async () => ROLES.find(r => r.name === 'learner'),
  switchRole: async (name) => { window.__mockCalls.push({ method: 'switchRole', args: name }); return ROLES.find(r => r.name === name) || ROLES[0]; },
  listAgentWorkspaces: async () => WORKSPACES,
  listConversations: async () => CONVS,
  createConversation: async (role, title, agentId, workspaceId) => {
    window.__mockCalls.push({ method: 'createConversation', args: { role, title, agentId, workspaceId } });
    return { id: 'new-conv', title: title || '新对话', role, workspaceId, createdAt: Date.now(), updatedAt: Date.now(), messageCount: 0 };
  },
  getConversation: async () => ({}),
  getConversationMessages: async () => [],
  replaceMessages: async () => {}, appendMessages: async () => {}, deleteConversation: async () => {},
  getAppSettings: async () => ({ detected: [], disabled: [], browsers: [] }),
  setDisabledApps: async () => {},
  isCustomConfig: async () => ({ isCustom: false }),
  getAvailableModels: async () => [], getModelConfig: async () => ({ provider: 'openai', baseUrl: '', apiKey: '', model: '' }),
  getModelConfigFull: async () => ({ provider: 'openai', baseUrl: '', apiKey: '', model: '' }),
  saveModelConfig: async () => {}, testConnection: async () => ({ ok: true }), getProviders: async () => ({}), clearModelConfig: async () => {},
  getRealtimeConfig: async () => ({ provider: 'openai', url: '', model: '', deployment: '', apiVersion: '', voice: 'alloy', hasKey: false }),
  startRealtime: async () => ({ success: false }), stopRealtime: () => {}, sendRealtimeEvent: () => {},
  onRealtimeEvent: () => () => {}, onRealtimeState: () => () => {},
  clearSessionApprovals: () => {},
};
`

async function setup(page: Page): Promise<void> {
  await page.addInitScript({ content: MOCK_API })
  await page.goto('/')
  await page.waitForLoadState('networkidle')
  await page.waitForSelector('textarea', { timeout: 10000 })
}

test('浏览器模式：隐藏侧栏 + 顶栏切换智能体 + 历史浮层', async ({ page }) => {
  await setup(page)

  // 1. 顶栏出现：AgentSwitcher 显示当前角色 / 历史 / 新建
  await expect(page.getByText('学习助手').first()).toBeVisible()
  await expect(page.getByRole('button', { name: '历史' })).toBeVisible()
  await expect(page.getByRole('button', { name: '新建' })).toBeVisible()

  // 2. 桌面 Sidebar 不渲染：其独有的「技能和工具」「新建对话」整按钮不应出现
  await expect(page.getByText('技能和工具')).toHaveCount(0)
  await expect(page.getByText('新建对话')).toHaveCount(0)
  await page.screenshot({ path: `${ARTIFACTS_DIR}/01-topbar.png` })

  // 3. 打开 AgentSwitcher：两组都在，独立 Agent 可见
  await page.getByText('学习助手').first().click()
  const menu = page.getByTestId('agent-switcher-menu')
  await expect(menu.getByText('全局角色')).toBeVisible()
  await expect(menu.getByText('我的 Agents')).toBeVisible()
  // general（OpenPipal 通用助手）现在是真实角色，应出现在全局角色组里
  await expect(menu.getByText('OpenPipal')).toBeVisible()
  await expect(menu.getByText('设计助手')).toBeVisible()
  await expect(menu.getByText('论文导师')).toBeVisible()
  await page.screenshot({ path: `${ARTIFACTS_DIR}/02-switcher-open.png` })

  // 3b. 选中 general → switchRole('general') 被调用
  await menu.getByText('OpenPipal').click()
  await page.waitForTimeout(200)
  const switched = await page.evaluate(() => (window as any).__mockCalls.find((c: any) => c.method === 'switchRole' && c.args === 'general'))
  expect(switched, '选 OpenPipal 应调用 switchRole(general)').toBeTruthy()
  // 重新打开切换器，继续后续步骤
  await page.getByText('OpenPipal').first().click()

  // 4. 选中独立 Agent → createConversation 收到 workspaceId
  await page.getByText('论文导师').click()
  await page.waitForTimeout(300)
  const calls = await page.evaluate(() => (window as any).__mockCalls)
  const created = calls.find((c: any) => c.method === 'createConversation' && c.args?.workspaceId === 'ws-1')
  expect(created, 'createConversation 应带 workspaceId=ws-1').toBeTruthy()

  // 5. 历史浮层：展开 + 搜索
  await page.getByRole('button', { name: '历史' }).click()
  await expect(page.getByText('GTC 大会新闻资讯')).toBeVisible()
  await page.screenshot({ path: `${ARTIFACTS_DIR}/03-history-open.png` })
  await page.getByPlaceholder('搜索对话...').fill('FastAPI')
  await page.waitForTimeout(400)
  await expect(page.getByText('Python FastAPI 笔记')).toBeVisible()
  await expect(page.getByText('GTC 大会新闻资讯')).toHaveCount(0)
})

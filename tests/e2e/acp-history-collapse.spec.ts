import { test, expect, Page } from '@playwright/test'

const ARTIFACTS_DIR = 'tests/artifacts/acp-history-collapse'

/**
 * ACP 外部会话折叠 —— 验证：
 *  1. 桌面 Sidebar：标题以 "[ACP]" 开头的会话不混进日期分组，默认收进折叠的「ACP 会话 · N」
 *  2. 点击分组头可展开/再收起
 *  3. 搜索时自动展开（有匹配却藏着会让人以为搜不到）
 *  4. 浏览器模式 HistoryPopover 同样折叠
 *
 * 判定依据：ACP 会话没有独立 source 落盘字段，openpipal-acp 适配器无条件给标题
 * 加 "[ACP] " 前缀（openpipal-acp/src/agent.ts），标题前缀即持久标记。
 */
function mockApi(env: 'desktop' | 'browser'): string {
  return `
${env === 'browser' ? "window.__OPENPIPAL_ENV__ = 'browser';" : ''}
window.__mockBus = { listeners:{}, on(e,fn){(this.listeners[e]=this.listeners[e]||[]).push(fn);return ()=>{};}, emit(e,...a){(this.listeners[e]||[]).forEach(fn=>fn(...a));} };
const NOW = Date.now();
const CONVS = [
  { id: 'c1', title: 'GTC 大会新闻资讯', role: 'learner', createdAt: NOW, updatedAt: NOW, messageCount: 22 },
  { id: 'a1', title: '[ACP] taco_ultra', role: 'general', createdAt: NOW - 1000, updatedAt: NOW - 1000, messageCount: 2 },
  { id: 'a2', title: '[ACP] taco_ultra', role: 'general', createdAt: NOW - 2000, updatedAt: NOW - 2000, messageCount: 4 },
  { id: 'a3', title: '[ACP] acp-stage6', role: 'general', createdAt: NOW - 3000, updatedAt: NOW - 3000, messageCount: 2 },
  { id: 'c2', title: 'Python FastAPI 笔记', role: 'learner', createdAt: NOW - 86400000 * 2, updatedAt: NOW - 86400000 * 2, messageCount: 7 },
];
window.api = {
  getLocaleState: async () => ({ preference: 'zh-CN', locale: 'zh-CN' }),
  sendChat: () => {}, abortChat: () => {}, hasApiKey: async () => ({ hasKey: true }),
  onStreamChunk: (cb) => window.__mockBus.on('stream-chunk', cb),
  onStreamEnd: (cb) => window.__mockBus.on('stream-end', cb),
  onTextFlush: (cb) => window.__mockBus.on('text-flush', cb),
  onThinking: (cb) => window.__mockBus.on('thinking', cb),
  onThinkingEnd: (cb) => window.__mockBus.on('thinking-end', cb),
  onToolStart: (cb) => window.__mockBus.on('tool-start', cb),
  onToolProgress: (cb) => window.__mockBus.on('tool-progress', cb),
  onToolEnd: (cb) => window.__mockBus.on('tool-end', cb),
  onAskUser: (cb) => window.__mockBus.on('ask-user', cb),
  onTargetStatus: () => () => {}, onAppChanged: () => () => {},
  getRoleInitState: async () => ({ hasRole: true, role: { name:'learner', displayName:'学习助手', icon:'📖' } }),
  getAllRoles: async () => [{ name:'learner', displayName:'学习助手', icon:'📖' }],
  getCurrentRole: async () => ({ name:'learner', displayName:'学习助手', icon:'📖' }),
  switchRole: async () => ({ name:'learner', displayName:'学习助手', icon:'📖' }),
  listAgentWorkspaces: async () => [],
  listConversations: async () => CONVS,
  createConversation: async (role) => ({ id:'new-conv', title:'新对话', role, createdAt:NOW, updatedAt:NOW, messageCount:0 }),
  getConversation: async () => ({}),
  getConversationMessages: async () => [], replaceMessages: async () => {}, appendMessages: async () => {}, deleteConversation: async () => {},
  getAppSettings: async () => ({ detected:[], disabled:[], browsers:[] }), setDisabledApps: async () => {},
  isCustomConfig: async () => ({ isCustom:false }), getAvailableModels: async () => [],
  getModelConfig: async () => ({ provider:'openai', baseUrl:'', apiKey:'', model:'' }),
  getModelConfigFull: async () => ({ provider:'openai', baseUrl:'', apiKey:'', model:'' }),
  saveModelConfig: async () => {}, testConnection: async () => ({ ok:true }), getProviders: async () => ({}), clearModelConfig: async () => {},
  getRealtimeConfig: async () => ({ provider:'openai', url:'', model:'', deployment:'', apiVersion:'', voice:'alloy', hasKey:false }),
  startRealtime: async () => ({ success:false }), stopRealtime: () => {}, sendRealtimeEvent: () => {}, onRealtimeEvent: () => () => {}, onRealtimeState: () => () => {}
};
`
}

async function setup(page: Page, env: 'desktop' | 'browser'): Promise<void> {
  await page.addInitScript({ content: mockApi(env) })
  await page.goto('/')
  await page.waitForLoadState('networkidle')
  await page.waitForSelector('textarea', { timeout: 10000 })
}

test.use({ viewport: { width: 1000, height: 760 } })

test('桌面 Sidebar：ACP 会话默认折叠，可展开，搜索自动展开', async ({ page }) => {
  await setup(page, 'desktop')

  // 1. 默认态：普通会话在日期分组里可见，ACP 会话不可见，折叠分组头显示数量
  await expect(page.getByText('GTC 大会新闻资讯')).toBeVisible()
  await expect(page.getByText('Python FastAPI 笔记')).toBeVisible()
  await expect(page.getByText('[ACP] taco_ultra')).toHaveCount(0)
  const toggle = page.getByText('ACP 会话 · 3')
  await expect(toggle).toBeVisible()
  await page.screenshot({ path: `${ARTIFACTS_DIR}/01-collapsed.png` })

  // 2. 展开 → 三条 ACP 会话可见；再点 → 收起
  await toggle.click()
  await expect(page.getByText('[ACP] taco_ultra')).toHaveCount(2)
  await expect(page.getByText('[ACP] acp-stage6')).toBeVisible()
  await page.screenshot({ path: `${ARTIFACTS_DIR}/02-expanded.png` })
  await toggle.click()
  await expect(page.getByText('[ACP] taco_ultra')).toHaveCount(0)

  // 3. 搜索命中 ACP → 自动展开，且不显示"没有匹配的对话"
  await page.getByPlaceholder('搜索对话...').fill('taco')
  await expect(page.getByText('[ACP] taco_ultra')).toHaveCount(2, { timeout: 3000 })
  await expect(page.getByText('没有匹配的对话')).toHaveCount(0)
  await page.screenshot({ path: `${ARTIFACTS_DIR}/03-search-autoexpand.png` })

  // 4. 清空搜索 → 回到默认折叠（此前未手动展开）
  await page.getByPlaceholder('搜索对话...').fill('')
  await expect(page.getByText('[ACP] taco_ultra')).toHaveCount(0, { timeout: 3000 })

  // 5. 回归：手动展开 → 搜索 → 清空，手动展开状态不能被搜索操作清掉
  await page.getByText('ACP 会话 · 3').click()
  await expect(page.getByText('[ACP] taco_ultra')).toHaveCount(2)
  await page.getByPlaceholder('搜索对话...').fill('taco')
  await expect(page.getByText('ACP 会话 · 2')).toBeVisible({ timeout: 3000 })
  await page.getByPlaceholder('搜索对话...').fill('')
  await expect(page.getByText('ACP 会话 · 3')).toBeVisible({ timeout: 3000 })
  await expect(page.getByText('[ACP] taco_ultra')).toHaveCount(2)
  console.log('[acp-history-collapse] Sidebar 折叠/展开/搜索自动展开/手动状态保留 - 通过')
})

test('浏览器模式 HistoryPopover：ACP 会话同样默认折叠', async ({ page }) => {
  await setup(page, 'browser')

  await page.getByRole('button', { name: '历史' }).click()
  await expect(page.getByText('GTC 大会新闻资讯')).toBeVisible()
  await expect(page.getByText('[ACP] taco_ultra')).toHaveCount(0)
  const toggle = page.getByText('ACP 会话 · 3')
  await expect(toggle).toBeVisible()

  await toggle.click()
  await expect(page.getByText('[ACP] taco_ultra')).toHaveCount(2)
  await page.screenshot({ path: `${ARTIFACTS_DIR}/04-popover-expanded.png` })
  console.log('[acp-history-collapse] HistoryPopover 折叠/展开 - 通过')
})

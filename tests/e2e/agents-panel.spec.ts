import { test, expect, Page } from '@playwright/test'

const ARTIFACTS_DIR = 'tests/artifacts/agents-panel'

/**
 * 我的 Pal 页：按分类分组 + 筛选片 + 搜索（像 bot 市场）。
 *  1. 「全部」：内置一组（行上带分类标签），我的 Pal 按 category 分组，没分类的落在「其他」
 *  2. 点分类片：内置与我的并入同一组，内置行不再重复分类标签
 *  3. 「内置」片只看内置；搜索对名字和介绍做包含匹配，在当前筛选片内生效；没结果有空态
 *  4. 我的 Pal 里自己写的分类词（"数学"）自成一片
 * 纯 view 层：mock window.api 给一份带 category 的列表，主进程侧的分类来源由单测钉。
 */
const MOCK_API = `
window.__mockBus = { listeners: {}, on(e, fn){ (this.listeners[e]=this.listeners[e]||[]).push(fn); return () => {} }, emit(e, ...args){ (this.listeners[e]||[]).forEach(fn => fn(...args)) } };
const ROLE = { name: 'general', displayName: 'OpenPipal', icon: '✦' };
const BUILTINS = [
  { id: 'general', kind: 'builtin', builtin: true, name: 'OpenPipal', icon: '✦', category: 'general' },
  { id: 'teacher', kind: 'builtin', builtin: true, name: '教师助手', icon: '🎓', category: 'education' },
  { id: 'design', kind: 'builtin', builtin: true, name: '设计助手', icon: '🎨', category: 'design' },
  { id: 'coding', kind: 'builtin', builtin: true, name: '编码助手', icon: '💻', category: 'coding' },
];
const WORKSPACES = [
  { id: 'ws-1', name: '论文导师', icon: '📚', description: '带你改论文结构', category: 'education', createdAt: 1, updatedAt: 1, memoryCount: 3, skillCount: 1, taskCount: 0 },
  { id: 'ws-2', name: '海报手', icon: '🖼️', description: '活动海报一键出', category: 'design', createdAt: 1, updatedAt: 1, memoryCount: 0, skillCount: 0, taskCount: 0 },
  { id: 'ws-3', name: '奥数教练', icon: '🧮', description: '小学奥数思路拆解', category: '数学', createdAt: 1, updatedAt: 1, memoryCount: 0, skillCount: 0, taskCount: 1 },
  { id: 'ws-4', name: '周报助手', icon: '🗂️', description: '每周五整理周报', createdAt: 1, updatedAt: 1, memoryCount: 0, skillCount: 0, taskCount: 0 },
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
  getRoleInitState: async () => ({ hasRole: true, role: ROLE }),
  getAllRoles: async () => [ROLE], getCurrentRole: async () => ROLE, switchRole: async () => ROLE,
  listConversations: async () => [],
  createConversation: async (role, title, agentId, workspaceId) => ({ id: 'conv-x', title: title || '新对话', role, agentId, workspaceId, createdAt: Date.now(), updatedAt: Date.now(), messageCount: 0 }),
  getConversationMessages: async () => [],
  replaceMessages: async () => {}, appendMessages: async () => {}, deleteConversation: async () => {},
  getAppSettings: async () => ({ detected: [], disabled: [], browsers: [] }), setDisabledApps: async () => {},
  getModelConfig: async () => ({ provider: 'openai', baseUrl: '', apiKey: '', model: '' }), saveModelConfig: async () => {},
  getModelConfigFull: async () => ({ provider: 'openai', baseUrl: '', apiKey: '', model: '' }),
  isCustomConfig: async () => ({ isCustom: false }), getAvailableModels: async () => [],
  testConnection: async () => ({ ok: true }), getProviders: async () => ({}), clearModelConfig: async () => {},
  getMemoryConfig: async () => ({ enabled: true }), setMemoryConfig: async () => {},
  getVersion: async () => '0.0.0-test', getAgents: async () => [], listSkills: async () => [],
  listAgents: async () => [...BUILTINS, ...WORKSPACES.map(w => ({ id: w.id, kind: 'pal', builtin: false, name: w.name, icon: w.icon, description: w.description, category: w.category }))],
  listAgentWorkspaces: async () => WORKSPACES, listAgentTemplates: async () => [],
  getOnboardingStatus: async () => ({ completed: true }), setOnboardingCompleted: async () => {},
  getRealtimeConfig: async () => ({ provider: 'openai', url: '', model: '', deployment: '', apiVersion: '', voice: 'alloy', hasKey: false }),
  steerChat: async () => ({ ok: true }), queueChat: async () => ({ ok: true }),
  getSources: async () => [], listModelPresets: async () => []
};
`

test.use({ viewport: { width: 1100, height: 760 } })

async function openAgentsPage(page: Page): Promise<void> {
  await page.addInitScript({ content: MOCK_API })
  await page.goto('/')
  await page.waitForLoadState('networkidle')
  await page.evaluate(() => (window as any).__appStore.getState().setActiveView('agents'))
  await expect(page.getByTestId('agents-search')).toBeVisible()
}

const sectionLabels = (page: Page) => page.locator('[data-testid="agents-builtin"] h2, [data-testid="agents-section"] h2').allTextContents()
const rowNames = (page: Page) => page.locator('[data-testid="agent-row"] h3').allTextContents()

test('内置一组带分类标签，我的 Pal 按分类分组，自己的词自成一组，没分类的在「其他」；顶部只有搜索框', async ({ page }) => {
  await openAgentsPage(page)
  await expect(page.getByTestId('agents-filters')).toHaveCount(0)
  expect(await sectionLabels(page)).toEqual(['OpenPipal 官方', '教育', '设计', '数学', '其他'])
  // 行上不打任何标签（没有"内置"、也没有分类）：名字够清楚，分类只体现在分组标题
  const builtin = page.getByTestId('agents-builtin')
  await expect(builtin.locator('[data-testid="agent-row"]')).toHaveCount(4)
  await expect(builtin.getByText('内置', { exact: true })).toHaveCount(0)
  await expect(page.getByTestId('agent-category')).toHaveCount(0)
  await expect(page.locator('[data-section="category:education"] [data-testid="agent-row"]')).toHaveCount(1)
  await expect(page.locator('[data-section="mine"] [data-testid="agent-row"]')).toHaveText(/周报助手/)
  await page.screenshot({ path: `${ARTIFACTS_DIR}/01-all.png` })
})

test('搜索名字或介绍；没结果有空态', async ({ page }) => {
  await openAgentsPage(page)
  const search = page.getByTestId('agents-search')
  await search.fill('海报')                                   // 命中介绍："活动海报一键出"
  expect(await rowNames(page)).toEqual(['海报手'])
  expect(await sectionLabels(page)).toEqual(['设计'])
  await page.screenshot({ path: `${ARTIFACTS_DIR}/03-search.png` })

  await search.fill('助手')                                   // 名字命中：内置三个 + 周报助手
  expect(await rowNames(page)).toEqual(['教师助手', '设计助手', '编码助手', '周报助手'])

  await search.fill('不存在的')
  await expect(page.getByTestId('agents-search-empty')).toBeVisible()
  await expect(page.locator('[data-testid="agent-row"]')).toHaveCount(0)
  await page.screenshot({ path: `${ARTIFACTS_DIR}/04-search-empty.png` })
})

import { test, expect, Page } from '@playwright/test'

/**
 * 输入框的模型控件两条契约：
 *  1. 模型名前面不再有那个所有模型共用的 Bot 图标（不携带任何信息）
 *  2. 思考关不掉的模型（GLM-5.3、grok-4 系）不画"不思考"那一行——点了不生效、还会被服务端拒
 * 纯 view 层断言，沿用 message-layout.spec 的注入技法（不依赖真实 main 进程）。
 */
const mockApi = (model: Record<string, unknown>) => `
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
  getRoleInitState: async () => ({ hasRole: true, role: { name: 'learner', displayName: '学习助手', icon: '📖' } }),
  getAllRoles: async () => [{ name: 'learner', displayName: '学习助手', icon: '📖' }],
  getCurrentRole: async () => ({ name: 'learner', displayName: '学习助手', icon: '📖' }),
  switchRole: async () => ({ name: 'learner', displayName: '学习助手', icon: '📖' }),
  listConversations: async () => [],
  createConversation: async (role) => ({ id: 'conv-model-control', title: '模型控件', role, createdAt: Date.now(), updatedAt: Date.now(), messageCount: 0 }),
  getConversationMessages: async () => [],
  replaceMessages: async () => {}, appendMessages: async () => {}, deleteConversation: async () => {},
  updateConversationConfig: async () => ({ ok: true }), updateConversationTitle: async () => ({ ok: true }),
  getAppSettings: async () => ({ detected: [], disabled: [], browsers: [] }), setDisabledApps: async () => {},
  getModelConfig: async () => (${JSON.stringify(model)}), saveModelConfig: async () => {},
  getModelConfigFull: async () => (${JSON.stringify(model)}),
  isCustomConfig: async () => ({ isCustom: true }),
  getAvailableModels: async () => [],
  testConnection: async () => ({ ok: true }), getProviders: async () => ({}), clearModelConfig: async () => {},
  getMemoryConfig: async () => ({ enabled: true }), setMemoryConfig: async () => {},
  getVersion: async () => '0.0.0-test', getAgents: async () => [], listSkills: async () => [],
  listWorkspaces: async () => [], listAgentTemplates: async () => [],
  getOnboardingStatus: async () => ({ completed: true }), setOnboardingCompleted: async () => {},
  getRealtimeConfig: async () => ({ provider: 'openai', url: '', model: '', deployment: '', apiVersion: '', voice: 'alloy', hasKey: false }),
  steerChat: async () => ({ ok: true }), queueChat: async () => ({ ok: true }),
  getSources: async () => [], listModelPresets: async () => []
};
`

async function openChat(page: Page, model: Record<string, unknown>): Promise<void> {
  await page.addInitScript({ content: mockApi(model) })
  await page.goto('/')
  await page.waitForLoadState('networkidle')
  await page.evaluate(async () => {
    const store = (window as any).__chatStore
    await store.getState().newConversation('learner')
    store.setState({ messages: [{ id: 'm1', role: 'user', content: '你好', timestamp: Date.now() }] })
  })
  await page.locator('textarea').waitFor({ timeout: 5000 })
}

const modelChip = (page: Page) =>
  page.locator('button').filter({ has: page.locator('span.truncate') }).last()

test('模型控件不带图标，只有模型名（和思考档位）', async ({ page }) => {
  await openChat(page, { provider: 'custom', baseUrl: '', apiKey: '', model: 'glm-5.3', supportsThinking: true, supportsEffortDial: true })

  const chip = modelChip(page)
  await expect(chip).toBeVisible()
  await expect(chip).toContainText('glm-5.3')
  expect(await chip.locator('svg').count()).toBe(0)
})

test('思考关不掉的模型：菜单里没有"不思考"，胶囊上也不显示"关"', async ({ page }) => {
  await openChat(page, {
    provider: 'custom', baseUrl: '', apiKey: '', model: 'glm-5.3',
    supportsThinking: true, supportsEffortDial: true, thinkingAlwaysOn: true
  })

  // 会话里即使存着"关闭思考"，界面也按关不掉处理（请求侧已落到最低档）
  await page.evaluate(() => (window as any).__chatStore.getState().setConversationThinking(false))
  const chip = modelChip(page)
  await expect(chip).not.toContainText('关')

  await chip.click()
  await page.getByText('思考深度', { exact: true }).click()
  await expect(page.getByText('低', { exact: true })).toBeVisible()
  await expect(page.getByText('不思考', { exact: true })).toHaveCount(0)
})

test('档位菜单画主进程给的那几档：GLM-5.3 是 低/最高，没有"中"', async ({ page }) => {
  await openChat(page, {
    provider: 'custom', baseUrl: '', apiKey: '', model: 'glm-5.3',
    supportsThinking: true, supportsEffortDial: true, thinkingAlwaysOn: true,
    thinkingLevels: ['low', 'high', 'max']
  })

  await modelChip(page).click()
  await page.getByText('思考深度', { exact: true }).click()
  await expect(page.getByText('最高', { exact: true })).toBeVisible()
  await expect(page.getByText('中', { exact: true })).toHaveCount(0)
  await page.getByText('最高', { exact: true }).click()
  await expect(modelChip(page)).toContainText('最高')
})

test('思考关得掉的模型仍然给"不思考"这一行（对照）', async ({ page }) => {
  await openChat(page, { provider: 'custom', baseUrl: '', apiKey: '', model: 'some-model', supportsThinking: true, supportsEffortDial: true })

  await modelChip(page).click()
  await page.getByText('思考深度', { exact: true }).click()
  await expect(page.getByText('不思考', { exact: true })).toBeVisible()
})

import { test, expect, Page } from '@playwright/test'

/**
 * 输入框的模型控件契约：
 *  1. 模型名前面不再有那个所有模型共用的 Bot 图标（不携带任何信息）
 *  2. 思考关不掉的模型（GLM-5.3、grok-4 系）滑杆上没有"不思考"那一格——选了不生效、还会被服务端拒
 *  3. 滑杆的格数 = 主进程给的档位数（关得掉的再加一格），调档不关浮层
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

// 按 title 认胶囊：浮层打开后里面那行模型名也是「带 truncate 的按钮」，按结构找会认错
const modelChip = (page: Page) => page.locator('button[title="模型与思考深度"]')

const slider = (page: Page) => page.getByTestId('thinking-slider')
const levelLabel = (page: Page) => page.getByTestId('model-control-level')

test('模型名前面不带图标：胶囊第一个元素就是模型名', async ({ page }) => {
  await openChat(page, { provider: 'custom', baseUrl: '', apiKey: '', model: 'glm-5.3', supportsThinking: true, supportsEffortDial: true })

  const chip = modelChip(page)
  await expect(chip).toBeVisible()
  await expect(chip).toContainText('glm-5.3')
  expect(await chip.evaluate(el => el.firstElementChild?.tagName)).toBe('SPAN')
})

test('思考关不掉的模型：滑杆最左没有"不思考"那一格，胶囊上也不显示"关"', async ({ page }) => {
  await openChat(page, {
    provider: 'custom', baseUrl: '', apiKey: '', model: 'glm-5.3',
    supportsThinking: true, supportsEffortDial: true, thinkingAlwaysOn: true
  })

  // 会话里即使存着"关闭思考"，界面也按关不掉处理（请求侧已落到最低档）
  await page.evaluate(() => (window as any).__chatStore.getState().setConversationThinking(false))
  const chip = modelChip(page)
  await expect(chip).not.toContainText('关')

  await chip.click()
  // 缺省三档、没有 off → 3 格
  await expect(slider(page)).toHaveAttribute('max', '2')
  await slider(page).press('Home')
  await expect(levelLabel(page)).toHaveText('低')
})

test('滑杆画主进程给的那几档：GLM-5.3 是 低/高/最高，没有"中"', async ({ page }) => {
  await openChat(page, {
    provider: 'custom', baseUrl: '', apiKey: '', model: 'glm-5.3',
    supportsThinking: true, supportsEffortDial: true, thinkingAlwaysOn: true,
    thinkingLevels: ['low', 'high', 'max']
  })

  await modelChip(page).click()
  await expect(slider(page)).toHaveAttribute('max', '2')
  await slider(page).press('Home')
  await expect(levelLabel(page)).toHaveText('低')
  await slider(page).press('ArrowRight')
  await expect(levelLabel(page)).toHaveText('高')
  await slider(page).press('End')
  await expect(levelLabel(page)).toHaveText('最高')
  // 调档不关浮层，胶囊跟着变
  await expect(slider(page)).toBeVisible()
  await expect(modelChip(page)).toContainText('最高')
})

test('思考关得掉的模型最左多一格"关"（对照）；点刻度和拖到哪停哪是一回事', async ({ page }) => {
  await openChat(page, { provider: 'custom', baseUrl: '', apiKey: '', model: 'some-model', supportsThinking: true, supportsEffortDial: true })

  await modelChip(page).click()
  // off + 缺省三档 → 4 格
  await expect(slider(page)).toHaveAttribute('max', '3')
  await slider(page).press('Home')
  await expect(levelLabel(page)).toHaveText('关')
  await expect(modelChip(page)).not.toContainText('·')

  // 点最右端 → 最后一档；看得见的滑块和透明的原生滑块几何对齐，点哪停哪
  const box = (await slider(page).boundingBox())!
  await page.mouse.click(box.x + box.width - 6, box.y + box.height / 2)
  await expect(levelLabel(page)).toHaveText('高')
  await page.mouse.click(box.x + box.width / 3 + 5, box.y + box.height / 2)
  await expect(levelLabel(page)).toHaveText('低')

  // 真拖：从"低"那一格按住拖到最左 → 关；松手后浮层还在
  await page.mouse.move(box.x + box.width / 3 + 5, box.y + box.height / 2)
  await page.mouse.down()
  await page.mouse.move(box.x + 2, box.y + box.height / 2, { steps: 6 })
  await page.mouse.up()
  await expect(levelLabel(page)).toHaveText('关')
  await expect(slider(page)).toBeVisible()
})

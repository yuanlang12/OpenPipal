import { expect, test, type Page } from '@playwright/test'

const ARTIFACTS_DIR = 'tests/artifacts/model-settings'

/**
 * 模型设置主从两栏布局 E2E
 *
 * 盯四件事:左栏分组列表(内置/自定义)+ 在用绿点、右栏详情字段常驻可编辑、
 * 内置服务商不露连接信息(红线)、窄窗退化成两级推进。截图供目视验收。
 */
const MOCK_API = `
window.api = {
  getLocaleState: async () => ({ preference: 'zh-CN', locale: 'zh-CN' }),
  sendChat: () => {},
  abortChat: () => {},
  onStreamChunk: () => () => {},
  onStreamEnd: () => () => {},
  onTextFlush: () => () => {},
  onToolStart: () => () => {},
  onToolEnd: () => () => {},
  onAskUser: () => () => {},
  onTargetStatus: () => () => {},
  onAppChanged: () => () => {},
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
  isCustomConfig: async () => ({ isCustom: true }),
  getModelConfig: async () => ({ provider: 'custom', baseUrl: 'https://opencode.ai/zen/go/v1', apiKey: '', model: 'glm-5.3' }),
  getModelConfigFull: async () => ({ provider: 'custom', baseUrl: 'https://opencode.ai/zen/go/v1', apiKey: 'sk-x', model: 'glm-5.3' }),
  getAvailableModels: async () => [
    { id: 'b1', name: '', model: '', active: false, builtin: true, providerId: 'prov-builtin' },
    { id: 'm-glm', name: 'glm-5.3', model: 'glm-5.3', active: true, supportsThinking: true, providerId: 'prov-opencode', builtin: false },
    { id: 'm-qwen', name: 'qwen3.7-plus', model: 'qwen3.7-plus', active: false, supportsThinking: true, supportsEffortDial: true, providerId: 'prov-qwen', builtin: false }
  ],
  listModelProviders: async () => [
    { id: 'prov-builtin', name: '', provider: 'builtin', baseUrl: '', builtin: true, apiKeyMasked: '', modelCount: 1 },
    { id: 'prov-opencode', name: 'opencode go', provider: 'custom', baseUrl: 'https://opencode.ai/zen/go/v1', apiFormat: 'openai', apiKeyMasked: 'sk-ope…9x2', modelCount: 1 },
    { id: 'prov-qwen', name: 'Alibaba Model Studio', provider: 'custom', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', apiFormat: 'openai', thinkingFormat: 'qwen', thinkingBudgets: { low: 2048, medium: 8192, high: 32768 }, apiKeyMasked: 'sk-tes…1234', modelCount: 1 }
  ],
  getModelPresetFull: async () => null,
  updateModelProvider: async () => true,
  updateModelPreset: async () => true,
  saveModelConfig: async () => {},
  switchModelPreset: async () => true,
  deleteModelPreset: async () => {},
  testConnection: async () => ({ ok: true, model: 'glm-5.3' }),
  getProviders: async () => ({}),
  clearModelConfig: async () => {},
  getRealtimeConfig: async () => ({ provider: 'openai', url: '', model: '', deployment: '', apiVersion: '', voice: 'alloy', hasKey: false }),
  startRealtime: async () => ({ success: false }),
  stopRealtime: () => {},
  sendRealtimeEvent: () => {},
  onRealtimeEvent: () => () => {},
  onRealtimeState: () => () => {}
};
`

async function openModelTab(page: Page): Promise<void> {
  await page.addInitScript({ content: MOCK_API })
  await page.goto('/')
  await page.waitForLoadState('networkidle')
  await page.waitForSelector('textarea', { timeout: 10000 })
  await page.getByRole('button', { name: '设置' }).first().click()
  await page.getByRole('button', { name: '模型', exact: true }).click()
}

test.describe('模型设置 · 宽窗主从两栏', () => {
  test.use({ viewport: { width: 1100, height: 780 } })

  test('左栏分组 + 在用绿点，右栏详情字段常驻，内置不露连接信息', async ({ page }) => {
    await openModelTab(page)

    // 自动选中「当前在用」的服务商,详情字段直接可编辑
    const baseUrl = page.getByTestId('provider-base-url-prov-opencode')
    await expect(baseUrl).toBeVisible({ timeout: 5000 })
    await expect(baseUrl).toHaveValue('https://opencode.ai/zen/go/v1')
    await expect(page.getByTestId('provider-api-key-prov-opencode')).toBeVisible()
    await expect(page.getByText('模型列表')).toBeVisible()
    await expect(page.getByText('glm-5.3').first()).toBeVisible()

    // 左栏:内置/自定义两组都在,在用的那家亮绿点
    await expect(page.getByText('内置', { exact: true })).toBeVisible()
    await expect(page.getByText('自定义服务商', { exact: true })).toBeVisible()
    await page.screenshot({ path: `${ARTIFACTS_DIR}/wide-light.png` })

    // 切到另一家:字段跟着换
    await page.getByTestId('select-provider-prov-qwen').click()
    await expect(page.getByTestId('provider-base-url-prov-qwen'))
      .toHaveValue('https://dashscope.aliyuncs.com/compatible-mode/v1')
    await page.screenshot({ path: `${ARTIFACTS_DIR}/wide-second-provider.png` })

    // 内置服务商:红线——只有模型列表,没有任何连接字段
    await page.getByTestId('select-provider-prov-builtin').click()
    await expect(page.getByText('内置服务，连接信息由应用管理。')).toBeVisible()
    await expect(page.locator('[data-testid^="provider-base-url-"]')).toHaveCount(0)
    await page.screenshot({ path: `${ARTIFACTS_DIR}/wide-builtin.png` })

    // 「添加服务商」在右栏展开表单,不整页跳转 —— 左栏原地不动,点别家即放弃表单
    await page.getByTestId('model-add-new').click()
    await expect(page.getByTestId('model-provider-trigger')).toBeVisible()
    await expect(page.getByTestId('select-provider-prov-qwen')).toBeVisible()
    await page.screenshot({ path: `${ARTIFACTS_DIR}/wide-add-form-in-pane.png` })

    // 深色走真实主题通道
    await page.evaluate(() => (window as any).__appStore.getState().setTheme('dark'))
    await page.waitForTimeout(300)
    await page.getByTestId('select-provider-prov-opencode').click()
    await page.screenshot({ path: `${ARTIFACTS_DIR}/wide-dark.png` })
  })
})

test.describe('模型设置 · 窄窗两级推进', () => {
  test.use({ viewport: { width: 420, height: 700 } })

  test('先列表后详情，返回键回列表', async ({ page }) => {
    await openModelTab(page)
    // 420px 下会话侧栏会把设置内容区挤没,先收起(真机上用户也是这么用的)
    await page.getByTestId('sidebar-toggle').click()

    // 窄窗默认停在列表(详情不直接铺开)
    const row = page.getByTestId('select-provider-prov-opencode')
    await expect(row).toBeVisible({ timeout: 5000 })
    await page.screenshot({ path: `${ARTIFACTS_DIR}/narrow-list.png` })

    await row.click()
    await expect(page.getByTestId('provider-base-url-prov-opencode')).toBeVisible()
    await page.screenshot({ path: `${ARTIFACTS_DIR}/narrow-detail.png` })

    await page.getByTestId('model-detail-back').click()
    await expect(page.getByTestId('select-provider-prov-qwen')).toBeVisible()
  })
})

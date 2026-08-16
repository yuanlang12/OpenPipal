import { expect, test, type Page } from '@playwright/test'

const ARTIFACTS_DIR = 'tests/artifacts/model-catalog'

/**
 * 服务商 / 模型目录选择器（2026-08-15）。
 *
 * 从前设置页只有 5 个硬编码服务商、每家 2-4 个模型名；现在这张表直接来自 Pi 的目录
 * （主进程 getProviders 现算）。目录路径最大的收益不是"选项多"，是能力位不再问用户——
 * supportsImages 填错会让网关吃 400，目录里既然写着就该回填。
 *
 * 这里用一份形状真实的目录 mock 验 UI 接线；目录本身的规模与过滤规则由
 * tests/unit/model-catalog.test.ts 对着真数据验。
 */
const MOCK_API = `
window.__mockBus = {
  listeners: {},
  on(event, fn) {
    if (!this.listeners[event]) this.listeners[event] = [];
    this.listeners[event].push(fn);
    return () => { this.listeners[event] = this.listeners[event].filter(f => f !== fn); };
  }
};
window.__mockCalls = [];
window.__modelProvider = {
  id: 'prov-qwen',
  name: 'Alibaba Model Studio',
  provider: 'custom',
  baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  apiFormat: 'openai',
  apiKeyMasked: 'sk-tes…1234',
  modelCount: 1
};
window.__modelPreset = {
  id: 'qwen-37',
  name: 'qwen3.7-plus',
  model: 'qwen3.7-plus',
  active: true,
  supportsThinking: true,
  supportsEffortDial: true,
  providerId: 'prov-qwen',
  providerName: 'Alibaba Model Studio',
  builtin: false
};

window.api = {
  getLocaleState: async () => ({ preference: 'zh-CN', locale: 'zh-CN' }),
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
  listSources: async () => [],
  listAgentTemplates: async () => [],
  listAgentWorkspaces: async () => [],
  isCustomConfig: async () => ({ isCustom: true }),
  getModelConfig: async () => ({ provider: 'custom', baseUrl: window.__modelProvider.baseUrl, apiKey: '', model: 'qwen3.7-plus' }),
  getModelConfigFull: async () => ({ provider: 'custom', baseUrl: window.__modelProvider.baseUrl, apiKey: 'sk-test-1234', model: 'qwen3.7-plus' }),
  getAvailableModels: async () => [],
  listModelProviders: async () => [],
  getModelPresetFull: async () => ({
    ...window.__modelPreset,
    config: {
      provider: 'custom',
      baseUrl: window.__modelProvider.baseUrl,
      apiKey: 'sk-test-1234',
      model: 'qwen3.7-plus',
      apiFormat: 'openai',
      supportsThinking: true,
      supportsImages: true,
      thinkingFormat: window.__modelProvider.thinkingFormat || 'qwen',
      thinkingBudgets: window.__modelProvider.thinkingBudgets
    },
    rawConfig: {
      provider: 'custom',
      baseUrl: window.__modelProvider.baseUrl,
      apiKey: 'sk-test-1234',
      model: 'qwen3.7-plus',
      apiFormat: 'openai',
      supportsThinking: true,
      supportsImages: true
    }
  }),
  updateModelProvider: async (id, patch) => {
    window.__mockCalls.push({ method: 'updateModelProvider', args: [id, patch] });
    window.__modelProvider = { ...window.__modelProvider, ...patch };
    return true;
  },
  updateModelPreset: async (id, name, config) => {
    window.__mockCalls.push({ method: 'updateModelPreset', args: [id, name, config] });
    return true;
  },
  saveModelConfig: async () => {},
  switchModelPreset: async () => true,
  deleteModelPreset: async () => {},
  testConnection: async () => ({ ok: true, model: 'qwen3.7-plus' }),
  listRemoteModels: async (config) => {
    window.__mockCalls.push({ method: 'listRemoteModels', args: [config] });
    return window.__remoteModels || { ok: false, models: [], errorKey: 'settings.model.errors.remoteModelsUnsupported' };
  },
  testThinkingSupport: async () => ({ detected: true }),
  getProviders: async () => ({
    openai: {
      name: 'OpenAI',
      baseUrl: 'https://api.openai.com/v1',
      models: [
        { id: 'gpt-5', name: 'GPT-5', reasoning: true, image: true, contextWindow: 400000 },
        { id: 'gpt-5-mini', name: 'GPT-5 mini', reasoning: true, image: true, contextWindow: 400000 },
        { id: 'gpt-4o-mini', name: 'GPT-4o mini', reasoning: false, image: true, contextWindow: 128000 }
      ]
    },
    'opencode-go': {
      name: 'OpenCode Zen Go',
      baseUrl: 'https://opencode.ai/zen/go/v1',
      models: [
        { id: 'grok-4.5', name: 'Grok 4.5', reasoning: true, image: true, contextWindow: 500000 },
        { id: 'glm-5.2', name: 'GLM 5.2', reasoning: true, image: false, contextWindow: 200000 }
      ]
    }
  }),
  clearModelConfig: async () => {},
  getRealtimeConfig: async () => ({ provider: 'openai', url: '', model: '', deployment: '', apiVersion: '', voice: 'alloy', hasKey: false }),
  startRealtime: async () => ({ success: false }),
  stopRealtime: () => {},
  sendRealtimeEvent: () => {},
  onRealtimeEvent: () => () => {},
  onRealtimeState: () => () => {}
};
`

/** 服务商选择器已经不是原生 <select>：34 家时 macOS 的系统菜单会顶出窗口 */
async function pickProvider(page: Page, key: string): Promise<void> {
  await page.getByTestId('model-provider-trigger').click()
  await page.getByTestId(`model-provider-option-${key}`).click()
}

async function openAddModelForm(page: Page): Promise<void> {
  await page.addInitScript({ content: MOCK_API })
  await page.goto('/')
  await page.waitForLoadState('networkidle')
  await page.waitForSelector('textarea', { timeout: 10000 })
  await page.getByRole('button', { name: '设置' }).first().click()
  await page.getByRole('button', { name: '模型', exact: true }).click()
  await page.getByTestId('model-add-new').click()
  await expect(page.getByTestId('model-base-url')).toBeVisible()
}

test.use({ viewport: { width: 1100, height: 780 } })

test('T1 服务商下拉来自目录，选中即填官方地址且默认只读', async ({ page }) => {
  await openAddModelForm(page)

  await page.getByTestId('model-provider-trigger').click()
  const menu = page.getByTestId('model-provider-menu')
  await expect(menu).toBeVisible()
  await expect(menu).toContainText('OpenAI')
  await expect(menu).toContainText('OpenCode Zen Go')
  await expect(menu).toContainText('自定义')
  await page.getByTestId('model-provider-option-opencode-go').click()
  const baseUrl = page.getByTestId('model-base-url')
  await expect(baseUrl).toHaveValue('https://opencode.ai/zen/go/v1')
  await expect(baseUrl).toHaveAttribute('readonly', '')
  await expect(page.getByText('官方地址，来自模型目录')).toBeVisible()
  await page.screenshot({ path: `${ARTIFACTS_DIR}/01-provider-picked.png` })
})

test('T2 模型建议来自目录，输入即筛选，选中回填能力位', async ({ page }) => {
  await openAddModelForm(page)
  await pickProvider(page, 'openai')

  const modelInput = page.getByPlaceholder('模型名称')
  await modelInput.click()
  await expect(page.getByTestId('model-suggestion-gpt-5-mini')).toBeVisible()
  await expect(page.getByText('目录里共 3 个')).toBeVisible()

  await modelInput.fill('mini')
  await expect(page.getByTestId('model-suggestion-gpt-5-mini')).toBeVisible()
  await expect(page.getByTestId('model-suggestion-gpt-4o-mini')).toBeVisible()
  await page.screenshot({ path: `${ARTIFACTS_DIR}/02-model-filtered.png` })

  await page.getByTestId('model-suggestion-gpt-4o-mini').click()
  await expect(modelInput).toHaveValue('gpt-4o-mini')
  // gpt-4o-mini：目录说不思考 → 思考勾选框应保持未选中；上下文窗口按目录回填
  await expect(page.locator('input.sw-checkbox').first()).not.toBeChecked()
  await expect(page.locator('select').filter({ hasText: '128K' }).first()).toBeVisible()
  await page.screenshot({ path: `${ARTIFACTS_DIR}/03-capabilities-backfilled.png` })
})

test('T3 会思考的模型选中后思考开关自动打开', async ({ page }) => {
  await openAddModelForm(page)
  await pickProvider(page, 'opencode-go')
  const modelInput = page.getByPlaceholder('模型名称')
  await modelInput.click()
  await page.getByTestId('model-suggestion-grok-4.5').click()
  await expect(modelInput).toHaveValue('grok-4.5')
  await expect(page.locator('input.sw-checkbox').first()).toBeChecked()
})

test('T4 高级入口才允许改成镜像地址，可一键恢复官方地址', async ({ page }) => {
  await openAddModelForm(page)
  await pickProvider(page, 'openai')
  const baseUrl = page.getByTestId('model-base-url')

  await page.getByTestId('model-endpoint-advanced').click()
  await expect(baseUrl).not.toHaveAttribute('readonly', '')
  await baseUrl.fill('https://my-mirror.example.com/v1')
  await expect(baseUrl).toHaveValue('https://my-mirror.example.com/v1')
  await page.screenshot({ path: `${ARTIFACTS_DIR}/04-mirror-unlocked.png` })

  await page.getByTestId('model-endpoint-advanced').click()
  await expect(baseUrl).toHaveValue('https://api.openai.com/v1')
  await expect(baseUrl).toHaveAttribute('readonly', '')
})

test('T5 自定义仍是自定义：没有目录条目就不锁地址，也没有建议列表', async ({ page }) => {
  await openAddModelForm(page)
  await pickProvider(page, 'custom')
  const baseUrl = page.getByTestId('model-base-url')
  await expect(baseUrl).not.toHaveAttribute('readonly', '')
  await expect(page.getByText('官方地址，来自模型目录')).toHaveCount(0)
  await expect(page.getByText(/目录里共 \d+ 个/)).toHaveCount(0)
})

test('T6 浮层永远落在视口内：窗口再矮也不会被滚动容器裁掉、不会顶出屏幕', async ({ page }) => {
  await openAddModelForm(page)
  // 故意压矮窗口——旧实现在这个高度下，原生 select 的系统菜单会整体往上顶出窗口，
  // 模型建议的 absolute 浮层则会被 SettingsPanel 的 overflow-y-auto 裁掉
  await page.setViewportSize({ width: 1100, height: 460 })

  await page.getByTestId('model-provider-trigger').click()
  const providerMenu = page.getByTestId('model-provider-menu')
  await expect(providerMenu).toBeVisible()
  const providerBox = (await providerMenu.boundingBox())!
  expect(providerBox.y).toBeGreaterThanOrEqual(0)
  expect(providerBox.y + providerBox.height).toBeLessThanOrEqual(460)
  await page.screenshot({ path: `${ARTIFACTS_DIR}/05-provider-menu-in-viewport.png` })

  await page.getByTestId('model-provider-option-openai').click()
  const modelInput = page.getByPlaceholder('模型名称')
  await modelInput.click()
  const suggestions = page.getByTestId('model-suggestions')
  await expect(suggestions).toBeVisible()
  const box = (await suggestions.boundingBox())!
  expect(box.y).toBeGreaterThanOrEqual(0)
  expect(box.y + box.height).toBeLessThanOrEqual(460)
  await page.screenshot({ path: `${ARTIFACTS_DIR}/06-model-menu-in-viewport.png` })
})

test('T7 连接成功后自动向服务商要清单，列表换成服务商返回的模型', async ({ page }) => {
  await page.addInitScript({
    content: `window.__remoteModels = {
      ok: true,
      models: [
        { id: 'gpt-5', name: 'GPT-5', reasoning: true, image: true, contextWindow: 400000, known: true },
        { id: 'internal-preview-o9', known: false }
      ]
    };`
  })
  await openAddModelForm(page)
  await pickProvider(page, 'openai')
  await page.getByPlaceholder('sk-...').fill('sk-live-key')
  const modelInput = page.getByPlaceholder('模型名称')
  await modelInput.fill('gpt-5')          // 测试连接要求 key + 模型都填了
  await page.keyboard.press('Escape')     // 收起建议浮层，别挡住下面的按钮

  await page.getByRole('button', { name: '测试连接' }).click()
  await expect(page.getByText('服务商返回 2 个')).toBeVisible()

  await modelInput.fill('')
  await modelInput.click()
  const suggestions = page.getByTestId('model-suggestions')
  await expect(suggestions).toContainText('internal-preview-o9')
  // 目录里没有的 id 明说"目录外"——它的能力位没人替用户确认过
  await expect(suggestions).toContainText('目录外')
  // 目录里已有的 3 个 openai 模型被远端清单顶掉，只剩服务商真给的这两个
  await expect(suggestions).not.toContainText('gpt-4o-mini')
  await page.screenshot({ path: `${ARTIFACTS_DIR}/07-remote-models.png` })
})

test('T8 服务商不提供清单时只提示一行，目录与手填都还在', async ({ page }) => {
  await openAddModelForm(page)
  await pickProvider(page, 'openai')

  await page.getByTestId('model-fetch-remote').click()
  await expect(page.getByTestId('model-fetch-remote-error')).toContainText('手动填写模型 ID')
  // 退回目录，不影响继续选
  await expect(page.getByText('目录里共 3 个')).toBeVisible()
  const modelInput = page.getByPlaceholder('模型名称')
  await modelInput.click()
  await expect(page.getByTestId('model-suggestions')).toContainText('gpt-5-mini')
  await page.screenshot({ path: `${ARTIFACTS_DIR}/08-remote-unsupported.png` })
})

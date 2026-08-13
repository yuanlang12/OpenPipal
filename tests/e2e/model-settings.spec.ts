import { expect, test, type Page } from '@playwright/test'

/**
 * Qwen 思考配置设置页回归：
 * - 服务商可以定义默认协议和三档 thinking_budget
 * - 单模型默认继承，也可以保存自己的三档覆盖
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
  getAvailableModels: async () => [window.__modelPreset],
  listModelProviders: async () => [window.__modelProvider],
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
  testThinkingSupport: async () => ({ detected: true }),
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

async function openModelSettings(page: Page): Promise<void> {
  await page.addInitScript({ content: MOCK_API })
  await page.goto('/')
  await page.waitForLoadState('networkidle')
  await page.waitForSelector('textarea', { timeout: 10000 })
  await page.getByRole('button', { name: '设置' }).first().click()
  await page.getByRole('button', { name: '模型', exact: true }).click()
  await expect(page.getByText('qwen3.7-plus').first()).toBeVisible()
}

test.use({ viewport: { width: 1100, height: 780 } })

test('服务商默认与单模型覆盖都能从设置页保存', async ({ page }) => {
  await openModelSettings(page)

  await expect(page.getByText('思考 · 档位')).toBeVisible()
  await page.locator('[data-testid="edit-provider-prov-qwen"]').click()
  await page.locator('[data-testid="provider-thinking-format-prov-qwen"]').selectOption('qwen')
  await page.locator('[data-testid="provider-thinking-budget-prov-qwen-mode"]').selectOption('custom')
  await page.locator('[data-testid="provider-thinking-budget-prov-qwen-low"]').fill('1536')
  await page.locator('[data-testid="provider-thinking-budget-prov-qwen-medium"]').fill('6144')
  await page.locator('[data-testid="provider-thinking-budget-prov-qwen-high"]').fill('24576')
  await page.locator('[data-testid="save-provider-prov-qwen"]').click()

  const providerCall = await page.evaluate(() =>
    (window as any).__mockCalls.find((call: any) => call.method === 'updateModelProvider')
  )
  expect(providerCall.args).toEqual([
    'prov-qwen',
    expect.objectContaining({
      thinkingFormat: 'qwen',
      thinkingBudgets: { low: 1536, medium: 6144, high: 24576 }
    })
  ])

  await page.locator('[data-testid="edit-model-qwen-37"]').click()
  await expect(page.locator('[data-testid="model-thinking-budget-mode"]')).toHaveValue('auto')
  await page.locator('[data-testid="model-thinking-budget-mode"]').selectOption('custom')
  await page.locator('[data-testid="model-thinking-budget-low"]').fill('1024')
  await page.locator('[data-testid="model-thinking-budget-medium"]').fill('4096')
  await page.locator('[data-testid="model-thinking-budget-high"]').fill('16384')
  await page.locator('[data-testid="model-save"]').click()

  const modelCall = await page.evaluate(() =>
    (window as any).__mockCalls.find((call: any) => call.method === 'updateModelPreset')
  )
  expect(modelCall.args[0]).toBe('qwen-37')
  expect(modelCall.args[2]).toEqual(expect.objectContaining({
    model: 'qwen3.7-plus',
    thinkingFormat: 'auto',
    thinkingBudgets: { low: 1024, medium: 4096, high: 16384 }
  }))
})

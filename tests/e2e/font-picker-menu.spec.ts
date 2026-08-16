import { expect, test, type Page } from '@playwright/test'

const ARTIFACTS_DIR = 'tests/artifacts/font-picker'

/**
 * 外观页的字体选择器（2026-08-16）。
 *
 * 它原本是 `op-menu absolute … max-h-48`，和模型页那两个下拉是同一份写法——也就是
 * 同一个 bug：设置面板正文是 flex-1 overflow-y-auto，浮层滚到下半屏会被祖先裁掉。
 * 模型页那两个改成锚定浮层时这里被漏下了，仓库于是同时教着两种写法。这组用例把它
 * 钉在新写法上：窗口再矮，浮层也整体落在视口内。
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

async function openAppearanceSettings(page: Page): Promise<void> {
  await page.addInitScript({ content: MOCK_API })
  await page.goto('/')
  await page.waitForLoadState('networkidle')
  await page.waitForSelector('textarea', { timeout: 10000 })
  await page.getByRole('button', { name: '设置' }).first().click()
  await page.getByRole('button', { name: '外观', exact: true }).click()
}

test.use({ viewport: { width: 1100, height: 780 } })

test('F1 字体下拉是锚定浮层，点选即回填', async ({ page }) => {
  await openAppearanceSettings(page)

  const uiFont = page.getByTestId('font-input').first()
  await uiFont.scrollIntoViewIfNeeded()
  await uiFont.click()

  const menu = page.getByTestId('font-suggestions')
  await expect(menu).toBeVisible()
  await page.screenshot({ path: `${ARTIFACTS_DIR}/01-font-menu-open.png` })

  const first = menu.getByRole('option').first()
  const picked = (await first.textContent())!.trim()
  await first.click()
  await expect(menu).toHaveCount(0)
  await expect(uiFont).toHaveValue(picked)
})

test('F2 窗口压矮后浮层仍整体落在视口内——收编前会被设置面板裁掉', async ({ page }) => {
  await openAppearanceSettings(page)
  await page.setViewportSize({ width: 1100, height: 440 })

  const uiFont = page.getByTestId('font-input').first()
  await uiFont.scrollIntoViewIfNeeded()
  await uiFont.click()

  const menu = page.getByTestId('font-suggestions')
  await expect(menu).toBeVisible()
  const box = (await menu.boundingBox())!
  expect(box.y).toBeGreaterThanOrEqual(0)
  expect(box.y + box.height).toBeLessThanOrEqual(440)
  await page.screenshot({ path: `${ARTIFACTS_DIR}/02-font-menu-in-viewport.png` })
})

test('F3 Esc 关闭，点外面也关闭', async ({ page }) => {
  await openAppearanceSettings(page)
  const uiFont = page.getByTestId('font-input').first()
  await uiFont.scrollIntoViewIfNeeded()
  await uiFont.click()
  await expect(page.getByTestId('font-suggestions')).toBeVisible()

  await page.keyboard.press('Escape')
  await expect(page.getByTestId('font-suggestions')).toHaveCount(0)

  await uiFont.click()
  await expect(page.getByTestId('font-suggestions')).toBeVisible()
  await page.mouse.click(20, 400)
  await expect(page.getByTestId('font-suggestions')).toHaveCount(0)
})

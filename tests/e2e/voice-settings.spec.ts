import { test, expect, Page } from '@playwright/test'

const ARTIFACTS_DIR = 'tests/artifacts/voice-settings'

/**
 * P2 — 语音通话配置 UI E2E
 * 验证 Settings 面板"语音"tab 的字段展示、provider 切换、保存、测试连接调用链路。
 */
const MOCK_API = `
window.__mockBus = {
  listeners: {},
  on(event, fn) {
    if (!this.listeners[event]) this.listeners[event] = [];
    this.listeners[event].push(fn);
    return () => { this.listeners[event] = this.listeners[event].filter(f => f !== fn); };
  },
  emit(event, ...args) {
    (this.listeners[event] || []).forEach(fn => fn(...args));
  }
};
window.__mockCalls = [];
window.__mockSavedVoiceConfig = null;
window.__mockTestVoiceResult = { ok: true };

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

  // ── Realtime / Voice 相关 ──
  getRealtimeConfig: async () => ({
    provider: 'openai', url: '', model: '', deployment: '', apiVersion: '', voice: 'alloy', hasKey: false
  }),
  startRealtime: async () => ({ success: false }),
  stopRealtime: () => {},
  sendRealtimeEvent: () => {},
  onRealtimeEvent: () => () => {},
  onRealtimeState: () => () => {},

  // ── P2: Voice 配置 IPC ──
  getVoiceConfig: async () => ({
    provider: 'openai',
    baseUrl: 'https://api.302.ai/v1/realtime',
    apiKey: '',
    model: 'gpt-4o-realtime-preview-2024-12-17',
    deployment: '',
    apiVersion: '2025-04-01-preview',
    voice: 'alloy'
  }),
  saveVoiceConfig: async (config) => {
    window.__mockCalls.push({ method: 'saveVoiceConfig', args: config });
    window.__mockSavedVoiceConfig = config;
    return { ok: true };
  },
  testVoiceConnection: async (config) => {
    window.__mockCalls.push({ method: 'testVoiceConnection', args: config });
    return window.__mockTestVoiceResult;
  },
  // ── 音色试听 mock ──
  previewVoice: async (config, voice) => {
    window.__mockCalls.push({ method: 'previewVoice', args: { config, voice } });
    return (window.__mockPreviewResults && window.__mockPreviewResults[voice]) || { ok: true };
  },
  stopVoicePreview: () => { window.__mockCalls.push({ method: 'stopVoicePreview' }); },
  onVoicePreviewAudio: () => () => {}
};
window.__mockPreviewResults = {};
`

async function setup(page: Page): Promise<void> {
  await page.addInitScript({ content: MOCK_API })
  await page.goto('/')
  await page.waitForLoadState('networkidle')
  await page.waitForSelector('textarea', { timeout: 10000 })
}

async function openVoiceTab(page: Page): Promise<void> {
  await page.getByRole('button', { name: '设置' }).first().click()
  // SettingsPanel 渲染后 tab 出现（SettingsPanel 当前未带 settings-panel testid）
  await page.locator('text=语音').first().waitFor({ timeout: 3000 })
  await page.locator('text=语音').first().click()
  await page.waitForTimeout(200)
}

// 这组测试不测"挂靠侧栏模式"，需要更宽的视口让 SettingsPanel 主内容区有渲染空间。
// 默认 420×700 下 sidebar(~240) + tab 导航(w-44=176) 几乎占满，右侧 VoiceSettings 被挤到 0 宽。
test.use({ viewport: { width: 1000, height: 700 } })

test.describe('P2 — 语音通话配置', () => {
  test('Settings 包含"语音"tab', async ({ page }) => {
    await setup(page)
    await page.getByRole('button', { name: '设置' }).first().click()
    await page.waitForTimeout(300)

    const voiceTab = page.locator('text=语音').first()
    await expect(voiceTab).toBeVisible({ timeout: 3000 })

    await page.screenshot({ path: `${ARTIFACTS_DIR}/voice-tab-visible.png` })
    console.log('[P2-1] 语音 tab 出现 - 通过')
  })

  test('点击 voice tab 显示 VoiceSettings 组件 + 默认字段加载', async ({ page }) => {
    await setup(page)
    await openVoiceTab(page)

    // 组件渲染
    await expect(page.locator('[data-testid="voice-settings"]')).toBeVisible({ timeout: 3000 })

    // 默认值从 getVoiceConfig 加载
    await expect(page.locator('[data-testid="voice-provider-select"]')).toHaveValue('openai')
    await expect(page.locator('[data-testid="voice-baseurl-input"]')).toHaveValue(
      'https://api.302.ai/v1/realtime'
    )
    await expect(page.locator('[data-testid="voice-model-input"]')).toHaveValue(
      'gpt-4o-realtime-preview-2024-12-17'
    )
    // 音色默认 alloy(卡片选中态)
    await expect(page.locator('[data-testid="voice-card-alloy"]')).toHaveAttribute('data-selected', 'true')

    // OpenAI provider 下不显示 Azure 专属字段
    await expect(page.locator('[data-testid="voice-deployment-input"]')).toHaveCount(0)
    await expect(page.locator('[data-testid="voice-apiversion-input"]')).toHaveCount(0)

    await page.screenshot({ path: `${ARTIFACTS_DIR}/voice-default-openai.png` })
    console.log('[P2-2] VoiceSettings 默认渲染 - 通过')
  })

  test('切换到 Azure provider 显示 deployment + api-version 字段', async ({ page }) => {
    await setup(page)
    await openVoiceTab(page)

    await page.locator('[data-testid="voice-provider-select"]').selectOption('azure')
    await page.waitForTimeout(150)

    // Azure 专属字段出现
    await expect(page.locator('[data-testid="voice-deployment-input"]')).toBeVisible()
    await expect(page.locator('[data-testid="voice-apiversion-input"]')).toBeVisible()

    // api-version 有默认值
    await expect(page.locator('[data-testid="voice-apiversion-input"]')).toHaveValue(
      '2025-04-01-preview'
    )

    await page.screenshot({ path: `${ARTIFACTS_DIR}/voice-azure-fields.png` })
    console.log('[P2-3] Azure 字段动态显示 - 通过')
  })

  test('填表 + 保存调用 saveVoiceConfig 并传递 Azure 配置', async ({ page }) => {
    await setup(page)
    await openVoiceTab(page)

    // 切到 Azure
    await page.locator('[data-testid="voice-provider-select"]').selectOption('azure')
    await page.waitForTimeout(100)

    // 填表
    await page.locator('[data-testid="voice-baseurl-input"]').fill('https://my-aoai.openai.azure.com')
    await page.locator('[data-testid="voice-apikey-input"]').fill('test-azure-key-xxx')
    await page.locator('[data-testid="voice-model-input"]').fill('gpt-realtime-2')
    await page.locator('[data-testid="voice-deployment-input"]').fill('my-deployment')
    await page.locator('[data-testid="voice-select-marin"]').click()  // 点 marin 音色卡片

    // 保存
    await page.locator('[data-testid="voice-save-btn"]').click()
    await page.waitForTimeout(200)

    // 验证 IPC 调用
    const calls = await page.evaluate(() => window.__mockCalls)
    const saveCall = calls.find((c) => c.method === 'saveVoiceConfig')
    expect(saveCall).toBeTruthy()
    expect(saveCall!.args.provider).toBe('azure')
    expect(saveCall!.args.baseUrl).toBe('https://my-aoai.openai.azure.com')
    expect(saveCall!.args.apiKey).toBe('test-azure-key-xxx')
    expect(saveCall!.args.model).toBe('gpt-realtime-2')
    expect(saveCall!.args.deployment).toBe('my-deployment')
    expect(saveCall!.args.apiVersion).toBe('2025-04-01-preview')
    expect(saveCall!.args.voice).toBe('marin')

    // 保存反馈
    await expect(page.locator('[data-testid="voice-save-btn"]')).toContainText('已保存')

    await page.screenshot({ path: `${ARTIFACTS_DIR}/voice-azure-saved.png` })
    console.log('[P2-4] Azure 保存流程 - 通过')
  })

  test('测试连接：成功路径显示"连接成功"', async ({ page }) => {
    await setup(page)
    await openVoiceTab(page)

    await page.locator('[data-testid="voice-baseurl-input"]').fill('https://api.test.com/v1/realtime')
    await page.locator('[data-testid="voice-apikey-input"]').fill('sk-good')
    await page.locator('[data-testid="voice-test-btn"]').click()
    await page.waitForTimeout(300)

    // 应该调用 testVoiceConnection
    const calls = await page.evaluate(() => window.__mockCalls)
    expect(calls.find((c) => c.method === 'testVoiceConnection')).toBeTruthy()

    // 显示成功
    await expect(page.locator('text=连接成功')).toBeVisible({ timeout: 3000 })

    await page.screenshot({ path: `${ARTIFACTS_DIR}/voice-test-success.png` })
    console.log('[P2-5] 测试连接成功 - 通过')
  })

  test('测试连接：失败路径显示错误', async ({ page }) => {
    await setup(page)

    // 改写 mock 让测试失败
    await page.addInitScript({
      content: 'window.__overrideTestResult = true;'
    })

    await openVoiceTab(page)

    // 在浏览器中改 mock 行为
    await page.evaluate(() => {
      window.__mockTestVoiceResult = { ok: false, error: '401 invalid key' }
    })

    await page.locator('[data-testid="voice-baseurl-input"]').fill('https://api.test.com')
    await page.locator('[data-testid="voice-apikey-input"]').fill('sk-bad')
    await page.locator('[data-testid="voice-test-btn"]').click()
    await page.waitForTimeout(300)

    // 错误显示
    await expect(page.locator('text=401 invalid key')).toBeVisible({ timeout: 3000 })

    await page.screenshot({ path: `${ARTIFACTS_DIR}/voice-test-failure.png` })
    console.log('[P2-6] 测试连接失败显示错误 - 通过')
  })

  // ── 音色卡片 + 试听 ──
  test('音色卡片网格:10 个音色全渲染,marin/cedar 带「需 gpt-realtime」标注', async ({ page }) => {
    await setup(page)
    await openVoiceTab(page)

    await expect(page.locator('[data-testid="voice-card-grid"]')).toBeVisible({ timeout: 3000 })
    for (const v of ['alloy', 'echo', 'shimmer', 'ash', 'ballad', 'coral', 'sage', 'verse', 'marin', 'cedar']) {
      await expect(page.locator(`[data-testid="voice-card-${v}"]`)).toBeVisible()
    }
    // marin/cedar 带 GA 标注;alloy 不带
    await expect(page.locator('[data-testid="voice-card-marin"]')).toContainText('需 gpt-realtime')
    await expect(page.locator('[data-testid="voice-card-cedar"]')).toContainText('需 gpt-realtime')
    await expect(page.locator('[data-testid="voice-card-alloy"]')).not.toContainText('需 gpt-realtime')

    await page.screenshot({ path: `${ARTIFACTS_DIR}/voice-card-grid.png` })
    console.log('[P2-7] 音色卡片网格渲染 - 通过')
  })

  test('点卡片切换选中 + 保存传新音色', async ({ page }) => {
    await setup(page)
    await openVoiceTab(page)

    // 默认 alloy 选中,点 coral 切换
    await expect(page.locator('[data-testid="voice-card-alloy"]')).toHaveAttribute('data-selected', 'true')
    await page.locator('[data-testid="voice-select-coral"]').click()
    await expect(page.locator('[data-testid="voice-card-coral"]')).toHaveAttribute('data-selected', 'true')
    await expect(page.locator('[data-testid="voice-card-alloy"]')).toHaveAttribute('data-selected', 'false')

    // 保存带新音色
    await page.locator('[data-testid="voice-apikey-input"]').fill('sk-xxx')
    await page.locator('[data-testid="voice-save-btn"]').click()
    await page.waitForTimeout(150)
    const calls = await page.evaluate(() => window.__mockCalls)
    expect(calls.find((c) => c.method === 'saveVoiceConfig')!.args.voice).toBe('coral')

    console.log('[P2-8] 卡片选中 + 保存音色 - 通过')
  })

  test('▶ 试听:无 key 时禁用;填 key 后点击调用 previewVoice 传对应音色', async ({ page }) => {
    await setup(page)
    await openVoiceTab(page)

    // 无 key → 试听按钮禁用
    await expect(page.locator('[data-testid="voice-preview-coral"]')).toBeDisabled()

    // 填 key → 启用
    await page.locator('[data-testid="voice-apikey-input"]').fill('sk-xxx')
    await expect(page.locator('[data-testid="voice-preview-coral"]')).toBeEnabled()

    // 点击 → 调用 previewVoice('...', 'coral')
    await page.locator('[data-testid="voice-preview-coral"]').click()
    await page.waitForTimeout(150)
    const calls = await page.evaluate(() => window.__mockCalls)
    const pc = calls.find((c) => c.method === 'previewVoice')
    expect(pc).toBeTruthy()
    expect(pc!.args.voice).toBe('coral')

    console.log('[P2-9] 试听调用 previewVoice - 通过')
  })

  test('marin 在 preview 模型上试听失败 → 提示改用 gpt-realtime', async ({ page }) => {
    await setup(page)
    await openVoiceTab(page)

    // 让 marin 试听返回不支持
    await page.evaluate(() => {
      window.__mockPreviewResults = { marin: { ok: false, error: 'voice not supported' } }
    })
    await page.locator('[data-testid="voice-apikey-input"]').fill('sk-xxx')
    await page.locator('[data-testid="voice-preview-marin"]').click()
    await page.waitForTimeout(200)

    const err = page.locator('[data-testid="voice-preview-error"]')
    await expect(err).toBeVisible({ timeout: 3000 })
    await expect(err).toContainText('gpt-realtime')

    await page.screenshot({ path: `${ARTIFACTS_DIR}/voice-marin-hint.png` })
    console.log('[P2-10] marin 不支持提示换模型 - 通过')
  })
})

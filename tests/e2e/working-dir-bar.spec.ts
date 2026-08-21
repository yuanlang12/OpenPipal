import { test, expect, Page } from '@playwright/test'

const ARTIFACTS_DIR = 'tests/artifacts/working-dir'

/**
 * 工作目录条 E2E
 *
 * 「在哪个目录里对话」是同一个功能，只是两页输入框位置不同：欢迎页贴输入框底、
 * 对话页贴输入框顶。这里盯三件事：两页都在、贴边(与输入框有重叠，不是并排一条)、
 * 选中后显示目录名且能清除。截图供目视验收。
 */
const MOCK_API = `
window.__mockCalls = [];
window.api = {
  getLocaleState: async () => ({ preference: 'zh-CN', locale: 'zh-CN' }),
  sendChat: (...a) => { window.__mockCalls.push(['sendChat', a]); },
  abortChat: () => {},
  onStreamChunk: () => () => {},
  onStreamEnd: () => () => {},
  onTextFlush: () => () => {},
  onToolStart: () => () => {},
  onToolEnd: () => () => {},
  onAskUser: () => () => {},
  onTargetStatus: () => () => {},
  onAppChanged: () => () => {},
  selectDirectory: async () => { window.__mockCalls.push(['selectDirectory']); return '/Users/x/Documents/my-project'; },
  updateConversationConfig: async (...a) => { window.__mockCalls.push(['updateConversationConfig', a]); return { ok: true }; },
  getRoleInitState: async () => ({ hasRole: true, role: { name: 'learner', displayName: '学习助手', icon: '📖' } }),
  getAllRoles: async () => [{ name: 'learner', displayName: '学习助手', icon: '📖' }],
  getCurrentRole: async () => ({ name: 'learner', displayName: '学习助手', icon: '📖' }),
  switchRole: async () => ({ name: 'learner', displayName: '学习助手', icon: '📖' }),
  listConversations: async () => [],
  createConversation: async (role) => ({ id: 'conv-dir', title: '目录条测试', role, createdAt: Date.now(), updatedAt: Date.now(), messageCount: 0 }),
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
  listSkills: async () => [],
  listWorkspaces: async () => [],
  listAgentTemplates: async () => [],
  getOnboardingStatus: async () => ({ completed: true }),
  getRealtimeConfig: async () => ({ provider: 'openai', url: '', model: '', deployment: '', apiVersion: '', voice: 'alloy', hasKey: false }),
  startRealtime: async () => ({ success: false }),
  stopRealtime: () => {},
  sendRealtimeEvent: () => {},
  onRealtimeEvent: () => () => {},
  onRealtimeState: () => () => {}
};
`

async function boot(page: Page): Promise<void> {
  await page.addInitScript({ content: MOCK_API })
  await page.goto('/')
  await page.waitForLoadState('networkidle')
  await page.waitForSelector('textarea', { timeout: 10000 })
}

/** 造一条已有消息，把界面推到对话页（InputBar 停在窗口底部） */
async function enterChat(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const store = (window as any).__chatStore
    await store.getState().newConversation('learner')
    store.setState({ messages: [{ id: 'init', role: 'user', content: 'hi', timestamp: Date.now() }] })
  })
  await page.waitForSelector('[data-testid="inputbar-plus-btn"]', { timeout: 5000 })
}

/** 目录条与输入框必须有纵向重叠 —— 贴边(压在下面)而不是隔开的一条 */
async function expectDocked(page: Page, composer: string, side: 'above' | 'below'): Promise<void> {
  const bar = await page.getByTestId('working-dir-bar').boundingBox()
  const box = await page.locator(composer).first().boundingBox()
  expect(bar && box).toBeTruthy()
  if (!bar || !box) return
  if (side === 'above') {
    expect(bar.y).toBeLessThan(box.y)                 // 在输入框上方
    expect(bar.y + bar.height).toBeGreaterThan(box.y) // 且压进去
  } else {
    expect(bar.y).toBeGreaterThan(box.y)
    expect(bar.y).toBeLessThan(box.y + box.height)    // 贴着底边压进去
  }
}

test.describe('工作目录条 · 欢迎页贴输入框底', () => {
  test.use({ viewport: { width: 900, height: 820 } })

  test('默认「选择工作目录」，选完显示目录名并可清除', async ({ page }) => {
    await boot(page)
    const bar = page.getByTestId('working-dir-bar')
    await expect(bar).toBeVisible()
    await expect(bar).toContainText('选择工作目录')
    await expect(page.getByTestId('working-dir-clear')).toHaveCount(0)
    await expectDocked(page, '.op-composer-solid', 'below')
    await page.screenshot({ path: `${ARTIFACTS_DIR}/welcome-empty.png` })

    await bar.getByRole('button').first().click()
    await expect(bar).toContainText('my-project')
    await page.screenshot({ path: `${ARTIFACTS_DIR}/welcome-picked.png` })

    // 深色走真实主题通道（applyTheme 重算全部 token）
    await page.evaluate(() => (window as any).__appStore.getState().setTheme('dark'))
    await page.waitForTimeout(300)
    await page.screenshot({ path: `${ARTIFACTS_DIR}/welcome-picked-dark.png` })
    await page.evaluate(() => (window as any).__appStore.getState().setTheme('light'))

    await page.getByTestId('working-dir-clear').click()
    await expect(bar).toContainText('选择工作目录')
    await expect(page.getByTestId('working-dir-clear')).toHaveCount(0)
  })
})

test.describe('工作目录条 · 对话页贴输入框顶', () => {
  test.use({ viewport: { width: 900, height: 820 } })

  test('同一个条子换到输入框上边，选择结果跟着会话走', async ({ page }) => {
    await boot(page)
    await enterChat(page)

    const bar = page.getByTestId('working-dir-bar')
    await expect(bar).toBeVisible()
    await expectDocked(page, '.op-composer', 'above')
    await page.screenshot({ path: `${ARTIFACTS_DIR}/chat-empty.png` })

    await bar.getByRole('button').first().click()
    await expect(bar).toContainText('my-project')
    expect(await page.evaluate(() => (window as any).__chatStore.getState().conversationConfig?.workingDir))
      .toBe('/Users/x/Documents/my-project')
    await page.screenshot({ path: `${ARTIFACTS_DIR}/chat-picked.png` })

    await page.evaluate(() => (window as any).__appStore.getState().setTheme('dark'))
    await page.waitForTimeout(300)
    await page.screenshot({ path: `${ARTIFACTS_DIR}/chat-picked-dark.png` })
  })
})

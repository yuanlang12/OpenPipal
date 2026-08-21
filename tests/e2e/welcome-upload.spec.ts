import { test, expect, Page } from '@playwright/test'

const ARTIFACTS_DIR = 'tests/artifacts/welcome-upload'

/**
 * 欢迎页「+」上传 E2E
 *
 * 上传在两页是同一件事（同一份进料规则：图片内联 / 其余上传成待发附件），
 * 以前只有对话页有入口。这里盯三件事：+ 能选文件、附件挂在输入框里可删、
 * 只挂文件不打字也能发且路径进得了请求。
 */
const MOCK_API = `
window.__mockCalls = [];
window.api = {
  getLocaleState: async () => ({ preference: 'zh-CN', locale: 'zh-CN' }),
  sendChat: (...a) => { window.__mockCalls.push(['sendChat', JSON.stringify(a).slice(0, 4000)]); },
  abortChat: () => {},
  onStreamChunk: () => () => {},
  onStreamEnd: () => () => {},
  onTextFlush: () => () => {},
  onToolStart: () => () => {},
  onToolEnd: () => () => {},
  onAskUser: () => () => {},
  onTargetStatus: () => () => {},
  onAppChanged: () => () => {},
  hasApiKey: async () => ({ hasKey: true }),
  openFileDialog: async () => { window.__mockCalls.push(['openFileDialog']); return window.__nextFiles || ['/tmp/season-report.pdf']; },
  uploadFile: async (p) => ({ fileName: p.split('/').pop(), sizeBytes: 20480, path: '/ws/uploads/' + p.split('/').pop() }),
  readFileBase64: async () => 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  persistChatImages: async () => [],
  getRoleInitState: async () => ({ hasRole: true, role: { name: 'general', displayName: '通用助手', icon: '✦' } }),
  getAllRoles: async () => [{ name: 'general', displayName: '通用助手', icon: '✦' }],
  getCurrentRole: async () => ({ name: 'general', displayName: '通用助手', icon: '✦' }),
  switchRole: async () => ({ name: 'general', displayName: '通用助手', icon: '✦' }),
  listConversations: async () => [],
  createConversation: async (role) => ({ id: 'conv-upload', title: '上传测试', role, createdAt: Date.now(), updatedAt: Date.now(), messageCount: 0 }),
  getConversationMessages: async () => [],
  replaceMessages: async () => {},
  appendMessages: async () => {},
  deleteConversation: async () => {},
  updateConversationConfig: async () => ({ ok: true }),
  getAppSettings: async () => ({ detected: [], disabled: [], browsers: [] }),
  isCustomConfig: async () => ({ isCustom: false }),
  getAvailableModels: async () => [],
  getModelConfig: async () => ({ provider: 'openai', baseUrl: '', apiKey: '', model: '' }),
  getModelConfigFull: async () => ({ provider: 'openai', baseUrl: '', apiKey: '', model: 'gpt-4o' }),
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

test.use({ viewport: { width: 900, height: 820 } })

test.describe('欢迎页 + 上传', () => {
  test('选文件 → 附件挂进输入框 → 不打字也能发，路径进请求', async ({ page }) => {
    await boot(page)

    // 空输入时发送按钮是灰的
    await expect(page.getByTestId('send-btn')).toBeDisabled()

    await page.getByTestId('welcome-upload-btn').click()
    const chip = page.getByTestId('welcome-file-chip')
    await expect(chip).toHaveCount(1)
    await expect(chip).toContainText('season-report.pdf')
    await page.screenshot({ path: `${ARTIFACTS_DIR}/welcome-attached.png` })

    // 只挂文件也算内容 → 可发送
    await expect(page.getByTestId('send-btn')).toBeEnabled()
    await page.getByTestId('send-btn').click()

    await expect(async () => {
      const calls = await page.evaluate(() => (window as any).__mockCalls)
      const send = calls.filter((c: any[]) => c[0] === 'sendChat')
      expect(send.length).toBeGreaterThan(0)
      const payload = send.map((c: any[]) => c[1]).join('')
      expect(payload).toContain('/ws/uploads/season-report.pdf')
      expect(payload).toContain('请分析这个文件')   // 正文留空 → chatStore 补的默认请求
    }).toPass({ timeout: 5000 })
  })

  test('附件可删除；图片走内联缩略图而不是附件条', async ({ page }) => {
    await boot(page)

    await page.getByTestId('welcome-upload-btn').click()
    await expect(page.getByTestId('welcome-file-chip')).toHaveCount(1)
    await page.getByTestId('welcome-file-chip').getByRole('button').click()
    await expect(page.getByTestId('welcome-file-chip')).toHaveCount(0)
    await expect(page.getByTestId('send-btn')).toBeDisabled()

    // 图片：同一个入口，进的是图片缩略图（附件条里不该出现）
    await page.evaluate(() => { (window as any).__nextFiles = ['/tmp/shot.png'] })
    await page.getByTestId('welcome-upload-btn').click()
    await expect(page.locator('.op-composer-solid img')).toHaveCount(1)
    await expect(page.getByTestId('welcome-file-chip')).toHaveCount(0)
    await page.screenshot({ path: `${ARTIFACTS_DIR}/welcome-image.png` })
  })
})

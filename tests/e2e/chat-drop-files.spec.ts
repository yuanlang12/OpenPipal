import { test, expect, Page } from '@playwright/test'

const ARTIFACTS_DIR = 'tests/artifacts/chat-drop-files'

/**
 * 拖文件进窗口（所有者 2026-09-15：输入框还不支持拖拽；整个界面识别、对话区亮一圈、松手进输入框）：
 *   1. 欢迎页：拖进来输入框亮边，松手 → 附件条挂进输入框（与 + 上传同一条进料）
 *   2. 对话页：拖到消息列（不是输入框）也认——对话区盖提示层，松手 → 附件进输入框；图片走内联缩略图
 *   3. 拖出窗口 / 拖的是文字不是文件：不亮
 * mock window.api：getPathForFile 给非图片一个假路径（桌面端由 preload 的 webUtils 给），图片不给 → 走浏览器 base64 路
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
  getPathForFile: (f) => f.type.startsWith('image/') ? undefined : '/tmp/' + f.name,
  uploadFile: async (p) => ({ fileName: p.split('/').pop(), sizeBytes: 20480, path: '/ws/uploads/' + p.split('/').pop() }),
  readFileBase64: async () => 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  persistChatImages: async () => [],
  getRoleInitState: async () => ({ hasRole: true, role: { name: 'general', displayName: '通用助手', icon: '✦' } }),
  getAllRoles: async () => [{ name: 'general', displayName: '通用助手', icon: '✦' }],
  getCurrentRole: async () => ({ name: 'general', displayName: '通用助手', icon: '✦' }),
  switchRole: async () => ({ name: 'general', displayName: '通用助手', icon: '✦' }),
  listConversations: async () => [],
  createConversation: async (role) => ({ id: 'conv-drop', title: '拖放测试', role, createdAt: Date.now(), updatedAt: Date.now(), messageCount: 0 }),
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

/** 在页面里造一次真的拖放：DataTransfer 带文件，事件从 target 冒泡到 document */
async function drag(page: Page, type: 'dragenter' | 'dragover' | 'dragleave' | 'drop', target: string, files: Array<{ name: string; mime: string }>): Promise<void> {
  await page.evaluate(({ type, target, files }) => {
    const dt = new DataTransfer()
    for (const f of files) dt.items.add(new File(['x'], f.name, { type: f.mime }))
    const el = document.querySelector(target) ?? document.body
    el.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt }))
  }, { type, target, files })
}

const PDF = [{ name: 'notes.pdf', mime: 'application/pdf' }]

test.use({ viewport: { width: 900, height: 820 } })

test('欢迎页：拖进来输入框亮边，松手附件挂进输入框，与 + 上传同一条', async ({ page }) => {
  await boot(page)
  const composer = page.locator('.op-composer-solid')
  await expect(composer).not.toHaveClass(/op-composer--drop/)

  await drag(page, 'dragenter', 'body', PDF)
  await drag(page, 'dragover', 'body', PDF)
  await expect(composer).toHaveClass(/op-composer--drop/)
  await expect(page.getByTestId('file-drop-highlight')).toBeVisible() // 欢迎页也有那圈外框（所有者 2026-09-16：只亮输入框看不见）
  await page.screenshot({ path: `${ARTIFACTS_DIR}/01-welcome-dragging.png` })

  await drag(page, 'drop', 'body', PDF)
  await expect(composer).not.toHaveClass(/op-composer--drop/)
  await expect(page.getByTestId('file-drop-highlight')).toHaveCount(0)
  await expect(page.getByTestId('welcome-file-chip')).toHaveCount(1)
  await expect(page.getByTestId('welcome-file-chip')).toContainText('notes.pdf')
  await expect(page.getByTestId('send-btn')).toBeEnabled()
  await page.screenshot({ path: `${ARTIFACTS_DIR}/02-welcome-dropped.png` })
})

test('对话页：拖到消息列也认——对话区盖提示层，松手附件进输入框；图片走内联；拖出窗口就灭', async ({ page }) => {
  await boot(page)
  // 先发一句进对话页（欢迎页只在没消息时显示）
  await page.locator('textarea').fill('你好')
  await page.getByTestId('send-btn').click()
  await expect(page.getByTestId('chat-scroll')).toBeVisible()
  await expect(page.getByTestId('file-drop-highlight')).toHaveCount(0)

  // 拖到消息列上（不是输入框）：提示层盖住对话区、输入框亮边
  await drag(page, 'dragenter', '[data-testid="chat-scroll"]', PDF)
  await drag(page, 'dragover', '[data-testid="chat-scroll"]', PDF)
  await expect(page.getByTestId('file-drop-highlight')).toBeVisible()
  await expect(page.getByTestId('file-drop-highlight')).toContainText('松手')
  await expect(page.locator('.op-composer')).toHaveClass(/op-composer--drop/)
  await page.screenshot({ path: `${ARTIFACTS_DIR}/03-chat-dragging.png` })

  // 拖出窗口：灭
  await drag(page, 'dragleave', '[data-testid="chat-scroll"]', PDF)
  await expect(page.getByTestId('file-drop-highlight')).toHaveCount(0)

  // 再拖进来、松手在消息列上：附件进输入框
  await drag(page, 'dragenter', '[data-testid="chat-scroll"]', PDF)
  await drag(page, 'drop', '[data-testid="chat-scroll"]', PDF)
  await expect(page.getByTestId('file-drop-highlight')).toHaveCount(0)
  await expect(page.getByTestId('input-file-chip')).toHaveCount(1)
  await expect(page.getByTestId('input-file-chip')).toContainText('notes.pdf')

  // 图片（浏览器模式拿不到路径）：内联缩略图，不进附件条
  const shot = [{ name: 'shot.png', mime: 'image/png' }]
  await drag(page, 'dragenter', 'body', shot)
  await drag(page, 'drop', 'body', shot)
  await expect(page.locator('.op-composer img')).toHaveCount(1)
  await expect(page.getByTestId('input-file-chip')).toHaveCount(1)
  await page.screenshot({ path: `${ARTIFACTS_DIR}/04-chat-dropped.png` })

  // 拖的是文字不是文件：不亮
  await page.evaluate(() => {
    const dt = new DataTransfer()
    dt.setData('text/plain', '一段文字')
    document.body.dispatchEvent(new DragEvent('dragenter', { bubbles: true, cancelable: true, dataTransfer: dt }))
  })
  await expect(page.getByTestId('file-drop-highlight')).toHaveCount(0)
})

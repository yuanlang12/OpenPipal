import { test, expect, Page } from '@playwright/test'

const ARTIFACTS_DIR = 'tests/artifacts/mark-studio-colors'

/**
 * 捏头像的两层色（所有者 2026-09-16：身体也要彩色，配饰另配一个搭得上的色；随机配按搭配表，手捏不设限）：
 *   1. 弹窗里颜色分两行：身体 / 配饰，各九个色
 *   2. 没手选配饰色时跟着身体色自动搭（换身体色，配饰行的选中跟着跳）
 *   3. 手选配饰色后定住，换身体色也不动；保存时两色都落盘
 *   4. 预览：身体填的是身体色，配饰画的是配饰色
 */
const MOCK_API = `
window.__mockCalls = [];
window.api = {
  getLocaleState: async () => ({ preference: 'zh-CN', locale: 'zh-CN' }),
  sendChat: () => {}, abortChat: () => {},
  onStreamChunk: () => () => {}, onStreamEnd: () => () => {}, onTextFlush: () => () => {},
  onToolStart: () => () => {}, onToolEnd: () => () => {}, onAskUser: () => () => {},
  onTargetStatus: () => () => {}, onAppChanged: () => () => {},
  hasApiKey: async () => ({ hasKey: true }),
  getMark: async () => null,
  saveMark: async (scope, id, config) => { window.__mockCalls.push(['saveMark', scope, id, config]); return true },
  getRoleInitState: async () => ({ hasRole: true, role: { name: 'general', displayName: '通用助手', icon: '✦' } }),
  getAllRoles: async () => [
    { name: 'general', displayName: '通用助手', icon: '✦' },
    { name: 'teacher', displayName: '老师', icon: '📚' },
    { name: 'interpreter', displayName: '同传', icon: '🎧' },
    { name: 'chef', displayName: '厨师', icon: '🍳', mark: { accessory: 'chefhat', hue: 'red' } },
  ],
  getCurrentRole: async () => ({ name: 'general', displayName: '通用助手', icon: '✦' }),
  switchRole: async (n) => ({ name: n, displayName: n, icon: '✦' }),
  listConversations: async () => [],
  createConversation: async (role) => ({ id: 'conv-1', title: '', role, createdAt: Date.now(), updatedAt: Date.now(), messageCount: 0 }),
  getConversationMessages: async () => [],
  replaceMessages: async () => {}, appendMessages: async () => {}, deleteConversation: async () => {},
  updateConversationConfig: async () => ({ ok: true }),
  getAppSettings: async () => ({ detected: [], disabled: [], browsers: [] }),
  isCustomConfig: async () => ({ isCustom: false }),
  getAvailableModels: async () => [],
  getModelConfig: async () => ({ provider: 'openai', baseUrl: '', apiKey: '', model: '' }),
  getModelConfigFull: async () => ({ provider: 'openai', baseUrl: '', apiKey: '', model: 'gpt-4o' }),
  listSkills: async () => [], listWorkspaces: async () => [], listAgentTemplates: async () => [],
  getOnboardingStatus: async () => ({ completed: true }),
  getRealtimeConfig: async () => ({ provider: 'openai', url: '', model: '', deployment: '', apiVersion: '', voice: 'alloy', hasKey: false }),
  startRealtime: async () => ({ success: false }), stopRealtime: () => {}, sendRealtimeEvent: () => {},
  onRealtimeEvent: () => () => {}, onRealtimeState: () => () => {}
};
`

async function boot(page: Page): Promise<void> {
  await page.addInitScript({ content: MOCK_API })
  await page.goto('/')
  await page.waitForLoadState('networkidle')
  await page.waitForSelector('textarea', { timeout: 10000 })
}

const pressed = (page: Page, of: 'body' | 'accessory'): Promise<string | null> =>
  page.getByTestId(`mark-color-${of}`).locator('button[aria-pressed="true"]').getAttribute('aria-label')

test.use({ viewport: { width: 1000, height: 820 } })

test('捏头像：身体 / 配饰两行色，配饰色自动搭、手选后定住，两色一起落盘', async ({ page }) => {
  await boot(page)
  // 老师那格的捏头像入口（悬停才显形；测试直接点）
  await page.getByRole('button', { name: '捏头像' }).nth(1).click({ force: true })
  const dialog = page.getByRole('dialog')
  await expect(dialog).toBeVisible()
  await expect(page.getByTestId('mark-color-body').locator('button')).toHaveCount(9)
  await expect(page.getByTestId('mark-color-accessory').locator('button')).toHaveCount(9)

  // 老师默认：红身体，配饰色自动搭成青（搭配表 red → teal）
  expect(await pressed(page, 'body')).toBe('红')
  expect(await pressed(page, 'accessory')).toBe('青')
  await page.screenshot({ path: `${ARTIFACTS_DIR}/01-studio-teacher.png` })

  // 换身体色为蓝：配饰色跟着跳到琥珀
  await page.getByTestId('mark-color-body').getByRole('button', { name: '蓝' }).click()
  expect(await pressed(page, 'accessory')).toBe('琥珀')

  // 手选配饰色玫瑰，再换身体色为青：配饰色不动
  await page.getByTestId('mark-color-accessory').getByRole('button', { name: '玫瑰' }).click()
  await page.getByTestId('mark-color-body').getByRole('button', { name: '青' }).click()
  expect(await pressed(page, 'body')).toBe('青')
  expect(await pressed(page, 'accessory')).toBe('玫瑰')

  // 预览：身体填青、配饰画玫瑰
  const preview = dialog.locator('svg.sw-agent-mark').first()
  await expect(preview.locator('path[mask]')).toHaveAttribute('fill', 'var(--sw-mark-teal)')
  const propColor = await preview.locator('g[style]').last().evaluate(el => (el as HTMLElement).style.color)
  expect(propColor).toBe('var(--sw-mark-rose)')
  await page.screenshot({ path: `${ARTIFACTS_DIR}/02-studio-picked.png` })

  await dialog.getByRole('button', { name: '保存' }).click()
  const calls = await page.evaluate(() => (window as unknown as { __mockCalls: unknown[] }).__mockCalls)
  expect(calls).toEqual([['saveMark', 'role', 'teacher', { accessory: 'scarf', hue: 'teal', accent: 'rose', shape: 'square' }]])
})

test('欢迎页头像条：伸到身体上方的配饰（耳机头梁、厨师帽）不被条的上沿裁掉', async ({ page }) => {
  await boot(page)
  const strip = page.getByTestId('welcome-avatar-strip')
  const box = (await strip.boundingBox())!
  const buttons = strip.locator('button[aria-pressed]')
  await expect(buttons).toHaveCount(4)
  for (let i = 0; i < 4; i++) {
    await buttons.nth(i).hover() // 悬停放大到 1：配饰伸得最远的时候
    const props = await buttons.nth(i).locator('svg.sw-agent-mark g[style]').evaluateAll(els => els.map(el => el.getBoundingClientRect()))
    for (const r of props) {
      expect(r.top, `第 ${i} 个头像的配饰顶到条外`).toBeGreaterThanOrEqual(box.y - 0.5)
      expect(r.bottom, `第 ${i} 个头像的配饰底到条外`).toBeLessThanOrEqual(box.y + box.height + 0.5)
    }
  }
  await page.screenshot({ path: `${ARTIFACTS_DIR}/03-welcome-strip.png` })
})

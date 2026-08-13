/**
 * E2E: OpenPipal Theme System (openpipal-theme-v1)
 *
 * 测试策略:
 *   1. 纯 CSS 验证 — 不依赖 UI 渲染,直接读 :root 的 CSS variables
 *   2. localStorage round-trip — 不依赖 Settings UI,通过直接写 localStorage 后 reload
 *      验证 initThemeOnLoad / parseThemeString / applyTheme 端到端
 *
 * UI 交互测试(切深色、导入字符串、滑块)留作手测,因为 baseline E2E mock 已 stale
 * (29 个 pre-existing failures,不在本次范围内修)
 */
import { test, expect, Page } from '@playwright/test'

const MOCK_API = `
window.__mockBus = { listeners: {}, on(e, fn){ (this.listeners[e]=this.listeners[e]||[]).push(fn); return () => {} }, emit(){} };
window.api = {
  sendChat: () => {}, abortChat: () => {},
  onStreamChunk: () => () => {}, onStreamEnd: () => () => {},
  onTextFlush: () => () => {}, onToolStart: () => () => {}, onToolEnd: () => () => {},
  onAskUser: () => () => {}, onTargetStatus: () => () => {}, onAppChanged: () => () => {},
  onPermissionRequest: () => () => {}, onThinking: () => () => {}, onThinkingEnd: () => () => {},
  onVisualizerDelta: () => () => {}, onArtifactDelta: () => () => {}, onArtifactComplete: () => () => {},
  getRoleInitState: async () => ({ hasRole: true, role: { name: 'learner', displayName: '学习助手', icon: '📖' } }),
  getAllRoles: async () => [{ name: 'learner', displayName: '学习助手', icon: '📖' }],
  getCurrentRole: async () => ({ name: 'learner', displayName: '学习助手', icon: '📖' }),
  switchRole: async () => ({ name: 'learner', displayName: '学习助手', icon: '📖' }),
  listConversations: async () => [],
  createConversation: async (role) => ({ id: 'mock-conv', title: '新对话', role, createdAt: Date.now(), updatedAt: Date.now(), messageCount: 0 }),
  getConversationMessages: async () => [],
  replaceMessages: async () => {}, appendMessages: async () => {}, deleteConversation: async () => {},
  getAppSettings: async () => ({ detected: [], disabled: [], browsers: [] }),
  setDisabledApps: async () => {},
  getModelConfig: async () => ({ provider: 'openai', baseUrl: '', apiKey: '', model: '' }),
  saveModelConfig: async () => {}, listModelPresets: async () => [],
  getMemoryConfig: async () => ({ enabled: true }), setMemoryConfig: async () => {},
  getVersion: async () => '0.0.0-test',
  getAgents: async () => [], listSkills: async () => [],
  getSources: async () => [], pasteToTarget: async () => ({ success: true })
};
`

async function setupFreshPage(page: Page) {
  await page.addInitScript(MOCK_API)
  await page.goto('/')
  // 清主题 storage,确保从默认开始
  await page.evaluate(() => localStorage.removeItem('openpipal-theme-v3'))
  await page.reload()
  await page.waitForTimeout(500) // 给 initThemeOnLoad + React mount 时间
}

const BLUE_THEME_STRING = 'openpipal-theme-v1:' + JSON.stringify({
  schema: 'openpipal-theme-v1',
  light: {
    accent: '#0EA5E9', surface: '#F0F9FF', ink: '#0C4A6E', contrast: 55,
    fonts: { ui: 'Inter', mono: 'JetBrains Mono' }, sidebarOpaque: true,
    semantic: { diffAdded: '#10B981', diffRemoved: '#EF4444', skill: '#0EA5E9' },
  },
  dark: {
    accent: '#7DD3FC', surface: '#0F172A', ink: '#F0F9FF', contrast: 65,
    fonts: { ui: 'Inter', mono: 'JetBrains Mono' }, sidebarOpaque: true,
    semantic: { diffAdded: '#34D399', diffRemoved: '#FB7185', skill: '#7DD3FC' },
  },
  uiZoom: 1, reducedMotion: 'system',
})

/* ════════════════════════════════════════════════════════ */

test('默认 token RGB 三元组在首屏注入(tokens.css fallback)', async ({ page }) => {
  await setupFreshPage(page)
  const tokens = await page.evaluate(() => {
    const root = getComputedStyle(document.documentElement)
    return {
      brand500: root.getPropertyValue('--sw-brand-500-rgb').trim().replace(/\s+/g, ' '),
      surface0: root.getPropertyValue('--sw-surface-0-rgb').trim().replace(/\s+/g, ' '),
      sidebar50: root.getPropertyValue('--sw-sidebar-50-rgb').trim().replace(/\s+/g, ' '),
    }
  })
  // default action accent = ink #1B2429 → "27 36 41"(sage 退回品牌位,不再是动作色)
  expect(tokens.brand500).toBe('27 36 41')
  // default canvas #FFFFFF → "255 255 255"(会话画布是不透明白)
  expect(tokens.surface0).toBe('255 255 255')
  // sidebar 派生(从 default surface/ink 算出)
  expect(tokens.sidebar50).toMatch(/^\d+ \d+ \d+$/)
})

test('localStorage 注入主题字符串 + reload → applyTheme 端到端', async ({ page }) => {
  await page.addInitScript(MOCK_API)
  await page.goto('/')
  // 写入蓝色主题字符串到 localStorage,然后 reload
  await page.evaluate((str) => localStorage.setItem('openpipal-theme-v3', str), BLUE_THEME_STRING)
  await page.reload()
  await page.waitForTimeout(500) // initThemeOnLoad 跑完

  // 验证 :root 已经应用蓝色主题
  const result = await page.evaluate(() => {
    const root = getComputedStyle(document.documentElement)
    return {
      accent: root.getPropertyValue('--sw-accent').trim().toUpperCase(),
      brand500: root.getPropertyValue('--sw-brand-500-rgb').trim().replace(/\s+/g, ' '),
      surface0: root.getPropertyValue('--sw-surface-0-rgb').trim().replace(/\s+/g, ' '),
    }
  })
  expect(result.accent).toBe('#0EA5E9')
  // #0EA5E9 → R=14 G=165 B=233
  expect(result.brand500).toBe('14 165 233')
  // #F0F9FF → R=240 G=249 B=255
  expect(result.surface0).toBe('240 249 255')
})

test('无效主题字符串注入 localStorage → fallback 到默认主题', async ({ page }) => {
  await page.addInitScript(MOCK_API)
  await page.goto('/')
  // 注入垃圾字符串
  await page.evaluate(() => localStorage.setItem('openpipal-theme-v3', 'not-a-valid-theme'))
  await page.reload()
  await page.waitForTimeout(500)

  // parseThemeString 应该 return null,themeStore 应该 fallback 到 DEFAULT_THEME
  const accent = await page.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue('--sw-accent').trim().toUpperCase()
  )
  // default action accent = ink
  expect(accent).toBe('#1B2429')
})

test('部分字段缺失的主题字符串 → 校验失败,fallback 默认', async ({ page }) => {
  await page.addInitScript(MOCK_API)
  await page.goto('/')
  // 缺 schema 字段
  const broken = 'openpipal-theme-v1:' + JSON.stringify({
    light: { accent: '#0EA5E9', surface: '#FFFFFF', ink: '#000000', contrast: 50, fonts: { ui: 'a', mono: 'b' }, sidebarOpaque: true, semantic: {} },
    dark: { accent: '#0EA5E9', surface: '#000000', ink: '#FFFFFF', contrast: 50, fonts: { ui: 'a', mono: 'b' }, sidebarOpaque: true, semantic: {} },
    uiZoom: 1, reducedMotion: 'system',
    // schema 字段缺失
  })
  await page.evaluate((s) => localStorage.setItem('openpipal-theme-v3', s), broken)
  await page.reload()
  await page.waitForTimeout(500)

  const accent = await page.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue('--sw-accent').trim().toUpperCase()
  )
  // 校验失败 → fallback DEFAULT_THEME → accent 默认墨色 #1B2429
  expect(accent).toBe('#1B2429')
})

test('对比度差异:不同 contrast 的主题派生出不同的 surface-400', async ({ page }) => {
  // 注入 contrast=10 主题
  const low = 'openpipal-theme-v1:' + JSON.stringify({
    schema: 'openpipal-theme-v1',
    light: { accent: '#C2410C', surface: '#FFFCF9', ink: '#33302E', contrast: 10, fonts: { ui: 'DM Sans', mono: 'SF Mono' }, sidebarOpaque: true, semantic: {} },
    dark: { accent: '#FDBA8C', surface: '#1F1D1B', ink: '#FAF7F5', contrast: 60, fonts: { ui: 'DM Sans', mono: 'SF Mono' }, sidebarOpaque: true, semantic: {} },
    uiZoom: 1, reducedMotion: 'system',
  })

  await page.addInitScript(MOCK_API)
  await page.goto('/')
  await page.evaluate((s) => localStorage.setItem('openpipal-theme-v3', s), low)
  await page.reload()
  await page.waitForTimeout(500)
  const at10 = await page.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue('--sw-surface-400-rgb').trim().replace(/\s+/g, ' ')
  )

  // 注入 contrast=90 主题
  const high = 'openpipal-theme-v1:' + JSON.stringify({
    schema: 'openpipal-theme-v1',
    light: { accent: '#C2410C', surface: '#FFFCF9', ink: '#33302E', contrast: 90, fonts: { ui: 'DM Sans', mono: 'SF Mono' }, sidebarOpaque: true, semantic: {} },
    dark: { accent: '#FDBA8C', surface: '#1F1D1B', ink: '#FAF7F5', contrast: 60, fonts: { ui: 'DM Sans', mono: 'SF Mono' }, sidebarOpaque: true, semantic: {} },
    uiZoom: 1, reducedMotion: 'system',
  })
  await page.evaluate((s) => localStorage.setItem('openpipal-theme-v3', s), high)
  await page.reload()
  await page.waitForTimeout(500)
  const at90 = await page.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue('--sw-surface-400-rgb').trim().replace(/\s+/g, ' ')
  )

  // contrast=10 应该比 contrast=90 时 surface-400 更浅(更接近 surface)
  expect(at10).not.toBe(at90)
})

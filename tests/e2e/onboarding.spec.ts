import { test, expect, Page } from '@playwright/test'

const ARTIFACTS_DIR = 'tests/artifacts/onboarding'

/**
 * 首启全屏引导 E2E
 *
 * 盯四件事：四屏顺序走得通、跳过/完成都真的写回、CTA 直达设置、
 * 窄窗(侧栏形态)不塌。截图进 tests/artifacts/onboarding/ 供目视验收。
 */
const BASE_API = `
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
  getAppSettings: async () => ({ enabled: true, detected: [], disabled: [], browsers: [] }),
  setAppFollowingEnabled: async () => ({ ok: true, enabled: true }),
  setDisabledApps: async () => ({ ok: true }),
  getWorkingDir: async () => '/Users/x/Documents',
  isCustomConfig: async () => ({ isCustom: false }),
  getAvailableModels: async () => [],
  getModelConfig: async () => ({ provider: 'openai', baseUrl: '', apiKey: '', model: '' }),
  getModelConfigFull: async () => ({ provider: 'openai', baseUrl: '', apiKey: '', model: '' }),
  saveModelConfig: async () => {},
  testConnection: async () => ({ ok: true, model: 'gpt-4o' }),
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

const FRESH_ONBOARDING = `
window.__onboardingDone = false;
window.__screenPrefsOpened = false;
window.api.getOnboardingStatus = async () => ({ completed: false });
window.api.completeOnboarding = async () => { window.__onboardingDone = true; return { ok: true }; };
window.api.openScreenRecordingPrefs = async () => { window.__screenPrefsOpened = true; return { ok: true }; };
`

const STEP_TITLES = ['欢迎使用 OpenPipal', '给自己捏一个专属帮手', '捏一次，别的软件里也能用', '不想捏？现成的直接用']

async function boot(page: Page, extra = FRESH_ONBOARDING): Promise<void> {
  await page.addInitScript({ content: BASE_API + extra })
  await page.goto('/')
  await page.waitForLoadState('networkidle')
}

test.describe('首启引导 · 宽窗（首次启动铺满工作区）', () => {
  test.use({ viewport: { width: 1280, height: 860 } })

  test('四屏顺序走完，Mark 引导动线随步滑动，最后一屏落「开始使用」', async ({ page }) => {
    await boot(page)

    const overlay = page.getByTestId('onboarding-overlay')
    const title = page.getByTestId('onboarding-step-title')
    const next = page.getByTestId('onboarding-next')
    await expect(overlay).toBeVisible({ timeout: 5000 })

    for (let i = 0; i < STEP_TITLES.length; i++) {
      await expect(title).toHaveText(STEP_TITLES[i])
      // 等 Mark 滑到位再截,截图要看的就是动线落点
      await page.waitForTimeout(800)
      await page.screenshot({ path: `${ARTIFACTS_DIR}/step-${i + 1}.png` })
      if (i < STEP_TITLES.length - 1) await next.click()
    }

    await expect(next).toHaveText('开始使用')
    await next.click()
    await expect(overlay).toHaveCount(0)
    expect(await page.evaluate(() => (window as any).__onboardingDone)).toBe(true)
  })

  test('键盘右箭头前进、上一步回退，第一屏不显示回退', async ({ page }) => {
    await boot(page)
    const title = page.getByTestId('onboarding-step-title')
    const back = page.getByTestId('onboarding-back')

    await expect(title).toHaveText(STEP_TITLES[0])
    await expect(back).toBeHidden()

    await page.keyboard.press('ArrowRight')
    await expect(title).toHaveText(STEP_TITLES[1])
    await expect(back).toBeVisible()

    await back.click()
    await expect(title).toHaveText(STEP_TITLES[0])
  })

  test('捏 Agent 步的 CTA 直达「我的 Agents」并结束引导', async ({ page }) => {
    await boot(page)
    await page.getByTestId('onboarding-next').click()
    await expect(page.getByTestId('onboarding-step-title')).toHaveText(STEP_TITLES[1])

    await page.getByTestId('onboarding-step-cta').click()
    await expect(page.getByTestId('onboarding-overlay')).toHaveCount(0)
    expect(await page.evaluate(() => (window as any).__onboardingDone)).toBe(true)
    expect(await page.evaluate(() => (window as any).__appStore.getState().activeView)).toBe('agents')
  })

  test('末屏 CTA 直达设置接模型并结束引导', async ({ page }) => {
    await boot(page)
    for (let i = 0; i < 3; i++) await page.getByTestId('onboarding-next').click()
    await expect(page.getByTestId('onboarding-step-title')).toHaveText(STEP_TITLES[3])

    await page.getByTestId('onboarding-step-cta').click()
    await expect(page.getByTestId('onboarding-overlay')).toHaveCount(0)
    expect(await page.evaluate(() => (window as any).__appStore.getState().activeView)).toBe('settings')
  })

  test('跳过立即写回完成；已完成的用户不再看到引导', async ({ page }) => {
    await boot(page)
    await page.getByTestId('onboarding-skip').click()
    await expect(page.getByTestId('onboarding-overlay')).toHaveCount(0)
    expect(await page.evaluate(() => (window as any).__onboardingDone)).toBe(true)

    await boot(page, `window.api.getOnboardingStatus = async () => ({ completed: true });`)
    await page.waitForTimeout(500)
    await expect(page.getByTestId('onboarding-overlay')).toHaveCount(0)
  })
})

test.describe('首启引导 · 窄窗（侧栏形态）与深色', () => {
  test.use({ viewport: { width: 420, height: 700 } })

  test('窄窗不塌、深色可读', async ({ page }) => {
    await boot(page)
    await expect(page.getByTestId('onboarding-overlay')).toBeVisible({ timeout: 5000 })
    await page.waitForTimeout(800)
    await page.screenshot({ path: `${ARTIFACTS_DIR}/narrow-step-1.png` })

    await page.getByTestId('onboarding-next').click()
    await page.waitForTimeout(800)
    await page.screenshot({ path: `${ARTIFACTS_DIR}/narrow-step-2.png` })

    // 走真实主题通道(applyTheme 重算全部 token),裸加 .dark class 只会得到半深色的假状态
    await page.evaluate(() => (window as any).__appStore.getState().setTheme('dark'))
    await page.waitForTimeout(300)
    await page.screenshot({ path: `${ARTIFACTS_DIR}/narrow-step-2-dark.png` })
  })
})

import { test, expect, Page } from '@playwright/test'

const ARTIFACTS_DIR = 'tests/artifacts/coding-preflow'

/**
 * 编码助手前置页 E2E
 *
 * 这一页只做一件事：**选仓库**。要盯住的是它别长成设计助手那个样子——
 * 设计的前置页是必选模板卡（"今天想设计点什么？"必须点一个），写代码大多数会话
 * 就是"这个 bug 怎么修"，每次拦一道选择卡是纯打扰。
 *
 * 还要盯住一个接线：preflow 会**整页替换**欢迎页，工作目录条不挂进来的话，
 * 一个"先选仓库"的角色反而没地方选目录。
 */
const CODING_MANIFEST = {
  title: '在哪个仓库里干活？',
  inputPlaceholder: '说说要做什么，比如：登录页刷新后会闪一下白屏，帮我看看',
  projectName: { enabled: false },
  dsSelector: { enabled: false },
  workingDir: { enabled: true },
  fields: [],
  contextButtons: [
    { kind: 'screenshot', label: '报错截图', subtitle: 'IDE / 终端 / 浏览器里的报错' },
    { kind: 'codebase', label: '参考目录', subtitle: '另一个只读参考的文件夹，不作为工作目录' }
  ],
  allowSkip: true
}

function mockApi(): string {
  return `
window.__mockCalls = [];
window.api = {
  getLocaleState: async () => ({ preference: 'zh-CN', locale: 'zh-CN' }),
  sendChat: (...a) => { window.__mockCalls.push(['sendChat', JSON.stringify(a).slice(0, 3000)]); },
  abortChat: () => {},
  onStreamChunk: () => () => {},
  onStreamEnd: () => () => {},
  onTextFlush: () => () => {},
  onToolStart: () => () => {},
  onToolEnd: () => () => {},
  onAskUser: () => () => {},
  onTargetStatus: () => () => {},
  onAppChanged: () => () => {},
  getRoleInitState: async () => ({ hasRole: true, role: { name: 'general', displayName: '通用助手', icon: '✦' } }),
  getAllRoles: async () => [
    { name: 'general', displayName: '通用助手', icon: '✦' },
    { name: 'coding', displayName: '编码助手', icon: '💻' }
  ],
  getCurrentRole: async () => ({ name: 'general', displayName: '通用助手', icon: '✦' }),
  switchRole: async (name) => ({ name, displayName: name === 'coding' ? '编码助手' : '通用助手', icon: '💻' }),
  getRolePreflow: async (roleName) => roleName === 'coding' ? ${JSON.stringify(CODING_MANIFEST)} : null,
  selectDirectory: async () => { window.__mockCalls.push(['selectDirectory']); return '/Users/x/code/checkout-service'; },
  validateWorkingDir: async () => ({ ok: true }),
  describeProjectContext: async (dir) => ({
    repoRoot: dir,
    files: [{ path: dir + '/AGENTS.md', truncated: false }],
    droppedForBudget: []
  }),
  listAssetsTree: async () => ({ brand: [], refs: [], docs: [], kits: [] }),
  listDesignSystems: async () => [],
  listArtifactHistory: async () => [],
  uploadAssetToCategory: async () => null,
  deleteAsset: async () => ({ ok: true }),
  openFileDialog: async () => null,
  updateConversationConfig: async (...a) => { window.__mockCalls.push(['updateConversationConfig', JSON.stringify(a).slice(0, 2000)]); return ({ ok: true }); },
  // 最近仓库从会话列表推导（listConversations 已按 updatedAt 降序、summary 自带 config），
  // 所以这里给几条带 workingDir 的历史会话就能验那一段
  listConversations: async () => [
    { id: 'c1', title: '修登录闪屏', role: 'coding', config: { workingDir: '/Users/x/code/checkout-service' }, createdAt: 1, updatedAt: 300, messageCount: 2 },
    { id: 'c2', title: '看看构建为什么慢', role: 'coding', config: { workingDir: '/Users/x/work/acme/billing-api' }, createdAt: 1, updatedAt: 200, messageCount: 2 },
    { id: 'c3', title: '又是那个仓库', role: 'coding', config: { workingDir: '/Users/x/code/checkout-service' }, createdAt: 1, updatedAt: 150, messageCount: 2 },
    { id: 'c4', title: '没选目录的会话', role: 'coding', createdAt: 1, updatedAt: 100, messageCount: 2 },
    { id: 'c5', title: '插件仓库', role: 'coding', config: { workingDir: '/Users/x/openpipal-extension' }, createdAt: 1, updatedAt: 50, messageCount: 2 }
  ],
  createConversation: async (role) => ({ id: 'conv-coding', title: '编码任务', role, createdAt: 1780000000000, updatedAt: 1780000000000, messageCount: 0 }),
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
  listRoleSystems: async () => [],
  getOnboardingStatus: async () => ({ completed: true }),
  getRealtimeConfig: async () => ({ provider: 'openai', url: '', model: '', deployment: '', apiVersion: '', voice: 'alloy', hasKey: false }),
  startRealtime: async () => ({ success: false }),
  stopRealtime: () => {},
  sendRealtimeEvent: () => {},
  onRealtimeEvent: () => () => {},
  onRealtimeState: () => () => {}
};
`
}

async function bootToCodingPreflow(page: Page): Promise<void> {
  await page.addInitScript({ content: mockApi() })
  await page.goto('/')
  await page.waitForLoadState('networkidle')
  await page.waitForSelector('textarea', { timeout: 10000 })
  await page.locator('button[title="编码助手"]').click()
  await page.waitForSelector('[data-testid="preflow-composer"]', { timeout: 5000 })
}

test.use({ viewport: { width: 1100, height: 900 } })

test.describe('编码助手前置页', () => {
  test('版式：只有选仓库，没有设计助手那套模板卡与设计系统下拉', async ({ page }) => {
    await bootToCodingPreflow(page)

    await expect(page.locator('[data-testid="preflow-headline"]')).toHaveText('在哪个仓库里干活？')
    await expect(page.locator('[data-testid="preflow-input"]')).toBeVisible()
    // fields: [] → 一张模板卡都不该有；dsSelector 关 → 设计系统下拉不该在
    await expect(page.locator('[data-testid^="preflow-type-card-"]')).toHaveCount(0)
    await expect(page.locator('[data-testid="preflow-tpl-select"]')).toHaveCount(0)
    await expect(page.locator('[data-testid="preflow-ds-select"]')).toHaveCount(0)
    // 没有模板卡就没有"直接开空白会话"链接——那条链接是给必选卡准备的逃生口。
    // 这一页本来就没拦人：直接在输入框写需求发出去即可。
    await expect(page.locator('[data-testid="preflow-blank-link"]')).toHaveCount(0)

    await page.screenshot({ path: `${ARTIFACTS_DIR}/layout.png`, fullPage: true })
  })

  test('工作目录条挂在前置页上，选完显示目录名与"已读 AGENTS.md"', async ({ page }) => {
    await bootToCodingPreflow(page)

    const bar = page.getByTestId('working-dir-bar')
    await expect(bar).toBeVisible()
    await expect(bar).toContainText('选择工作目录')
    await expect(page.getByTestId('working-dir-project-rules')).toHaveCount(0)

    await bar.getByRole('button').first().click()
    await expect(bar).toContainText('checkout-service')
    await expect(page.getByTestId('working-dir-project-rules')).toContainText('AGENTS.md')

    // 目录必须真的落进会话配置 —— 只显示不落盘等于什么都没选
    expect(await page.evaluate(() => (window as any).__chatStore.getState().conversationConfig?.workingDir))
      .toBe('/Users/x/code/checkout-service')

    await page.screenshot({ path: `${ARTIFACTS_DIR}/repo-picked.png`, fullPage: true })

    await page.evaluate(() => (window as any).__appStore.getState().setTheme('dark'))
    await page.waitForTimeout(300)
    await page.screenshot({ path: `${ARTIFACTS_DIR}/repo-picked-dark.png`, fullPage: true })
    await page.evaluate(() => (window as any).__appStore.getState().setTheme('light'))
  })

  test('选完仓库再发首条消息，工作目录随请求一起走', async ({ page }) => {
    await bootToCodingPreflow(page)
    await page.getByTestId('working-dir-bar').getByRole('button').first().click()
    await expect(page.getByTestId('working-dir-bar')).toContainText('checkout-service')

    await page.locator('[data-testid="preflow-input"]').fill('登录页刷新会闪白屏，帮我看看')
    await page.locator('[data-testid="preflow-start-btn"]').click()

    await expect.poll(async () =>
      await page.evaluate(() =>
        ((window as any).__mockCalls as any[]).filter(c => c[0] === 'sendChat').length
      )
    ).toBeGreaterThan(0)

    const payload = await page.evaluate(() =>
      ((window as any).__mockCalls as any[]).filter(c => c[0] === 'sendChat').map(c => c[1]).join('\n')
    )
    expect(payload).toContain('/Users/x/code/checkout-service')
  })

  test('最近仓库：去重、按最近在前，点一条直接落进会话配置', async ({ page }) => {
    await bootToCodingPreflow(page)

    const items = page.getByTestId('working-dir-recent-item')
    // checkout-service 出现在两条会话里，只算一条；没选目录的那条不进来
    await expect(items).toHaveCount(3)
    await expect(items.nth(0)).toContainText('checkout-service')
    await expect(items.nth(1)).toContainText('billing-api')
    await expect(items.nth(2)).toContainText('openpipal-extension')
    // 路径只留最后两层父目录——头部截断会把仓库名截掉，那才是要看的部分
    await expect(items.nth(1)).toContainText('…/work/acme')

    await page.screenshot({ path: `${ARTIFACTS_DIR}/recents.png`, fullPage: true })

    await items.nth(1).click()
    await expect(page.getByTestId('working-dir-bar')).toContainText('billing-api')
    expect(await page.evaluate(() => (window as any).__chatStore.getState().conversationConfig?.workingDir))
      .toBe('/Users/x/work/acme/billing-api')
    // 选中的那条从"最近"里消失（已经在上面显示了，再列一遍是噪音）
    await expect(page.getByTestId('working-dir-recent-item')).toHaveCount(2)

    await page.screenshot({ path: `${ARTIFACTS_DIR}/recents-picked.png`, fullPage: true })
  })

  test('最近仓库走同一道校验：目录没了就报同一条错，不静悄悄选中', async ({ page }) => {
    await bootToCodingPreflow(page)
    await page.evaluate(() => {
      ;(window as any).api.validateWorkingDir = async () => ({ ok: false, code: 'unknown', reason: '这个目录不在允许范围内' })
    })

    await page.getByTestId('working-dir-recent-item').first().click()
    await expect(page.getByTestId('working-dir-rejected')).toBeVisible()
    expect(await page.evaluate(() => (window as any).__chatStore.getState().conversationConfig?.workingDir))
      .toBeFalsy()
  })

  // OpenPipal 常态是贴边的窄窗，目录条上现在挂了四样东西（目录名 / 已读徽标 /
  // 权限档位 / 清除），窄窗下会不会挤成一团得真截一张看。
  // 取 400px：App 在 <420 时自动收侧栏，这才是真实贴边形态
  test('窄窗（400px）下目录条不挤爆', async ({ page }) => {
    await page.setViewportSize({ width: 400, height: 760 })
    await bootToCodingPreflow(page)
    await page.getByTestId('working-dir-recent-item').first().click()
    await expect(page.getByTestId('working-dir-bar')).toContainText('checkout-service')
    await expect(page.getByTestId('permission-tier-trigger')).toBeVisible()

    // toContainText 读的是 textContent，CSS 截断它看不见——挤没挤爆得量渲染宽度。
    // 目录名被压到 28px（"che…"）时这条会红：那时候徽标还占着满宽，优先级反了。
    const nameWidth = await page.getByTestId('working-dir-bar')
      .locator('span.truncate').first().evaluate(el => el.clientWidth)
    expect(nameWidth, '窄窗下目录名至少得留出认得出仓库的宽度').toBeGreaterThanOrEqual(80)

    await page.screenshot({ path: `${ARTIFACTS_DIR}/narrow.png`, fullPage: true })
  })

  test('权限档位挂在前置页的目录条上，默认自动审核', async ({ page }) => {
    await bootToCodingPreflow(page)
    const trigger = page.getByTestId('permission-tier-trigger')
    await expect(trigger).toBeVisible()
    await expect(trigger).toHaveText(/自动审核/)

    await trigger.click()
    await page.getByTestId('permission-tier-readonly').click()
    await expect(trigger).toHaveText(/只读/)
    // 前置页选的档位得真的进会话配置，否则发第一条消息时又回到默认
    expect(await page.evaluate(() => (window as any).__chatStore.getState().conversationConfig?.permissionTier))
      .toBe('readonly')
  })
})

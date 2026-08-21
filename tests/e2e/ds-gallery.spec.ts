/**
 * 设计系统画廊 E2E — ArtifactType='design-system' 的侧栏渲染
 *
 * 覆盖:
 *   T1 emitArtifact({type:'design-system'}) → workspace 自动展开 ArtifactTab
 *      → DesignSystemGallery 拉 manifest → 头部/分组卡墙/UI Kits 全渲染
 *      → 卡 iframe src 指向进程期只读 capability 下的 /design-systems/<cap>/<name>/<rel>
 *   T2 manifest 为 null(系统不存在)→ 占位文案
 *   T4 顶栏「全部文件」下拉切视图 → Finder 式文件浏览(宽面板分栏/目录展开/详情元信息)
 *   T5 窄面板推进式(点文件进详情、可返回)+ 下拉直接跳某个页面
 *
 * Mock 策略同 dc-render.spec.ts:精简 window.api mock + __mockBus.emit('artifact', '', ...)。
 * 画廊卡 iframe 指向 3031 静态服务(测试环境无此服务)——只断言属性,不要求内容可达。
 */

import { test, expect, Page } from '@playwright/test'

test.use({ viewport: { width: 1200, height: 800 } })

const ARTIFACTS_DIR = 'tests/artifacts/ds-gallery'
const DS_CAPABILITY = 'c'.repeat(43)

// 画廊 fixture:两组卡 + 两个 UI kit(镜像真实 wildcreek 结构)
const FIXTURE_MANIFEST = {
  name: 'wildcreek',
  title: 'Wildcreek',
  description: 'Trail-inspired design system',
  path: '/Users/x/.openpipal/design-systems/wildcreek',
  groups: [
    {
      group: 'preview',
      cards: [
        { rel: 'preview/hero.html', name: 'Hero', subtitle: 'Landing hero', group: 'preview', w: 700, h: 260 },
        { rel: 'preview/pricing.html', name: 'Pricing', group: 'preview', w: 700, h: 400 }
      ]
    },
    {
      group: 'components',
      cards: [{ rel: 'components/button.html', name: 'Button', group: 'components', w: 700, h: 400 }]
    }
  ],
  kits: [
    { rel: 'ui_kits/route-detail/index.html', label: 'route-detail' },
    { rel: 'ui_kits/route-discover/index.html', label: 'route-discover' }
  ],
  // 「全部文件」视图的目录树（main 侧 scanDsFiles 如实扫盘的形状）
  files: [
    {
      name: 'components', rel: 'components', kind: 'dir',
      children: [{ name: 'button.html', rel: 'components/button.html', kind: 'file', size: 1024, mtime: Date.now() - 7 * 60_000 }]
    },
    {
      name: 'preview', rel: 'preview', kind: 'dir',
      children: [
        { name: 'hero.html', rel: 'preview/hero.html', kind: 'file', size: 2048, mtime: Date.now() - 21 * 60_000 },
        { name: 'pricing.html', rel: 'preview/pricing.html', kind: 'file', size: 3072, mtime: Date.now() - 30 * 60_000 }
      ]
    },
    { name: 'README.md', rel: 'README.md', kind: 'file', size: 512, mtime: Date.now() - 60 * 60_000 },
    { name: 'styles.css', rel: 'styles.css', kind: 'file', size: 4096, mtime: Date.now() - 21 * 60_000 },
    { name: '_ds_bundle.js', rel: '_ds_bundle.js', kind: 'file', size: 8192, mtime: Date.now() - 2 * 60_000 }
  ]
}

const MOCK_API = `
window.__mockBus = {
  listeners: {},
  on(event, fn) { (this.listeners[event] ||= []).push(fn); return () => {}; },
  emit(event, ...args) { (this.listeners[event] || []).forEach(fn => fn(...args)); }
};
const DESIGN_ROLE = { name: 'design', displayName: '设计助手', icon: '🎨' };
const DS_MANIFEST = ${JSON.stringify(FIXTURE_MANIFEST)};
const DS_CAPABILITY = '${DS_CAPABILITY}';
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
  onArtifact: (cb) => window.__mockBus.on('artifact', cb),
  onArtifactDelta: (cb) => window.__mockBus.on('artifact-delta', cb),
  onArtifactUpdate: (cb) => window.__mockBus.on('artifact-update', cb),
  onVisualizer: (cb) => window.__mockBus.on('visualizer', cb),
  onVisualizerDelta: (cb) => window.__mockBus.on('visualizer-delta', cb),
  onTargetStatus: (cb) => window.__mockBus.on('target-status', cb),
  onAppChanged: (cb) => window.__mockBus.on('app-changed', cb),
  pasteToTarget: async () => ({ success: true }),
  getRoleInitState: async () => ({ hasRole: true, role: DESIGN_ROLE }),
  getAllRoles: async () => [DESIGN_ROLE],
  getCurrentRole: async () => DESIGN_ROLE,
  switchRole: async () => DESIGN_ROLE,
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
  getRealtimeConfig: async () => ({ provider: 'openai', url: '', model: '', deployment: '', apiVersion: '', voice: 'alloy', hasKey: false }),
  startRealtime: async () => ({ success: false }),
  stopRealtime: () => {},
  sendRealtimeEvent: () => {},
  onRealtimeEvent: () => () => {},
  onRealtimeState: () => () => {},
  listAssetsTree: async () => ({ brand: [], refs: [], docs: [], kits: [] }),
  saveArtifact: async (cid, art) => ({ ok: true, ref: { id: art.id } }),
  // 画廊数据源:已知名回 fixture,未知名回 null(占位路径)
  getDesignSystemManifest: async (name) => (name === 'wildcreek' ? DS_MANIFEST : null),
  getDesignSystemResourceCapability: async (name) => (name === 'wildcreek' ? DS_CAPABILITY : null),
  // 评审记录:初始无记录;保存调用记入 __savedReviews 供断言
  getDsReview: async () => null,
  saveDsReview: async (name, review) => { (window.__savedReviews ||= []).push({ name, review }); return true; },
};
// 反馈发送最终走 sendChat——包一层记录参数
const _origSendChat = window.api.sendChat;
window.api.sendChat = (...args) => { (window.__sentChats ||= []).push(args); return _origSendChat(...args); };
`

async function setup(page: Page): Promise<void> {
  await page.addInitScript({ content: MOCK_API })
  await page.goto('/')
  await page.waitForLoadState('networkidle')
  await page.evaluate(() => {
    ;(window as any).__chatStore?.setState?.({ activeConversationId: 'mock-conv' })
  })
}

async function emitArtifact(
  page: Page,
  artifact: { id: string; type: string; title: string; content: string }
): Promise<void> {
  await page.evaluate(
    ({ artifact }) => (window as any).__mockBus.emit('artifact', '', artifact),
    { artifact }
  )
  await page.waitForTimeout(300)
}

test.describe('设计系统画廊 侧栏渲染', () => {
  test('T1 design-system artifact → 画廊完整渲染(头部/分组卡/UI kit/静态 src)', async ({ page }) => {
    await setup(page)
    await emitArtifact(page, {
      id: 'ds-wildcreek',
      type: 'design-system',
      title: 'Wildcreek',
      content: JSON.stringify({ name: 'wildcreek' })
    })

    // workspace 自动展开 → 画廊挂载
    const gallery = page.locator('[data-testid="ds-gallery"]')
    await expect(gallery).toBeVisible({ timeout: 5000 })

    // 头部:title + description + 绝对路径
    await expect(gallery.getByRole('heading', { name: 'Wildcreek' })).toBeVisible()
    await expect(gallery.getByText('Trail-inspired design system')).toBeVisible()
    await expect(gallery.getByText('/Users/x/.openpipal/design-systems/wildcreek')).toBeVisible()

    // 分组标题(raw textContent = 组名,CSS uppercase 仅视觉)
    await expect(gallery.getByText('preview', { exact: true })).toBeVisible()
    await expect(gallery.getByText('components', { exact: true })).toBeVisible()

    // 分组卡:3 张,首卡 iframe src 指向 3031 静态服务
    const cards = page.locator('[data-testid="ds-gallery-card"]')
    await expect(cards).toHaveCount(3)
    const firstSrc = await cards.first().locator('iframe').getAttribute('src')
    expect(firstSrc).toContain(`/design-systems/${DS_CAPABILITY}/wildcreek/`)
    expect(firstSrc).toContain('preview/hero.html')

    // UI Kits:两个容器,src 指向 ui_kits/*/index.html
    const kits = page.locator('[data-testid="ds-gallery-kit"]')
    await expect(kits).toHaveCount(2)
    const kitSrc = await kits.first().locator('iframe').getAttribute('src')
    expect(kitSrc).toContain(`/design-systems/${DS_CAPABILITY}/wildcreek/ui_kits/`)
    expect(kitSrc).toContain('index.html')

    await page.screenshot({ path: `${ARTIFACTS_DIR}/t1-gallery.png`, fullPage: true })
  })

  test('T3 逐卡评审:赞/踩计数+评语持久化+批量反馈发送', async ({ page }) => {
    await setup(page)
    await emitArtifact(page, {
      id: 'ds-wildcreek',
      type: 'design-system',
      title: 'Wildcreek',
      content: JSON.stringify({ name: 'wildcreek' })
    })
    const gallery = page.locator('[data-testid="ds-gallery"]')
    await expect(gallery).toBeVisible({ timeout: 5000 })

    // 评审栏:3 卡 + 2 kit = 5 项全部未评审;未评审前发送按钮禁用
    const bar = page.locator('[data-testid="ds-review-bar"]')
    await expect(bar).toContainText('未评审 5')
    await expect(page.locator('[data-testid="ds-review-send"]')).toBeDisabled()

    // 第一张卡点赞 → 定稿:按钮对折叠成"已确认"徽标 + 计数变化 + 持久化调用
    const firstCard = page.locator('[data-testid="ds-gallery-card"]').first()
    await firstCard.locator('[data-testid="ds-review-up"]').click()
    await expect(firstCard.locator('[data-testid="ds-review-approved"]')).toBeVisible()
    await expect(firstCard.locator('[data-testid="ds-review-up"]')).toHaveCount(0)
    await expect(firstCard.locator('[data-testid="ds-review-down"]')).toHaveCount(0)
    await expect(bar).toContainText('已确认 1')
    const saved = await page.evaluate(() => (window as any).__savedReviews?.at(-1))
    expect(saved.name).toBe('wildcreek')
    expect(saved.review.cards['preview/hero.html'].verdict).toBe('up')

    // 徽标可撤销:点一下回到未评审,再确认回去
    await firstCard.locator('[data-testid="ds-review-approved"]').click()
    await expect(bar).toContainText('未评审 5')
    await firstCard.locator('[data-testid="ds-review-up"]').click()
    await expect(bar).toContainText('已确认 1')

    // 第二张卡点踩 → 评语框出现,写意见后失焦保存
    await page.locator('[data-testid="ds-gallery-card"]').nth(1).locator('[data-testid="ds-review-down"]').click()
    const comment = page.locator('[data-testid="ds-review-comment"]')
    await expect(comment).toBeVisible()
    await comment.fill('留白太挤,价格层级不清')
    await comment.blur()
    const saved2 = await page.evaluate(() => (window as any).__savedReviews?.at(-1))
    expect(saved2.review.cards['preview/pricing.html']).toEqual(
      expect.objectContaining({ verdict: 'down', comment: '留白太挤,价格层级不清' })
    )

    // 批量发送 → sendChat 收到结构化反馈,按钮变已发送
    await page.locator('[data-testid="ds-review-send"]').click()
    const sent = await page.evaluate(() => JSON.stringify((window as any).__sentChats || []))
    expect(sent).toContain('设计系统评审反馈 · wildcreek')
    expect(sent).toContain('留白太挤')
    expect(sent).toContain('Hero')
    await expect(page.locator('[data-testid="ds-review-send"]')).toContainText('已发送')

    await page.screenshot({ path: `${ARTIFACTS_DIR}/t3-review.png`, fullPage: true })
  })

  test('T2 manifest 为 null → 占位文案(系统不存在)', async ({ page }) => {
    await setup(page)
    await emitArtifact(page, {
      id: 'ds-missing',
      type: 'design-system',
      title: 'Missing',
      content: JSON.stringify({ name: 'missing' })
    })

    const gallery = page.locator('[data-testid="ds-gallery"]')
    await expect(gallery).toBeVisible({ timeout: 5000 })
    await expect(gallery).toContainText('设计系统不存在或已移动')
    // 占位态不渲染卡墙/kit
    await expect(page.locator('[data-testid="ds-gallery-card"]')).toHaveCount(0)

    await page.screenshot({ path: `${ARTIFACTS_DIR}/t2-missing.png`, fullPage: true })
  })

  test('T4 全部文件视图:宽面板分栏(列表+详情),文件夹展开,详情元信息', async ({ page }) => {
    await setup(page)
    await page.evaluate(() => (window as any).__workspaceStore.setState({ width: 900 }))
    await emitArtifact(page, {
      id: 'ds-wildcreek',
      type: 'design-system',
      title: 'Wildcreek',
      content: JSON.stringify({ name: 'wildcreek' })
    })

    // 顶栏下拉:默认画廊 → 切到全部文件
    await expect(page.locator('[data-testid="ds-gallery"]')).toBeVisible({ timeout: 5000 })
    await page.locator('[data-testid="ds-view-menu-btn"]').click()
    await page.locator('[data-testid="ds-view-opt-files"]').click()

    const files = page.locator('[data-testid="ds-files"]')
    await expect(files).toBeVisible()
    await expect(page.locator('[data-testid="ds-gallery"]')).toHaveCount(0)

    // 分节 = 文件夹/页面?/样式表/脚本/文档（顶层无页面,故至少 4 节）
    await expect(page.locator('[data-testid="ds-files-section"]').first()).toBeVisible()
    await expect(page.locator('[data-testid="ds-files-dir"]')).toHaveCount(2)

    // 宽版自动选中首个可预览文件(components/button.html)→ 祖先目录自动展开,详情已在右侧
    const detail = page.locator('[data-testid="ds-files-detail"]')
    await expect(detail).toContainText('button.html')

    // 「页面」分节跨层摊平：3 张页面全在（预览卡按技能规定嵌在子目录里，不摊平就一张也看不见）。
    // 文件夹保持折叠——被选中的页面已在摊平区可见，没必要再展开把文件夹区撑长。
    // 行数 = 摊平页面 3 + css/js/md 各 1 = 6
    await expect(page.locator('[data-testid="ds-files-row"]')).toHaveCount(6)
    await expect(page.locator('[data-testid="ds-files-row"]').filter({ hasText: 'pricing.html' })).toHaveCount(1)

    // 展开 preview 目录 → 目录树里再出现两张（摊平副本仍在，故 +2）
    await page.locator('[data-testid="ds-files-dir"]').filter({ hasText: 'preview' }).click()
    await expect(page.locator('[data-testid="ds-files-row"]')).toHaveCount(8)

    // 选中样式表 → 详情元信息(修改时间 · 大小 · 类型)
    await page.locator('[data-testid="ds-files-row"]').filter({ hasText: 'styles.css' }).click()
    await expect(detail).toContainText('4 KB')
    await expect(detail).toContainText('样式表')

    // 摊平的页面行副标题显示所在文件夹（目录树里那份显示类型"页面"），两份可区分
    await expect(
      page.locator('[data-testid="ds-files-row"]').filter({ hasText: 'hero.html' }).filter({ hasText: 'preview' })
    ).toHaveCount(1)

    // 选中页面 → iframe 指向 3031 静态服务（展开后同名行有两份：摊平区 + 目录树，取第一份即可）
    await page.locator('[data-testid="ds-files-row"]').filter({ hasText: 'hero.html' }).first().click()
    await expect(page.locator('[data-testid="ds-files-preview-frame"]')).toHaveAttribute(
      'src',
      /\/design-systems\/[A-Za-z0-9_-]{20,}\/wildcreek\/preview\/hero\.html$/
    )

    await page.screenshot({ path: `${ARTIFACTS_DIR}/t4-files-split.png`, fullPage: true })
  })

  test('T5 窄面板推进式 + 下拉直接跳页面', async ({ page }) => {
    await setup(page)
    await page.evaluate(() => (window as any).__workspaceStore.setState({ width: 380 }))
    await emitArtifact(page, {
      id: 'ds-wildcreek',
      type: 'design-system',
      title: 'Wildcreek',
      content: JSON.stringify({ name: 'wildcreek' })
    })

    // 下拉里列出全部页面,按修改时间新→旧
    await page.locator('[data-testid="ds-view-menu-btn"]').click()
    const pages = page.locator('[data-testid="ds-view-page"]')
    await expect(pages).toHaveCount(3)
    await expect(pages.first()).toContainText('button.html')

    // 点页面 = 切视图 + 选中;窄版直接进详情
    await pages.first().click()
    const detail = page.locator('[data-testid="ds-files-detail"]')
    await expect(detail).toBeVisible()
    await expect(page.locator('[data-testid="ds-files-list"]')).toHaveCount(0)
    await expect(page.locator('[data-testid="ds-files-preview-frame"]')).toHaveAttribute(
      'src',
      /\/design-systems\/[A-Za-z0-9_-]{20,}\/wildcreek\/components\/button\.html$/
    )

    // 返回 → 回到列表态(窄版不自动重选)
    await page.locator('[data-testid="ds-files-back"]').click()
    await expect(page.locator('[data-testid="ds-files-list"]')).toBeVisible()
    await expect(detail).toHaveCount(0)

    await page.screenshot({ path: `${ARTIFACTS_DIR}/t5-files-narrow.png`, fullPage: true })
  })
})

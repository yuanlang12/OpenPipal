import { test, expect, Page } from '@playwright/test'

const ARTIFACTS_DIR = 'tests/artifacts/preflow-composer'

/**
 * design 角色前置页 — Claude Design 风首页版式
 *
 * 版式契约：衬线大标题 → 输入卡（+菜单 / 设计系统▾ / 模板▾ / 模型▾ / 发送）
 *          → 扇形模板卡组（hover 联动模板下拉）→ 空白会话链接 → 库区（产物/设计系统 tab + 搜索）
 * 数据契约：设计系统 = listAssetsTree().designSystems（有 → 下拉默认选中第一个；无 → 不使用）
 *          下拉含"生成新设计系统…"（填入引导文案）；提交带 initialMessage → 直接 sendChat 开聊
 */

const DESIGN_MANIFEST = {
  title: '今天想设计点什么？',
  inputPlaceholder: '画一个落地页布局…',
  projectName: { enabled: false },
  fields: [
    { id: 'taskType', kind: 'text-options', title: '模板', options: ['原型', '幻灯片', '文档', '线框', '动画'], display: 'cards' }
  ],
  contextButtons: ['brand', 'screenshot', 'codebase', 'figma'],
  allowSkip: true
}

function mockApi(opts: { designSystems?: Array<{ name: string; path: string }>; history?: any[] } = {}): string {
  const ds = JSON.stringify(opts.designSystems ?? [])
  const history = JSON.stringify(opts.history ?? [])
  return `
window.__mockBus = {
  listeners: {},
  on(event, fn) { (this.listeners[event] ||= []).push(fn); return () => {}; },
  emit(event, ...args) { (this.listeners[event] || []).forEach(fn => fn(...args)); }
};
window.__mockCalls = [];
window.api = {
  getLocaleState: async () => ({ preference: 'zh-CN', locale: 'zh-CN' }),
  sendChat: (...a) => { window.__mockCalls.push(['sendChat', JSON.stringify(a).slice(0, 3000)]); },
  abortChat: () => {},
  onStreamChunk: (cb) => window.__mockBus.on('stream-chunk', cb),
  onStreamEnd: (cb) => window.__mockBus.on('stream-end', cb),
  onTextFlush: (cb) => window.__mockBus.on('text-flush', cb),
  onToolStart: (cb) => window.__mockBus.on('tool-start', cb),
  onToolEnd: (cb) => window.__mockBus.on('tool-end', cb),
  onAskUser: (cb) => window.__mockBus.on('ask-user', cb),
  onTargetStatus: (cb) => window.__mockBus.on('target-status', cb),
  onAppChanged: (cb) => window.__mockBus.on('app-changed', cb),
  getRoleInitState: async () => ({ hasRole: true, role: { name: 'general', displayName: '通用助手', icon: '✦' } }),
  getAllRoles: async () => [
    { name: 'general', displayName: '通用助手', icon: '✦' },
    { name: 'design', displayName: '设计助手', icon: '🎨' }
  ],
  getCurrentRole: async () => ({ name: 'general', displayName: '通用助手', icon: '✦' }),
  switchRole: async (name) => ({ name, displayName: name === 'design' ? '设计助手' : '通用助手', icon: '🎨' }),
  getRolePreflow: async (roleName) => roleName === 'design' ? ${JSON.stringify(DESIGN_MANIFEST)} : null,
  listAssetsTree: async () => ({ brand: [], refs: [], docs: [], kits: [] }),
  listDesignSystems: async () => ${ds},
  getDesignSystemManifest: async (name) => ({
    name, title: name, description: 'Preflow preview',
    path: '/fake/assets/design/' + name,
    groups: [{ group: 'preview', cards: [{ rel: 'preview/hero.html', name: 'Hero', group: 'preview', w: 700, h: 260 }] }],
    kits: []
  }),
  listArtifactHistory: async (role, limit) => { window.__mockCalls.push(['listArtifactHistory', role, limit]); return ${history}; },
  uploadAssetToCategory: async (p, category) => ({ category, fileName: 'x.png', path: '/tmp/x.png', sourceType: 'upload' }),
  deleteAsset: async () => ({ ok: true }),
  openFileDialog: async () => null,
  updateConversationConfig: async (...a) => { window.__mockCalls.push(['updateConversationConfig', JSON.stringify(a).slice(0, 3000)]); return ({ ok: true }); },
  // 会话专属模型上线后前置页不该再碰全局切换——记录调用以便断言"绝不被调用"
  switchModelPreset: async (...a) => { window.__mockCalls.push(['switchModelPreset', JSON.stringify(a)]); return true; },
  listConversations: async () => [],
  createConversation: async (role) => ({ id: 'c1', title: '新对话', role, createdAt: Date.now(), updatedAt: Date.now(), messageCount: 0 }),
  getConversationMessages: async (id) => {
    window.__mockCalls.push(['getConversationMessages', id]);
    if (id === 'conv-a') return [
      { role: 'user', content: '旧需求：做个仪表盘', timestamp: Date.now() - 60000 },
      { role: 'assistant', content: '旧产物在这个会话里', timestamp: Date.now() - 50000 }
    ];
    return [];
  },
  replaceMessages: async () => {}, appendMessages: async () => {}, deleteConversation: async () => {},
  getAppSettings: async () => ({ detected: [], disabled: [], browsers: [] }),
  isCustomConfig: async () => ({ isCustom: false }),
  getAvailableModels: async () => [
    { id: 'm1', name: 'gpt-4o', model: 'gpt-4o', active: true },
    { id: 'm2', name: 'qwen3.7-max', model: 'qwen3.7-max', active: false }
  ],
  getModelConfig: async () => ({ provider: 'openai', baseUrl: '', apiKey: '', model: '' }),
  getModelConfigFull: async () => ({ provider: 'openai', baseUrl: '', apiKey: '', model: 'gpt-4o' }),
  listSkills: async () => [],
  getRealtimeConfig: async () => ({ provider: 'openai', url: '', model: '', deployment: '', apiVersion: '', voice: 'alloy', hasKey: false }),
  startRealtime: async () => ({ success: false }),
  stopRealtime: () => {}, sendRealtimeEvent: () => {},
  onRealtimeEvent: () => () => {}, onRealtimeState: () => () => {}
};
`
}

const DS_ONE = [{ name: 'openpipal-design-system', path: '/fake/assets/design/openpipal-design-system' }]
const HISTORY_TWO = [
  {
    id: 'artifact-1', type: 'html', title: 'Clio-Design-System.dc.html',
    conversationId: 'conv-a', conversationTitle: 'Clio 复刻', updatedAt: 1780000000000,
    thumbnail: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
  },
  {
    id: 'artifact-2', type: 'html', title: '产品介绍 deck.dc.html',
    conversationId: 'conv-b', conversationTitle: 'Deck 任务', updatedAt: 1780000100000
  }
]

async function bootToDesignPreflow(page: Page, opts: Parameters<typeof mockApi>[0] = {}): Promise<void> {
  await page.addInitScript({ content: mockApi(opts) })
  await page.goto('/')
  await page.waitForLoadState('networkidle')
  await page.waitForSelector('textarea', { timeout: 10000 })
  // 欢迎页固定从 general 起步 → 点设计助手头像触发 preflow
  await page.locator('button[title="设计助手"]').click()
  await page.waitForSelector('[data-testid="preflow-composer"]', { timeout: 5000 })
}

async function bootToGeneralWelcome(page: Page): Promise<void> {
  await page.addInitScript({ content: mockApi() })
  await page.goto('/')
  await page.waitForLoadState('networkidle')
  await page.waitForSelector('[data-testid="welcome-model-select"]', { timeout: 10000 })
}

test.use({ viewport: { width: 1100, height: 900 } })

test.describe('design preflow — Claude Design 风首页', () => {
  test('T1 版式：大标题 + 输入卡三下拉 + 5 张扇形卡 + 空白会话链接', async ({ page }) => {
    await bootToDesignPreflow(page, { designSystems: DS_ONE, history: HISTORY_TWO })
    await expect(page.locator('[data-testid="preflow-headline"]')).toHaveText('今天想设计点什么？')
    await expect(page.locator('[data-testid="preflow-input"]')).toBeVisible()
    await expect(page.locator('[data-testid="preflow-plus-btn"]')).toBeVisible()
    await expect(page.locator('[data-testid="preflow-ds-select"]')).toBeVisible()
    await expect(page.locator('[data-testid="preflow-tpl-select"]')).toBeVisible()
    await expect(page.locator('[data-testid="preflow-model-select"]')).toBeVisible()
    await expect(page.locator('[data-testid^="preflow-type-card-"]')).toHaveCount(5)
    await expect(page.locator('[data-testid="preflow-blank-link"]')).toBeVisible()
    await page.screenshot({ path: `${ARTIFACTS_DIR}/t1-home-layout.png`, fullPage: true })
    console.log('[preflow-t1] 首页版式齐全 - 通过')
  })

  test('T2a 有设计系统 → 下拉默认选中；可切换到不使用', async ({ page }) => {
    await bootToDesignPreflow(page, { designSystems: DS_ONE })
    const sel = page.locator('[data-testid="preflow-ds-select"]')
    await expect(sel).toHaveAttribute('data-ds-selected', 'true')
    await expect(sel).toContainText('openpipal-design-system')
    await sel.click()
    await page.locator('[data-testid="preflow-ds-menu"] button', { hasText: '不使用' }).click()
    await expect(sel).toHaveAttribute('data-ds-selected', 'false')
    await expect(sel).toContainText('不使用')
    await page.screenshot({ path: `${ARTIFACTS_DIR}/t2a-ds-dropdown.png` })
    console.log('[preflow-t2a] 设计系统下拉默认选中/可切换 - 通过')
  })

  test('T2b 无设计系统 → 缺省不使用；菜单含生成入口并填入引导文案', async ({ page }) => {
    await bootToDesignPreflow(page, { designSystems: [] })
    const sel = page.locator('[data-testid="preflow-ds-select"]')
    await expect(sel).toHaveAttribute('data-ds-selected', 'false')
    await sel.click()
    await page.locator('[data-testid="preflow-ds-generate"]').click()
    await expect(page.locator('[data-testid="preflow-input"]')).toHaveValue(/生成一套完整设计系统/)
    console.log('[preflow-t2b] 无设计系统缺省 + 生成入口 - 通过')
  })

  test('T3 hover 预览式联动（显示跟随、松开回落）；click 才提交选值', async ({ page }) => {
    await bootToDesignPreflow(page, { designSystems: DS_ONE })
    const tpl = page.locator('[data-testid="preflow-tpl-select"]')
    await expect(tpl).toContainText('无') // v3 manifest 无默认
    // hover → 下拉联动显示预览（灰字），但选值未提交
    await page.locator('[data-testid="preflow-type-card-1"]').hover()
    await expect(tpl).toContainText('幻灯片')
    // 鼠标离开卡组 → 显示回落到"无"（预览不粘滞，绝不静默覆盖）
    await page.locator('[data-testid="preflow-input"]').hover()
    await expect(tpl).toContainText('无')
    await page.locator('[data-testid="preflow-type-card-2"]').click()
    await expect(tpl).toContainText('文档')
    // 选中态描边:原来钉死的是硬编码 sage(#A8BB87),现在走令牌 border-brand-300 ——
    // 断言的意图不变(点过之后这张卡要拿到选中描边),只是不再依赖某个具体色值。
    await expect(page.locator('[data-testid="preflow-type-card-2"]')).toHaveClass(/border-brand-300/)
    // click 后扫过别的卡：显示临时预览，离开后回落到已提交选值（提交值始终不被 hover 改写）
    await page.locator('[data-testid="preflow-type-card-4"]').hover()
    await expect(tpl).toContainText('动画')
    await page.locator('[data-testid="preflow-input"]').hover()
    await expect(tpl).toContainText('文档')
    await page.screenshot({ path: `${ARTIFACTS_DIR}/t3-hover-linkage.png` })
    console.log('[preflow-t3] hover 预览式联动 / click 提交 - 通过')
  })

  test('T4 输入需求提交 → 简报（含设计系统+模板）随首条消息 sendChat', async ({ page }) => {
    await bootToDesignPreflow(page, { designSystems: DS_ONE })
    await page.locator('[data-testid="preflow-type-card-1"]').click() // 幻灯片（click 才选中，hover 只是预览）
    await page.locator('[data-testid="preflow-input"]').fill('给新品发布做一个 8 页 deck')
    await page.locator('[data-testid="preflow-start-btn"]').click()
    await expect(page.locator('[data-testid="preflow-composer"]')).toHaveCount(0)
    await expect(async () => {
      const calls = await page.evaluate(() => (window as any).__mockCalls)
      const send = calls.filter((c: any[]) => c[0] === 'sendChat')
      expect(send.length).toBeGreaterThan(0)
      const payload = send.map((c: any[]) => c[1]).join('')
      expect(payload).toContain('给新品发布做一个 8 页 deck')
      expect(payload).toContain('design-system')   // 设计系统 initialAsset
      expect(payload).toContain('幻灯片')           // roleBrief.taskType
    }).toPass({ timeout: 5000 })
    await page.screenshot({ path: `${ARTIFACTS_DIR}/t4-submit-send.png` })
    console.log('[preflow-t4] 提交带 initialMessage + 简报进 sendChat - 通过')
  })

  test('T4b 选"不使用" → 载荷零设计系统指针（读不到=不存在）', async ({ page }) => {
    await bootToDesignPreflow(page, { designSystems: DS_ONE })
    await page.locator('[data-testid="preflow-ds-select"]').click()
    await page.locator('[data-testid="preflow-ds-menu"] button', { hasText: '不使用' }).click()
    await page.locator('[data-testid="preflow-input"]').fill('随便做一张卡片')
    await page.locator('[data-testid="preflow-start-btn"]').click()
    await expect(async () => {
      const calls = await page.evaluate(() => (window as any).__mockCalls)
      const send = calls.filter((c: any[]) => c[0] === 'sendChat')
      expect(send.length).toBeGreaterThan(0)
      const payload = send.map((c: any[]) => c[1]).join('')
      expect(payload).toContain('随便做一张卡片')
      expect(payload).not.toContain('design-system')                    // 无类别指针
      expect(payload).not.toContain('/fake/assets/design/openpipal')     // 无路径指针
    }).toPass({ timeout: 5000 })
    console.log('[preflow-t4b] 不使用 → 零设计系统指针 - 通过')
  })

  test('T5 库区：产物/设计系统双 tab + 搜索 + 点击回原会话', async ({ page }) => {
    await bootToDesignPreflow(page, { designSystems: DS_ONE, history: HISTORY_TWO })
    const items = page.locator('[data-testid="preflow-history-item"]')
    await expect(items).toHaveCount(2)
    // 界面内隐藏 .dc.html 技术后缀（导出才带）——这里同时锁住 stripDcSuffix 行为
    await expect(items.first()).toContainText('Clio-Design-System')
    await expect(items.first()).not.toContainText('.dc.html')
    await expect(items.first().locator('img')).toHaveCount(1) // 缩略图
    // 搜索过滤
    await page.locator('[data-testid="preflow-lib-search"]').fill('deck')
    await expect(items).toHaveCount(1)
    await page.locator('[data-testid="preflow-lib-search"]').fill('')
    // 设计系统 tab
    await page.locator('[data-testid="preflow-lib-tab-systems"]').click()
    const dsRow = page.locator('[data-testid="preflow-ds-row"]')
    await expect(dsRow).toHaveCount(1)
    await expect(dsRow).toContainText('openpipal-design-system')
    await expect(dsRow).toContainText('已选用') // 默认选中 → 行内状态同步
    await page.screenshot({ path: `${ARTIFACTS_DIR}/t5-library.png`, fullPage: true })
    // 回产物 tab 点击跳会话
    await page.locator('[data-testid="preflow-lib-tab-products"]').click()
    await items.first().click()
    await expect(page.getByText('旧产物在这个会话里')).toBeVisible({ timeout: 5000 })
    const calls = await page.evaluate(() => (window as any).__mockCalls)
    expect(calls.some((c: any[]) => c[0] === 'getConversationMessages' && c[1] === 'conv-a')).toBeTruthy()
    console.log('[preflow-t5] 库区双 tab + 搜索 + 跳回原会话 - 通过')
  })

  test('T6 加号菜单 = 4 类资料', async ({ page }) => {
    await bootToDesignPreflow(page, { designSystems: DS_ONE })
    await page.locator('[data-testid="preflow-plus-btn"]').click()
    const menu = page.locator('[data-testid="preflow-plus-menu"]')
    await expect(menu).toBeVisible()
    for (const label of ['品牌资产', '参考截图', '代码库', 'Figma 链接']) {
      await expect(menu).toContainText(label)
    }
    console.log('[preflow-t6] + 菜单 4 类资料 - 通过')
  })

  test('T10 前置页选模型 = 会话专属：不调全局 switchModelPreset；modelPresetId 随会话 config', async ({ page }) => {
    await bootToDesignPreflow(page, { designSystems: DS_ONE })
    // 打开合一控件，两级菜单：主面板"模型"行 → 子面板选非激活的 qwen（m2）
    await page.locator('[data-testid="preflow-model-select"]').click()
    await page.locator('[data-testid="preflow-model-menu"] button', { hasText: '模型' }).first().click()
    await page.locator('[data-testid="preflow-model-menu"] button', { hasText: 'qwen3.7-max' }).click()
    // 下拉显示切到所选模型名（纯本地选择，不经全局往返）
    await expect(page.locator('[data-testid="preflow-model-select"]')).toContainText('qwen3.7-max')
    // 选完模型这一步就绝不能碰全局 switchModelPreset（旧 bug 的根因）
    {
      const calls = await page.evaluate(() => (window as any).__mockCalls)
      expect(calls.some((c: any[]) => c[0] === 'switchModelPreset')).toBeFalsy()
    }
    // 提交开聊 → modelPresetId 进本会话 config（sendChat 载荷 or updateConversationConfig 落盘）
    await page.locator('[data-testid="preflow-input"]').fill('用 qwen 画个卡片')
    await page.locator('[data-testid="preflow-start-btn"]').click()
    await expect(async () => {
      const calls = await page.evaluate(() => (window as any).__mockCalls)
      expect(calls.some((c: any[]) => c[0] === 'switchModelPreset')).toBeFalsy() // 全程都不碰全局
      const relevant = calls.filter((c: any[]) => c[0] === 'sendChat' || c[0] === 'updateConversationConfig')
      expect(relevant.length).toBeGreaterThan(0)
      const payload = relevant.map((c: any[]) => c[1]).join('')
      expect(payload).toContain('modelPresetId')
      expect(payload).toContain('m2')
    }).toPass({ timeout: 5000 })
    console.log('[preflow-t10] 前置页选模型 = 会话专属，不碰全局 - 通过')
  })

  test('T11 欢迎页选模型 = 当前空会话专属；首条请求不回退到出生模型', async ({ page }) => {
    await bootToGeneralWelcome(page)
    await page.locator('[data-testid="welcome-model-select"]').click()
    await page.locator('[data-testid="welcome-model-menu"] button', { hasText: '模型' }).click()
    await page.locator('[data-testid="welcome-model-menu"] button', { hasText: 'qwen3.7-max' }).click()
    await expect(page.locator('[data-testid="welcome-model-select"]')).toContainText('qwen3.7-max')

    // 尚无任何历史会话时，选择先保存在 inflight conversationConfig，首条发送物化会话后再落盘；
    // 所以发送前只断言不碰全局，最终契约以 sendChat 的真实会话配置为准。
    const beforeSend = await page.evaluate(() => (window as any).__mockCalls)
    expect(beforeSend.some((c: any[]) => c[0] === 'switchModelPreset')).toBeFalsy()

    await page.locator('textarea').fill('批改这张作业图片')
    await page.locator('[data-testid="send-btn"]').click()
    await expect(async () => {
      const calls = await page.evaluate(() => (window as any).__mockCalls)
      expect(calls.some((c: any[]) => c[0] === 'switchModelPreset')).toBeFalsy()
      const send = calls.find((c: any[]) => c[0] === 'sendChat')
      expect(send?.[1]).toContain('modelPresetId')
      expect(send?.[1]).toContain('m2')
    }).toPass({ timeout: 5000 })
    console.log('[preflow-t11] 欢迎页所选模型进入首条请求 - 通过')
  })

  test('T7 空白会话链接 = 跳过前置', async ({ page }) => {
    await bootToDesignPreflow(page, { designSystems: DS_ONE })
    await page.locator('[data-testid="preflow-blank-link"]').click()
    await expect(page.locator('[data-testid="preflow-composer"]')).toHaveCount(0)
    await expect(page.locator('textarea')).toBeVisible() // 回到欢迎页输入
    console.log('[preflow-t7] 空白会话链接跳过 - 通过')
  })

  test('T8 设计系统 tab 行主体点击 → 全屏画廊预览 overlay；关闭消失', async ({ page }) => {
    await bootToDesignPreflow(page, { designSystems: DS_ONE })
    await page.locator('[data-testid="preflow-lib-tab-systems"]').click()
    // 行主体(左上角,避开右侧「选用」按钮的 stopPropagation)→ overlay 打开
    await page.locator('[data-testid="preflow-ds-row"]').click({ position: { x: 20, y: 20 } })
    const preview = page.locator('[data-testid="preflow-ds-preview"]')
    await expect(preview).toBeVisible()
    // 内嵌 DesignSystemGallery 拉 manifest 并渲染分组
    await expect(preview.locator('[data-testid="ds-gallery"]')).toBeVisible({ timeout: 5000 })
    await expect(preview.getByText('preview', { exact: true })).toBeVisible()
    // 关闭 → overlay 消失
    await page.locator('[data-testid="preflow-ds-preview-close"]').click()
    await expect(preview).toHaveCount(0)
    console.log('[preflow-t8] ds 行 → 画廊预览 overlay + 关闭 - 通过')
  })

  test('T9 画廊「选用这套」→ 等价选用(data-ds-selected=true) + overlay 关闭', async ({ page }) => {
    await bootToDesignPreflow(page, { designSystems: DS_ONE })
    const sel = page.locator('[data-testid="preflow-ds-select"]')
    // 先切到「不使用」，制造可观测的选用变化
    await sel.click()
    await page.locator('[data-testid="preflow-ds-menu"] button', { hasText: '不使用' }).click()
    await expect(sel).toHaveAttribute('data-ds-selected', 'false')
    // 进设计系统 tab → 行主体点开预览 → 点「选用这套」
    await page.locator('[data-testid="preflow-lib-tab-systems"]').click()
    await page.locator('[data-testid="preflow-ds-row"]').click({ position: { x: 20, y: 20 } })
    const preview = page.locator('[data-testid="preflow-ds-preview"]')
    await expect(preview).toBeVisible()
    await page.locator('[data-testid="preflow-ds-preview-use"]').click()
    // overlay 关闭 + 顶部下拉回到已选用态(与 T2a 选用断言一致)
    await expect(preview).toHaveCount(0)
    await expect(sel).toHaveAttribute('data-ds-selected', 'true')
    await expect(sel).toContainText('openpipal-design-system')
    console.log('[preflow-t9] 画廊选用这套 → 选用生效 + overlay 关闭 - 通过')
  })
})

/**
 * dc 幻灯片（deck-stage）导出 PPTX（分享弹窗新增格式卡）E2E
 *
 * 覆盖:
 *   T1 deck dc artifact（引用 deck-stage.js）→ 弹窗含 pptx 格式卡
 *   T2 选中 pptx 卡 → 下载 → artifact:export(format:'pptx')
 *   T3 非 deck dc artifact（动画/静态，无 deck-stage.js 标记）→ 无 pptx 卡（回归防误伤）
 *   T4 deck dc → 不出现 mp4 卡（deck 不是 animation，两个格式卡互斥回归）
 *
 * Mock 策略同 mp4-export-btn.spec.ts / pdf-export-btn.spec.ts：精简 window.api mock +
 * __mockBus.emit('artifact', ...)。弹窗格式卡只依赖同步的 isDcHtml(content)/looksLikeDeckDc(content)，
 * 不需要 iframe 内渲染。
 */

import { test, expect, Page } from '@playwright/test'

test.use({ viewport: { width: 1200, height: 800 } })

const ARTIFACTS_DIR = 'tests/artifacts/pptx-export-btn'

// 最小 deck dc：引用 ./deck-stage.js 触发 looksLikeDeckDc。这个 UI 测试只走 mock window.api
// （不实际渲染 iframe 内的 <deck-stage>），页数/尺寸解析已下沉到主进程 dc-pptx-export.ts 读 DOM 真值。
const MINI_DECK = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<script src="./support.js"></script>
</head>
<body>
<x-dc>
<helmet><style>body{margin:0}</style></helmet>
<x-import component-from-global-scope="deck-stage" from="./deck-stage.js" width="1920" height="1080" hint-size="100%,100%">
<section data-label="One" style="background:#f5f0e6;display:flex;align-items:center;justify-content:center;"><h1 style="font-size:72px;">Slide One</h1></section>
<section data-label="Two" style="background:#2a2620;color:#fff;display:flex;align-items:center;justify-content:center;"><h1 style="font-size:72px;">Slide Two</h1></section>
</x-import>
</x-dc>
</body>
</html>`

// 动画 dc（无 deck-stage.js 标记）：不应出现 pptx 卡
const MINI_ANIM = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<script src="./support.js"></script>
</head>
<body>
<x-dc>
<helmet><style>body{margin:0}</style></helmet>
<x-import component-from-global-scope="Stage" from="./animations.jsx" width="1280" height="720" duration="4" hint-size="100%,100%">
<div style="font-size:64px;color:#2a2620;padding:80px;">Hello Motion</div>
</x-import>
</x-dc>
</body>
</html>`

// 静态 dc（无动画/deck 标记）：不应出现 pptx 卡
const MINI_DC = `<!DOCTYPE html><html><body><x-dc><div style="padding:20px">STATIC SUBJECT</div></x-dc></body></html>`

const MOCK_API = `
window.__mockBus = {
  listeners: {},
  on(event, fn) { (this.listeners[event] ||= []).push(fn); return () => { this.listeners[event] = this.listeners[event].filter(f => f !== fn); }; },
  emit(event, ...args) { (this.listeners[event] || []).forEach(fn => fn(...args)); }
};
const DESIGN_ROLE = { name: 'design', displayName: '设计助手', icon: '🎨' };
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
  onExportProgress: (cb) => window.__mockBus.on('export-progress', cb),
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
  loadCompiledArtifact: async () => null,
  getExportDir: async () => ({ dir: '/Users/mock/Downloads' }),
  chooseExportDir: async () => ({ dir: '/Users/mock/Downloads' }),
  exportArtifact: async (req) => {
    (window.__mockCalls ||= []).push({ method: 'exportArtifact', format: req.format, title: req.title });
    return { ok: true, path: '/Users/mock/Downloads/' + (req.title || 'out') + '.pptx' };
  },
};
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

test.describe('pptx 导出（分享弹窗流）', () => {
  test('T1-T2 deck dc → pptx 卡 + 下载 → artifact:export(format:pptx)', async ({ page }) => {
    await setup(page)
    await emitArtifact(page, { id: 'deck-dc', type: 'html', title: 'Deck', content: MINI_DECK })

    await page.getByTestId('share-btn').click()
    const pptxCard = page.getByTestId('export-fmt-pptx')
    await expect(pptxCard).toBeVisible({ timeout: 5000 })
    await expect(pptxCard).toContainText('PPTX')
    // 交接包对所有 dc 类型都开放（无门槛），deck 也应看到这张卡
    await expect(page.getByTestId('export-fmt-handoff')).toBeVisible()

    await pptxCard.click()
    await page.getByTestId('export-download-btn').click()
    await expect(page.getByTestId('dc-export-msg')).toContainText('已导出', { timeout: 5000 })

    const calls = await page.evaluate(() => (window as any).__mockCalls.filter((c: any) => c.method === 'exportArtifact'))
    expect(calls.length).toBe(1)
    expect(calls[0].format).toBe('pptx')

    await page.screenshot({ path: `${ARTIFACTS_DIR}/t1-deck-pptx-card.png`, fullPage: true })
  })

  test('T3 动画 dc（无 deck-stage 标记）→ 无 pptx 卡，但有交接包卡', async ({ page }) => {
    await setup(page)
    await emitArtifact(page, { id: 'anim-dc', type: 'html', title: 'Anim', content: MINI_ANIM })

    await page.getByTestId('share-btn').click()
    await expect(page.getByTestId('export-fmt-mp4')).toBeVisible({ timeout: 5000 })
    await expect(page.getByTestId('export-fmt-pptx')).toHaveCount(0)
    await expect(page.getByTestId('export-fmt-handoff')).toBeVisible()

    await page.screenshot({ path: `${ARTIFACTS_DIR}/t3-anim-no-pptx-card.png`, fullPage: true })
  })

  test('T3b 静态 dc（无动画/deck 标记）→ 无 pptx 卡，但有交接包卡', async ({ page }) => {
    await setup(page)
    await emitArtifact(page, { id: 'static-dc', type: 'html', title: 'Static', content: MINI_DC })

    await page.getByTestId('share-btn').click()
    await expect(page.getByTestId('export-fmt-project-zip')).toBeVisible({ timeout: 5000 })
    await expect(page.getByTestId('export-fmt-pptx')).toHaveCount(0)
    await expect(page.getByTestId('export-fmt-handoff')).toBeVisible()

    await page.screenshot({ path: `${ARTIFACTS_DIR}/t3b-static-no-pptx-card.png`, fullPage: true })
  })

  test('T4 deck dc → 不出现 mp4 卡（deck 不是 animation，格式卡互斥回归）', async ({ page }) => {
    await setup(page)
    await emitArtifact(page, { id: 'deck-dc-2', type: 'html', title: 'Deck2', content: MINI_DECK })

    await page.getByTestId('share-btn').click()
    await expect(page.getByTestId('export-fmt-pptx')).toBeVisible({ timeout: 5000 })
    await expect(page.getByTestId('export-fmt-mp4')).toHaveCount(0)

    await page.screenshot({ path: `${ARTIFACTS_DIR}/t4-deck-no-mp4-card.png`, fullPage: true })
  })

  test('T5 交接包卡（存在于三类 dc）→ 选中并下载 → artifact:export(format:handoff)', async ({ page }) => {
    await setup(page)
    await emitArtifact(page, { id: 'deck-dc-3', type: 'html', title: 'Deck3', content: MINI_DECK })

    await page.getByTestId('share-btn').click()
    const handoffCard = page.getByTestId('export-fmt-handoff')
    await expect(handoffCard).toBeVisible({ timeout: 5000 })
    await expect(handoffCard).toContainText('Code Agent')

    await handoffCard.click()
    await page.getByTestId('export-download-btn').click()
    await expect(page.getByTestId('dc-export-msg')).toContainText('已导出', { timeout: 5000 })

    const calls = await page.evaluate(() => (window as any).__mockCalls.filter((c: any) => c.method === 'exportArtifact'))
    expect(calls.length).toBe(1)
    expect(calls[0].format).toBe('handoff')

    await page.screenshot({ path: `${ARTIFACTS_DIR}/t5-handoff-card.png`, fullPage: true })
  })
})

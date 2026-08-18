/**
 * dc 动画导出 MP4（分享弹窗新增格式卡）E2E
 *
 * 覆盖:
 *   T1 动画 dc artifact（引用 animations.jsx）→ 弹窗含 mp4 格式卡 + "时长自动读取"说明文案，无时长输入框
 *   T2 选中 mp4 卡 → 下载 → artifact:export(format:'mp4', fps:30)，不带 durationSec（时长由主进程
 *      从 DOM data-openpipal-video-duration-secs 属性读取，见 dc-video-export.ts）
 *   T3 非动画 dc artifact（无 animations.jsx/useTime 等标记）→ 无 mp4 卡（回归防误伤静态 dc）
 *
 * Mock 策略同 pdf-export-btn.spec.ts：精简 window.api mock + __mockBus.emit('artifact', ...)。
 * 弹窗格式卡只依赖同步的 isDcHtml(content)/looksLikeAnimationDc(content)，不需要 iframe 内渲染。
 */

import { test, expect, Page } from '@playwright/test'

test.use({ viewport: { width: 1200, height: 800 } })

const ARTIFACTS_DIR = 'tests/artifacts/mp4-export-btn'

// 最小动画 dc：引用 ./animations.jsx 触发 looksLikeAnimationDc。duration="4" 保留在源码里但这个
// UI 测试只走 mock window.api（不实际渲染 svg/DOM），时长解析已下沉到主进程 dc-video-export.ts
// 读 DOM 真值，这里的 UI 层测试只关心弹窗不再暴露时长输入框、且请求不带 durationSec。
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

// 静态 dc（无动画标记）：不应出现 mp4 卡
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
    (window.__mockCalls ||= []).push({ method: 'exportArtifact', format: req.format, title: req.title, durationSec: req.durationSec, fps: req.fps });
    return { ok: true, path: '/Users/mock/Downloads/' + (req.title || 'out') + '.mp4' };
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

test.describe('mp4 导出（分享弹窗流）', () => {
  test('T1-T2 动画 dc → mp4 卡 + 时长自动读取说明 + 下载请求不带 durationSec', async ({ page }) => {
    await setup(page)
    await emitArtifact(page, { id: 'anim-dc', type: 'html', title: 'Anim', content: MINI_ANIM })

    await page.getByTestId('share-btn').click()
    const mp4Card = page.getByTestId('export-fmt-mp4')
    await expect(mp4Card).toBeVisible({ timeout: 5000 })
    // 交接包对所有 dc 类型都开放（无门槛），动画 dc 也应看到这张卡
    await expect(page.getByTestId('export-fmt-handoff')).toBeVisible()

    await mp4Card.click()
    // 时长选择器已去掉：无输入框，改为说明文案——真实时长由主进程从 DOM 读取
    await expect(page.getByTestId('export-mp4-duration')).toHaveCount(0)
    await expect(page.getByTestId('export-mp4-duration-note')).toBeVisible()
    await expect(page.getByTestId('export-mp4-duration-note')).toContainText('自动读取')

    await page.getByTestId('export-download-btn').click()
    await expect(page.getByTestId('dc-export-msg')).toContainText('已导出', { timeout: 5000 })

    const calls = await page.evaluate(() => (window as any).__mockCalls.filter((c: any) => c.method === 'exportArtifact'))
    expect(calls.length).toBe(1)
    expect(calls[0].format).toBe('mp4')
    expect(calls[0].durationSec).toBeUndefined()
    expect(calls[0].fps).toBe(30)

    await page.screenshot({ path: `${ARTIFACTS_DIR}/t1-anim-mp4-card.png`, fullPage: true })
  })

  test('T3 静态 dc（无动画标记）→ 无 mp4 卡，但有交接包卡', async ({ page }) => {
    await setup(page)
    await emitArtifact(page, { id: 'static-dc', type: 'html', title: 'Static', content: MINI_DC })

    await page.getByTestId('share-btn').click()
    await expect(page.getByTestId('export-fmt-project-zip')).toBeVisible({ timeout: 5000 })
    await expect(page.getByTestId('export-fmt-mp4')).toHaveCount(0)
    await expect(page.getByTestId('export-fmt-handoff')).toBeVisible()

    await page.screenshot({ path: `${ARTIFACTS_DIR}/t3-static-no-mp4-card.png`, fullPage: true })
  })
})

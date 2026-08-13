/**
 * PDF 导出（经分享弹窗）E2E — W3 任务3 用户可见交付物，已升级为导出弹窗流
 *
 * 覆盖:
 *   T1 dc artifact（<x-dc>）→ 分享弹窗含 PDF 格式卡，选中下载 → artifact:export(format:'pdf') → toast
 *   T2 document artifact → 弹窗含 PDF 卡（文档类才有）
 *   T3 code / svg artifact → 弹窗只有源文件卡，无 PDF 卡（toHaveCount(0)）
 *
 * Mock 策略同 dc-render.spec.ts：精简 window.api mock + __mockBus.emit('artifact', ...)。
 * 弹窗格式卡只依赖同步的 isDcHtml(content)/type，不需要 iframe 内 React 渲染（无网络依赖）。
 */

import { test, expect, Page } from '@playwright/test'

test.use({ viewport: { width: 1200, height: 800 } })

const ARTIFACTS_DIR = 'tests/artifacts/pdf-export-btn'

// 最小 dc html：isDcHtml 只需 <x-dc 标签，无需网络渲染即可让 isDcArtifact=true
const MINI_DC = `<!DOCTYPE html><html><body><x-dc><div style="padding:20px">PDF SUBJECT</div></x-dc></body></html>`

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
  // 钉死接口契约：exportArtifact({format,...}) → { ok, path }；目录来自 getExportDir
  getExportDir: async () => ({ dir: '/Users/mock/Downloads' }),
  chooseExportDir: async () => ({ dir: '/Users/mock/Downloads' }),
  exportArtifact: async (req) => {
    (window.__mockCalls ||= []).push({ method: 'exportArtifact', format: req.format, title: req.title, contentLen: (req.content || '').length });
    return { ok: true, path: '/Users/mock/Downloads/' + (req.title || 'out') + '.pdf' };
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
  artifact: { id: string; type: string; title: string; content: string; language?: string }
): Promise<void> {
  await page.evaluate(
    ({ artifact }) => (window as any).__mockBus.emit('artifact', '', artifact),
    { artifact }
  )
  await page.waitForTimeout(300)
}

test.describe('PDF 导出（分享弹窗流）(W3 task3)', () => {
  test('T1 dc artifact → 弹窗含 PDF 卡，选中下载 → artifact:export(pdf) + toast', async ({ page }) => {
    await setup(page)
    await emitArtifact(page, { id: 'pdf-dc', type: 'html', title: 'Clio', content: MINI_DC })

    await page.getByTestId('share-btn').click()
    const pdfCard = page.getByTestId('export-fmt-pdf')
    await expect(pdfCard).toBeVisible({ timeout: 5000 })

    await pdfCard.click()
    await page.getByTestId('export-download-btn').click()
    await expect(page.getByTestId('dc-export-msg')).toContainText('已导出', { timeout: 5000 })
    await expect(page.getByTestId('dc-export-msg')).toContainText('Clio.pdf')

    const calls = await page.evaluate(() =>
      (window as any).__mockCalls.filter((c: any) => c.method === 'exportArtifact')
    )
    expect(calls.length).toBe(1)
    expect(calls[0].format).toBe('pdf')
    expect(calls[0].title).toBe('Clio')
    expect(calls[0].contentLen).toBeGreaterThan(0)

    await page.screenshot({ path: `${ARTIFACTS_DIR}/t1-dc-pdf-btn.png`, fullPage: true })
  })

  test('T2 document artifact → 弹窗含 PDF 卡（无 dc 项目包卡）', async ({ page }) => {
    await setup(page)
    await emitArtifact(page, { id: 'pdf-doc', type: 'document', title: 'Report', content: '# Heading\n\nBody text.' })

    await page.getByTestId('share-btn').click()
    await expect(page.getByTestId('export-fmt-pdf')).toBeVisible({ timeout: 5000 })
    // document 非 dc：无项目包/独立 HTML 卡
    await expect(page.getByTestId('export-fmt-project-zip')).toHaveCount(0)
    await expect(page.getByTestId('export-fmt-standalone-html')).toHaveCount(0)

    await page.screenshot({ path: `${ARTIFACTS_DIR}/t2-document-pdf-btn.png`, fullPage: true })
  })

  test('T3 code / svg artifact → 弹窗只有源文件卡，无 PDF 卡', async ({ page }) => {
    await setup(page)
    await emitArtifact(page, { id: 'pdf-code', type: 'code', title: 'script.js', content: 'const x = 1', language: 'javascript' })
    // ArtifactTab 已挂载（工具条源码/预览切换存在）
    await expect(page.getByRole('button', { name: '源码' })).toBeVisible({ timeout: 5000 })
    await page.getByTestId('share-btn').click()
    await expect(page.getByTestId('export-fmt-source')).toBeVisible()
    await expect(page.getByTestId('export-fmt-pdf')).toHaveCount(0)
    await page.getByTestId('share-btn').click() // 关掉弹窗，避免与下一个 tab 的弹窗共存

    // 多 tab 同时挂载：新 artifact 的 tab 在 DOM 末尾，用 .last() 定位当前激活 tab
    await emitArtifact(page, { id: 'pdf-svg', type: 'svg', title: 'icon.svg', content: '<svg xmlns="http://www.w3.org/2000/svg"></svg>' })
    await page.getByTestId('share-btn').last().click()
    await expect(page.getByTestId('export-fmt-source')).toBeVisible()
    await expect(page.getByTestId('export-fmt-pdf')).toHaveCount(0)

    await page.screenshot({ path: `${ARTIFACTS_DIR}/t3-code-no-pdf-btn.png`, fullPage: true })
  })
})

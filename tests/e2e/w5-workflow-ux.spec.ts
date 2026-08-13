/**
 * W5 工作流 UX 轻件 E2E — 用户可见交付物
 *
 * 覆盖(契约 A 展示半 + 契约 C 分享按钮半):
 *   T1 todos artifact(type='todos') → ArtifactTab 渲染勾选清单:
 *      done/total 计数 + 三态图标(completed/in_progress/pending)+ 各项文本;
 *      todos 无可分享格式 → share-btn 不渲染。
 *   T1b todos 全部完成 → artifact + tab 自动退场，工具记录留在对话；同 id 再启用可重新打开。
 *   T2 document artifact → share-btn 可见,点击 → 路由到 exportArtifactPdf(PDF)+ toast。
 *   T3 design-system artifact → share-btn 可见,点击 → 路由到 exportZip,
 *      从 getMemoryConfig().globalDir 派生 .openpipal 基路径拼出 design-systems/<name> 绝对路径。
 *   T4 code artifact → share-btn 可见(路由到源文件下载)。
 *   T5 questions artifact → share-btn 不渲染(loop-break 类型无分享格式)。
 *
 * Mock 策略同 pdf-export-btn.spec.ts / ds-gallery.spec.ts:精简 window.api mock +
 * __mockBus.emit('artifact', '', ...)。按钮可见性只依赖同步的 data.type,不需要 iframe 内渲染。
 * 每个 test 单独 setup + 只 emit 一个 artifact → 只有一个 ArtifactTab 挂载,避免多 share-btn 破坏 strict 定位。
 */

import { test, expect, Page } from '@playwright/test'

test.use({ viewport: { width: 1200, height: 800 } })

const ARTIFACTS_DIR = 'tests/artifacts/w5-workflow-ux'

const MOCK_API = `
window.__mockBus = {
  listeners: {},
  on(event, fn) { (this.listeners[event] ||= []).push(fn); return () => { this.listeners[event] = this.listeners[event].filter(f => f !== fn); }; },
  emit(event, ...args) { (this.listeners[event] || []).forEach(fn => fn(...args)); }
};
window.__mockCalls = [];
const DESIGN_ROLE = { name: 'design', displayName: '设计助手', icon: '🎨' };
const DS_MANIFEST = { name: 'wildcreek', title: 'Wildcreek', description: '', path: '/Users/tester/.openpipal/design-systems/wildcreek', groups: [], kits: [] };
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
  onQuestionsV2Delta: (cb) => window.__mockBus.on('questions-v2-delta', cb),
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
  getDesignSystemManifest: async (name) => (name === 'wildcreek' ? DS_MANIFEST : null),
  getMemoryConfig: async () => ({ globalDir: '/Users/tester/.openpipal/memory/global' }),
  // 钉死契约:exportArtifactPdf(title, content) / exportZip(sourceDir, outName)
  exportArtifactPdf: async (title, content) => {
    window.__mockCalls.push({ method: 'exportArtifactPdf', title, contentLen: (content || '').length });
    return { ok: true, path: '/Users/tester/.openpipal/outputs/' + title + '.pdf' };
  },
  exportZip: async (sourceDir, outName) => {
    window.__mockCalls.push({ method: 'exportZip', sourceDir, outName });
    return { ok: true, path: '/Users/tester/.openpipal/outputs/' + outName + '.zip' };
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

const TODOS_CONTENT = JSON.stringify({
  todos: [
    { content: '收集需求', status: 'completed' },
    { content: '出设计方案', status: 'in_progress' },
    { content: '交付验收', status: 'pending' }
  ]
})

test.describe('W5 工作流 UX 轻件', () => {
  test('T1 todos artifact → 渲染勾选清单(计数+三态)且无 share-btn', async ({ page }) => {
    await setup(page)
    await emitArtifact(page, { id: 'todos-mock-conv', type: 'todos', title: '任务清单', content: TODOS_CONTENT })

    const todosView = page.getByTestId('artifact-todos')
    await expect(todosView).toBeVisible({ timeout: 5000 })

    // done/total 计数:1 个 completed / 共 3
    await expect(todosView).toContainText('1/3 已完成')

    // 三项文本全渲染
    await expect(todosView).toContainText('收集需求')
    await expect(todosView).toContainText('出设计方案')
    await expect(todosView).toContainText('交付验收')

    // completed 项加删除线(视觉三态的可断言证据)
    const doneItem = todosView.locator('span', { hasText: '收集需求' })
    await expect(doneItem).toHaveClass(/line-through/)

    // todos 无可分享格式 → share-btn 不出现
    await expect(page.getByTestId('share-btn')).toHaveCount(0)

    await page.screenshot({ path: `${ARTIFACTS_DIR}/t1-todos-checklist.png`, fullPage: true })
  })

  test('T1b todos 全部完成后自动退场，保留对话记录且同 id 可再次启用', async ({ page }) => {
    await setup(page)
    const artifactId = 'todos-mock-conv'
    await emitArtifact(page, { id: artifactId, type: 'todos', title: '任务清单', content: TODOS_CONTENT })
    const todosTab = page.getByRole('button', { name: '任务清单 关闭标签', exact: true })
    await expect(todosTab).toBeVisible()

    const completedContent = JSON.stringify({
      todos: [
        { content: '收集需求', status: 'completed' },
        { content: '出设计方案', status: 'completed' },
        { content: '交付验收', status: 'completed' }
      ]
    })
    await page.evaluate(({ artifactId, completedContent }) => {
      const bus = (window as unknown as { __mockBus: { emit: (...args: unknown[]) => void } }).__mockBus
      bus.emit('tool-start', '', 'update_todos')
      bus.emit('tool-end', '', 'update_todos', undefined, undefined, '任务清单已更新（3/3 完成）')
      bus.emit('artifact', '', { id: artifactId, type: 'todos', title: '任务清单', content: completedContent })
    }, { artifactId, completedContent })

    await expect(page.getByTitle('任务清单')).toHaveCount(0)
    await expect(page.getByTestId('artifact-todos')).toHaveCount(0)
    const retainedToolRecord = await page.evaluate(() => {
      const chatWindow = window as unknown as {
        __chatStore?: { getState?: () => { messages?: Array<{ toolName?: string; content?: string }> } }
      }
      const messages = chatWindow.__chatStore?.getState?.().messages || []
      return messages.some((message) =>
        message.toolName === 'update_todos' && message.content?.includes('3/3 完成')
      )
    })
    expect(retainedToolRecord).toBe(true)

    // 防守路径：修改前已经进入内存的完成清单，也会被 workspace bridge 主动清扫。
    await page.evaluate(({ artifactId, completedContent }) => {
      const artifactWindow = window as unknown as {
        __artifactStore?: { getState?: () => { addArtifact?: (artifact: Record<string, unknown>) => void } }
      }
      artifactWindow.__artifactStore?.getState?.().addArtifact?.({
        id: artifactId,
        type: 'todos',
        title: '任务清单',
        content: completedContent,
        messageId: 'legacy-completed-todos',
        createdAt: Date.now()
      })
    }, { artifactId, completedContent })
    await expect(page.getByTitle('任务清单')).toHaveCount(0)

    // update_todos 使用稳定 id；退场后若同一会话开始新计划，应再次打开而不是被旧去重状态吞掉。
    await emitArtifact(page, { id: artifactId, type: 'todos', title: '任务清单', content: TODOS_CONTENT })
    await expect(todosTab).toBeVisible()
    await expect(page.getByTestId('artifact-todos')).toContainText('1/3 已完成')
  })

  test('T2 document artifact → share-btn 可见,点击路由到 PDF', async ({ page }) => {
    await setup(page)
    await emitArtifact(page, { id: 'doc-1', type: 'document', title: 'Report', content: '# Heading\n\nBody.' })

    const share = page.getByTestId('share-btn')
    await expect(share).toBeVisible({ timeout: 5000 })

    await share.click()
    // 文档 → PDF:落 toast + 调 exportArtifactPdf
    await expect(page.getByTestId('dc-export-msg')).toContainText('已导出 PDF', { timeout: 5000 })
    const calls = await page.evaluate(() => (window as any).__mockCalls)
    const pdf = calls.filter((c: any) => c.method === 'exportArtifactPdf')
    expect(pdf.length).toBe(1)
    expect(pdf[0].title).toBe('Report')
    // document 未路由到 zip
    expect(calls.filter((c: any) => c.method === 'exportZip').length).toBe(0)

    await page.screenshot({ path: `${ARTIFACTS_DIR}/t2-document-share-pdf.png`, fullPage: true })
  })

  test('T3 design-system artifact → share-btn 点击路由到 exportZip(派生绝对路径)', async ({ page }) => {
    await setup(page)
    await emitArtifact(page, { id: 'ds-1', type: 'design-system', title: 'Wildcreek', content: JSON.stringify({ name: 'wildcreek' }) })

    const share = page.getByTestId('share-btn')
    await expect(share).toBeVisible({ timeout: 5000 })

    await share.click()
    await expect(page.getByTestId('dc-export-msg')).toContainText('已打包分享', { timeout: 5000 })

    const calls = await page.evaluate(() => (window as any).__mockCalls)
    const zip = calls.filter((c: any) => c.method === 'exportZip')
    expect(zip.length).toBe(1)
    // globalDir=/Users/tester/.openpipal/memory/global → base=/Users/tester/.openpipal
    expect(zip[0].sourceDir).toBe('/Users/tester/.openpipal/design-systems/wildcreek')
    expect(zip[0].outName).toBe('wildcreek')
    // design-system 未路由到 PDF
    expect(calls.filter((c: any) => c.method === 'exportArtifactPdf').length).toBe(0)

    await page.screenshot({ path: `${ARTIFACTS_DIR}/t3-design-system-share-zip.png`, fullPage: true })
  })

  test('T4 code artifact → share-btn 可见(源文件下载路由)', async ({ page }) => {
    await setup(page)
    await emitArtifact(page, { id: 'code-1', type: 'code', title: 'script.js', content: 'const x = 1', language: 'javascript' })

    // code 不在排除集 → share-btn 显示(点击走 Blob 源文件下载)
    await expect(page.getByTestId('share-btn')).toBeVisible({ timeout: 5000 })

    await page.screenshot({ path: `${ARTIFACTS_DIR}/t4-code-share.png`, fullPage: true })
  })

  test('T5 questions artifact → 无 share-btn(loop-break 类型无分享格式)', async ({ page }) => {
    await setup(page)
    await emitArtifact(page, {
      id: 'q-1',
      type: 'questions',
      title: '几个问题',
      content: JSON.stringify({ title: '几个问题', questions: [{ id: 'a', kind: 'freeform', title: 'x' }] })
    })

    // ArtifactTab 已挂载(questions 渲染分支),但 share-btn 不应出现
    await expect(page.getByTestId('share-btn')).toHaveCount(0)

    await page.screenshot({ path: `${ARTIFACTS_DIR}/t5-questions-no-share.png`, fullPage: true })
  })
})

/**
 * 自检实时画面卡 E2E —— 输入框上方的固定槽（对标官方 Claude Design 的
 * 「Checking the design for issues…」+ 设备外框）
 *
 * 覆盖：
 *   T1  render_artifact 开始 → 卡出现（转圈 + 文案 + 设备外框里的 iframe 装着当前产物）
 *   T2  自检结束 → 卡**不自动关闭**（这是需求，不是 bug），显示「渲染干净」
 *   T2b 自检发现问题 → 显示「发现 N 个问题」
 *   T2c 结论文本缺失 → 中性完成态（不误报通过/失败）
 *   T3  用户点 ✕ 才关；折叠只藏画面不关卡
 *   T4  本轮没碰产物（path 模式自检设计系统）→ 不弹卡
 *
 * 位置断言：卡必须排在 textarea（输入框）之前的兄弟节点里——它是钉在输入框上方的固定槽，
 * 不是对话流里的一条消息（流里的会滚走、流式结束就消失）。
 */

import { test, expect, Page } from '@playwright/test'
import { bootstrapChat } from './helpers'

test.use({ viewport: { width: 1200, height: 800 } })

const ARTIFACTS_DIR = 'tests/artifacts/self-check'

const MOCK_API = `
window.__mockBus = {
  listeners: {},
  on(event, fn) { (this.listeners[event] ||= []).push(fn); return () => {}; },
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
};
`

const PAGE_HTML = '<!DOCTYPE html><html><body><h1 style="font:700 64px system-ui">Kyro</h1></body></html>'

/** 会话里已有一条用户消息 + 一条带 artifactRef 的 create_artifact（= 本轮刚出了稿） */
async function setup(page: Page, opts: { withArtifact?: boolean } = {}): Promise<void> {
  const withArtifact = opts.withArtifact !== false
  await page.addInitScript({ content: MOCK_API })
  await page.goto('/')
  await page.waitForLoadState('networkidle')
  await bootstrapChat(page, {
    role: 'design',
    messages: [
      { id: 'u1', role: 'user', content: '做个落地页', timestamp: 1 },
      ...(withArtifact
        ? [{
            id: 't1', role: 'assistant', content: 'ok', timestamp: 2,
            toolName: 'create_artifact', toolCallId: 'c1',
            artifactRef: { id: 'art-1', type: 'html', title: 'Kyro 落地页', path: '/x/art-1.html' }
          }]
        : [])
    ]
  })
  if (withArtifact) {
    await page.evaluate((html) => {
      ;(window as any).__artifactStore.getState().addArtifact({
        id: 'art-1', type: 'html', title: 'Kyro 落地页', content: html, messageId: 't1', createdAt: Date.now()
      })
    }, PAGE_HTML)
  }
}

const startSelfCheck = (page: Page): Promise<void> =>
  page.evaluate(() => (window as any).__mockBus.emit('tool-start', '', 'render_artifact', 'call-check'))

/**
 * 自检结束。结论文本走 tool-end 的第 5 个形参（mcpResult 位）——main 侧 pi-event-adapter 的
 * 通用分支就是把内置工具的结果文本放这个位置发过来的（模型历史的单条结果上限对
 * render_artifact 不做压缩，原样透传）。
 */
const endSelfCheck = (page: Page, resultText?: string): Promise<void> =>
  page.evaluate(
    (text) => (window as any).__mockBus.emit('tool-end', '', 'render_artifact', undefined, undefined, text, undefined, undefined, 'call-check'),
    resultText
  )

test.describe('自检实时画面卡', () => {
  test('T1 自检开始 → 输入框上方出现画面卡（设备外框 + 当前产物）', async ({ page }) => {
    await setup(page)
    await startSelfCheck(page)

    const card = page.locator('[data-testid="self-check-preview"]')
    await expect(card).toBeVisible({ timeout: 5000 })
    await expect(card).toContainText('正在检查这一稿有没有问题')
    await expect(card).toContainText('Kyro 落地页')

    // 画面：iframe 按真机逻辑视口渲染再整体缩放（不是把 iframe 缩小成小尺寸）
    const frame = page.locator('[data-testid="self-check-frame"]')
    await expect(frame).toBeVisible()
    const box = await frame.evaluate((el) => ({ w: (el as HTMLElement).style.width, t: (el as HTMLElement).style.transform }))
    expect(box.w).toBe('1280px')
    expect(box.t).toContain('scale(')

    // 位置：卡在输入框之上（DOM 里排在 textarea 之前），不是对话流里的消息
    const order = await page.evaluate(() => {
      const c = document.querySelector('[data-testid="self-check-preview"]')!
      const ta = document.querySelector('textarea')!
      // eslint-disable-next-line no-bitwise
      return !!(c.compareDocumentPosition(ta) & Node.DOCUMENT_POSITION_FOLLOWING)
    })
    expect(order).toBe(true)

    await page.screenshot({ path: `${ARTIFACTS_DIR}/t1-running.png`, fullPage: true })
  })

  test('T2 自检结束（渲染干净）→ 卡不自动关闭，转完成态并显示真结论', async ({ page }) => {
    await setup(page)
    await startSelfCheck(page)
    await expect(page.locator('[data-testid="self-check-preview"]')).toBeVisible()

    await endSelfCheck(page, '渲染干净：无 console 错误、无未解析空穴。\n截图已存盘: /x/.self-check/art-1.png')
    const card = page.locator('[data-testid="self-check-preview"]')
    await expect(card).toBeVisible()                       // ← 需求：不自动关闭
    await expect(card).not.toContainText('正在检查')
    await expect(card).toContainText('渲染干净')
    await expect(card.getByTestId('self-check-success-icon')).toBeVisible()
    await expect(page.locator('[data-testid="self-check-frame"]')).toBeVisible()

    await page.screenshot({ path: `${ARTIFACTS_DIR}/t2-done.png`, fullPage: true })
  })

  test('T2b 自检发现问题 → 卡上出结论徽标（数量来自工具结果首行）', async ({ page }) => {
    await setup(page)
    await startSelfCheck(page)
    await endSelfCheck(page, '渲染发现 3 个问题（修完再交）：\n- TypeError: x is not a function\n- 文本重叠: .nav / .title')

    const card = page.locator('[data-testid="self-check-preview"]')
    await expect(card).toContainText('发现 3 个问题')
    await expect(card.getByTestId('self-check-issues-icon')).toBeVisible()
    await expect(page.locator('[data-testid="self-check-frame"]')).toBeVisible()

    await page.screenshot({ path: `${ARTIFACTS_DIR}/t2b-problems.png`, fullPage: true })
  })

  test('T2c 结论文本缺失（旧后端/插件端没带）→ 中性完成态，不误报通过或失败', async ({ page }) => {
    await setup(page)
    await startSelfCheck(page)
    await endSelfCheck(page)

    const card = page.locator('[data-testid="self-check-preview"]')
    await expect(card).toContainText('自检完成')
    await expect(card).not.toContainText('个问题')
    await expect(card.getByTestId('self-check-neutral-icon')).toBeVisible()
    await expect(card.getByTestId('self-check-success-icon')).toHaveCount(0)
  })

  test('T3 点电脑本身盖上/打开（无收起按钮）；点 ✕ 才关卡', async ({ page }) => {
    await setup(page)
    await startSelfCheck(page)
    await endSelfCheck(page)

    const card = page.locator('[data-testid="self-check-preview"]')
    const lid = page.locator('[data-testid="self-check-lid"]')

    // 盖上：画面收掉，但卡还在，且盖上的机身仍可点（不然打不开了）
    await lid.click()
    await expect(page.locator('[data-testid="self-check-frame"]')).toHaveCount(0)
    await expect(card).toBeVisible()
    await expect(lid).toBeVisible()
    await page.screenshot({ path: `${ARTIFACTS_DIR}/t3-lid-closed.png`, fullPage: true })

    // 再点一下打开
    await lid.click()
    await expect(page.locator('[data-testid="self-check-frame"]')).toBeVisible()

    // 关闭只剩 ✕
    await expect(page.locator('[data-testid="self-check-collapse"]')).toHaveCount(0)
    await page.locator('[data-testid="self-check-close"]').click()
    await expect(card).toHaveCount(0)
  })

  test('T4 本轮没碰产物（path 模式自检）→ 不弹卡', async ({ page }) => {
    await setup(page, { withArtifact: false })
    await startSelfCheck(page)
    await page.waitForTimeout(400)
    await expect(page.locator('[data-testid="self-check-preview"]')).toHaveCount(0)
  })
})

/**
 * DC artifact 流式增量渲染管线 —— 行为级回归锁
 *
 * 锁住 HtmlPreview.tsx 的流式路径（外壳建一次 + __dcUpdate 模板泵，不重载 iframe）：
 *   P1 <x-dc> 未到达的头部增量 → 600ms 照片模式，iframe 有内容
 *   P2 <x-dc> 到达后继续喂模板增量 → 最后一个增量文本应可见（中间 delta 不被吞）
 *      （2026-07-03 曾抓到 pump 误传 kind='template' 被 support.js 静默吞的真 bug，已修为 'html'）
 *   P3 外壳建立后向 iframe.contentWindow 写标记 → 喂增量 → 标记仍在
 *      （增量走 postMessage 泵而非 srcDoc 重建/iframe 重载）
 *   P4 streaming 置 false 收尾 → 终态 srcDoc 正常渲染出全文
 *
 * 驱动 seam：复用 dc-render.spec 的 mock 事件总线，走真实 chatStore.onArtifactDelta →
 *   artifactStore.startStreaming/updateStreaming → useArtifactWorkspaceBridge 自动开
 *   artifactId='streaming' tab → ArtifactTab（streaming=true）→ HtmlPreview。
 *   收尾发 'artifact' 事件 → finalizeStreaming（streaming=false）。
 *
 * 注意:iframe 内渲染需要网络(unpkg React 18.3.1),断网环境本测试会超时。
 */

import { test, expect, Page } from '@playwright/test'

test.use({ viewport: { width: 1200, height: 800 } })

// —— dc-render.spec 同款精简 window.api mock（现行有效模板）——
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
  exportDcArtifacts: async () => ({ ok: true, dir: '/x', files: [] }),
};
`

// 最小可行 dc 骨架（template-only，无逻辑类，规避流式 <script> 截断复杂度）。
//   - <head> 加一行 padding 注释：把 160 字符"头部指纹"完全压进这段稳定前缀，
//     确保各增量（同一文件的生长前缀）头部一致 → 外壳只建一次（不因指纹变化重建）。
//   - <x-dc> 前放一个 photo-head div：<x-dc> 未到达时照片模式能渲出可见内容。
//   - dc-body 里三段文本 SEG_ALPHA / SEG_BRAVO / SEG_CHARLIE 逐段增长，模拟 token 流。
const FINAL = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<!-- openpipal-dc-stream-pump-e2e padding line to push the 160-char head fingerprint entirely into this stable prefix so the shell builds exactly once ZZZZ -->
<script src="./support.js"></script>
</head>
<body>
<div data-testid="photo-head">HEAD_BEFORE_XDC</div>
<x-dc>
<div data-testid="dc-body" style="padding:24px;font-size:28px">SEG_ALPHA SEG_BRAVO SEG_CHARLIE</div>
</x-dc>
</body>
</html>`

// 生长前缀（模拟真实 token 流：同一文件逐段变长）
const P0 = FINAL.slice(0, FINAL.indexOf('<x-dc>'))                               // 无 <x-dc> —— 照片模式
const P1 = FINAL.slice(0, FINAL.indexOf('SEG_ALPHA') + 'SEG_ALPHA'.length)      // <x-dc> 到达 —— 建壳
const P2 = FINAL.slice(0, FINAL.indexOf('SEG_BRAVO') + 'SEG_BRAVO'.length)      // 泵增量
const P3 = FINAL                                                                 // 泵增量（含 </x-dc>）

const DC_IFRAME = 'iframe[sandbox="allow-scripts allow-modals allow-downloads"]'
const ART_ID = 'dc-stream'

async function setup(page: Page): Promise<void> {
  await page.addInitScript({ content: MOCK_API })
  await page.goto('/')
  await page.waitForLoadState('networkidle')
  await page.evaluate(() => {
    ;(window as any).__chatStore?.setState?.({ activeConversationId: 'mock-conv' })
  })
}

// 一个 artifact-delta 事件 = 一个"token 流快照"。首个 delta 触发 startStreaming（其 content
// 被丢弃，只建流式 tab），故所有测试首段都 emit 两次把内容真正写进 store。cid='' 绕过会话守卫。
async function delta(page: Page, content: string): Promise<void> {
  await page.evaluate(
    ({ content, id }) =>
      (window as any).__mockBus.emit('artifact-delta', '', { id, artifactType: 'html', title: 'Stream.dc.html', delta: content, offset: 0 }),
    { content, id: ART_ID }
  )
}

// 收尾：'artifact' 完成事件 → finalizeStreaming（streaming=false）
async function finalize(page: Page, content: string): Promise<void> {
  await page.evaluate(
    ({ content, id }) => (window as any).__mockBus.emit('artifact', '', { id, type: 'html', title: 'Stream.dc.html', content }),
    { content, id: ART_ID }
  )
}

const frameEl = (page: Page) => page.frames().find((f) => f !== page.mainFrame())

test.describe('DC 流式增量渲染管线', () => {
  test('P1 头部增量(无 <x-dc>) → 照片模式活着，iframe 有内容', async ({ page }) => {
    await setup(page)
    await delta(page, P0) // startStreaming（内容丢弃）
    await delta(page, P0) // 照片模式内容

    await expect(page.locator(DC_IFRAME).first()).toBeVisible({ timeout: 8000 })
    const frame = page.frameLocator(DC_IFRAME)
    // 照片模式把 P0 直写 srcdoc —— <x-dc> 前的可见内容渲出
    await expect(frame.locator('[data-testid="photo-head"]')).toBeVisible({ timeout: 8000 })
    await expect(frame.locator('[data-testid="photo-head"]')).toHaveText('HEAD_BEFORE_XDC')
  })

  // 历史 bug 回归锁（2026-07-03 发现并修复）：pump 曾用 __dcUpdate(name,'template',...)，
  // 而 support.js dcUpdate 只认 kind ∈ {'html','js','props'} → 增量被静默吞，
  // #dc-root 冻结在建壳快照直到流结束。修复 = HtmlPreview BRIDGE 改传 'html'。
  test('P2 <x-dc> 后喂 2 个模板增量 → 最后一个增量文本应可见（中间 delta 不被吞）', async ({ page }) => {
    await setup(page)
    await delta(page, P0)
    await delta(page, P0)
    await expect(page.locator(DC_IFRAME).first()).toBeVisible({ timeout: 8000 })

    await delta(page, P1) // 建壳（模板快照 = SEG_ALPHA）
    const frame = page.frameLocator(DC_IFRAME)
    await expect(frame.locator('#dc-root')).toBeVisible({ timeout: 20000 })
    await expect(frame.locator('#dc-root')).toContainText('SEG_ALPHA', { timeout: 20000 })

    await delta(page, P2) // 泵增量
    await delta(page, P3) // 泵增量（含最后一段 + </x-dc>）

    // 应能看到最后一个增量文本（两级节流 200/600ms，用 poll 而非固定 sleep）。
    await expect(frame.locator('#dc-root')).toContainText('SEG_CHARLIE', { timeout: 5000 })
  })

  test('P3 外壳建立后 contentWindow 标记存活 → 增量走 postMessage 泵而非 iframe 重载', async ({ page }) => {
    await setup(page)
    await delta(page, P0)
    await delta(page, P0)
    await expect(page.locator(DC_IFRAME).first()).toBeVisible({ timeout: 8000 })

    await delta(page, P1) // 建壳
    const frame = page.frameLocator(DC_IFRAME)
    await expect(frame.locator('#dc-root')).toContainText('SEG_ALPHA', { timeout: 20000 })

    // 在 iframe 里打标记——若后续 srcDoc 被重建，iframe 重载，标记随 contentWindow 丢失
    await frameEl(page)!.evaluate(() => ((window as any).__pump_marker = 'alive'))

    await delta(page, P2) // 泵增量
    await delta(page, P3) // 泵增量
    await page.waitForTimeout(800) // 过两次 200ms 泵节流 + 缓冲

    // 标记仍在 → 外壳未重建、iframe 未重载 → 增量确实走 postMessage 泵（而非整页 srcDoc 重写）
    const marker = await frameEl(page)!.evaluate(() => (window as any).__pump_marker)
    expect(marker).toBe('alive')
    // #dc-root 仍在（未被重建擦除）。'SEG_ALPHA' 无论 bug 是否修好都成立（全文亦含此段），
    // 故本用例是纯"免重载"不变量锁，独立于 P2 的增量泵 bug。
    await expect(frame.locator('#dc-root')).toContainText('SEG_ALPHA')
  })

  test('P4 streaming 置 false 收尾 → 终态 srcDoc 正常渲染全文', async ({ page }) => {
    await setup(page)
    await delta(page, P0)
    await delta(page, P0)
    await expect(page.locator(DC_IFRAME).first()).toBeVisible({ timeout: 8000 })

    await delta(page, P1)
    await delta(page, P2)
    await delta(page, P3)

    // 收尾：finalizeStreaming → 流式 tab 关闭、真实 artifact tab 打开（streaming=false）
    await finalize(page, FINAL)
    await page.waitForTimeout(800) // tab 切换与 srcDoc 挂载

    // 终态整页 srcDoc 渲染 —— 全文（含最后一段）可见
    const frame = page.frameLocator(DC_IFRAME).last()
    await expect(frame.locator('#dc-root')).toBeVisible({ timeout: 20000 })
    await expect(frame.locator('#dc-root')).toContainText('SEG_CHARLIE', { timeout: 20000 })
    await expect(frame.locator('#dc-root')).toContainText('SEG_ALPHA')
  })
})

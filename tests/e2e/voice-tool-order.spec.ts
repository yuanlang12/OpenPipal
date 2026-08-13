import { test, expect, Page } from '@playwright/test'

const ARTIFACTS_DIR = 'tests/artifacts/voice-tool-order'

/**
 * 语音流工具卡顺序 — 工具卡必须排在已渲染的 AI 语音转录之后，不能冒到对话最上面
 *
 * 复现的 bug：
 * - onToolStart 把工具锚点插在「最近一条 user 消息」之后（文字模式正确，因为助手回复还在 streamBuf 没落库）
 * - 语音模式下 assistant 转录已通过 upsertVoiceMessage append 到 messages[] 末尾
 * - 于是工具被插到 user 之后、assistant 转录之前 → 工具卡冒到语音流最上面
 *
 * 修复：onToolStart 检测「user 之后已有 voice 消息」时，把工具锚点 append 到末尾（语音流顺序）
 */
const MOCK_API = `
window.__mockBus = {
  listeners: {},
  on(event, fn) {
    if (!this.listeners[event]) this.listeners[event] = [];
    this.listeners[event].push(fn);
    return () => { this.listeners[event] = this.listeners[event].filter(f => f !== fn); };
  },
  emit(event, ...args) {
    (this.listeners[event] || []).forEach(fn => fn(...args));
  }
};
window.api = {
  sendChat: () => {},
  abortChat: () => {},
  onStreamChunk: (cb) => window.__mockBus.on('stream-chunk', cb),
  onStreamEnd: (cb) => window.__mockBus.on('stream-end', cb),
  onTextFlush: (cb) => window.__mockBus.on('text-flush', cb),
  onToolStart: (cb) => window.__mockBus.on('tool-start', cb),
  onToolEnd: (cb) => window.__mockBus.on('tool-end', cb),
  onAskUser: (cb) => window.__mockBus.on('ask-user', cb),
  onTargetStatus: (cb) => window.__mockBus.on('target-status', cb),
  onAppChanged: (cb) => window.__mockBus.on('app-changed', cb),
  pasteToTarget: async () => ({ success: true }),
  getRoleInitState: async () => ({ hasRole: true, role: { name: 'learner', displayName: '学习助手', icon: '📖' } }),
  getAllRoles: async () => [{ name: 'learner', displayName: '学习助手', icon: '📖' }],
  getCurrentRole: async () => ({ name: 'learner', displayName: '学习助手', icon: '📖' }),
  switchRole: async () => ({ name: 'learner', displayName: '学习助手', icon: '📖' }),
  listConversations: async () => [],
  createConversation: async (role) => ({ id: 'conv-test', title: '语音测试', role, createdAt: Date.now(), updatedAt: Date.now(), messageCount: 0 }),
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
  getRealtimeConfig: async () => ({ provider: 'openai', url: '', model: '', deployment: '', apiVersion: '', voice: 'alloy', hasKey: true }),
  startRealtime: async () => ({ success: false }),
  stopRealtime: () => {},
  sendRealtimeEvent: () => {},
  onRealtimeEvent: () => () => {},
  onRealtimeState: () => () => {}
};
`

async function setup(page: Page): Promise<void> {
  await page.addInitScript({ content: MOCK_API })
  await page.goto('/')
  await page.waitForLoadState('networkidle')
  await page.waitForSelector('textarea', { timeout: 10000 })
  await page.evaluate(async () => {
    const store = (window as any).__chatStore
    await store.getState().newConversation('learner')
  })
}

// 给 chat 面板足够空间
test.use({ viewport: { width: 1000, height: 700 } })

test.describe('语音流工具卡顺序', () => {
  test('工具卡 append 在 AI 语音转录之后（不冒到最上面）', async ({ page }) => {
    await setup(page)

    // 语音流：用户问 → AI 开口转录(已落库到末尾) → AI 调工具
    await page.evaluate(() => {
      const store = (window as any).__chatStore
      const upsert = store.getState().upsertVoiceMessage
      upsert('u1', 'user', '帮我查 SF 天气', true)
      upsert('a1', 'assistant', '好的，我查一下', false)
      // AI 在说话过程中触发工具调用（main 的 emitToolArtifactToChat 走 chat:tool-start）
      window.__mockBus.emit('tool-start', '', 'web_search')
    })

    const order = await page.evaluate(() => {
      return (window as any).__chatStore.getState().messages.map((m: any) => ({
        role: m.role,
        kind: m.messageKind,
        tool: m.toolName,
        vid: m.voiceItemId
      }))
    })

    // 期望顺序：user(u1) → assistant 转录(a1) → 工具卡
    // bug 时会是：user(u1) → 工具卡 → assistant 转录(a1)
    expect(order).toHaveLength(3)
    expect(order[0]).toMatchObject({ role: 'user', vid: 'u1' })
    expect(order[1]).toMatchObject({ role: 'assistant', vid: 'a1' })
    expect(order[2]).toMatchObject({ kind: 'tool', tool: 'web_search' })

    // tool-end 带结果 → 工具卡渲染，且仍在转录之后
    await page.evaluate(() => {
      window.__mockBus.emit('tool-end', '', 'web_search', undefined, undefined, 'SF 今天 64°F 晴', undefined, undefined)
    })

    const finalOrder = await page.evaluate(() => {
      return (window as any).__chatStore.getState().messages.map((m: any) => ({
        role: m.role, kind: m.messageKind, tool: m.toolName, vid: m.voiceItemId
      }))
    })
    expect(finalOrder[finalOrder.length - 1]).toMatchObject({ kind: 'tool', tool: 'web_search' })
    expect(finalOrder.find((m: any) => m.vid === 'a1')).toBeTruthy()
    // 转录索引必须小于工具卡索引
    const aIdx = finalOrder.findIndex((m: any) => m.vid === 'a1')
    const tIdx = finalOrder.findIndex((m: any) => m.kind === 'tool')
    expect(aIdx).toBeLessThan(tIdx)

    await page.screenshot({ path: `${ARTIFACTS_DIR}/tool-after-transcript.png` })
    console.log('[voice-tool-order] 工具卡排在 AI 转录之后 - 通过')
  })

  test('AI 工具后继续说话：转录追加在工具卡之后', async ({ page }) => {
    await setup(page)

    await page.evaluate(() => {
      const store = (window as any).__chatStore
      const upsert = store.getState().upsertVoiceMessage
      upsert('u1', 'user', '今天能出门吗', true)
      upsert('a1', 'assistant', '我查下天气', true)
      window.__mockBus.emit('tool-start', '', 'web_search')
      window.__mockBus.emit('tool-end', '', 'web_search', undefined, undefined, '晴天', undefined, undefined)
      // 工具结果回流 → AI 用新 item 继续说（response.create 产生新 item）
      upsert('a2', 'assistant', '今天晴天，适合出门', true)
    })

    const order = await page.evaluate(() => {
      return (window as any).__chatStore.getState().messages.map((m: any) => ({
        role: m.role, kind: m.messageKind, tool: m.toolName, vid: m.voiceItemId
      }))
    })

    // 期望：user(u1) → a1 → 工具卡 → a2
    const idxU1 = order.findIndex((m: any) => m.vid === 'u1')
    const idxA1 = order.findIndex((m: any) => m.vid === 'a1')
    const idxTool = order.findIndex((m: any) => m.kind === 'tool')
    const idxA2 = order.findIndex((m: any) => m.vid === 'a2')
    expect(idxU1).toBeLessThan(idxA1)
    expect(idxA1).toBeLessThan(idxTool)
    expect(idxTool).toBeLessThan(idxA2)

    await page.screenshot({ path: `${ARTIFACTS_DIR}/tool-then-more-speech.png` })
    console.log('[voice-tool-order] 工具后继续说话顺序正确 - 通过')
  })

  // ── 视图层(groupTurns/ChatPanel)回归 ──
  // 数据数组顺序对不代表渲染对:旧 ChatPanel 把所有 process 折叠组渲染在所有 final 之前,
  // 工具卡(已处理 X)会冒到语音流最上面。这条按 DOM 垂直坐标断言「说话→工具→说话」保序。
  test('DOM 顺序:工具卡(已处理)夹在两条 AI 语音之间,不冒到最上面', async ({ page }) => {
    await setup(page)

    await page.evaluate(() => {
      const store = (window as any).__chatStore
      const upsert = store.getState().upsertVoiceMessage
      upsert('u1', 'user', '查一下 Claude 最新动态', true)
      upsert('a1', 'assistant', '好，我来帮你理一下关于最新动态的资讯', true)
      window.__mockBus.emit('tool-start', '', 'web_search')
      window.__mockBus.emit('tool-end', '', 'web_search', undefined, undefined, '检索受限,无有效结果', undefined, undefined)
      upsert('a2', 'assistant', '我这边没能直接搜到有效结果,你可以看官方博客', true)
    })

    // 等三段都渲染出来
    await expect(page.locator('text=好，我来帮你理一下关于最新动态的资讯')).toBeVisible({ timeout: 3000 })
    await expect(page.locator('[data-testid="process-group"]')).toBeVisible()
    await expect(page.locator('text=我这边没能直接搜到有效结果')).toBeVisible()

    // 按 DOM 垂直坐标取三者的 top
    const tops = await page.evaluate(() => {
      const topOf = (sel: string) =>
        (document.querySelector(sel) as HTMLElement | null)?.getBoundingClientRect().top ?? -1
      const byText = (txt: string) => {
        const all = Array.from(document.querySelectorAll('*')) as HTMLElement[]
        const el = all.find(e => e.children.length === 0 && e.textContent?.includes(txt))
        return el ? el.getBoundingClientRect().top : -1
      }
      return {
        a1: byText('好，我来帮你理一下关于最新动态的资讯'),
        proc: topOf('[data-testid="process-group"]'),
        a2: byText('我这边没能直接搜到有效结果')
      }
    })

    expect(tops.a1).toBeGreaterThan(0)
    expect(tops.proc).toBeGreaterThan(0)
    expect(tops.a2).toBeGreaterThan(0)
    // 关键:AI 第一句 在 工具卡 之上,工具卡 在 AI 第二句 之上
    expect(tops.a1).toBeLessThan(tops.proc)
    expect(tops.proc).toBeLessThan(tops.a2)

    await page.screenshot({ path: `${ARTIFACTS_DIR}/dom-order-interleaved.png` })
    console.log('[voice-tool-order] DOM 顺序 说话→工具→说话 - 通过')
  })
})

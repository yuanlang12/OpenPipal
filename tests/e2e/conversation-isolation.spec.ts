import { test, expect, Page } from '@playwright/test'

const ARTIFACTS_DIR = 'tests/artifacts/conversation-isolation'

/**
 * 会话隔离:regenerate/editAndResend 必须带发起会话 id,流事件不得溢出到新会话。
 *
 * bug(已修):beginStream 对 regenerate/editAndResend 传 sendCid=false → 主进程 `cid = conversationId || ''`
 * 发空 cid → 渲染层 `if (cid && cid !== active) return` 守卫被空串短路(cid='' 时 `cid &&` 为假)→
 * 事件被当成"当前会话"渲染。用户在 A 触发重试(空 cid 流)未结束就新建会话切到 B → A 流的尾巴
 * (文字/工具卡/[Error] stream-end)溢出到 B 的视图。
 *
 * 修复:beginStream 始终把 activeConversationId 作 sendChat 第 4 参 → 事件带真 cid=A → 守卫按 cid
 * 隔离(A≠B → 存 bgStreamBufs 不上屏)。cid 非空时 `!cid || cid===active` 恒按真实归属判,故即便
 * StrictMode 重复注册处理器也稳(不依赖会被清空的 streamingCid)。
 */
const MOCK_API = `
window.__sendChatArgs = [];
window.__mockBus = { listeners:{}, on(e,fn){(this.listeners[e]=this.listeners[e]||[]).push(fn);return ()=>{};}, emit(e,...a){(this.listeners[e]||[]).forEach(fn=>fn(...a));} };
let __cid = 0;
window.api = {
  sendChat: (...args) => { window.__sendChatArgs.push(args); },
  abortChat: () => {}, hasApiKey: async () => ({ hasKey: true }),
  onStreamChunk: (cb) => window.__mockBus.on('stream-chunk', cb),
  onStreamEnd: (cb) => window.__mockBus.on('stream-end', cb),
  onTextFlush: (cb) => window.__mockBus.on('text-flush', cb),
  onThinking: (cb) => window.__mockBus.on('thinking', cb),
  onThinkingEnd: (cb) => window.__mockBus.on('thinking-end', cb),
  onToolStart: (cb) => window.__mockBus.on('tool-start', cb),
  onToolProgress: (cb) => window.__mockBus.on('tool-progress', cb),
  onToolEnd: (cb) => window.__mockBus.on('tool-end', cb),
  onAskUser: (cb) => window.__mockBus.on('ask-user', cb),
  onTargetStatus: () => () => {}, onAppChanged: () => () => {},
  getRoleInitState: async () => ({ hasRole: true, role: { name:'learner', displayName:'学习助手', icon:'📖' } }),
  getAllRoles: async () => [{ name:'learner', displayName:'学习助手', icon:'📖' }],
  getCurrentRole: async () => ({ name:'learner', displayName:'学习助手', icon:'📖' }),
  switchRole: async () => ({ name:'learner', displayName:'学习助手', icon:'📖' }),
  listConversations: async () => [],
  createConversation: async (role) => { __cid++; return { id:'conv-'+__cid, title:'会话'+__cid, role, createdAt:Date.now(), updatedAt:Date.now(), messageCount:0 }; },
  getConversationMessages: async () => [], replaceMessages: async () => {}, appendMessages: async () => {}, deleteConversation: async () => {},
  getAppSettings: async () => ({ detected:[], disabled:[], browsers:[] }), setDisabledApps: async () => {},
  isCustomConfig: async () => ({ isCustom:false }), getAvailableModels: async () => [],
  getModelConfig: async () => ({ provider:'openai', baseUrl:'', apiKey:'', model:'' }),
  getModelConfigFull: async () => ({ provider:'openai', baseUrl:'', apiKey:'', model:'' }),
  saveModelConfig: async () => {}, testConnection: async () => ({ ok:true }), getProviders: async () => ({}), clearModelConfig: async () => {},
  getRealtimeConfig: async () => ({ provider:'openai', url:'', model:'', deployment:'', apiVersion:'', voice:'alloy', hasKey:false }),
  startRealtime: async () => ({ success:false }), stopRealtime: () => {}, sendRealtimeEvent: () => {}, onRealtimeEvent: () => () => {}, onRealtimeState: () => () => {}
};
`

async function setup(page: Page): Promise<void> {
  await page.addInitScript({ content: MOCK_API })
  await page.goto('/')
  await page.waitForLoadState('networkidle')
  await page.waitForSelector('textarea', { timeout: 10000 })
}

test.use({ viewport: { width: 1000, height: 760 } })

test.describe('会话隔离:重试流不溢出到新会话', () => {
  test('regenerate 带发起会话 id → 切到新会话 B → A 的流事件不进 B', async ({ page }) => {
    await setup(page)

    // 1. 建会话 A + 造一轮 [user, assistant]（regenerate 需要有可重来的一轮）
    const aId = await page.evaluate(async () => {
      const store = (window as any).__chatStore
      await store.getState().newConversation('learner')
      const a = store.getState().activeConversationId
      store.setState({ messages: [
        { id:'u1', role:'user', content:'原问题', timestamp:Date.now(), messageKind:'user' },
        { id:'a1', role:'assistant', content:'旧回答', timestamp:Date.now()+1, messageKind:'assistant' }
      ]})
      return a
    })
    expect(aId).toBeTruthy()

    // 2. 核心 fix 断言:regenerate 现在把 A 的 conversationId 作 sendChat 第 4 参(旧实现传 undefined)
    const cidArg = await page.evaluate(() => {
      ;(window as any).__sendChatArgs.length = 0
      ;(window as any).__chatStore.getState().regenerate()
      const calls = (window as any).__sendChatArgs
      const last = calls[calls.length - 1]
      return last ? last[3] : '__none__'
    })
    expect(cidArg).toBe(aId)

    // 3. 用户切到新会话 B（A 的流仍在跑）
    const bId = await page.evaluate(async () => {
      const store = (window as any).__chatStore
      await store.getState().newConversation('learner')
      return store.getState().activeConversationId
    })
    expect(bId).not.toBe(aId)

    // 4. A 的流继续吐(带真 cid=A)+ 报错收尾 —— 应被隔离,不进 B
    await page.evaluate((a) => {
      window.__mockBus.emit('stream-chunk', a, '★LEAKED★ A 会话输出')
      window.__mockBus.emit('tool-start', a, 'render_artifact')
      window.__mockBus.emit('stream-end', a, 'Premature close')
    }, aId)

    // 5. 断言:B 的消息与 DOM 都没有 A 的溢出内容
    const b = await page.evaluate(() => {
      const store = (window as any).__chatStore
      return {
        active: store.getState().activeConversationId,
        msgs: JSON.stringify(store.getState().messages),
        body: document.body.innerText
      }
    })
    expect(b.active).toBe(bId)
    expect(b.msgs).not.toContain('★LEAKED★')
    expect(b.msgs).not.toContain('Premature close')
    expect(b.msgs).not.toContain('render_artifact')
    expect(b.body).not.toContain('★LEAKED★')
    expect(b.body).not.toContain('Premature close')

    await page.screenshot({ path: `${ARTIFACTS_DIR}/no-leak-to-new-conv.png` })
    console.log('[conversation-isolation] 重试流带真 cid、未溢出到新会话 - 通过')
  })
})

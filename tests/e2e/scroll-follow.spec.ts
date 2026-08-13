import { test, expect, Page } from '@playwright/test'

/**
 * 生成中可上滑查看历史（不被强制拽回底部）+ "跳到最新"提示。
 * 旧 bug：ChatPanel 的 messages effect 每次追加消息都 reset userScrolledUp + 强制贴底 → 生成中无法上滑。
 * 修复：仅当用户没上滑时才贴底；用户上滑 → 显示 data-testid="jump-to-latest"，点击回到最新。
 */
const MOCK_API = `
window.__mockBus = { listeners:{}, on(){return ()=>{};}, emit(){} };
window.api = {
  sendChat: () => {}, abortChat: () => {}, hasApiKey: async () => ({ hasKey: true }),
  onStreamChunk:()=>()=>{}, onStreamEnd:()=>()=>{}, onTextFlush:()=>()=>{}, onThinking:()=>()=>{},
  onThinkingEnd:()=>()=>{}, onToolStart:()=>()=>{}, onToolProgress:()=>()=>{}, onToolEnd:()=>()=>{},
  onAskUser:()=>()=>{}, onTargetStatus:()=>()=>{}, onAppChanged:()=>()=>{},
  getRoleInitState: async () => ({ hasRole:true, role:{ name:'learner', displayName:'学习助手', icon:'📖' } }),
  getAllRoles: async () => [{ name:'learner', displayName:'学习助手', icon:'📖' }],
  getCurrentRole: async () => ({ name:'learner', displayName:'学习助手', icon:'📖' }),
  switchRole: async () => ({ name:'learner', displayName:'学习助手', icon:'📖' }),
  listConversations: async () => [], createConversation: async (role) => ({ id:'conv-scroll', title:'t', role, createdAt:1, updatedAt:2, messageCount:0 }),
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

function seed(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    id: 'm' + i, role: i % 2 ? 'assistant' : 'user',
    content: '这是第 ' + i + ' 条消息，内容要足够多才能撑出滚动高度。'.repeat(3),
    timestamp: Date.now() + i, messageKind: i % 2 ? 'assistant' : 'user'
  }))
}

async function setup(page: Page): Promise<void> {
  await page.addInitScript({ content: MOCK_API })
  await page.goto('/')
  await page.waitForLoadState('networkidle')
  await page.waitForSelector('textarea', { timeout: 10000 })
}

test.use({ viewport: { width: 900, height: 600 } })

test.describe('生成中可上滑 + 跳到最新', () => {
  test('上滑后追加消息不被强制贴底，pill 出现，点击回到最新', async ({ page }) => {
    await setup(page)
    // 建会话 + 塞满消息撑出滚动
    await page.evaluate(async (msgs) => {
      const store = (window as any).__chatStore
      await store.getState().newConversation('learner')
      store.setState({ messages: msgs, isStreaming: true })
    }, seed(40))
    const scroller = page.locator('[data-testid="chat-scroll"]')
    await expect(scroller).toBeVisible()

    // 上滑到顶部
    await scroller.evaluate((el) => { el.scrollTop = 0; el.dispatchEvent(new Event('scroll')) })
    await page.waitForTimeout(100)
    // pill 出现（用户脱离贴底）
    await expect(page.locator('[data-testid="jump-to-latest"]')).toBeVisible()

    const topBefore = await scroller.evaluate((el) => el.scrollTop)
    // 模拟生成中追加一条消息（旧 bug 会在此把用户拽回底部）
    await page.evaluate(() => {
      const store = (window as any).__chatStore
      const msgs = store.getState().messages
      store.setState({ messages: [...msgs, { id: 'new', role: 'assistant', content: '刚生成的新内容', timestamp: Date.now(), messageKind: 'assistant' }] })
    })
    await page.waitForTimeout(120)
    const topAfter = await scroller.evaluate((el) => el.scrollTop)
    // 关键断言：追加消息后仍停在上方（没被强制贴底）
    expect(Math.abs(topAfter - topBefore)).toBeLessThan(40)

    // 点 pill → 回到最新（贴底）
    await page.locator('[data-testid="jump-to-latest"]').click()
    await page.waitForTimeout(120)
    const atBottom = await scroller.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight < 60)
    expect(atBottom).toBe(true)
    await expect(page.locator('[data-testid="jump-to-latest"]')).toHaveCount(0)
  })
})

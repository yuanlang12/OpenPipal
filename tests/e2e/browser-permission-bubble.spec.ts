import { test, expect, Page } from '@playwright/test'

/**
 * 浏览器写操作确认气泡(Problem 2 自主验证)——文字模式下:
 *  - 内联权限气泡(browser_navigate)能渲染、可见、不被祖先 overflow 裁剪(CLAUDE.md「看不见先查 DOM clipping」)
 *  - 「本次会话允许此类操作」按钮可点,并以 (requestId, true, sessionApprove=true) 回传
 * 不需要真实 main 进程 / 真扩展;用 mock window.api + 直接注入 permission_request 消息。
 */
const MOCK_API = `
window.__mockBus = { listeners:{}, on(e,f){ (this.listeners[e]=this.listeners[e]||[]).push(f); return ()=>{}; }, emit(e,...a){ (this.listeners[e]||[]).forEach(f=>f(...a)); } };
window.__mockCalls = [];
window.api = {
  getLocaleState: async () => ({ preference: 'zh-CN', locale: 'zh-CN' }),
  sendChat: (...args)=>{ window.__mockCalls.push({method:'sendChat',args}); },
  abortChat: ()=>{}, steerChat: async()=>({ok:true}), queueChat: async()=>({ok:true}),
  respondPermissionInline: (...args)=>{ window.__mockCalls.push({method:'respondPermissionInline',args}); },
  respondPermission: ()=>{},
  onStreamChunk:(cb)=>window.__mockBus.on('stream-chunk',cb), onStreamEnd:(cb)=>window.__mockBus.on('stream-end',cb),
  onTextFlush:(cb)=>window.__mockBus.on('text-flush',cb), onThinking:(cb)=>window.__mockBus.on('thinking',cb),
  onThinkingEnd:(cb)=>window.__mockBus.on('thinking-end',cb), onToolStart:(cb)=>window.__mockBus.on('tool-start',cb),
  onToolProgress:(cb)=>window.__mockBus.on('tool-progress',cb), onToolEnd:(cb)=>window.__mockBus.on('tool-end',cb),
  onAskUser:(cb)=>window.__mockBus.on('ask-user',cb), onQuestionsV2:(cb)=>window.__mockBus.on('questions-v2',cb),
  onArtifact:(cb)=>window.__mockBus.on('artifact',cb), onArtifactDelta:(cb)=>window.__mockBus.on('artifact-delta',cb),
  onVisualizer:(cb)=>window.__mockBus.on('visualizer',cb), onVisualizerDelta:(cb)=>window.__mockBus.on('visualizer-delta',cb),
  onMcpAppInline:(cb)=>window.__mockBus.on('mcp-app-inline',cb), onTargetStatus:(cb)=>window.__mockBus.on('target-status',cb),
  onAppChanged:(cb)=>window.__mockBus.on('app-changed',cb), onMemoryUpdated:(cb)=>window.__mockBus.on('memory-updated',cb),
  onConvTitleUpdated:(cb)=>window.__mockBus.on('conv-title-updated',cb),
  onInlinePermission:(cb)=>window.__mockBus.on('inline-permission',cb), onPermissionRequest:(cb)=>window.__mockBus.on('permission-request',cb),
  pasteToTarget: async()=>({success:true}), hasApiKey: async()=>({hasKey:true}),
  getRoleInitState: async()=>({hasRole:true, role:{name:'learner',displayName:'学习助手',icon:'📖'}}),
  getAllRoles: async()=>[{name:'learner',displayName:'学习助手',icon:'📖'}],
  getCurrentRole: async()=>({name:'learner',displayName:'学习助手',icon:'📖'}),
  switchRole: async()=>({name:'learner',displayName:'学习助手',icon:'📖'}),
  listConversations: async()=>[], createConversation: async(role)=>({id:'conv-perm',title:'Perm',role,createdAt:Date.now(),updatedAt:Date.now(),messageCount:0}),
  getConversationMessages: async()=>[], replaceMessages: async()=>{}, appendMessages: async()=>{}, deleteConversation: async()=>{},
  getAppSettings: async()=>({detected:[],disabled:[],browsers:[]}), setDisabledApps: async()=>{}, isCustomConfig: async()=>({isCustom:false}),
  getAvailableModels: async()=>[], getModelConfig: async()=>({provider:'openai',baseUrl:'',apiKey:'',model:''}),
  getModelConfigFull: async()=>({provider:'openai',baseUrl:'',apiKey:'',model:''}), saveModelConfig: async()=>{},
  testConnection: async()=>({ok:true,model:'gpt-4o'}), getProviders: async()=>({}), clearModelConfig: async()=>{},
  listSkills: async()=>[], listWorkspaces: async()=>[], listAgentTemplates: async()=>[],
  getOnboardingStatus: async()=>({completed:true}), setOnboardingCompleted: async()=>{},
  getRealtimeConfig: async()=>({provider:'openai',url:'',model:'',deployment:'',apiVersion:'',voice:'alloy',hasKey:false}),
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
    store.setState({ messages: [{ id: 'init', role: 'user', content: 'hi', timestamp: Date.now() }] })
  })
}

test.use({ viewport: { width: 600, height: 700 } })

test('browser_navigate 确认气泡:可见、不被裁剪、「本次会话允许」回传 (requestId,true,true)', async ({ page }) => {
  await setup(page)
  await page.evaluate(() => {
    const store = (window as any).__chatStore
    const msgs = store.getState().messages
    store.setState({
      messages: [...msgs, {
        id: 'perm-bc-1', role: 'assistant', content: '请求执行操作：browser_navigate',
        messageKind: 'permission_request',
        permissionRequest: {
          requestId: 'req-bc-1', tool: 'browser_navigate',
          args: { url: 'https://example.com' }, risk: 'needs_confirmation',
          reason: '浏览器操作 browser_navigate @ example.com'
        },
        permissionStatus: 'pending', timestamp: Date.now()
      }]
    })
  })

  // 1) 气泡可见(header「需要确认」+ reason 原文 + 三个按钮)
  await expect(page.getByText('需要确认', { exact: false }).first()).toBeVisible()
  await expect(page.getByText('浏览器操作 browser_navigate @ example.com')).toBeVisible()
  await expect(page.getByRole('button', { name: '拒绝' })).toBeVisible()
  await expect(page.getByRole('button', { name: '允许', exact: true })).toBeVisible()
  const allowSession = page.getByRole('button', { name: '本次会话允许此类操作' })
  await expect(allowSession).toBeVisible()

  // 2) 不被裁剪:按钮 boundingBox 落在 viewport 内
  const box = await allowSession.boundingBox()
  expect(box).not.toBeNull()
  expect(box!.y).toBeGreaterThanOrEqual(0)
  expect(box!.y + box!.height).toBeLessThanOrEqual(700)
  expect(box!.x).toBeGreaterThanOrEqual(0)

  // 3) 点「本次会话允许」→ 用户可见结果:气泡转「已允许执行」+ store 状态 approved + 回传 sessionApprove=true
  await page.evaluate(() => { (window as any).__mockCalls = [] })
  await allowSession.click()
  // approved 后该消息按设计折进过程组(groupTurns:已 approved/denied 的 permission 视为已解决,
  // 折叠进 ProcessGroup)——「已允许执行」不再直接常显,先展开过程组再断言可见
  await page.locator('[data-testid="process-group-toggle"]').first().click()
  await expect(page.getByText('已允许执行')).toBeVisible()
  const after = await page.evaluate(() => {
    const m = (window as any).__chatStore.getState().messages.find((x: any) => x.id === 'perm-bc-1')
    const calls = (window as any).__mockCalls.filter((c: any) => c.method === 'respondPermissionInline')
    return { status: m?.permissionStatus, calls }
  })
  expect(after.status).toBe('approved')
  // 回传给 main 的应带 sessionApprove=true(按站点授权 → 同站点本对话不再问)
  expect(after.calls.length).toBeGreaterThanOrEqual(1)
  expect(after.calls[0].args[0]).toBe('req-bc-1')
  expect(after.calls[0].args[2]).toBe(true)
})

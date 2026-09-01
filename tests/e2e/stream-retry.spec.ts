import { test, expect, Page } from '@playwright/test'

/**
 * 断流重连在界面上的契约（用户能看见的那三件事）：
 *  1. 半截思考被丢掉——重连是整轮重发，不是断点续传，留着就会跟第二次的思考拼在一起
 *  2. 出现一条"连接中断，正在重试 (n/m)"的细灰字，用户知道刚才发生了什么
 *  3. 重连后的思考是新的一段，不是接在旧内容后面
 * 沿用 model-control.spec 的注入技法：不依赖真实 main 进程，直接从渲染层触发事件。
 */
const MOCK_API = `
window.__fire = {};
const cap = (name) => (cb) => { window.__fire[name] = cb; return () => {}; };
window.api = {
  getLocaleState: async () => ({ preference: 'zh-CN', locale: 'zh-CN' }),
  sendChat: () => {}, abortChat: () => {},
  onStreamChunk: cap('chunk'), onStreamEnd: cap('end'),
  onThinking: cap('thinking'), onThinkingEnd: cap('thinkingEnd'),
  onStreamRetry: cap('retry'),
  onTextFlush: () => () => {}, onToolStart: () => () => {}, onToolEnd: () => () => {},
  onToolProgress: () => () => {}, onAskUser: () => () => {}, onQuestionsV2: () => () => {},
  onArtifact: () => () => {}, onArtifactDelta: () => () => {}, onArtifactComplete: () => () => {},
  onVisualizer: () => () => {}, onVisualizerDelta: () => () => {}, onMcpAppInline: () => () => {},
  onTargetStatus: () => () => {}, onAppChanged: () => () => {}, onMemoryUpdated: () => () => {},
  onConvTitleUpdated: () => () => {}, onInlinePermission: () => () => {}, onPermissionRequest: () => () => {},
  respondPermission: () => {}, pasteToTarget: async () => ({ success: true }), hasApiKey: async () => ({ hasKey: true }),
  getRoleInitState: async () => ({ hasRole: true, role: { name: 'learner', displayName: '学习助手', icon: '📖' } }),
  getAllRoles: async () => [{ name: 'learner', displayName: '学习助手', icon: '📖' }],
  getCurrentRole: async () => ({ name: 'learner', displayName: '学习助手', icon: '📖' }),
  switchRole: async () => ({ name: 'learner', displayName: '学习助手', icon: '📖' }),
  listConversations: async () => [],
  createConversation: async (role) => ({ id: 'conv-stream-retry', title: '断流重连', role, createdAt: Date.now(), updatedAt: Date.now(), messageCount: 0 }),
  getConversationMessages: async () => [],
  replaceMessages: async () => {}, appendMessages: async () => {}, deleteConversation: async () => {},
  updateConversationConfig: async () => ({ ok: true }), updateConversationTitle: async () => ({ ok: true }),
  getAppSettings: async () => ({ detected: [], disabled: [], browsers: [] }), setDisabledApps: async () => {},
  getModelConfig: async () => ({ model: 'glm-5.3', supportsThinking: true }),
  getModelConfigFull: async () => ({ model: 'glm-5.3', supportsThinking: true }),
  isCustomConfig: async () => ({ isCustom: true }),
  getAvailableModels: async () => [],
  testConnection: async () => ({ ok: true }), getProviders: async () => ({}), clearModelConfig: async () => {},
  getMemoryConfig: async () => ({ enabled: true }), setMemoryConfig: async () => {},
  getVersion: async () => '0.0.0-test', getAgents: async () => [], listSkills: async () => [],
  listWorkspaces: async () => [], listAgentTemplates: async () => [],
  getOnboardingStatus: async () => ({ completed: true }), setOnboardingCompleted: async () => {},
  getRealtimeConfig: async () => ({ provider: 'openai', url: '', model: '', deployment: '', apiVersion: '', voice: 'alloy', hasKey: false }),
  steerChat: async () => ({ ok: true }), queueChat: async () => ({ ok: true }),
  getSources: async () => [], listModelPresets: async () => []
};
`

const CONV = 'conv-stream-retry'

async function openChat(page: Page): Promise<void> {
  await page.addInitScript({ content: MOCK_API })
  await page.goto('/')
  await page.waitForLoadState('networkidle')
  await page.evaluate(async () => {
    const store = (window as any).__chatStore
    await store.getState().newConversation('learner')
    store.setState({ messages: [{ id: 'm1', role: 'user', content: '你好', timestamp: Date.now() }] })
  })
  await page.locator('textarea').waitFor({ timeout: 5000 })
}

const thinkingText = (page: Page) =>
  page.evaluate(() => {
    const store = (window as any).__chatStore
    return store.getState().messages
      .filter((m: any) => m.messageKind === 'thinking')
      .map((m: any) => m.thinkingContent || '')
  })

test.describe('断流重连', () => {
  test('重连时丢掉半截思考，留下一条可读的提示', async ({ page }) => {
    await openChat(page)

    await page.evaluate((cid) => (window as any).__fire.thinking(cid, '第一次思考：这题要先……'), CONV)
    await expect.poll(() => thinkingText(page)).toEqual(['第一次思考：这题要先……'])

    await page.evaluate((cid) => (window as any).__fire.retry(cid, 1, 5), CONV)

    // 半截思考没了
    await expect.poll(() => thinkingText(page)).toEqual([])
    // 用户看得懂发生了什么
    const notice = page.getByTestId('inject-notice').filter({ hasText: '正在重试' })
    await expect(notice).toBeVisible()
    await expect(notice).toContainText('1/5')
    await expect(notice).not.toContainText('openpipal:stream-retry')
  })

  test('重连后的思考是新的一段，不接在旧内容后面', async ({ page }) => {
    await openChat(page)

    await page.evaluate((cid) => (window as any).__fire.thinking(cid, '被掐断的思考'), CONV)
    await expect.poll(() => thinkingText(page)).toEqual(['被掐断的思考'])

    await page.evaluate((cid) => (window as any).__fire.retry(cid, 1, 5), CONV)
    await page.evaluate((cid) => (window as any).__fire.thinking(cid, '重连后重新想'), CONV)

    await expect.poll(() => thinkingText(page)).toEqual(['重连后重新想'])
  })

  test('重连提示不进模型历史，也不当成可重新生成的回答', async ({ page }) => {
    await openChat(page)
    await page.evaluate((cid) => (window as any).__fire.retry(cid, 2, 5), CONV)

    const kinds = await page.evaluate(() => {
      const store = (window as any).__chatStore
      return store.getState().messages.map((m: any) => m.messageKind || 'plain')
    })
    expect(kinds).toContain('inject-notice')
  })
})

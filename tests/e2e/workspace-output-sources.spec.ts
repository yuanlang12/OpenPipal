import { expect, test, type Page } from '@playwright/test'
import { bootstrapChat } from './helpers'

/**
 * 会话摘要与全局作品的边界：
 * - 当前会话右侧只能看本会话的交付物和用户输入；
 * - 跨会话文件只在用户主动打开“作品”时加载。
 */
const MOCK_API = `
window.__mockBus = {
  listeners: {},
  on(event, fn) { (this.listeners[event] ||= []).push(fn); return () => { this.listeners[event] = this.listeners[event].filter(f => f !== fn); }; }
};
window.__mockCalls = [];
window.__conversationList = [];
window.__conversationMessages = {};
const ROLE = { name: 'general', displayName: '通用助手', icon: '✦' };
window.api = {
  getLocaleState: async () => ({ preference: 'zh-CN', locale: 'zh-CN' }),
  sendChat: (...args) => window.__mockCalls.push({ method: 'sendChat', args }),
  abortChat: () => {},
  onStreamChunk: () => () => {}, onStreamEnd: () => () => {}, onTextFlush: () => () => {},
  onThinking: () => () => {}, onThinkingEnd: () => () => {},
  onToolStart: () => () => {}, onToolProgress: () => () => {}, onToolEnd: () => () => {},
  onAskUser: () => () => {}, onQuestionsV2: () => () => {}, onQuestionsV2Delta: () => () => {},
  onArtifact: () => () => {}, onArtifactDelta: () => () => {}, onArtifactUpdate: () => () => {},
  onVisualizer: () => () => {}, onVisualizerDelta: () => () => {}, onMcpAppInline: () => () => {},
  onTargetStatus: () => () => {}, onAppChanged: () => () => {}, onMemoryUpdated: () => () => {},
  onPermissionRequest: () => () => {},
  getRoleInitState: async () => ({ hasRole: true, role: ROLE }),
  getAllRoles: async () => [ROLE], getCurrentRole: async () => ROLE, switchRole: async () => ROLE,
  listConversations: async () => window.__conversationList,
  createConversation: async (role) => ({ id: 'current-conversation', title: '当前任务', role, createdAt: Date.now(), updatedAt: Date.now(), messageCount: 0 }),
  getConversationMessages: async (id) => window.__conversationMessages[id] || [],
  replaceMessages: async () => {}, appendMessages: async () => {}, updateConversationConfig: async () => ({ ok: true }),
  deleteConversation: async () => {}, clearSessionApprovals: async () => {},
  getAppSettings: async () => ({ detected: [], disabled: [], browsers: [] }), setDisabledApps: async () => {},
  getModelConfig: async () => ({ provider: 'openai', baseUrl: '', apiKey: '', model: '' }),
  getModelConfigFull: async () => ({ provider: 'openai', baseUrl: '', apiKey: '', model: '' }),
  getAvailableModels: async () => [], hasApiKey: async () => ({ hasKey: true }),
  getRealtimeConfig: async () => ({ url: '', model: '', hasKey: false }),
  onRealtimeEvent: () => () => {}, onRealtimeState: () => () => {},
  listSkills: async () => [], listAgentTemplates: async () => [], listAgentWorkspaces: async () => [],
  listTasks: async () => [], getOnboardingStatus: async () => ({ completed: true }), setOnboardingCompleted: async () => {},
  listArtifactHistory: async () => [{
    id: 'older-artifact', type: 'html', title: '旧报告', conversationId: 'older-conversation',
    conversationTitle: '另一个任务', updatedAt: 1_710_000_000_000
  }],
  listOutputHistory: async () => [{
    name: 'Agent-in QE 季度汇报 PPT.pptx', path: '/tmp/agent-qe.pptx', size: 1024,
    updatedAt: 1_710_000_100_000, ext: 'pptx', scope: 'agent', workspaceId: 'qe', workspaceName: '汇报 Agent'
  }],
  listAgentOutputs: async () => { window.__mockCalls.push({ method: 'listAgentOutputs' }); return []; },
  listAssetsTree: async () => { window.__mockCalls.push({ method: 'listAssetsTree' }); return {}; },
  readUploadAsset: async () => ({ base64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9WlPbQAAAABJRU5ErkJggg==', mime: 'image/png' }),
  listSources: async () => [], getRolePreflow: async () => null,
  saveArtifact: async (_cid, artifact) => ({ ok: true, ref: { id: artifact.id, type: artifact.type, title: artifact.title, path: '' } })
};
`

test.use({ viewport: { width: 1200, height: 800 } })

async function setupCurrentConversation(page: Page): Promise<void> {
  await page.addInitScript({ content: MOCK_API })
  await page.goto('/')
  await page.waitForLoadState('networkidle')
  await bootstrapChat(page, {
    role: 'general',
    messages: [{
      id: 'user-source',
      role: 'user',
      content: '请根据这份作业给建议',
      timestamp: 1_710_000_200_000,
      fileAttachments: [{ fileName: '学生作业.pdf', fileType: 'pdf', sizeBytes: 42, path: '/tmp/student-homework.pdf' }],
      imagePaths: ['uploads/pasted-homework.png']
    }]
  })

  await page.evaluate(() => {
    const artifactStore = (window as any).__artifactStore
    artifactStore.getState().addArtifact({
      id: 'current-artifact', type: 'html', title: '当前会话作品', content: '<main>ok</main>',
      messageId: 'assistant-artifact', createdAt: 1_710_000_300_000, rehydrated: true
    })
    const workspace = (window as any).__workspaceStore.getState()
    workspace.setCurrentConversationId('current-conversation')
    workspace.setSectionCollapsed('outputs', false)
    workspace.setSectionCollapsed('sources', false)
    workspace.setOpen(true)
    workspace.focusSummary()
  })
}

test('右侧摘要只展示当前会话的输出和用户来源，跨会话历史仅在作品中出现', async ({ page }) => {
  await setupCurrentConversation(page)

  await expect(page.getByText('输出', { exact: true })).toBeVisible()
  await expect(page.getByText('来源', { exact: true })).toBeVisible()
  await expect(page.getByText('当前会话作品', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: '学生作业.pdf', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: '图片 1', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: '资产', exact: true })).toHaveCount(0)
  await expect(page.getByText('Agent-in QE 季度汇报 PPT.pptx', { exact: true })).toHaveCount(0)
  await expect.poll(() => page.evaluate(() => (window as any).__mockCalls.filter((call: any) => call.method === 'listAgentOutputs').length)).toBe(0)
  await expect.poll(() => page.evaluate(() => (window as any).__mockCalls.filter((call: any) => call.method === 'listAssetsTree').length)).toBe(0)

  await page.getByRole('button', { name: '作品', exact: true }).click()
  await expect(page.getByTestId('output-center')).toBeVisible()
  await expect(page.getByText('旧报告', { exact: true })).toBeVisible()
  await expect(page.getByText('Agent-in QE 季度汇报 PPT.pptx', { exact: true })).toBeVisible()

  await page.getByTestId('output-center-search').fill('Agent-in QE')
  await expect(page.getByText('Agent-in QE 季度汇报 PPT.pptx', { exact: true })).toBeVisible()
  await expect(page.getByText('旧报告', { exact: true })).toHaveCount(0)
})

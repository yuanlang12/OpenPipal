import { expect, test, type Page } from '@playwright/test'
import { bootstrapChat } from './helpers'

/**
 * questions_v2 的真实 renderer 链路：IPC 终态事件 → pending 配置 → workspace 问卷面板。
 * 这里不 mock QuestionsV2Panel，避免“状态已保存但 ephemeral artifact 没有重新装回 UI”再次漏测。
 */
const MOCK_API = `
window.__mockBus = {
  listeners: {},
  on(event, fn) { (this.listeners[event] ||= []).push(fn); return () => { this.listeners[event] = this.listeners[event].filter(f => f !== fn); }; },
  emit(event, ...args) { (this.listeners[event] || []).forEach(fn => fn(...args)); }
};
window.__conversationList = [];
window.__conversationMessages = {};
window.__mockCalls = [];
const ROLE = { name: 'learner', displayName: '学习助手', icon: '📖' };
window.api = {
  sendChat: (...args) => window.__mockCalls.push({ method: 'sendChat', args }),
  abortChat: () => {},
  onStreamChunk: (cb) => window.__mockBus.on('stream-chunk', cb),
  onStreamEnd: (cb) => window.__mockBus.on('stream-end', cb),
  onTextFlush: (cb) => window.__mockBus.on('text-flush', cb),
  onThinking: (cb) => window.__mockBus.on('thinking', cb),
  onThinkingEnd: (cb) => window.__mockBus.on('thinking-end', cb),
  onToolStart: (cb) => window.__mockBus.on('tool-start', cb),
  onToolProgress: (cb) => window.__mockBus.on('tool-progress', cb),
  onToolEnd: (cb) => window.__mockBus.on('tool-end', cb),
  onAskUser: (cb) => window.__mockBus.on('ask-user', cb),
  onQuestionsV2: (cb) => window.__mockBus.on('questions-v2', cb),
  onQuestionsV2Delta: (cb) => window.__mockBus.on('questions-v2-delta', cb),
  onArtifact: (cb) => window.__mockBus.on('artifact', cb),
  onArtifactDelta: (cb) => window.__mockBus.on('artifact-delta', cb),
  onArtifactUpdate: (cb) => window.__mockBus.on('artifact-update', cb),
  onVisualizer: (cb) => window.__mockBus.on('visualizer', cb),
  onVisualizerDelta: (cb) => window.__mockBus.on('visualizer-delta', cb),
  onMcpAppInline: (cb) => window.__mockBus.on('mcp-app-inline', cb),
  onTargetStatus: (cb) => window.__mockBus.on('target-status', cb),
  onAppChanged: (cb) => window.__mockBus.on('app-changed', cb),
  onMemoryUpdated: (cb) => window.__mockBus.on('memory-updated', cb),
  onPermissionRequest: (cb) => window.__mockBus.on('permission-request', cb),
  pasteToTarget: async () => ({ success: true }),
  getRoleInitState: async () => ({ hasRole: true, role: ROLE }),
  getAllRoles: async () => [ROLE],
  getCurrentRole: async () => ROLE,
  switchRole: async () => ROLE,
  listConversations: async () => window.__conversationList,
  createConversation: async (role) => ({ id: 'mock-conv', title: '问卷测试', role, createdAt: Date.now(), updatedAt: Date.now(), messageCount: 0 }),
  getConversationMessages: async (id) => window.__conversationMessages[id] || [],
  replaceMessages: async () => {},
  appendMessages: async () => {},
  updateConversationConfig: async (...args) => { window.__mockCalls.push({ method: 'updateConversationConfig', args }); return { ok: true }; },
  deleteConversation: async () => {},
  saveArtifact: async (_cid, artifact) => ({ ok: true, ref: { id: artifact.id, type: artifact.type, title: artifact.title, path: '' } }),
  getAppSettings: async () => ({ detected: [], disabled: [], browsers: [] }),
  setDisabledApps: async () => {},
  isCustomConfig: async () => ({ isCustom: false }),
  getAvailableModels: async () => [],
  getModelConfig: async () => ({ provider: 'openai', baseUrl: '', apiKey: '', model: '' }),
  getModelConfigFull: async () => ({ provider: 'openai', baseUrl: '', apiKey: '', model: '' }),
  saveModelConfig: async () => {},
  testConnection: async () => ({ ok: true }),
  getProviders: async () => ({}),
  clearModelConfig: async () => {},
  listSkills: async () => [],
  listWorkspaces: async () => [],
  listAgentTemplates: async () => [],
  getOnboardingStatus: async () => ({ completed: true }),
  setOnboardingCompleted: async () => {},
  getRealtimeConfig: async () => ({ provider: 'openai', url: '', model: '', deployment: '', apiVersion: '', voice: 'alloy', hasKey: false }),
};
`

test.use({ viewport: { width: 1200, height: 800 } })

async function setupChat(page: Page): Promise<void> {
  await page.addInitScript({ content: MOCK_API })
  await page.goto('/')
  await page.waitForLoadState('networkidle')
  await bootstrapChat(page, {
    role: 'learner',
    messages: [{ id: 'init', role: 'user', content: '初始化', timestamp: Date.now() - 1_000 }]
  })
}

async function emitQuestions(page: Page, questions: unknown[]): Promise<void> {
  await page.evaluate((items) => {
    ;(window as any).__mockBus.emit('questions-v2', '', '补充信息', items)
  }, questions)
}

const UX_ARTIFACTS = 'tests/artifacts/questions-panel'

test.describe('问卷面板：代选规则与版式', () => {
  test('不再逐题摆「交给 AI 判断」；必答题拦提交；未答题落成 AI 判断', async ({ page }) => {
    await setupChat(page)
    await emitQuestions(page, [
      { id: 'tone', kind: 'text-options', title: '讲解语气', subtitle: '影响旁白与字幕的口吻', options: ['活泼', '沉稳'] },
      { id: 'palette', kind: 'svg-options', title: '色板', options: [
        { value: 'green', label: '深绿', svg: '<svg viewBox="0 0 80 56"><rect width="80" height="56" fill="#0F3D2E"/></svg>' },
        { value: 'cream', label: '奶油', svg: '<svg viewBox="0 0 80 56"><rect width="80" height="56" fill="#F5F1E8"/></svg>' }
      ] },
      { id: 'pace', kind: 'slider', title: '节奏', min: 1, max: 5, step: 1, default: 3 },
      { id: 'notes', kind: 'freeform', title: '还有什么要补充的', placeholder: '可以留空' },
      { id: 'topics', kind: 'multi-chip', title: '想覆盖的点', options: ['从众', '匿名', '情绪'] },
      { id: 'memo', kind: 'text-options', title: '是否把这条偏好写进你的档案', options: ['记下来', '不要记录'], allowAiDecision: false }
    ])

    // 规则改造：选项区只剩真选项 + 其他；代选变成面板级的一句话
    // （本 harness 没 mock getLocaleState，UI 走 en——断言用英文串，模型给的选项文本仍是中文）
    await expect(page.getByText('Let AI decide', { exact: true })).toHaveCount(0)
    await expect(page.getByText('You do not have to answer every question', { exact: false })).toBeVisible()
    await expect(page.getByText('Required', { exact: true })).toHaveCount(1)

    await page.screenshot({ path: `${UX_ARTIFACTS}/panel-wide.png`, fullPage: true })

    // 必答题没答 → 拦下，不发任何消息
    await page.getByRole('button', { name: 'Submit and continue' }).click()
    await expect(page.getByTestId('questions-required-notice')).toBeVisible()
    await expect(page.getByTestId('question-missing')).toHaveCount(1)
    // 提示要能定位：被拦下的那道题必须被滚进视野，而不是只在底部亮一行字
    await expect(page.getByTestId('question-missing')).toBeInViewport({ timeout: 3000 })
    expect(await page.evaluate(() =>
      (window as any).__mockCalls.filter((c: any) => c.method === 'sendChat').length)).toBe(0)
    await page.screenshot({ path: `${UX_ARTIFACTS}/panel-required-blocked.png`, fullPage: true })

    // 答掉必答题 → 放行；其余没答的题统一落成「请 AI 根据已有信息判断」
    await page.getByRole('button', { name: '不要记录' }).click()
    await page.getByRole('button', { name: 'Submit and continue' }).click()
    await expect.poll(() => page.evaluate(() =>
      (window as any).__mockCalls.filter((c: any) => c.method === 'sendChat').length)).toBeGreaterThan(0)
    const sent = await page.evaluate(() =>
      JSON.stringify((window as any).__mockCalls.find((c: any) => c.method === 'sendChat')))
    expect(sent).toContain('Let AI decide from the available information')
    expect(sent).toContain('不要记录')
  })

  test('流式空档给骨架占位，不是一片白', async ({ page }) => {
    await setupChat(page)
    await page.evaluate(() => (window as any).__mockBus.emit('questions-v2-delta', '', {
      id: 'q-stream', title: '《乌合之众》儿童讲解动画 · 几个关键问题', questions: []
    }))
    await expect(page.getByTestId('questions-skeleton')).toBeVisible()
    await expect(page.getByTestId('questions-streaming')).toBeVisible()
    await page.screenshot({ path: `${UX_ARTIFACTS}/panel-streaming.png`, fullPage: true })
  })
})

test.describe('questions_v2 生命周期与动态附件', () => {
  test('模型 SVG 只保留静态图形，事件、脚本和外部资源不会进入主界面', async ({ page }) => {
    await setupChat(page)
    await page.evaluate(() => {
      ;(window as any).__svgExecuted = false
    })
    await emitQuestions(page, [
      {
        id: 'palette',
        kind: 'svg-options',
        title: '选择色板',
        options: [{
          value: 'green',
          label: '深绿',
          svg: '<svg viewBox="0 0 80 56" onload="window.__svgExecuted=true"><script>window.__svgExecuted=true</script><image href="https://attacker.invalid/pixel"/><rect width="80" height="56" fill="#0F3D2E"/></svg>'
        }]
      }
    ])

    await expect(page.getByTitle('深绿')).toBeVisible()
    await expect.poll(() => page.evaluate(() => (window as any).__svgExecuted)).toBe(false)
    const rendered = await page.getByTitle('深绿').locator('img').evaluate((img) =>
      decodeURIComponent(img.getAttribute('src')?.split(',', 2)[1] || '')
    )
    expect(rendered).toContain('<rect')
    expect(rendered).not.toMatch(/onload|script|image|https:/i)
  })

  test('只显示 Agent 对具体题目声明的附件位，不再有固定通用上传区', async ({ page }) => {
    await setupChat(page)
    await emitQuestions(page, [
      { id: 'work', kind: 'freeform', title: '学生作业', attach: true, attachHint: '请上传一张作业照片。' },
      { id: 'goal', kind: 'text-options', title: '反馈重点', options: ['鼓励', '纠错'] }
    ])

    await expect(page.getByTestId('question-attach-zone')).toHaveCount(1)
    await expect(page.getByTestId('question-attach-zone')).toContainText('请上传一张作业照片。')
    await expect(page.getByTestId('questions-file-input')).toHaveCount(1)
    await expect(page.getByTestId('questions-attachments')).toHaveCount(0)
    await expect(page.getByText('相关材料（选填）')).toHaveCount(0)
    await expect(page.getByTestId('legacy-question-unavailable')).toHaveCount(0)
  })

  test('没有 attach:true 时，问卷内不渲染或接管任何文件上传入口', async ({ page }) => {
    await setupChat(page)
    await emitQuestions(page, [
      { id: 'goal', kind: 'text-options', title: '反馈重点', options: ['鼓励', '纠错'] }
    ])

    await expect(page.getByTestId('question-attach-zone')).toHaveCount(0)
    await expect(page.getByTestId('questions-file-input')).toHaveCount(0)
    await expect(page.getByTestId('questions-attachments')).toHaveCount(0)
  })

  test('重载会话时用 pendingQuestion 重建 ephemeral 问卷并强制回到可回答界面', async ({ page }) => {
    await page.addInitScript({ content: MOCK_API })
    await page.goto('/')
    await page.waitForLoadState('networkidle')

    const restored = await page.evaluate(async () => {
      const conversation = {
        id: 'pending-conv',
        title: '待答问卷',
        role: 'learner',
        createdAt: Date.now() - 10_000,
        updatedAt: Date.now(),
        messageCount: 1,
        config: {
          pendingQuestion: {
            artifactId: 'questions-pending',
            title: '恢复中的问卷',
            questions: [{ id: 'source', kind: 'freeform', title: '作业来源' }]
          }
        }
      }
      ;(window as any).__conversationList = [conversation]
      ;(window as any).__conversationMessages['pending-conv'] = [{
        id: 'tool-questions-pending',
        role: 'tool',
        toolName: 'questions_v2',
        questionsV2Version: 1,
        content: '恢复中的问卷',
        artifactRef: { id: 'questions-pending', type: 'questions', title: '恢复中的问卷', path: '' },
        timestamp: Date.now() - 1_000
      }]

      const chat = (window as any).__chatStore
      chat.setState({ conversations: [conversation] })
      await chat.getState().switchConversation('pending-conv')
      const artifacts = (window as any).__artifactStore.getState().artifacts
      const workspace = (window as any).__workspaceStore.getState()
      return {
        pending: chat.getState().pendingQuestionsV2?.artifactId,
        artifact: artifacts.some((artifact: any) => artifact.id === 'questions-pending'),
        tab: workspace.tabs.some((tab: any) => tab.artifactId === 'questions-pending'),
        open: workspace.open
      }
    })

    expect(restored).toEqual({ pending: 'questions-pending', artifact: true, tab: true, open: true })
    await expect(page.getByRole('heading', { name: '恢复中的问卷' })).toBeVisible()
    await expect(page.getByTestId('legacy-question-unavailable')).toHaveCount(0)
  })
})

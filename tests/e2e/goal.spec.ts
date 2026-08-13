/**
 * Goal Loop E2E — P3 验收
 *
 * 覆盖:
 *   T1 /goal <text> → setGoal IPC + GoalTab 自动展开 + 显示"追逐中"
 *   T2 goal_update 推 turnsUsed=1 → GoalTab 进度条更新
 *   T3 goal_update 推 status=done → GoalTab 显示"已完成"
 *   T4 goal_update 推 status=exceeded → GoalTab 显示"已达上限"
 *   T5 /goal clear → clearGoal IPC + artifact 移除
 *   T6 /goal show 无 goal 时不打开侧栏(主进程不发事件,UI 安静)
 *   T7 GoalTab 内点 × 按钮 → clearGoal IPC 调用
 *
 * Mock 策略:走 phase1-ui.spec.ts / new-features.spec.ts 同款 window.__mockBus + __mockCalls
 * 模式,不真启 Electron 主进程。验证渲染端到 IPC 边界的行为。
 */

import { test, expect, Page } from '@playwright/test'
import { bootstrapChat } from './helpers'

const ARTIFACTS_DIR = 'tests/artifacts/goal'

const MOCK = `
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
window.__mockCalls = [];
const noop = () => {};
const noopSub = () => noop;
const mockConv = { id: 'goal-test-conv', title: 'goal 测试会话', role: 'learner', createdAt: Date.now(), updatedAt: Date.now(), messageCount: 1 };
// App.tsx 的 ChatPanel 渲染条件是 messages.length > 0。塞一条初始消息让 ChatPanel 挂载,
// 否则 WelcomePage 渲染的 InputBar 不带 /goal 拦截。
const mockInitMessages = [{ id: 'msg-init', role: 'user', content: '初始化', timestamp: Date.now() - 60000 }];
window.api = {
  getLocaleState: async () => ({ preference: 'zh-CN', locale: 'zh-CN' }),
  // chat 基础(不会被 /goal 路径触发,但 InputBar 初始化要)
  sendChat: (messages, agentId, cfg, cid, wsid) => { window.__mockCalls.push({ method: 'sendChat', args: [messages, agentId, cfg, cid, wsid] }); },
  abortChat: noop,
  onStreamChunk: (cb) => window.__mockBus.on('stream-chunk', cb),
  onStreamEnd: (cb) => window.__mockBus.on('stream-end', cb),
  onTextFlush: (cb) => window.__mockBus.on('text-flush', cb),
  onToolStart: (cb) => window.__mockBus.on('tool-start', cb),
  onToolEnd: (cb) => window.__mockBus.on('tool-end', cb),
  onToolProgress: (cb) => window.__mockBus.on('tool-progress', cb),
  onAskUser: (cb) => window.__mockBus.on('ask-user', cb),
  onQuestionsV2: (cb) => window.__mockBus.on('questions-v2', cb),
  onThinking: (cb) => window.__mockBus.on('thinking', cb),
  onThinkingEnd: (cb) => window.__mockBus.on('thinking-end', cb),
  onArtifact: (cb) => window.__mockBus.on('artifact', cb),
  onArtifactDelta: (cb) => window.__mockBus.on('artifact-delta', cb),
  onVisualizer: (cb) => window.__mockBus.on('visualizer', cb),
  onVisualizerDelta: (cb) => window.__mockBus.on('visualizer-delta', cb),
  onMcpAppInline: (cb) => window.__mockBus.on('mcp-app-inline', cb),
  // 默认就是挂靠模式(sidebar 隐藏 → workspace 拿到全宽,模拟真实用户 420px 侧栏 UX)
  // 把回调存起来,goto 后再 emit 第一次 status
  onTargetStatus: (cb) => {
    setTimeout(() => cb({ connected: true, appName: '测试目标 app', isFullscreen: false }), 0);
    return window.__mockBus.on('target-status', cb);
  },
  onAppChanged: noopSub,
  onTitleUpdated: noopSub,
  onTaskExecuted: noopSub,
  onMemoryUpdated: noopSub,
  onPermissionRequest: noopSub,
  onPermissionRequestInline: noopSub,
  onDreamStatus: noopSub,
  pasteToTarget: async () => ({ success: true }),

  // 角色 / 会话
  getRoleInitState: async () => ({ hasRole: true, role: { name: 'learner', displayName: '学习助手', icon: '📖' } }),
  getAllRoles: async () => [{ name: 'learner', displayName: '学习助手', icon: '📖' }],
  getCurrentRole: async () => ({ name: 'learner', displayName: '学习助手', icon: '📖' }),
  switchRole: async (name) => ({ name, displayName: name, icon: '📖' }),
  listConversations: async () => [mockConv],
  createConversation: async (role) => ({ ...mockConv, role }),
  getConversation: async () => ({ ...mockConv, messages: mockInitMessages, config: {} }),
  getConversationMessages: async () => mockInitMessages,
  replaceMessages: async () => {},
  appendMessages: async () => {},
  deleteConversation: async () => {},
  updateConversationTitle: async () => {},

  // app / model
  getAppSettings: async () => ({ detected: [], disabled: [], browsers: [] }),
  setDisabledApps: async () => {},
  isCustomConfig: async () => ({ isCustom: false }),
  getModelConfig: async () => ({ provider: 'openai', baseUrl: '', apiKey: '', model: 'gpt-4o' }),
  getModelConfigFull: async () => ({ provider: 'openai', baseUrl: '', apiKey: '', model: 'gpt-4o' }),
  saveModelConfig: async () => {},
  testConnection: async () => ({ ok: true }),
  getProviders: async () => ({}),
  clearModelConfig: async () => {},
  getRealtimeConfig: async () => ({ url: '', model: '', hasKey: false }),
  startRealtime: async () => ({ success: false }),
  stopRealtime: noop,
  sendRealtimeEvent: noop,
  onRealtimeEvent: noopSub,
  onRealtimeState: noopSub,

  // ⭐ Goal 相关(P3 新加)
  setGoal: (cid, text) => { window.__mockCalls.push({ method: 'setGoal', args: [cid, text] }); },
  clearGoal: (cid) => { window.__mockCalls.push({ method: 'clearGoal', args: [cid] }); },
  showGoal: (cid) => { window.__mockCalls.push({ method: 'showGoal', args: [cid] }); },
  onArtifactUpdate: (cb) => window.__mockBus.on('artifact-update', cb),
};
`

async function setup(page: Page): Promise<void> {
  await page.addInitScript({ content: MOCK })
  await page.goto('/')
  await page.waitForLoadState('networkidle')
  // App 启动停在 WelcomePage(messages 为空)——bootstrapChat 建会话 + 塞一条初始消息把
  // WelcomePage 挤掉,让 ChatPanel 的 InputBar(带 /goal 拦截)挂载。
  await bootstrapChat(page, {
    role: 'learner',
    messages: [{ id: 'msg-init', role: 'user', content: '初始化', timestamp: Date.now() - 60000 }]
  })
  await page.waitForSelector('[data-testid="send-btn"]', { timeout: 10000 })
  // workspaceStore 默认宽 480 > 测试 viewport 420 → 面板溢出视口右边。
  // 真实用户在挂靠模式下会拖窄面板,这里 mock 一次让截图代表"用户调好后"的视图。
  await page.evaluate(() => {
    const ws = (window as any).__workspaceStore?.getState?.()
    ws?.setWidth?.(380)
  })
}

async function typeAndSend(page: Page, text: string): Promise<void> {
  const textarea = page.locator('textarea').first()
  await textarea.fill(text)
  // 用 send-btn 点击代替 Enter,避免 React state batching 在 Enter 时未刷的边界情况
  // (existing new-features.spec.ts 也是这个套路)
  await page.locator('[data-testid="send-btn"]').click()
  await page.waitForTimeout(200)
}

async function emitArtifactUpdate(
  page: Page,
  cid: string,
  artifact: { id: string; type: string; title: string; content: string; removed?: boolean }
): Promise<void> {
  await page.evaluate(
    ({ cid, artifact }) => window.__mockBus.emit('artifact-update', cid, artifact),
    { cid, artifact }
  )
  await page.waitForTimeout(150)
}

function buildGoal(opts: { text?: string; turnsUsed?: number; status?: string; reason?: string } = {}): any {
  return {
    text: opts.text ?? '修复登录 bug',
    maxTurns: 8,
    turnsUsed: opts.turnsUsed ?? 0,
    status: opts.status ?? 'active',
    consecutiveBlocks: 0,
    createdAt: Date.now(),
    lastCheck: opts.reason
      ? { ok: opts.status === 'done', reason: opts.reason, timestamp: Date.now() }
      : undefined
  }
}

test.describe('Goal loop P3 E2E', () => {
  test('T1 /goal <text> → setGoal IPC + GoalTab 自动展开', async ({ page }) => {
    await setup(page)
    await typeAndSend(page, '/goal 修复登录 bug')

    // setGoal IPC 被调用(参数对得上)
    const calls = await page.evaluate(() => window.__mockCalls)
    const setCall = calls.find((c: any) => c.method === 'setGoal')
    expect(setCall).toBeTruthy()
    expect(setCall.args[0]).toBe('goal-test-conv')
    expect(setCall.args[1]).toBe('修复登录 bug')

    // 模拟主进程回推 artifact-update → UI 应该自动展开 GoalTab
    await emitArtifactUpdate(page, 'goal-test-conv', {
      id: 'goal-goal-test-conv',
      type: 'goal',
      title: '🎯 目标',
      content: JSON.stringify(buildGoal())
    })

    // GoalTab 出现 + 文本可见
    await expect(page.locator('text=修复登录 bug')).toBeVisible({ timeout: 3000 })
    // 状态徽章"追逐中"
    await expect(page.locator('text=追逐中')).toBeVisible()
    // 进度 0/8
    await expect(page.locator('text=0 / 8 轮')).toBeVisible()

    await page.screenshot({ path: `${ARTIFACTS_DIR}/t1-set-goal.png`, fullPage: true })
  })

  test('T2 goal_update 推进度 → 进度条+轮次更新', async ({ page }) => {
    await setup(page)
    // 先设个 goal 让 artifact 出现
    await emitArtifactUpdate(page, 'goal-test-conv', {
      id: 'goal-goal-test-conv',
      type: 'goal',
      title: '🎯 目标',
      content: JSON.stringify(buildGoal())
    })
    await expect(page.locator('text=0 / 8 轮')).toBeVisible({ timeout: 3000 })

    // 推一次进度更新 → 用 upsert 替换
    await emitArtifactUpdate(page, 'goal-test-conv', {
      id: 'goal-goal-test-conv',
      type: 'goal',
      title: '🎯 目标',
      content: JSON.stringify(buildGoal({ turnsUsed: 3, reason: '测试还没跑通' }))
    })
    await expect(page.locator('text=3 / 8 轮')).toBeVisible()
    // 上次评估 reason 应该可见
    await expect(page.locator('text=测试还没跑通')).toBeVisible()

    await page.screenshot({ path: `${ARTIFACTS_DIR}/t2-progress.png`, fullPage: true })
  })

  test('T3 status=done → 显示"已完成" + 完成色', async ({ page }) => {
    await setup(page)
    await emitArtifactUpdate(page, 'goal-test-conv', {
      id: 'goal-goal-test-conv',
      type: 'goal',
      title: '🎯 目标',
      content: JSON.stringify(buildGoal({ turnsUsed: 2, status: 'done', reason: '已通过' }))
    })
    await expect(page.locator('text=已完成')).toBeVisible({ timeout: 3000 })
    await expect(page.locator('text=2 / 8 轮')).toBeVisible()

    await page.screenshot({ path: `${ARTIFACTS_DIR}/t3-done.png`, fullPage: true })
  })

  test('T4 status=exceeded → 显示"已达上限"', async ({ page }) => {
    await setup(page)
    await emitArtifactUpdate(page, 'goal-test-conv', {
      id: 'goal-goal-test-conv',
      type: 'goal',
      title: '🎯 目标',
      content: JSON.stringify(buildGoal({ turnsUsed: 8, status: 'exceeded', reason: '达到上限' }))
    })
    await expect(page.locator('text=已达上限')).toBeVisible({ timeout: 3000 })
    await expect(page.locator('text=8 / 8 轮')).toBeVisible()

    await page.screenshot({ path: `${ARTIFACTS_DIR}/t4-exceeded.png`, fullPage: true })
  })

  test('T5 /goal clear → clearGoal IPC + removed=true 后 artifact 移除', async ({ page }) => {
    await setup(page)
    // 先输 /goal clear (InputBar 未被工作区面板撑占,send-btn 可点)
    await typeAndSend(page, '/goal clear')

    const calls = await page.evaluate(() => window.__mockCalls)
    const clearCall = calls.find((c: any) => c.method === 'clearGoal')
    expect(clearCall).toBeTruthy()
    expect(clearCall.args[0]).toBe('goal-test-conv')

    // 验证"先 set 再 clear"的 artifact 移除路径(用 store 直接驱动,跳过 InputBar)
    await emitArtifactUpdate(page, 'goal-test-conv', {
      id: 'goal-goal-test-conv',
      type: 'goal',
      title: '🎯 目标',
      content: JSON.stringify(buildGoal())
    })
    await expect(page.locator('text=修复登录 bug')).toBeVisible({ timeout: 3000 })

    await emitArtifactUpdate(page, 'goal-test-conv', {
      id: 'goal-goal-test-conv',
      type: 'goal',
      title: '',
      content: '',
      removed: true
    })
    await expect(page.locator('text=修复登录 bug')).not.toBeVisible({ timeout: 3000 })
  })

  test('T6 /goal show → showGoal IPC', async ({ page }) => {
    await setup(page)
    await typeAndSend(page, '/goal show')

    const calls = await page.evaluate(() => window.__mockCalls)
    const showCall = calls.find((c: any) => c.method === 'showGoal')
    expect(showCall).toBeTruthy()
    expect(showCall.args[0]).toBe('goal-test-conv')

    // /goal 单独(无参数)也走 show
    await typeAndSend(page, '/goal')
    const calls2 = await page.evaluate(() => window.__mockCalls)
    const showCalls = calls2.filter((c: any) => c.method === 'showGoal')
    expect(showCalls.length).toBeGreaterThanOrEqual(2)
  })

  test('T7 GoalTab 点 × 按钮 → clearGoal IPC', async ({ page }) => {
    await setup(page)
    await emitArtifactUpdate(page, 'goal-test-conv', {
      id: 'goal-goal-test-conv',
      type: 'goal',
      title: '🎯 目标',
      content: JSON.stringify(buildGoal())
    })
    await expect(page.locator('[data-testid="goal-clear-btn"]')).toBeVisible({ timeout: 3000 })

    // 清空 mockCalls 以便区分前后
    await page.evaluate(() => { window.__mockCalls = [] })

    await page.locator('[data-testid="goal-clear-btn"]').click()
    await page.waitForTimeout(150)

    const calls = await page.evaluate(() => window.__mockCalls)
    const clearCall = calls.find((c: any) => c.method === 'clearGoal')
    expect(clearCall).toBeTruthy()
    expect(clearCall.args[0]).toBe('goal-test-conv')
  })

  test('T8 sendChat 路径不被 /goal 误伤(普通消息正常发送)', async ({ page }) => {
    await setup(page)
    await typeAndSend(page, '你好')

    const calls = await page.evaluate(() => window.__mockCalls)
    const sendCall = calls.find((c: any) => c.method === 'sendChat')
    expect(sendCall).toBeTruthy()

    // 同会话不应触发 setGoal/clearGoal/showGoal
    const goalCalls = calls.filter((c: any) =>
      ['setGoal', 'clearGoal', 'showGoal'].includes(c.method)
    )
    expect(goalCalls.length).toBe(0)
  })
})

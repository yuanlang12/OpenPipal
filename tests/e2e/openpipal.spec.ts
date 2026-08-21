import { test, expect, Page } from '@playwright/test'
import { bootstrapChat } from './helpers'

const ARTIFACTS_DIR = 'tests/artifacts'

/**
 * Mock window.api (Electron preload bridge)
 *
 * 策略：注入一个事件发射器风格的 mock，所有 on* 回调注册到 __mockBus 上，
 * 然后测试通过 page.evaluate 调用 __mockBus.emit(event, ...args) 来模拟 IPC 事件。
 * sendChat / abortChat 会记录调用，以便测试验证。
 */
const MOCK_API_SCRIPT = `
window.__mockBus = {
  listeners: {},
  on(event, fn) {
    if (!this.listeners[event]) this.listeners[event] = [];
    this.listeners[event].push(fn);
    return () => {
      this.listeners[event] = this.listeners[event].filter(f => f !== fn);
    };
  },
  emit(event, ...args) {
    (this.listeners[event] || []).forEach(fn => fn(...args));
  }
};

window.__mockCalls = [];

window.api = {
  getLocaleState: async () => ({ preference: 'zh-CN', locale: 'zh-CN' }),
  sendChat: (messages) => {
    window.__mockCalls.push({ method: 'sendChat', args: messages });
  },
  abortChat: () => {
    window.__mockCalls.push({ method: 'abortChat' });
  },
  onStreamChunk: (cb) => window.__mockBus.on('stream-chunk', cb),
  onStreamEnd: (cb) => window.__mockBus.on('stream-end', cb),
  onTextFlush: (cb) => window.__mockBus.on('text-flush', cb),
  onToolStart: (cb) => window.__mockBus.on('tool-start', cb),
  onToolEnd: (cb) => window.__mockBus.on('tool-end', cb),
  onAskUser: (cb) => window.__mockBus.on('ask-user', cb),
  onTargetStatus: (cb) => window.__mockBus.on('target-status', cb),
  onAppChanged: (cb) => window.__mockBus.on('app-changed', cb),
  pasteToTarget: async (text) => ({ success: true }),
  getRoleInitState: async () => ({
    hasRole: true,
    role: { name: 'learner', displayName: '学习助手', icon: '📖', systemPrompt: '', tools: [] }
  }),
  getAllRoles: async () => [
    { name: 'learner', displayName: '学习助手', icon: '📖', systemPrompt: '', tools: [] },
    { name: 'teacher', displayName: '教师助手', icon: '🎓', systemPrompt: '', tools: [] },
    { name: 'office', displayName: '办公助手', icon: '💼', systemPrompt: '', tools: [] }
  ],
  getCurrentRole: async () => ({
    name: 'learner', displayName: '学习助手', icon: '📖', systemPrompt: '', tools: []
  }),
  switchRole: async (roleName) => ({
    name: roleName, displayName: roleName, icon: '📖', systemPrompt: '', tools: []
  }),
  listConversations: async () => [],
  createConversation: async (role) => ({ id: 'mock-conv-' + Date.now(), title: '新对话', role, createdAt: Date.now(), updatedAt: Date.now(), messageCount: 0 }),
  getConversationMessages: async () => [],
  replaceMessages: async () => {},
  appendMessages: async () => {},
  deleteConversation: async () => {},
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
  stopRealtime: () => {},
  sendRealtimeEvent: () => {},
  onRealtimeEvent: () => () => {},
  onRealtimeState: () => () => {},
};
`

// 辅助函数：注入 mock 并导航到页面
async function setupPage(page: Page) {
  await page.addInitScript({ content: MOCK_API_SCRIPT })
  await page.goto('/')
  await page.waitForLoadState('networkidle')
  // App 启动停在 WelcomePage(messages 为空)——bootstrapChat 建会话 + 塞一条初始消息
  // 把 WelcomePage 挤掉,让 ChatPanel 挂载。
  await bootstrapChat(page, {
    role: 'learner',
    messages: [{ id: 'msg-init', role: 'user', content: '初始化', timestamp: Date.now() - 60000 }]
  })
}

// 辅助函数：模拟 AI 流式回复
async function simulateStreamReply(page: Page, text: string, chunkSize = 10) {
  // 分块发送
  for (let i = 0; i < text.length; i += chunkSize) {
    const chunk = text.slice(i, i + chunkSize)
    await page.evaluate((c) => window.__mockBus.emit('stream-chunk', '', c), chunk)
    await page.waitForTimeout(50) // 模拟网络延迟
  }
  // 发送结束信号
  await page.evaluate(() => window.__mockBus.emit('stream-end', ''))
}

// 辅助函数：模拟工具调用（搜索）
async function simulateSearchTool(page: Page) {
  // 工具开始
  await page.evaluate(() => window.__mockBus.emit('tool-start', '', 'web_search'))
  await page.waitForTimeout(500)

  // 先刷新已有文本
  await page.evaluate(() => window.__mockBus.emit('text-flush', ''))
  await page.waitForTimeout(100)

  // 工具结束，带搜索结果
  const searchResults = `1. MCP (Model Context Protocol) 是 Anthropic 推出的开放协议
2. 它定义了 AI 模型与外部工具/数据源之间的标准通信方式
3. MCP 使用 JSON-RPC 2.0 作为传输格式`

  await page.evaluate(
    (results) => window.__mockBus.emit('tool-end', '', 'web_search', undefined, results),
    searchResults
  )
}

// ============================================================
// 测试用例 2：消息发送测试
// ============================================================
test.describe('2. 消息发送测试', () => {
  test('发送消息并收到 AI 回复', async ({ page }) => {
    await setupPage(page)

    // 2.1 在输入框输入文本
    const textarea = page.locator('textarea')
    await textarea.fill('你好，请做下自我介绍')
    await page.screenshot({ path: `${ARTIFACTS_DIR}/02-01-typed-message.png` })

    // 2.2 点击发送按钮
    const sendButton = page.locator('[data-testid="send-btn"]')
    await sendButton.click()

    // 2.3 验证用户消息出现
    const userMessage = page.locator('text=你好，请做下自我介绍')
    await expect(userMessage).toBeVisible()
    await page.screenshot({ path: `${ARTIFACTS_DIR}/02-02-user-message-sent.png` })

    // 2.4 验证 sendChat 被调用
    const calls = await page.evaluate(() => window.__mockCalls)
    expect(calls.length).toBe(1)
    expect(calls[0].method).toBe('sendChat')

    // 2.5 验证"正在处理"的反馈出现（isStreaming=true 但一个字节都还没回来）。
    // 曾经是三个跳动点组成的带边框气泡，2026-08-18 按用户要求删掉了——
    // 计时分割线自己就在扫光、还带真实秒数，方框点点是同一件事说两遍。
    const liveBar = page.locator('[data-testid="process-group-toggle"][data-active="true"]')
    await expect(liveBar).toBeVisible({ timeout: 3000 })
    // 此刻模型还一个字节都没回来 —— 只写「连接模型…」,不报秒数(用户实锤:
    // "发了消息就计时,其实模型还没通")。收到第一个模型事件后才切成「处理中 N 秒」。
    await expect(liveBar).toContainText('连接模型')
    await expect(page.locator('.animate-pulse-soft')).toHaveCount(0)
    await page.screenshot({ path: `${ARTIFACTS_DIR}/02-03-thinking-indicator.png` })

    // 2.6 模拟 AI 流式回复
    const aiReply = '你好！我是 OpenPipal，你的 AI 助手。我可以帮你截取屏幕、搜索资料、解答问题。有什么需要帮忙的吗？'
    await simulateStreamReply(page, aiReply)

    // 2.7 等待 assistant 消息渲染（prose-light div）
    const assistantMessage = page.locator('.prose-light')
    await expect(assistantMessage.last()).toBeVisible({ timeout: 5000 })
    await page.screenshot({ path: `${ARTIFACTS_DIR}/02-04-ai-reply-received.png` })

    // 2.8 验证回复内容
    const replyText = await assistantMessage.last().textContent()
    expect(replyText).toBeTruthy()
    expect(replyText!).toContain('OpenPipal')
    expect(replyText!.length).toBeGreaterThan(10)

    // 2.9 验证输入框已清空、可以继续输入
    const inputValue = await textarea.inputValue()
    expect(inputValue).toBe('')

    console.log(`[测试2] 消息发送测试 - 全部通过，AI 回复长度: ${replyText!.length} 字符`)
  })
})

// ============================================================
// 测试用例 3：工具调用测试（搜索）
// ============================================================
test.describe('3. 工具调用测试（搜索）', () => {
  test('发送搜索请求并验证搜索结果', async ({ page }) => {
    await setupPage(page)

    // 3.1 发送搜索请求
    const textarea = page.locator('textarea')
    await textarea.fill('帮我搜索一下：什么是MCP协议')
    const sendButton = page.locator('[data-testid="send-btn"]')
    await sendButton.click()
    await page.screenshot({ path: `${ARTIFACTS_DIR}/03-01-search-request-sent.png` })

    // 3.2 模拟工具调用 - 搜索中
    await simulateSearchTool(page)

    // 3.3 验证搜索结果卡片直接可见。
    // 探索类步骤只有 **≥2 条**才并成"探索 · N 搜索"那一行(门槛与 file-group / archive-group 对齐);
    // 本例只搜了一次,所以结果卡原样铺在过程栏里,不必再点开一层。
    await expect(page.locator('[data-testid="process-explore-group"]')).toHaveCount(0)
    const searchResultCard = page.locator('text=搜索结果')
    await expect(searchResultCard).toBeVisible({ timeout: 5000 })
    await page.screenshot({ path: `${ARTIFACTS_DIR}/03-02-search-results-card.png` })

    // 3.4 模拟 AI 基于搜索结果的回复
    const aiReply = `根据搜索结果，MCP（Model Context Protocol）是 Anthropic 推出的一个开放协议，主要用于定义 AI 模型与外部工具和数据源之间的标准通信方式。

**核心特点：**
- 使用 JSON-RPC 2.0 作为传输格式
- 支持工具调用、资源访问等标准化操作
- 允许 AI 助手连接各种外部服务`

    await simulateStreamReply(page, aiReply)

    // 3.5 等待 AI 最终回复渲染
    const assistantReply = page.locator('.prose-light').last()
    await expect(assistantReply).toBeVisible({ timeout: 5000 })
    await page.screenshot({ path: `${ARTIFACTS_DIR}/03-03-search-final-reply.png` })

    // 3.6 验证回复中包含 MCP 相关内容
    const replyText = await assistantReply.textContent()
    expect(replyText).toBeTruthy()
    const hasMCPContent =
      replyText!.includes('MCP') ||
      replyText!.includes('Model Context Protocol') ||
      replyText!.includes('协议')
    expect(hasMCPContent).toBeTruthy()

    console.log('[测试3] 工具调用测试 - 全部通过')
  })
})

// ============================================================
// 测试用例 4：停止按钮测试
// ============================================================
test.describe('4. 停止按钮测试', () => {
  test('在 streaming 过程中停止生成', async ({ page }) => {
    await setupPage(page)

    // 4.1 发送一个复杂问题
    const textarea = page.locator('textarea')
    await textarea.fill('详细解释量子计算的原理和应用')
    const sendButton = page.locator('[data-testid="send-btn"]')
    await sendButton.click()
    await page.screenshot({ path: `${ARTIFACTS_DIR}/04-01-complex-question-sent.png` })

    // 4.2 验证停止按钮出现（红色背景按钮，包含 rect SVG）
    // isStreaming=true 时，InputBar 显示停止按钮（bg-red-50 + svg rect）
    const stopButton = page.locator('[data-testid="stop-btn"]')
    await expect(stopButton).toBeVisible({ timeout: 3000 })
    await page.screenshot({ path: `${ARTIFACTS_DIR}/04-02-stop-button-visible.png` })
    console.log('[测试4] 停止按钮已出现')

    // 4.3 模拟一些 streaming 内容（但不发送 stream-end）
    const partialText = '量子计算是一种利用量子力学原理进行信息处理的计算方式。与经典计算机使用比特（0或1）不同，量子计算机使用量子比特（qubit），'
    for (let i = 0; i < partialText.length; i += 8) {
      const chunk = partialText.slice(i, i + 8)
      await page.evaluate((c) => window.__mockBus.emit('stream-chunk', '', c), chunk)
      await page.waitForTimeout(30)
    }
    await page.screenshot({ path: `${ARTIFACTS_DIR}/04-03-streaming-in-progress.png` })

    // 4.4 点击停止按钮
    await stopButton.click()
    await page.screenshot({ path: `${ARTIFACTS_DIR}/04-04-stop-clicked.png` })

    // 4.5 验证 abortChat 被调用
    const calls = await page.evaluate(() => window.__mockCalls)
    const abortCall = calls.find((c: any) => c.method === 'abortChat')
    expect(abortCall).toBeTruthy()

    // 4.6 模拟 stream-end（abort 后主进程会发送 stream-end）
    await page.evaluate(() => window.__mockBus.emit('stream-end', ''))
    await page.waitForTimeout(300)

    // 4.7 验证发送按钮恢复（停止按钮消失）
    const sendButtonAfterStop = page.locator('[data-testid="send-btn"]')
    await expect(sendButtonAfterStop).toBeVisible({ timeout: 5000 })
    await page.screenshot({ path: `${ARTIFACTS_DIR}/04-05-input-restored.png` })

    // 4.8 验证输入框可以重新输入
    await textarea.fill('测试输入')
    const inputValue = await textarea.inputValue()
    expect(inputValue).toBe('测试输入')

    console.log('[测试4] 停止按钮测试 - 全部通过')
  })
})

// ============================================================
// 测试用例 5：清空对话测试
// ============================================================
test.describe('5. 清空对话测试', () => {
  test('清空对话后恢复空状态', async ({ page }) => {
    await setupPage(page)

    // 5.1 先发送一条消息
    const textarea = page.locator('textarea')
    await textarea.fill('你好')
    const sendButton = page.locator('[data-testid="send-btn"]')
    await sendButton.click()

    // 5.2 模拟 AI 回复
    await simulateStreamReply(page, '你好！有什么可以帮助你的吗？')

    // 5.3 等待 assistant 消息渲染
    const assistantMessage = page.locator('.prose-light')
    await expect(assistantMessage.last()).toBeVisible({ timeout: 5000 })
    await page.screenshot({ path: `${ARTIFACTS_DIR}/05-01-has-messages.png` })

    // 5.4 验证有消息内容
    const userMsg = page.locator('text=你好')
    await expect(userMsg.first()).toBeVisible()

    // 5.5 点击新建对话按钮（Sidebar「新建对话」入口；旧 button[title="Cmd+N"] 选择器已死）
    const newConvButton = page.locator('button', { hasText: '新建对话' })
    await newConvButton.click()
    await page.waitForTimeout(500)
    await page.screenshot({ path: `${ARTIFACTS_DIR}/05-02-after-clear.png` })

    // 5.6 验证回到 WelcomePage —— 新架构下清空/新建后停在欢迎页(onboarding 块已删,
    // 用 WelcomePage 特征输入框 placeholder 断言)
    const welcomeInput = page.locator('textarea[placeholder*="分配一个任务"]')
    await expect(welcomeInput).toBeVisible({ timeout: 5000 })
    await page.screenshot({ path: `${ARTIFACTS_DIR}/05-03-empty-state-restored.png` })

    // 5.9 验证 assistant 消息已不存在
    await expect(page.locator('.prose-light')).toHaveCount(0)

    console.log('[测试5] 清空对话测试 - 全部通过')
  })
})

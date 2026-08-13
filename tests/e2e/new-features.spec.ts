import { test, expect, Page } from '@playwright/test'
import { bootstrapChat } from './helpers'

const ARTIFACTS_DIR = 'tests/artifacts/new-features'

// ============================================================
// Mock：已选角色状态（正常使用）
// ============================================================
const MOCK_WITH_ROLE = `
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
window.api = {
  getLocaleState: async () => ({ preference: 'zh-CN', locale: 'zh-CN' }),
  sendChat: (messages) => { window.__mockCalls.push({ method: 'sendChat', args: messages }); },
  abortChat: () => { window.__mockCalls.push({ method: 'abortChat' }); },
  onStreamChunk: (cb) => window.__mockBus.on('stream-chunk', cb),
  onStreamEnd: (cb) => window.__mockBus.on('stream-end', cb),
  onTextFlush: (cb) => window.__mockBus.on('text-flush', cb),
  onToolStart: (cb) => window.__mockBus.on('tool-start', cb),
  onToolEnd: (cb) => window.__mockBus.on('tool-end', cb),
  onAskUser: (cb) => window.__mockBus.on('ask-user', cb),
  onTargetStatus: (cb) => window.__mockBus.on('target-status', cb),
  onAppChanged: (cb) => window.__mockBus.on('app-changed', cb),
  pasteToTarget: async () => ({ success: true }),
  getRoleInitState: async () => ({
    hasRole: true,
    role: { name: 'learner', displayName: '学习助手', icon: '📖' }
  }),
  getAllRoles: async () => [
    { name: 'learner', displayName: '学习助手', icon: '📖' },
    { name: 'teacher', displayName: '教师助手', icon: '🎓' },
    { name: 'office', displayName: '办公助手', icon: '💼' }
  ],
  getCurrentRole: async () => ({ name: 'learner', displayName: '学习助手', icon: '📖' }),
  switchRole: async (name) => {
    const map = {
      learner: { name: 'learner', displayName: '学习助手', icon: '📖' },
      teacher: { name: 'teacher', displayName: '教师助手', icon: '🎓' },
      office: { name: 'office', displayName: '办公助手', icon: '💼' }
    };
    window.__mockCalls.push({ method: 'switchRole', args: name });
    return map[name] || map.learner;
  },
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

// ============================================================
// 辅助函数
// ============================================================
async function setupWithRole(page: Page) {
  await page.addInitScript({ content: MOCK_WITH_ROLE })
  await page.goto('/')
  await page.waitForLoadState('networkidle')
  // App 启动停在 WelcomePage(messages 为空)——bootstrapChat 建会话 + 塞一条初始消息
  // 把 WelcomePage 挤掉,让 ChatPanel 挂载。
  await bootstrapChat(page, {
    role: 'learner',
    messages: [{ id: 'msg-init', role: 'user', content: '初始化', timestamp: Date.now() - 60000 }]
  })
}

// ============================================================
// 阶段二：记忆系统（模拟工具调用）
// ============================================================
test.describe('阶段二：本地持久记忆', () => {
  test('TC-2.1 save_memory 工具卡片正确展示', async ({ page }) => {
    await setupWithRole(page)

    // 发消息
    const textarea = page.locator('textarea')
    await textarea.fill('帮我解释特征值分解')
    const sendButton = page.locator('[data-testid="send-btn"]')
    await sendButton.click()

    // 模拟 AI 先回复一段文字
    await page.evaluate(() => window.__mockBus.emit('stream-chunk', '', '特征值分解是线性代数的重要概念...'))
    await page.evaluate(() => window.__mockBus.emit('text-flush', ''))
    await page.waitForTimeout(100)

    // 模拟 save_memory 工具调用
    await page.evaluate(() => window.__mockBus.emit('tool-start', '', 'save_memory'))
    await page.waitForTimeout(200)
    await page.evaluate(() => window.__mockBus.emit(
      'tool-end', '', 'save_memory', undefined, undefined,
      '已保存记忆：线性代数 — 学习了特征值分解的概念',
      '{"topic":"线性代数","summary":"学习了特征值分解","tags":["math"]}'
    ))
    await page.waitForTimeout(200)

    // 继续 AI 回复
    await page.evaluate(() => window.__mockBus.emit('stream-chunk', '', '我已经帮你记住了。'))
    await page.evaluate(() => window.__mockBus.emit('stream-end', ''))
    await page.waitForTimeout(300)

    // turn 完成后过程性消息(含无交付物标记的 tool)按 focus 模式折进 ProcessGroup——先展开
    await page.locator('[data-testid="process-group-toggle"]').first().click()
    await page.waitForTimeout(200)

    // 工具卡片可见
    const toolCard = page.locator('text=保存记忆').first()
    await expect(toolCard).toBeVisible({ timeout: 3000 })

    await page.screenshot({ path: `${ARTIFACTS_DIR}/tc-2.1-save-memory.png` })
    console.log('[TC-2.1] save_memory 工具卡片 - 通过')
  })

  test('TC-2.3 recall_memory 工具卡片正确展示', async ({ page }) => {
    await setupWithRole(page)

    const textarea = page.locator('textarea')
    await textarea.fill('我上次学到哪了？')
    const sendButton = page.locator('[data-testid="send-btn"]')
    await sendButton.click()

    // 模拟 recall_memory 工具调用
    await page.evaluate(() => window.__mockBus.emit('tool-start', '', 'recall_memory'))
    await page.waitForTimeout(200)
    await page.evaluate(() => window.__mockBus.emit(
      'tool-end', '', 'recall_memory', undefined, undefined,
      '[2024/3/15] 线性代数：学习了特征值分解的概念和几何意义\n  待解决：实际应用场景？\n  标签：math, linear-algebra',
      '{"query":"学习"}'
    ))
    await page.waitForTimeout(200)

    // AI 基于记忆回复
    await page.evaluate(() => window.__mockBus.emit('stream-chunk', '', '根据记忆，你上次学习了线性代数的特征值分解。'))
    await page.evaluate(() => window.__mockBus.emit('stream-end', ''))
    await page.waitForTimeout(300)

    // turn 完成后过程性消息按 focus 模式折进 ProcessGroup——先展开
    await page.locator('[data-testid="process-group-toggle"]').first().click()
    await page.waitForTimeout(200)

    // 工具卡片可见
    const toolCard = page.locator('text=回忆记忆')
    await expect(toolCard).toBeVisible({ timeout: 3000 })

    // 点击展开卡片
    await toolCard.click()
    await page.waitForTimeout(300)

    // 展开后可见记忆内容
    const content = page.locator('text=线性代数')
    await expect(content.first()).toBeVisible()

    await page.screenshot({ path: `${ARTIFACTS_DIR}/tc-2.3-recall-memory.png` })
    console.log('[TC-2.3] recall_memory 工具卡片 - 通过')
  })
})

// ============================================================
// 阶段三：学习产出系统
// ============================================================
test.describe('阶段三：学习产出系统', () => {
  test('TC-3.1 generate_document 文档卡片展示', async ({ page }) => {
    await setupWithRole(page)

    const textarea = page.locator('textarea')
    await textarea.fill('帮我整理学习笔记')
    const sendButton = page.locator('[data-testid="send-btn"]')
    await sendButton.click()

    // 模拟 recall_memory
    await page.evaluate(() => window.__mockBus.emit('tool-start', '', 'recall_memory'))
    await page.waitForTimeout(100)
    await page.evaluate(() => window.__mockBus.emit(
      'tool-end', '', 'recall_memory', undefined, undefined,
      '[2024/3/15] 线性代数：特征值分解',
      '{"query":""}'
    ))
    await page.waitForTimeout(100)

    // 模拟 generate_document
    await page.evaluate(() => window.__mockBus.emit('tool-start', '', 'generate_document'))
    await page.waitForTimeout(200)

    const docContent = `📄 已生成学习笔记「本周学习总结」
保存位置: ~/.openpipal/outputs/2024-03-15_本周学习总结.md

---

# 本周学习总结

## 线性代数

### 特征值分解
- **定义**：将矩阵分解为特征向量和特征值的乘积
- **几何意义**：特征向量是线性变换中方向不变的向量
- **公式**：A = PDP⁻¹

### 待复习
- 特征值分解的实际应用场景
- SVD 与特征值分解的关系`

    await page.evaluate((content) => window.__mockBus.emit(
      'tool-end', '', 'generate_document', undefined, undefined,
      content,
      '{"title":"本周学习总结","content":"...","docType":"学习笔记"}'
    ), docContent)
    await page.waitForTimeout(200)

    // AI 回复
    await page.evaluate(() => window.__mockBus.emit('stream-chunk', '', '已生成学习笔记，你可以复制到 Notion。'))
    await page.evaluate(() => window.__mockBus.emit('stream-end', ''))
    await page.waitForTimeout(500)

    // turn 完成后过程性消息(含 generate_document 工具卡)按 focus 模式折进 ProcessGroup——先展开
    await page.locator('[data-testid="process-group-toggle"]').first().click()
    await page.waitForTimeout(200)

    // 文档卡片可见（brand 颜色背景）
    const docCard = page.locator('text=📄')
    await expect(docCard.first()).toBeVisible({ timeout: 3000 })

    await page.screenshot({ path: `${ARTIFACTS_DIR}/tc-3.1-doc-card.png` })

    // 文档默认展开，内容可见
    const heading = page.locator('text=本周学习总结')
    await expect(heading.first()).toBeVisible()

    // Markdown 渲染正确（h2 标签）
    const h2 = page.locator('h2', { hasText: '线性代数' })
    await expect(h2).toBeVisible()

    console.log('[TC-3.1] 文档卡片展示 - 通过')
  })

  test('TC-3.2 文档卡片有复制按钮', async ({ page }) => {
    await setupWithRole(page)

    const textarea = page.locator('textarea')
    await textarea.fill('生成笔记')
    const sendButton = page.locator('[data-testid="send-btn"]')
    await sendButton.click()

    // 直接模拟 generate_document 结果
    await page.evaluate(() => window.__mockBus.emit('tool-start', '', 'generate_document'))
    await page.waitForTimeout(100)
    await page.evaluate(() => window.__mockBus.emit(
      'tool-end', '', 'generate_document', undefined, undefined,
      '📄 测试文档\n---\n# 标题\n内容正文',
      '{"title":"测试","content":"# 标题\\n内容","docType":"学习笔记"}'
    ))
    await page.waitForTimeout(100)
    await page.evaluate(() => window.__mockBus.emit('stream-end', ''))
    await page.waitForTimeout(500)

    // turn 完成后过程性消息按 focus 模式折进 ProcessGroup——先展开
    await page.locator('[data-testid="process-group-toggle"]').first().click()
    await page.waitForTimeout(200)

    // 复制按钮可见
    const copyBtn = page.locator('button', { hasText: '复制' })
    await expect(copyBtn.first()).toBeVisible({ timeout: 3000 })

    await page.screenshot({ path: `${ARTIFACTS_DIR}/tc-3.2-copy-btn.png` })
    console.log('[TC-3.2] 文档复制按钮 - 通过')
  })

  test('TC-3.3 文档卡片可折叠', async ({ page }) => {
    await setupWithRole(page)

    const textarea = page.locator('textarea')
    await textarea.fill('生成笔记')
    const sendButton = page.locator('[data-testid="send-btn"]')
    await sendButton.click()

    await page.evaluate(() => window.__mockBus.emit('tool-start', '', 'generate_document'))
    await page.waitForTimeout(100)
    await page.evaluate(() => window.__mockBus.emit(
      'tool-end', '', 'generate_document', undefined, undefined,
      '📄 折叠测试\n---\n# 折叠内容\n这段应该可以折叠',
      '{"title":"折叠测试","content":"# 折叠内容","docType":"其他"}'
    ))
    await page.waitForTimeout(100)
    await page.evaluate(() => window.__mockBus.emit('stream-end', ''))
    await page.waitForTimeout(500)

    // turn 完成后过程性消息按 focus 模式折进 ProcessGroup——先展开
    await page.locator('[data-testid="process-group-toggle"]').first().click()
    await page.waitForTimeout(200)

    // 默认展开，内容可见
    const content = page.locator('text=折叠内容')
    await expect(content.first()).toBeVisible({ timeout: 3000 })

    // 点击标题折叠
    const header = page.locator('text=📄 折叠测试')
    await header.click()
    await page.waitForTimeout(300)

    // 折叠后内容隐藏
    const copyBtn = page.locator('button', { hasText: '复制' })
    await expect(copyBtn).toHaveCount(0)

    // 再点击展开
    await header.click()
    await page.waitForTimeout(300)
    await expect(page.locator('button', { hasText: '复制' }).first()).toBeVisible()

    await page.screenshot({ path: `${ARTIFACTS_DIR}/tc-3.3-collapsible.png` })
    console.log('[TC-3.3] 文档折叠展开 - 通过')
  })
})

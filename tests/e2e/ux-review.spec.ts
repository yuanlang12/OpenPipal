/**
 * UX Review — 自动化截图采集
 *
 * 这不是功能测试，而是为 UX 评估专家提供截图证据。
 * 模拟真实用户操作，每步截图，保存到 tests/artifacts/ux-review/
 */
import { test, expect, Page } from '@playwright/test'

const DIR = 'tests/artifacts/ux-review'

// 复用 phase1-ui 的 mock（包含所有需要的 API）
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
    const map = { learner: { name: 'learner', displayName: '学习助手', icon: '📖' }, teacher: { name: 'teacher', displayName: '教师助手', icon: '🎓' }, office: { name: 'office', displayName: '办公助手', icon: '💼' } };
    return map[name] || map.learner;
  },
  listConversations: async () => [],
  createConversation: async (role) => ({ id: 'c-' + Date.now(), title: '新对话', role, createdAt: Date.now(), updatedAt: Date.now(), messageCount: 0 }),
  getConversationMessages: async () => [],
  replaceMessages: async () => {},
  appendMessages: async () => {},
  deleteConversation: async () => {},
  getAppSettings: async () => ({ detected: ['Xcode', 'Notion', 'WPS Office'], disabled: ['WPS Office'], browsers: ['Google Chrome', 'Safari'] }),
  setDisabledApps: async () => {},
  isCustomConfig: async () => ({ isCustom: false }),
  getModelConfig: async () => ({ provider: 'openai', baseUrl: '', apiKey: 'sk-***', model: 'gpt-4o' }),
  getModelConfigFull: async () => ({ provider: 'openai', baseUrl: '', apiKey: 'sk-test', model: 'gpt-4o' }),
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

async function setup(page: Page, mock = MOCK_API) {
  await page.addInitScript({ content: mock })
  await page.goto('/')
  await page.waitForLoadState('networkidle')
}

async function streamReply(page: Page, text: string) {
  for (let i = 0; i < text.length; i += 15) {
    await page.evaluate((c) => window.__mockBus.emit('stream-chunk', '', c), text.slice(i, i + 15))
    await page.waitForTimeout(30)
  }
  await page.evaluate(() => window.__mockBus.emit('stream-end', ''))
  await page.waitForTimeout(300)
}

// ============================================================
// 场景 1：侧栏模式（420x700）完整流程
// ============================================================
test.describe('UX Review — 侧栏模式 420x700', () => {
  test.use({ viewport: { width: 420, height: 700 } })

  test('完整用户旅程截图', async ({ page }) => {
    // 1. 启动 —— 直接停在 WelcomePage(不再有首启角色选择页阻断流程,角色选择已整合进
    // WelcomePage 自己的头像群，无需单独的"选择角色→开始使用"步骤)
    await setup(page)
    await page.waitForSelector('[data-testid="send-btn"]', { timeout: 5000 })
    await page.screenshot({ path: `${DIR}/01-welcome-page.png`, fullPage: true })

    // 2. 发送第一条消息
    await page.locator('textarea').fill('你好，帮我解释一下什么是机器学习')
    await page.screenshot({ path: `${DIR}/02-typing.png`, fullPage: true })
    await page.locator('[data-testid="send-btn"]').click()
    await page.waitForTimeout(300)
    await page.screenshot({ path: `${DIR}/03-message-sent-thinking.png`, fullPage: true })

    // 3. AI 回复（流式）
    await streamReply(page, '机器学习是人工智能的一个分支，它让计算机系统能够从数据中学习和改进，而不需要被明确编程。\n\n**核心概念：**\n- 监督学习：用标注数据训练\n- 无监督学习：发现数据中的模式\n- 强化学习：通过奖惩机制学习')
    await page.screenshot({ path: `${DIR}/04-ai-reply.png`, fullPage: true })

    // 4. 工具调用
    await page.locator('textarea').fill('帮我搜索最新的 AI 新闻')
    await page.locator('[data-testid="send-btn"]').click()
    await page.waitForTimeout(200)
    await page.evaluate(() => window.__mockBus.emit('tool-start', '', 'web_search'))
    await page.waitForTimeout(500)
    await page.screenshot({ path: `${DIR}/05-tool-executing.png`, fullPage: true })

    // 工具完成
    await page.evaluate(() => window.__mockBus.emit('text-flush', ''))
    await page.evaluate(() => window.__mockBus.emit(
      'tool-end', '', 'web_search', undefined, '1. GPT-5 发布预告\n2. Claude 4 更新\n3. Gemini 2.5 Pro 上线'
    ))
    await page.waitForTimeout(200)
    await streamReply(page, '根据搜索结果，最近的 AI 新闻有：\n\n1. **GPT-5** 即将发布\n2. **Claude 4** 有重大更新\n3. **Gemini 2.5 Pro** 已上线')
    await page.screenshot({ path: `${DIR}/06-tool-result.png`, fullPage: true })

    // 5. 再发一条带工具卡片的
    await page.locator('textarea').fill('记住这个知识点')
    await page.locator('[data-testid="send-btn"]').click()
    await page.waitForTimeout(200)
    await page.evaluate(() => window.__mockBus.emit('tool-start', '', 'save_memory'))
    await page.waitForTimeout(300)
    await page.evaluate(() => window.__mockBus.emit('text-flush', ''))
    await page.evaluate(() => window.__mockBus.emit(
      'tool-end', '', 'save_memory', undefined, undefined,
      '成功保存记忆：机器学习基础概念 — 监督/无监督/强化学习三种类型',
      '{"topic":"机器学习","summary":"基础概念"}'
    ))
    await page.waitForTimeout(200)
    await streamReply(page, '好的，我已经记住了。下次你问到相关内容时我会参考这个知识点。')
    await page.screenshot({ path: `${DIR}/07-tool-card-collapsed.png`, fullPage: true })

    // 6. 设置面板 —— 现为整页六 Tab 布局(旧浮层三 Tab 面板已删),入口是 Sidebar 底部「设置」
    await page.getByRole('button', { name: '设置' }).click()
    await page.waitForTimeout(300)
    await page.screenshot({ path: `${DIR}/08-settings-appearance-tab.png`, fullPage: true })

    await page.locator('button', { hasText: '应用' }).click()
    await page.waitForTimeout(200)
    await page.screenshot({ path: `${DIR}/09-settings-apps-tab.png`, fullPage: true })

    await page.locator('button', { hasText: '关于' }).click()
    await page.waitForTimeout(200)
    await page.screenshot({ path: `${DIR}/10-settings-about-tab.png`, fullPage: true })

    console.log('[UX Review] 侧栏模式截图完成：10 张')
  })
})

// ============================================================
// 场景 2：独立窗口模式（900x700）
// ============================================================
test.describe('UX Review — 独立窗口模式 900x700', () => {
  test.use({ viewport: { width: 900, height: 700 } })

  test('独立窗口布局截图', async ({ page }) => {
    await setup(page)
    await page.waitForSelector('textarea', { timeout: 5000 })

    // 空状态
    await page.screenshot({ path: `${DIR}/14-wide-empty-state.png`, fullPage: true })

    // 发消息 + 回复
    await page.locator('textarea').fill('帮我写一封工作周报')
    await page.locator('[data-testid="send-btn"]').click()
    await streamReply(page, '好的，这是本周工作周报的初稿：\n\n## 本周工作总结\n\n### 已完成\n- 完成了用户管理模块的开发\n- 修复了 3 个线上 bug\n- 参加了产品评审会议\n\n### 下周计划\n- 开始订单系统重构\n- 性能优化')
    await page.screenshot({ path: `${DIR}/15-wide-with-messages.png`, fullPage: true })

    // 设置（整页六 Tab 布局，入口是 Sidebar 底部「设置」；旧 settings-btn testid 已删）
    await page.getByRole('button', { name: '设置' }).click()
    await page.waitForTimeout(300)
    await page.screenshot({ path: `${DIR}/16-wide-settings.png`, fullPage: true })

    console.log('[UX Review] 独立窗口模式截图完成：3 张')
  })
})

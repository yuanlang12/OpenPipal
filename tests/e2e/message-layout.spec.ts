import { test, expect, Page } from '@playwright/test'

const ARTIFACTS_DIR = 'tests/artifacts/message-layout'

/**
 * 消息体布局回归 — 守护两条用户明确要求、且历史上反复回归的视觉规范:
 *
 *  1. 用户消息靠右(左右布局):MessageBubble 在 isUser 时外层 flex = justify-end
 *  2. ProcessGroup 展开后 thinking 平铺,不再"套娃"(组内不套第二层折叠):
 *     thinking 渲染为扁平暗色文本 div([data-testid=process-thinking-flat]),
 *     不是带 chevron 的可折叠卡片。
 *
 * 纯 view 层断言 — 通过 window.__chatStore.setState 直接注入一轮完整对话,
 * 不依赖真实 main 进程(沿用 pending-messages.spec 的注入技法)。
 */
const MOCK_API = `
window.__mockBus = { listeners: {}, on(e, fn){ (this.listeners[e]=this.listeners[e]||[]).push(fn); return () => {} }, emit(e, ...args){ (this.listeners[e]||[]).forEach(fn => fn(...args)) } };
window.api = {
  getLocaleState: async () => ({ preference: 'zh-CN', locale: 'zh-CN' }),
  sendChat: () => {}, abortChat: () => {},
  onStreamChunk: (fn) => window.__mockBus.on('stream-chunk', fn), onStreamEnd: () => () => {},
  onTextFlush: () => () => {}, onToolStart: () => () => {}, onToolEnd: () => () => {},
  onToolProgress: () => () => {}, onAskUser: () => () => {}, onQuestionsV2: () => () => {},
  onArtifact: () => () => {}, onArtifactDelta: () => () => {}, onArtifactComplete: () => () => {},
  onVisualizer: () => () => {}, onVisualizerDelta: () => () => {}, onMcpAppInline: () => () => {},
  onTargetStatus: () => () => {}, onAppChanged: () => () => {}, onMemoryUpdated: () => () => {},
  onConvTitleUpdated: () => () => {}, onInlinePermission: () => () => {}, onPermissionRequest: () => () => {},
  onThinking: () => () => {}, onThinkingEnd: () => () => {},
  respondPermission: () => {}, pasteToTarget: async () => ({ success: true }), hasApiKey: async () => ({ hasKey: true }),
  getRoleInitState: async () => ({ hasRole: true, role: { name: 'learner', displayName: '学习助手', icon: '📖' } }),
  getAllRoles: async () => [{ name: 'learner', displayName: '学习助手', icon: '📖' }],
  getCurrentRole: async () => ({ name: 'learner', displayName: '学习助手', icon: '📖' }),
  switchRole: async () => ({ name: 'learner', displayName: '学习助手', icon: '📖' }),
  listConversations: async () => [],
  createConversation: async (role) => ({ id: 'conv-layout', title: '布局测试', role, createdAt: Date.now(), updatedAt: Date.now(), messageCount: 0 }),
  getConversationMessages: async () => [],
  replaceMessages: async () => {}, appendMessages: async () => {}, deleteConversation: async () => {},
  getAppSettings: async () => ({ detected: [], disabled: [], browsers: [] }), setDisabledApps: async () => {},
  getModelConfig: async () => ({ provider: 'openai', baseUrl: '', apiKey: '', model: '' }), saveModelConfig: async () => {},
  getModelConfigFull: async () => ({ provider: 'openai', baseUrl: '', apiKey: '', model: '' }),
  isCustomConfig: async () => ({ isCustom: false }), getAvailableModels: async () => [],
  testConnection: async () => ({ ok: true, model: 'gpt-4o' }), getProviders: async () => ({}), clearModelConfig: async () => {},
  getMemoryConfig: async () => ({ enabled: true }), setMemoryConfig: async () => {},
  getVersion: async () => '0.0.0-test', getAgents: async () => [], listSkills: async () => [],
  listWorkspaces: async () => [], listAgentTemplates: async () => [],
  getOnboardingStatus: async () => ({ completed: true }), setOnboardingCompleted: async () => {},
  getRealtimeConfig: async () => ({ provider: 'openai', url: '', model: '', deployment: '', apiVersion: '', voice: 'alloy', hasKey: false }),
  steerChat: async () => ({ ok: true }), queueChat: async () => ({ ok: true }),
  getSources: async () => [], listModelPresets: async () => []
};
`

const USER_TEXT = '帮我查一下北京今天的天气'
const THINK_TEXT = '用户想要北京的天气,我需要调用搜索工具确认实时数据。'
const FINAL_TEXT = '北京今天晴,气温 25°C,适合外出。'

async function setupTurn(page: Page): Promise<void> {
  await page.addInitScript({ content: MOCK_API })
  await page.goto('/')
  await page.waitForLoadState('networkidle')
  await page.evaluate(async (texts) => {
    const store = (window as any).__chatStore
    await store.getState().newConversation('learner')
    const now = Date.now()
    // 一轮完整对话:user → thinking(过程) → tool(过程) → assistant 最终
    store.setState({
      isStreaming: false,
      messages: [
        { id: 'u1', role: 'user', content: texts.user, timestamp: now, messageKind: 'user' },
        { id: 't1', role: 'assistant', content: '', thinkingContent: texts.think, timestamp: now + 100, messageKind: 'thinking' },
        { id: 'tool1', role: 'tool', toolName: 'web_search', content: '成功: 找到北京天气数据', timestamp: now + 200, messageKind: 'tool' },
        { id: 'a1', role: 'assistant', content: texts.final, timestamp: now + 300, messageKind: 'assistant' },
      ]
    })
  }, { user: USER_TEXT, think: THINK_TEXT, final: FINAL_TEXT })
  await page.waitForSelector('[data-testid="process-group"]', { timeout: 8000 })
}

test.use({ viewport: { width: 460, height: 760 } })

test.describe('消息体布局', () => {
  test('用户消息靠右(isUser → justify-end)', async ({ page }) => {
    await setupTurn(page)
    // 用户文本所在的 MessageBubble 外层 flex 容器带 justify-end
    const userRow = page.locator('.justify-end', { hasText: USER_TEXT }).first()
    await expect(userRow).toBeVisible()
    // 反向保险:assistant 最终文本不在 justify-end 容器里(它是裸文本靠左填满列)
    await expect(page.locator('.justify-end', { hasText: FINAL_TEXT })).toHaveCount(0)
  })

  test('ProcessGroup 默认折叠,展开后 thinking 平铺(无套娃折叠)', async ({ page }) => {
    await setupTurn(page)

    const toggle = page.locator('[data-testid="process-group-toggle"]')
    await expect(toggle).toBeVisible()
    await expect(toggle).toContainText('已处理')
    // 折叠态:thinking 文本不可见
    await expect(page.locator('[data-testid="process-thinking-flat"]')).toHaveCount(0)

    // 展开
    await toggle.click()
    const flat = page.locator('[data-testid="process-thinking-flat"]')
    await expect(flat).toBeVisible()
    await expect(flat).toContainText(THINK_TEXT)

    // 关键:thinking 是扁平 div,不是 <button>(否则就是又一层折叠 = 套娃)
    const tag = await flat.evaluate(el => el.tagName)
    expect(tag).toBe('DIV')
    // thinking 的祖先链里不应再有 button(确认它没被包进可折叠卡片)
    const wrappedInButton = await flat.evaluate(el => !!el.closest('button'))
    expect(wrappedInButton).toBe(false)

    await page.screenshot({ path: `${ARTIFACTS_DIR}/01-expanded-flat.png` })
  })

  test('历史列表角色图标用 Lucide(非 emoji)', async ({ page }) => {
    await page.addInitScript({ content: MOCK_API })
    await page.goto('/')
    await page.waitForLoadState('networkidle')
    await page.evaluate(async () => {
      const store = (window as any).__chatStore
      await store.getState().newConversation('learner')
      const now = Date.now()
      // 注入两条不同角色的历史会话,让侧栏历史列表渲染角色图标
      store.setState({
        isStreaming: false,
        conversations: [
          { id: 'c-learner', title: '学习助手会话', role: 'learner', updatedAt: now, createdAt: now, messageCount: 2 },
          { id: 'c-teacher', title: '老师会话', role: 'teacher', updatedAt: now, createdAt: now, messageCount: 2 },
        ]
      })
    })

    const learnerRow = page.locator('button', { hasText: '学习助手会话' }).first()
    await expect(learnerRow).toBeVisible()
    // 角色图标渲染为 Lucide <svg>,不是 emoji 文本
    await expect(learnerRow.locator('svg').first()).toBeVisible()
    const rowText = (await learnerRow.innerText()) || ''
    // 不应再出现角色 emoji
    expect(rowText).not.toContain('📖')
    expect(rowText).not.toContain('🎓')
    expect(rowText).not.toContain('💬')

    await page.screenshot({ path: `${ARTIFACTS_DIR}/02-history-lucide.png` })
  })
})

/**
 * Focus 模式 — turn 完成态收敛回归。
 *
 * mock 一轮"完成"的 turn:user → thinking → 中间叙述(assistant 文本,非最后一条)
 * → 常规工具(process) → 交付物(create_visualizer,常显)→ 常规工具(process)
 * → 结论(assistant 文本,最后一条)。
 *
 * 真实顺序拆出的 segments:
 *   process[thinking, 中间叙述, tool1] → final[交付物] → process[tool2] → final[结论]
 * focus 开:groupTurns 的 processMsgs(4条)合一条摘要;focus 关:按 segments 顺序渲染 → 2 条摘要条(交付物前后各一)。
 */
const NARRATION_TEXT = '让我先分析一下数据结构'
const CONCLUSION_TEXT = '图表做好了,数据也整理好了'
const VISUALIZER_HTML = '<html><body style="margin:0"><svg width="100" height="60"><rect width="100" height="60" fill="steelblue"/></svg></body></html>'

async function setupFocusTurn(page: Page): Promise<void> {
  await page.addInitScript({ content: MOCK_API })
  await page.goto('/')
  await page.waitForLoadState('networkidle')
  await page.evaluate(async ({ narration, conclusion, html }) => {
    const store = (window as any).__chatStore
    await store.getState().newConversation('learner')
    const now = Date.now()
    store.setState({
      isStreaming: false,
      messages: [
        { id: 'fu1', role: 'user', content: '帮我整理一下这个页面的数据,并做个图', timestamp: now, messageKind: 'user' },
        { id: 'ft1', role: 'assistant', content: '', thinkingContent: '先看看结构', timestamp: now + 100, messageKind: 'thinking' },
        { id: 'fa1', role: 'assistant', content: narration, timestamp: now + 200, messageKind: 'assistant' },
        { id: 'ftool1', role: 'tool', toolName: 'web_search', content: '成功: 拿到数据', timestamp: now + 300, messageKind: 'tool' },
        { id: 'fviz', role: 'tool', toolName: 'create_visualizer', content: '成功: 已生成图表', visualizerHtml: html, timestamp: now + 400, messageKind: 'tool' },
        { id: 'ftool2', role: 'tool', toolName: 'bash', content: '成功: 已整理完毕', timestamp: now + 500, messageKind: 'tool' },
        { id: 'fa2', role: 'assistant', content: conclusion, timestamp: now + 600, messageKind: 'assistant' },
      ]
    })
  }, { narration: NARRATION_TEXT, conclusion: CONCLUSION_TEXT, html: VISUALIZER_HTML })
  await page.waitForSelector('[data-testid="process-group-toggle"]', { timeout: 8000 })
}

test.describe('Focus 模式:turn 完成态收敛', () => {
  test('F1: 完成 turn 收敛态 — 台面只有 user/摘要条/交付物/结论,中间叙述不可见', async ({ page }) => {
    await setupFocusTurn(page)

    // 默认开(localStorage 无键时开)—— 开关按钮 aria-pressed=true
    const toggle = page.locator('[data-testid="focus-stream-toggle"]')
    await expect(toggle).toHaveAttribute('aria-pressed', 'true')

    // 收敛态:只有一条摘要条(该 turn 全部过程合一条)
    await expect(page.locator('[data-testid="process-group-toggle"]')).toHaveCount(1)

    // 交付物(可视化)常显
    await expect(page.locator('iframe')).toBeVisible()

    // 结论可见
    await expect(page.getByText(CONCLUSION_TEXT)).toBeVisible()

    // 中间叙述折进过程,收起态不可见
    await expect(page.getByText(NARRATION_TEXT)).toHaveCount(0)

    await page.screenshot({ path: `${ARTIFACTS_DIR}/F1-focus-collapsed.png` })
  })

  test('F2: 展开摘要条后中间叙述与工具按序平铺(无套娃)', async ({ page }) => {
    await setupFocusTurn(page)

    const toggle = page.locator('[data-testid="process-group-toggle"]')
    await toggle.click()

    await expect(page.getByText(NARRATION_TEXT)).toBeVisible()
    await expect(page.locator('[data-testid="process-thinking-flat"]')).toBeVisible()

    // 顺序:thinking → 中间叙述 → tool1 → tool2(真实顺序,展开后完整可读,信息不丢)
    const tops = await page.evaluate((narration) => {
      const think = document.querySelector('[data-testid="process-thinking-flat"]') as HTMLElement | null
      const all = Array.from(document.querySelectorAll('*')) as HTMLElement[]
      const narrationEl = all.find(e => e.children.length === 0 && e.textContent?.trim() === narration)
      return {
        think: think ? think.getBoundingClientRect().top : -1,
        narration: narrationEl ? narrationEl.getBoundingClientRect().top : -1
      }
    }, NARRATION_TEXT)
    expect(tops.think).toBeGreaterThan(0)
    expect(tops.narration).toBeGreaterThan(0)
    expect(tops.think).toBeLessThan(tops.narration)

    await page.screenshot({ path: `${ARTIFACTS_DIR}/F2-expanded-interleaved.png` })
  })

  test('F3: 关闭 focus 开关后,交错渲染恢复(2 条摘要条),叙述仍在过程组内', async ({ page }) => {
    await setupFocusTurn(page)

    // 关闭前:收敛态,1 条摘要条
    await expect(page.locator('[data-testid="process-group-toggle"]')).toHaveCount(1)

    const focusToggle = page.locator('[data-testid="focus-stream-toggle"]')
    await focusToggle.click()
    await expect(focusToggle).toHaveAttribute('aria-pressed', 'false')

    // 关闭后:按真实顺序渲染 segments —— 交付物前后各一段 process,恢复成 2 条摘要条
    await expect(page.locator('[data-testid="process-group-toggle"]')).toHaveCount(2)

    // 叙述依然折在过程组里,不再单独平铺出来
    await expect(page.getByText(NARRATION_TEXT)).toHaveCount(0)

    // 交付物仍然可见,结论仍然可见
    await expect(page.locator('iframe')).toBeVisible()
    await expect(page.getByText(CONCLUSION_TEXT)).toBeVisible()

    await page.screenshot({ path: `${ARTIFACTS_DIR}/F3-focus-off-interleaved.png` })
  })

  test('F4: 交付物(visualizer)在收敛态仍常显', async ({ page }) => {
    await setupFocusTurn(page)

    const toggle = page.locator('[data-testid="focus-stream-toggle"]')
    await expect(toggle).toHaveAttribute('aria-pressed', 'true')

    // 未展开摘要条的情况下,交付物卡片(iframe)依然可见 —— 不随过程折叠
    await expect(page.locator('[data-testid="process-thinking-flat"]')).toHaveCount(0)
    await expect(page.locator('iframe')).toBeVisible()

    await page.screenshot({ path: `${ARTIFACTS_DIR}/F4-deliverable-always-visible.png` })
  })

  test('F5: 流式 token 不重建 messages 数组(锁 groupTurns 只在提交边界重算的性能不变量)', async ({ page }) => {
    await setupTurn(page)
    // ChatPanel 的 turns useMemo 只依赖 [messages, isStreaming]:只要 token 流不动 messages
    // 引用,O(n) 的分组就不会随每个 token 重跑。这是消除长会话流式卡顿的载重设计
    // (ChatPanel.tsx 注释明确声明),此测试防止未来有人把 tool_progress/token 写回 messages。
    const stable = await page.evaluate(() => {
      const store = (window as any).__chatStore
      const before = store.getState().messages
      for (let i = 0; i < 100; i++) {
        ;(window as any).__mockBus.emit('stream-chunk', '', `token-${i} `)
      }
      return store.getState().messages === before
    })
    expect(stable).toBe(true)
  })
})

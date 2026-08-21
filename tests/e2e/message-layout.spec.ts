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
        { id: 't1', role: 'assistant', content: '', thinkingContent: texts.think, thinkingMs: 3000, timestamp: now + 100, messageKind: 'thinking' },
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

  test('ProcessGroup 默认折叠,展开后思考为折叠行(不再平铺)', async ({ page }) => {
    await setupTurn(page)

    const toggle = page.locator('[data-testid="process-group-toggle"]')
    await expect(toggle).toBeVisible()
    // 计时分割线:完成后显示"处理完成 X 秒"
    await expect(toggle).toContainText('处理完成')
    // 折叠态:思考组不可见
    await expect(page.locator('[data-testid="process-think-group"]')).toHaveCount(0)

    // 展开 → 思考是单行折叠行(点开才见全文)
    await toggle.click()
    const thinkRow = page.locator('[data-testid="process-think-group"]')
    await expect(thinkRow).toBeVisible()
    // 思考行讲状态不讲段数:落了 thinkingMs 就写"已思考 N 秒"("· N 段"已去掉)
    await expect(thinkRow).toContainText('已思考 3 秒')
    await expect(thinkRow).not.toContainText('段')
    await expect(page.locator('text=' + THINK_TEXT)).toHaveCount(0)

    // 点开思考行 → 全文可见,且高度受 max-h 限制(不无限拉长)
    await thinkRow.locator('button').click()
    const content = thinkRow.locator('.sw-chat-reasoning')
    await expect(content).toContainText(THINK_TEXT)

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
 * → 常规工具(process) → 交付物(create_visualizer) → 常规工具(process)
 * → 结论(assistant 文本,最后一条)。
 *
 * 完成态拆出的结构(过程合一段,交付物自成一段留在真实位置):
 *   segments = process[thinking, 中间叙述, tool1, tool2] → deliverable[图表] → final[结论]
 * 所以台面恒为:user / 一条分割线 / 图表卡 / 结论 —— 图表在结论**之前**,因为它就是先产出的。
 * focus 只决定分割线默认展开与否。
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
  test('F1: 完成 turn 收敛态 — 台面只有 user/摘要条/结论/成品卡,中间叙述不可见', async ({ page }) => {
    await setupFocusTurn(page)

    // 默认开(localStorage 无键时开)—— 开关按钮 aria-pressed=true
    const toggle = page.locator('[data-testid="focus-stream-toggle"]')
    await expect(toggle).toHaveAttribute('aria-pressed', 'true')

    // 收敛态:只有一条摘要条(该 turn 全部过程合一条,交付物被摘出去不切断它)
    await expect(page.locator('[data-testid="process-group-toggle"]')).toHaveCount(1)

    // 结论可见
    await expect(page.getByText(CONCLUSION_TEXT)).toBeVisible()

    // 交付物(可视化)常显 —— 收敛态照样渲染 iframe,且按真实产出顺序排在结论**之前**。
    // 曾经统一挪到轮尾,于是模型说"卡片已生成在上面 👆"时卡片却在文字下面(用户实锤 2026-08-18)。
    await expect(page.locator('iframe')).toBeVisible()
    const order = await page.evaluate((conclusion) => {
      const all = Array.from(document.querySelectorAll('*')) as HTMLElement[]
      const conclusionEl = all.find(e => e.children.length === 0 && e.textContent?.trim() === conclusion)
      const iframe = document.querySelector('iframe') as HTMLElement | null
      return {
        conclusion: conclusionEl ? conclusionEl.getBoundingClientRect().top : -1,
        iframe: iframe ? iframe.getBoundingClientRect().top : -1
      }
    }, CONCLUSION_TEXT)
    expect(order.conclusion).toBeGreaterThan(0)
    expect(order.iframe).toBeGreaterThan(0)
    expect(order.iframe).toBeLessThan(order.conclusion)

    // 中间叙述折进过程,收起态不可见
    await expect(page.getByText(NARRATION_TEXT)).toHaveCount(0)

    await page.screenshot({ path: `${ARTIFACTS_DIR}/F1-focus-collapsed.png` })
  })

  test('F2: 展开摘要条后中间叙述/工具按序平铺(无套娃),成品卡不受影响', async ({ page }) => {
    await setupFocusTurn(page)

    const toggle = page.locator('[data-testid="process-group-toggle"]')
    await toggle.click()

    await expect(page.getByText(NARRATION_TEXT)).toBeVisible()
    await expect(page.locator('[data-testid="process-think-group"]')).toBeVisible()

    // 成品卡本来就在轮尾常显 —— 展开过程不会把它变出来/藏起来,始终一张
    await expect(page.locator('iframe')).toHaveCount(1)

    // 顺序:思考组 → 中间叙述 → tool1 → tool2(真实顺序,展开后完整可读,信息不丢)
    const tops = await page.evaluate((narration) => {
      const think = document.querySelector('[data-testid="process-think-group"]') as HTMLElement | null
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

  test('F3: 关闭 focus 后仍是 1 条分割线,过程段直接铺开(交付物也在线下)', async ({ page }) => {
    await setupFocusTurn(page)

    // 关闭前:收敛态,1 条分割线,过程折叠
    await expect(page.locator('[data-testid="process-group-toggle"]')).toHaveCount(1)
    await expect(page.locator('[data-testid="process-think-group"]')).toHaveCount(0)

    const focusToggle = page.locator('[data-testid="focus-stream-toggle"]')
    await focusToggle.click()
    await expect(focusToggle).toHaveAttribute('aria-pressed', 'false')

    // 关闭后:仍只有 1 条分割线(交付物被摘出 segments,不切断过程);
    // 但过程段直接铺开(defaultExpanded)——思考行/叙述立即可见,成品卡照常在轮尾
    await expect(page.locator('[data-testid="process-group-toggle"]')).toHaveCount(1)
    await expect(page.locator('[data-testid="process-think-group"]')).toBeVisible()
    await expect(page.getByText(NARRATION_TEXT)).toBeVisible()
    await expect(page.locator('iframe')).toBeVisible()
    await expect(page.getByText(CONCLUSION_TEXT)).toBeVisible()

    await page.screenshot({ path: `${ARTIFACTS_DIR}/F3-focus-off-interleaved.png` })
  })

  test('F4: 交付物(visualizer)永远在台面上 — 折叠/展开过程都只有一张,不被折走', async ({ page }) => {
    await setupFocusTurn(page)

    const toggle = page.locator('[data-testid="focus-stream-toggle"]')
    await expect(toggle).toHaveAttribute('aria-pressed', 'true')

    // 收敛态:过程全折起来了(思考行不可见),但成品卡照样在
    await expect(page.locator('[data-testid="process-think-group"]')).toHaveCount(0)
    await expect(page.locator('iframe')).toBeVisible()

    // 图卡裸奔:图本身就是交付物,头上不压工具卡头(artifact 类交付物仍保留卡头 ——
    // "在工作空间打开"的入口挂在那张卡上,详见 ToolCallCard)
    await expect(page.locator('[data-testid="bare-visualizer-card"]')).toBeVisible()
    await expect(page.getByText('创建可视化')).toHaveCount(0)

    // 展开摘要条 → 过程铺开,成品卡仍是唯一一张(没有被复制进过程里)
    await page.locator('[data-testid="process-group-toggle"]').click()
    await expect(page.locator('[data-testid="process-think-group"]')).toBeVisible()
    await expect(page.locator('iframe')).toHaveCount(1)

    await page.screenshot({ path: `${ARTIFACTS_DIR}/F4-deliverable-always-visible.png` })
  })

  test('F6: 收敛态摘要条 chevron 默认隐身,hover 后浮现(展开控件不常显)', async ({ page }) => {
    await setupFocusTurn(page)

    const bar = page.locator('[data-testid="process-group-toggle"]')
    const chevron = bar.locator('svg').first()
    // 静止:chevron opacity 0 —— 台面只有一行安静的"处理完成"元信息
    await expect.poll(() => chevron.evaluate(el => getComputedStyle(el).opacity)).toBe('0')
    // hover:chevron 浮现
    await bar.hover()
    await expect.poll(() => chevron.evaluate(el => getComputedStyle(el).opacity)).toBe('1')

    // 鼠标点一下再移开:必须回到隐身。:focus-within 会把刚点过的那一行钉住不走
    // (Chromium 点按钮同样给焦点),同一个控件因为点没点过而长得不一样 —— 用户实锤的
    // 「交互规范不一致」。现在走 :focus-visible,鼠标点不触发。
    await bar.click()
    await page.mouse.move(5, 5)
    await expect.poll(() => chevron.evaluate(el => getComputedStyle(el).opacity)).toBe('0')
    // 展开态同样不常显 chevron:下面已经铺着内容,状态不需要一个常驻箭头来说明
    await expect(page.locator('[data-testid="process-think-group"]')).toBeVisible()
    await expect.poll(() => chevron.evaluate(el => getComputedStyle(el).opacity)).toBe('0')
    // 键盘可达性不能一起丢掉:**用键盘**回到这一行时(:focus-visible)仍然要浮现。
    // 必须真按 Tab —— 浏览器按"最后一次输入是不是键盘"来判定 focus-visible,
    // 脚本 .focus() 在刚点过鼠标之后不算数。点击已经把焦点留在本行,Shift+Tab 出去再 Tab 回来。
    await page.keyboard.press('Shift+Tab')
    await page.keyboard.press('Tab')
    await expect.poll(() => bar.evaluate(el => el === document.activeElement)).toBe(true)
    await expect.poll(() => chevron.evaluate(el => getComputedStyle(el).opacity)).toBe('1')

    await page.screenshot({ path: `${ARTIFACTS_DIR}/F6-hover-reveal-chevron.png` })
  })

  test('F11: 计时从 agent 开跑算起,不把回车前的等待计进"处理"', async ({ page }) => {
    // 真机会话 496041e6(2026-08-18):10:05:58 按下回车 → 供应商 429、换端点重试 →
    // 10:06:17 agent 才真正开跑 → 10:06:21 出答案。以 userMsg 为起点写出"处理完成 23 秒",
    // 展开却只有一步 2 秒的思考,用户当场指出对不上。runtime-context 快照的时间戳
    // 正是 agent 开跑的时刻(主进程在 turn 开始时广播、重试会覆盖),拿它当锚点 → 4 秒。
    await page.addInitScript({ content: MOCK_API })
    await page.goto('/')
    await page.waitForLoadState('networkidle')
    await page.evaluate(async () => {
      const store = (window as any).__chatStore
      await store.getState().newConversation('learner')
      store.setState({
        isStreaming: false,
        messages: [
          { id: 'u1', role: 'user', content: '你可以做什么', timestamp: 1787018758371, messageKind: 'user' },
          { id: 'rc-u1', role: 'user', content: '<runtime-context>x</runtime-context>', timestamp: 1787018777416, messageKind: 'runtime-context' },
          { id: 't1', role: 'assistant', content: '', thinkingContent: '', thinkingMs: 2486, timestamp: 1787018778898, messageKind: 'thinking' },
          { id: 'a1', role: 'assistant', content: '当然可以!', timestamp: 1787018781403, messageKind: 'assistant' },
        ]
      })
    })
    const bar = page.locator('[data-testid="process-group-toggle"]')
    await expect(bar).toContainText('处理完成 4 秒')
    await expect(bar).not.toContainText('23 秒')
    // 隐藏的快照消息本身绝不上台面
    await expect(page.locator('text=runtime-context')).toHaveCount(0)
  })

  test('F13: 生成中与生成后都只有一条分割线,且不再有带边框的思考气泡', async ({ page }) => {
    // 用户实锤(2026-08-18):同一轮生成中两条横线、生成完变回一条 —— 中间那段叙述文本
    // 当 final 把过程劈成了两截。另外那个带外框的"努力思考中…"气泡也要去掉:
    // 分割线自己就在扫光 + 报真实秒数,方框点点是同一件事说两遍。
    await page.addInitScript({ content: MOCK_API })
    await page.goto('/')
    await page.waitForLoadState('networkidle')
    const t0 = 1787018758000
    const live = [
      { id: 'u1', role: 'user', content: '查一下特征值分解,顺便做张卡片', timestamp: t0, messageKind: 'user' },
      { id: 'th1', role: 'assistant', content: '', thinkingContent: '先看看环境', thinkingMs: 9000, timestamp: t0 + 1000, messageKind: 'thinking' },
      { id: 'tl1', role: 'tool', toolName: 'get_environment', content: '{"mode":"undocked"}', timestamp: t0 + 10000, messageKind: 'tool' },
      { id: 'a1', role: 'assistant', content: '下面先快速验证例子计算,再做卡片:', timestamp: t0 + 14000, messageKind: 'assistant' },
      { id: 'tl2', role: 'tool', toolName: 'execute_code', content: '特征值: [3. 1.]', timestamp: t0 + 16000, messageKind: 'tool' },
      { id: 'th2', role: 'assistant', content: '', thinkingContent: '组织讲解', timestamp: t0 + 17000, messageKind: 'thinking' },
    ]
    const rule = page.locator('[data-testid="process-group-rule"]')
    const bubble = page.locator('text=努力思考中')

    // 生成中:叙述夹在两段过程之间 —— 只能有一条线
    await page.evaluate(async (live) => {
      const store = (window as any).__chatStore
      await store.getState().newConversation('learner')
      store.setState({ isStreaming: true, messages: live })
    }, live)
    await expect(rule).toHaveCount(1)
    await expect(page.locator('[data-testid="process-group-toggle"]')).toContainText('处理中')
    await expect(bubble).toHaveCount(0)
    // 叙述没有消失,只是从整栏正文变成过程清单里的一行(流式中过程组是展开的)
    await expect(page.locator('text=下面先快速验证例子计算')).toBeVisible()

    // 生成结束:结构不变,仍然一条线
    await page.evaluate(async (live) => {
      const t0 = live[0].timestamp
      ;(window as any).__chatStore.setState({
        isStreaming: false,
        messages: [...live, { id: 'a2', role: 'assistant', content: '特征值分解就是…', timestamp: t0 + 19000, messageKind: 'assistant' }],
      })
    }, live)
    await expect(rule).toHaveCount(1)
    await expect(page.locator('[data-testid="process-group-toggle"]')).toContainText('处理完成')
    await expect(bubble).toHaveCount(0)

    // 刚按下回车、什么都还没回来:也要有一条扫光的线顶着(气泡删了,不能一片空白)
    await page.evaluate(async (live) => {
      ;(window as any).__chatStore.setState({ isStreaming: true, messages: [live[0]] })
    }, live)
    await expect(rule).toHaveCount(1)
    await expect(bubble).toHaveCount(0)

    await page.screenshot({ path: `${ARTIFACTS_DIR}/F13-one-rule-while-streaming.png` })
  })

  test('F15: 思考正文生成中自动贴底,用户上滑后交出控制权', async ({ page }) => {
    await page.addInitScript({ content: MOCK_API })
    await page.goto('/')
    await page.waitForLoadState('networkidle')
    const t0 = 1787018758000
    const line = (i: number) => `第 ${i} 行推理:先看条件,再看结论,最后检查边界。\n`
    const seed = (n: number) => Array.from({ length: n }, (_, i) => line(i + 1)).join('')

    const setThinking = async (text: string) => {
      await page.evaluate(({ text, t0 }) => {
        ;(window as any).__chatStore.setState({
          isStreaming: true, isThinking: true,
          modelRespondedConvIds: { [(window as any).__chatStore.getState().activeConversationId || '']: true },
          messages: [
            { id: 'u1', role: 'user', content: '想一个复杂问题', timestamp: t0, messageKind: 'user' },
            { id: 'th1', role: 'assistant', content: '', thinkingContent: text, timestamp: t0 + 1000, messageKind: 'thinking' },
          ],
        })
      }, { text, t0 })
    }

    await page.evaluate(async () => { await (window as any).__chatStore.getState().newConversation('learner') })
    await setThinking(seed(40))
    // 思考行默认折叠,点开才看正文
    await page.locator('[data-testid="process-think-group"] button').click()
    const box = page.locator('[data-testid="thinking-stream"]')
    await expect(box).toBeVisible()

    const metrics = () => box.evaluate(el => ({
      top: Math.round(el.scrollTop),
      max: Math.round(el.scrollHeight - el.clientHeight),
    }))

    // 刚展开一段已有内容:停在顶部,不许把开头弹走
    expect((await metrics()).top).toBe(0)

    // 内容继续长 → 自动贴底
    await setThinking(seed(80))
    await expect.poll(async () => {
      const m = await metrics()
      return m.max - m.top <= 24
    }).toBe(true)

    // 用户往上滑 → 后续 chunk 不再拽回去
    await box.evaluate(el => { el.scrollTop = 0; el.dispatchEvent(new Event('scroll')) })
    await setThinking(seed(120))
    await page.waitForTimeout(300)
    expect((await metrics()).top).toBe(0)

    // 滑回底部 → 自动贴底恢复
    await box.evaluate(el => { el.scrollTop = el.scrollHeight; el.dispatchEvent(new Event('scroll')) })
    await setThinking(seed(160))
    await expect.poll(async () => {
      const m = await metrics()
      return m.max - m.top <= 24
    }).toBe(true)

    await page.screenshot({ path: `${ARTIFACTS_DIR}/F15-thinking-autoscroll.png` })
  })

  test('F17: 单条探索不折叠;全局 focus 开关能覆盖手动展开过的轮次', async ({ page }) => {
    await page.addInitScript({ content: MOCK_API })
    await page.goto('/')
    await page.waitForLoadState('networkidle')
    const t0 = 1787018758000

    // 评审存量 A:一条搜索折成"探索 · 1 搜索"是净亏 —— 收起态连搜了什么都没有。
    // 门槛对齐 file-group / archive-group 的 >1。
    // (用 web_search 而不是 read:read 会先被 archiveReadInfo 截成 archive-group,
    //  走不到探索分支 —— 单条 read 本来就不会被折。)
    const oneSearch = (t0: number) => ({
      isStreaming: false,
      messages: [
        { id: 'u1', role: 'user', content: '搜一下', timestamp: t0, messageKind: 'user' },
        { id: 'tl1', role: 'tool', toolName: 'web_search', content: '成功: 找到 3 条结果', timestamp: t0 + 1000, messageKind: 'tool' },
        { id: 'a1', role: 'assistant', content: '看完了', timestamp: t0 + 2000, messageKind: 'assistant' },
      ],
    })
    await page.evaluate(async (state) => {
      const store = (window as any).__chatStore
      await store.getState().newConversation('learner')
      store.setState(state)
    }, oneSearch(t0))
    const bar = page.locator('[data-testid="process-group-toggle"]')
    await bar.click()
    await expect(page.locator('[data-testid="process-explore-group"]')).toHaveCount(0)
    await expect(page.getByText('找到 3 条结果').first()).toBeVisible()   // 结果摘要直接可见

    // 两条探索仍然聚合成一行
    await page.evaluate(async (t0) => {
      ;(window as any).__chatStore.setState({
        isStreaming: false,
        messages: [
          { id: 'u1', role: 'user', content: '搜一下', timestamp: t0, messageKind: 'user' },
          { id: 'tl1', role: 'tool', toolName: 'web_search', content: '成功 A', timestamp: t0 + 1000, messageKind: 'tool' },
          { id: 'tl2', role: 'tool', toolName: 'web_search', content: '成功 B', timestamp: t0 + 1500, messageKind: 'tool' },
          { id: 'a1', role: 'assistant', content: '看完了', timestamp: t0 + 2000, messageKind: 'assistant' },
        ],
      })
    }, t0)
    // 不用再点:turn id 没变(还是 u1),ProcessGroup 是同一个实例、仍是展开态。
    // 再点一下反而会收起来。
    await expect(page.locator('[data-testid="process-explore-group"]')).toHaveCount(1)

    // 评审存量 B:手动展开过的轮次,曾经对全局 focus 开关永久免疫。
    // 现在 defaultExpanded 一变(= 用户拨了开关)就清掉本轮的手动状态。
    const focusToggle = page.locator('[data-testid="focus-stream-toggle"]')
    await expect(focusToggle).toHaveAttribute('aria-pressed', 'true')   // focus 开 → 默认收起
    await expect(page.locator('[data-testid="process-explore-group"]')).toHaveCount(1) // 刚手动展开着
    await focusToggle.click()                                          // 关 focus → 全部铺开
    await expect(focusToggle).toHaveAttribute('aria-pressed', 'false')
    await focusToggle.click()                                          // 再开 focus → 必须收回去
    await expect(focusToggle).toHaveAttribute('aria-pressed', 'true')
    await expect(page.locator('[data-testid="process-explore-group"]')).toHaveCount(0)
  })

  test('F16: 没有用户消息的轮次不报荒谬耗时;不足 1 秒的思考不写「已思考 0 秒」', async ({ page }) => {
    // 评审 #1:零步骤分割线让 messages 可以为空,而 procStart 当时写着 `?? 0` ——
    // 定时任务 / 主动问候这类没有用户消息的轮次于是从 1970 年开始算,写出「处理完成 2978 万分钟」。
    // 评审 #8:thinkingMs=400 四舍五入成 0,和正上方"不足 1 秒不写秒数"的分割线自相矛盾。
    await page.addInitScript({ content: MOCK_API })
    await page.goto('/')
    await page.waitForLoadState('networkidle')
    const t0 = 1787018758000
    await page.evaluate(async (t0) => {
      const store = (window as any).__chatStore
      await store.getState().newConversation('learner')
      store.setState({
        isStreaming: false,
        messages: [
          // 整轮没有 user 消息:headless turn,既没有 agentStartTs 也没有过程消息
          { id: 'a1', role: 'assistant', content: '早上好,今天要备课吗?', timestamp: t0, messageKind: 'assistant' },
        ],
      })
    }, t0)
    const bar = page.locator('[data-testid="process-group-toggle"]')
    await expect(bar).toHaveCount(1)
    await expect(bar).toHaveText('处理完成')          // 只有说法,没有数字
    await expect(bar).not.toContainText('分钟')
    await expect(bar).not.toContainText('秒')

    // 不足 1 秒的思考:退回中性说法,不写「已思考 0 秒」
    await page.evaluate(async (t0) => {
      ;(window as any).__chatStore.setState({
        isStreaming: false,
        messages: [
          { id: 'u1', role: 'user', content: '快速想一下', timestamp: t0, messageKind: 'user' },
          { id: 't1', role: 'assistant', content: '', thinkingContent: '嗯', thinkingMs: 400, timestamp: t0 + 400, messageKind: 'thinking' },
          { id: 'a1', role: 'assistant', content: '好了', timestamp: t0 + 900, messageKind: 'assistant' },
        ],
      })
    }, t0)
    await page.locator('[data-testid="process-group-toggle"]').click()
    const thinkRow = page.locator('[data-testid="process-think-group"]')
    await expect(thinkRow).toBeVisible()
    await expect(thinkRow).not.toContainText('0 秒')
    await expect(thinkRow).toContainText('思考过程')
  })

  test('F14: 模型没通就不报秒数;步骤空档有一行不带边框的进行中标记', async ({ page }) => {
    // 用户实锤(2026-08-18):① "发了消息就计时,其实模型还没通" ②"去掉深度思考中的 loading
    // 以后,经常看不到下一步,总感觉是中断的"。①→ 连接期间只写「连接模型…」;
    // ②→ 步骤之间补一行标记,但**不能是带边框的气泡**(上一版就是因为那个框被退回的)。
    await page.addInitScript({ content: MOCK_API })
    await page.goto('/')
    await page.waitForLoadState('networkidle')
    const t0 = 1787018758000
    const bar = page.locator('[data-testid="process-group-toggle"]')

    // 发了消息,模型一个事件都还没回来
    await page.evaluate(async (t0) => {
      const store = (window as any).__chatStore
      await store.getState().newConversation('learner')
      store.setState({
        isStreaming: true, isThinking: false, modelRespondedConvIds: {},
        messages: [{ id: 'u1', role: 'user', content: '在吗', timestamp: t0, messageKind: 'user' }],
      })
    }, t0)
    await expect(bar).toContainText('连接模型')
    await expect(bar).not.toContainText('秒')

    // 模型开口了(第一条思考落地)—— 这才开始报秒数
    await page.evaluate(async (t0) => {
      ;(window as any).__chatStore.setState({
        isStreaming: true, isThinking: false,
        modelRespondedConvIds: { [(window as any).__chatStore.getState().activeConversationId || '']: true },
        messages: [
          { id: 'u1', role: 'user', content: '在吗', timestamp: t0, messageKind: 'user' },
          { id: 'rc', role: 'user', content: '<runtime-context>x</runtime-context>', timestamp: t0 + 1000, messageKind: 'runtime-context' },
          { id: 't1', role: 'assistant', content: '', thinkingContent: '想想', thinkingMs: 2000, timestamp: t0 + 2000, messageKind: 'thinking' },
        ],
      })
    }, t0)
    await expect(bar).not.toContainText('连接模型')
    await expect(bar).toContainText('处理中')

    // 步骤空档:一行标记顶着,且它没有边框/底色(上一版那个气泡带 border + bg)
    const marker = page.getByText('生成中…')
    await expect(marker).toBeVisible()
    const box = await marker.evaluate(el => {
      const row = el.parentElement as HTMLElement
      const cs = getComputedStyle(row)
      return { border: cs.borderTopWidth, bg: cs.backgroundColor }
    })
    expect(box.border).toBe('0px')
    expect(box.bg === 'rgba(0, 0, 0, 0)' || box.bg === 'transparent').toBe(true)

    await page.screenshot({ path: `${ARTIFACTS_DIR}/F14-connecting-and-gap.png` })

    // 有正文在流的时候它必须让位(否则就是在正文旁边空喊"生成中")。
    // 走 mock 事件总线打真实的 onStreamChunk —— 早先这里写的是
    // `window.__liveStreamStore?.setState?.(...)`,而那个 store 全仓根本没暴露,
    // 可选链把整句吞掉、后面又没有断言:把 StreamingArea 的 !text 门删掉都照样绿。
    await page.evaluate(() => {
      const cid = (window as any).__chatStore.getState().activeConversationId || ''
      ;(window as any).__mockBus.emit('stream-chunk', cid, '正在作答…')
    })
    await expect(page.getByText('正在作答…')).toBeVisible()
    await expect(marker).toHaveCount(0)
  })

  test('F12: 一步过程都没有的轮次照样画线(直接作答 / 服务报错 / 只出成品)', async ({ page }) => {
    // 用户要求(2026-08-18):"只要有 AI 的内容就带,哪怕是发了 prompt 以后 AI 服务本身报错了"。
    await page.addInitScript({ content: MOCK_API })
    await page.goto('/')
    await page.waitForLoadState('networkidle')

    const seed = async (messages: unknown[]) => {
      await page.evaluate(async (messages) => {
        const store = (window as any).__chatStore
        store.setState({ isStreaming: false, messages })
      }, messages)
    }
    const t0 = 1787018758000

    // ① 模型直接作答:没有思考、没有工具
    await page.evaluate(async () => { await (window as any).__chatStore.getState().newConversation('learner') })
    await seed([
      { id: 'u1', role: 'user', content: '几点了', timestamp: t0, messageKind: 'user' },
      { id: 'a1', role: 'assistant', content: '现在 10:06。', timestamp: t0 + 2000, messageKind: 'assistant' },
    ])
    const bar = page.locator('[data-testid="process-group-toggle"]')
    await expect(bar).toHaveCount(1)
    await expect(bar).toContainText('处理完成 2 秒')
    await expect(page.locator('[data-testid="process-group-rule"]')).toHaveCount(1)
    // 无步骤 → 不是按钮:点了不该展开出任何东西,也不该长出 chevron
    await expect(bar).toHaveAttribute('data-expandable', 'false')
    expect(await bar.evaluate(el => el.tagName)).toBe('DIV')
    await bar.hover()
    await expect(bar.locator('svg')).toHaveCount(0)

    // ② prompt 发出去,AI 服务自己报错 —— 报错也是 AI 的内容,线照画
    await seed([
      { id: 'u2', role: 'user', content: '搜一下', timestamp: t0, messageKind: 'user' },
      { id: 'e1', role: 'assistant', content: '请求失败:429 quota exhausted', timestamp: t0 + 3000,
        messageKind: 'incomplete', messageSubtype: 'stream-error' },
    ])
    await expect(bar).toHaveCount(1)
    await expect(bar).toContainText('处理完成 3 秒')

    // ③ 只出了一件成品(交付物挂轮尾,segments 里一条过程段都没有)
    await seed([
      { id: 'u3', role: 'user', content: '画个图', timestamp: t0, messageKind: 'user' },
      { id: 'v1', role: 'tool', toolName: 'create_visualizer', content: '成功: 已生成图表', timestamp: t0 + 5000,
        messageKind: 'tool', visualizerHtml: '<html><body>chart</body></html>' },
    ])
    await expect(bar).toHaveCount(1)
    await expect(page.locator('iframe')).toHaveCount(1)

    // ④ 反向保险:一个字节都没回来的空转轮次不画线
    await seed([{ id: 'u4', role: 'user', content: '在吗', timestamp: t0, messageKind: 'user' }])
    await expect(bar).toHaveCount(0)
    await expect(page.locator('[data-testid="process-group-rule"]')).toHaveCount(0)

    await page.screenshot({ path: `${ARTIFACTS_DIR}/F12-bare-divider.png` })
  })

  test('F7: 执行中只有一条分割线,且分割线上没有展开控件(交付物不切断过程)', async ({ page }) => {
    await page.addInitScript({ content: MOCK_API })
    await page.goto('/')
    await page.waitForLoadState('networkidle')
    // 执行中的一轮:思考 → 工具 → 交付物(artifact)→ 又一段思考,结论还没来
    await page.evaluate(async (html) => {
      const store = (window as any).__chatStore
      await store.getState().newConversation('learner')
      const now = Date.now()
      store.setState({
        isStreaming: true,
        messages: [
          { id: 'su1', role: 'user', content: '查一下并做张卡片', timestamp: now, messageKind: 'user' },
          { id: 'st1', role: 'assistant', content: '', thinkingContent: '先算一下', timestamp: now + 100, messageKind: 'thinking' },
          { id: 'stool1', role: 'tool', toolName: 'execute_code', content: '成功: 算完了', timestamp: now + 200, messageKind: 'tool' },
          { id: 'sviz', role: 'tool', toolName: 'create_visualizer', content: '成功: 已生成图表', visualizerHtml: html, timestamp: now + 300, messageKind: 'tool' },
          { id: 'st2', role: 'assistant', content: '', thinkingContent: '再组织一下', timestamp: now + 400, messageKind: 'thinking' },
        ]
      })
    }, VISUALIZER_HTML)

    const bar = page.locator('[data-testid="process-group-toggle"]')
    await expect(bar).toHaveCount(1)                       // 只有一条分割线
    await expect(bar).toHaveAttribute('data-active', 'true')
    await expect(bar).toContainText('处理中')
    await expect(bar.locator('svg')).toHaveCount(0)        // 执行中没有展开控件
    await bar.hover()
    await expect(bar.locator('svg')).toHaveCount(0)        // hover 也不冒出来
    // 成品卡照常在台面上(执行中就能看到)
    await expect(page.locator('[data-testid="bare-visualizer-card"]')).toBeVisible()
  })

  test('F8: 纯空白的 assistant 消息既不画第二条分割线,也不留空气泡', async ({ page }) => {
    await page.addInitScript({ content: MOCK_API })
    await page.goto('/')
    await page.waitForLoadState('networkidle')
    // 真机实录:模型调工具前先吐了 "\n\n",被 flush 成一条 content='\n\n' 的 assistant 消息。
    // 它曾经占一条 final 段,把过程切成两截 —— 台面上是"空气泡 + 复制"再加一条无字的横线。
    await page.evaluate(async () => {
      const store = (window as any).__chatStore
      await store.getState().newConversation('learner')
      const now = Date.now()
      store.setState({
        isStreaming: true,
        messages: [
          { id: 'bu1', role: 'user', content: '查一下特征值分解', timestamp: now, messageKind: 'user' },
          { id: 'bt1', role: 'assistant', content: '', thinkingContent: '先看看环境', thinkingMs: 1200, timestamp: now + 100, messageKind: 'thinking' },
          { id: 'bblank', role: 'assistant', content: '\n\n', timestamp: now + 200, messageKind: 'assistant' },
          { id: 'btool', role: 'tool', toolName: 'get_environment', content: '成功: undocked', timestamp: now + 300, messageKind: 'tool' },
          { id: 'bt2', role: 'assistant', content: '', thinkingContent: '组织讲解', timestamp: now + 400, messageKind: 'thinking' },
        ]
      })
    })

    await expect(page.locator('[data-testid="process-group-toggle"]')).toHaveCount(1)
    await expect(page.locator('[data-testid="process-group-rule"]')).toHaveCount(1)
    // 空气泡连同它的「复制」页脚都不该出现
    await expect(page.getByRole('button', { name: '复制' })).toHaveCount(0)
  })

  test('F9: AI 侧铺满整栏,用户气泡仍然收窄', async ({ page }) => {
    await page.addInitScript({ content: MOCK_API })
    await page.goto('/')
    await page.waitForLoadState('networkidle')
    const LONG_USER = '帮我把这段很长的问题原样保留下来,我要看它会不会一直撑到整栏那么宽,还是停在 85% 就收住'
    const LONG_AI = 'AI 的回答应当铺满整栏,读起来像一篇文章而不是一列细条,这样代码块表格和图卡都不会被挤扁。'
    await page.evaluate(async (texts) => {
      const store = (window as any).__chatStore
      await store.getState().newConversation('learner')
      const now = Date.now()
      store.setState({
        isStreaming: false,
        messages: [
          { id: 'wu1', role: 'user', content: texts.user, timestamp: now, messageKind: 'user' },
          { id: 'wa1', role: 'assistant', content: texts.ai, timestamp: now + 100, messageKind: 'assistant' },
        ]
      })
    }, { user: LONG_USER, ai: LONG_AI })

    const ratios = await page.evaluate((texts) => {
      const pick = (t: string): HTMLElement | null => {
        const rows = Array.from(document.querySelectorAll('.mb-msg')) as HTMLElement[]
        const row = rows.find(r => r.textContent?.includes(t.slice(0, 20)))
        return (row?.firstElementChild as HTMLElement) || null
      }
      const userEl = pick(texts.user)
      const aiEl = pick(texts.ai)
      const colWidth = (userEl?.parentElement?.clientWidth) || 1
      return {
        user: (userEl?.getBoundingClientRect().width || 0) / colWidth,
        ai: (aiEl?.getBoundingClientRect().width || 0) / colWidth
      }
    }, { user: LONG_USER, ai: LONG_AI })

    expect(ratios.ai).toBeGreaterThan(0.99)   // AI 侧 100% 铺满
    expect(ratios.user).toBeLessThan(0.9)     // 用户侧仍卡在 85% 档
  })

  test('F10: 执行中思考行写「思考中」,不再重复一个"努力思考中"气泡', async ({ page }) => {
    await page.addInitScript({ content: MOCK_API })
    await page.goto('/')
    await page.waitForLoadState('networkidle')
    await page.evaluate(async () => {
      const store = (window as any).__chatStore
      await store.getState().newConversation('learner')
      const now = Date.now()
      store.setState({
        isStreaming: true,
        isThinking: true,   // 有一条正在流的 thinking 消息
        messages: [
          { id: 'ku1', role: 'user', content: '想一个问题', timestamp: now, messageKind: 'user' },
          // 没有 thinkingMs = thinking_end 还没到 = 还在想
          { id: 'kt1', role: 'assistant', content: '', thinkingContent: '正在推理…', timestamp: now + 100, messageKind: 'thinking' },
        ]
      })
    })

    const thinkRow = page.locator('[data-testid="process-think-group"]')
    await expect(thinkRow).toContainText('思考中')
    await expect(thinkRow).not.toContainText('已思考')
    // 同一件事不说两遍:流式区的思考点点让位给过程栏里的这一行
    await expect(page.getByText('正在思考…')).toHaveCount(0)
    await expect(page.getByText('努力思考中…')).toHaveCount(0)
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

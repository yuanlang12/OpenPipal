import { test, expect, Page } from '@playwright/test'

const ARTIFACTS_DIR = 'tests/artifacts/slash-panel'

/**
 * `/` 快捷指令面板 · 欢迎页
 *
 * 技能的按钮入口已经全部拆掉（欢迎页那颗「技能」胶囊、对话页 + 菜单里的「添加技能」），
 * 唯一入口是在输入框打 `/`。这里盯欢迎页这一侧：面板出得来、选中插的是 token、
 * 欢迎页不给内置命令（`/goal` 改的是会话状态，这里还没有会话）。对话页一侧在
 * skill-request.spec.ts。截图供目视验收。
 */
const MOCK_API = `
window.__mockCalls = [];
window.api = {
  getLocaleState: async () => ({ preference: 'zh-CN', locale: 'zh-CN' }),
  sendChat: (...a) => { window.__mockCalls.push(['sendChat', JSON.stringify(a).slice(0, 3000)]); },
  abortChat: () => {},
  onStreamChunk: () => () => {},
  onStreamEnd: () => () => {},
  onTextFlush: () => () => {},
  onToolStart: () => () => {},
  onToolEnd: () => () => {},
  onAskUser: () => () => {},
  onTargetStatus: () => () => {},
  onAppChanged: () => () => {},
  hasApiKey: async () => ({ hasKey: true }),
  getRoleInitState: async () => ({ hasRole: true, role: { name: 'general', displayName: '通用助手', icon: '✦' } }),
  getAllRoles: async () => [{ name: 'general', displayName: '通用助手', icon: '✦' }],
  getCurrentRole: async () => ({ name: 'general', displayName: '通用助手', icon: '✦' }),
  switchRole: async () => ({ name: 'general', displayName: '通用助手', icon: '✦' }),
  listConversations: async () => [],
  createConversation: async (role) => ({ id: 'conv-slash', title: '斜杠面板', role, createdAt: Date.now(), updatedAt: Date.now(), messageCount: 0 }),
  getConversationMessages: async () => [],
  replaceMessages: async () => {},
  appendMessages: async () => {},
  deleteConversation: async () => {},
  updateConversationConfig: async () => ({ ok: true }),
  getAppSettings: async () => ({ detected: [], disabled: [], browsers: [] }),
  isCustomConfig: async () => ({ isCustom: false }),
  getAvailableModels: async () => [],
  getModelConfig: async () => ({ provider: 'openai', baseUrl: '', apiKey: '', model: '' }),
  getModelConfigFull: async () => ({ provider: 'openai', baseUrl: '', apiKey: '', model: 'gpt-4o' }),
  // 名字/说明的长度按真机内置技能来（长名 + 长描述才看得出面板够不够宽）
  listSkills: async () => ([
    { name: 'animation-basics', description: '动画时间线运行时(./animations.js)：入场、滚动触发、逐字揭示', enabled: true },
    { name: 'curriculum-info-tech-primary', description: '小学信息科技课标参考——课时目标、活动建议、评价要点', enabled: true },
    { name: 'dc-authoring', description: 'Design Component(.dc.html) 的写法与参数面板约定', enabled: true },
    { name: 'pdf', description: '处理 PDF', enabled: true },
    { name: '课件生成', description: '出一份可讲的课件', enabled: true }
  ]),
  listWorkspaces: async () => [],
  listAgentTemplates: async () => [],
  getOnboardingStatus: async () => ({ completed: true }),
  getRealtimeConfig: async () => ({ provider: 'openai', url: '', model: '', deployment: '', apiVersion: '', voice: 'alloy', hasKey: false }),
  startRealtime: async () => ({ success: false }),
  stopRealtime: () => {},
  sendRealtimeEvent: () => {},
  onRealtimeEvent: () => () => {},
  onRealtimeState: () => () => {}
};
`

async function boot(page: Page): Promise<void> {
  await page.addInitScript({ content: MOCK_API })
  await page.goto('/')
  await page.waitForLoadState('networkidle')
  await page.waitForSelector('textarea', { timeout: 10000 })
}

test.use({ viewport: { width: 900, height: 820 } })

test.describe('欢迎页 · / 快捷指令面板', () => {
  test('打 / 出技能列表，选中插 token，按钮入口已不存在', async ({ page }) => {
    await boot(page)
    // 「技能」按钮已经拆掉，输入框里只剩 + / 语音 / 模型
    await expect(page.getByRole('button', { name: '技能' })).toHaveCount(0)

    const textarea = page.locator('textarea').first()
    await textarea.click()
    await page.keyboard.type('/')

    const popup = page.locator('[data-testid="skill-mention-popup"]')
    await expect(popup).toBeVisible()
    await expect(popup.locator('[data-testid="skill-mention-item"]')).toHaveCount(5)
    // 欢迎页不给内置命令：这里还没有会话可改
    await expect(popup.locator('[data-kind="command"]')).toHaveCount(0)
    await page.waitForTimeout(300) // 等淡入放完再截，不然截到半透明的中间帧
    await page.screenshot({ path: `${ARTIFACTS_DIR}/welcome-panel.png` })

    // 打字过滤 → Enter 选中 → 插的是 /token，镜像层给它着色
    await page.keyboard.type('课件')
    await expect(popup.locator('[data-testid="skill-mention-item"]')).toHaveCount(1)
    await page.keyboard.press('Enter')
    await expect(textarea).toHaveValue('/课件生成 ')
    await expect(page.locator('[data-testid="skill-mention-mirror"]')).toBeVisible()

    await page.keyboard.type('讲三角函数')
    await page.screenshot({ path: `${ARTIFACTS_DIR}/welcome-token.png` })
    await page.locator('[data-testid="send-btn"]').click()

    await expect(async () => {
      const calls = await page.evaluate(() => (window as any).__mockCalls)
      const payload = calls.filter((c: any[]) => c[0] === 'sendChat').map((c: any[]) => c[1]).join('')
      expect(payload).toContain('<skill-request>课件生成</skill-request>')
    }).toPass({ timeout: 5000 })
  })

  test('句中打 / 也能唤起；路径里的 / 不打扰', async ({ page }) => {
    await boot(page)
    const textarea = page.locator('textarea').first()
    await textarea.click()

    // 路径：/ 前面贴着字，不是触发符
    await page.keyboard.type('看下 src/pdf')
    await expect(page.locator('[data-testid="skill-mention-popup"]')).toHaveCount(0)

    // 空格后的 / 才是触发符
    await page.keyboard.type(' /pd')
    await expect(page.locator('[data-testid="skill-mention-popup"]')).toBeVisible()
    await page.keyboard.press('Enter')
    await expect(textarea).toHaveValue('看下 src/pdf /pdf ')
    await page.screenshot({ path: `${ARTIFACTS_DIR}/welcome-inline.png` })
  })
})

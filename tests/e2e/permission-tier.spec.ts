import { test, expect, Page } from '@playwright/test'
import { bootstrapChat } from './helpers'

/**
 * 权限档位控件的三条界面契约：
 *  1. 只在编码助手的输入框出现（别的角色不该被迫理解"工具风险分级"）
 *  2. 胶囊常驻显示当前档位——这是个改变 agent 能干什么的开关，藏起来等于没有
 *  3. 三档的说明常驻可见，且"完全允许"必须写明破坏性操作仍会问一次
 * 纯 view 层，沿用 model-control.spec 的注入技法（不依赖真实 main 进程）。
 */
const role = (name: string, displayName: string) => ({ name, displayName, icon: '💻' })

const mockApi = (roleName: string) => `
window.api = {
  getLocaleState: async () => ({ preference: 'zh-CN', locale: 'zh-CN' }),
  sendChat: () => {}, abortChat: () => {},
  onStreamChunk: () => () => {}, onStreamEnd: () => () => {},
  onTextFlush: () => () => {}, onToolStart: () => () => {}, onToolEnd: () => () => {},
  onToolProgress: () => () => {}, onAskUser: () => () => {}, onQuestionsV2: () => () => {},
  onArtifact: () => () => {}, onArtifactDelta: () => () => {}, onArtifactComplete: () => () => {},
  onVisualizer: () => () => {}, onVisualizerDelta: () => () => {}, onMcpAppInline: () => () => {},
  onTargetStatus: () => () => {}, onAppChanged: () => () => {}, onMemoryUpdated: () => () => {},
  onConvTitleUpdated: () => () => {}, onInlinePermission: () => () => {}, onPermissionRequest: () => () => {},
  onThinking: () => () => {}, onThinkingEnd: () => () => {},
  respondPermission: () => {}, pasteToTarget: async () => ({ success: true }), hasApiKey: async () => ({ hasKey: true }),
  getRoleInitState: async () => ({ hasRole: true, role: ${JSON.stringify(role(roleName, roleName === 'coding' ? '编码助手' : '学习助手'))} }),
  getAllRoles: async () => [${JSON.stringify(role(roleName, roleName === 'coding' ? '编码助手' : '学习助手'))}],
  getCurrentRole: async () => (${JSON.stringify(role(roleName, roleName === 'coding' ? '编码助手' : '学习助手'))}),
  switchRole: async () => (${JSON.stringify(role(roleName, roleName === 'coding' ? '编码助手' : '学习助手'))}),
  listConversations: async () => [],
  createConversation: async (r) => ({ id: 'conv-tier', title: '权限档位', role: r, createdAt: Date.now(), updatedAt: Date.now(), messageCount: 0 }),
  getConversationMessages: async () => [],
  replaceMessages: async () => {}, appendMessages: async () => {}, deleteConversation: async () => {},
  updateConversationConfig: async () => ({ ok: true }), updateConversationTitle: async () => ({ ok: true }),
  getAppSettings: async () => ({ detected: [], disabled: [], browsers: [] }), setDisabledApps: async () => {},
  getModelConfig: async () => ({ provider: 'anthropic', model: 'test-model' }), saveModelConfig: async () => {},
  getModelConfigFull: async () => ({ provider: 'anthropic', model: 'test-model' }),
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

/**
 * 等 CSS 过渡跑完再截图/取色。
 * transition-colors 默认 150ms，中间帧的背景是 rgba(...,0.004) 这种——
 * 截到中间帧会让人以为"颜色没生效"，前面已经踩过一次（淡入的菜单同理）。
 */
async function settled(page: Page): Promise<void> {
  await page.waitForTimeout(300)
}

async function openChat(page: Page, roleName: string): Promise<void> {
  await page.addInitScript({ content: mockApi(roleName) })
  await page.goto('/')
  await page.waitForLoadState('networkidle')
  await page.evaluate(r => { (window as any).__appStore?.setState?.({ currentRole: { name: r, displayName: r, icon: '💻' } }) }, roleName)
  await bootstrapChat(page, { role: roleName, messages: [{ id: 'm1', role: 'user', content: '看看这个仓库', timestamp: Date.now() }] })
  // 收起侧栏：420px 视窗下侧栏展开会把聊天区挤到 ~180px，那是测试布景不是真实使用形态
  await page.getByTestId('sidebar-toggle').click()
  await expect(page.getByTestId('sidebar')).toHaveClass(/w-12/)
}

test('编码助手：胶囊默认显示"自动审核"，菜单三档说明常驻', async ({ page }) => {
  await openChat(page, 'coding')
  const trigger = page.getByTestId('permission-tier-trigger')
  await expect(trigger).toBeVisible()
  await expect(trigger).toHaveText(/自动审核/)

  await trigger.click()
  const menu = page.getByTestId('permission-tier-menu')
  await expect(menu).toBeVisible()
  await expect(menu).toContainText('只读')
  await expect(menu).toContainText('不写文件、不跑命令')
  // 界面不许比代码承诺得多：完全允许并不会自动放行删除/回滚/强推
  await expect(menu).toContainText('删除、回滚、强推这类仍会问一次')
  await expect.poll(() => menu.evaluate(el => getComputedStyle(el).opacity)).toBe('1')
  await page.screenshot({ path: 'test-results/permission-tier-01-menu.png' })

  await page.getByTestId('permission-tier-full').click()
  await expect(menu).toBeHidden()
  await expect(trigger).toHaveText(/完全允许/)
  await settled(page)
  // 放宽档得看得出来：琥珀底色不是装饰，是"这条会话现在不逐次问了"的常驻提示
  await expect.poll(() => trigger.evaluate(el => getComputedStyle(el).backgroundColor))
    .toBe('rgb(255, 251, 235)')
  await page.screenshot({ path: 'test-results/permission-tier-02-full.png' })

  await trigger.click()
  await page.getByTestId('permission-tier-readonly').click()
  await expect(trigger).toHaveText(/只读/)
  await settled(page)
  await page.screenshot({ path: 'test-results/permission-tier-03-readonly.png' })
})

test('别的角色看不到这个控件', async ({ page }) => {
  await openChat(page, 'learner')
  await expect(page.locator('textarea')).toBeVisible()
  await expect(page.getByTestId('permission-tier-trigger')).toHaveCount(0)
})

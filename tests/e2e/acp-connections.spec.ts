import { test, expect, Page } from '@playwright/test'

const ARTIFACTS_DIR = 'tests/artifacts/acp-connections'

/**
 * 设置 →「应用」→「外部连接」E2E
 *
 * 盯三件事：正在跑的会话要标出来、待确认权限要显眼、桌面端能力缺席时整节隐藏
 * （浏览器插件的 web-api-shim 没有 getAcpStatus，显示空壳比不显示更糟）。
 */
const BASE_API = `
window.__mockBus = {
  listeners: {},
  on(event, fn) {
    if (!this.listeners[event]) this.listeners[event] = [];
    this.listeners[event].push(fn);
    return () => { this.listeners[event] = this.listeners[event].filter(f => f !== fn); };
  },
  emit(event, ...args) { (this.listeners[event] || []).forEach(fn => fn(...args)); }
};

window.api = {
  getLocaleState: async () => ({ preference: 'zh-CN', locale: 'zh-CN' }),
  sendChat: () => {},
  abortChat: () => {},
  onStreamChunk: (cb) => window.__mockBus.on('stream-chunk', cb),
  onStreamEnd: (cb) => window.__mockBus.on('stream-end', cb),
  onTextFlush: (cb) => window.__mockBus.on('text-flush', cb),
  onToolStart: (cb) => window.__mockBus.on('tool-start', cb),
  onToolEnd: (cb) => window.__mockBus.on('tool-end', cb),
  onAskUser: (cb) => window.__mockBus.on('ask-user', cb),
  onTargetStatus: (cb) => window.__mockBus.on('target-status', cb),
  onAppChanged: (cb) => window.__mockBus.on('app-changed', cb),
  pasteToTarget: async () => ({ success: true }),
  getRoleInitState: async () => ({ hasRole: true, role: { name: 'learner', displayName: '学习助手', icon: '📖' } }),
  getAllRoles: async () => [{ name: 'learner', displayName: '学习助手', icon: '📖' }],
  getCurrentRole: async () => ({ name: 'learner', displayName: '学习助手', icon: '📖' }),
  switchRole: async () => ({ name: 'learner', displayName: '学习助手', icon: '📖' }),
  listConversations: async () => [],
  createConversation: async (role) => ({ id: 'mock-conv', title: '新对话', role, createdAt: Date.now(), updatedAt: Date.now(), messageCount: 0 }),
  getConversationMessages: async () => [],
  replaceMessages: async () => {},
  appendMessages: async () => {},
  deleteConversation: async () => {},
  getAppSettings: async () => ({ enabled: true, detected: [], disabled: [], browsers: [] }),
  setAppFollowingEnabled: async () => ({ ok: true, enabled: true }),
  setDisabledApps: async () => ({ ok: true }),
  getWorkingDir: async () => '/Users/x/Documents',
  isCustomConfig: async () => ({ isCustom: false }),
  getAvailableModels: async () => [],
  getModelConfig: async () => ({ provider: 'openai', baseUrl: '', apiKey: '', model: '' }),
  getModelConfigFull: async () => ({ provider: 'openai', baseUrl: '', apiKey: '', model: '' }),
  saveModelConfig: async () => {},
  testConnection: async () => ({ ok: true, model: 'gpt-4o' }),
  getProviders: async () => ({}),
  clearModelConfig: async () => {},
  getRealtimeConfig: async () => ({ provider: 'openai', url: '', model: '', deployment: '', apiVersion: '', voice: 'alloy', hasKey: false }),
  startRealtime: async () => ({ success: false }),
  stopRealtime: () => {},
  sendRealtimeEvent: () => {},
  onRealtimeEvent: () => () => {},
  onRealtimeState: () => () => {}
};
`

const ACP_STATUS = `
window.__acpStatus = {
  port: 3031,
  adapter: {
    command: '/Applications/OpenPipal.app/Contents/MacOS/OpenPipal',
    args: ['/Applications/OpenPipal.app/Contents/Resources/acp/openpipal-acp.mjs'],
    env: { ELECTRON_RUN_AS_NODE: '1' }
  },
  tokenPath: '/Users/x/.openpipal/acp-mcp.token',
  lastHandshakeAt: Date.now() - 60000,
  sessions: [
    {
      conversationId: 'acp-running',
      title: '[ACP] openpipal · 设计助手',
      role: 'design',
      cwd: '/Users/x/code/openpipal',
      client: 'Zed',
      protocolVersion: 2,
      agent: '我的法务助手',
      mcpServers: [{ name: 'context7', toolCount: 4 }],
      lastActivityAt: Date.now(),
      streaming: true
    },
    {
      conversationId: 'acp-idle',
      title: '[ACP] notes',
      role: 'general',
      cwd: '/Users/x/notes',
      mcpServers: [],
      lastActivityAt: Date.now() - 3 * 3600 * 1000,
      streaming: false
    }
  ],
  pendingPermissions: [
    { tool: 'execute_command', risk: 'high', conversationId: 'acp-running', requestedAt: Date.now() }
  ]
};
// IPC 每次都是深拷贝——mock 也必须给新对象，否则 React 认同一个引用不重渲染
window.api.getAcpStatus = async () => JSON.parse(JSON.stringify(window.__acpStatus));
window.api.onAcpStatusChanged = (cb) => window.__mockBus.on('acp-status-changed', cb);
`

async function openConnectionsTab(page: Page, extra = ''): Promise<void> {
  await page.addInitScript({ content: BASE_API + extra })
  await page.goto('/')
  await page.waitForLoadState('networkidle')
  await page.waitForSelector('textarea', { timeout: 10000 })
  await page.getByRole('button', { name: '设置' }).first().click()
  await page.getByRole('button', { name: '连接', exact: true }).click()
  await page.waitForTimeout(200)
}

test.use({ viewport: { width: 1000, height: 900 } })

test.describe('设置 → 外部连接（ACP）', () => {
  test('列出会话、标出正在运行的那条、把待确认权限顶到显眼处', async ({ page }) => {
    await openConnectionsTab(page, ACP_STATUS)

    const panel = page.getByTestId('acp-connections')
    await expect(panel).toBeVisible({ timeout: 3000 })
    await expect(panel).toContainText('127.0.0.1:3031')

    // 待确认权限——这一节存在的最大理由，必须能一眼看到
    const pending = page.getByTestId('acp-pending-permissions')
    await expect(pending).toBeVisible()
    await expect(pending).toContainText('等你确认（1）')
    await expect(pending).toContainText('execute_command')

    // 两条会话；跑着的那条显示"正在运行"，闲着的显示相对时间而不是假装在跑
    await expect(panel).toContainText('[ACP] openpipal · 设计助手')
    await expect(panel).toContainText('Zed · ACP v2')
    await expect(panel).toContainText('使用 Agent：我的法务助手')
    await expect(panel).toContainText('context7 (4)')
    await expect(panel).toContainText('正在运行')
    await expect(panel).toContainText('[ACP] notes')
    await expect(panel).toContainText('未知编辑器')

    await page.screenshot({ path: `${ARTIFACTS_DIR}/acp-connections.png` })

    // 深色下也得看得见：待确认那块是手挑的琥珀色，浅色好看不代表深色不糊。
    // 主题开关在「应用」tab，切过去点完再回「连接」。
    await page.getByRole('button', { name: '应用', exact: true }).click()
    await page.getByTestId('theme-switcher').getByText('深色').click()
    await page.getByRole('button', { name: '连接', exact: true }).click()
    await page.waitForTimeout(300)
    await expect(page.getByTestId('acp-pending-permissions')).toBeVisible()
    await page.screenshot({ path: `${ARTIFACTS_DIR}/acp-connections-dark.png` })
  })

  test('推送变更后重新取快照，不靠轮询', async ({ page }) => {
    await openConnectionsTab(page, ACP_STATUS)
    await expect(page.getByTestId('acp-pending-permissions')).toBeVisible({ timeout: 3000 })

    await page.evaluate(() => {
      ;(window as any).__acpStatus.pendingPermissions = []
      ;(window as any).__mockBus.emit('acp-status-changed')
    })

    await expect(page.getByTestId('acp-pending-permissions')).toHaveCount(0, { timeout: 3000 })
  })

  test('桌面端能力缺席时整节隐藏，不留空壳', async ({ page }) => {
    await openConnectionsTab(page)

    // 设置页开着、tab 也点开了，但插件那套 api 没有这个能力 → 整节不渲染
    await expect(page.locator('text=设置').first()).toBeVisible({ timeout: 3000 })
    await expect(page.getByTestId('acp-connections')).toHaveCount(0)
  })

  test('给 AI 的对接说明按钮在服务没起来时不可点', async ({ page }) => {
    await openConnectionsTab(page, ACP_STATUS.replace('port: 3031', 'port: null'))
    await expect(page.getByTestId('acp-copy-spec')).toBeDisabled()
  })

  test('随包带了适配器就把启动命令摆出来，编辑器直接抄', async ({ page }) => {
    await openConnectionsTab(page, ACP_STATUS)

    const command = page.getByTestId('acp-launch-command')
    await expect(command).toBeVisible({ timeout: 3000 })
    await expect(command).toContainText('ELECTRON_RUN_AS_NODE')
    await expect(command).toContainText('openpipal-acp.mjs')
    await expect(page.getByTestId('acp-copy-launch')).toBeVisible()
    await page.screenshot({ path: `${ARTIFACTS_DIR}/acp-launch-command.png` })
  })

  test('没带适配器就直说，不摆一条跑不通的命令', async ({ page }) => {
    await openConnectionsTab(page, ACP_STATUS.replace(/adapter: \{[\s\S]*?\},\n/, 'adapter: null,\n'))

    await expect(page.getByTestId('acp-connections')).toContainText('没随包带 ACP 适配器')
    await expect(page.getByTestId('acp-launch-command')).toHaveCount(0)
    await expect(page.getByTestId('acp-copy-launch')).toHaveCount(0)
  })
})

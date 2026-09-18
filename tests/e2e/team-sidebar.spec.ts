import { test, expect, Page } from '@playwright/test'

const ARTIFACTS_DIR = 'tests/artifacts/team-sidebar'

/**
 * 团队第 2 段（纯 view 层，mock window.api）：
 *  1. 左栏：「团队」分组在上（团队名 + 自己的 mark，可折叠；有频道再分一层，空频道也列出来能开话题），
 *     「对话」分组在下按最近更新排一列（不分日期小组）
 *  2. 点开一条团队话题：左上角团队徽标、空状态列成员、中栏换成团队目录（team.md / 成员 / 频道 / memory / rules / shared）
 *  3. 我的 Pal 页：「团队」分组 + 新建团队对话框（名字、勾成员、选 Lead）→ createTeam 收到正确参数
 */
const MOCK_API = `
window.__mockBus = { listeners: {}, on(e, fn){ (this.listeners[e]=this.listeners[e]||[]).push(fn); return () => {} }, emit(e, ...args){ (this.listeners[e]||[]).forEach(fn => fn(...args)) } };
const ROLE = { name: 'general', displayName: 'OpenPipal', icon: '✦' };
const BUILTINS = [
  { id: 'general', kind: 'builtin', builtin: true, name: 'OpenPipal', icon: '✦', category: 'general' },
];
const WORKSPACES = [
  { id: 'ws-1', name: '备课 Pal', icon: '📐', description: '写教案', createdAt: 1, updatedAt: 1, memoryCount: 1, skillCount: 0, taskCount: 0 },
  { id: 'ws-2', name: '文案 Pal', icon: '✍️', description: '写小红书文案', createdAt: 1, updatedAt: 1, memoryCount: 0, skillCount: 0, taskCount: 0 },
  { id: 'ws-3', name: '出题 Pal', icon: '📝', description: '出练习题', createdAt: 1, updatedAt: 1, memoryCount: 0, skillCount: 0, taskCount: 0 },
  { id: 'ws-4', name: '批改 Pal', icon: '✅', description: '批作业', createdAt: 1, updatedAt: 1, memoryCount: 0, skillCount: 0, taskCount: 0 },
];
const TEAMS = [
  { id: 'a1a1a1a1-0000-4000-8000-000000000001', name: '教研组', lead: 'ws-3', members: ['ws-1', 'ws-3', 'ws-2', 'ws-4'], tier: 'auto', channels: ['备课', '批改', '家长沟通'], createdAt: 1, updatedAt: 3 },
  { id: 'b2b2b2b2-0000-4000-8000-000000000002', name: '小红书运营', lead: 'ws-2', members: ['ws-2'], tier: 'auto', channels: [], createdAt: 1, updatedAt: 2 },
];
const T1 = TEAMS[0].id;
window.__TEAMS = TEAMS; window.__WORKSPACES = WORKSPACES;
const now = Date.now(); const H = 3600000; const D = 24 * H;
const CONVERSATIONS = [
  { id: 'c1', title: '周三公开课教案改新课标', role: 'general', workspaceId: 'ws-1', teamId: T1, channel: '备课', createdAt: now - 60000, updatedAt: now - 60000, messageCount: 4 },
  { id: 'c4', title: '整理会议纪要', role: 'general', createdAt: now - H, updatedAt: now - H, messageCount: 6 },
  { id: 'c2', title: '单元测验出题', role: 'general', workspaceId: 'ws-1', teamId: T1, channel: '备课', createdAt: now - 2 * H, updatedAt: now - 2 * H, messageCount: 9 },
  { id: 'c3', title: '家长会通知', role: 'general', workspaceId: 'ws-1', teamId: T1, channel: '家长沟通', createdAt: now - 5 * H, updatedAt: now - 5 * H, messageCount: 2 },
  { id: 'c5', title: '期中复习计划', role: 'general', createdAt: now - D, updatedAt: now - D - 1000, messageCount: 14 },
  { id: 'c6', title: '五天前的对话', role: 'general', createdAt: now - 5 * D, updatedAt: now - 5 * D, messageCount: 3 },
  { id: 'c7', title: '一个月前的对话', role: 'general', createdAt: now - 30 * D, updatedAt: now - 30 * D, messageCount: 3 },
];
window.api = {
  getLocaleState: async () => ({ preference: 'zh-CN', locale: 'zh-CN' }),
  sendChat: () => {}, abortChat: () => {},
  onStreamChunk: () => () => {}, onStreamEnd: () => () => {},
  onTextFlush: () => () => {}, onToolStart: () => () => {}, onToolEnd: () => () => {},
  onToolProgress: () => () => {}, onAskUser: () => () => {}, onQuestionsV2: () => () => {},
  onArtifact: () => () => {}, onArtifactDelta: () => () => {}, onArtifactComplete: () => () => {},
  onVisualizer: () => () => {}, onVisualizerDelta: () => () => {}, onMcpAppInline: () => () => {},
  onTargetStatus: () => () => {}, onAppChanged: () => () => {}, onMemoryUpdated: () => () => {},
  onTeamChanged: (fn) => window.__mockBus.on('team:changed', fn),
  onConvTitleUpdated: () => () => {}, onInlinePermission: () => () => {}, onPermissionRequest: () => () => {},
  onThinking: () => () => {}, onThinkingEnd: () => () => {},
  respondPermission: () => {}, pasteToTarget: async () => ({ success: true }), hasApiKey: async () => ({ hasKey: true }),
  getRoleInitState: async () => ({ hasRole: true, role: ROLE }),
  getAllRoles: async () => [ROLE], getCurrentRole: async () => ROLE, switchRole: async () => ROLE,
  listConversations: async () => CONVERSATIONS,
  createConversation: async (role, title, agentId, workspaceId, team) => {
    const conv = { id: 'conv-new', title: title || '新对话', role, agentId, workspaceId: team ? TEAMS.find(t => t.id === team.teamId)?.lead : workspaceId, teamId: team?.teamId, channel: team?.channel, createdAt: Date.now(), updatedAt: Date.now(), messageCount: 0 };
    CONVERSATIONS.unshift(conv);
    return conv;
  },
  getConversationMessages: async () => [],
  replaceMessages: async () => {}, appendMessages: async () => {}, deleteConversation: async () => {},
  getAppSettings: async () => ({ detected: [], disabled: [], browsers: [] }), setDisabledApps: async () => {},
  getModelConfig: async () => ({ provider: 'openai', baseUrl: '', apiKey: '', model: '' }), saveModelConfig: async () => {},
  getModelConfigFull: async () => ({ provider: 'openai', baseUrl: '', apiKey: '', model: '' }),
  isCustomConfig: async () => ({ isCustom: false }), getAvailableModels: async () => [],
  testConnection: async () => ({ ok: true }), getProviders: async () => ({}), clearModelConfig: async () => {},
  getMemoryConfig: async () => ({ enabled: true }), setMemoryConfig: async () => {},
  getVersion: async () => '0.0.0-test', getAgents: async () => [], listSkills: async () => [],
  listAgents: async () => [...BUILTINS, ...WORKSPACES.map(w => ({ id: w.id, kind: 'pal', builtin: false, name: w.name, icon: w.icon, description: w.description }))],
  listAgentWorkspaces: async () => WORKSPACES, listAgentTemplates: async () => [],
  listTeams: async () => [...TEAMS],
  getTeam: async (id) => {
    const team = TEAMS.find(t => t.id === id); if (!team) return null;
    return { ...team, teamMd: '---\\nname: 教研组\\nlead: ws-3\\nmembers: ws-1, ws-3, ws-2, ws-4\\ntier: auto\\n---\\n\\n我们是语文教研组。教案按 2022 新课标写，练习题先出后审。\\n', charter: '我们是语文教研组。教案按 2022 新课标写，练习题先出后审。', dir: '/tmp/teams/' + id, sharedDir: '/tmp/teams/' + id + '/shared',
      memberProfiles: team.members.map(mid => ({ id: mid, name: WORKSPACES.find(w => w.id === mid)?.name || mid })),
      memories: [{ name: '家长沟通不提分数', content: '---\\ndescription: 家长群里不说具体分数\\n---\\n\\n年级组定的。' }],
      rules: ['no-scores.ts'], sharedFiles: ['周三公开课-v2.md', '课堂练习.md'], tasks: [] };
  },
  foundTeam: async () => { window.__foundCalls = (window.__foundCalls || 0) + 1; WORKSPACES.push({ id: 'ws-lead-new', name: '新团队组长', icon: '🧭', description: '组建团队、分派话题', createdAt: 1, updatedAt: 1, memoryCount: 0, skillCount: 0, taskCount: 0 }); const team = { id: 'c3c3c3c3-0000-4000-8000-000000000003', name: '新团队', lead: 'ws-lead-new', members: ['ws-lead-new'], tier: 'auto', channels: [], createdAt: Date.now(), updatedAt: Date.now() }; TEAMS.push(team); return team; },
  deleteTeam: async () => ({ ok: true }),
  writeTeamMd: async () => ({ ok: true }),
  readTeamFile: async (id, rel) => '# ' + rel + '\\n\\n内容示意',
  getMark: async () => null,
  getOnboardingStatus: async () => ({ completed: true }), setOnboardingCompleted: async () => {},
  getRealtimeConfig: async () => ({ provider: 'openai', url: '', model: '', deployment: '', apiVersion: '', voice: 'alloy', hasKey: false }),
  steerChat: async () => ({ ok: true }), queueChat: async () => ({ ok: true }),
  getSources: async () => [], listModelPresets: async () => []
};
`

test.use({ viewport: { width: 1200, height: 800 } })

async function openApp(page: Page): Promise<void> {
  await page.addInitScript({ content: MOCK_API })
  await page.goto('/')
  await page.waitForLoadState('networkidle')
  await expect(page.getByTestId('sidebar')).toBeVisible()
}

test('左栏：团队分组在上、对话按日期分级在下；团队可折叠、频道分层、空频道也能开话题', async ({ page }) => {
  await openApp(page)
  const teams = page.getByTestId('sidebar-teams')
  await expect(teams).toBeVisible()
  await expect(teams.getByTestId('sidebar-create-team')).toBeVisible()
  await expect(teams.locator('[data-testid="sidebar-team"]')).toHaveCount(2)
  // 有话题的团队按最近活动排前面；还没话题的团队也列出来
  await expect(teams.locator('[data-testid="sidebar-team"]').nth(0)).toContainText('教研组')
  await expect(teams.locator('[data-testid="sidebar-team"]').nth(1)).toContainText('小红书运营')
  // 成员头像排排站：第一个是 Lead（ws-3）站最前，四人只画三个，后一个叠在前一个身后；不盖"更多"遮罩、不写 +N
  const stack = teams.locator('[data-testid="sidebar-team"]').nth(0).getByTestId('team-member-stack')
  await expect(stack.locator('[data-member-id]')).toHaveCount(3)
  await expect(stack.locator('[data-member-id]').nth(0)).toHaveAttribute('data-member-id', 'ws-3')
  await expect(stack).not.toContainText(/[+⋯]/)
  const heads = await stack.locator('[data-member-id]').evaluateAll(els => els.map(el => el.getBoundingClientRect()))
  expect(heads[1].left).toBeLessThan(heads[0].right) // 叠着，不是并排
  expect(heads[1].left).toBeGreaterThan(heads[0].left)
  // 单人团队画团队 mark，没有成员格
  await expect(teams.locator('[data-testid="sidebar-team"]').nth(1).getByTestId('team-member-stack')).toHaveCount(0)
  // 标题铺满整行：悬停才出的 + / 时间 / 删除不占宽度（所有者 2026-09-16：明明有地方也被省略）
  const reach = async (rowSel: string, titleId: string): Promise<number> => {
    const row = teams.locator(rowSel).first()
    const rowBox = (await row.boundingBox())!
    const titleBox = (await row.getByTestId(titleId).first().boundingBox())!
    return rowBox.x + rowBox.width - (titleBox.x + titleBox.width)
  }
  expect(await reach('[data-testid="sidebar-team"][data-team-id^="b2b2"] [data-testid="team-toggle"]', 'team-name')).toBeLessThanOrEqual(13) // px-3 = 12
  const convRow = page.getByTestId('sidebar').locator('button:has([data-testid="conv-title"])').first()
  const convBox = (await convRow.boundingBox())!
  const titleBox = (await convRow.getByTestId('conv-title').boundingBox())!
  expect(convBox.x + convBox.width - (titleBox.x + titleBox.width)).toBeLessThanOrEqual(13)
  await convRow.hover() // 悬停：时间 + 删除从行底色里浮出来盖住标题尾巴
  await expect(convRow.getByLabel('删除对话')).toBeVisible()
  await page.getByTestId('sidebar').screenshot({ path: 'tests/artifacts/team-sidebar/row-hover.png' })
  await expect(page.getByTestId('sidebar-conversations-header')).toHaveText('对话')
  // 单对话一列按最近更新排，没有日期小标签（团队话题不进这里）
  const sidebar = page.getByTestId('sidebar')
  for (const label of ['今天', '昨天', '过去 7 天', '更早']) await expect(sidebar.getByText(label, { exact: true })).toHaveCount(0)
  await expect(sidebar.getByText('周三公开课教案改新课标')).toHaveCount(0) // 团队默认收起
  await expect(sidebar.getByText('整理会议纪要')).toBeVisible()
  await page.screenshot({ path: `${ARTIFACTS_DIR}/01-sidebar-collapsed.png` })

  // 展开教研组：频道 备课(2) / 家长沟通(1) / 批改(空，也列出来)；话题挂在频道下
  const team1 = teams.locator('[data-testid="sidebar-team"]').nth(0)
  await team1.getByTestId('team-toggle').click()
  await expect(team1).toHaveAttribute('data-open', 'true')
  await expect(team1.locator('[data-testid="sidebar-channel"]')).toHaveCount(3)
  const channels = await team1.locator('[data-testid="sidebar-channel"]').allTextContents()
  expect(channels.map(s => s.replace(/\s+/g, ''))).toEqual(['备课2', '家长沟通1', '批改'])
  await expect(team1.getByText('周三公开课教案改新课标')).toBeVisible()
  await expect(team1.getByText('单元测验出题')).toBeVisible()
  await expect(team1.getByText('家长会通知')).toBeVisible()
  // 有频道的团队：团队行上没有 ＋（得选频道），频道行上有
  await expect(team1.getByTestId('team-new-thread')).toHaveCount(0)
  await expect(team1.getByTestId('channel-new-thread')).toHaveCount(3)
  // 没频道的团队：团队行上有 ＋
  const team2 = teams.locator('[data-testid="sidebar-team"]').nth(1)
  await expect(team2.getByTestId('team-new-thread')).toHaveCount(1)
  await page.screenshot({ path: `${ARTIFACTS_DIR}/02-sidebar-expanded.png` })
})

test('点开团队话题：徽标、空状态列成员、中栏换成团队目录并可编辑 team.md', async ({ page }) => {
  await openApp(page)
  const team1 = page.getByTestId('sidebar-teams').locator('[data-testid="sidebar-team"]').nth(0)
  await team1.getByTestId('team-toggle').click()
  await team1.getByText('周三公开课教案改新课标').click()

  await expect(page.getByTestId('team-badge')).toHaveText(/教研组 › 备课/)
  const onboarding = page.getByTestId('team-onboarding')
  await expect(onboarding).toBeVisible()
  await expect(onboarding.getByTestId('team-members')).toContainText('出题 Pal · Lead')
  await expect(onboarding.getByTestId('team-members')).toContainText('备课 Pal')

  const inspector = page.getByTestId('team-inspector')
  await expect(inspector).toBeVisible()
  await expect(inspector.getByTestId('team-inspector-name')).toContainText('教研组')
  await expect(inspector.getByTestId('team-inspector-name')).toContainText('备课')
  await expect(inspector.locator('[data-testid="team-inspector-member"]')).toHaveCount(4)
  await expect(inspector.locator('[data-testid="team-inspector-member"]').nth(1)).toContainText('Lead')
  // 成员行画的是 Mark（没捏过就按 id 现算），不是 meta 里的 emoji
  await expect(inspector.locator('[data-testid="team-inspector-member"]').nth(0).locator('svg').first()).toBeVisible()
  await expect(inspector.locator('[data-testid="team-inspector-member"]').nth(0)).not.toContainText('📐')
  await expect(inspector.getByText('家长沟通不提分数.md')).toBeVisible()
  await expect(inspector.getByText('no-scores.ts')).toBeVisible()
  await expect(inspector.getByText('周三公开课-v2.md')).toBeVisible()
  await expect(inspector.getByTestId('team-md-declarations')).toContainText('lead: ws-3')
  await expect(inspector.getByText('教案按 2022 新课标写')).toBeVisible()
  await page.screenshot({ path: `${ARTIFACTS_DIR}/03-thread-inspector.png` })

  await inspector.getByTestId('team-md-edit').click()
  await expect(inspector.getByTestId('team-md-editor')).toBeVisible()
  await inspector.getByTestId('team-md-save').click()
  await expect(inspector.getByTestId('team-md-editor')).toHaveCount(0)

  // 从频道行的 ＋ 开一条新话题：徽标带频道，话题落进那个频道
  await team1.locator('[data-testid="sidebar-channel"][data-channel="批改"]').hover()
  await team1.locator('[data-testid="sidebar-channel"][data-channel="批改"] [data-testid="channel-new-thread"]').click()
  await expect(page.getByTestId('team-badge')).toHaveText(/教研组 › 批改/)
  await page.screenshot({ path: `${ARTIFACTS_DIR}/04-new-thread-in-channel.png` })
})

test('还没有团队：左栏「团队」分组照样在，一行空态；标题旁的 ＋ 不弹窗，直接开一条跟组长的话题', async ({ page }) => {
  await page.addInitScript({ content: MOCK_API.replace('listTeams: async () => [...TEAMS]', 'listTeams: async () => TEAMS.filter(t => t.name === \'新团队\')').replace('listConversations: async () => CONVERSATIONS', 'listConversations: async () => CONVERSATIONS.filter(c => !c.teamId)') })
  await page.goto('/')
  await page.waitForLoadState('networkidle')
  const teams = page.getByTestId('sidebar-teams')
  await expect(teams).toBeVisible()
  await expect(teams.getByTestId('sidebar-teams-empty')).toHaveText('还没有团队，点 ＋ 组一个')
  await expect(teams.locator('[data-testid="sidebar-team"]')).toHaveCount(0)
  await expect(page.getByTestId('sidebar-conversations-header')).toHaveText('对话')
  await page.screenshot({ path: `${ARTIFACTS_DIR}/07-sidebar-no-teams.png` })

  await teams.getByTestId('sidebar-create-team').click()
  await expect(page.getByTestId('team-dialog')).toHaveCount(0)
  await expect(page.getByTestId('team-badge')).toHaveText(/新团队/)
  await expect(page.getByTestId('team-onboarding')).toContainText('团队刚成立')
  await expect(page.getByTestId('team-onboarding').getByTestId('team-members')).toContainText('新团队组长 · Lead')
  await expect(teams.locator('[data-testid="sidebar-team"]')).toHaveCount(1)
  await expect(teams.locator('[data-testid="sidebar-team"]').first()).toContainText('新团队')
  expect(await page.evaluate(() => (window as any).__foundCalls)).toBe(1)
  await page.screenshot({ path: `${ARTIFACTS_DIR}/08-founding-thread.png` })
})

test('我的 Pal 页：团队分组；「组建团队」同样直接开话题', async ({ page }) => {
  await openApp(page)
  await page.evaluate(() => (window as any).__appStore.getState().setActiveView('agents'))
  await expect(page.getByTestId('teams-create')).toBeVisible()
  const teamsSection = page.locator('[data-section="teams"]')
  await expect(teamsSection).toBeVisible()
  await expect(teamsSection.locator('[data-testid="agent-row"]')).toHaveCount(2)
  await expect(teamsSection.locator('[data-testid="agent-row"]').nth(0)).toContainText('备课 Pal、出题 Pal（Lead）、文案 Pal、批改 Pal')
  await expect(teamsSection.locator('[data-testid="agent-row"]').nth(0)).toContainText('4 个成员 · 3 个频道')
  await page.screenshot({ path: `${ARTIFACTS_DIR}/05-agents-teams.png` })

  await page.getByTestId('teams-create').click()
  await expect(page.getByTestId('team-dialog')).toHaveCount(0)
  await expect(page.getByTestId('team-badge')).toHaveText(/新团队/)
  await expect(page.getByTestId('sidebar-teams').locator('[data-testid="sidebar-team"]')).toHaveCount(3)
})

test('组长边聊边落：主进程一说团队目录变了，左栏名字、成员格、徽标、面板名单当场刷新，不等话题跑完', async ({ page }) => {
  await openApp(page)
  const teams = page.getByTestId('sidebar-teams')
  const team2 = teams.locator('[data-testid="sidebar-team"]').nth(1)
  await expect(team2).toContainText('小红书运营')
  await team2.hover()
  await team2.getByTestId('team-new-thread').click()
  await expect(page.getByTestId('team-badge')).toHaveText(/小红书运营/)
  await expect(page.getByTestId('team-inspector').locator('[data-testid="team-inspector-member"]')).toHaveCount(1)

  // 模拟组长在这一轮里 manage_team：改名 + 建成员 → 主进程发 team:changed（话题还在跑，没有 stream-end）
  await page.evaluate(() => {
    const w = window as any
    const TEAMS = w.__TEAMS as any[]
    const WORKSPACES = w.__WORKSPACES as any[]
    const team = TEAMS[1]
    team.name = '小红书运营组'
    WORKSPACES.push({ id: 'ws-new-1', name: '选题 Pal', icon: '🤖', description: '找选题', createdAt: 1, updatedAt: 1, memoryCount: 0, skillCount: 0, taskCount: 0 })
    team.members = [...team.members, 'ws-new-1']
    w.__mockBus.emit('team:changed', team.id)
  })
  await expect(teams.locator('[data-testid="sidebar-team"]').nth(1)).toContainText('小红书运营组')
  await expect(teams.locator('[data-testid="sidebar-team"]').nth(1).getByTestId('team-member-stack').locator('[data-member-id]')).toHaveCount(2)
  await expect(page.getByTestId('team-badge')).toHaveText(/小红书运营组/)
  await expect(page.getByTestId('team-inspector').locator('[data-testid="team-inspector-member"]')).toHaveCount(2)
  await page.screenshot({ path: `${ARTIFACTS_DIR}/06-live-refresh.png` })
})

test('运行状态点只亮一处：收起看团队行（几条在跑也只一个），展开看话题行；悬停 ＋ 站在状态点左边不重叠', async ({ page }) => {
  await openApp(page)
  const teams = page.getByTestId('sidebar-teams')
  const team1 = teams.locator('[data-testid="sidebar-team"][data-team-id^="a1a1"]')
  const team2 = teams.locator('[data-testid="sidebar-team"][data-team-id^="b2b2"]')
  // 给没频道的「小红书运营」塞一条话题；教研组两条 + 这一条都标成在跑
  await page.evaluate(() => {
    const w = window as any
    const store = w.__chatStore
    const now = Date.now()
    store.setState({
      conversations: [...store.getState().conversations, { id: 'c8', title: '选题会', role: 'general', workspaceId: 'ws-2', teamId: w.__TEAMS[1].id, createdAt: now, updatedAt: now, messageCount: 1 }],
      streamingConvIds: { c1: true, c2: true, c8: true }
    })
  })
  const spinners = (scope: ReturnType<Page['locator']>) => scope.locator('[role="img"][aria-label="生成中…"]')
  // 收起：教研组两条在跑，团队行只转一个（悬停条里的副本不算：没悬停时它在 DOM 里但不可见）
  await expect(team1).toHaveAttribute('data-open', 'false')
  await expect(spinners(team1.getByTestId('team-toggle'))).toHaveCount(1)
  await page.getByTestId('sidebar').screenshot({ path: `${ARTIFACTS_DIR}/09-status-collapsed.png` })
  // 展开：团队行不转，两条话题行各转各的
  await team1.getByTestId('team-toggle').click()
  await expect(team1).toHaveAttribute('data-open', 'true')
  await expect(spinners(team1.getByTestId('team-toggle'))).toHaveCount(0)
  await expect(spinners(team1.getByTestId('team-threads'))).toHaveCount(2)
  await page.getByTestId('sidebar').screenshot({ path: `${ARTIFACTS_DIR}/10-status-expanded.png` })
  // 没频道的团队收起着、有一条在跑：悬停时 ＋ 出来，状态点仍在行尾，＋ 整个在它左边
  await expect(team2).toHaveAttribute('data-open', 'false')
  await team2.getByTestId('team-toggle').hover()
  const plus = team2.getByTestId('team-new-thread')
  await expect(plus).toBeVisible()
  const overlayDot = team2.locator('[data-testid="team-new-thread"] + [role="img"]')
  await expect(overlayDot).toBeVisible()
  const plusBox = (await plus.boundingBox())!
  const dotBox = (await overlayDot.boundingBox())!
  expect(plusBox.x + plusBox.width).toBeLessThanOrEqual(dotBox.x + 0.5)
  await page.getByTestId('sidebar').screenshot({ path: `${ARTIFACTS_DIR}/11-status-hover-plus.png` })
})

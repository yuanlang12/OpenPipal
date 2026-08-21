/**
 * E2E: 技能导入 / 删除（SkillsHub）
 *
 * 覆盖:
 *   1. 列表来源标签(内置/自定义/MCP) + 导入入口 + 删除按钮仅对自定义技能可见
 *   2. 本地文件夹导入全流程: 选目录 → 候选勾选(三种冲突标注) → 应用 → 反馈 + 列表刷新
 *   3. GitHub 链接导入入口: URL 输入 → 扫描 → 进入候选步骤
 *   4. 删除自定义技能: 行内二次确认 → 删除 → 反馈 + 列表移除
 *
 * window.api 全量 mock(addInitScript),不依赖 main 进程。
 */
import { test, expect, Page } from '@playwright/test'

const ARTIFACTS_DIR = 'tests/artifacts/skills-import'

const MOCK_API = `
window.__mockBus = { listeners: {}, on(e, fn){ (this.listeners[e]=this.listeners[e]||[]).push(fn); return () => {} }, emit(){} };
window.__skills = [
  { name: 'skill-creator', description: '指导 AI 创建结构良好的技能包', enabled: true, builtIn: true, source: 'builtin', dir: '/mock/builtin/skill-creator' },
  { name: 'my-notes', description: '个人笔记整理流程', enabled: true, builtIn: false, source: 'user', dir: '/mock/user/my-notes' },
  { name: 'web-clip', description: '网页剪藏与归档', enabled: true, builtIn: false, source: 'mcp', mcpServer: 'clipper', dir: '/mock/user/_mcp/clipper/web-clip' }
];
window.api = {
  getLocaleState: async () => ({ preference: 'zh-CN', locale: 'zh-CN' }),
  // ── 基础启动底座(与 memory-archive-ui.spec.ts 相同,已验证可完整挂载应用) ──
  sendChat: () => {}, abortChat: () => {},
  onStreamChunk: (cb) => window.__mockBus.on('stream-chunk', cb),
  onStreamEnd: (cb) => window.__mockBus.on('stream-end', cb),
  onTextFlush: (cb) => window.__mockBus.on('text-flush', cb),
  onToolStart: (cb) => window.__mockBus.on('tool-start', cb),
  onToolEnd: (cb) => window.__mockBus.on('tool-end', cb),
  onAskUser: (cb) => window.__mockBus.on('ask-user', cb),
  onTargetStatus: (cb) => window.__mockBus.on('target-status', cb),
  onAppChanged: (cb) => window.__mockBus.on('app-changed', cb),
  onPermissionRequest: () => () => {}, onThinking: () => () => {}, onThinkingEnd: () => () => {},
  onVisualizerDelta: () => () => {}, onArtifactDelta: () => () => {}, onArtifactComplete: () => () => {},
  getRoleInitState: async () => ({ hasRole: true, role: { name: 'learner', displayName: '学习助手', icon: '📖' } }),
  getAllRoles: async () => [{ name: 'learner', displayName: '学习助手', icon: '📖' }],
  getCurrentRole: async () => ({ name: 'learner', displayName: '学习助手', icon: '📖' }),
  switchRole: async () => ({ name: 'learner', displayName: '学习助手', icon: '📖' }),
  listConversations: async () => [],
  createConversation: async (role) => ({ id: 'mock-conv', title: '新对话', role, createdAt: Date.now(), updatedAt: Date.now(), messageCount: 0 }),
  getConversationMessages: async () => [],
  replaceMessages: async () => {}, appendMessages: async () => {}, deleteConversation: async () => {},
  getAppSettings: async () => ({ detected: [], disabled: [], browsers: [] }),
  setDisabledApps: async () => {},
  isCustomConfig: async () => ({ isCustom: false }),
  getAvailableModels: async () => [],
  getModelConfig: async () => ({ provider: 'openai', baseUrl: '', apiKey: '', model: '' }),
  getModelConfigFull: async () => ({ provider: 'openai', baseUrl: '', apiKey: '', model: '' }),
  saveModelConfig: async () => {}, listModelPresets: async () => [],
  testConnection: async () => ({ ok: true, model: 'gpt-4o' }),
  getProviders: async () => ({}),
  clearModelConfig: async () => {},
  getRealtimeConfig: async () => ({ provider: 'openai', url: '', model: '', deployment: '', apiVersion: '', voice: 'alloy', hasKey: false }),
  startRealtime: async () => ({ success: false }),
  stopRealtime: () => {}, sendRealtimeEvent: () => {},
  onRealtimeEvent: () => () => {}, onRealtimeState: () => () => {},
  getMemoryConfig: async () => ({ autoMemoryEnabled: true, globalDir: '/Users/x/.openpipal/memory/global' }),
  setMemoryConfig: async () => ({ ok: true }),
  listGlobalMemories: async () => [], listArchivedMemories: async () => [],
  readMemory: async () => null, deleteMemory: async () => true,
  getVersion: async () => '0.0.0-test',
  getAgents: async () => [], listAgentTemplates: async () => [], listWorkspaces: async () => [],
  getSources: async () => [], pasteToTarget: async () => ({ success: true }),

  // ---- Skills(本 spec 的主角) ----
  listSkills: async () => window.__skills,
  setSkillDisabled: async () => ({ ok: true }),
  getSkillDetails: async () => null,
  selectDirectory: async () => '/Users/mock/downloaded-skills',
  importScanSkills: async () => ({ ok: true, scanId: 'scan-1', candidates: [
    { name: 'pdf-tools', description: 'PDF 拆分合并与表单填写', conflict: 'none' },
    { name: 'my-notes', description: '个人笔记整理流程(新版)', conflict: 'user' },
    { name: 'skill-creator', description: '与内置同名的重复技能', conflict: 'builtin' }
  ]}),
  importApplySkills: async ({ names }) => {
    for (const n of names) window.__skills = window.__skills.filter(s => s.name !== n).concat([{ name: n, description: '导入的技能 ' + n, enabled: true, builtIn: false, source: 'user', dir: '/mock/user/' + n }]);
    return { ok: true, installed: names, skipped: [] };
  },
  deleteSkill: async (name) => { window.__skills = window.__skills.filter(s => s.name !== name); return { ok: true } }
};
`

// SkillsHub 挂在 ToolsHub 里,420 窄视口会挤没主内容区,用宽视口(同 memory-archive 先例)
test.use({ viewport: { width: 1000, height: 700 } })

async function openSkillsTab(page: Page): Promise<void> {
  await page.addInitScript({ content: MOCK_API })
  await page.goto('/')
  await page.waitForLoadState('networkidle')
  // 侧栏有 icon/展开两种形态,合并选择器都能命中。
  // 入口从「技能和工具」改名成「插件」(shell.navigation.plugins / toolsHub.title)之后,
  // 这里一直点不到,四条用例全卡在这一步 —— 改名时测试没跟着改。
  await page.locator('button[title="插件"], button:has-text("插件")').first().click()
  // 「插件」现在既是页面标题也是第一个 tab 名,用 first() 收敛掉 strict 模式冲突
  await expect(page.getByRole('heading', { name: '插件' }).first()).toBeVisible({ timeout: 5000 })
  // 默认 tab 是「插件」,切到「技能」tab 再等列表渲染。
  // tab 是 role="tab" 不是 button —— 早先它确实是普通按钮,加上 tablist 语义之后
  // getByRole('button') 就再也命中不到了。
  await page.getByRole('tab', { name: '技能', exact: true }).click()
  await expect(page.getByText('skill-creator').first()).toBeVisible({ timeout: 5000 })
}

test.describe('技能导入与删除', () => {
  test('列表来源标签 + 导入入口 + 删除按钮仅自定义技能可见', async ({ page }) => {
    await openSkillsTab(page)

    await expect(page.getByRole('button', { name: '导入技能' })).toBeVisible()
    await expect(page.getByText('内置').first()).toBeVisible()
    await expect(page.getByText('自定义').first()).toBeVisible()
    await expect(page.getByText('MCP · clipper')).toBeVisible()
    console.log('[skills-1] 三种来源标签 + 导入按钮渲染 - 通过')

    // 删除按钮只出现在 source==='user' 的行(my-notes),内置/MCP 不可删
    await expect(page.locator('button[title^="删除技能"]')).toHaveCount(1)
    console.log('[skills-1] 删除按钮仅自定义技能可见 - 通过')

    await page.screenshot({ path: `${ARTIFACTS_DIR}/list.png` })
  })

  test('本地文件夹导入全流程: 候选冲突标注 → 应用 → 反馈刷新', async ({ page }) => {
    await openSkillsTab(page)

    await page.getByRole('button', { name: '导入技能' }).click()
    await expect(page.getByText('从本地文件夹…')).toBeVisible()
    await expect(page.getByText('从 GitHub 仓库…')).toBeVisible()
    await page.waitForTimeout(400) // 等淡入动画结束再截图,避免抓到半透明瞬态
    await page.screenshot({ path: `${ARTIFACTS_DIR}/modal-source.png` })

    await page.getByText('从本地文件夹…').click()
    await expect(page.getByText('选择要导入的技能')).toBeVisible({ timeout: 5000 })

    // 三种冲突标注各就各位
    await expect(page.getByText('与内置技能同名，无法安装')).toBeVisible()
    await expect(page.getByText('将覆盖已有同名技能')).toBeVisible()
    // builtin 候选被排除在默认勾选外 → 按钮显示 2 个
    await expect(page.getByRole('button', { name: '导入 2 个技能' })).toBeVisible()
    console.log('[skills-2] 候选步骤: 冲突标注 + 默认勾选排除内置 - 通过')
    await page.screenshot({ path: `${ARTIFACTS_DIR}/modal-candidates.png` })

    await page.getByRole('button', { name: '导入 2 个技能' }).click()
    await expect(page.getByText('已导入 2 个技能')).toBeVisible({ timeout: 5000 })
    await expect(page.getByText('pdf-tools').first()).toBeVisible()
    console.log('[skills-2] 应用后反馈横幅 + 列表出现新技能 - 通过')
    await page.screenshot({ path: `${ARTIFACTS_DIR}/after-import.png` })
  })

  test('GitHub 链接导入入口: URL 输入 → 扫描进入候选步骤', async ({ page }) => {
    await openSkillsTab(page)

    await page.getByRole('button', { name: '导入技能' }).click()
    await page.getByText('从 GitHub 仓库…').click()
    const urlInput = page.getByPlaceholder('https://github.com/anthropics/skills')
    await expect(urlInput).toBeVisible()
    await urlInput.fill('https://github.com/anthropics/skills')
    await page.getByRole('button', { name: '确认' }).click()
    await expect(page.getByText('选择要导入的技能')).toBeVisible({ timeout: 5000 })
    console.log('[skills-3] GitHub URL 扫描进入候选步骤 - 通过')
    await page.screenshot({ path: `${ARTIFACTS_DIR}/github-flow.png` })
  })

  test('删除自定义技能: 行内二次确认 → 反馈 + 列表移除', async ({ page }) => {
    await openSkillsTab(page)

    await page.locator('button[title^="删除技能"]').click()
    await expect(page.getByText('确认删除？')).toBeVisible()
    // 确认按钮是「确认删除？」的紧邻兄弟,避免误命中垃圾桶按钮(title 同为「删除」)
    await page.getByText('确认删除？').locator('xpath=following-sibling::button[1]').click()

    // 文案以 toolsHub.skills.deleted 为准:用的是中文弯引号“”,不是直角引号「」
    await expect(page.getByText('已删除技能“my-notes”')).toBeVisible({ timeout: 5000 })
    await expect(page.locator('text=个人笔记整理流程')).toHaveCount(0)
    console.log('[skills-4] 删除自定义技能 + 反馈 + 列表移除 - 通过')
    await page.screenshot({ path: `${ARTIFACTS_DIR}/after-delete.png` })
  })
})

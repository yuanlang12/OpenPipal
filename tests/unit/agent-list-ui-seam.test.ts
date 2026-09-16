/**
 * 统一身份第 4 段（UI）：一份列表两个分区、一个动词。
 *   - 主进程给渲染层一份摘要列表（内置 → Pal → 模板），内置可复制成 Pal（人设 + 声明 + 点名它的专属技能）
 *   - 切换器 / 我的 Pal 页 / 欢迎页都从这份列表画，选谁都走 startConversationWith
 *   - 内置行带徽标、不可删；欢迎页的模板卡片没了（模板进了头像行）
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'

const HOME = mkdtempSync(join(tmpdir(), 'openpipal-agent-list-'))
process.env.OPENPIPAL_ISOLATED_HOME = HOME
const DATA = join(HOME, '.openpipal')
vi.mock('electron', () => ({ app: { isPackaged: false, getAppPath: () => process.cwd(), getPath: () => HOME } }))

const PAL = 'c1c2c3c4-0000-4000-8000-000000000009'
mkdirSync(join(DATA, 'agents', PAL), { recursive: true })
writeFileSync(join(DATA, 'agents', PAL, 'meta.json'), JSON.stringify({ id: PAL, name: '周报小助手', icon: '📝', description: '每周五整理周报', category: '办公 ', createdAt: 1, updatedAt: 1 }), 'utf8')
writeFileSync(join(DATA, 'agents', PAL, 'agent.md'), '# 周报小助手\n', 'utf8')

const registry = await import('../../src/main/agent-registry')
const read = (file: string): string => readFileSync(file, 'utf8')
afterAll(() => rmSync(HOME, { recursive: true, force: true }))

describe('主进程：摘要列表与复制内置', () => {
  it('listAgentSummaries：内置在前带 builtin 标记，Pal 在后带描述；不带提示词', () => {
    const list = registry.listAgentSummaries()
    expect(list[0]).toMatchObject({ id: 'general', kind: 'builtin', category: 'general' })
    expect(Object.keys(list[0])).not.toContain('builtin')   // 内置 = kind === 'builtin'，不再另存一份
    const pal = list.find(a => a.id === PAL)!
    expect(pal).toMatchObject({ kind: 'pal', name: '周报小助手', icon: '📝', description: '每周五整理周报', category: '办公' })
    expect(Object.keys(pal)).not.toContain('systemPrompt')
  })

  it('分类：每个内置都有分类键；Pal 的分类来自 meta.json（首尾空白去掉，空串等于没写）；listWorkspaces 同一份', async () => {
    for (const agent of registry.listAgents().filter(a => a.kind === 'builtin')) expect(agent.category, agent.id).toBe(registry.BUILTIN_CATEGORY[agent.id])
    expect(registry.BUILTIN_CATEGORY).toMatchObject({ general: 'general', learner: 'education', teacher: 'education', office: 'office', interpreter: 'language', design: 'design', coding: 'coding' })
    const store = await import('../../src/main/agent-workspace-store')
    expect(store.listWorkspaces().find(w => w.id === PAL)?.category).toBe('办公')
    const blank = store.createWorkspace({ name: '没分类', icon: '·', description: '', category: '' })
    expect(registry.getAgent(blank.id)?.category).toBeUndefined()
    expect(Object.keys(JSON.parse(read(join(DATA, 'agents', blank.id, 'meta.json'))))).not.toContain('category')
  })

  it('copyBuiltinAsPal：新 Pal 的 agent.md = 声明 frontmatter + 人设正文；点名了内置的专属技能；不是内置的返回 undefined', () => {
    const meta = registry.copyBuiltinAsPal('coding')!
    expect(meta.name).toBe(`${registry.getAgent('coding')!.name} 副本`)
    const md = read(join(DATA, 'agents', meta.id, 'agent.md'))
    expect(md.startsWith('---\n')).toBe(true)
    expect(md).toMatch(/^permission-tier: allowed$/m)
    expect(md).toMatch(/^skills: .*repo-onboarding/m)
    expect(md).toContain(registry.getAgent('coding')!.systemPrompt.trim().slice(0, 40))
    const copy = registry.getAgent(meta.id)!
    expect(copy.kind).toBe('pal')
    expect(copy.category).toBe('coding')   // 副本落在原来的分类里
    expect(copy.policies.permissionTier).toBe('allowed')
    expect(copy.policies.skills).toContain('repo-onboarding')
    expect(copy.systemPrompt).not.toContain('permission-tier')
    expect(existsSync(join(DATA, 'agents', meta.id, 'hooks'))).toBe(false)   // hooks/ 由定规则时按需建
    expect(registry.copyBuiltinAsPal(PAL)).toBeUndefined()
    expect(registry.copyBuiltinAsPal('nope')).toBeUndefined()
  })
})

describe('接线', () => {
  it('IPC / preload / HTTP / 插件 shim 都有 agents:list 与复制入口', () => {
    expect(read('src/main/ipc-handlers.ts')).toMatch(/ipcMain\.handle\('agents:list', \(\) => listAgentSummaries\(\)\)/)
    expect(read('src/main/ipc-handlers.ts')).toMatch(/ipcMain\.handle\('agents:copy-builtin'/)
    expect(read('src/preload/index.ts')).toContain("ipcRenderer.invoke('agents:list')")
    expect(read('src/preload/index.ts')).toContain("ipcRenderer.invoke('agents:copy-builtin', id)")
    expect(read('src/main/http-server.ts')).toMatch(/url === '\/api\/agents' && req\.method === 'GET'[\s\S]*?listAgentSummaries\(\)/)
    expect(read('src/renderer/src/web-api-shim.ts')).toMatch(/async listAgents\(\)[\s\S]*?\/api\/agents/)
    expect(read('src/renderer/src/stores/appStore.ts')).toMatch(/loadAgents: \(\) =>[\s\S]*?window\.api\.listAgents\?\.\(\)/)
  })

  it('三处入口同一个动词：切换器 / 我的 Pal 页 / 欢迎页都走 startConversationWith，头像都走 AgentAvatar', () => {
    for (const file of ['AgentSwitcher.tsx', 'AgentsPanel.tsx', 'WelcomePage.tsx']) {
      const source = read(`src/renderer/src/components/${file}`)
      expect(source, file).toContain('startConversationWith(')
      expect(source, file).toContain('<AgentAvatar')
    }
    const verb = read('src/renderer/src/utils/startConversationWith.ts')
    expect(verb).toMatch(/kind === 'builtin'[\s\S]*?chat\.newConversation\(agent\.id\)/)
    expect(verb).not.toContain('switchRole')
    expect(verb).toMatch(/else \{\n\s*await chat\.newConversationFromWorkspace\(agent\.id, agent\.name\)/)
    expect(verb).not.toContain('newConversationFromAgent')
  })

  it('切换器分区是「OpenPipal 官方 / 我的 Pal」；我的 Pal 页内置行不可删、可复制、不打徽标；欢迎页没有模板卡片', () => {
    const switcher = read('src/renderer/src/components/AgentSwitcher.tsx')
    expect(switcher).toContain("t('shell.agentSwitcher.builtins')")
    expect(switcher).toContain("t('shell.navigation.myAgents')")
    expect(switcher).not.toContain("t('shell.agentSwitcher.globalRoles')")
    expect(switcher).toContain('data-agent-kind={agent.kind}')
    const panel = read('src/renderer/src/components/AgentsPanel.tsx')
    expect(panel).toContain("'agents-builtin'")
    expect(panel).not.toContain('agents.badge')
    expect(panel).not.toContain('agents-filters')
    expect(panel).toMatch(/onCopy=\{\(\) => \{ void handleCopyBuiltin\(agent\) \}\}/)
    expect(panel).toMatch(/kind="builtin"[\s\S]*?onTry=\{\(\) => \{ void startConversationWith\(agent\) \}\}/)
    expect(panel).toMatch(/\{!onDelete \? null : confirming \?/)
    const welcome = read('src/renderer/src/components/WelcomePage.tsx')
    expect(welcome).toContain('data-testid="welcome-my-agent"')
    expect(welcome).not.toContain("t('welcome.templatesTitle')")
  })

  it('我的 Pal 页：搜索框 + 分类分组（没有筛选片）；分类显示名走 agents.category.<键> 且认不出的原样显示', () => {
    const panel = read('src/renderer/src/components/AgentsPanel.tsx')
    expect(panel).toContain('data-testid="agents-search"')
    expect(panel).toMatch(/translate\(`agents\.category\.\$\{value\}`, \{ defaultValue: value \}\)/)
    expect(panel).toMatch(/row\.name\.toLowerCase\(\)\.includes\(q\) \|\| \(row\.description \|\| ''\)\.toLowerCase\(\)\.includes\(q\)/)
    // 保存为 Pal 的写手也知道要填分类
    expect(read('resources/system-agents/evolver/skills/save-agent/SKILL.md')).toMatch(/"category": "one of: general, education, office, language, design, coding/)
  })

  it('中英文案齐全', async () => {
    const { createRendererI18n } = await import('../../src/renderer/src/i18n')
    for (const lang of ['zh-CN', 'en'] as const) {
      const i18n = await createRendererI18n(lang)
      for (const key of ['shell.agentSwitcher.builtins', 'agents.sections.builtin', 'agents.sections.mine', 'agents.sections.other', 'agents.actions.copyAsPal', 'agents.search.placeholder', 'agents.search.empty', ...Object.values(registry.BUILTIN_CATEGORY).map(c => `agents.category.${c}`)]) {
        expect(i18n.t(key), `${lang} ${key}`).not.toMatch(/^(shell|agents)\./)
      }
      expect(i18n.t('agents.actions.copyAsPalNamed', { name: 'X' })).toContain('X')
      expect(i18n.t('agents.category.数学', { defaultValue: '数学' })).toBe('数学')
    }
  })
})

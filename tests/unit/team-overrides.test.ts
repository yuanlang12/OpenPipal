/**
 * 团队话题的 overrides（设计稿 §4 / §5 / §6）：
 *   - 会话记录带 teamId → 系统提示 = Lead 人设 + 团队层 + Lead 记忆；overrides.teamId / workingDir（团队的）跟着走
 *   - 天花板：readonly 压给所有人；auto 压掉 full；full 什么都不放宽
 *   - 频道：章程与 Lead 按频道生效
 *   - 团队目录没了 → 按普通 Pal 会话跑，不整条拒
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'

const HOME = mkdtempSync(join(tmpdir(), 'openpipal-team-overrides-'))
process.env.OPENPIPAL_ISOLATED_HOME = HOME
const DATA = join(HOME, '.openpipal')

vi.mock('electron', () => ({ app: { isPackaged: false, getAppPath: () => process.cwd(), getPath: () => HOME } }))
vi.mock('../../src/main/mcp-manager', () => ({ listMcpSkillDirs: () => [], getMcpToolIndex: () => '', hasVisibleMcpServer: () => false }))
vi.mock('../../src/main/conversation-service', () => ({
  peekConversation: (id: string) => convs.get(id) ?? null,
  listConversationsCached: () => Array.from(convs.values()).sort((a, b) => Number(b.updatedAt ?? 0) - Number(a.updatedAt ?? 0)),
  updateConversationConfig: async () => true
}))
const convs = new Map<string, Record<string, unknown>>()

const pal = (id: string, name: string, frontmatter: string[] = [], memory?: string): void => {
  const dir = join(DATA, 'agents', id)
  mkdirSync(join(dir, 'memory'), { recursive: true })
  writeFileSync(join(dir, 'meta.json'), JSON.stringify({ id, name, icon: '🤖', description: `${name}的介绍`, createdAt: 1, updatedAt: 1 }), 'utf8')
  writeFileSync(join(dir, 'agent.md'), [...(frontmatter.length ? ['---', ...frontmatter, '---', ''] : []), `# ${name}人设`, ''].join('\n'), 'utf8')
  if (memory) writeFileSync(join(dir, 'memory', 'note.md'), memory, 'utf8')
}
const LEAD = 'pal-lead-0000-4000-8000-000000000001'
const MEMBER = 'pal-mem0-0000-4000-8000-000000000002'
const CODER = 'pal-code-0000-4000-8000-000000000003'
pal(LEAD, '备课 Pal', [], '---\ndescription: 偏好\n---\n喜欢短句。\n')
pal(MEMBER, '出题 Pal')
pal(CODER, '会写码的', ['permission-tier: allowed'])

const store = await import('../../src/main/team-store')
const overridesMod = await import('../../src/main/agent-overrides')
afterAll(() => rmSync(HOME, { recursive: true, force: true }))

describe('团队话题的 overrides', () => {
  it('系统提示 = 人设 + 团队层 + 记忆；teamId / 工作目录跟团队走', () => {
    const team = store.createTeam({ name: '教研组', members: [LEAD, MEMBER], charter: '教案按新课标写。' })
    convs.set('c-team', { id: 'c-team', role: 'general', workspaceId: LEAD, agent: LEAD, teamId: team.id })
    const o = overridesMod.resolveAgentOverrides({ conversationId: 'c-team', workspaceId: LEAD })!
    expect(o.teamId).toBe(team.id)
    expect(o.channel).toBeUndefined()
    expect(o.workingDir).toBe(join(team.dir, 'shared'))
    expect(o.workspaceId).toBe(LEAD)
    const prompt = o.systemPrompt
    const iPersona = prompt.indexOf('# 备课 Pal人设')
    const iTeam = prompt.indexOf('## 你所在的团队：教研组')
    const iMemory = prompt.indexOf('## 你的记忆')
    expect(iPersona).toBeGreaterThanOrEqual(0)
    expect(iTeam).toBeGreaterThan(iPersona)
    expect(iMemory).toBeGreaterThan(iTeam)
    expect(prompt).toContain('教案按新课标写。')
    expect(prompt).toContain(`- 出题 Pal id: ${MEMBER} — 出题 Pal的介绍`)
    expect(prompt).toContain('（Lead，就是你）')
    expect(o.permissionTier).toBeUndefined()
  })

  it('会话显式选了目录就以会话为准', () => {
    const team = store.createTeam({ name: '选目录', members: [LEAD] })
    convs.set('c-dir', { id: 'c-dir', role: 'general', workspaceId: LEAD, agent: LEAD, teamId: team.id, config: { workingDir: '/tmp/picked' } })
    const o = overridesMod.resolveAgentOverrides({ conversationId: 'c-dir', workspaceId: LEAD, conversationConfig: { workingDir: '/tmp/picked' } as never })!
    expect(o.workingDir).toBe('/tmp/picked')
  })

  it('没传 workspaceId 的入口补成频道 Lead；频道章程与频道 Lead 生效', () => {
    const team = store.createTeam({ name: '有频道', members: [LEAD, MEMBER], lead: LEAD, charter: '团队章程。' })
    const cdir = join(team.dir, 'channels', '出题')
    mkdirSync(cdir, { recursive: true })
    writeFileSync(join(cdir, 'team.md'), `---\nlead: ${MEMBER}\n---\n\n频道章程。\n`, 'utf8')
    convs.set('c-chan', { id: 'c-chan', role: 'general', workspaceId: MEMBER, agent: MEMBER, teamId: team.id, channel: '出题' })
    const o = overridesMod.resolveAgentOverrides({ conversationId: 'c-chan' })!
    expect(o.workspaceId).toBe(MEMBER)
    expect(o.channel).toBe('出题')
    expect(o.systemPrompt).toContain('## 你所在的团队：有频道 › 出题')
    expect(o.systemPrompt).toContain('团队章程。')
    expect(o.systemPrompt).toContain('频道章程。')
    expect(o.systemPrompt).toContain(`- 出题 Pal（Lead，就是你） id: ${MEMBER}`)
  })

  it('天花板：readonly 压给没有档位开关的 Pal；auto 压掉 full；full 不放宽', () => {
    const ro = store.createTeam({ name: '只读', members: [LEAD], tier: 'readonly' })
    convs.set('c-ro', { id: 'c-ro', role: 'general', workspaceId: LEAD, agent: LEAD, teamId: ro.id })
    expect(overridesMod.resolveAgentOverrides({ conversationId: 'c-ro', workspaceId: LEAD })!.permissionTier).toBe('readonly')

    const auto = store.createTeam({ name: '自动', members: [CODER], tier: 'auto' })
    convs.set('c-auto', { id: 'c-auto', role: 'general', workspaceId: CODER, agent: CODER, teamId: auto.id })
    expect(overridesMod.resolveAgentOverrides({ conversationId: 'c-auto', workspaceId: CODER, conversationConfig: { permissionTier: 'full' } as never })!.permissionTier).toBe('auto')

    const full = store.createTeam({ name: '全开', members: [LEAD], tier: 'full' })
    convs.set('c-full', { id: 'c-full', role: 'general', workspaceId: LEAD, agent: LEAD, teamId: full.id })
    expect(overridesMod.resolveAgentOverrides({ conversationId: 'c-full', workspaceId: LEAD, conversationConfig: { permissionTier: 'full' } as never })!.permissionTier).toBeUndefined()
  })

  it('Lead 的团队层带频道最近话题索引：同团队同频道、不含当前话题；成员版与写记忆的规矩', () => {
    const team = store.createTeam({ name: '索引组', members: [LEAD, MEMBER] })
    convs.set('c-now', { id: 'c-now', title: '当前话题', role: 'general', workspaceId: LEAD, agent: LEAD, teamId: team.id, updatedAt: 3 })
    convs.set('c-old', { id: 'c-old', title: '上周的教案', role: 'general', workspaceId: LEAD, agent: LEAD, teamId: team.id, updatedAt: 2 })
    convs.set('c-chan', { id: 'c-chan', title: '批改频道的', role: 'general', workspaceId: LEAD, agent: LEAD, teamId: team.id, channel: '批改', updatedAt: 1 })
    convs.set('c-other', { id: 'c-other', title: '别的团队的', role: 'general', workspaceId: LEAD, agent: LEAD, teamId: 'team-else', updatedAt: 1 })
    const o = overridesMod.resolveAgentOverrides({ conversationId: 'c-now', workspaceId: LEAD })!
    expect(o.systemPrompt).toContain('### 频道最近话题')
    expect(o.systemPrompt).toContain('- 上周的教案（1970-01-01）产物：')
    expect(o.systemPrompt).toContain(join('outputs', 'c-old'))
    expect(o.systemPrompt).not.toContain('当前话题（')
    expect(o.systemPrompt).not.toContain('批改频道的')
    expect(o.systemPrompt).not.toContain('别的团队的')
    expect(o.systemPrompt).toContain('### 团队记忆怎么写')
    expect(o.systemPrompt).toContain(`${join(team.dir, 'memory')}/<一事一名>.md`)
    const member = store.buildTeamPromptLayer(store.resolveTeamScope(team.id)!, MEMBER, 'member', { recentThreads: [{ title: 'x', updatedAt: 0, outputsDir: '/o' }] })
    expect(member).not.toContain('### 频道最近话题')
    expect(member).toContain('### 团队记忆怎么写')
  })

  it('团队目录没了：按普通 Pal 会话跑，没有团队层', () => {
    convs.set('c-gone', { id: 'c-gone', role: 'general', workspaceId: LEAD, agent: LEAD, teamId: 'team-gone-0000' })
    const o = overridesMod.resolveAgentOverrides({ conversationId: 'c-gone', workspaceId: LEAD })!
    expect(o.teamId).toBeUndefined()
    expect(o.systemPrompt).not.toContain('你所在的团队')
    expect(o.systemPrompt).toContain('# 备课 Pal人设')
  })
})

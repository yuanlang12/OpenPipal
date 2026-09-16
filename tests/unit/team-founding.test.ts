/**
 * 组建团队 = 跟组长聊（设计稿 §7）：
 *   - foundTeam：造默认组长（普通 Pal）+ 只有它的「新团队」
 *   - 组长用 manage_team 起名（默认命名的组长跟着改名）、写章程、建成员 / 加现成 Pal、移出、换 Lead
 *   - manage_team 只给在 App 里跟主人聊的 Lead：scheduler 面没有；不是 Lead 的话题没有
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'

const HOME = mkdtempSync(join(tmpdir(), 'openpipal-team-founding-'))
process.env.OPENPIPAL_ISOLATED_HOME = HOME
const DATA = join(HOME, '.openpipal')
vi.mock('electron', () => ({ app: { isPackaged: false, getAppPath: () => process.cwd(), getPath: () => HOME } }))
vi.mock('../../src/main/mcp-manager', () => ({ listMcpSkillDirs: () => [], getMcpToolIndex: () => '', hasVisibleMcpServer: () => false }))
vi.mock('../../src/main/conversation-service', () => ({ peekConversation: () => null, listConversationsCached: () => [], updateConversationConfig: async () => true }))

const EXISTING = 'pal-old-0000-4000-8000-000000000001'
mkdirSync(join(DATA, 'agents', EXISTING), { recursive: true })
writeFileSync(join(DATA, 'agents', EXISTING, 'meta.json'), JSON.stringify({ id: EXISTING, name: '出题 Pal', icon: '📝', description: '出题', createdAt: 1, updatedAt: 1 }), 'utf8')
writeFileSync(join(DATA, 'agents', EXISTING, 'agent.md'), '# 出题 Pal\n', 'utf8')

const store = await import('../../src/main/team-store')
const workspaceStore = await import('../../src/main/agent-workspace-store')
const tools = await import('../../src/main/openpipal-product-tools')
const { composeMark, isAccessoryId, isMarkHue, isMarkShape } = await import('../../src/shared/agent-mark-catalog')
afterAll(() => rmSync(HOME, { recursive: true, force: true }))

const teamToolsFor = (opts: { teamId: string; workspaceId: string; source?: 'desktop' | 'scheduler' | 'acp' }) =>
  tools.buildOpenPipalProductTools(opts.source ?? 'desktop', async () => null, { systemPrompt: '', workspaceId: opts.workspaceId, teamId: opts.teamId, conversationId: 'conv-1' } as never)
const manageTeamFor = (opts: { teamId: string; workspaceId: string; source?: 'desktop' | 'scheduler' | 'acp' }) =>
  teamToolsFor(opts).find(t => t.name === 'manage_team')
const readMark = (palId: string): Record<string, string> => JSON.parse(readFileSync(join(DATA, 'agents', palId, 'mark.json'), 'utf8'))
const run = async (tool: any, params: Record<string, unknown>): Promise<string> => {
  const result = await tool.execute('call', params)
  return (result as { content: Array<{ text: string }> }).content[0].text
}

describe('组建团队', () => {
  it('foundTeam：默认组长是一个普通 Pal，团队叫「新团队」、名单只有组长、章程为空', () => {
    const team = store.foundTeam()
    expect(team.name).toBe('新团队')
    expect(team.members).toEqual([team.lead])
    expect(team.charter).toBe('')
    const lead = workspaceStore.readWorkspaceMeta(team.lead)!
    expect(lead.name).toBe('新团队组长')
    expect(readFileSync(join(DATA, 'agents', team.lead, 'agent.md'), 'utf8')).toContain('用 manage_team 起名字、写章程、建成员')
    const scope = store.resolveTeamScope(team.id)!
    expect(store.isTeamForming(scope)).toBe(true)
    expect(store.buildTeamPromptLayer(scope, team.lead, 'lead')).toContain('团队刚成立')
    // 组长一出生就有捏好的头像（不是 emoji）：管事的戴公文包，颜色 / 轮廓按 id 定
    const mark = readMark(team.lead)
    expect(mark.accessory).toBe('briefcase')
    expect(isMarkHue(mark.hue) && mark.hue !== 'ink').toBe(true)
    expect(isMarkShape(mark.shape) && mark.shape !== 'hexagon').toBe(true)
  })

  it('manage_team 只给在 App 里跟主人聊的 Lead', () => {
    const team = store.foundTeam()
    expect(manageTeamFor({ teamId: team.id, workspaceId: team.lead })).toBeDefined()
    expect(manageTeamFor({ teamId: team.id, workspaceId: team.lead, source: 'scheduler' })).toBeUndefined()
    expect(manageTeamFor({ teamId: team.id, workspaceId: EXISTING })).toBeUndefined()
    const plain = tools.buildOpenPipalProductTools('desktop', async () => null, { systemPrompt: '', workspaceId: team.lead, conversationId: 'conv-1' } as never)
    expect(plain.find(t => t.name === 'manage_team')).toBeUndefined()
  })

  it('组长边聊边落：改名（组长跟着改名）、写章程、建成员、加现成 Pal、换 Lead、移出', async () => {
    const team = store.foundTeam()
    const tool = manageTeamFor({ teamId: team.id, workspaceId: team.lead })!
    expect(await run(tool, { action: 'rename', name: '物理教研组' })).toContain('物理教研组')
    expect(store.readTeam(team.id)!.name).toBe('物理教研组')
    expect(workspaceStore.readWorkspaceMeta(team.lead)!.name).toBe('物理教研组组长')

    await run(tool, { action: 'set_charter', charter: '教案按新课标写。\n练习题先出后审。' })
    expect(store.readTeam(team.id)!.charter).toBe('教案按新课标写。\n练习题先出后审。')
    expect(store.readTeam(team.id)!.handoffBudget).toBe(store.DEFAULT_HANDOFF_BUDGET)

    const created = await run(tool, { action: 'create_member', name: '批改 Pal', description: '批作业', persona: '你专门批初中物理作业，给分要有依据。', look: 'magnifier' })
    const memberId = created.match(/pal_id: ([\w-]+)/)?.[1]
    expect(memberId).toBeTruthy()
    expect(existsSync(join(DATA, 'agents', memberId!, 'agent.md'))).toBe(true)
    expect(readFileSync(join(DATA, 'agents', memberId!, 'agent.md'), 'utf8')).toContain('# 批改 Pal')
    expect(store.readTeam(team.id)!.members).toEqual([team.lead, memberId])
    // 建出来的成员头像：配饰按组长挑的，颜色 / 轮廓按 id 组合；回执里写明了
    expect(readMark(memberId!)).toMatchObject({ accessory: 'magnifier' })
    expect(created).toContain('头像：magnifier')

    expect(await run(tool, { action: 'add_member', pal_id: EXISTING })).toContain('已加入')
    expect(store.readTeam(team.id)!.members).toEqual([team.lead, memberId, EXISTING])
    expect(await run(tool, { action: 'add_member', pal_id: 'not-a-pal' })).toContain('不是一个 Pal')

    expect(await run(tool, { action: 'remove_member', pal_id: team.lead })).toContain('先换 Lead')
    expect(await run(tool, { action: 'set_lead', pal_id: EXISTING })).toContain('Lead 已换成')
    expect(store.readTeam(team.id)!.lead).toBe(EXISTING)
    expect(await run(tool, { action: 'remove_member', pal_id: memberId })).toContain('已移出')
    expect(store.readTeam(team.id)!.members).toEqual([team.lead, EXISTING])

    const shown = await run(tool, { action: 'show' })
    expect(shown).toContain('团队「物理教研组」')
    expect(shown).toContain('出题 Pal（Lead）')
    expect(store.isTeamForming(store.resolveTeamScope(team.id)!)).toBe(false)
  })

  it('组长挑的配饰认不出（或没挑）就按 id 散列挑一个，不会掉回 emoji', async () => {
    const team = store.foundTeam()
    const tool = manageTeamFor({ teamId: team.id, workspaceId: team.lead })!
    const created = await run(tool, { action: 'create_member', name: '出题 Pal', persona: '出题。', look: 'unicorn' })
    const memberId = created.match(/pal_id: ([\w-]+)/)?.[1]!
    const mark = readMark(memberId)
    expect(isAccessoryId(mark.accessory) && mark.accessory !== 'none' && mark.accessory !== 'badge').toBe(true)
    // 写进 mark.json 的就是按 id 现算的那一份：同一个 id 每次组合一样
    const again = await run(tool, { action: 'create_member', name: '出题 Pal 2', persona: '出题。' })
    const id2 = again.match(/pal_id: ([\w-]+)/)?.[1]!
    expect(readMark(id2)).toEqual(composeMark(id2))
  })

  it('团队话题里 subagent 只做交接：没有 profile 参数、pal 必填；不填 pal 就被拒并指向 create_member', async () => {
    const team = store.foundTeam()
    const subagent = teamToolsFor({ teamId: team.id, workspaceId: team.lead }).find(t => t.name === 'subagent')!
    expect(subagent).toBeDefined()
    const schema = subagent.parameters as unknown as { properties: Record<string, unknown>; required?: string[] }
    expect(schema.properties.profile).toBeUndefined()
    expect(schema.required).toContain('pal')
    expect(subagent.description).toContain('没有通用子 agent')
    const result = await subagent.execute('call', { task: '去调研一下' }, undefined as never, undefined as never) as { isError?: boolean; content: Array<{ text: string }> }
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('create_member')
  })

  it('updateTeamMd 保留没动的声明（handoff-budget）', () => {
    const team = store.foundTeam()
    writeFileSync(join(team.dir, 'team.md'), ['---', 'name: 保留', `lead: ${team.lead}`, `members: ${team.lead}`, 'tier: auto', 'handoff-budget: off', '---', ''].join('\n'), 'utf8')
    store.updateTeamMd(team.id, { charter: '章程' })
    const after = store.readTeam(team.id)!
    expect(after.handoffBudget).toBe('off')
    expect(after.charter).toBe('章程')
    expect(after.name).toBe('保留')
  })
})

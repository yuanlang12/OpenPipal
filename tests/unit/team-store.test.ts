/**
 * 团队目录（设计稿 docs/claude/team-collaboration-design.md §3 / §2.1）：
 *   - team.md frontmatter 是声明，正文是章程；名单只认 Pal；lead 缺省名单第一个；tier 缺省 auto
 *   - 频道只收窄：名单取子集、tier 求交、章程与记忆索引按"团队 → 频道"拼接、工作目录优先频道的 shared/
 *   - 工具边界求交：禁用取并、MCP 白名单取交（交集为空 = 一个都不许）、工作目录用边界的
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'

const HOME = mkdtempSync(join(tmpdir(), 'openpipal-team-store-'))
process.env.OPENPIPAL_ISOLATED_HOME = HOME
const DATA = join(HOME, '.openpipal')
vi.mock('electron', () => ({ app: { isPackaged: false, getAppPath: () => process.cwd(), getPath: () => HOME } }))

const pal = (id: string, name: string, description = ''): void => {
  const dir = join(DATA, 'agents', id)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'meta.json'), JSON.stringify({ id, name, icon: '🤖', description, createdAt: 1, updatedAt: 1 }), 'utf8')
  writeFileSync(join(dir, 'agent.md'), `# ${name}\n`, 'utf8')
}
const A = 'pal-a-000000-4000-8000-000000000001'
const B = 'pal-b-000000-4000-8000-000000000002'
const NOT_PAL = 'pal-x-000000-4000-8000-000000000009'
pal(A, '备课 Pal', '写教案')
pal(B, '出题 Pal', '出练习题')

const store = await import('../../src/main/team-store')
afterAll(() => rmSync(HOME, { recursive: true, force: true }))

describe('团队目录', () => {
  it('创建：team.md 声明 + 章程；memory/ shared/ rules/ 就位；lead 缺省名单第一个', () => {
    const team = store.createTeam({ name: '教研组', members: [A, B], charter: '教案按新课标写。' })
    expect(store.isTeamId(team.id)).toBe(true)
    expect(team).toMatchObject({ name: '教研组', lead: A, members: [A, B], tier: 'auto', charter: '教案按新课标写。', handoffBudget: store.DEFAULT_HANDOFF_BUDGET })
    for (const sub of ['memory', 'shared', 'rules']) expect(existsSync(join(team.dir, sub))).toBe(true)
    expect(readFileSync(join(team.dir, 'team.md'), 'utf8')).toContain(`members: ${A}, ${B}`)
    expect(store.listTeams().map(t => t.id)).toContain(team.id)
  })

  it('创建校验：不是 Pal 的成员、不在名单里的 Lead 都拒', () => {
    expect(() => store.createTeam({ name: 'x', members: [A, NOT_PAL] })).toThrow(/不是一个 Pal/)
    expect(() => store.createTeam({ name: 'x', members: [A], lead: B })).toThrow(/Lead 必须在成员名单里/)
    expect(() => store.createTeam({ name: ' ', members: [A] })).toThrow(/名字/)
  })

  it('读：名单里不是 Pal 的忽略、lead 不在名单里回落第一个、tier 认不出当 auto、handoff-budget: off', () => {
    const id = 'team-manual-0000'
    const dir = join(DATA, 'teams', id)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'team.md'), ['---', 'name: 手写', `lead: ${NOT_PAL}`, `members: ${B}, ${NOT_PAL}, ${A}`, 'tier: whatever', 'handoff-budget: off', '---', '', '章程正文', ''].join('\n'), 'utf8')
    const team = store.readTeam(id)!
    expect(team.members).toEqual([B, A])
    expect(team.lead).toBe(B)
    expect(team.tier).toBe('auto')
    expect(team.handoffBudget).toBe('off')
    expect(team.charter).toBe('章程正文')
    expect(store.readTeam('nope')).toBeNull()
    expect(store.isTeamId('../etc')).toBe(false)
  })

  it('话题生效层：成员带名字和一句描述；工作目录 = shared/；记忆索引只在有 MEMORY.md 时出现', () => {
    const team = store.createTeam({ name: '带记忆', members: [A, B], lead: B })
    const scope = store.resolveTeamScope(team.id)!
    expect(scope.lead).toBe(B)
    expect(scope.members).toEqual([{ id: A, name: '备课 Pal', description: '写教案' }, { id: B, name: '出题 Pal', description: '出练习题' }])
    expect(scope.workingDir).toBe(join(team.dir, 'shared'))
    expect(scope.memoryIndexes).toEqual([])
    store.writeTeamMemory(scope, '家长沟通不提分数', '---\ndescription: 家长群里不说具体分数\ntype: convention\n---\n\n年级组定的。\n')
    const again = store.resolveTeamScope(team.id)!
    expect(again.memoryIndexes).toHaveLength(1)
    expect(again.memoryIndexes[0].index).toContain('[家长沟通不提分数](家长沟通不提分数.md) (convention) -- 家长群里不说具体分数')
    // 索引读的时候现算：Pal 用 write 直接放进去的文件（没人更新 MEMORY.md）下一轮就在索引里
    writeFileSync(join(team.dir, 'memory', '直接写的.md'), '---\ndescription: 用 write 放进来的\ntype: gotcha\n---\n\n正文\n', 'utf8')
    expect(store.resolveTeamScope(team.id)!.memoryIndexes[0].index).toContain('[直接写的](直接写的.md) (gotcha) -- 用 write 放进来的')
    expect(readFileSync(join(team.dir, 'memory', 'MEMORY.md'), 'utf8')).not.toContain('直接写的')
  })

  it('频道只收窄：名单子集、tier 求交、章程按团队→频道拼接、频道有 shared/ 就用频道的', () => {
    const team = store.createTeam({ name: '教研组2', members: [A, B], lead: B, charter: '团队章程。' })
    const cdir = join(team.dir, 'channels', '批改')
    mkdirSync(join(cdir, 'memory'), { recursive: true })
    writeFileSync(join(cdir, 'team.md'), ['---', `members: ${A}, ${NOT_PAL}`, 'tier: readonly', '---', '', '批改频道章程。', ''].join('\n'), 'utf8')
    writeFileSync(join(cdir, 'memory', 'x.md'), '---\ndescription: 频道记忆\n---\n\n正文\n', 'utf8')
    expect(store.listChannels(team.id)).toEqual(['批改'])
    const scope = store.resolveTeamScope(team.id, '批改')!
    expect(scope.members.map(m => m.id)).toEqual([A])
    expect(scope.lead).toBe(A) // 团队的 lead（B）不在频道名单里 → 频道名单第一个
    expect(scope.tier).toBe('readonly')
    expect(scope.charters.map(c => c.body)).toEqual(['团队章程。', '批改频道章程。'])
    expect(scope.memoryIndexes.map(m => m.index)).toEqual(['- [x](x.md) -- 频道记忆'])
    expect(scope.memoryWriteDir).toBe(join(cdir, 'memory'))
    expect(scope.workingDir).toBe(join(team.dir, 'shared'))
    mkdirSync(join(cdir, 'shared'))
    expect(store.resolveTeamScope(team.id, '批改')!.workingDir).toBe(join(cdir, 'shared'))
    expect(store.resolveTeamScope(team.id, '不存在')).toBeNull()
    expect(store.resolveTeamScope(team.id, '../批改')).toBeNull()
  })

  it('目录一动就通知：建团队 / 改 team.md / 写记忆 / 删团队都喊一声 teamId（左栏与面板据此当场刷新）；同一段里连写合成一次', async () => {
    const tick = () => Promise.resolve()
    const heard: string[] = []
    const off = store.onTeamChanged(id => heard.push(id))
    const team = store.createTeam({ name: '通知组', members: [A] })
    await tick()
    store.updateTeamMd(team.id, { charter: '章程' })
    await tick()
    // 整理引擎一次落几条记忆：只喊一声（订阅方每次都是整份重拉）
    store.writeTeamMemory(store.resolveTeamScope(team.id)!, '一条', '---\ndescription: x\n---\n\n正文\n')
    store.writeTeamMemory(store.resolveTeamScope(team.id)!, '两条', '---\ndescription: y\n---\n\n正文\n')
    await tick()
    store.deleteTeam(team.id)
    await tick()
    expect(heard).toEqual([team.id, team.id, team.id, team.id])
    off()
    store.createTeam({ name: '不再听', members: [A] })
    await tick()
    expect(heard).toHaveLength(4)
  })

  it('频道不能放宽 tier', () => {
    const team = store.createTeam({ name: '只读组', members: [A], tier: 'readonly' })
    const cdir = join(team.dir, 'channels', '宽')
    mkdirSync(cdir, { recursive: true })
    writeFileSync(join(cdir, 'team.md'), '---\ntier: full\n---\n', 'utf8')
    expect(store.resolveTeamScope(team.id, '宽')!.tier).toBe('readonly')
  })
})

describe('求交', () => {
  it('tier 取更窄的；认不出的当 auto', () => {
    expect(store.intersectTier('full', 'auto')).toBe('auto')
    expect(store.intersectTier('auto', 'readonly')).toBe('readonly')
    expect(store.intersectTier(undefined, 'full')).toBe('auto')
    expect(store.intersectTier('full', undefined)).toBe('auto')
  })

  it('工具边界：禁用取并、MCP 白名单取交、交集为空一个都不许、工作目录用边界的', () => {
    expect(store.intersectToolsConfig({ disabledTools: ['a'], mcpServers: ['x', 'y'], workingDir: '/me' }, { disabledTools: ['b'], mcpServers: ['y', 'z'], workingDir: '/team' }))
      .toEqual({ workingDir: '/team', mcpServers: ['y'], disabledTools: ['a', 'b'] })
    expect(store.intersectToolsConfig({ mcpServers: ['x'] }, { mcpServers: ['z'] }).mcpServers).toEqual([store.NO_MCP_SERVERS_SENTINEL])
    expect(store.intersectToolsConfig({ mcpServers: ['x'] }, undefined)).toEqual({ mcpServers: ['x'] })
    expect(store.intersectToolsConfig(undefined, { mcpServers: ['z'] })).toEqual({ mcpServers: ['z'] })
    expect(store.intersectToolsConfig({ workingDir: '/me' }, {})).toEqual({ workingDir: '/me' })
    expect(store.intersectToolsConfig(undefined, undefined)).toEqual({})
  })
})

describe('团队层提示词', () => {
  it('Lead 版讲怎么交接、成员版讲怎么回报；名单里标出 Lead 与"就是你"；章程与索引都在', () => {
    const team = store.createTeam({ name: '提示组', members: [A, B], lead: A, charter: '章程一行。' })
    const scope = store.resolveTeamScope(team.id)!
    const lead = store.buildTeamPromptLayer(scope, A, 'lead')
    expect(lead).toContain('## 你所在的团队：提示组')
    expect(lead).toContain('把 `pal` 填成成员的 id')
    expect(lead).toContain(`- 备课 Pal（Lead，就是你） id: ${A} — 写教案`)
    expect(lead).toContain(`- 出题 Pal id: ${B} — 出练习题`)
    expect(lead).toContain('### 章程：提示组\n章程一行。')
    const member = store.buildTeamPromptLayer(scope, B, 'member')
    expect(member).toContain('你不能再交接给别人')
    expect(member).toContain(`- 备课 Pal（Lead） id: ${A}`)
    expect(member).toContain(`- 出题 Pal（就是你） id: ${B}`)
    expect(member).not.toContain('把 `pal` 填成')
  })
})

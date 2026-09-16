/**
 * 团队话题跑完后的记忆整理（所有者 2026-09-14：胶囊说"记忆整理完成"，团队记忆却没动）：
 *   - 团队话题：同一台整理引擎，记忆落 teams/<id>/memory/（频道有 memory/ 就落频道），提示词换团队版
 *   - 只记团队的事、类型用团队的（decision / convention / gotcha / reference）；团队这一路没有改人设这回事
 *   - 回执带文件名（胶囊要说清记了什么）；写完团队目录会喊一声（面板当场刷新）
 *   - 不是团队话题：老路子不变，记忆落 agents/<id>/memory/
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

const HOME = mkdtempSync(join(tmpdir(), 'openpipal-team-dreaming-'))
process.env.OPENPIPAL_ISOLATED_HOME = HOME
const DATA = join(HOME, '.openpipal')
vi.mock('electron', () => ({ app: { isPackaged: false, getAppPath: () => process.cwd(), getPath: () => HOME } }))

const provider = vi.hoisted(() => ({ complete: vi.fn() }))
vi.mock('@earendil-works/pi-ai/compat', () => ({ completeSimple: provider.complete }))
vi.mock('../../src/main/config-manager', () => ({
  getPiModel: () => ({ provider: 'faux', id: 'dream-test' }),
  ensurePiApiKey: () => undefined,
  ensurePiApiKeyFor: () => undefined,
  buildModelFromConfig: () => ({ provider: 'faux', id: 'dream-test' }),
  createModelPayloadAdapter: () => undefined,
  getEffectiveModelConfig: () => ({ provider: 'faux', baseUrl: '', apiKey: '', model: 'dream-test' }),
  auxCompletionTuning: (_mc: unknown, _model: unknown, maxTokens: number) => ({ maxTokens, reasoning: undefined }),
}))

const store = await import('../../src/main/team-store')
const { executeAgentDreaming } = await import('../../src/main/agent-dreamer')
afterAll(() => rmSync(HOME, { recursive: true, force: true }))

const pal = (id: string, name: string): void => {
  const dir = join(DATA, 'agents', id)
  mkdirSync(join(dir, 'memory'), { recursive: true })
  writeFileSync(join(dir, 'meta.json'), JSON.stringify({ id, name, icon: '🤖', description: '', createdAt: 1, updatedAt: 1 }), 'utf8')
  writeFileSync(join(dir, 'agent.md'), `# ${name}\n`, 'utf8')
}
const LEAD = 'pal-lead-0000-4000-8000-000000000001'
pal(LEAD, '组长')

const messages = [
  { role: 'user', content: '以后练习题都要带答案和解析', timestamp: 1 },
  { role: 'assistant', content: '好，记下了。', timestamp: 2 }
] as never

const reply = (json: unknown) => provider.complete.mockResolvedValue({ stopReason: 'stop', content: [{ type: 'text', text: JSON.stringify(json) }] })

describe('团队话题的记忆整理', () => {
  beforeEach(() => provider.complete.mockReset())

  it('记忆落团队 memory/、提示词是团队版、组长人设不动、回执带文件名、面板收到通知', async () => {
    const team = store.createTeam({ name: '物理教研组', members: [LEAD], charter: '练习题先出后审。' })
    const scope = store.resolveTeamScope(team.id)!
    reply({
      memories: [{ name: '练习题带解析', description: '练习题必须带答案和解析', content: '---\ndescription: 练习题必须带答案和解析\ntype: convention\nmodified: 2026-09-14\n---\n\n主人定的。\n', action: 'create' }],
      agentMdUpdate: '# 被篡改的组长'
    })
    await Promise.resolve() // 建团队那一声先落地；下面只听整理引擎的
    const heard: string[] = []
    const off = store.onTeamChanged(id => heard.push(id))
    let done: { memories: number; agentMdUpdated: boolean; names: string[] } | undefined
    await executeAgentDreaming({ team: scope }, messages, r => { done = r })
    off()

    expect(done).toEqual({ memories: 1, agentMdUpdated: false, names: ['练习题带解析'] })
    expect(readFileSync(join(team.dir, 'memory', '练习题带解析.md'), 'utf8')).toContain('type: convention')
    expect(store.resolveTeamScope(team.id)!.memoryIndexes[0].index).toContain('[练习题带解析](练习题带解析.md) (convention)')
    expect(readdirSync(join(DATA, 'agents', LEAD, 'memory'))).toEqual([])
    expect(readFileSync(join(DATA, 'agents', LEAD, 'agent.md'), 'utf8')).toBe('# 组长\n')
    expect(heard).toEqual([team.id])

    const [, ctx] = provider.complete.mock.calls[0] as [unknown, { systemPrompt: string }]
    expect(ctx.systemPrompt).toContain('团队「物理教研组」')
    expect(ctx.systemPrompt).toContain('练习题先出后审。')
    expect(ctx.systemPrompt).toContain('decision | convention | gotcha | reference')
    expect(ctx.systemPrompt).not.toContain('Agent 记忆更新引擎')
    expect(ctx.systemPrompt).not.toContain('agentMdUpdate')
  })

  it('频道有自己的 memory/ 就落频道；已有记忆进提示词让引擎判断 update 还是 create', async () => {
    const team = store.createTeam({ name: '带频道', members: [LEAD] })
    const cdir = join(team.dir, 'channels', '批改')
    mkdirSync(join(cdir, 'memory'), { recursive: true })
    writeFileSync(join(cdir, 'memory', '给分口径.md'), '---\ndescription: 给分要有依据\ntype: convention\n---\n\n扣分写理由。\n', 'utf8')
    const scope = store.resolveTeamScope(team.id, '批改')!
    reply({ memories: [{ name: '给分口径', content: '---\ndescription: 给分要有依据，扣分写理由\ntype: convention\n---\n\n扣分写理由，半对给一半。\n', action: 'update' }], agentMdUpdate: null })
    await executeAgentDreaming({ team: scope }, messages)
    const [, ctx] = provider.complete.mock.calls[0] as [unknown, { systemPrompt: string }]
    expect(ctx.systemPrompt).toContain('### 给分口径\n扣分写理由。')
    expect(readFileSync(join(cdir, 'memory', '给分口径.md'), 'utf8')).toContain('半对给一半')
    expect(existsSync(join(team.dir, 'memory', '给分口径.md'))).toBe(false)
  })

  it('不是团队话题：老路子，记忆落 Pal 自己的 memory/', async () => {
    reply({ memories: [{ name: 'owner_pref', content: '---\nname: owner_pref\ndescription: 偏好\ntype: project\n---\n\n简短。\n', action: 'create' }], agentMdUpdate: null })
    let done: { memories: number; names: string[] } | undefined
    await executeAgentDreaming({ workspaceId: LEAD }, messages, r => { done = r })
    expect(done?.names).toEqual(['owner_pref'])
    expect(existsSync(join(DATA, 'agents', LEAD, 'memory', 'owner_pref.md'))).toBe(true)
  })
})

/**
 * 团队规则（设计稿 §5 第③层"规则加硬拦"）：teams/<id>/rules/ 与 channels/<频道>/rules/ 里的 hook 文件
 *   - 团队话题装：团队的 + 频道的；容器段 team:<id> / team:<id>/<频道>，同名文件不撞
 *   - 规则页清单（allAgents）把所有团队与频道的都列出来，source.kind = 'team'
 *   - 单条开关：改名 .off，与插件 / Pal 的规则同一个开关函数
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'

const HOME = mkdtempSync(join(tmpdir(), 'openpipal-team-rules-'))
process.env.OPENPIPAL_ISOLATED_HOME = HOME
const DATA = join(HOME, '.openpipal')
vi.mock('electron', () => ({ app: { isPackaged: false, getAppPath: () => process.cwd(), getPath: () => HOME } }))

const LEAD = 'pal-lead-0000-4000-8000-000000000001'
mkdirSync(join(DATA, 'agents', LEAD), { recursive: true })
writeFileSync(join(DATA, 'agents', LEAD, 'meta.json'), JSON.stringify({ id: LEAD, name: '备课 Pal', icon: '📐', description: '', createdAt: 1, updatedAt: 1 }), 'utf8')

const RULE = (desc: string, tool: string) => `export const description = '${desc}'
export default function (hook) {
  hook.on('tool_call', (event) => { if (event.toolName === '${tool}') return { block: true, reason: '${desc}' } })
}
`

const store = await import('../../src/main/team-store')
const registry = await import('../../src/main/hooks/hook-registry')
const chain = await import('../../src/main/hooks/hook-chain')
afterAll(() => rmSync(HOME, { recursive: true, force: true }))

const team = store.createTeam({ name: '教研组', members: [LEAD] })
writeFileSync(join(team.dir, 'rules', 'no-bash.ts'), RULE('团队里不许跑 bash', 'bash'), 'utf8')
mkdirSync(join(team.dir, 'channels', '批改', 'rules'), { recursive: true })
writeFileSync(join(team.dir, 'channels', '批改', 'rules', 'no-bash.ts'), RULE('批改频道也不许跑 bash', 'bash'), 'utf8')
writeFileSync(join(team.dir, 'channels', '批改', 'rules', 'no-write.ts'), RULE('批改频道不许写文件', 'write'), 'utf8')

describe('团队规则', () => {
  it('团队话题装团队的规则；有频道再装频道的，同名文件靠容器段分开', async () => {
    const teamOnly = await registry.loadActiveHooks(undefined, { workspaceId: LEAD, teamId: team.id })
    expect(teamOnly.failures).toEqual([])
    expect(teamOnly.hooks.map(h => h.id)).toEqual([`team:${team.id}/no-bash`])
    expect(teamOnly.report[0].source).toEqual({ kind: 'team', id: team.id, name: '教研组' })

    const withChannel = await registry.loadActiveHooks(undefined, { workspaceId: LEAD, teamId: team.id, channel: '批改' })
    expect(withChannel.hooks.map(h => h.id).sort()).toEqual([
      `team:${team.id}/no-bash`,
      `team:${team.id}/批改/no-bash`,
      `team:${team.id}/批改/no-write`,
    ].sort())
    expect(withChannel.report.find(r => r.id === `team:${team.id}/批改/no-write`)?.source.name).toBe('教研组 › 批改')

    // 规则真的拦：bash 被团队规则拦下，read 不受影响
    const hookChain = { hooks: withChannel.hooks, ctx: { workingDir: '/tmp', source: 'desktop' as const, signal: new AbortController().signal } }
    const blocked = await chain.runToolCallHooks(hookChain, { type: 'tool_call', toolName: 'bash', toolCallId: 'x', input: { command: 'ls' } })
    expect(blocked?.block).toBe(true)
    expect(blocked?.reason).toContain('团队里不许跑 bash')
    expect(await chain.runToolCallHooks(hookChain, { type: 'tool_call', toolName: 'read', toolCallId: 'y', input: { path: '/tmp/a' } })).toBeUndefined()
  })

  it('不在团队话题里的会话装不到团队规则', async () => {
    const plain = await registry.loadActiveHooks(undefined, { workspaceId: LEAD })
    expect(plain.hooks.filter(h => h.id.startsWith('team:'))).toEqual([])
  })

  it('规则页清单列出所有团队与频道的规则；单条开关改名 .off 后本话题不再装它', async () => {
    const entries = await registry.listHookEntries()
    const teamEntries = entries.filter(e => e.source.kind === 'team')
    expect(teamEntries.map(e => e.id).sort()).toEqual([
      `team:${team.id}/no-bash`,
      `team:${team.id}/批改/no-bash`,
      `team:${team.id}/批改/no-write`,
    ].sort())

    const file = join(team.dir, 'channels', '批改', 'rules', 'no-write.ts')
    const off = registry.setHookFileEnabled(file, false)
    expect(off).toEqual({ ok: true, file: `${file}.off` })
    const after = await registry.loadActiveHooks(undefined, { workspaceId: LEAD, teamId: team.id, channel: '批改' })
    expect(after.hooks.map(h => h.id)).not.toContain(`team:${team.id}/批改/no-write`)
    const listed = (await registry.listHookEntries()).find(e => e.id === `team:${team.id}/批改/no-write`)
    expect(listed?.status).toBe('off')
    expect(registry.setHookFileEnabled(`${file}.off`, true).ok).toBe(true)
  })

  it('团队目录外的文件不是可开关的规则', () => {
    expect(registry.setHookFileEnabled(join(team.dir, 'team.md'), false).ok).toBe(false)
    expect(registry.setHookFileEnabled(join(team.dir, 'shared', 'x.ts'), false).ok).toBe(false)
  })
})

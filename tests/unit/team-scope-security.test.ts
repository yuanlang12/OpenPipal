/**
 * 团队租户边界（设计稿 §5）：本团队的 teams/<id>/ 可读；写只许 memory/ 与 shared/（含频道的）；
 * 别的团队、没在团队话题里的会话一律不可见；成员之间 agents/<别人>/ 仍不可读（Pal 的记忆是私事）。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { assessToolScopeWithRoots, setConversationTeamResolver } from '../../src/main/pi-security'

const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'openpipal-team-scope-'))
afterAll(() => fs.rmSync(fakeHome, { recursive: true, force: true }))
const root = path.join(fakeHome, '.openpipal')
const teams = path.join(root, 'teams')
const own = path.join(teams, 'team-own')
const other = path.join(teams, 'team-other')
for (const d of [path.join(own, 'memory'), path.join(own, 'shared'), path.join(own, 'rules'), path.join(own, 'channels', 'c1', 'memory'), path.join(own, 'channels', 'c1', 'shared'), path.join(other, 'shared'), path.join(root, 'agents', 'lead'), path.join(root, 'agents', 'member')]) {
  fs.mkdirSync(d, { recursive: true })
}
fs.writeFileSync(path.join(own, 'team.md'), '---\nname: own\n---\n', 'utf8')
const workingDir = path.join(own, 'shared')
const roots = {
  root,
  agents: path.join(root, 'agents'),
  conversations: path.join(root, 'conversations'),
  artifacts: path.join(root, 'conversations', 'artifacts'),
  outputs: path.join(root, 'outputs'),
  teams
}
const inTeam = { conversationId: 'conv-1', workspaceId: 'lead', teamId: 'team-own', workingDir }
const noTeam = { conversationId: 'conv-2', workspaceId: 'lead', workingDir }
const assess = (tool: string, args: Record<string, unknown>, scope = inTeam) => assessToolScopeWithRoots(tool, args, scope, roots)

// shell 命令里的路径是按"~/.openpipal/…"这个形状抓的（不是按 roots 抓），所以 bash 的用例用真实 home 的根来判
const home = os.homedir()
const homeRoot = path.join(home, '.openpipal')
const homeRoots = {
  root: homeRoot,
  agents: path.join(homeRoot, 'agents'),
  conversations: path.join(homeRoot, 'conversations'),
  artifacts: path.join(homeRoot, 'conversations', 'artifacts'),
  outputs: path.join(homeRoot, 'outputs'),
  teams: path.join(homeRoot, 'teams')
}
const ownHome = '~/.openpipal/teams/team-own'
const assessShell = (command: string, scope: Record<string, unknown> = { ...inTeam, workingDir: path.join(homeRoots.teams, 'team-own', 'shared') }) =>
  assessToolScopeWithRoots('bash', { command }, scope, homeRoots)

describe('团队目录的租户边界', () => {
  it('本团队目录可读：章程、记忆、共享文件夹、频道', () => {
    expect(assess('read', { path: path.join(own, 'team.md') })).toBeNull()
    expect(assess('read', { path: path.join(own, 'memory', 'x.md') })).toBeNull()
    expect(assess('ls', { path: path.join(own, 'shared') })).toBeNull()
    expect(assess('read', { path: path.join(own, 'channels', 'c1', 'team.md') })).toBeNull()
    expect(assessShell(`cat ${ownHome}/team.md`)).toBeNull()
  })

  it('别的团队一律不可见；不在团队话题里的会话看不到任何团队目录', () => {
    expect(assess('read', { path: path.join(other, 'shared', 'a.md') })?.reason).toContain('其他团队')
    expect(assessShell('ls ~/.openpipal/teams/team-other')?.level).toBe('risky')
    expect(assess('read', { path: path.join(own, 'team.md') }, noTeam)?.reason).toContain('只有团队话题里的成员')
    expect(assessShell(`find ~/.openpipal/teams -name '*.md'`, noTeam)?.level).toBe('risky')
  })

  it('写只许 memory/ 与 shared/（含频道的）；章程 / 规则 / 工具边界只有人能改', () => {
    expect(assess('write', { path: path.join(own, 'memory', 'new.md'), content: 'x' })).toBeNull()
    expect(assess('write', { path: path.join(own, 'shared', '教案.md'), content: 'x' })).toBeNull()
    expect(assess('edit', { path: path.join(own, 'channels', 'c1', 'memory', 'y.md') })).toBeNull()
    expect(assess('write', { path: path.join(own, 'channels', 'c1', 'shared', 'z.md') })).toBeNull()
    expect(assess('write', { path: path.join(own, 'team.md'), content: 'x' })?.reason).toContain('只有人在 App 里能改')
    expect(assess('edit', { path: path.join(own, 'rules', 'r.ts') })?.level).toBe('risky')
    expect(assess('write', { path: path.join(own, 'tools', 'config.json') })?.level).toBe('risky')
    expect(assess('write', { path: path.join(own, 'channels', 'c1', 'team.md') })?.level).toBe('risky')
  })

  it('shell 里带写意图的命令同样按写边界判；只读命令不受影响', () => {
    expect(assessShell(`echo hi > ${ownHome}/team.md`)?.reason).toContain('只有人在 App 里能改')
    expect(assessShell(`sed -i '' 's/a/b/' ${ownHome}/rules/r.ts`)?.level).toBe('risky')
    expect(assessShell(`rm ${ownHome}/tools/config.json`)?.level).toBe('risky')
    expect(assessShell(`echo hi > ${ownHome}/shared/out.md`)).toBeNull()
    expect(assessShell(`tee ${ownHome}/memory/m.md`)).toBeNull()
    expect(assessShell(`grep -r 新课标 ${ownHome}/memory`)).toBeNull()
  })

  it('同团队别的话题的产物目录可读；别的团队的、没登记的仍然拦', () => {
    const outputs = roots.outputs
    for (const cid of ['conv-1', 'conv-mate', 'conv-foreign']) fs.mkdirSync(path.join(outputs, cid), { recursive: true })
    setConversationTeamResolver(id => ({ 'conv-mate': 'team-own', 'conv-foreign': 'team-other' } as Record<string, string>)[id])
    try {
      expect(assess('ls', { path: path.join(outputs, 'conv-1') })).toBeNull()
      expect(assess('ls', { path: path.join(outputs, 'conv-mate') })).toBeNull()
      expect(assess('ls', { path: path.join(outputs, 'conv-foreign') })?.level).toBe('risky')
      expect(assess('ls', { path: path.join(outputs, 'conv-unknown') })?.level).toBe('risky')
      expect(assess('ls', { path: path.join(outputs, 'conv-mate') }, noTeam)?.level).toBe('risky')
    } finally {
      setConversationTeamResolver(null)
    }
    expect(assess('ls', { path: path.join(outputs, 'conv-mate') })?.level).toBe('risky')
  })

  it('团队不是安全边界：成员之间的 agents/<别人>/ 仍然不可读', () => {
    expect(assess('read', { path: path.join(root, 'agents', 'member', 'memory', 'private.md') })?.reason).toContain('其他 Agent')
    expect(assess('read', { path: path.join(root, 'agents', 'lead', 'memory', 'mine.md') })).toBeNull()
  })
})

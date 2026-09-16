/**
 * 审计行带上"谁在哪条会话里做的"（设计稿 §9 第 3 段）：团队话题里 Lead 与每个成员各自留名，
 * 事后翻 audit.log 能分出是哪个成员越了界。格式只在行尾追加，老字段一个不动。
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'

const HOME = mkdtempSync(join(tmpdir(), 'openpipal-team-audit-'))
process.env.OPENPIPAL_ISOLATED_HOME = HOME
const DATA = join(HOME, '.openpipal')
vi.mock('electron', () => ({ app: { isPackaged: false, getAppPath: () => process.cwd(), getPath: () => HOME } }))

const TEAM = 'team-audit-0001'
const shared = join(DATA, 'teams', TEAM, 'shared')
mkdirSync(shared, { recursive: true })
writeFileSync(join(DATA, 'teams', TEAM, 'team.md'), '---\nname: audit\n---\n', 'utf8')
writeFileSync(join(shared, '教案.md'), '# 教案\n', 'utf8')

const security = await import('../../src/main/pi-security')
afterAll(() => rmSync(HOME, { recursive: true, force: true }))

async function auditLines(): Promise<string[]> {
  // 审计写入是 fire-and-forget，让出几拍事件循环再读
  for (let i = 0; i < 20; i++) await new Promise(r => setTimeout(r, 10))
  try {
    return readFileSync(join(DATA, 'audit.log'), 'utf8').split('\n').filter(Boolean)
  } catch {
    return []
  }
}

describe('审计行的 actor 字段', () => {
  it('团队话题：CONV / AGENT / TEAM 追加在行尾（各取前 8 位）', async () => {
    const verdict = await security.authorizeToolCall('read', { path: join(shared, '教案.md') }, {
      conversationId: 'conv-abcdef0123',
      scope: { workspaceId: 'member-0123456', teamId: TEAM, workingDir: shared }
    }, new AbortController().signal)
    expect(verdict).toBeUndefined()
    const lines = await auditLines()
    const line = lines.find(l => l.includes('TOOL=read') && l.includes('TEAM='))
    expect(line, `没有带 TEAM 的 read 审计行：${lines.join(' | ')}`).toBeDefined()
    expect(line).toContain('RESULT=safe')
    expect(line).toMatch(/ CONV=conv-abc AGENT=member-0 TEAM=team-aud$/)
  })

  it('越界被拦的那条也留名：别的团队的目录', async () => {
    const other = join(DATA, 'teams', 'team-other-0002', 'shared', 'x.md')
    const verdict = await security.authorizeToolCall('read', { path: other }, {
      conversationId: 'conv-second-000',
      scope: { workspaceId: 'member-0123456', teamId: TEAM, workingDir: shared }
    }, new AbortController().signal)
    expect(verdict?.block).toBe(true)
    const line = (await auditLines()).find(l => l.includes('CONV=conv-sec'))
    expect(line).toContain('RESULT=risky')
    expect(line).toContain('TEAM=team-aud')
  })

  it('普通会话没有团队字段，老格式不变', async () => {
    await security.authorizeToolCall('read', { path: join(shared, '教案.md') }, {
      conversationId: 'conv-plain-0000',
      scope: { workspaceId: 'solo-000000', workingDir: shared }
    }, new AbortController().signal)
    const line = (await auditLines()).find(l => l.includes('CONV=conv-pla'))
    expect(line).toMatch(/ CONV=conv-pla AGENT=solo-000$/)
    expect(line).not.toContain('TEAM=')
  })
})

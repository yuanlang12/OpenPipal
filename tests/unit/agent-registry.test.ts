/**
 * Agent 注册表（统一身份第 1 段）：内置角色、Pal、模板三种来源解析成同一份档案。
 * 钉：内置档案带角色表里的提示词 / 工具 / 声明表；Pal 档案从目录来、frontmatter 能声明 artifacts / skills；
 * 模板映射成没有目录的档案；listAgents 内置在前；认不出的 id 是 undefined；老记录派生顺序 workspaceId > agentId > role。
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'

const HOME = mkdtempSync(join(tmpdir(), 'openpipal-agent-registry-'))
process.env.OPENPIPAL_ISOLATED_HOME = HOME
const DATA = join(HOME, '.openpipal')

vi.mock('electron', () => ({
  app: { isPackaged: false, getAppPath: () => process.cwd(), getPath: () => HOME }
}))

// 一个 Pal：agent.md 用 frontmatter 声明"整页 HTML 走 DC"并点名引入两个全局技能
const PAL = 'a1b2c3d4-0000-4000-8000-000000000001'
const palDir = join(DATA, 'agents', PAL)
mkdirSync(join(palDir, 'hooks'), { recursive: true })
mkdirSync(join(palDir, 'tools'), { recursive: true })
writeFileSync(join(palDir, 'meta.json'), JSON.stringify({ id: PAL, name: '海报小助手', icon: '🎨', description: '做海报', createdAt: 1, updatedAt: 1 }), 'utf8')
writeFileSync(join(palDir, 'agent.md'), ['---', 'artifacts: dc', 'skills: dc-authoring, deck-stage', 'memory: off', '---', '', '# 海报小助手', '你专做海报。', ''].join('\n'), 'utf8')
writeFileSync(join(palDir, 'tools', 'config.json'), JSON.stringify({ workingDir: '/tmp/poster-work' }), 'utf8')
writeFileSync(join(palDir, 'mark.json'), JSON.stringify({ accessory: 'palette', hue: 'amber', shape: 'cloud' }), 'utf8')
// 一个没 frontmatter 的 Pal
const PLAIN = 'a1b2c3d4-0000-4000-8000-000000000002'
mkdirSync(join(DATA, 'agents', PLAIN), { recursive: true })
writeFileSync(join(DATA, 'agents', PLAIN, 'meta.json'), JSON.stringify({ id: PLAIN, name: '素人', icon: '🤖', description: '', createdAt: 1, updatedAt: 1 }), 'utf8')
writeFileSync(join(DATA, 'agents', PLAIN, 'agent.md'), '# 素人\n', 'utf8')
// 一个模板
const TEMPLATE = 'b1b2c3d4-0000-4000-8000-000000000003'
mkdirSync(join(DATA, 'agent-templates'), { recursive: true })
writeFileSync(join(DATA, 'agent-templates', `${TEMPLATE}.json`), JSON.stringify({ id: TEMPLATE, name: '周报模板', description: '', icon: '📝', systemPrompt: '写周报', workingDir: '/tmp/weekly', tools: ['read', 'write'], createdAt: 1, updatedAt: 1 }), 'utf8')

const registry = await import('../../src/main/agent-registry')
const { COMMON_TOOLS } = await import('../../src/main/role-manager')

afterAll(() => rmSync(HOME, { recursive: true, force: true }))

describe('getAgent', () => {
  it('内置角色：提示词 / 工具来自角色表，声明来自内置声明表，目录指向用户副本', () => {
    const general = registry.getAgent('general')!
    expect(general.kind).toBe('builtin')
    expect(general.kind).toBe('builtin')
    expect(general.tools).toEqual(COMMON_TOOLS)
    expect(general.systemPrompt.length).toBeGreaterThan(50)
    expect(general.dir).toBe(join(DATA, 'system-agents', 'general'))
    expect(general.policies).toEqual({ memory: true, skills: [] })
    expect(general.hooksDir).toBeUndefined()

    const design = registry.getAgent('design')!
    expect(design.policies.artifacts).toBe('dc')
    expect(design.policies.artifactJsxGuards).toBe(true)
    expect(design.policies.memory).toBe(false)
    expect(registry.getAgent('coding')!.policies.permissionTier).toBe('allowed')
    expect(registry.getAgent('teacher')!.policies).toMatchObject({ artifacts: 'dc', archives: 'role-system' })
    expect(registry.getAgent('coding')!.skillDirs[0]).toMatch(/system-agents\/coding\/skills$/)
  })

  it('Pal：目录、人设正文、frontmatter 声明、工具配置、头像都从它自己的目录来', () => {
    const pal = registry.getAgent(PAL)!
    expect(pal.kind).toBe('pal')
    expect(pal.kind).toBe('pal')
    expect(pal.name).toBe('海报小助手')
    expect(pal.dir).toBe(palDir)
    expect(pal.systemPrompt).toBe('# 海报小助手\n你专做海报。\n')
    expect(pal.policies).toEqual({ memory: false, artifacts: 'dc', skills: ['dc-authoring', 'deck-stage'] })
    expect(pal.workingDir).toBe('/tmp/poster-work')
    expect(pal.hooksDir).toBe(join(palDir, 'hooks'))
    expect(pal.skillDirs).toEqual([join(palDir, 'skills')])
    expect(pal.mark).toEqual({ accessory: 'palette', hue: 'amber', shape: 'cloud' })
    // 跨会话工具要在 tools/config.json 点名 enabledTools 才有（conversation-peer.test 验开关）
    expect(pal.tools).toEqual(COMMON_TOOLS.filter(t => t !== 'conversations'))

    const plain = registry.getAgent(PLAIN)!
    expect(plain.policies).toEqual({ memory: true, skills: [] })
    expect(plain.systemPrompt).toBe('# 素人\n')
  })

  it('模板不再是一种身份：迁移前认不出；migrateTemplatesIntoPals 后同 id 是 Pal（人设 / 工作目录带过来，原文件改名留底），再跑一次不重复建', async () => {
    expect(registry.getAgent(TEMPLATE)).toBeUndefined()
    const { migrateTemplatesIntoPals } = await import('../../src/main/agent-template-manager')
    migrateTemplatesIntoPals()
    const pal = registry.getAgent(TEMPLATE)!
    expect(pal.kind).toBe('pal')
    expect(pal.name).toBe('周报模板')
    expect(pal.systemPrompt.trim()).toBe('写周报')
    expect(pal.workingDir).toBe('/tmp/weekly')
    expect(pal.dir).toBe(join(DATA, 'agents', TEMPLATE))
    expect(existsSync(join(DATA, 'agent-templates', `${TEMPLATE}.json`))).toBe(false)
    expect(existsSync(join(DATA, 'agent-templates', `${TEMPLATE}.json.migrated`))).toBe(true)
    const before = readFileSync(join(DATA, 'agents', TEMPLATE, 'meta.json'), 'utf8')
    migrateTemplatesIntoPals()
    expect(readFileSync(join(DATA, 'agents', TEMPLATE, 'meta.json'), 'utf8')).toBe(before)
  })

  it('认不出的 id、路径形状的 id 都是 undefined', () => {
    expect(registry.getAgent('nope')).toBeUndefined()
    expect(registry.getAgent('../etc')).toBeUndefined()
    expect(registry.getAgent('')).toBeUndefined()
    expect(registry.getAgent(undefined)).toBeUndefined()
  })
})

describe('listAgents / resolveAgentId', () => {
  it('内置在前、然后 Pal；每个 id 一条', () => {
    const list = registry.listAgents()
    const ids = list.map((a) => a.id)
    expect(ids[0]).toBe('general')
    expect(list.filter((a) => a.kind === 'builtin').length).toBeGreaterThanOrEqual(5)
    expect(ids.indexOf(PAL)).toBeGreaterThan(ids.lastIndexOf('general'))
    expect(ids).toContain(TEMPLATE)   // 上一组用例已把模板并入 Pal
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('老记录派生：workspaceId > agentId > role > general', () => {
    expect(registry.resolveAgentId({ workspaceId: PAL, agentId: TEMPLATE, role: 'design' })).toBe(PAL)
    expect(registry.resolveAgentId({ agentId: TEMPLATE, role: 'design' })).toBe(TEMPLATE)
    expect(registry.resolveAgentId({ role: 'design' })).toBe('design')
    expect(registry.resolveAgentId({})).toBe('general')
  })

  it('frontmatter 解析：认不出的值当没写，skills 去重', () => {
    expect(registry.policiesFromFrontmatter({ artifacts: 'weird', 'permission-tier': 'god', skills: 'a, b, a' })).toEqual({ memory: true, skills: ['a', 'b'] })
    expect(registry.policiesFromFrontmatter({ memory: 'off' }, { artifacts: 'dc', skills: ['x'] })).toEqual({ memory: false, artifacts: 'dc', skills: ['x'] })
  })
})

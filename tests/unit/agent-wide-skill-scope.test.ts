/**
 * 独立智能体（我的 Pal）看得见哪些技能：自己目录里的 + 全局里声明了 `metadata.agent-scope: all` 的。
 *
 * 代码评审抓到的洞：这条规则原先只写在 skill-manager（legacy 运行时 + 菜单）里，默认的 pi-core 运行时
 * 走 loadPiCoreSkillCatalog 自己算作用域，独立 Pal 只装自己的目录——hook-creator 在菜单里有、模型看不到。
 * 这里钉：两条运行时对独立 Pal 给出同一份技能名单；判据只认 metadata 块下的 agent-scope。
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'

const HOME = mkdtempSync(join(tmpdir(), 'openpipal-agent-wide-skill-'))
process.env.OPENPIPAL_ISOLATED_HOME = HOME
const DATA = join(HOME, '.openpipal')

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getAppPath: () => process.cwd(),
    getPath: () => HOME
  }
}))
vi.mock('../../src/main/mcp-manager', () => ({ listMcpSkillDirs: () => [] }))

const skill = (dir: string, name: string, metadata: string[] = []): string => {
  const file = join(dir, name, 'SKILL.md')
  mkdirSync(join(dir, name), { recursive: true })
  const meta = metadata.length ? ['metadata:', ...metadata.map((line) => `  ${line}`)] : []
  writeFileSync(file, ['---', `name: ${name}`, `description: ${name} 技能`, ...meta, '---', '', `# ${name}`, ''].join('\n'), 'utf8')
  return file
}

const userSkills = join(DATA, 'skills')
const ownSkills = join(DATA, 'agents', 'ws-1', 'skills')
skill(ownSkills, 'own-thing')
skill(userSkills, 'wide', ['short-description: 人人可见', '# 注释行也在块里', 'agent-scope: all'])
skill(userSkills, 'narrow', ['short-description: 只给全局'])
skill(userSkills, 'wide-but-off', ['agent-scope: all'])
const topLevelScope = join(DATA, 'skills', 'top-level-scope', 'SKILL.md')
mkdirSync(join(DATA, 'skills', 'top-level-scope'), { recursive: true })
writeFileSync(topLevelScope, ['---', 'name: top-level-scope', 'description: 写错位置', 'agent-scope: all', 'metadata:', '  short-description: x', '---', '', '# x', ''].join('\n'), 'utf8')
writeFileSync(join(DATA, 'skills.config.json'), JSON.stringify({ disabled: ['wide-but-off', 'own-thing'] }), 'utf8')
// 第三方：插件带的、MCP 同步下来的技能声明 agent-scope: all 也不算——不许凭一句 frontmatter 进每个 Pal 的系统提示
const pluginDir = join(DATA, 'plugins', 'p1')
mkdirSync(pluginDir, { recursive: true })
writeFileSync(join(pluginDir, 'plugin.json'), JSON.stringify({ $schema: 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json', name: 'p1', description: 'x' }), 'utf8')
skill(join(pluginDir, 'skills'), 'plugin-wide', ['agent-scope: all'])
skill(join(DATA, 'skills', '_mcp', 'srv'), 'mcp-wide', ['agent-scope: all'])

const sources = await import('../../src/main/openpipal-skill-sources')
const manager = await import('../../src/main/skill-manager')
const core = await import('../../src/main/agent-runtime/pi-core-skills')
await manager.preloadSkillEngine()
manager.initSkills()   // 读 skills.config.json 的禁用名单（preload 只装引擎）

afterAll(() => rmSync(HOME, { recursive: true, force: true }))

describe('agent-scope: all 的判据', () => {
  it('只认 metadata 块下缩进的 agent-scope: all；顶层写的、没写的、文件不存在的都不算', () => {
    expect(sources.isAgentWideSkillFile(join(userSkills, 'wide', 'SKILL.md'))).toBe(true)
    expect(sources.isAgentWideSkillFile(join(userSkills, 'narrow', 'SKILL.md'))).toBe(false)
    expect(sources.isAgentWideSkillFile(topLevelScope)).toBe(false)
    expect(sources.isAgentWideSkillFile(join(userSkills, 'missing', 'SKILL.md'))).toBe(false)
    expect(sources.isAgentWideSkillFile('resources/skills/hook-creator/SKILL.md')).toBe(true)
    expect(sources.isAgentWideSkillFile(join(pluginDir, 'skills', 'plugin-wide', 'SKILL.md'))).toBe(false)
    expect(sources.isAgentWideSkillFile(join(DATA, 'skills', '_mcp', 'srv', 'mcp-wide', 'SKILL.md'))).toBe(false)
  })
})

describe('独立 Pal 的技能作用域', () => {
  it('pi-core 运行时：自己的 + 全局里 agent-scope: all 的（禁用的除外），hook-creator 在其中', async () => {
    const catalog = await core.loadPiCoreSkillCatalog({ workspaceId: 'ws-1' })
    const names = catalog.skills.map((s) => s.name)
    expect(names).toContain('own-thing')
    expect(names).toContain('wide')
    expect(names).toContain('hook-creator')
    expect(names).not.toContain('narrow')
    expect(names).not.toContain('wide-but-off')
    expect(names).not.toContain('top-level-scope')
    expect(names).not.toContain('plugin-wide')
    expect(names).not.toContain('mcp-wide')
    // 自己目录里的技能不受全局禁用名单管（own-thing 在名单里照样在）
    expect(names).toContain('own-thing')
    expect(catalog.promptSection).toContain('<name>hook-creator</name>')
  })

  it('菜单（skill-manager）列的和 pi-core 装的是同一份', async () => {
    const menu = manager.listSkillsMeta('ws-1').filter((s) => s.enabled).map((s) => s.name).sort()
    const catalog = (await core.loadPiCoreSkillCatalog({ workspaceId: 'ws-1' })).skills.map((s) => s.name).sort()
    expect(catalog).toEqual(menu)
  })

  it('全局会话不受影响：narrow 照常可见', async () => {
    const names = (await core.loadPiCoreSkillCatalog({ roleName: 'general' })).skills.map((s) => s.name)
    expect(names).toContain('narrow')
    expect(names).toContain('wide')
  })
})

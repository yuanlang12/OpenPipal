/**
 * 统一身份第 3 段：专属行为读档案里的声明，不再按角色名认。
 *   - 通用助手 / 没声明的 Pal：整页 HTML 直接过；design 内置声明 artifacts: dc → 拒；Pal 在 agent.md 里声明了 → 同样拒
 *   - 工具白名单从档案取（Pal = 公共工具）
 *   - 权限档位只对声明了 permission-tier: allowed 的 Agent 放宽
 *   - 技能作用域：Pal 点名（frontmatter skills:）的全局技能进它的索引，两条运行时一致
 *   - resolveExecutionAgent：overrides.agentId > workspaceId > 会话 agent > 角色名 > 通用助手
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'

const HOME = mkdtempSync(join(tmpdir(), 'openpipal-agent-policies-'))
process.env.OPENPIPAL_ISOLATED_HOME = HOME
const DATA = join(HOME, '.openpipal')

vi.mock('electron', () => ({ app: { isPackaged: false, getAppPath: () => process.cwd(), getPath: () => HOME } }))
vi.mock('../../src/main/mcp-manager', () => ({ listMcpSkillDirs: () => [], getMcpToolIndex: () => '', hasVisibleMcpServer: () => false }))
vi.mock('../../src/main/conversation-service', () => ({ peekConversation: (id: string) => convs.get(id) ?? null }))
const convs = new Map<string, { agent?: string; role: string; workspaceId?: string; config?: Record<string, unknown> }>()

const pal = (id: string, frontmatter: string[]): string => {
  const dir = join(DATA, 'agents', id)
  mkdirSync(join(dir, 'skills'), { recursive: true })
  writeFileSync(join(dir, 'meta.json'), JSON.stringify({ id, name: id, icon: '🤖', description: '', createdAt: 1, updatedAt: 1 }), 'utf8')
  writeFileSync(join(dir, 'agent.md'), [...(frontmatter.length ? ['---', ...frontmatter, '---', ''] : []), `# ${id}`, ''].join('\n'), 'utf8')
  return dir
}
const PLAIN = 'pal-plain-0000-4000-8000-000000000001'
const DC = 'pal-dc-000000-4000-8000-000000000002'
pal(PLAIN, [])
pal(DC, ['artifacts: dc', 'skills: dc-authoring'])

const overridesMod = await import('../../src/main/agent-overrides')
const tools = await import('../../src/main/openpipal-product-tools')
const skills = await import('../../src/main/agent-runtime/pi-core-skills')
const manager = await import('../../src/main/skill-manager')
await manager.preloadSkillEngine()
manager.initSkills()

afterAll(() => rmSync(HOME, { recursive: true, force: true }))

const FULL_PAGE = '<!DOCTYPE html><html><head><title>x</title></head><body><h1>hi</h1></body></html>'

async function createHtml(overrides: Record<string, unknown>): Promise<string> {
  const built = tools.buildOpenPipalProductTools('desktop', async () => null, { systemPrompt: '', ...overrides } as never)
  const create = built.find(t => t.name === 'create_artifact')!
  const result = await create.execute('call-1', { type: 'html', title: '页面', content: FULL_PAGE } as never)
  return (result as { content: Array<{ text: string }> }).content[0].text
}

describe('产物闸门按声明', () => {
  it('通用助手 / 没声明的 Pal 直接过；design 与声明了 artifacts: dc 的 Pal 被拒', async () => {
    expect(await createHtml({ roleName: 'general', agentId: 'general' })).not.toMatch(/已拒绝/)
    expect(await createHtml({ roleName: 'general', workspaceId: PLAIN, agentId: PLAIN })).not.toMatch(/已拒绝/)
    expect(await createHtml({ roleName: 'design', agentId: 'design' })).toMatch(/已拒绝：整页 HTML 交付物必须是 Design Component/)
    expect(await createHtml({ roleName: 'general', workspaceId: DC, agentId: DC })).toMatch(/已拒绝：整页 HTML 交付物必须是 Design Component/)
  })
})

describe('resolveExecutionAgent', () => {
  it('agentId > workspaceId > 会话记录 > 角色名 > 通用助手', () => {
    convs.set('c-pal', { role: 'general', workspaceId: DC, agent: DC })
    expect(overridesMod.resolveExecutionAgent({ agentId: 'coding', workspaceId: DC }).id).toBe('coding')
    expect(overridesMod.resolveExecutionAgent({ workspaceId: DC, roleName: 'design' }).id).toBe(DC)
    expect(overridesMod.resolveExecutionAgent({ conversationId: 'c-pal', roleName: 'design' }).id).toBe(DC)
    expect(overridesMod.resolveExecutionAgent({ roleName: 'design' }).id).toBe('design')
    expect(overridesMod.resolveExecutionAgent({ roleName: 'nope' }).kind).toBe('builtin')
    expect(overridesMod.resolveExecutionAgent(undefined).kind).toBe('builtin')
  })

  it('权限档位只对声明了 allowed 的 Agent 放宽；Pal 的 overrides 带统一身份', () => {
    convs.set('c-code', { role: 'coding' })
    convs.set('c-general', { role: 'general' })
    const coding = overridesMod.resolveAgentOverrides({ conversationId: 'c-code', conversationConfig: { permissionTier: 'allowed' } as never })
    expect(coding?.permissionTier).toBe('allowed')
    const general = overridesMod.resolveAgentOverrides({ conversationId: 'c-general', conversationConfig: { permissionTier: 'allowed' } as never })
    expect(general?.permissionTier).toBeUndefined()
    const forPal = overridesMod.resolveAgentOverrides({ conversationId: 'c-pal', workspaceId: DC })
    expect(forPal?.agentId).toBe(DC)
    expect(forPal?.systemPrompt).not.toContain('artifacts: dc')   // frontmatter 是声明，不进提示词
    expect(forPal?.systemPrompt).toContain(`# ${DC}`)
  })
})

describe('技能作用域按声明', () => {
  it('Pal 点名的全局技能进它的索引；没点名的 Pal 看不到；菜单与 pi-core 一致', async () => {
    const dc = (await skills.loadPiCoreSkillCatalog({ workspaceId: DC, agentId: DC })).skills.map(s => s.name)
    expect(dc).toContain('dc-authoring')
    expect(dc).toContain('hook-creator')
    const plain = (await skills.loadPiCoreSkillCatalog({ workspaceId: PLAIN, agentId: PLAIN })).skills.map(s => s.name)
    expect(plain).not.toContain('dc-authoring')
    const menu = manager.listSkillsMeta(DC).filter(s => s.enabled).map(s => s.name).sort()
    expect(menu).toEqual([...dc].sort())
  })
})

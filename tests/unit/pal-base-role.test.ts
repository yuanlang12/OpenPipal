/**
 * Pal 对话的 role 槽位一律是中性值（PAL_BASE_ROLE），不借 App 当时选中的全局角色。
 * 2026-09-09 实撞：所有者上次点过设计助手，再点「试一下」开物理教案 Pal，Pal 借来 design 的
 * "整页 HTML 必须是 DC"闸门，可它的技能索引里没有 dc-authoring → 猜路径、翻目录、要搜全盘。
 * 钉：四处开 Pal 对话的入口（我的 Pal 页、顶栏切换器、欢迎页模板、定时任务 / HTTP）都用 PAL_BASE_ROLE；
 * 中性角色真的中性（公共工具、没有产物闸门）；闸门文案给绝对路径，不再指望"技能索引里有"。
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { PAL_BASE_ROLE } from '../../src/shared/pal-contract'

const read = (file: string): string => readFileSync(file, 'utf8')

describe('Pal 的底层角色', () => {
  it('中性值是 general：只带公共工具，不在任何产物闸门的角色名单里', () => {
    expect(PAL_BASE_ROLE).toBe('general')
    const roles = read('src/main/role-manager.ts')
    expect(roles).toMatch(/name: 'general',[\s\S]*?tools: COMMON_TOOLS/)
    const tools = read('src/main/openpipal-product-tools.ts')
    for (const gate of tools.match(/\[[^\]]*\]\.includes\(roleName\)|roleName === '[a-z]+'/g) ?? []) {
      expect(gate, gate).not.toContain("'general'")
    }
  })

  it.each([
    ['src/renderer/src/components/AgentsPanel.tsx', /newConversationFrom(?:Agent|Workspace)\(PAL_BASE_ROLE,/g],
    ['src/renderer/src/components/AgentSwitcher.tsx', /newConversationFromWorkspace\(PAL_BASE_ROLE,/g],
    ['src/renderer/src/components/WelcomePage.tsx', /newConversationFromAgent\(PAL_BASE_ROLE,/g],
  ])('%s 开 Pal 对话不带当前全局角色', (file, pattern) => {
    const source = read(file)
    expect(source).toMatch(pattern)
    expect(source).not.toMatch(/newConversationFrom(?:Agent|Workspace)\(roleName,/)
  })

  it('定时任务与 HTTP 创建 Pal 会话同样用中性角色', () => {
    expect(read('src/main/scheduler.ts')).toMatch(/\(task\.workspaceId \|\| task\.agentId\) \? PAL_BASE_ROLE/)
    expect(read('src/main/http-server.ts')).toMatch(/\(body\.workspaceId \|\| body\.agentId\) \? PAL_BASE_ROLE/)
  })

  it('DC 闸门的拒绝文案给 dc-authoring 的绝对路径，不再说"技能索引里的"', () => {
    const tools = read('src/main/openpipal-product-tools.ts')
    expect(tools).toMatch(/先 read \$\{path\.join\(getBuiltInSkillsDir\(\), 'dc-authoring', 'SKILL\.md'\)\}/)
    expect(tools).not.toMatch(/技能索引里 dc-authoring/)
  })
})

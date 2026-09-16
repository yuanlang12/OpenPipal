/**
 * Pal 会话的 `role` 槽位一律是默认角色（DEFAULT_AGENT_ID = general），不借任何"当前角色"。
 * 2026-09-09 实撞：所有者上次点过设计助手，再点「试一下」开物理教案 Pal，Pal 借来 design 的
 * "整页 HTML 必须是 DC"闸门，可它的技能索引里没有 dc-authoring → 猜路径、翻目录、要搜全盘。
 * 第 5 段起没有 PAL_BASE_ROLE 常量了（pal-contract 删除）：槽位就是默认角色这一个概念，
 * 由 chatStore.newConversationFromWorkspace / scheduler / HTTP 三处各自固定；中性角色真的中性（公共工具、没有产物闸门）。
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { DEFAULT_AGENT_ID } from '../../src/shared/agent-identity'

const read = (file: string): string => readFileSync(file, 'utf8')

describe('Pal 会话的 role 槽位', () => {
  it('默认角色是 general：只带公共工具，不在任何产物闸门的角色名单里', () => {
    expect(DEFAULT_AGENT_ID).toBe('general')
    const roles = read('src/main/role-manager.ts')
    expect(roles).toMatch(/name: 'general',[\s\S]*?tools: COMMON_TOOLS/)
    const tools = read('src/main/openpipal-product-tools.ts')
    for (const gate of tools.match(/\[[^\]]*\]\.includes\(roleName\)|roleName === '[a-z]+'/g) ?? []) {
      expect(gate, gate).not.toContain("'general'")
    }
  })

  it('渲染层：开 Pal 会话只有一条路（newConversationFromWorkspace），role 槽位在 chatStore 里固定成默认角色', () => {
    const chat = read('src/renderer/src/stores/chatStore.ts')
    expect(chat).toMatch(/newConversationFromWorkspace: \(workspaceId, workspaceName\) =>[\s\S]*?createConversation\(DEFAULT_AGENT_ID, workspaceName, undefined, workspaceId\)/)
    expect(chat).not.toContain('newConversationFromAgent')
    expect(chat).not.toContain('activeAgentId')
    expect(read('src/renderer/src/utils/startConversationWith.ts')).toMatch(/newConversationFromWorkspace\(agent\.id, agent\.name\)/)
    expect(read('src/renderer/src/components/AgentsPanel.tsx')).not.toContain('newConversationFromWorkspace(')   // 面板只走 startConversationWith
  })

  it('不变量收在存储层：有 workspaceId 的会话 role 槽位一律默认角色，入口写错也拦得住；PAL_BASE_ROLE / pal-contract 不存在了', () => {
    for (const file of ['src/main/conversation-store.ts', 'src/main/conversation-service.ts']) {
      expect(read(file), file).toContain('role: workspaceId ? DEFAULT_AGENT_ID : role,')
    }
    expect(read('src/main/scheduler.ts')).toMatch(/const workspaceId = team \? team\.lead : task\.workspaceId\n[\s\S]{0,400}workspaceId \? DEFAULT_AGENT_ID : \(task\.role \|\| DEFAULT_AGENT_ID\)/)
    expect(read('src/main/http-server.ts')).toMatch(/target\.kind === 'builtin' \? target\.id : DEFAULT_AGENT_ID/)
    const { existsSync } = require('node:fs') as typeof import('node:fs')
    expect(existsSync('src/shared/pal-contract.ts')).toBe(false)
  })

  it('DC 闸门的拒绝文案给 dc-authoring 的绝对路径，不再说"技能索引里的"', () => {
    const tools = read('src/main/openpipal-product-tools.ts')
    expect(tools).toMatch(/先 read \$\{path\.join\(getBuiltInSkillsDir\(\), 'dc-authoring', 'SKILL\.md'\)\}/)
    expect(tools).not.toMatch(/技能索引里 dc-authoring/)
  })
})

/**
 * 统一身份第 2 段（数据层）：对话 / 任务 / 会话文件都带一个 `agent`，老记录读侧派生、不改文件；
 * 写侧新旧字段并存（老版本照样打开）；文件头 / 快照缺 role 但有 agent 也打得开（为将来只写 agent 的版本铺路）。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { resolveAgentId } from '../../src/shared/agent-identity'

const homes: string[] = []
const originalIsolatedHome = process.env.OPENPIPAL_ISOLATED_HOME
function isolatedHome(): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'openpipal-agent-identity-'))
  homes.push(home)
  process.env.OPENPIPAL_ISOLATED_HOME = home
  return home
}
afterEach(() => {
  vi.resetModules()
  for (const home of homes.splice(0)) fs.rmSync(home, { recursive: true, force: true })
  if (originalIsolatedHome === undefined) delete process.env.OPENPIPAL_ISOLATED_HOME
  else process.env.OPENPIPAL_ISOLATED_HOME = originalIsolatedHome
})

describe('resolveAgentId', () => {
  it('已有 agent 就用它；否则 Pal > 模板 > 角色 > general', () => {
    expect(resolveAgentId({ agent: 'x', workspaceId: 'w', role: 'design' })).toBe('x')
    expect(resolveAgentId({ workspaceId: 'w', agentId: 't', role: 'design' })).toBe('w')
    expect(resolveAgentId({ agentId: 't', role: 'design' })).toBe('t')
    expect(resolveAgentId({ role: 'design' })).toBe('design')
    expect(resolveAgentId({})).toBe('general')
  })
})

describe('老 JSON 会话', () => {
  it('创建时写 agent + 老字段；磁盘上没有 agent 的老文件读出来也有', async () => {
    const home = isolatedHome()
    vi.resetModules()
    const store = await import('../../src/main/conversation-store')
    const pal = store.createConversation('general', 'Pal 会话', undefined, 'ws-1')
    expect(pal.agent).toBe('ws-1')
    const onDisk = JSON.parse(fs.readFileSync(path.join(home, '.openpipal', 'conversations', `${pal.id}.json`), 'utf8'))
    expect(onDisk).toMatchObject({ role: 'general', workspaceId: 'ws-1', agent: 'ws-1' })

    // 手写一份 1.1.4 之前的文件：只有 role
    const oldId = '11111111-1111-4111-8111-111111111111'
    fs.writeFileSync(path.join(home, '.openpipal', 'conversations', `${oldId}.json`), JSON.stringify({ id: oldId, title: '老会话', role: 'design', createdAt: 1, updatedAt: 1, messages: [] }), 'utf8')
    expect(store.getConversation(oldId)?.agent).toBe('design')
    const summaries = store.listConversations()
    expect(summaries.find(s => s.id === oldId)?.agent).toBe('design')
    expect(summaries.find(s => s.id === pal.id)?.agent).toBe('ws-1')
  })
})

describe('JSONL 会话', () => {
  it('文件头与快照都带 agent；换身份后快照里的 agent 跟着变；重启后投影照样有', async () => {
    const home = isolatedHome()
    vi.resetModules()
    const service = await import('../../src/main/conversation-service')
    await service.initializeConversationService({ newSessionStorage: 'pi-jsonl-v4' })
    const conv = await service.createConversation('design', '设计会话')
    expect(conv.agent).toBe('design')
    const files = fs.readdirSync(path.join(home, '.openpipal', 'sessions-v4', 'logs'), { recursive: true }) as string[]
    const jsonl = files.find(f => f.endsWith('.jsonl'))!
    const header = JSON.parse(fs.readFileSync(path.join(home, '.openpipal', 'sessions-v4', 'logs', jsonl), 'utf8').split('\n')[0])
    expect(header.metadata).toMatchObject({ initialRole: 'design', initialAgent: 'design' })

    await service.updateConversationWorkspace(conv.id, 'ws-9')
    expect((await service.getConversation(conv.id))?.agent).toBe('ws-9')

    vi.resetModules()
    const restarted = await import('../../src/main/conversation-service')
    await restarted.initializeConversationService({ newSessionStorage: 'pi-jsonl-v4' })
    expect((await restarted.getConversation(conv.id))?.agent).toBe('ws-9')
    expect((await restarted.listConversations()).find(s => s.id === conv.id)?.agent).toBe('ws-9')
  })

  it('校验器：缺 role 但有 agent 的文件头 / 快照打得开，role 回落中性值；两个都缺才拒', async () => {
    const events = await import('../../src/main/session/openpipal-session-events')
    const base = { openpipalSchema: 1, conversationId: 'c', createdBy: 'desktop', initialTitle: 't', initialCreatedAt: 1 }
    expect(events.readSessionHeader({ ...base, initialAgent: 'ws-1' })).toMatchObject({ initialAgent: 'ws-1', initialRole: 'general' })
    expect(events.readSessionHeader({ ...base, initialRole: 'design' })?.initialRole).toBe('design')
    expect(events.readSessionHeader(base)).toBeNull()
    const snap = { schema: 1, title: 't', updatedAt: 1 }
    expect(events.readProductSnapshot({ ...snap, agent: 'ws-1' })).toMatchObject({ agent: 'ws-1', role: 'general' })
    expect(events.readProductSnapshot({ ...snap, role: 'coding' })?.role).toBe('coding')
    expect(events.readProductSnapshot(snap)).toBeNull()
    expect(events.readProductSnapshot({ ...snap, agent: 7 })).toBeNull()
  })
})

describe('任务', () => {
  it('创建 / 读取 / 改作用域都带 agent', async () => {
    const home = isolatedHome()
    vi.resetModules()
    const tasks = await import('../../src/main/task-store')
    const created = tasks.createTask({ name: 't', enabled: true, role: 'teacher', trigger: { type: 'manual' } as never, prompt: 'x' } as never)
    expect(created.agent).toBe('teacher')
    const moved = tasks.updateTask(created.id, { workspaceId: 'ws-2' })
    expect(moved?.agent).toBe('ws-2')
    const oldId = 'legacy-task'
    fs.writeFileSync(path.join(home, '.openpipal', 'tasks', `${oldId}.json`), JSON.stringify({ id: oldId, name: '老任务', enabled: true, agentId: 'tpl-1', trigger: { type: 'manual' }, prompt: 'x', createdAt: 1, updatedAt: 1 }), 'utf8')
    expect(tasks.getTask(oldId)?.agent).toBe('tpl-1')
    expect(tasks.listTasks().find(t => t.id === oldId)?.agent).toBe('tpl-1')
  })
})

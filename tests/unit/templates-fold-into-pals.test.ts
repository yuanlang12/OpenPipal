/**
 * 统一身份第 5 段：模板并入 Pal，第三种身份消失。
 *   - 启动迁移 migrateTemplatesIntoPals：agent-templates/<id>.json → agents/<id>/（同 id），原文件改名 .migrated
 *   - 读侧派生：老会话 / 老任务里的 agentId（曾指模板）只要是个 Pal 目录，就当 workspaceId；文件不改
 *   - 写侧：新会话不再写 agentId；IPC / preload / shim 没有模板 CRUD；注册表只认内置和 Pal
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'

const HOME = mkdtempSync(join(tmpdir(), 'openpipal-fold-'))
process.env.OPENPIPAL_ISOLATED_HOME = HOME
const DATA_DIR = '.openpipal'
const DATA = join(HOME, DATA_DIR)
vi.mock('electron', () => ({ app: { isPackaged: false, getAppPath: () => process.cwd(), getPath: () => HOME } }))

const TEMPLATE = 'd1d2d3d4-0000-4000-8000-000000000005'
mkdirSync(join(DATA, 'agent-templates'), { recursive: true })
writeFileSync(join(DATA, 'agent-templates', `${TEMPLATE}.json`), JSON.stringify({ id: TEMPLATE, name: '周报模板', description: '每周五', icon: '📝', systemPrompt: '写周报', workingDir: '/tmp/weekly', createdAt: 1, updatedAt: 1 }), 'utf8')
// 一条老会话：只有 agentId（模板时代的写法），没有 workspaceId
mkdirSync(join(DATA, 'conversations'), { recursive: true })
const CONV = 'c0c0c0c0-0000-4000-8000-000000000006'
writeFileSync(join(DATA, 'conversations', `${CONV}.json`), JSON.stringify({ id: CONV, title: '老会话', role: 'general', agentId: TEMPLATE, createdAt: 1, updatedAt: 1, messages: [] }), 'utf8')
// 一条老任务：同样只有 agentId
mkdirSync(join(DATA, 'tasks'), { recursive: true })
const TASK = 't0t0t0t0-0000-4000-8000-000000000007'
writeFileSync(join(DATA, 'tasks', `${TASK}.json`), JSON.stringify({ id: TASK, name: '老任务', enabled: false, agentId: TEMPLATE, trigger: { type: 'schedule', schedule: { type: 'cron', cron: '0 9 * * 1' } }, prompt: 'x', conversationMode: 'per-run', createdAt: 1, updatedAt: 1 }), 'utf8')

const read = (file: string): string => readFileSync(file, 'utf8')
afterAll(() => rmSync(HOME, { recursive: true, force: true }))

describe('模板并入 Pal', () => {
  it('迁移：同 id 变成 Pal 目录，人设 / 工作目录 / 描述带过来，原文件改名留底', async () => {
    const { migrateTemplatesIntoPals } = await import('../../src/main/agent-template-manager')
    const { isPalId, palIdOf } = await import('../../src/main/pal-id')
    expect(isPalId(TEMPLATE)).toBe(false)
    migrateTemplatesIntoPals()
    expect(isPalId(TEMPLATE)).toBe(true)
    expect(palIdOf({ agentId: TEMPLATE })).toBe(TEMPLATE)
    expect(palIdOf({ agentId: 'not-a-pal' })).toBeUndefined()
    expect(palIdOf({ workspaceId: 'ws', agentId: TEMPLATE })).toBe('ws')
    const meta = JSON.parse(read(join(DATA, 'agents', TEMPLATE, 'meta.json')))
    expect(meta).toMatchObject({ id: TEMPLATE, name: '周报模板', description: '每周五', icon: '📝' })
    expect(read(join(DATA, 'agents', TEMPLATE, 'agent.md'))).toBe('写周报\n')
    expect(JSON.parse(read(join(DATA, 'agents', TEMPLATE, 'tools', 'config.json')))).toEqual({ workingDir: '/tmp/weekly' })
    expect(existsSync(join(DATA, 'agent-templates', `${TEMPLATE}.json.migrated`))).toBe(true)
  })

  it('读侧派生：老会话 / 老任务的 agentId 当 workspaceId；新会话不再写 agentId', async () => {
    const conv = await import('../../src/main/conversation-store')
    const old = conv.getConversation(CONV)!
    expect(old.workspaceId).toBe(TEMPLATE)
    expect(old.agent).toBe(TEMPLATE)
    expect(JSON.parse(read(join(DATA, 'conversations', `${CONV}.json`))).workspaceId).toBeUndefined()   // 文件没改
    const fresh = conv.createConversation('general', '新的', TEMPLATE)
    expect(fresh.workspaceId).toBe(TEMPLATE)
    expect(fresh.agentId).toBeUndefined()
    const tasks = await import('../../src/main/task-store')
    const task = tasks.getTask(TASK)!
    expect(task.workspaceId).toBe(TEMPLATE)
    expect(task.agent).toBe(TEMPLATE)
  })

  it('没有模板 CRUD 了：IPC / preload / shim / 渲染层 store 都不认识 agent:list 那一套；注册表只有两种身份', () => {
    expect(read('src/main/ipc-handlers.ts')).not.toMatch(/'agent:(list|get|create|update|delete)'/)
    for (const file of ['src/preload/index.ts', 'src/preload/index.d.ts', 'src/renderer/src/web-api-shim.ts', 'src/renderer/src/stores/agentStore.ts']) {
      expect(read(file), file).not.toMatch(/AgentTemplate|listAgentTemplates/)
    }
    expect(read('src/shared/agent-identity.ts')).toContain("export type AgentKind = 'builtin' | 'pal'")
    expect(existsSync('src/renderer/src/components/AgentTemplateEditor.tsx')).toBe(false)
    expect(read('src/main/index.ts')).toMatch(/migrateLegacyTemplates\(\)\n\s*migrateLegacyWorkspaces\(\)\n\s*migrateTemplatesIntoPals\(\)/)
  })
})

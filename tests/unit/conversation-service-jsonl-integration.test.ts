import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const homes: string[] = []
const originalIsolatedHome = process.env.OPENPIPAL_ISOLATED_HOME

function isolatedHome(): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'openpipal-conversation-service-'))
  homes.push(home)
  process.env.OPENPIPAL_ISOLATED_HOME = home
  return home
}

function findFiles(root: string, suffix: string): string[] {
  if (!fs.existsSync(root)) return []
  const pending = [root]
  const matches: string[] = []
  while (pending.length > 0) {
    const current = pending.pop()!
    for (const name of fs.readdirSync(current)) {
      const child = path.join(current, name)
      const info = fs.lstatSync(child)
      if (info.isDirectory()) pending.push(child)
      else if (name.endsWith(suffix)) matches.push(child)
    }
  }
  return matches
}

afterEach(() => {
  vi.resetModules()
  for (const home of homes.splice(0)) fs.rmSync(home, { recursive: true, force: true })
  if (originalIsolatedHome === undefined) delete process.env.OPENPIPAL_ISOLATED_HOME
  else process.env.OPENPIPAL_ISOLATED_HOME = originalIsolatedHome
})

describe('Conversation Service JSONL product integration', () => {
  it('keeps legacy conversations readable while new sessions use JSONL across restart', async () => {
    const home = isolatedHome()
    vi.resetModules()

    const legacy = await import('../../src/main/conversation-store')
    const oldConversation = legacy.createConversation('general', '旧会话')
    await legacy.appendMessages(oldConversation.id, [{
      id: 'legacy-user',
      role: 'user',
      content: '旧记录仍然可读',
      timestamp: 1,
    }])

    const service = await import('../../src/main/conversation-service')
    await service.initializeConversationService({ newSessionStorage: 'pi-jsonl-v4' })
    const fresh = await service.createConversation('design', '新格式会话', 'design-agent', 'workspace-1')
    const user = { id: 'user-1', role: 'user' as const, content: '生成首页', timestamp: 10 }
    const oldAssistant = {
      id: 'assistant-old',
      role: 'assistant' as const,
      content: '旧版本',
      timestamp: 11,
      artifactRef: { id: 'artifact-1', type: 'html', title: '首页', path: 'artifact-1.html' },
    }
    const newAssistant = {
      ...oldAssistant,
      id: 'assistant-new',
      content: '新版本',
      timestamp: 12,
    }
    expect(await service.appendMessages(fresh.id, [user, oldAssistant])).toBe(true)
    expect(await service.replaceMessages(fresh.id, [user, newAssistant])).toBe(true)
    expect(await service.updateConversationConfig(fresh.id, {
      workingDir: '/tmp/project',
      acp: { adapter: 'openpipal-acp', client: 'Zed', protocolVersion: 2 },
      goal: {
        text: '完成首页',
        createdAt: 20,
        maxTurns: 8,
        turnsUsed: 1,
        status: 'active',
        consecutiveBlocks: 0,
      },
    })).toBe(true)

    expect((await service.listConversations()).map((item) => item.id).sort())
      .toEqual([oldConversation.id, fresh.id].sort())
    expect((await service.getConversation(oldConversation.id))?.messages[0].id).toBe('legacy-user')
    expect((await service.getConversation(fresh.id))?.messages.map((item) => item.id))
      .toEqual(['user-1', 'assistant-new'])
    expect(service.peekConversation(fresh.id)?.config).toMatchObject({
      workingDir: '/tmp/project',
      acp: { adapter: 'openpipal-acp' },
      goal: { text: '完成首页' },
    })

    const dataRoot = path.join(home, '.openpipal')
    expect(fs.existsSync(path.join(dataRoot, 'conversations', `${oldConversation.id}.json`))).toBe(true)
    expect(fs.existsSync(path.join(dataRoot, 'conversations', `${fresh.id}.json`))).toBe(false)
    expect(findFiles(path.join(dataRoot, 'sessions-v4'), '.jsonl')).toHaveLength(1)
    await service.drainConversationService()

    // A fresh module graph simulates an application restart and forces the
    // active branch/product state to be reconstructed from disk.
    vi.resetModules()
    const restarted = await import('../../src/main/conversation-service')
    await restarted.initializeConversationService({ newSessionStorage: 'pi-jsonl-v4' })
    expect((await restarted.listConversations()).map((item) => item.id).sort())
      .toEqual([oldConversation.id, fresh.id].sort())
    const restored = await restarted.getConversation(fresh.id)
    expect(restored).toMatchObject({
      id: fresh.id,
      role: 'design',
      agentId: 'design-agent',
      workspaceId: 'workspace-1',
      config: {
        workingDir: '/tmp/project',
        acp: { adapter: 'openpipal-acp', client: 'Zed' },
        goal: { text: '完成首页' },
      },
    })
    expect(restored?.messages.map((item) => item.id)).toEqual(['user-1', 'assistant-new'])

    expect(await restarted.deleteConversation(oldConversation.id)).toBe(true)
    expect(await restarted.deleteConversation(fresh.id)).toBe(true)
    expect(await restarted.listConversations()).toEqual([])
  })

  it('keeps an explicit legacy kill switch without hiding existing JSONL history', async () => {
    const home = isolatedHome()
    vi.resetModules()
    const jsonlService = await import('../../src/main/conversation-service')
    await jsonlService.initializeConversationService({ newSessionStorage: 'pi-jsonl-v4' })
    const existingJsonl = await jsonlService.createConversation('design', '已存在的新格式会话')
    await jsonlService.appendMessages(existingJsonl.id, [{
      id: 'jsonl-message-1',
      role: 'user',
      content: '回退后仍应可见',
      timestamp: 1,
    }])
    await jsonlService.drainConversationService()

    vi.resetModules()
    const service = await import('../../src/main/conversation-service')
    await service.initializeConversationService({ newSessionStorage: 'legacy-json' })
    const rollbackConversation = await service.createConversation('general', '回退会话')
    await service.appendMessages(rollbackConversation.id, [{
      id: 'message-1',
      role: 'user',
      content: '旧路径',
      timestamp: 2,
    }])

    const dataRoot = path.join(home, '.openpipal')
    expect(fs.existsSync(path.join(dataRoot, 'conversations', `${rollbackConversation.id}.json`))).toBe(true)
    expect(findFiles(path.join(dataRoot, 'sessions-v4'), '.jsonl')).toHaveLength(1)
    expect((await service.listConversations()).map((item) => item.id).sort())
      .toEqual([existingJsonl.id, rollbackConversation.id].sort())
    expect((await service.getConversation(existingJsonl.id))?.messages[0].id).toBe('jsonl-message-1')
    expect((await service.getConversation(rollbackConversation.id))?.messages[0].id).toBe('message-1')
  })

  it('recovers an interrupted runtime once on startup and never replays it', async () => {
    isolatedHome()
    vi.resetModules()
    const service = await import('../../src/main/conversation-service')
    await service.initializeConversationService({ newSessionStorage: 'pi-jsonl-v4' })
    const conversation = await service.createConversation('coding', '中断恢复')
    await service.appendMessages(conversation.id, [{
      id: 'user-1',
      role: 'user',
      content: '执行一次可能改文件的任务',
      timestamp: 1,
    }])
    const interruptedRunId = await service.beginConversationOperation(conversation.id, 'desktop')
    expect(interruptedRunId).toBeTruthy()
    await service.drainConversationService()

    vi.resetModules()
    const restarted = await import('../../src/main/conversation-service')
    await restarted.initializeConversationService({ newSessionStorage: 'pi-jsonl-v4' })
    const recovered = await restarted.getConversation(conversation.id)
    expect(recovered?.messages.map((message) => message.id)).toEqual([
      'user-1',
      `runtime-interrupted-${interruptedRunId}`,
    ])
    expect(recovered?.messages[1]).toMatchObject({
      messageKind: 'incomplete',
      messageSubtype: 'runtime-interrupted',
    })

    // A later normal operation can proceed, proving recovery closed the stale
    // run instead of replaying or permanently locking the conversation.
    const completedRunId = await restarted.beginConversationOperation(conversation.id, 'desktop')
    expect(completedRunId).toBeTruthy()
    expect(await restarted.finishConversationOperation(
      conversation.id,
      completedRunId,
      'completed'
    )).toBe(true)
    await restarted.drainConversationService()

    vi.resetModules()
    const secondRestart = await import('../../src/main/conversation-service')
    await secondRestart.initializeConversationService({ newSessionStorage: 'pi-jsonl-v4' })
    const warnings = (await secondRestart.getConversation(conversation.id))?.messages
      .filter((message) => message.messageSubtype === 'runtime-interrupted')
    expect(warnings).toHaveLength(1)
  })
})

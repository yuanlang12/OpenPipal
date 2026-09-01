import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  JsonlSessionRepo,
  type CustomEntry,
  type JsonlSessionMetadata,
} from '@earendil-works/pi-agent-core'
import type { Conversation, StoredMessage } from '../../src/main/conversation-store'
import {
  OPENPIPAL_MESSAGE_EVENT,
  PiV4JsonlSessionStore,
  SecureSessionFileSystem,
  createPiV4SessionStoreIfEnabled,
  readMessageEvent,
  resolveNewSessionStorageKind,
} from '../../src/main/session'

const roots: string[] = []

function makeRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openpipal-session-store-'))
  roots.push(root)
  return root
}

function message(id: string, role: StoredMessage['role'], content: string, timestamp: number): StoredMessage {
  return { id, role, content, timestamp }
}

function conversation(id: string, messages: StoredMessage[] = []): Conversation {
  return {
    id,
    title: '会话标题',
    role: 'design',
    agentId: 'design-agent',
    workspaceId: 'workspace-a',
    config: {
      workingDir: '/tmp/project',
      projectName: '项目甲',
      permissionTier: 'auto',
      acp: { adapter: 'openpipal-acp', client: 'vscode', protocolVersion: 2 },
      initialAssets: [{
        category: 'design-system',
        fileName: 'tokens.json',
        path: '/tmp/project/tokens.json',
        sourceType: 'library',
      }],
      historyCompaction: {
        summary: '此前已经完成需求确认',
        coveredCount: 2,
        coveredDigest: 'digest-1',
      },
      pendingQuestion: { artifactId: 'q1', title: '补充信息', questions: [{ id: 'field-a' }] },
      goal: {
        text: '完成设计',
        createdAt: 101,
        maxTurns: 8,
        turnsUsed: 1,
        status: 'active',
        consecutiveBlocks: 0,
      },
    },
    createdAt: 100,
    updatedAt: 200,
    messages,
  }
}

function findJsonl(root: string): string {
  const pending = [root]
  while (pending.length > 0) {
    const current = pending.pop()!
    for (const name of fs.readdirSync(current)) {
      const child = path.join(current, name)
      const info = fs.lstatSync(child)
      if (info.isDirectory()) pending.push(child)
      else if (name.endsWith('.jsonl')) return child
    }
  }
  throw new Error('JSONL session not found')
}

function findJsonlForConversation(root: string, conversationId: string): string {
  const pending = [root]
  while (pending.length > 0) {
    const current = pending.pop()!
    for (const name of fs.readdirSync(current)) {
      const child = path.join(current, name)
      const info = fs.lstatSync(child)
      if (info.isDirectory()) {
        pending.push(child)
        continue
      }
      if (!name.endsWith('.jsonl')) continue
      const firstLine = fs.readFileSync(child, 'utf8').split('\n', 1)[0]
      try {
        const header = JSON.parse(firstLine)
        if (header?.id === conversationId && header?.metadata?.conversationId === conversationId) {
          return child
        }
      } catch { /* malformed headers are not a match */ }
    }
  }
  throw new Error(`JSONL session not found for ${conversationId}`)
}

async function openRawSession(root: string): Promise<{
  metadata: JsonlSessionMetadata
  session: Awaited<ReturnType<JsonlSessionRepo['open']>>
}> {
  const adapter = new SecureSessionFileSystem(root)
  const repo = new JsonlSessionRepo({ fs: adapter, sessionsRoot: path.join(root, 'logs') })
  const [metadata] = await repo.list({ cwd: path.join(root, 'openpipal') })
  return { metadata, session: await repo.open(metadata) }
}

function messageEntries(entries: CustomEntry[]): Array<{ entry: CustomEntry; id: string }> {
  return entries.flatMap((entry) => {
    const event = readMessageEvent(entry.data)
    return event ? [{ entry, id: event.message.id }] : []
  })
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
  delete process.env.OPENPIPAL_SESSION_STORE
})

describe('PiV4JsonlSessionStore', () => {
  it('uses only pi-agent-core public exports and never activates AgentHarness or the CLI package', () => {
    const sessionDir = path.resolve('src/main/session')
    for (const name of fs.readdirSync(sessionDir).filter((file) => file.endsWith('.ts'))) {
      const source = fs.readFileSync(path.join(sessionDir, name), 'utf8')
      expect(source, name).not.toContain('@earendil-works/pi-agent-core/dist/')
      expect(source, name).not.toContain('@earendil-works/pi-coding-agent')
      expect(source, name).not.toMatch(/new AgentHarness\s*\(/)
    }
  })

  it('is opt-in and does not silently replace the existing Conversation Service', async () => {
    const root = makeRoot()
    expect(resolveNewSessionStorageKind()).toBe('legacy-json')
    expect(resolveNewSessionStorageKind('PI-JSONL-V4')).toBe('pi-jsonl-v4')
    expect(resolveNewSessionStorageKind('unexpected')).toBe('legacy-json')
    expect(createPiV4SessionStoreIfEnabled({ root })).toBeNull()

    process.env.OPENPIPAL_SESSION_STORE = 'pi-jsonl-v4'
    const enabled = createPiV4SessionStoreIfEnabled({ root })
    expect(enabled).toBeInstanceOf(PiV4JsonlSessionStore)
    await expect(enabled!.list()).resolves.toEqual([])
  })

  it('round-trips OpenPipal product state and full message display fields across restart', async () => {
    const root = makeRoot()
    const original = conversation('roundtrip', [
      message('user-1', 'user', '读取设计规范', 201),
      {
        ...message('assistant-tool-call', 'assistant', '', 202),
        toolName: 'read_file',
        toolArgs: '{"path":"tokens.json"}',
        modelToolArgs: '{"path":"/tmp/project/tokens.json"}',
        toolCallId: 'tool-call-1',
      },
      {
        ...message('tool-result-1', 'tool', '读取成功', 203),
        toolName: 'read_file',
        toolCallId: 'tool-call-1',
        fileAttachments: [{ fileName: 'tokens.json', fileType: 'application/json', sizeBytes: 128 }],
      },
      {
        ...message('permission-1', 'assistant', '', 204),
        permissionRequest: {
          requestId: 'permission-1',
          tool: 'bash',
          args: { command: 'npm test' },
          risk: 'medium',
          reason: '运行项目测试',
        },
        permissionStatus: 'pending',
      },
      {
        ...message('assistant-1', 'assistant', '完成', 210),
        thinkingContent: '内部思考',
        thinkingMs: 1234,
        artifactRef: { id: 'artifact-1', type: 'code', title: '页面', path: 'artifact.html' },
        screenshotRef: 'shot.png',
        mcpAppRef: 'mcp-payload.json',
      },
      {
        ...message('retry-live-only', 'assistant', '连接中断', 211),
        messageKind: 'inject-notice',
        messageSubtype: 'stream-retry',
      },
    ])
    const store = new PiV4JsonlSessionStore({ root })
    await store.create({ conversation: original, createdBy: 'test' })

    const restarted = new PiV4JsonlSessionStore({ root })
    await expect(restarted.open(original.id)).resolves.toEqual({
      conversationId: original.id,
      storage: 'pi-jsonl-v4',
      createdAt: original.createdAt,
    })
    const projected = await restarted.project(original.id)
    expect(projected).toMatchObject({
      id: original.id,
      title: original.title,
      role: original.role,
      agentId: original.agentId,
      workspaceId: original.workspaceId,
      config: original.config,
      createdAt: original.createdAt,
    })
    expect(projected?.messages.map((item) => item.id)).toEqual([
      'user-1',
      'assistant-tool-call',
      'tool-result-1',
      'permission-1',
      'assistant-1',
    ])
    expect(projected?.messages.find((item) => item.id === 'assistant-tool-call')).toMatchObject({
      toolName: 'read_file',
      toolCallId: 'tool-call-1',
      modelToolArgs: '{"path":"/tmp/project/tokens.json"}',
    })
    expect(projected?.messages.find((item) => item.id === 'tool-result-1')).toMatchObject({
      role: 'tool',
      toolName: 'read_file',
      toolCallId: 'tool-call-1',
      fileAttachments: [{ fileName: 'tokens.json', sizeBytes: 128 }],
    })
    expect(projected?.messages.find((item) => item.id === 'permission-1')).toMatchObject({
      permissionRequest: { requestId: 'permission-1', tool: 'bash' },
      permissionStatus: 'pending',
    })
    expect(projected?.messages.find((item) => item.id === 'assistant-1')).toMatchObject({
      id: 'assistant-1',
      thinkingContent: '内部思考',
      thinkingMs: 1234,
      screenshotRef: 'shot.png',
      mcpAppRef: 'mcp-payload.json',
      artifactRef: { id: 'artifact-1' },
    })
  })

  it('restores 1,000 appended events exactly after a new store instance opens the log', async () => {
    const root = makeRoot()
    const messages = Array.from({ length: 1000 }, (_, index) => (
      message(`m-${index}`, index % 2 === 0 ? 'user' : 'assistant', `内容 ${index}`, 1000 + index)
    ))
    const store = new PiV4JsonlSessionStore({ root })
    await store.create({ conversation: conversation('thousand', messages), createdBy: 'test' })
    await store.drain()

    const projected = await new PiV4JsonlSessionStore({ root }).project('thousand')
    expect(projected?.messages).toHaveLength(1000)
    expect(projected?.messages.map((item) => item.id)).toEqual(messages.map((item) => item.id))
  })

  it('serializes concurrent appends without dropping messages or sequence numbers', async () => {
    const root = makeRoot()
    const store = new PiV4JsonlSessionStore({ root })
    await store.create({ conversation: conversation('concurrent'), createdBy: 'test' })
    await Promise.all(Array.from({ length: 50 }, (_, index) => (
      store.appendMessages('concurrent', [message(`m-${index}`, 'user', String(index), 300 + index)])
    )))

    const projected = await new PiV4JsonlSessionStore({ root }).project('concurrent')
    expect(projected?.messages.map((item) => item.id))
      .toEqual(Array.from({ length: 50 }, (_, index) => `m-${index}`))
    const mutations = fs.readFileSync(findJsonl(root), 'utf8').trimEnd().split('\n').slice(1)
      .map((line) => JSON.parse(line) as { seq: number; entry?: { seq: number } })
    const sequences = mutations.map((mutation) => mutation.entry?.seq ?? mutation.seq)
    expect(sequences).toEqual(Array.from({ length: sequences.length }, (_, index) => index + 1))
  })

  it('treats a retried unacknowledged append batch as idempotent', async () => {
    const root = makeRoot()
    const store = new PiV4JsonlSessionStore({ root })
    await store.create({ conversation: conversation('append-retry'), createdBy: 'test' })
    const batch = [
      message('retry-user', 'user', '同一批次', 1),
      message('retry-assistant', 'assistant', '只保存一次', 2),
    ]

    expect(await store.appendMessages('append-retry', batch)).toBe(true)
    expect(await store.appendMessages('append-retry', batch)).toBe(true)
    expect((await new PiV4JsonlSessionStore({ root }).project('append-retry'))?.messages
      .map((item) => ({ id: item.id, content: item.content })))
      .toEqual(batch.map((item) => ({ id: item.id, content: item.content })))
  })

  it('branches on regeneration and keeps the old assistant entry readable', async () => {
    const root = makeRoot()
    const store = new PiV4JsonlSessionStore({ root })
    const user = message('user-1', 'user', '画一张海报', 1)
    const oldAssistant = message('assistant-old', 'assistant', '旧版本', 2)
    const newAssistant = message('assistant-new', 'assistant', '新版本', 3)
    await store.create({ conversation: conversation('branch', [user, oldAssistant]), createdBy: 'test' })
    await store.replaceMessages('branch', [user, newAssistant])

    expect((await store.project('branch'))?.messages.map((item) => item.id))
      .toEqual(['user-1', 'assistant-new'])
    const { session } = await openRawSession(root)
    const entries = await session.findEntries({
      type: 'custom',
      customType: OPENPIPAL_MESSAGE_EVENT,
      order: 'oldestFirst',
    }) as CustomEntry[]
    const indexed = messageEntries(entries)
    expect(indexed.map((item) => item.id)).toEqual(['user-1', 'assistant-old', 'assistant-new'])

    const oldLeaf = indexed.find((item) => item.id === 'assistant-old')!.entry.id
    const oldBranch = await session.findEntriesOnBranch({ start: oldLeaf, order: 'oldestFirst' }) as CustomEntry[]
    expect(messageEntries(oldBranch).map((item) => item.id)).toEqual(['user-1', 'assistant-old'])
  })

  it('records streaming changes to the current tail as updates instead of branch spam', async () => {
    const root = makeRoot()
    const store = new PiV4JsonlSessionStore({ root })
    const user = message('user-1', 'user', '开始', 1)
    await store.create({
      conversation: conversation('tail-update', [user, message('assistant-1', 'assistant', '半', 2)]),
      createdBy: 'test',
    })
    await store.replaceMessages('tail-update', [user, message('assistant-1', 'assistant', '完整回答', 3)])

    expect((await store.project('tail-update'))?.messages.map((item) => item.content))
      .toEqual(['开始', '完整回答'])
    const { session } = await openRawSession(root)
    const entries = await session.findEntries({ customType: OPENPIPAL_MESSAGE_EVENT }) as CustomEntry[]
    expect(entries).toHaveLength(3)
    expect(entries.map((entry) => readMessageEvent(entry.data)?.operation))
      .toContain('update')
  })

  it('durably brackets one runtime operation and refuses overlapping starts', async () => {
    const root = makeRoot()
    const store = new PiV4JsonlSessionStore({ root })
    await store.create({ conversation: conversation('operation'), createdBy: 'test' })
    const runId = await store.beginOperation('operation', 'desktop')
    expect(runId).toBeTruthy()
    await expect(store.beginOperation('operation', 'desktop'))
      .rejects.toThrow(/unfinished operation/i)

    const opened = await openRawSession(root)
    expect((await opened.session.findOpenOperations('main')).map((item) => item.id))
      .toEqual([runId])
    expect(await store.finishOperation('operation', runId!, 'completed')).toBe(true)
    expect(await (await openRawSession(root)).session.findOpenOperations('main')).toEqual([])
    expect(await store.finishOperation('operation', runId!, 'completed')).toBe(false)
  })

  it('marks an interrupted run after restart without replaying it or duplicating the warning', async () => {
    const root = makeRoot()
    const store = new PiV4JsonlSessionStore({ root })
    await store.create({
      conversation: conversation('interrupted', [message('user-1', 'user', '执行工具', 1)]),
      createdBy: 'test',
    })
    const runId = await store.beginOperation('interrupted', 'scheduler')
    expect(runId).toBeTruthy()

    const restarted = new PiV4JsonlSessionStore({ root })
    expect(await restarted.recoverInterruptedOperation('interrupted')).toBe(true)
    expect(await restarted.recoverInterruptedOperation('interrupted')).toBe(false)
    const projected = await restarted.project('interrupted')
    expect(projected?.messages.map((item) => item.id)).toEqual([
      'user-1',
      `runtime-interrupted-${runId}`,
    ])
    expect(projected?.messages[1]).toMatchObject({
      messageKind: 'incomplete',
      messageSubtype: 'runtime-interrupted',
    })
    const opened = await openRawSession(root)
    expect(await opened.session.findOpenOperations('main')).toEqual([])
  })

  it('repairs only a torn final line and preserves every acknowledged event', async () => {
    const root = makeRoot()
    const store = new PiV4JsonlSessionStore({ root })
    await store.create({
      conversation: conversation('torn-tail', [message('m-1', 'user', '保留', 1)]),
      createdBy: 'test',
    })
    const file = findJsonl(root)
    const acknowledged = fs.readFileSync(file, 'utf8')
    fs.appendFileSync(file, '{"kind":"entry"', 'utf8')

    const projected = await new PiV4JsonlSessionStore({ root }).project('torn-tail')
    expect(projected?.messages.map((item) => item.id)).toEqual(['m-1'])
    const repaired = fs.readFileSync(file, 'utf8')
    expect(repaired.endsWith('\n')).toBe(true)
    expect(repaired).toBe(acknowledged)
    expect(() => repaired.trimEnd().split('\n').forEach((line) => JSON.parse(line))).not.toThrow()
  })

  it('fails loudly for corruption in the middle of an acknowledged log', async () => {
    const root = makeRoot()
    const store = new PiV4JsonlSessionStore({ root })
    await store.create({
      conversation: conversation('middle-corruption', [
        message('m-1', 'user', '一', 1),
        message('m-2', 'assistant', '二', 2),
      ]),
      createdBy: 'test',
    })
    const file = findJsonl(root)
    const lines = fs.readFileSync(file, 'utf8').trimEnd().split('\n')
    lines[2] = '{not-valid-json'
    fs.writeFileSync(file, `${lines.join('\n')}\n`, 'utf8')

    await expect(new PiV4JsonlSessionStore({ root }).project('middle-corruption'))
      .rejects.toThrow(/line 3|Invalid|decode|session/i)
  })

  it('isolates one corrupt conversation without hiding healthy sessions from the list', async () => {
    const root = makeRoot()
    const store = new PiV4JsonlSessionStore({ root })
    await store.create({
      conversation: conversation('healthy', [message('healthy-1', 'user', '保留', 1)]),
      createdBy: 'test',
    })
    await store.create({
      conversation: conversation('damaged', [
        message('damaged-1', 'user', '一', 1),
        message('damaged-2', 'assistant', '二', 2),
      ]),
      createdBy: 'test',
    })

    const damagedFile = findJsonlForConversation(root, 'damaged')
    const lines = fs.readFileSync(damagedFile, 'utf8').trimEnd().split('\n')
    lines[2] = '{not-valid-json'
    fs.writeFileSync(damagedFile, `${lines.join('\n')}\n`, 'utf8')

    const restarted = new PiV4JsonlSessionStore({ root })
    await expect(restarted.list()).resolves.toMatchObject([{ id: 'healthy' }])
    await expect(restarted.project('damaged')).rejects.toThrow(/line 3|Invalid|decode|session/i)
    await expect(restarted.project('healthy')).resolves.toMatchObject({ id: 'healthy' })
  })

  it('keeps product changes off the model branch and supports explicit field clearing', async () => {
    const root = makeRoot()
    const store = new PiV4JsonlSessionStore({ root })
    await store.create({ conversation: conversation('product'), createdBy: 'test' })
    await store.updateProduct('product', {
      title: '新标题',
      agentId: undefined,
      workspaceId: undefined,
      config: { projectName: '项目乙' },
    })

    const projected = await store.project('product')
    expect(projected).toMatchObject({ title: '新标题', config: { projectName: '项目乙' } })
    expect(projected?.agentId).toBeUndefined()
    expect(projected?.workspaceId).toBeUndefined()
    const summaries = await store.list()
    expect(summaries).toHaveLength(1)
    expect(summaries[0]).toMatchObject({ id: 'product', title: '新标题', messageCount: 0 })
  })

  it('uses an owner-only rebuildable sidebar index without making it authoritative', async () => {
    const root = makeRoot()
    const store = new PiV4JsonlSessionStore({ root })
    await store.create({
      conversation: conversation('indexed', [message('m-1', 'user', '索引摘要', 1)]),
      createdBy: 'test',
    })
    const indexPath = path.join(root, 'session-index.json')
    expect(fs.statSync(indexPath).mode & 0o777).toBe(0o600)
    expect(JSON.parse(fs.readFileSync(indexPath, 'utf8')).entries[0].summary)
      .toMatchObject({ id: 'indexed', messageCount: 1, lastMessage: '索引摘要' })

    fs.writeFileSync(indexPath, '{broken-index', 'utf8')
    const rebuilt = await new PiV4JsonlSessionStore({ root }).list()
    expect(rebuilt).toHaveLength(1)
    expect(() => JSON.parse(fs.readFileSync(indexPath, 'utf8'))).not.toThrow()

    fs.rmSync(indexPath)
    expect(await new PiV4JsonlSessionStore({ root }).list())
      .toMatchObject([{ id: 'indexed', messageCount: 1 }])
    expect(fs.existsSync(indexPath)).toBe(true)
  })

  it('does not damage an existing session when duplicate create is rejected', async () => {
    const root = makeRoot()
    const store = new PiV4JsonlSessionStore({ root })
    await store.create({
      conversation: conversation('duplicate', [message('m-1', 'user', '原内容', 1)]),
      createdBy: 'test',
    })
    await expect(store.create({ conversation: conversation('duplicate'), createdBy: 'test' }))
      .rejects.toThrow(/already exists|already_exists|exists/i)
    expect((await store.project('duplicate'))?.messages.map((item) => item.content))
      .toEqual(['原内容'])
  })

  it('deletes only the selected JSONL session', async () => {
    const root = makeRoot()
    const store = new PiV4JsonlSessionStore({ root })
    await store.create({ conversation: conversation('delete-me'), createdBy: 'test' })
    await expect(store.delete('delete-me')).resolves.toBe(true)
    await expect(store.project('delete-me')).resolves.toBeNull()
    await expect(store.delete('delete-me')).resolves.toBe(false)
  })
})

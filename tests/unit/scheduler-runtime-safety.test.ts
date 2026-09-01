import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  tasks: new Map<string, any>(),
  agentTemplates: new Map<string, any>(),
  workspaces: new Map<string, any>(),
  conversations: new Map<string, any>(),
  histories: new Map<string, any[]>(),
  serializedReads: [] as string[],
  appendCalls: [] as Array<{ id: string; messages: any[] }>,
  deleteCalls: [] as string[],
  records: [] as Array<{ id: string; result: any; nextRun?: number }>,
  agentCalls: [] as Array<{ messages: any[]; signal?: AbortSignal; source?: string; overrides?: any }>,
  agentChat: undefined as any,
  nextConversationId: 'new-conversation'
}))

vi.mock('electron', () => ({ BrowserWindow: class BrowserWindow {} }))

vi.mock('../../src/main/task-store', () => ({
  listTasks: () => [],
  getTask: (id: string) => state.tasks.get(id) ?? null,
  updateTask: (id: string, updates: Record<string, unknown>) => {
    const task = state.tasks.get(id)
    if (!task) return null
    const updated = { ...task, ...updates }
    state.tasks.set(id, updated)
    return updated
  },
  recordTaskExecution: (id: string, result: any, nextRun?: number) => {
    state.records.push({ id, result, nextRun })
    const task = state.tasks.get(id)
    if (task) state.tasks.set(id, { ...task, lastResult: result, lastRun: result.timestamp, nextRun })
  },
  migrateLegacyTasks: () => undefined
}))

vi.mock('../../src/main/agent-runtime', () => ({
  getAgentRuntime: async () => ({
    agentChat: (messages: any[], signal?: AbortSignal, source?: string, overrides?: any) => {
      state.agentCalls.push({ messages, signal, source, overrides })
      return state.agentChat(messages, signal, source, overrides)
    }
  })
}))

vi.mock('../../src/main/agent-template-manager', () => ({
  getAgentTemplate: (id: string) => state.agentTemplates.get(id) ?? null
}))

vi.mock('../../src/main/conversation-store', () => ({
  createConversation: (role: string, title: string, agentId?: string, workspaceId?: string) => {
    const conversation = {
      id: state.nextConversationId,
      title,
      role,
      agentId,
      workspaceId,
      config: {},
      createdAt: Date.now(),
      updatedAt: Date.now(),
      messages: []
    }
    state.conversations.set(conversation.id, conversation)
    return conversation
  },
  deleteConversation: async (id: string) => {
    state.deleteCalls.push(id)
    state.conversations.delete(id)
    state.histories.delete(id)
    return true
  },
  getConversation: (id: string) => state.conversations.get(id) ?? null,
  getConversationMessagesSerialized: async (id: string) => {
    state.serializedReads.push(id)
    return state.histories.get(id) ?? []
  },
  shouldReplayStoredMessage: (message: any) => message.messageKind !== 'permission_request',
  appendMessages: async (id: string, messages: any[]) => {
    state.appendCalls.push({ id, messages })
    state.histories.set(id, [...(state.histories.get(id) ?? []), ...messages])
    return true
  }
}))


vi.mock('../../src/main/agent-workspace-store', () => ({
  getWorkspace: (id: string) => state.workspaces.get(id) ?? null,
  readAllWorkspaceTriggers: () => [],
  clearWorkspaceTriggers: () => undefined
}))

vi.mock('../../src/main/role-manager', () => ({
  getCurrentRole: () => ({ name: 'learner' }),
  getRoleConfig: (name: string) => ({ name })
}))

const scheduler = await import('../../src/main/scheduler')
const { acquireConversationExecution } = await import('../../src/main/conversation-execution-coordinator')

function task(overrides: Record<string, unknown> = {}): any {
  return {
    id: 'task-1',
    name: 'runtime safety',
    enabled: true,
    trigger: { type: 'webhook' },
    prompt: '执行下一轮',
    conversationMode: 'persistent',
    boundConversationId: 'conversation-1',
    smartSilence: false,
    createdAt: 1,
    updatedAt: 1,
    ...overrides
  }
}

async function waitForRunningSignal(): Promise<AbortSignal> {
  await vi.waitFor(() => expect(state.agentCalls).toHaveLength(1))
  const signal = state.agentCalls[0].signal
  if (!signal) throw new Error('scheduler did not pass an AbortSignal')
  return signal
}

beforeEach(() => {
  state.tasks.clear()
  state.agentTemplates.clear()
  state.workspaces.clear()
  state.conversations.clear()
  state.conversations.set('conversation-1', {
    id: 'conversation-1',
    title: 'runtime safety',
    role: 'learner',
    config: {},
    createdAt: 1,
    updatedAt: 1,
    messages: []
  })
  state.histories.clear()
  state.serializedReads = []
  state.appendCalls = []
  state.deleteCalls = []
  state.records = []
  state.agentCalls = []
  state.nextConversationId = 'new-conversation'
  state.agentChat = async function* () {}
  scheduler.initScheduler()
})

afterEach(() => {
  scheduler.shutdownScheduler()
})

describe('scheduler Runtime safety', () => {
  it('fails closed before Agent Runtime when a persisted task binding is missing', async () => {
    state.tasks.set('task-1', task())
    state.conversations.delete('conversation-1')
    state.agentChat = async function* () {
      yield { type: 'text', content: 'must not run' }
    }

    await scheduler.executeTask('task-1')

    expect(state.agentCalls).toHaveLength(0)
    expect(state.serializedReads).toHaveLength(0)
    expect(state.appendCalls).toHaveLength(0)
    expect(state.records[0].result).toMatchObject({
      status: 'error',
      message: '任务绑定的会话 conversation-1 不存在，已停止执行'
    })
  })

  it('re-checks a persisted binding after waiting for the conversation lease', async () => {
    state.tasks.set('task-1', task())
    state.agentChat = async function* () {
      yield { type: 'text', content: 'must not run' }
    }
    const http = await acquireConversationExecution({
      conversationId: 'conversation-1',
      owner: { entrypoint: 'http', ownerId: 'acp' },
      policy: 'reject'
    })

    const pending = scheduler.executeTask('task-1')
    await Promise.resolve()
    await Promise.resolve()
    state.conversations.delete('conversation-1')
    http.release()
    await pending

    expect(state.agentCalls).toHaveLength(0)
    expect(state.serializedReads).toHaveLength(0)
    expect(state.records[0].result).toMatchObject({
      status: 'error',
      message: '任务绑定的会话 conversation-1 不存在，已停止执行'
    })
  })

  it('inherits persisted conversation Runtime settings before adding scheduler silence guidance', async () => {
    const goal = { text: '完成发布说明', status: 'active', turnsUsed: 1, maxTurns: 4, consecutiveBlocks: 0 }
    const roleBrief = { general: { taskType: '发布说明' } }
    state.tasks.set('task-1', task({ smartSilence: true }))
    state.conversations.set('conversation-1', {
      ...state.conversations.get('conversation-1'),
      config: {
        modelPresetId: 'preset-deepseek',
        workingDir: '/tmp/scheduler-project',
        thinkingEnabled: true,
        thinkingLevel: 'high',
        roleBrief,
        goal
      }
    })
    state.agentChat = async function* () {
      yield { type: 'text', content: '任务完成' }
    }

    await scheduler.executeTask('task-1')

    expect(state.agentCalls).toHaveLength(1)
    expect(state.agentCalls[0].overrides).toMatchObject({
      conversationId: 'conversation-1',
      modelPresetId: 'preset-deepseek',
      workingDir: '/tmp/scheduler-project',
      thinkingEnabled: true,
      thinkingLevel: 'high',
      roleBrief,
      goal
    })
    expect(state.agentCalls[0].overrides.systemPrompt).toContain('智能免打扰')
  })

  it('keeps an Agent template explicit working directory ahead of conversation config', async () => {
    const roleBrief = { general: { taskType: 'agent task' } }
    const goal = { text: 'finish agent task', status: 'active', turnsUsed: 0, maxTurns: 3, consecutiveBlocks: 0 }
    state.agentTemplates.set('agent-1', {
      systemPrompt: 'Agent template prompt',
      tools: ['read', 'write'],
      workingDir: '/agent/template'
    })
    state.tasks.set('task-1', task({ agentId: 'agent-1' }))
    state.conversations.set('conversation-1', {
      ...state.conversations.get('conversation-1'),
      config: {
        workingDir: '/conversation/config',
        modelPresetId: 'agent-conversation-preset',
        thinkingEnabled: false,
        thinkingLevel: 'medium',
        roleBrief,
        goal
      }
    })
    state.agentChat = async function* () {
      yield { type: 'text', content: '任务完成' }
    }

    await scheduler.executeTask('task-1')

    expect(state.agentCalls[0].overrides).toMatchObject({
      workingDir: '/agent/template',
      tools: ['read', 'write'],
      modelPresetId: 'agent-conversation-preset',
      thinkingEnabled: false,
      thinkingLevel: 'medium',
      roleBrief,
      goal
    })
  })

  it('lets an explicit conversation working directory win over the workspace default', async () => {
    state.workspaces.set('workspace-1', {
      id: 'workspace-1',
      agentMd: 'Workspace prompt',
      memories: []
    })
    state.tasks.set('task-1', task({ workspaceId: 'workspace-1' }))
    state.conversations.set('conversation-1', {
      ...state.conversations.get('conversation-1'),
      config: { workingDir: '/conversation/config' }
    })
    state.agentChat = async function* () {
      yield { type: 'text', content: '任务完成' }
    }

    await scheduler.executeTask('task-1')

    expect(state.agentCalls[0].overrides).toMatchObject({
      workspaceId: 'workspace-1',
      systemPrompt: 'Workspace prompt'
    })
    // 会话级选择优先于模板默认，与 goal/projectName 同一口径。旧契约是这里留空、
    // 由 Runtime 回落 tools/config.json，代价是用户在目录条上选的目录、以及 Zed 经 ACP
    // 传进来的仓库 cwd，对自定义 Agent 会话一律静默失效。
    expect(state.agentCalls[0].overrides.workingDir).toBe('/conversation/config')
  })

  it('still falls back to the workspace default when the conversation picked no directory', async () => {
    state.workspaces.set('workspace-1', {
      id: 'workspace-1',
      agentMd: 'Workspace prompt',
      memories: []
    })
    state.tasks.set('task-1', task({ workspaceId: 'workspace-1' }))
    state.conversations.set('conversation-1', {
      ...state.conversations.get('conversation-1'),
      config: {}
    })
    state.agentChat = async function* () {
      yield { type: 'text', content: '任务完成' }
    }

    await scheduler.executeTask('task-1')

    // 没显式选目录就保持原样——自定义 Agent「自带一块地」的语义不变，
    // Runtime 继续按 tools/config.json → 全局工作区回落。
    expect(state.agentCalls[0].overrides.workingDir).toBeUndefined()
  })

  it('identifies background turns as scheduler Runtime traffic', async () => {
    state.tasks.set('task-1', task())
    state.agentChat = async function* () {
      yield { type: 'text', content: '任务完成' }
    }

    await scheduler.executeTask('task-1')

    expect(state.agentCalls).toHaveLength(1)
    expect(state.agentCalls[0].source).toBe('scheduler')
  })

  it('waits behind an HTTP owner of the same conversation through the shared process coordinator', async () => {
    state.tasks.set('task-1', task())
    state.agentChat = async function* () {
      yield { type: 'text', content: '任务完成' }
    }
    const http = await acquireConversationExecution({
      conversationId: 'conversation-1',
      owner: { entrypoint: 'http', ownerId: 'acp' },
      policy: 'reject'
    })

    const pending = scheduler.executeTask('task-1')
    await Promise.resolve()
    await Promise.resolve()
    expect(state.agentCalls).toHaveLength(0)

    http.release()
    await pending
    expect(state.agentCalls).toHaveLength(1)
    expect(state.records[0]?.result.status).toBe('success')
  })

  it('records AgentEvent.error as an error instead of a successful empty response', async () => {
    state.tasks.set('task-1', task())
    state.agentChat = async function* () {
      yield { type: 'error', content: 'provider exploded' }
    }

    await scheduler.executeTask('task-1')

    expect(state.records).toHaveLength(1)
    expect(state.records[0].result).toMatchObject({
      status: 'error',
      message: 'provider exploded'
    })
    expect(state.records[0].result.message).not.toBe('(无响应)')
    expect(state.appendCalls).toHaveLength(0)
  })

  it('fails closed when the Runtime returns neither text nor a persisted tool result', async () => {
    state.tasks.set('task-1', task())
    state.agentChat = async function* () {
      yield* []
    }

    await scheduler.executeTask('task-1')

    expect(state.records).toHaveLength(1)
    expect(state.records[0].result).toMatchObject({
      status: 'error',
      message: 'Agent Runtime 未返回文本或工具结果'
    })
    expect(state.appendCalls).toHaveLength(0)
  })

  it('rebuilds a persistent turn from serialized conversation history and appends only the new turn', async () => {
    state.tasks.set('task-1', task())
    state.histories.set('conversation-1', [
      { id: 'u1', role: 'user', content: '上一轮问题' },
      { id: 'a1', role: 'assistant', content: '上一轮回答' },
      { id: 't1', role: 'tool', content: '已读取', toolName: 'read', toolCallId: 'call-1', toolArgs: '{"path":"a.ts"}' },
      { id: 'p1', role: 'assistant', content: '请求权限', messageKind: 'permission_request' }
    ])
    state.agentChat = async function* () {
      yield { type: 'text', content: '本轮完成' }
    }

    await scheduler.executeTask('task-1')

    expect(state.serializedReads).toEqual(['conversation-1'])
    expect(state.agentCalls[0].messages).toEqual([
      expect.objectContaining({ id: 'u1', role: 'user', content: '上一轮问题' }),
      expect.objectContaining({ id: 'a1', role: 'assistant', content: '上一轮回答' }),
      expect.objectContaining({
        id: 't1', role: 'tool', content: '已读取', toolName: 'read',
        toolCallId: 'call-1', toolArgs: '{"path":"a.ts"}'
      }),
      expect.objectContaining({ role: 'user', content: '执行下一轮' })
    ])
    expect(state.appendCalls).toHaveLength(1)
    expect(state.appendCalls[0].id).toBe('conversation-1')
    expect(state.appendCalls[0].messages).toHaveLength(2)
    expect(state.appendCalls[0].messages.map(message => message.content)).toEqual([
      '执行下一轮',
      '本轮完成'
    ])
  })

  it('preserves an existing persistent conversation and its binding when a later turn is silent', async () => {
    state.tasks.set('task-1', task({ smartSilence: true }))
    const existingHistory = [
      { id: 'u1', role: 'user', content: '已有问题' },
      { id: 'a1', role: 'assistant', content: '已有回答' }
    ]
    state.histories.set('conversation-1', existingHistory)
    state.agentChat = async function* () {
      yield { type: 'text', content: 'NO_REPLY: [scheduler] 例行检查无需打扰' }
    }

    await scheduler.executeTask('task-1')

    expect(state.deleteCalls).toEqual([])
    expect(state.tasks.get('task-1').boundConversationId).toBe('conversation-1')
    expect(state.histories.get('conversation-1')).toEqual(existingHistory)
    expect(state.appendCalls).toHaveLength(0)
    expect(state.records.at(-1)?.result).toMatchObject({
      status: 'success',
      message: '（静默） 例行检查无需打扰'
    })
  })

  it('deletes and unbinds only a persistent empty shell created by the silent turn', async () => {
    state.tasks.set('task-1', task({ boundConversationId: undefined, smartSilence: true }))
    state.agentChat = async function* () {
      yield { type: 'text', content: 'NO_REPLY: 首轮无需打扰' }
    }

    await scheduler.executeTask('task-1')

    expect(state.serializedReads).toEqual(['new-conversation'])
    expect(state.deleteCalls).toEqual(['new-conversation'])
    expect(state.tasks.get('task-1').boundConversationId).toBeUndefined()
    expect(state.appendCalls).toHaveLength(0)
  })

  it('persists interleaved assistant text and tool evidence in event order and replays it next turn', async () => {
    state.tasks.set('task-1', task())
    state.agentChat = async function* () {
      yield { type: 'text', content: '先读取文件' }
      yield { type: 'text_flush' }
      yield {
        type: 'tool_end',
        name: 'read',
        toolCallId: 'call-read',
        mcpResult: '读取完成',
        modelToolArgs: '{"path":"a.ts"}'
      }
      yield { type: 'text', content: '然后给出结论' }
    }

    await scheduler.executeTask('task-1')

    expect(state.appendCalls[0].messages.map(message => ({
      role: message.role,
      content: message.content,
      toolName: message.toolName,
      toolCallId: message.toolCallId,
      toolArgs: message.toolArgs
    }))).toEqual([
      expect.objectContaining({ role: 'user', content: '执行下一轮' }),
      expect.objectContaining({ role: 'assistant', content: '先读取文件' }),
      expect.objectContaining({
        role: 'tool', content: '读取完成', toolName: 'read',
        toolCallId: 'call-read', toolArgs: '{"path":"a.ts"}'
      }),
      expect.objectContaining({ role: 'assistant', content: '然后给出结论' })
    ])

    state.agentChat = async function* () {
      yield { type: 'text', content: '第二轮完成' }
    }
    await scheduler.executeTask('task-1')

    expect(state.agentCalls[1].messages).toEqual([
      expect.objectContaining({ role: 'user', content: '执行下一轮' }),
      expect.objectContaining({ role: 'assistant', content: '先读取文件' }),
      expect.objectContaining({
        role: 'tool', content: '读取完成', toolName: 'read',
        toolCallId: 'call-read', toolArgs: '{"path":"a.ts"}'
      }),
      expect.objectContaining({ role: 'assistant', content: '然后给出结论' }),
      expect.objectContaining({ role: 'user', content: '执行下一轮' })
    ])
  })

  it('落盘 runtime-context 快照，下一轮带着 messageKind 回放（跨回合前缀缓存的前提）', async () => {
    const snapshot = '\n\n<runtime-context>\n当前真实时间：2026年8月18日星期二 10:30。\n</runtime-context>'
    state.tasks.set('task-1', task())
    state.agentChat = async function* () {
      // 主进程在 turn 开跑时广播一次。桌面由渲染层接住落盘，定时任务没有渲染层——
      // 不在服务端自己落，磁盘上就永远没有这条快照，下一轮回放字节对不上、缓存从这里断
      yield { type: 'runtime_context', text: snapshot }
      yield { type: 'text', content: '第一轮完成' }
    }

    await scheduler.executeTask('task-1')

    expect(state.appendCalls[0].messages.map(message => ({
      role: message.role,
      content: message.content,
      messageKind: message.messageKind
    }))).toEqual([
      { role: 'user', content: '执行下一轮', messageKind: 'task-trigger' },
      // 紧跟触发消息，位置与渲染层 chatStore 一致
      { role: 'user', content: snapshot, messageKind: 'runtime-context' },
      { role: 'assistant', content: '第一轮完成', messageKind: undefined }
    ])

    state.agentChat = async function* () {
      yield { type: 'text', content: '第二轮完成' }
    }
    await scheduler.executeTask('task-1')

    // 投影必须把 messageKind 带过缝，pi-message-conversion 才认得出这是快照、原样回放
    expect(state.agentCalls[1].messages[1]).toMatchObject({
      role: 'user', content: snapshot, messageKind: 'runtime-context'
    })
  })

  it('persists and replays a tool-only scheduled turn even when assistant text is empty', async () => {
    state.tasks.set('task-1', task())
    state.agentChat = async function* () {
      yield {
        type: 'tool_end',
        name: 'write',
        toolCallId: 'call-write',
        mcpResult: '已创建报告',
        mcpArgs: '{"path":"report.md"}'
      }
    }

    await scheduler.executeTask('task-1')

    expect(state.records[0].result).toMatchObject({
      status: 'success',
      message: '[仅工具结果] write: 已创建报告'
    })
    expect(state.appendCalls[0].messages).toEqual([
      expect.objectContaining({ role: 'user', content: '执行下一轮', messageKind: 'task-trigger' }),
      expect.objectContaining({
        role: 'tool', content: '已创建报告', toolName: 'write',
        toolCallId: 'call-write', toolArgs: '{"path":"report.md"}'
      })
    ])

    state.agentChat = async function* () {
      yield { type: 'text', content: '看到了上一轮工具结果' }
    }
    await scheduler.executeTask('task-1')
    expect(state.agentCalls[1].messages).toEqual([
      expect.objectContaining({ role: 'user', content: '执行下一轮' }),
      expect.objectContaining({
        role: 'tool', content: '已创建报告', toolName: 'write',
        toolCallId: 'call-write', toolArgs: '{"path":"report.md"}'
      }),
      expect.objectContaining({ role: 'user', content: '执行下一轮' })
    ])
  })

  it('serializes two different tasks bound to the same persistent conversation', async () => {
    state.tasks.set('task-1', task({ id: 'task-1', name: 'first', prompt: '第一轮' }))
    state.tasks.set('task-2', task({ id: 'task-2', name: 'second', prompt: '第二轮' }))

    let releaseFirst!: () => void
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve })
    let active = 0
    let maxActive = 0
    let invocation = 0
    state.agentChat = async function* () {
      invocation++
      active++
      maxActive = Math.max(maxActive, active)
      try {
        if (invocation === 1) await firstGate
        yield { type: 'text', content: `完成 ${invocation}` }
      } finally {
        active--
      }
    }

    const first = scheduler.executeTask('task-1')
    await vi.waitFor(() => expect(state.agentCalls).toHaveLength(1))
    const second = scheduler.executeTask('task-2')
    await Promise.resolve()
    await Promise.resolve()
    expect(state.agentCalls).toHaveLength(1)

    releaseFirst()
    await Promise.all([first, second])

    expect(maxActive).toBe(1)
    expect(state.agentCalls).toHaveLength(2)
    expect(state.agentCalls[1].messages).toEqual([
      expect.objectContaining({ role: 'user', content: '第一轮' }),
      expect.objectContaining({ role: 'assistant', content: '完成 1' }),
      expect.objectContaining({ role: 'user', content: '第二轮' })
    ])
    expect(state.records.map(record => record.id)).toEqual(['task-1', 'task-2'])
  })

  it('can abort a task while it is waiting for the shared conversation lock', async () => {
    state.tasks.set('task-1', task({ id: 'task-1', name: 'holder' }))
    state.tasks.set('task-2', task({ id: 'task-2', name: 'waiter' }))
    state.agentChat = async function* (_messages: any[], signal: AbortSignal) {
      await new Promise<void>((resolve) => {
        if (signal.aborted) resolve()
        else signal.addEventListener('abort', () => resolve(), { once: true })
      })
      yield* []
    }

    const holder = scheduler.executeTask('task-1')
    await vi.waitFor(() => expect(state.agentCalls).toHaveLength(1))
    const waiter = scheduler.executeTask('task-2')
    await Promise.resolve()
    expect(state.agentCalls).toHaveLength(1)

    state.tasks.set('task-2', { ...state.tasks.get('task-2'), enabled: false })
    scheduler.unscheduleTask('task-2')
    await waiter

    expect(state.agentCalls).toHaveLength(1)
    expect(state.records.find(record => record.id === 'task-2')?.result).toMatchObject({
      status: 'error',
      message: '任务已禁用或删除，执行已取消'
    })

    scheduler.shutdownScheduler()
    await holder
  })

  it('aborts the matching running task through the existing disable/delete unschedule path', async () => {
    state.tasks.set('task-1', task({
      trigger: { type: 'schedule', schedule: { type: 'interval', intervalMs: 60_000 } },
      nextRun: Date.now() + 60_000
    }))
    state.agentChat = async function* (_messages: any[], signal: AbortSignal) {
      await new Promise<void>((resolve) => {
        if (signal.aborted) resolve()
        else signal.addEventListener('abort', () => resolve(), { once: true })
      })
      if (!signal.aborted) yield { type: 'text', content: '' }
    }

    const pending = scheduler.executeTask('task-1')
    const signal = await waitForRunningSignal()
    state.tasks.set('task-1', { ...state.tasks.get('task-1'), enabled: false })
    scheduler.unscheduleTask('task-1')
    await pending

    expect(signal.aborted).toBe(true)
    expect(state.records.at(-1)?.result).toMatchObject({
      status: 'error',
      message: '任务已禁用或删除，执行已取消'
    })
    expect(state.records.at(-1)?.nextRun).toBeUndefined()
  })

  it('does not restore a next run after a scheduled task is deleted while running', async () => {
    state.tasks.set('task-1', task({
      trigger: { type: 'schedule', schedule: { type: 'interval', intervalMs: 60_000 } },
      nextRun: Date.now() + 60_000
    }))
    state.agentChat = async function* (_messages: any[], signal: AbortSignal) {
      await new Promise<void>((resolve) => {
        if (signal.aborted) resolve()
        else signal.addEventListener('abort', () => resolve(), { once: true })
      })
      yield* []
    }

    const pending = scheduler.executeTask('task-1')
    await waitForRunningSignal()
    state.tasks.delete('task-1')
    scheduler.unscheduleTask('task-1')
    await pending

    expect(state.tasks.has('task-1')).toBe(false)
    expect(state.records.at(-1)?.result).toMatchObject({
      status: 'error',
      message: '任务已禁用或删除，执行已取消'
    })
    expect(state.records.at(-1)?.nextRun).toBeUndefined()
  })

  it('uses a schedule edited during execution when recording the next run', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-08T00:00:00.000Z'))
    try {
      state.tasks.set('task-1', task({
        trigger: { type: 'schedule', schedule: { type: 'interval', intervalMs: 3_600_000 } },
        nextRun: Date.now() + 3_600_000
      }))
      let release!: () => void
      const gate = new Promise<void>((resolve) => { release = resolve })
      state.agentChat = async function* () {
        await gate
        yield { type: 'text', content: 'scheduled' }
      }

      const pending = scheduler.executeTask('task-1')
      await waitForRunningSignal()
      state.tasks.set('task-1', {
        ...state.tasks.get('task-1'),
        trigger: { type: 'schedule', schedule: { type: 'interval', intervalMs: 60_000 } },
        updatedAt: Date.now()
      })
      scheduler.rescheduleTask('task-1')
      release()
      await pending

      expect(state.tasks.get('task-1').trigger.schedule.intervalMs).toBe(60_000)
      expect(state.records.at(-1)?.nextRun).toBe(Date.now() + 60_000)
      expect(state.records.at(-1)?.nextRun).not.toBe(Date.now() + 3_600_000)
    } finally {
      scheduler.shutdownScheduler()
      vi.useRealTimers()
    }
  })

  it('aborts every running task during scheduler shutdown', async () => {
    state.tasks.set('task-1', task())
    state.agentChat = async function* (_messages: any[], signal: AbortSignal) {
      await new Promise<void>((resolve) => {
        if (signal.aborted) resolve()
        else signal.addEventListener('abort', () => resolve(), { once: true })
      })
      if (!signal.aborted) yield { type: 'text', content: '' }
    }

    const pending = scheduler.executeTask('task-1')
    const signal = await waitForRunningSignal()
    scheduler.shutdownScheduler()
    await pending

    expect(signal.aborted).toBe(true)
    expect(state.records.at(-1)?.result).toMatchObject({
      status: 'error',
      message: '调度器已关闭，任务执行已取消'
    })
  })

  it('keeps the newly rescheduled timer cancellable after the prior timer fires', async () => {
    vi.useFakeTimers()
    try {
      state.tasks.set('task-1', task({
        trigger: { type: 'schedule', schedule: { type: 'interval', intervalMs: 1000 } },
        nextRun: Date.now() + 1000
      }))
      state.agentChat = async function* () {
        yield { type: 'text', content: 'scheduled' }
      }

      scheduler.scheduleTask(state.tasks.get('task-1'))
      await vi.advanceTimersByTimeAsync(1000)
      expect(state.agentCalls).toHaveLength(1)

      scheduler.unscheduleTask('task-1')
      await vi.advanceTimersByTimeAsync(2000)
      expect(state.agentCalls).toHaveLength(1)
    } finally {
      vi.useRealTimers()
    }
  })
})

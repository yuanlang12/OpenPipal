import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall
} from '@earendil-works/pi-ai'
import { Agent } from '@earendil-works/pi-agent-core'
import { Type } from 'typebox'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { PiEventAdapter } from '../../src/main/pi-event-adapter'

const state = vi.hoisted(() => ({
  model: undefined as any,
  models: undefined as any,
  usageRecords: [] as any[],
  measured: [] as any[],
  tools: [] as any[],
  currentRole: 'general',
  promptRoleNames: [] as Array<string | undefined>,
  toolRoleNames: [] as Array<string | undefined>,
  sessionStreamConfigs: [] as any[],
  modelFactoryOptions: [] as any[],
  loadSkills: async () => ({ skills: [], promptSection: '' }),
  goalResults: [] as any[],
  compact: undefined as any
}))

vi.mock('../../src/main/agent-overrides', () => ({
  resolveExecutionRoleName: (overrides?: { roleName?: string }) => (
    overrides?.roleName || state.currentRole
  )
}))

vi.mock('../../src/main/config-manager', () => ({
  adaptModelRequestPayload: (payload: unknown) => payload,
  buildModelFromConfig: () => state.model,
  // 工具授权会经 assessToolScope 落到 getWorkingDir()。少了它，授权路径抛
  // TypeError、被 catch 成"安全阻止"，现象是所有工具静默不执行。
  getWorkingDir: () => '/tmp',
  resolveAuxThinkingLevel: () => 'off',
  resolveConversationModelConfig: () => ({
    source: 'global',
    config: {
      provider: 'faux',
      baseUrl: 'http://localhost:0',
      apiKey: 'test',
      model: 'faux-1',
      supportsThinking: false
    }
  }),
  supportsEffortDial: () => false,
  withSessionStreamOptions: (stream: unknown, config: unknown) => {
    state.sessionStreamConfigs.push(config)
    return stream
  }
}))

vi.mock('../../src/main/agent-runtime/pi-core-models', () => ({
  createOpenPipalPiCoreModels: (_model: unknown, _config: unknown, options?: unknown) => {
    state.modelFactoryOptions.push(options)
    return state.models
  }
}))

vi.mock('../../src/main/agent-runtime/pi-core-tool-bridge', () => ({
  buildPiCoreAgentTools: (options: any) => {
    state.toolRoleNames.push(options.overrides?.roleName)
    return {
    tools: state.tools,
    toolContext: {},
    askUserResolver: {},
    dispose: async () => {}
    }
  }
}))

vi.mock('../../src/main/goal-checker', () => ({
  buildContinuationHint: () => 'goal continuation',
  checkGoal: async (options: any) => {
    const result = state.goalResults.shift()
    return typeof result === 'function'
      ? result(options)
      : (result ?? { ok: true, reason: 'done' })
  }
}))

vi.mock('../../src/main/agent-runtime/openpipal-prompt-core', () => ({
  buildOpenPipalRuntimeContext: () => '',
  prepareOpenPipalSystemPrompt: (_source: unknown, overrides?: { roleName?: string }) => {
    state.promptRoleNames.push(overrides?.roleName)
    return {
      skillContext: { roleName: overrides?.roleName },
      render: () => 'system'
    }
  },
  resolveOpenPipalWorkingDirectory: () => ({ workingDir: '/tmp', disabledTools: [] })
}))

vi.mock('../../src/main/agent-runtime/pi-core-skills', () => ({
  loadPiCoreSkillCatalog: () => state.loadSkills()
}))

vi.mock('../../src/main/history-compactor', () => ({
  compactHistoryForModel: (...args: any[]) => state.compact(...args),
  getContextBudget: () => ({ contextWindow: 128_000, budget: 100_000 }),
  recordMeasuredPromptTokens: (...args: unknown[]) => state.measured.push(args)
}))

vi.mock('../../src/main/usage-log', () => ({
  appendUsageRecord: (record: unknown) => state.usageRecords.push(record)
}))

vi.mock('../../src/main/prompt-cache-fifo', () => ({
  resolveCacheRetentionForModel: () => undefined
}))

import { createPiCoreAgentRuntime } from '../../src/main/agent-runtime/pi-core-runtime'

async function collect(generator: AsyncGenerator<any>): Promise<any[]> {
  const events: any[] = []
  for await (const event of generator) events.push(event)
  return events
}

function expectInvalidHandleState(call: () => unknown): void {
  let thrown: unknown
  try {
    call()
  } catch (error) {
    thrown = error
  }
  expect(thrown).toMatchObject({ code: 'invalid_state' })
}

describe('pi-core Runtime lifecycle', () => {
  let faux: ReturnType<typeof fauxProvider>

  beforeEach(() => {
    faux = fauxProvider()
    const models = createModels()
    models.setProvider(faux.provider)
    state.model = faux.getModel()
    state.models = models
    state.usageRecords = []
    state.measured = []
    state.tools = []
    state.currentRole = 'general'
    state.promptRoleNames = []
    state.toolRoleNames = []
    state.sessionStreamConfigs = []
    state.modelFactoryOptions = []
    state.loadSkills = async () => ({ skills: [], promptSection: '' })
    state.goalResults = []
    state.compact = async (history: unknown[]) => history
  })

  it('pins one role before async skill loading when overrides are absent', async () => {
    let releaseSkills!: () => void
    state.currentRole = 'design'
    state.loadSkills = () => new Promise((resolve) => {
      releaseSkills = () => resolve({ skills: [], promptSection: '' })
    })
    faux.setResponses([fauxAssistantMessage('role-pinned')])

    const collecting = collect(createPiCoreAgentRuntime().agentChat(
      [{ role: 'user', content: 'hello' }],
      undefined,
      'desktop'
    ))
    await vi.waitFor(() => expect(state.promptRoleNames).toEqual(['design']))

    state.currentRole = 'teacher'
    releaseSkills()
    await collecting

    expect(state.toolRoleNames).toEqual(['design'])
  })

  it('wraps the public Models stream with the conversation-scoped request options', async () => {
    faux.setResponses([fauxAssistantMessage('wrapped')])

    await collect(createPiCoreAgentRuntime().agentChat(
      [{ role: 'user', content: 'hello' }],
      undefined,
      'desktop',
      { systemPrompt: 'system', conversationId: 'conv-request-options' }
    ))

    expect(state.sessionStreamConfigs).toEqual([
      expect.objectContaining({ apiKey: 'test', model: 'faux-1' })
    ])
  })

  it('records local stream boundaries through the pi-core Model adapter', async () => {
    const originalStreamSimple = state.models.streamSimple.bind(state.models)
    state.models.streamSimple = (...args: any[]) => {
      const observer = state.modelFactoryOptions.at(-1)?.onStreamBoundary
      observer?.('stream_fn_called', 1)
      observer?.('stream_opened', 1)
      observer?.('first_stream_next', 1)
      return originalStreamSimple(...args)
    }
    faux.setResponses([fauxAssistantMessage('observed boundary')])

    await collect(createPiCoreAgentRuntime().agentChat(
      [{ role: 'user', content: 'observe stream boundary' }],
      undefined,
      'desktop',
      { systemPrompt: 'system', conversationId: 'conv-stream-boundary' }
    ))

    const observation = state.usageRecords.filter((record: any) => record.kind === 'runtime_turn')
    expect(observation).toEqual(expect.arrayContaining([
      expect.objectContaining({ phase: 'stream_fn_called', streamAttempt: 1, firstModelEvent: false }),
      expect.objectContaining({ phase: 'stream_opened', streamAttempt: 1, firstModelEvent: false }),
      expect.objectContaining({ phase: 'first_stream_next', streamAttempt: 1, firstModelEvent: false })
    ]))
  })

  it('exposes one stable ready handle before output and accepts immediate steer', async () => {
    faux.setResponses([
      async (context) => {
        const sawSteer = JSON.stringify(context.messages).includes('second')
        return fauxAssistantMessage(sawSteer ? 'first-steered' : 'first-missed')
      }
    ])
    const order: string[] = []
    let readyHandle: any
    const events = await collect(createPiCoreAgentRuntime().agentChat(
      [{ role: 'user', content: 'hello' }],
      undefined,
      'desktop',
      { systemPrompt: 'system', conversationId: 'conv-ready' },
      (handle) => {
        order.push('ready')
        readyHandle = handle
        void handle.steer({ text: 'second' })
      }
    ))
    order.push(...events.filter((event) => event.type === 'text').map(() => 'text'))

    expect(order[0]).toBe('ready')
    expect(events.filter((event) => event.type === 'text').map((event) => event.content).join('')).toContain('first')
    expect(events.filter((event) => event.type === 'text').map((event) => event.content).join('')).toContain('steered')
    expect(readyHandle).toBeTruthy()
    expect(state.usageRecords.some((record) => record.kind === 'turn')).toBe(true)
  })

  it('delivers an active follow-up with images exactly once as a second Agent round', async () => {
    let readyHandle: any
    let secondContext = ''
    let providerCalls = 0
    faux.setResponses([
      async () => {
        providerCalls += 1
        await readyHandle.followUp({
          text: 'active follow-up',
          images: ['data:image/png;base64,active-image-payload']
        })
        return fauxAssistantMessage('first round')
      },
      async (context) => {
        providerCalls += 1
        secondContext = JSON.stringify(context.messages)
        return fauxAssistantMessage('second round')
      }
    ])

    const events = await collect(createPiCoreAgentRuntime().agentChat(
      [{ role: 'user', content: 'hello' }],
      undefined,
      'desktop',
      { systemPrompt: 'system', conversationId: 'conv-active-follow-up' },
      (handle) => { readyHandle = handle }
    ))

    expect(providerCalls).toBe(2)
    expect(secondContext.match(/active follow-up/g)).toHaveLength(1)
    expect(secondContext).toContain('active-image-payload')
    expect(events.filter((event) => event.type === 'text').map((event) => event.content).join('')).toContain('second round')
  })

  it('stops a sequential tool batch after questions and does not call the provider again', async () => {
    let questionsExecuted = 0
    let laterToolExecuted = 0
    let providerCalls = 0
    state.tools = [
      {
        name: 'questions_v2',
        label: 'questions_v2',
        description: 'ask one question',
        parameters: Type.Object({}),
        executionMode: 'sequential',
        async execute() {
          questionsExecuted += 1
          return {
            content: [{ type: 'text', text: 'waiting for answer' }],
            details: {
              questionsV2: {
                title: 'Choose',
                questions: [{ id: 'choice', kind: 'text-options', title: 'Pick one', options: ['A', 'B'] }]
              }
            }
          }
        }
      },
      {
        name: 'write',
        label: 'write',
        description: 'must not execute after a question',
        parameters: Type.Object({}),
        executionMode: 'sequential',
        async execute() {
          laterToolExecuted += 1
          return { content: [{ type: 'text', text: 'unexpected write' }], details: {} }
        }
      }
    ]
    faux.setResponses([
      async () => {
        providerCalls += 1
        return fauxAssistantMessage([
          fauxToolCall('questions_v2', {}, { id: 'call-question' }),
          fauxToolCall('write', {}, { id: 'call-after-question' })
        ], { stopReason: 'toolUse' })
      },
      async () => {
        providerCalls += 1
        return fauxAssistantMessage('must not continue')
      }
    ])

    const events = await collect(createPiCoreAgentRuntime().agentChat(
      [{ role: 'user', content: 'ask before writing' }],
      undefined,
      'desktop',
      { systemPrompt: 'system', conversationId: 'conv-question-batch' }
    ))

    expect(questionsExecuted).toBe(1)
    expect(laterToolExecuted).toBe(0)
    expect(providerCalls).toBe(1)
    expect(events.filter((event) => event.type === 'questions_v2')).toHaveLength(1)
    expect(events.filter((event) => event.type === 'text').map((event) => event.content).join(''))
      .not.toContain('must not continue')
  })

  it('atomically drains a tail-window input once and then closes the handle', async () => {
    let readyHandle: any
    let continuationContext = ''
    let providerCalls = 0
    let queuedTail = false
    faux.setResponses([
      async () => {
        providerCalls += 1
        return fauxAssistantMessage('initial complete')
      },
      async (context) => {
        providerCalls += 1
        continuationContext = JSON.stringify(context.messages)
        return fauxAssistantMessage('tail complete')
      }
    ])
    const originalSubscribe = Agent.prototype.subscribe
    const subscribeSpy = vi.spyOn(Agent.prototype, 'subscribe').mockImplementation(function (listener: any) {
      return originalSubscribe.call(this, (event: any, eventSignal?: AbortSignal) => {
        const result = listener(event, eventSignal)
        // Agent awaits agent_end listeners before prompt() settles, but its
        // low-level loop has already finished polling queues. This exercises
        // the exact final-listener tail window, not an ordinary active turn.
        if (event.type === 'agent_end' && !queuedTail) {
          queuedTail = true
          void readyHandle.steer({
            text: 'tail-window input',
            images: ['data:image/png;base64,tail-image-payload']
          })
        }
        return result
      })
    })

    try {
      await collect(createPiCoreAgentRuntime().agentChat(
        [{ role: 'user', content: 'start' }],
        undefined,
        'desktop',
        { systemPrompt: 'system', conversationId: 'conv-tail-window' },
        (handle) => { readyHandle = handle }
      ))
    } finally {
      subscribeSpy.mockRestore()
    }

    expect(queuedTail).toBe(true)
    expect(providerCalls).toBe(2)
    expect(continuationContext.match(/tail-window input/g)).toHaveLength(1)
    expect(continuationContext).toContain('tail-image-payload')
    expectInvalidHandleState(() => readyHandle.followUp({ text: 'too late' }))
  })

  it('maps a provider failure to exactly one product error', async () => {
    faux.setResponses([
      fauxAssistantMessage('', { stopReason: 'error', errorMessage: 'provider boom' })
    ])
    const events = await collect(createPiCoreAgentRuntime().agentChat(
      [{ role: 'user', content: 'fail' }],
      undefined,
      'desktop',
      { systemPrompt: 'system', conversationId: 'conv-error' }
    ))
    expect(events.filter((event) => event.type === 'error')).toEqual([
      { type: 'error', content: 'provider boom' }
    ])
  })

  it('fails closed with one product error when event adaptation throws', async () => {
    faux.setResponses([fauxAssistantMessage('must not be silently accepted')])
    const adapt = vi.spyOn(PiEventAdapter.prototype, 'adapt')
      .mockImplementationOnce(() => { throw new Error('adapter boom') })
    try {
      const events = await collect(createPiCoreAgentRuntime().agentChat(
        [{ role: 'user', content: 'map events' }],
        undefined,
        'desktop',
        { systemPrompt: 'system', conversationId: 'conv-adapter-error' }
      ))
      expect(events.filter((event) => event.type === 'error')).toEqual([
        { type: 'error', content: 'Agent 事件适配失败: adapter boom' }
      ])
    } finally {
      adapt.mockRestore()
    }
  })

  it('rebuilds every execution view from the latest OpenPipal history', async () => {
    const seenContexts: string[] = []
    faux.setResponses([
      async (context) => {
        seenContexts.push(JSON.stringify(context.messages))
        return fauxAssistantMessage('first')
      },
      async (context) => {
        seenContexts.push(JSON.stringify(context.messages))
        return fauxAssistantMessage('second')
      }
    ])
    const runtime = createPiCoreAgentRuntime()
    await collect(runtime.agentChat(
      [{ role: 'user', content: 'old text that was edited' }],
      undefined,
      'desktop',
      { systemPrompt: 'system', conversationId: 'same-conversation' }
    ))
    await collect(runtime.agentChat(
      [{ role: 'user', content: 'new edited text' }],
      undefined,
      'desktop',
      { systemPrompt: 'system', conversationId: 'same-conversation' }
    ))

    expect(seenContexts).toHaveLength(2)
    expect(seenContexts[1]).not.toContain('old text that was edited')
    expect(seenContexts[1].match(/new edited text/g)).toHaveLength(1)
  })

  it('settles a blocked provider on external abort without surfacing an error', async () => {
    faux.setResponses([
      async (_context, options) => new Promise((resolve) => {
        const finish = () => resolve(fauxAssistantMessage('', { stopReason: 'aborted' }))
        if (options?.signal?.aborted) finish()
        else options?.signal?.addEventListener('abort', finish, { once: true })
      })
    ])
    const controller = new AbortController()
    const collecting = collect(createPiCoreAgentRuntime().agentChat(
      [{ role: 'user', content: 'wait' }],
      controller.signal,
      'desktop',
      { systemPrompt: 'system', conversationId: 'conv-abort' }
    ))
    setTimeout(() => controller.abort(), 10)
    const events = await collecting
    expect(events.some((event) => event.type === 'error')).toBe(false)
    const observation = state.usageRecords.filter((record: any) => record.kind === 'runtime_turn')
    expect(observation).toEqual(expect.arrayContaining([
      expect.objectContaining({ phase: 'started', firstModelEvent: false }),
      expect.objectContaining({ phase: 'external_abort', firstModelEvent: false }),
      expect.objectContaining({ phase: 'settled', outcome: 'external_abort', firstModelEvent: false })
    ]))
  })

  it('records the first model event before a successful turn settles', async () => {
    faux.setResponses([fauxAssistantMessage('observed')])

    await collect(createPiCoreAgentRuntime().agentChat(
      [{ role: 'user', content: 'observe' }],
      undefined,
      'desktop',
      { systemPrompt: 'system', conversationId: 'conv-observed' }
    ))

    const observation = state.usageRecords.filter((record: any) => record.kind === 'runtime_turn')
    expect(observation).toEqual(expect.arrayContaining([
      expect.objectContaining({ phase: 'started', firstModelEvent: false }),
      expect.objectContaining({ phase: 'first_model_event', firstModelEvent: true }),
      expect.objectContaining({ phase: 'settled', outcome: 'completed', firstModelEvent: true })
    ]))
  })

  it('closes the handle immediately on external abort', async () => {
    let markProviderStarted!: () => void
    const providerStarted = new Promise<void>((resolve) => { markProviderStarted = resolve })
    faux.setResponses([
      async (_context, options) => new Promise((resolve) => {
        markProviderStarted()
        const finish = () => resolve(fauxAssistantMessage('', { stopReason: 'aborted' }))
        if (options?.signal?.aborted) finish()
        else options?.signal?.addEventListener('abort', finish, { once: true })
      })
    ])
    const controller = new AbortController()
    let readyHandle: any
    let markReady!: () => void
    const ready = new Promise<void>((resolve) => { markReady = resolve })
    const collecting = collect(createPiCoreAgentRuntime().agentChat(
      [{ role: 'user', content: 'wait' }],
      controller.signal,
      'desktop',
      { systemPrompt: 'system', conversationId: 'conv-abort-handle' },
      (handle) => {
        readyHandle = handle
        markReady()
      }
    ))

    await ready
    await providerStarted
    controller.abort()
    expectInvalidHandleState(() => readyHandle.steer({ text: 'after abort' }))
    await collecting
  })

  it('removes retry scaffolding without dropping tool evidence', async () => {
    const executed: string[] = []
    state.tools = [{
      name: 'read',
      label: 'read',
      description: 'read',
      parameters: Type.Object({ path: Type.String() }),
      executionMode: 'sequential',
      async execute(_id: string, params: { path: string }) {
        executed.push(params.path)
        return {
          content: [{ type: 'text', text: `result:${params.path}` }],
          details: { args: params }
        }
      }
    }]
    let continuationContext = ''
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall('read', { path: '/tmp/before' }, { id: 'call-before-empty' }), { stopReason: 'toolUse' }),
      fauxAssistantMessage(''),
      fauxAssistantMessage(fauxToolCall('read', { path: '/tmp/retry' }, { id: 'call-during-retry' }), { stopReason: 'toolUse' }),
      fauxAssistantMessage('recovered'),
      async (context) => {
        continuationContext = JSON.stringify(context.messages)
        return fauxAssistantMessage('goal-finished')
      }
    ])
    state.goalResults = [
      { ok: false, reason: 'continue' },
      { ok: true, reason: 'done' }
    ]

    const events = await collect(createPiCoreAgentRuntime().agentChat(
      [{ role: 'user', content: 'use tools' }],
      undefined,
      'desktop',
      {
        systemPrompt: 'system',
        conversationId: 'conv-retry-tools',
        goal: {
          text: 'finish',
          maxTurns: 2,
          turnsUsed: 0,
          status: 'active',
          consecutiveBlocks: 0,
          createdAt: Date.now()
        }
      }
    ))

    expect(events.some((event) => event.type === 'error')).toBe(false)
    expect(executed).toEqual(['/tmp/before', '/tmp/retry'])
    expect(continuationContext).toContain('call-before-empty')
    expect(continuationContext).toContain('result:/tmp/before')
    expect(continuationContext).toContain('call-during-retry')
    expect(continuationContext).toContain('result:/tmp/retry')
    expect(continuationContext).not.toContain('[OpenPipal 自动续跑]')
  })

  it('never replays an overflowed turn after tool activity', async () => {
    let executed = 0
    let forcedCompactions = 0
    state.tools = [{
      name: 'read',
      label: 'read',
      description: 'read',
      parameters: Type.Object({}),
      executionMode: 'sequential',
      async execute() {
        executed += 1
        return { content: [{ type: 'text', text: 'evidence' }], details: {} }
      }
    }]
    state.compact = async (history: unknown[], _conversationId?: string, _config?: unknown, options?: { force?: boolean }) => {
      if (options?.force) {
        forcedCompactions += 1
        return [{ role: 'user', content: 'compacted replay' }]
      }
      return history
    }
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall('read', {}, { id: 'call-once' }), { stopReason: 'toolUse' }),
      fauxAssistantMessage('', { stopReason: 'length' }),
      fauxAssistantMessage(fauxToolCall('read', {}, { id: 'call-duplicate' }), { stopReason: 'toolUse' })
    ])

    const events = await collect(createPiCoreAgentRuntime().agentChat(
      [{ role: 'user', content: 'run once' }],
      undefined,
      'desktop',
      { systemPrompt: 'system', conversationId: 'conv-overflow-tool' }
    ))

    expect(executed).toBe(1)
    expect(forcedCompactions).toBe(0)
    expect(events.filter((event) => event.type === 'error')).toEqual([
      expect.objectContaining({ content: expect.stringContaining('避免自动重放') })
    ])
  })

  it('cancels background goal work when the event consumer closes early', async () => {
    let providerCalls = 0
    let goalStarted = false
    let goalAborted = false
    let readyHandle: any
    faux.setResponses([
      async () => {
        providerCalls += 1
        return fauxAssistantMessage('initial')
      },
      async () => {
        providerCalls += 1
        return fauxAssistantMessage('must-not-run')
      }
    ])
    state.goalResults = [({ signal }: { signal: AbortSignal }) => new Promise((resolve) => {
      goalStarted = true
      const finish = () => {
        goalAborted = true
        resolve({ ok: true, reason: 'cancelled' })
      }
      if (signal.aborted) finish()
      else signal.addEventListener('abort', finish, { once: true })
    })]
    const generator = createPiCoreAgentRuntime().agentChat(
      [{ role: 'user', content: 'start goal' }],
      undefined,
      'desktop',
      {
        systemPrompt: 'system',
        conversationId: 'conv-consumer-close',
        goal: {
          text: 'keep going',
          maxTurns: 2,
          turnsUsed: 0,
          status: 'active',
          consecutiveBlocks: 0,
          createdAt: Date.now()
        }
      },
      (handle) => { readyHandle = handle }
    )

    for (let attempt = 0; attempt < 20 && !goalStarted; attempt++) {
      const next = await generator.next()
      expect(next.done).toBe(false)
      await new Promise((resolve) => setTimeout(resolve, 1))
    }
    expect(goalStarted).toBe(true)

    await expect(Promise.race([
      generator.return(undefined),
      new Promise((_, reject) => setTimeout(() => reject(new Error('generator return timeout')), 500))
    ])).resolves.toMatchObject({ done: true })
    await new Promise((resolve) => setTimeout(resolve, 10))

    expect(goalAborted).toBe(true)
    expect(providerCalls).toBe(1)
    expectInvalidHandleState(() => readyHandle.followUp({ text: 'after consumer close' }))
  })
})

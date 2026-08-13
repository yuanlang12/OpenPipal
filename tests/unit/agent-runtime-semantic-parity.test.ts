import {
  createAssistantMessageEventStream,
  createFauxCore,
  createModels,
  createProvider,
  fauxAssistantMessage,
  fauxProvider,
  fauxThinking,
  fauxToolCall,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type StreamFunction
} from '@earendil-works/pi-ai'
import {
  registerApiProvider,
  registerFauxProvider,
  unregisterApiProviders
} from '@earendil-works/pi-ai/compat'
import { Type } from 'typebox'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createTranscriptCollector,
  type TranscriptEntry
} from '../../src/main/pi-event-adapter'

const state = vi.hoisted(() => ({
  model: undefined as any,
  models: undefined as any,
  legacyTools: [] as any[],
  coreTools: [] as any[],
  mcpBuildCalls: [] as unknown[][],
  usageRecords: [] as any[],
  measured: [] as any[]
}))

vi.mock('../../src/main/config-manager', () => ({
  adaptModelRequestPayload: (payload: unknown) => payload,
  buildModelFromConfig: () => state.model,
  createModelPayloadAdapter: () => (payload: unknown) => payload,
  ensurePiApiKeyFor: () => undefined,
  getWorkingDir: () => '/tmp',
  resolveAuxThinkingLevel: () => 'off',
  resolveConversationModelConfig: () => ({
    source: 'global',
    config: {
      provider: state.model?.provider || 'faux',
      baseUrl: 'http://localhost:0',
      apiKey: 'test',
      model: state.model?.id || 'faux-1',
      supportsThinking: true
    }
  }),
  supportsEffortDial: () => false,
  withSessionStreamOptions: (stream: unknown) => stream
}))

vi.mock('../../src/main/pi-tools', () => ({
  AskUserResolver: class AskUserResolver {},
  buildPiTools: () => state.legacyTools
}))

vi.mock('../../src/main/pi-mcp-bridge', () => ({
  buildMcpBridgeTools: (...args: unknown[]) => {
    state.mcpBuildCalls.push(args)
    return []
  }
}))

vi.mock('../../src/main/agent-workspace-store', () => ({
  readToolsConfig: () => undefined
}))

vi.mock('../../src/main/pi-security', () => ({
  authorizeToolCall: async () => undefined,
  createSecurityHook: () => async () => undefined
}))

vi.mock('../../src/main/context-window-policy', () => ({
  capToolResultText: (value: string) => value,
  createStableContextTransform: () => (messages: unknown) => messages
}))

vi.mock('../../src/main/history-compactor', () => ({
  compactHistoryForModel: async (history: unknown[]) => history,
  getContextBudget: () => ({ contextWindow: 128_000, budget: 100_000 }),
  recordMeasuredPromptTokens: (...args: unknown[]) => state.measured.push(args)
}))

vi.mock('../../src/main/goal-checker', () => ({
  buildContinuationHint: () => 'goal continuation',
  checkGoal: async () => ({ ok: true, reason: 'done' })
}))

vi.mock('../../src/main/agent-runtime/openpipal-prompt', () => ({
  buildOpenPipalRuntimeContext: () => '',
  buildOpenPipalSystemPrompt: () => 'system'
}))

vi.mock('../../src/main/agent-runtime/openpipal-prompt-core', () => ({
  buildOpenPipalRuntimeContext: () => '',
  prepareOpenPipalSystemPrompt: () => ({
    skillContext: {},
    render: () => 'system'
  }),
  resolveOpenPipalWorkingDirectory: () => ({
    workingDir: '/tmp',
    disabledTools: []
  })
}))

vi.mock('../../src/main/agent-runtime/pi-core-skills', () => ({
  loadPiCoreSkillCatalog: async () => ({ skills: [], promptSection: '' })
}))

vi.mock('../../src/main/agent-runtime/pi-core-models', () => ({
  createOpenPipalPiCoreModels: () => state.models
}))

vi.mock('../../src/main/agent-runtime/pi-core-tool-bridge', () => ({
  buildPiCoreHarnessTools: () => ({
    tools: state.coreTools,
    toolContext: {},
    askUserResolver: {},
    dispose: async () => undefined
  }),
  buildPiCoreAgentTools: () => ({
    tools: state.coreTools,
    toolContext: {},
    askUserResolver: {},
    dispose: async () => undefined
  })
}))

vi.mock('../../src/main/usage-log', () => ({
  appendUsageRecord: (record: unknown) => state.usageRecords.push(record)
}))

vi.mock('../../src/main/prompt-cache-fifo', () => ({
  resolveCacheRetentionForModel: () => undefined
}))

import { createPiCoreAgentRuntime } from '../../src/main/agent-runtime/pi-core-runtime'
import { agentChat as legacyAgentChat } from '../../src/main/pi-agent-service'

interface SemanticRun {
  thinking: string
  thinkingEnds: number
  text: string
  transcript: TranscriptEntry[]
  toolStarts: Array<{ name: string; toolCallId?: string }>
  toolEnds: Array<{
    name: string
    toolCallId?: string
    result?: string
    args?: unknown
  }>
  errors: string[]
  contextUsage: {
    count: number
    promptTokensArePositive: boolean
    contextWindow: number[]
    budget: number[]
    compacted: boolean[]
  }
}

interface RuntimePair {
  legacyModel: any
  coreModel: any
  coreModels: any
  close(): void
}

let runtimePairSequence = 0

async function collect(generator: AsyncGenerator<any>): Promise<any[]> {
  const events: any[] = []
  for await (const event of generator) events.push(event)
  return events
}

function parseArgs(value: unknown): unknown {
  if (typeof value !== 'string') return value
  try {
    return JSON.parse(value)
  } catch {
    return value
  }
}

function semanticRun(events: any[]): SemanticRun {
  const transcript = createTranscriptCollector()
  for (const event of events) transcript.feed(event)
  const contextUsage = events.filter((event) => event.type === 'context_usage')
  return {
    thinking: events
      .filter((event) => event.type === 'thinking')
      .map((event) => event.content)
      .join(''),
    thinkingEnds: events.filter((event) => event.type === 'thinking_end').length,
    text: events
      .filter((event) => event.type === 'text')
      .map((event) => event.content)
      .join(''),
    transcript: transcript.finishTranscript(),
    toolStarts: events
      .filter((event) => event.type === 'tool_start')
      .map((event) => ({ name: event.name, toolCallId: event.toolCallId })),
    toolEnds: events
      .filter((event) => event.type === 'tool_end')
      .map((event) => ({
        name: event.name,
        toolCallId: event.toolCallId,
        result: event.mcpResult,
        args: parseArgs(event.modelToolArgs ?? event.mcpArgs)
      })),
    errors: events
      .filter((event) => event.type === 'error')
      .map((event) => event.content),
    // Prompt token totals may differ because the Harness owns a different
    // provider envelope. The product contract is presence, positivity, and the
    // shared context budget/compaction semantics, so compare those explicitly.
    contextUsage: {
      count: contextUsage.length,
      promptTokensArePositive: contextUsage.every((event) => event.promptTokens > 0),
      contextWindow: contextUsage.map((event) => event.contextWindow),
      budget: contextUsage.map((event) => event.budget),
      compacted: contextUsage.map((event) => event.compacted)
    }
  }
}

async function runPair(pair: RuntimePair): Promise<{ legacy: SemanticRun; core: SemanticRun }> {
  state.model = pair.legacyModel
  const legacy = semanticRun(await collect(legacyAgentChat(
    [{ role: 'user', content: 'parity request' }],
    undefined,
    'desktop',
    { systemPrompt: 'system', conversationId: 'legacy-parity' }
  )))

  state.model = pair.coreModel
  state.models = pair.coreModels
  const core = semanticRun(await collect(createPiCoreAgentRuntime().agentChat(
    [{ role: 'user', content: 'parity request' }],
    undefined,
    'desktop',
    { systemPrompt: 'system', conversationId: 'core-parity' }
  )))

  return { legacy, core }
}

function createStreamingPair(responses: AssistantMessage[]): RuntimePair {
  const suffix = String(++runtimePairSequence)
  const legacy = registerFauxProvider({
    api: `faux-legacy-${suffix}`,
    provider: `parity-legacy-${suffix}`,
    tokenSize: { min: 1, max: 1 }
  })
  const core = fauxProvider({
    api: `faux-core-${suffix}`,
    provider: `parity-core-${suffix}`,
    tokenSize: { min: 1, max: 1 }
  })
  legacy.setResponses(responses)
  core.setResponses(responses)
  const coreModels = createModels()
  coreModels.setProvider(core.provider)
  return {
    legacyModel: legacy.getModel(),
    coreModel: core.getModel(),
    coreModels,
    close: () => legacy.unregister()
  }
}

function terminalOnly<TOptions>(
  upstream: StreamFunction<string, TOptions>
): StreamFunction<string, TOptions> {
  return (model, context, options): AssistantMessageEventStream => {
    const output = createAssistantMessageEventStream()
    void (async () => {
      let finalMessage: AssistantMessage | undefined
      try {
        const stream = upstream(model, context, options)
        for await (const event of stream) {
          if (event.type === 'done') {
            finalMessage = event.message
            output.push(event)
          } else if (event.type === 'error') {
            finalMessage = event.error
            output.push(event)
          }
        }
      } finally {
        if (finalMessage) output.end(finalMessage)
      }
    })()
    return output
  }
}

function createFallbackPair(responses: AssistantMessage[]): RuntimePair {
  const suffix = String(++runtimePairSequence)
  const legacySource = `semantic-parity-legacy-${suffix}`
  const legacy = createFauxCore({
    api: `fallback-legacy-${suffix}`,
    provider: `fallback-legacy-${suffix}`,
    tokenSize: { min: 1, max: 1 }
  })
  const core = createFauxCore({
    api: `fallback-core-${suffix}`,
    provider: `fallback-core-${suffix}`,
    tokenSize: { min: 1, max: 1 }
  })
  legacy.setResponses(responses)
  core.setResponses(responses)

  registerApiProvider({
    api: legacy.api,
    stream: terminalOnly(legacy.stream),
    streamSimple: terminalOnly(legacy.streamSimple)
  }, legacySource)

  const coreModels = createModels()
  coreModels.setProvider(createProvider({
    id: core.getModel().provider,
    auth: { apiKey: { name: 'fallback', resolve: async () => ({ auth: {} }) } },
    models: core.models,
    api: {
      stream: terminalOnly(core.stream),
      streamSimple: terminalOnly(core.streamSimple)
    }
  }))

  return {
    legacyModel: legacy.getModel(),
    coreModel: core.getModel(),
    coreModels,
    close: () => unregisterApiProviders(legacySource)
  }
}

describe('legacy and pi-core normalized semantic transcript parity', () => {
  beforeEach(() => {
    state.model = undefined
    state.models = undefined
    state.legacyTools = []
    state.coreTools = []
    state.mcpBuildCalls = []
    state.usageRecords = []
    state.measured = []
  })

  it('streams thinking and text once without message_end duplication', async () => {
    const pair = createStreamingPair([
      fauxAssistantMessage([
        fauxThinking('deterministic thought'),
        { type: 'text', text: 'deterministic answer' }
      ])
    ])
    try {
      const result = await runPair(pair)
      expect(result.legacy).toEqual(result.core)
      expect(result.legacy).toEqual(expect.objectContaining({
        thinking: 'deterministic thought',
        thinkingEnds: 1,
        text: 'deterministic answer',
        transcript: [{ kind: 'text', content: 'deterministic answer' }],
        errors: [],
        contextUsage: {
          count: 1,
          promptTokensArePositive: true,
          contextWindow: [128_000],
          budget: [100_000],
          compacted: [false]
        }
      }))
    } finally {
      pair.close()
    }
  })

  it('records the legacy Runtime turn phases without conversation content', async () => {
    const pair = createStreamingPair([fauxAssistantMessage('observed legacy')])
    try {
      state.model = pair.legacyModel
      await collect(legacyAgentChat(
        [{ role: 'user', content: 'runtime observation request' }],
        undefined,
        'desktop',
        { systemPrompt: 'system', conversationId: 'legacy-observed' }
      ))

      const observations = state.usageRecords.filter((record: any) => record.kind === 'runtime_turn')
      expect(observations).toEqual(expect.arrayContaining([
        expect.objectContaining({ runtime: 'legacy', phase: 'started', firstModelEvent: false }),
        expect.objectContaining({ runtime: 'legacy', phase: 'stream_fn_called', streamAttempt: 1, firstModelEvent: false }),
        expect.objectContaining({ runtime: 'legacy', phase: 'stream_opened', streamAttempt: 1, firstModelEvent: false }),
        expect.objectContaining({ runtime: 'legacy', phase: 'first_stream_next', streamAttempt: 1, firstModelEvent: false }),
        expect.objectContaining({ runtime: 'legacy', phase: 'first_model_event', firstModelEvent: true }),
        expect.objectContaining({ runtime: 'legacy', phase: 'settled', outcome: 'completed', firstModelEvent: true })
      ]))
      expect(JSON.stringify(observations)).not.toContain('runtime observation request')
      expect(JSON.stringify(observations)).not.toContain('observed legacy')
    } finally {
      pair.close()
    }
  })

  it('records an external abort before the legacy Runtime has a model event', async () => {
    const pair = createStreamingPair([
      async (_context: unknown, options: { signal?: AbortSignal }) => new Promise<AssistantMessage>((resolve) => {
        const finish = () => resolve(fauxAssistantMessage('', { stopReason: 'aborted' }))
        if (options.signal?.aborted) finish()
        else options.signal?.addEventListener('abort', finish, { once: true })
      })
    ] as any)
    try {
      state.model = pair.legacyModel
      const controller = new AbortController()
      const collecting = collect(legacyAgentChat(
        [{ role: 'user', content: 'wait for cancellation' }],
        controller.signal,
        'desktop',
        { systemPrompt: 'system', conversationId: 'legacy-abort' }
      ))
      setTimeout(() => controller.abort(), 10)
      await collecting

      const observations = state.usageRecords.filter((record: any) => record.kind === 'runtime_turn')
      expect(observations).toEqual(expect.arrayContaining([
        expect.objectContaining({ runtime: 'legacy', phase: 'started', firstModelEvent: false }),
        expect.objectContaining({ runtime: 'legacy', phase: 'external_abort', firstModelEvent: false }),
        expect.objectContaining({ runtime: 'legacy', phase: 'settled', outcome: 'external_abort', firstModelEvent: false })
      ]))
    } finally {
      pair.close()
    }
  })

  it('passes scheduler source through the legacy Runtime MCP gateway build', async () => {
    const pair = createStreamingPair([fauxAssistantMessage('scheduler complete')])
    try {
      state.model = pair.legacyModel
      await collect(legacyAgentChat(
        [{ role: 'user', content: 'scheduled request' }],
        undefined,
        'scheduler',
        { systemPrompt: 'system', conversationId: 'legacy-scheduler' }
      ))

      expect(state.mcpBuildCalls).toContainEqual([
        undefined,
        'legacy-scheduler',
        'scheduler'
      ])
    } finally {
      pair.close()
    }
  })

  it('falls back to terminal thinking and text when the provider emits no deltas', async () => {
    const pair = createFallbackPair([
      fauxAssistantMessage([
        fauxThinking('fallback thought'),
        { type: 'text', text: 'fallback answer' }
      ])
    ])
    try {
      const result = await runPair(pair)
      expect(result.legacy).toEqual(result.core)
      expect(result.legacy).toEqual(expect.objectContaining({
        thinking: 'fallback thought',
        thinkingEnds: 1,
        text: 'fallback answer',
        transcript: [{ kind: 'text', content: 'fallback answer' }],
        errors: []
      }))
    } finally {
      pair.close()
    }
  })

  it('preserves one sequential tool call, args, result, and toolCallId', async () => {
    const executions: string[] = []
    const tool = {
      name: 'echo',
      label: 'echo',
      description: 'echo one value',
      parameters: Type.Object({ value: Type.String() }),
      executionMode: 'sequential' as const,
      async execute(toolCallId: string, params: { value: string }) {
        executions.push(`${toolCallId}:${params.value}`)
        return {
          content: [{ type: 'text' as const, text: `echo:${params.value}` }],
          details: { args: params }
        }
      }
    }
    state.legacyTools = [tool]
    state.coreTools = [tool]
    const pair = createStreamingPair([
      fauxAssistantMessage(
        fauxToolCall('echo', { value: 'alpha' }, { id: 'call-parity-1' }),
        { stopReason: 'toolUse' }
      ),
      fauxAssistantMessage('tool complete')
    ])
    try {
      const result = await runPair(pair)
      expect(result.legacy).toEqual(result.core)
      expect(result.legacy).toEqual(expect.objectContaining({
        text: 'tool complete',
        toolStarts: [{ name: 'echo', toolCallId: 'call-parity-1' }],
        toolEnds: [{
          name: 'echo',
          toolCallId: 'call-parity-1',
          result: 'echo:alpha',
          args: { value: 'alpha' }
        }],
        transcript: [
          {
            kind: 'tool',
            toolName: 'echo',
            toolCallId: 'call-parity-1',
            content: 'echo:alpha',
            toolArgs: '{"value":"alpha"}',
            searchResults: undefined
          },
          { kind: 'text', content: 'tool complete' }
        ],
        errors: []
      }))
      expect(executions).toEqual([
        'call-parity-1:alpha',
        'call-parity-1:alpha'
      ])
    } finally {
      pair.close()
    }
  })

  it('surfaces a provider error exactly once', async () => {
    const pair = createStreamingPair([
      fauxAssistantMessage('', {
        stopReason: 'error',
        errorMessage: 'provider parity boom'
      })
    ])
    try {
      const result = await runPair(pair)
      expect(result.legacy).toEqual(result.core)
      expect(result.legacy.errors).toEqual(['provider parity boom'])
      expect(result.legacy.transcript).toEqual([])
    } finally {
      pair.close()
    }
  })
})

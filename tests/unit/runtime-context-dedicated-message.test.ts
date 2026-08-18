import {
  createAssistantMessageEventStream,
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  type AssistantMessage,
  type StreamFunction
} from '@earendil-works/pi-ai'
import {
  registerFauxProvider,
  unregisterApiProviders
} from '@earendil-works/pi-ai/compat'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const RUNTIME_CONTEXT_FIXTURE = `
<runtime-context>
当前真实时间：2026年8月16日 星期日 15:04。凡涉及"今天/现在"等时间判断，一律以此为准。
</runtime-context>`

const state = vi.hoisted(() => ({
  model: undefined as any,
  models: undefined as any,
  legacyRequests: [] as any[],
  coreRequests: [] as any[]
}))

// legacy runtime 的 streamFn 落在 pi-ai/compat 的全局 streamSimple 上；
// onPayload 只有真实 API 实现会回调，faux provider 不走，所以在 compat 层捕获。
vi.mock('@earendil-works/pi-ai/compat', async (importOriginal) => {
  const actual = await importOriginal() as any
  return {
    ...actual,
    streamSimple: (model: any, context: any, options: any) => {
      state.legacyRequests.push({ messages: context?.messages })
      return actual.streamSimple(model, context, options)
    }
  }
})

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
  buildPiTools: () => []
}))

vi.mock('../../src/main/pi-mcp-bridge', () => ({
  buildMcpBridgeTools: () => []
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
  recordMeasuredPromptTokens: () => undefined
}))

vi.mock('../../src/main/goal-checker', () => ({
  buildContinuationHint: () => 'goal continuation',
  checkGoal: async () => ({ ok: true, reason: 'done' })
}))

vi.mock('../../src/main/agent-runtime/openpipal-prompt', () => ({
  buildOpenPipalRuntimeContext: () => RUNTIME_CONTEXT_FIXTURE,
  buildOpenPipalSystemPrompt: () => 'system',
  prepareOpenPipalSystemPrompt: () => ({ skillContext: {}, render: () => 'system' })
}))

vi.mock('../../src/main/skill-manager', () => ({
  buildSkillPromptSection: () => ''
}))

vi.mock('../../src/main/agent-runtime/openpipal-prompt-core', () => ({
  buildOpenPipalRuntimeContext: () => RUNTIME_CONTEXT_FIXTURE,
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
    tools: [],
    toolContext: {},
    askUserResolver: {},
    dispose: async () => undefined
  }),
  buildPiCoreAgentTools: () => ({
    tools: [],
    toolContext: {},
    askUserResolver: {},
    dispose: async () => undefined
  })
}))

vi.mock('../../src/main/usage-log', () => ({
  appendUsageRecord: () => undefined
}))

vi.mock('../../src/main/prompt-cache-fifo', () => ({
  resolveCacheRetentionForModel: () => undefined
}))

import { createPiCoreAgentRuntime } from '../../src/main/agent-runtime/pi-core-runtime'
import { agentChat as legacyAgentChat } from '../../src/main/pi-agent-service'

const RC_MARKER = '<runtime-context>'

function textOf(message: any): string {
  const content = message?.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter((block: any) => block?.type === 'text' && typeof block.text === 'string')
    .map((block: any) => block.text)
    .join('\n')
}

function isRuntimeContextMessage(message: any): boolean {
  return message?.role === 'user' && textOf(message).includes(RC_MARKER)
}

/** 与 prompt cache 的前缀匹配同口径：去掉易变 timestamp 后的规范化投影。 */
function stableProjection(message: any): unknown {
  const { timestamp, ...rest } = message ?? {}
  return rest
}

async function collect(generator: AsyncGenerator<any>): Promise<any[]> {
  const events: any[] = []
  for await (const event of generator) events.push(event)
  return events
}

function captureStream(upstream: StreamFunction<string, any>): StreamFunction<string, any> {
  return (model, context, options) => {
    state.coreRequests.push({ messages: (context as any)?.messages })
    return upstream(model, context, options)
  }
}

const TURN_ONE_HISTORY = [{ role: 'user', content: '第一问' }]
const TURN_TWO_HISTORY = [
  { role: 'user', content: '第一问' },
  { role: 'assistant', content: '答复一' },
  { role: 'user', content: '第二问' }
]

let registry: Array<() => void> = []

beforeEach(() => {
  state.legacyRequests = []
  state.coreRequests = []
  registry = []
})

afterEach(() => {
  for (const dispose of registry.splice(0).reverse()) dispose()
  unregisterApiProviders()
})

describe('runtime context 作为独立末尾 user 消息（prompt cache 前缀稳定）', () => {
  it('buildRuntimeContextMessage：独立 user 消息、单 text 块、去除首尾空白', async () => {
    const { buildRuntimeContextMessage } = await import('../../src/main/agent-runtime/pi-message-conversion')
    const message: any = buildRuntimeContextMessage('\n\n<runtime-context>x</runtime-context>\n')
    expect(message.role).toBe('user')
    expect(message.content).toEqual([{ type: 'text', text: '<runtime-context>x</runtime-context>' }])
    expect(() => buildRuntimeContextMessage('   ')).toThrow()
  })

  it('legacy：两个回合间历史消息逐字节稳定，rc 只以独立消息出现在末尾', async () => {
    const faux = registerFauxProvider({
      api: 'faux-rc-legacy',
      provider: 'rc-legacy',
      tokenSize: { min: 1, max: 1 }
    })
    registry.push(() => faux.unregister())
    faux.setResponses([
      fauxAssistantMessage('答复一'),
      fauxAssistantMessage('答复二')
    ] as AssistantMessage[])
    state.model = faux.getModel()

    await collect(legacyAgentChat(TURN_ONE_HISTORY, undefined, 'desktop', {
      systemPrompt: 'system', conversationId: 'rc-legacy-1'
    }))
    const turnOneRequests = state.legacyRequests.slice()
    expect(turnOneRequests.length).toBeGreaterThan(0)
    const turnTwoEvents = await collect(legacyAgentChat(TURN_TWO_HISTORY, undefined, 'desktop', {
      systemPrompt: 'system', conversationId: 'rc-legacy-1'
    }))

    const turnOne = turnOneRequests[turnOneRequests.length - 1].messages
    const turnTwo = state.legacyRequests[state.legacyRequests.length - 1].messages

    // 回合一：末条用户消息保持原文（rc 不再拼进消息体），rc 是紧随其后的独立消息
    const turnOneLastUser = [...turnOne].reverse().find((m: any) => m.role === 'user' && !isRuntimeContextMessage(m))
    expect(textOf(turnOneLastUser)).toBe('第一问')
    const turnOneLast = turnOne[turnOne.length - 1]
    expect(isRuntimeContextMessage(turnOneLast)).toBe(true)
    expect(turnOne[turnOne.length - 2]).toBe(turnOneLastUser)

    // 回合二：历史里的"第一问"与回合一完全一致（缓存前缀可复用的证据），
    // rc 不进历史、全载荷只出现一次，且仍位于末条
    const turnTwoFirstUser = turnTwo.find((m: any) => m.role === 'user' && !isRuntimeContextMessage(m))
    expect(stableProjection(turnTwoFirstUser)).toEqual(stableProjection(turnOneLastUser))
    expect(turnTwo.filter(isRuntimeContextMessage)).toHaveLength(1)
    expect(isRuntimeContextMessage(turnTwo[turnTwo.length - 1])).toBe(true)
    expect(textOf(turnTwo.find((m: any) => m.role === 'user' && textOf(m) === '第二问'))).toBe('第二问')

    // 事件面：快照原文广播（渲染层据此落盘隐藏消息）+ context_usage 携带 usage/segments
    const rcEvents = turnTwoEvents.filter((e: any) => e.type === 'runtime_context')
    expect(rcEvents).toHaveLength(1)
    expect(rcEvents[0].text.trim()).toBe(RUNTIME_CONTEXT_FIXTURE.trim())
    const usageEvents = turnTwoEvents.filter((e: any) => e.type === 'context_usage')
    expect(usageEvents.length).toBeGreaterThan(0)
    for (const evt of usageEvents) {
      expect(evt.usage).toMatchObject({ input: expect.any(Number), cacheRead: expect.any(Number), cacheWrite: expect.any(Number) })
      expect(evt.segments).toMatchObject({
        systemPrompt: expect.any(Number), skills: expect.any(Number),
        toolsBuiltin: expect.any(Number), toolsMcp: expect.any(Number), messages: expect.any(Number)
      })
    }
  })

  it('legacy：落盘的 rc 快照按原样回放，与当轮实发字节一致（跨回合前缀缓存的前提）', async () => {
    const faux = registerFauxProvider({
      api: 'faux-rc-legacy-2',
      provider: 'rc-legacy-2',
      tokenSize: { min: 1, max: 1 }
    })
    registry.push(() => faux.unregister())
    faux.setResponses([fauxAssistantMessage('答复三')] as AssistantMessage[])
    state.model = faux.getModel()

    // 渲染层落盘后的历史形状：u1 后跟隐藏 rc 快照，再是 a1 与本轮新问
    await collect(legacyAgentChat([
      { role: 'user', content: '第一问' },
      { role: 'user', content: RUNTIME_CONTEXT_FIXTURE, messageKind: 'runtime-context' },
      { role: 'assistant', content: '答复一' },
      { role: 'user', content: '第三问' }
    ], undefined, 'desktop', { systemPrompt: 'system', conversationId: 'rc-legacy-2' }))

    const payload = state.legacyRequests[state.legacyRequests.length - 1].messages
    const rcMessages = payload.filter(isRuntimeContextMessage)
    // 落盘快照（u1 后）+ 当轮实发（末条）各一张
    expect(rcMessages).toHaveLength(2)
    expect(stableProjection(rcMessages[0])).toEqual(stableProjection(rcMessages[1]))
    const u1Idx = payload.findIndex((m: any) => textOf(m) === '第一问')
    expect(isRuntimeContextMessage(payload[u1Idx + 1])).toBe(true)
    expect(isRuntimeContextMessage(payload[payload.length - 1])).toBe(true)
  })

  it('pi-core：与 legacy 同契约', async () => {
    const faux = fauxProvider({
      api: 'faux-rc-core',
      provider: 'rc-core',
      tokenSize: { min: 1, max: 1 }
    })
    faux.setResponses([
      fauxAssistantMessage('答复一'),
      fauxAssistantMessage('答复二')
    ] as AssistantMessage[])
    const models = createModels()
    models.setProvider(faux.provider)
    const stream = models.streamSimple.bind(models)
    state.models = { ...models, streamSimple: captureStream(stream) }

    const runtime = createPiCoreAgentRuntime()
    await collect(runtime.agentChat(TURN_ONE_HISTORY, undefined, 'desktop', {
      systemPrompt: 'system', conversationId: 'rc-core-1'
    }))
    const turnOneRequests = state.coreRequests.slice()
    expect(turnOneRequests.length).toBeGreaterThan(0)
    const turnTwoEvents = await collect(runtime.agentChat(TURN_TWO_HISTORY, undefined, 'desktop', {
      systemPrompt: 'system', conversationId: 'rc-core-1'
    }))

    const turnOne = turnOneRequests[turnOneRequests.length - 1].messages
    const turnTwo = state.coreRequests[state.coreRequests.length - 1].messages

    const turnOneLastUser = [...turnOne].reverse().find((m: any) => m.role === 'user' && !isRuntimeContextMessage(m))
    expect(textOf(turnOneLastUser)).toBe('第一问')
    expect(isRuntimeContextMessage(turnOne[turnOne.length - 1])).toBe(true)
    expect(turnOne[turnOne.length - 2]).toBe(turnOneLastUser)

    const turnTwoFirstUser = turnTwo.find((m: any) => m.role === 'user' && !isRuntimeContextMessage(m))
    expect(stableProjection(turnTwoFirstUser)).toEqual(stableProjection(turnOneLastUser))
    expect(turnTwo.filter(isRuntimeContextMessage)).toHaveLength(1)
    expect(isRuntimeContextMessage(turnTwo[turnTwo.length - 1])).toBe(true)

    // 与 legacy 同口径：快照广播 + context_usage 携带 usage/segments
    const rcEvents = turnTwoEvents.filter((e: any) => e.type === 'runtime_context')
    expect(rcEvents).toHaveLength(1)
    expect(rcEvents[0].text.trim()).toBe(RUNTIME_CONTEXT_FIXTURE.trim())
    const usageEvents = turnTwoEvents.filter((e: any) => e.type === 'context_usage')
    expect(usageEvents.length).toBeGreaterThan(0)
    expect(usageEvents[0].usage).toBeDefined()
    expect(usageEvents[0].segments).toBeDefined()
  })
})

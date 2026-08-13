import {
  Agent,
  type AgentMessage
} from '@earendil-works/pi-agent-core'
import {
  contentText,
  type AssistantMessage,
  type ImageContent,
  type Model,
  type Models
} from '@earendil-works/pi-ai'
import { createHash } from 'crypto'
import { resolveExecutionRoleName } from '../agent-overrides'
import { formatModelStallNotice } from '../../shared/runtime-notice'
import {
  adaptModelRequestPayload,
  buildModelFromConfig,
  resolveAuxThinkingLevel,
  resolveConversationModelConfig,
  supportsEffortDial,
  withSessionStreamOptions,
  type ModelConfig
} from '../config-manager'
import { createStableContextTransform } from '../context-window-policy'
import {
  EMPTY_COMPLETION_RETRY_PROMPT,
  isContextOverflowCompletion,
  isEmptySuccessfulAssistantMessage
} from '../empty-completion-guard'
import {
  buildContinuationHint,
  checkGoal,
  type ConversationGoal,
  type GoalCheckerLLM
} from '../goal-checker'
import {
  compactHistoryForModel,
  getContextBudget,
  recordMeasuredPromptTokens
} from '../history-compactor'
import { PiEventAdapter } from '../pi-event-adapter'
import type { PermissionHandler } from '../pi-security'
import { resolveCacheRetentionForModel } from '../prompt-cache-fifo'
import { createStallWatchdog, resolveModelStallTimeoutMs } from '../stall-watchdog'
import { measureToolTrail } from '../tool-trail'
import { appendUsageRecord, type RuntimeTurnPhase } from '../usage-log'
import type { StreamBoundaryPhase } from '../isolated-stream-signal'
import { AsyncQueue } from './async-queue'
import type {
  AgentEvent,
  AgentOverrides,
  ChatMessage,
  ChatSource,
  RunningAgentHandle,
  RuntimeUserInput,
  OpenPipalAgentRuntime
} from './contracts'
import {
  appendRuntimeContext,
  convertHistoryToPiMessages,
  runtimeInputToPrompt
} from './pi-message-conversion'
import { createOpenPipalPiCoreModels } from './pi-core-models'
import { buildPiCoreAgentTools } from './pi-core-tool-bridge'
import {
  buildPiCoreAfterToolCallPatch,
  isPiAgentEvent,
  PiCoreToolAuthorizer
} from './pi-core-tool-adapter'
import {
  buildOpenPipalRuntimeContext,
  prepareOpenPipalSystemPrompt,
  resolveOpenPipalWorkingDirectory
} from './openpipal-prompt-core'
import { loadPiCoreSkillCatalog } from './pi-core-skills'

const MODEL_STALL_TIMEOUT_MS = resolveModelStallTimeoutMs(process.env.OPENPIPAL_STALL_TIMEOUT_MS)

interface PromptInput {
  text: string
  images?: ImageContent[]
}

interface AgentBundle {
  agent: Agent
  prompt?: PromptInput
  dispose: () => void
}

interface UsageState {
  calls: number
  input: number
  cacheRead: number
  cacheWrite: number
  output: number
}

interface ActiveTurnObservation {
  sequence: number
  startedAt: number
  firstModelEvent: boolean
}

function splitUserMessage(message: AgentMessage | undefined): PromptInput | undefined {
  if (!message || message.role !== 'user') return undefined
  if (typeof message.content === 'string') return { text: message.content }
  if (!Array.isArray(message.content)) return undefined
  const text = message.content
    .filter((block: any) => block?.type === 'text' && typeof block.text === 'string')
    .map((block: any) => block.text)
    .join('\n')
  const images = message.content.filter((block: any): block is ImageContent => block?.type === 'image')
  return {
    text: text || (images.length > 0 ? '请分析这些图片' : ''),
    images: images.length > 0 ? images : undefined
  }
}

function extractRecentForCheck(messages: AgentMessage[]): Array<{ role: string; content: string }> {
  return messages
    .filter((message: any) => message.role !== 'system')
    .map((message: any) => ({
      role: String(message.role),
      content: typeof message.content === 'string'
        ? message.content
        : Array.isArray(message.content)
          ? message.content
              .filter((block: any) => block?.type === 'text' && typeof block.text === 'string')
              .map((block: any) => block.text)
              .join('\n') || '[non-text content]'
          : ''
    }))
}

function findLastAssistantMessage(
  messages: readonly AgentMessage[],
  startIndex = 0
): AssistantMessage | undefined {
  for (let index = messages.length - 1; index >= startIndex; index--) {
    const message = messages[index]
    if (message?.role === 'assistant') return message
  }
  return undefined
}

function createAgentGoalChecker(
  models: Models,
  model: Model<any>,
  config: ModelConfig
): GoalCheckerLLM {
  return async ({ systemPrompt, userPrompt, signal }) => {
    const thinking = resolveAuxThinkingLevel(config, model)
    const result = await models.completeSimple(
      model,
      {
        systemPrompt,
        messages: [{ role: 'user', content: userPrompt, timestamp: Date.now() }]
      },
      {
        apiKey: config.apiKey || undefined,
        cacheRetention: resolveCacheRetentionForModel(model),
        reasoning: thinking === 'off' ? undefined : thinking,
        signal,
        onPayload: (payload) => adaptModelRequestPayload(
          payload,
          config,
          thinking === 'off' ? undefined : { reasoningEffort: thinking }
        )
      }
    )
    if (result.stopReason === 'error' || result.stopReason === 'aborted') {
      throw new Error(result.errorMessage || `GoalChecker ${result.stopReason}`)
    }
    return contentText(result.content, '')
  }
}

function safeErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

type RuntimeInputKind = 'steer' | 'followUp'

interface PendingRuntimeInput {
  kind: RuntimeInputKind
  input: RuntimeUserInput
  delivering: boolean
}

interface StableRunningHandleController {
  handle: RunningAgentHandle
  close: (reason?: string) => void
  flushPendingToAgent: (agent: Agent) => Promise<void>
  settleDeliveries: () => Promise<void>
  shiftPending: () => PendingRuntimeInput | undefined
}

function createInvalidHandleStateError(reason?: string): Error & { code: 'invalid_state' } {
  return Object.assign(
    new Error(reason || 'OpenPipal Agent run is no longer accepting steer or follow-up input'),
    { code: 'invalid_state' as const }
  )
}

function createStableRunningHandle(
  getAgent: () => Agent | undefined,
  isTurnActive: () => boolean,
): StableRunningHandleController {
  let accepting = true
  let closedReason: string | undefined
  const pending: PendingRuntimeInput[] = []
  const deliveries = new Set<Promise<void>>()

  const removePending = (item: PendingRuntimeInput): void => {
    const index = pending.indexOf(item)
    if (index >= 0) pending.splice(index, 1)
  }

  const deliver = (
    item: PendingRuntimeInput,
    agent: Agent
  ): Promise<void> => {
    item.delivering = true
    const prompt = runtimeInputToPrompt(item.input)
    try {
      const content: any[] = [{ type: 'text', text: prompt.text }]
      if (prompt.images?.length) content.push(...prompt.images)
      agent[item.kind]({ role: 'user', content, timestamp: Date.now() })
      removePending(item)
      return Promise.resolve()
    } catch (error) {
      item.delivering = false
      removePending(item)
      return Promise.reject(error)
    }
  }

  const route = (kind: RuntimeInputKind, input: RuntimeUserInput): void | Promise<void> => {
    if (!accepting) throw createInvalidHandleStateError(closedReason)

    // Queue first, before any await or Harness call. close() and shiftPending()
    // therefore see either the whole accepted input or none of it.
    const item: PendingRuntimeInput = { kind, input, delivering: false }
    pending.push(item)
    const agent = getAgent()
    if (!agent || !isTurnActive()) return
    const delivery = deliver(item, agent)
    deliveries.add(delivery)
    void delivery.then(
      () => { deliveries.delete(delivery) },
      () => { deliveries.delete(delivery) }
    )
    return delivery
  }

  const handle: RunningAgentHandle = Object.freeze({
    steer: (input: RuntimeUserInput) => route('steer', input),
    followUp: (input: RuntimeUserInput) => route('followUp', input)
  })

  const settleDeliveries = async (): Promise<void> => {
    while (deliveries.size > 0) {
      await Promise.allSettled(Array.from(deliveries))
    }
  }

  return {
    handle,
    close(reason?: string): void {
      if (!accepting) return
      accepting = false
      closedReason = reason
    },
    async flushPendingToAgent(agent: Agent): Promise<void> {
      await settleDeliveries()
      for (const item of [...pending]) {
        if (!item.delivering) await deliver(item, agent)
      }
    },
    settleDeliveries,
    shiftPending(): PendingRuntimeInput | undefined {
      const index = pending.findIndex((item) => !item.delivering)
      if (index < 0) return undefined
      return pending.splice(index, 1)[0]
    }
  }
}

export function createPiCoreAgentRuntime(): OpenPipalAgentRuntime {
  let permissionHandler: PermissionHandler | undefined

  return Object.freeze({
    kind: 'pi-core' as const,
    setPermissionHandler(handler: PermissionHandler): void {
      permissionHandler = handler
    },
    agentChat(
      history: ChatMessage[],
      signal?: AbortSignal,
      source: ChatSource = 'desktop',
      overrides?: AgentOverrides,
      onAgentReady?: (handle: RunningAgentHandle) => void
    ) {
      return runPiCoreAgentChat(history, signal, source, overrides, onAgentReady, permissionHandler)
    },
    testThinkingSupport
  })
}

export async function loadPiCoreAgentRuntime(): Promise<OpenPipalAgentRuntime> {
  return createPiCoreAgentRuntime()
}

async function* runPiCoreAgentChat(
  history: ChatMessage[],
  signal: AbortSignal | undefined,
  source: ChatSource,
  overrides: AgentOverrides | undefined,
  onAgentReady: ((handle: RunningAgentHandle) => void) | undefined,
  permissionHandler: PermissionHandler | undefined
): AsyncGenerator<AgentEvent, void, undefined> {
  // Capture the execution role before any asynchronous skill/model setup. A
  // stateless caller may not provide an overrides object, but prompt, skills,
  // product tools and security guards still have to share one role snapshot.
  const executionRoleName = resolveExecutionRoleName(overrides)
  overrides = overrides
    ? { ...overrides, roleName: executionRoleName }
    : { systemPrompt: '', roleName: executionRoleName }

  const eventQueue = new AsyncQueue<AgentEvent>()
  const adapter = new PiEventAdapter()
  const lifecycleController = new AbortController()
  const lifecycleSignal = lifecycleController.signal
  const forwardExternalAbort = (): void => lifecycleController.abort(signal?.reason)
  if (signal?.aborted) forwardExternalAbort()
  else signal?.addEventListener('abort', forwardExternalAbort, { once: true })
  const usage: UsageState = { calls: 0, input: 0, cacheRead: 0, cacheWrite: 0, output: 0 }
  const conversationShort = overrides?.conversationId?.slice(0, 8) || '-'
  const workspace = resolveOpenPipalWorkingDirectory(overrides)
  const resolvedModel = resolveConversationModelConfig(overrides?.modelPresetId)
  if (resolvedModel.danglingPresetId) {
    console.warn(`[Model] 会话预设 ${resolvedModel.danglingPresetId} 已不存在，回退全局默认`)
  }
  const modelConfig = resolvedModel.config
  const model = buildModelFromConfig(modelConfig)
  const modelContextWindow = Number((model as any).contextWindow)
  const historyModelConfig: ModelConfig = !modelConfig.contextWindow
    && Number.isFinite(modelContextWindow)
    && modelContextWindow > 0
    ? { ...modelConfig, contextWindow: modelContextWindow }
    : modelConfig
  const { contextWindow, budget } = getContextBudget(historyModelConfig)
  const preparedPrompt = prepareOpenPipalSystemPrompt(source, overrides, {
    stablePrefix: true,
    modelConfig
  })
  const skillCatalog = await loadPiCoreSkillCatalog(preparedPrompt.skillContext)
  const systemPrompt = preparedPrompt.render(skillCatalog.promptSection)
  const modelSupportsThinking = modelConfig.supportsThinking ?? !!(model as any).reasoning
  const userWantsThinking = overrides?.thinkingEnabled !== false
  const selectedLevel = overrides?.thinkingLevel && supportsEffortDial(modelConfig)
    ? overrides.thinkingLevel
    : 'low'
  const thinkingLevel = modelSupportsThinking && userWantsThinking ? selectedLevel : 'off'
  const builtTools = buildPiCoreAgentTools({
    source,
    overrides,
    workingDir: workspace.workingDir,
    disabledTools: workspace.disabledTools,
    mcpServers: workspace.mcpServers
  })
  let recordStreamBoundary: (phase: StreamBoundaryPhase, attempt: number) => void = () => {}
  const models = createOpenPipalPiCoreModels(model, modelConfig, {
    onStreamBoundary: (phase, attempt) => recordStreamBoundary(phase, attempt)
  })
  const stableTransform = createStableContextTransform()
  const { contextWindow: usageContextWindow, budget: usageBudget } = { contextWindow, budget }

  let historyForModel = history
  try {
    historyForModel = await compactHistoryForModel(
      history,
      overrides?.conversationId,
      historyModelConfig,
      { signal: lifecycleSignal }
    )
  } catch (error) {
    if (!lifecycleSignal.aborted) {
      console.warn('[Compactor] pi-core 压缩流程异常，回退全量历史:', safeErrorMessage(error))
    }
  }
  // Match legacy timing: snapshot volatile facts only after pre-compaction has
  // settled, then reuse the same snapshot for any transient Agent rebuild.
  const runtimeContext = buildOpenPipalRuntimeContext(overrides?.conversationId)
  let historyCompacted = historyForModel.length < history.length
  let trailMeasure = measureToolTrail(historyForModel)
  let activeBundle: AgentBundle | undefined
  let turnActive = false
  let interruptedByQuestion = false
  let eventMappingFailed = false
  let hasToolActivity = false
  let watchdogTriggered = false
  let currentWatchdog: ReturnType<typeof createStallWatchdog> | undefined
  let lastSystemHash = ''
  let lastToolsHash = ''
  let abortTask: Promise<void> | undefined
  let activeTurnObservation: ActiveTurnObservation | undefined
  let nextTurnObservation = 0
  const observeTurn = (
    phase: RuntimeTurnPhase,
    outcome?: 'completed' | 'provider_error' | 'agent_aborted' | 'external_abort' | 'watchdog' | 'event_mapping_failed' | 'lifecycle_abort' | 'failed_before_assistant',
    streamAttempt?: number
  ): void => {
    const observation = activeTurnObservation
    if (!observation) return
    const record = {
      kind: 'runtime_turn' as const,
      runtime: 'pi-core' as const,
      conv: conversationShort,
      model: modelConfig.model,
      source,
      sequence: observation.sequence,
      phase,
      elapsedMs: Math.max(0, Date.now() - observation.startedAt),
      firstModelEvent: observation.firstModelEvent,
      ...(streamAttempt === undefined ? {} : { streamAttempt }),
      ...(outcome ? { outcome } : {})
    }
    appendUsageRecord(record)
    console.log(`[RuntimeTurn] ${JSON.stringify(record)}`)
  }
  recordStreamBoundary = (phase, attempt) => observeTurn(phase, undefined, attempt)
  const markFirstModelEvent = (): void => {
    if (!activeTurnObservation || activeTurnObservation.firstModelEvent) return
    activeTurnObservation.firstModelEvent = true
    observeTurn('first_model_event')
  }
  const runningHandleController = createStableRunningHandle(
    () => activeBundle?.agent,
    () => turnActive
  )
  const closeRunningHandleForAbort = (): void => {
    runningHandleController.close('OpenPipal Agent run was aborted or its event consumer closed')
  }
  lifecycleSignal.addEventListener('abort', closeRunningHandleForAbort, { once: true })
  if (lifecycleSignal.aborted) closeRunningHandleForAbort()

  const requestAbort = (): Promise<void> => {
    if (abortTask) return abortTask
    const agent = activeBundle?.agent
    if (!agent) return Promise.resolve()
    abortTask = Promise.resolve()
      .then(() => {
        agent.clearAllQueues()
        agent.abort()
        return agent.waitForIdle()
      })
      .catch((error) => {
        if (!lifecycleSignal.aborted) console.warn('[AgentRuntime] pi-core abort cleanup:', safeErrorMessage(error))
      })
      .finally(() => { abortTask = undefined })
    return abortTask!
  }

  const abortAgentForExternalSignal = (): void => {
    observeTurn('external_abort')
    void requestAbort()
  }
  signal?.addEventListener('abort', abortAgentForExternalSignal, { once: true })

  const createBundle = async (messages: AgentMessage[]): Promise<AgentBundle> => {
    const current = messages[messages.length - 1]
    const prompt = splitUserMessage(current)
    const prefix = prompt ? messages.slice(0, -1) : messages
    const authorizer = new PiCoreToolAuthorizer({
      conversationId: overrides?.conversationId,
      onConfirmation: permissionHandler,
      scope: { workspaceId: workspace.workspaceId, workingDir: workspace.workingDir }
    })
    const cleanups: Array<() => void> = []

    const streamFn = withSessionStreamOptions(
      (activeModel, context, options) => models.streamSimple(
        activeModel,
        context,
        {
          ...options,
          cacheRetention: options?.cacheRetention ?? resolveCacheRetentionForModel(activeModel)
        }
      ),
      modelConfig
    )

    const agent = new Agent({
      initialState: {
        systemPrompt,
        model,
        thinkingLevel,
        tools: builtTools.tools,
        messages: prefix
      },
      sessionId: overrides?.conversationId,
      // Match the legacy Runtime's request boundary: the conversation key is
      // explicit for this exact request rather than relying solely on a
      // provider-level credential resolver. This keeps concurrent presets
      // isolated and avoids provider adapters that ignore deferred auth.
      streamFn,
      transformContext: async (contextMessages) => {
        try {
          return await stableTransform(contextMessages)
        } catch (error) {
          console.warn('[AgentRuntime] pi-core context transform failed; using original context:', safeErrorMessage(error))
          return contextMessages
        }
      },
      onPayload: (payload) => {
        try {
          const observedPayload = payload as any
          const payloadMessages: any[] = observedPayload?.messages || observedPayload?.input || []
          const system = payloadMessages.find?.((message: any) => message?.role === 'system')
          const systemText = typeof system?.content === 'string'
            ? system.content
            : JSON.stringify(system?.content ?? '')
          lastSystemHash = createHash('sha256').update(systemText).digest('hex').slice(0, 12)
          lastToolsHash = createHash('sha256').update(JSON.stringify(observedPayload?.tools || [])).digest('hex').slice(0, 12)
          console.log(`[Payload] runtime=pi-core conv=${conversationShort} sys=${lastSystemHash} sysLen=${systemText.length} msgs=${payloadMessages.length} tools=${lastToolsHash}`)
        } catch (error) {
          console.warn('[Payload] pi-core 观测失败:', safeErrorMessage(error))
        }
        return adaptModelRequestPayload(
          payload,
          modelConfig,
          thinkingLevel === 'off' ? undefined : { reasoningEffort: thinkingLevel }
        )
      },
      beforeToolCall: (event, runSignal) => {
        if (interruptedByQuestion) {
          return Promise.resolve({
            block: true,
            reason: '等待用户回答，已阻止同批次中的后续工具调用',
            terminate: true
          })
        }
        return authorizer.authorize(event, runSignal)
      },
      afterToolCall: async (event) => {
        const patch = buildPiCoreAfterToolCallPatch(event)
        if (patch?.terminate) interruptedByQuestion = true
        return patch
      },
      shouldStopAfterTurn: () => interruptedByQuestion,
      toolExecution: 'sequential',
      steeringMode: 'one-at-a-time',
      followUpMode: 'one-at-a-time'
    })

    cleanups.push(agent.subscribe((event) => {
      if (eventMappingFailed) return
      try {
        if (isPiAgentEvent(event)) {
          if (
            event.type === 'message_update'
            || (
              event.type === 'message_end'
              && !lifecycleSignal.aborted
              && !watchdogTriggered
              && (event.message as { role?: unknown } | undefined)?.role === 'assistant'
            )
          ) {
            markFirstModelEvent()
          }
          if (event.type === 'tool_execution_start') {
            hasToolActivity = true
            currentWatchdog?.disarm()
          }
          else if (event.type === 'tool_execution_end') currentWatchdog?.arm()
          else if (event.type !== 'tool_execution_update') currentWatchdog?.arm()

          if (event.type === 'message_end') {
            const message = event.message as any
            if (message?.stopReason === 'error') {
              eventQueue.push({ type: 'error', content: message.errorMessage || 'LLM 返回错误（无内容）' })
            }
            if (message?.role === 'assistant' && message.usage) {
              usage.calls += 1
              const input = message.usage.input || 0
              const cacheRead = message.usage.cacheRead || 0
              const cacheWrite = message.usage.cacheWrite || 0
              const output = message.usage.output || 0
              const promptTokens = input + cacheRead + cacheWrite
              const hit = promptTokens > 0 ? Math.round((cacheRead / promptTokens) * 100) : 0
              usage.input += input
              usage.cacheRead += cacheRead
              usage.cacheWrite += cacheWrite
              usage.output += output
              recordMeasuredPromptTokens(overrides?.conversationId, modelConfig.model, promptTokens)
              appendUsageRecord({
                kind: 'call', conv: conversationShort, model: modelConfig.model, seq: usage.calls,
                input, cacheRead, cacheWrite, output, prompt: promptTokens, hit,
                trailTok: trailMeasure.tokens, trailMsgs: trailMeasure.count,
                histMsgs: historyForModel.length, compacted: historyCompacted
              })
              const warmContext = usage.calls > 1 || prefix.length > 0
              if (warmContext && promptTokens > 8000 && hit < 50) {
                console.warn(`[CacheMiss] runtime=pi-core conv=${conversationShort} call#${usage.calls} hit=${hit}% cacheWrite=${cacheWrite} input=${input} sys=${lastSystemHash} tools=${lastToolsHash}`)
              }
              eventQueue.push({
                type: 'context_usage',
                promptTokens,
                contextWindow: usageContextWindow,
                budget: usageBudget,
                compacted: historyCompacted
              })
            }
          }

          for (const openpipalEvent of adapter.adapt(event)) {
            if (openpipalEvent.type === 'ask_user' || openpipalEvent.type === 'questions_v2') {
              interruptedByQuestion = true
            }
            eventQueue.push(openpipalEvent)
          }
        }
      } catch (error) {
        if (eventMappingFailed) return
        eventMappingFailed = true
        const message = safeErrorMessage(error)
        console.error('[AgentRuntime] pi-core event mapping failed:', message)
        eventQueue.push({ type: 'error', content: `Agent 事件适配失败: ${message}` })
        lifecycleController.abort(error)
        void requestAbort()
      }
    }))

    return {
      agent,
      prompt,
      dispose: () => {
        for (const cleanup of cleanups.splice(0).reverse()) cleanup()
      }
    }
  }

  const seedMessages = (projection: ChatMessage[]): AgentMessage[] => {
    const messages = convertHistoryToPiMessages(projection, overrides?.conversationId)
    const current = messages[messages.length - 1]
    if (current && runtimeContext) appendRuntimeContext(current, runtimeContext)
    return messages
  }

  const runPrompt = async (bundle: AgentBundle, prompt: PromptInput): Promise<AssistantMessage> => {
    // Each Agent.prompt is a distinct OpenPipal phase. Adapter streaming/fallback
    // state must not leak from the prior phase, while tool turns inside this
    // prompt continue to share the same state.
    adapter.reset()
    if (lifecycleSignal.aborted) throw new Error('Agent run aborted')
    const observation: ActiveTurnObservation = {
      sequence: ++nextTurnObservation,
      startedAt: Date.now(),
      firstModelEvent: false
    }
    activeTurnObservation = observation
    observeTurn('started')
    currentWatchdog?.disarm()
    currentWatchdog = createStallWatchdog(MODEL_STALL_TIMEOUT_MS, () => {
      if (watchdogTriggered) return
      watchdogTriggered = true
      observeTurn('watchdog')
      eventQueue.push({
        type: 'error',
        // 语言中立哨兵，渲染层翻译——记录不得随界面语言变化（见 shared/runtime-notice.ts）
        content: formatModelStallNotice(MODEL_STALL_TIMEOUT_MS / 1000)
      })
      void requestAbort()
    })
    currentWatchdog.arm()
    const messageStart = bundle.agent.state.messages.length
    turnActive = true
    const task = bundle.agent.prompt(prompt.text, prompt.images)
    let reply: AssistantMessage | undefined
    try {
      await runningHandleController.flushPendingToAgent(bundle.agent)
      await task
      // Agent drains normal steer/follow-up queues itself. A message accepted
      // in the final polling tail can remain queued after prompt() settles;
      // continue it here exactly once before the OpenPipal handle goes idle.
      turnActive = false
      while (
        bundle.agent.hasQueuedMessages()
        && !lifecycleSignal.aborted
        && !watchdogTriggered
        && !interruptedByQuestion
      ) {
        turnActive = true
        await bundle.agent.continue()
        turnActive = false
      }
      reply = findLastAssistantMessage(bundle.agent.state.messages, messageStart)
      if (!reply) throw new Error('Pi Agent settled without an assistant message')
      return reply
    } finally {
      turnActive = false
      currentWatchdog.disarm()
      const outcome = watchdogTriggered
        ? 'watchdog'
        : eventMappingFailed
          ? 'event_mapping_failed'
          : signal?.aborted
            ? 'external_abort'
            : lifecycleSignal.aborted
              ? 'lifecycle_abort'
              : reply?.stopReason === 'error'
                ? 'provider_error'
                : reply?.stopReason === 'aborted'
                  ? 'agent_aborted'
                  : reply
                    ? 'completed'
                    : 'failed_before_assistant'
      observeTurn('settled', outcome)
      if (activeTurnObservation === observation) activeTurnObservation = undefined
    }
  }

  const retryEmptyCompletion = async (
    bundle: AgentBundle
  ): Promise<{ bundle: AgentBundle; reply: AssistantMessage; stillEmpty: boolean }> => {
    // Rebuild from the flat execution context instead of truncating back to the
    // original user. Truncation would also discard
    // any successful toolCall/toolResult pairs produced before the empty final
    // assistant message.
    const beforeRetry = [...bundle.agent.state.messages]
    for (let index = beforeRetry.length - 1; index >= 0; index--) {
      if (beforeRetry[index].role === 'assistant' && isEmptySuccessfulAssistantMessage(beforeRetry[index])) {
        beforeRetry.splice(index, 1)
        break
      }
    }
    bundle.dispose()
    adapter.reset()
    const retryMessage = {
      role: 'user',
      content: [{ type: 'text', text: EMPTY_COMPLETION_RETRY_PROMPT }],
      timestamp: Date.now()
    } as AgentMessage
    const retryBundle = await createBundle([...beforeRetry, retryMessage])
    activeBundle = retryBundle
    if (!retryBundle.prompt) throw new Error('pi-core empty-completion retry lost its prompt')
    const retry = await runPrompt(retryBundle, retryBundle.prompt)
    const stillEmpty = isEmptySuccessfulAssistantMessage(retry)
    if (stillEmpty || retry.stopReason === 'error' || retry.stopReason === 'aborted') {
      return { bundle: retryBundle, reply: retry, stillEmpty }
    }

    // The retry itself may execute tools. Preserve its complete tool trail, but
    // remove the internal user scaffold before subsequent goal/queue turns.
    const cleanMessages = [...retryBundle.agent.state.messages]
    for (let index = cleanMessages.length - 1; index >= 0; index--) {
      const message = cleanMessages[index]
      if (message.role === 'user' && contentText(message.content, '').includes(EMPTY_COMPLETION_RETRY_PROMPT)) {
        cleanMessages.splice(index, 1)
        break
      }
    }
    retryBundle.dispose()
    const cleanBundle = await createBundle(cleanMessages)
    activeBundle = cleanBundle
    return { bundle: cleanBundle, reply: retry, stillEmpty: false }
  }

  const reportEmptyFailure = (overflow: boolean): void => {
    eventQueue.push({
      type: 'error',
      content: overflow
        ? '会话上下文已达模型窗口上限，当前续跑无法安全压缩并重放。建议开个新会话继续，或切换到上下文窗口更大的模型。'
        : '模型连续两次结束，但都没有返回正文或工具调用。这通常是服务商的流式响应不完整，请重试或降低思考强度。'
    })
  }

  const runContinuation = async (
    bundle: AgentBundle,
    prompt: PromptInput
  ): Promise<{ bundle: AgentBundle; reply: AssistantMessage; ok: boolean }> => {
    let reply = await runPrompt(bundle, prompt)
    if (lifecycleSignal.aborted || watchdogTriggered || reply.stopReason === 'error' || reply.stopReason === 'aborted') {
      return { bundle, reply, ok: false }
    }
    if (!isEmptySuccessfulAssistantMessage(reply)) return { bundle, reply, ok: true }

    // The OpenPipal compactor operates on the durable transcript. Once this
    // in-memory execution has already advanced, replaying only the old durable
    // history could repeat side effects. Fail explicitly on later overflow;
    // non-overflow empty completions can be retried without replaying work.
    if (isContextOverflowCompletion(reply, usageContextWindow)) {
      reportEmptyFailure(true)
      return { bundle, reply, ok: false }
    }
    const retry = await retryEmptyCompletion(bundle)
    bundle = retry.bundle
    reply = retry.reply
    if (retry.stillEmpty) reportEmptyFailure(false)
    const ok = !retry.stillEmpty
      && !lifecycleSignal.aborted
      && !watchdogTriggered
      && reply.stopReason !== 'error'
      && reply.stopReason !== 'aborted'
    return { bundle, reply, ok }
  }

  const closeAndDrainAcceptedInputs = async (): Promise<void> => {
    // close() is synchronous: no new caller can slip between the final queue
    // observation and runTask settlement. Deliveries accepted while the
    // Harness was active settle first; only tail-window fallbacks remain here.
    runningHandleController.close('OpenPipal Agent run has settled')
    await runningHandleController.settleDeliveries()
    if (lifecycleSignal.aborted || watchdogTriggered || interruptedByQuestion) return

    let bundle = activeBundle
    if (!bundle) return
    while (!lifecycleSignal.aborted && !watchdogTriggered && !interruptedByQuestion) {
      const queued = runningHandleController.shiftPending()
      if (!queued) break
      const input = runtimeInputToPrompt(queued.input)
      const continuation = await runContinuation(bundle, input)
      bundle = continuation.bundle
      if (!continuation.ok) break
    }
  }

  const runTask = (async (): Promise<void> => {
    try {
      let bundle = await createBundle(seedMessages(historyForModel))
      activeBundle = bundle

      // Legacy parity: expose the stable handle after construction even when the
      // supplied history has no executable final user message.
      onAgentReady?.(runningHandleController.handle)
      if (!bundle.prompt) return
      if (lifecycleSignal.aborted) {
        await requestAbort()
        return
      }

      let reply = await runPrompt(bundle, bundle.prompt)
      if (lifecycleSignal.aborted || watchdogTriggered) return
      if (isEmptySuccessfulAssistantMessage(reply) && !lifecycleSignal.aborted) {
        if (isContextOverflowCompletion(reply, usageContextWindow)) {
          if (hasToolActivity) {
            eventQueue.push({
              type: 'error',
              content: '会话上下文已达模型窗口上限，但本轮已经调用过工具。为避免自动重放造成重复写入或重复操作，系统没有重试；请开个新会话继续，或切换到上下文窗口更大的模型。'
            })
            return
          }
          let compacted: ChatMessage[] | undefined
          try {
            compacted = await compactHistoryForModel(
              history,
              overrides?.conversationId,
              historyModelConfig,
              { force: true, signal: lifecycleSignal }
            )
          } catch (error) {
            console.warn('[Compactor] pi-core overflow recovery failed:', safeErrorMessage(error))
          }
          if (!compacted || compacted === history) {
            eventQueue.push({
              type: 'error',
              content: '会话上下文已达模型窗口上限，且当前历史已无可压缩空间。建议开个新会话继续，或切换到上下文窗口更大的模型。'
            })
            return
          }
          bundle.dispose()
          adapter.reset()
          historyForModel = compacted
          historyCompacted = true
          trailMeasure = measureToolTrail(compacted)
          bundle = await createBundle(seedMessages(compacted))
          activeBundle = bundle
          if (!bundle.prompt) return
          reply = await runPrompt(bundle, bundle.prompt)
          if (isEmptySuccessfulAssistantMessage(reply)) {
            eventQueue.push({
              type: 'error',
              content: '会话上下文已达模型窗口上限，自动压缩后仍无法继续。建议开个新会话继续这项工作，或切换到上下文窗口更大的模型。'
            })
            return
          }
        } else {
          const retry = await retryEmptyCompletion(bundle)
          bundle = retry.bundle
          reply = retry.reply
          if (retry.stillEmpty) {
            eventQueue.push({
              type: 'error',
              content: '模型连续两次结束，但都没有返回正文或工具调用。这通常是服务商的流式响应不完整，请重试或降低思考强度。'
            })
            return
          }
        }
      }

      if (reply.stopReason === 'error' || reply.stopReason === 'aborted' || watchdogTriggered) return

      const goal: ConversationGoal | undefined = overrides?.goal ? { ...overrides.goal } : undefined
      while (!lifecycleSignal.aborted && !interruptedByQuestion && !watchdogTriggered) {
        await runningHandleController.settleDeliveries()
        const first = runningHandleController.shiftPending()
        if (first) {
          const input = runtimeInputToPrompt(first.input)
          const continuation = await runContinuation(bundle, input)
          bundle = continuation.bundle
          if (!continuation.ok) break
          continue
        }
        if (!goal || goal.status !== 'active') break
        if (goal.turnsUsed >= goal.maxTurns || goal.consecutiveBlocks >= 3) {
          goal.status = 'exceeded'
          eventQueue.push({ type: 'goal_update', goal: { ...goal } })
          break
        }

        let checkResult
        try {
          checkResult = await checkGoal({
            goal,
            recentMessages: extractRecentForCheck(bundle.agent.state.messages),
            llm: createAgentGoalChecker(models, model, modelConfig),
            signal: lifecycleSignal
          })
        } catch (error) {
          console.error('[Goal] pi-core checker 异常:', safeErrorMessage(error))
          checkResult = { ok: true, reason: 'checker exception', fallback: true }
        }
        goal.lastCheck = {
          ok: checkResult.ok,
          reason: checkResult.reason,
          fallback: checkResult.fallback,
          timestamp: Date.now()
        }
        if (checkResult.ok) {
          goal.status = 'done'
          eventQueue.push({ type: 'goal_update', goal: { ...goal } })
          break
        }
        goal.turnsUsed += 1
        goal.consecutiveBlocks += 1
        eventQueue.push({ type: 'goal_update', goal: { ...goal } })
        const continuation = await runContinuation(bundle, { text: buildContinuationHint(goal, checkResult) })
        bundle = continuation.bundle
        if (!continuation.ok) break
      }
    } finally {
      await closeAndDrainAcceptedInputs()
    }
  })()
    .catch((error) => {
      if (!lifecycleSignal.aborted && !watchdogTriggered) {
        console.error('[AgentRuntime] pi-core run failed:', error)
        eventQueue.push({ type: 'error', content: safeErrorMessage(error) || 'Agent 执行失败' })
      }
    })
    .finally(() => eventQueue.done())

  try {
    for await (const event of eventQueue) {
      yield event
      if (event.type === 'ask_user' || event.type === 'questions_v2') {
        await requestAbort()
        break
      }
    }
    await runTask
  } finally {
    lifecycleController.abort(new Error('Agent Runtime consumer closed'))
    lifecycleSignal.removeEventListener('abort', closeRunningHandleForAbort)
    signal?.removeEventListener('abort', forwardExternalAbort)
    signal?.removeEventListener('abort', abortAgentForExternalSignal)
    currentWatchdog?.disarm()
    await requestAbort()
    await runTask
    await requestAbort()
    await activeBundle?.agent.waitForIdle().catch(() => undefined)
    activeBundle?.dispose()
    await builtTools.dispose()
    adapter.reset()
    eventQueue.done()
    const promptTokens = usage.input + usage.cacheRead + usage.cacheWrite
    const hit = promptTokens > 0 ? Math.round((usage.cacheRead / promptTokens) * 100) : 0
    console.log(`[Usage:turn] runtime=pi-core conv=${conversationShort} calls=${usage.calls} input=${usage.input} cacheRead=${usage.cacheRead} hit=${hit}%`)
    if (usage.calls > 0) {
      appendUsageRecord({
        kind: 'turn', conv: conversationShort, model: modelConfig.model, calls: usage.calls,
        input: usage.input, cacheRead: usage.cacheRead, cacheWrite: usage.cacheWrite,
        output: usage.output, hit
      })
    }
  }
}

export async function testThinkingSupport(testConfig: ModelConfig): Promise<{
  detected: boolean
  error?: string
}> {
  let agent: Agent | undefined
  let unsubscribe: (() => void) | undefined
  let detected = false
  let timedOut = false
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    const configuredModel = buildModelFromConfig(testConfig)
    const model = { ...configuredModel, reasoning: true } as Model<any>
    const models = createOpenPipalPiCoreModels(model, testConfig)
    agent = new Agent({
      initialState: {
        model,
        systemPrompt: '请简短回答，并在支持时使用思考能力。',
        thinkingLevel: 'low',
        tools: [],
        messages: []
      },
      streamFn: (activeModel, context, options) => models.streamSimple(
        activeModel,
        context,
        {
          ...options,
          cacheRetention: options?.cacheRetention ?? resolveCacheRetentionForModel(activeModel)
        }
      )
    })
    unsubscribe = agent.subscribe((event) => {
      if (event.type === 'message_update') {
        const update = event.assistantMessageEvent as any
        if (update?.type === 'thinking_start' || update?.type === 'thinking_delta') detected = true
      }
      if (event.type === 'message_end') {
        const message = event.message as any
        if (Array.isArray(message?.content)) {
          detected ||= message.content.some((block: any) => block?.type === 'thinking' && block.thinking)
        }
      }
    })
    timeout = setTimeout(() => {
      timedOut = true
      agent?.abort()
    }, 30_000)
    await agent.prompt('请只回答：1+1 等于多少？')
    if (timedOut) {
      return detected
        ? { detected: true }
        : { detected: false, error: '检测超时（30秒未完成）' }
    }
    const result = findLastAssistantMessage(agent.state.messages)
    if (!result) return { detected: false, error: '模型未返回 assistant 消息' }
    if (result.stopReason === 'error') return { detected: false, error: result.errorMessage || '模型返回错误' }
    if (result.stopReason === 'aborted') return { detected: false, error: result.errorMessage || '检测已取消' }
    return { detected }
  } catch (error) {
    return { detected: false, error: safeErrorMessage(error) }
  } finally {
    if (timeout) clearTimeout(timeout)
    agent?.clearAllQueues()
    agent?.abort()
    await agent?.waitForIdle().catch(() => undefined)
    unsubscribe?.()
  }
}

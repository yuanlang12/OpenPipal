/**
 * Pi Agent Service
 * 核心引擎：用 Pi 框架的 Agent 类替代原有的 OpenAI SDK 循环。
 * 保持 agentChat() 的 AsyncGenerator 签名不变，前端零改动。
 */

import { Agent } from '@earendil-works/pi-agent-core'
import type { AgentEvent as PiAgentEvent, AgentMessage } from '@earendil-works/pi-agent-core'
import { resolveExecutionRoleName } from './agent-overrides'
import { createHash } from 'crypto'
import { measureToolTrail } from './tool-trail'
import { appendUsageRecord, type RuntimeTurnPhase } from './usage-log'
import { formatModelStallNotice } from '../shared/runtime-notice'

/**
 * 等模型说话的静默上限。超过就判服务无响应、中断本轮并明确告诉用户（见 8.1b 看门狗）。
 * 60s 的取法：思考型模型的推理内容是流式回传的（每个 delta 都续命），真正持续一分钟
 * 一个字节都不来的通常是挂起的连接；再长用户已经会把应用判断为卡死。
 * 环境变量可覆盖（值 <=0 关闭看门狗）——不同网关的限流行为差别大，留个不用重编译的旋钮。
 */
import {
  resolveConversationModelConfig,
  buildModelFromConfig,
  ensurePiApiKeyFor,
  withSessionStreamOptions,
  adaptModelRequestPayload,
  createModelPayloadAdapter,
  resolveAuxThinkingLevel,
  supportsEffortDial,
  type ModelConfig
} from './config-manager'
import { readToolsConfig } from './agent-workspace-store'
import { join } from 'path'
import { homedir } from 'os'
import { buildPiTools, AskUserResolver } from './pi-tools'
import { buildMcpBridgeTools } from './pi-mcp-bridge'
import { PiEventAdapter } from './pi-event-adapter'
import { createSecurityHook, type PermissionHandler } from './pi-security'
import { createStableContextTransform } from './context-window-policy'
import { compactHistoryForModel, getContextBudget, recordMeasuredPromptTokens } from './history-compactor'
import {
  checkGoal,
  buildContinuationHint,
  type ConversationGoal,
  type GoalCheckerLLM
} from './goal-checker'
import { promptWithEmptyCompletionRetry } from './empty-completion-guard'
import {
  createIsolatedStreamSimple,
  isolatedStreamSimple,
  type StreamBoundaryPhase
} from './isolated-stream-signal'
import { createStallWatchdog, resolveModelStallTimeoutMs } from './stall-watchdog'
import type {
  AgentEvent,
  AgentOverrides,
  ChatMessage,
  ChatSource,
  RunningAgentHandle
} from './agent-runtime/contracts'
import { filterToolsForChatSource } from './agent-runtime/source-tool-policy'
import {
  buildPiUserMessage,
  buildRuntimeContextMessage,
  convertHistoryToPiMessages
} from './agent-runtime/pi-message-conversion'
import { AsyncQueue } from './agent-runtime/async-queue'
import {
  buildOpenPipalRuntimeContext,
  buildOpenPipalSystemPrompt,
  prepareOpenPipalSystemPrompt
} from './agent-runtime/openpipal-prompt'
import { buildSkillPromptSection } from './skill-manager'
import {
  buildContextUsageSegments,
  estimateTextTokens,
  estimateToolTokens,
  isMcpToolName
} from './context-usage-stats'
import { dataPath } from './data-root'

// Backward-compatible type exports while callers migrate to agent-runtime.
export type {
  AgentEvent,
  AgentOverrides,
  ChatMessage,
  ChatSource,
  RunningAgentHandle,
  RuntimeUserInput
} from './agent-runtime/contracts'

export { buildPiUserMessage, toPiImageBlock } from './agent-runtime/pi-message-conversion'

const MODEL_STALL_TIMEOUT_MS = resolveModelStallTimeoutMs(process.env.OPENPIPAL_STALL_TIMEOUT_MS)

// One product-owned prompt implementation feeds both Runtime adapters.
export const buildSystemPrompt = buildOpenPipalSystemPrompt
export const buildRuntimeContext = buildOpenPipalRuntimeContext

// ---- 核心 API（保持签名不变！） ----

// 模块级权限处理器（由 ipc-handlers 在启动时注入）
let _permissionHandler: PermissionHandler | undefined

export function setPermissionHandler(handler: PermissionHandler): void {
  _permissionHandler = handler
}

// ---- Goal loop helpers --------------------------------------------------

/**
 * 把 Pi 的消息格式(可能是 string 或 ContentBlock[])摊平成 GoalChecker 用的
 * 简单 { role, content: string }[] — content 只取 text 块拼接。
 * 系统消息不参与判定(GoalChecker system prompt 已覆盖)。
 */
function extractRecentForCheck(
  piMessages: AgentMessage[]
): Array<{ role: string; content: string }> {
  return piMessages
    .filter((m: any) => m.role !== 'system')
    .map((m: any) => {
      const content = m.content
      if (typeof content === 'string') {
        return { role: String(m.role), content }
      }
      if (Array.isArray(content)) {
        const text = content
          .filter((b: any) => b?.type === 'text' && typeof b.text === 'string')
          .map((b: any) => b.text)
          .join('\n')
        return { role: String(m.role), content: text || '[non-text content]' }
      }
      return { role: String(m.role), content: '' }
    })
}

/**
 * 把 Pi model 包成 GoalCheckerLLM 函数 — 启一个一次性 Agent(无工具)做判定。
 * 借用 testThinkingSupport 同款套路:subscribe + message_end 收尾。
 * 任何错误抛出,由 checkGoal() 内部 try/catch 转成 fallback=true。
 */
function createPiGoalCheckerLLM(model: any, modelConfig: ModelConfig): GoalCheckerLLM {
  return ({ systemPrompt, userPrompt, signal: innerSignal }) => {
    return new Promise<string>((resolve, reject) => {
      let subAgent: Agent
      try {
        subAgent = new Agent({
          initialState: {
            systemPrompt,
            model,
            tools: [],
            // 不能硬编码 'off'：qwen3.8-max-preview 等强制思考的模型 400 拒绝关思考,
            // GoalChecker 每轮静默失败走 fallback=true(fail-open 放行,判定形同虚设)
            thinkingLevel: resolveAuxThinkingLevel(modelConfig, model),
            messages: []
          },
          toolExecution: 'sequential',
          streamFn: withSessionStreamOptions(isolatedStreamSimple, modelConfig),
          onPayload: createModelPayloadAdapter(modelConfig)
        })
      } catch (err: any) {
        reject(new Error(`GoalChecker agent 创建失败: ${err?.message || err}`))
        return
      }

      let settled = false
      let collected = ''

      // abort 联动:外层 signal 或 checker 自带 signal 任一触发都中止。
      // 先创建稳定函数引用，finish 才能在成功/失败收尾时精确移除同一个监听器。
      const onAbort = (): void => {
        try { subAgent.abort() } catch { /* agent 可能已自然结束 */ }
        finish(() => reject(new Error('GoalChecker aborted')))
      }

      const finish = (cb: () => void): void => {
        if (settled) return
        settled = true
        try { unsub?.() } catch { /* 订阅可能已由 agent 收尾 */ }
        if (innerSignal) innerSignal.removeEventListener('abort', onAbort)
        cb()
      }

      const unsub = subAgent.subscribe((event: PiAgentEvent) => {
        const evt = event as any
        // 流式 text delta 也累加,兜底某些 provider 不带 text 块
        if (evt.type === 'text_delta' && typeof evt.text === 'string') {
          collected += evt.text
        }
        if (evt.type === 'message_end') {
          const msg = evt.message
          if (msg?.stopReason === 'error') {
            finish(() => reject(new Error(msg.errorMessage || 'GoalChecker LLM error')))
            return
          }
          if (Array.isArray(msg?.content)) {
            const text = msg.content
              .filter((b: any) => b?.type === 'text' && typeof b.text === 'string')
              .map((b: any) => b.text)
              .join('')
            if (text) collected = text  // 整段优先于 delta 累加
          } else if (typeof msg?.content === 'string' && msg.content) {
            collected = msg.content
          }
          finish(() => resolve(collected))
        }
      })

      if (innerSignal?.aborted) { onAbort(); return }
      innerSignal?.addEventListener('abort', onAbort, { once: true })

      subAgent.prompt({
        role: 'user',
        content: userPrompt
      } as any).catch((err: any) => {
        finish(() => reject(new Error(err?.message || 'GoalChecker prompt 失败')))
      })
    })
  }
}

export async function* agentChat(
  history: ChatMessage[],
  signal?: AbortSignal,
  source: ChatSource = 'desktop',
  overrides?: AgentOverrides,
  onAgentReady?: (handle: RunningAgentHandle) => void
): AsyncGenerator<AgentEvent, void, undefined> {

  // Legacy composes tools before building its prompt. Normalize the role at
  // entry so both surfaces share one conversation-scoped snapshot even if a
  // different conversation switches the UI default later in this run.
  const roleName = resolveExecutionRoleName(overrides)
  overrides = overrides
    ? { ...overrides, roleName }
    : { systemPrompt: '', roleName }

  // Usage 观测：只读打点，不改任何业务行为（供 prompt 前缀缓存优化前后对比）
  const convIdShort = overrides?.conversationId ? overrides.conversationId.slice(0, 8) : '-'

  // 1. 合并 Agent tools/config.json 到工具配置
  const workspaceId = overrides?.workspaceId
  const toolsCfg = workspaceId ? readToolsConfig(workspaceId) : undefined
  const globalWs = dataPath('workspace')
  const workingDir = overrides?.workingDir || toolsCfg?.workingDir || globalWs

  // 2. 构建工具列表
  const askUserResolver = new AskUserResolver()
  const builtinTools = buildPiTools(source, askUserResolver, {
    tools: overrides?.tools,
    disabledTools: toolsCfg?.disabledTools,
    roleName: overrides?.roleName,
    workingDir,
    modelPresetId: overrides?.modelPresetId,
    workspaceId,
    conversationId: overrides?.conversationId,
    roleBrief: overrides?.roleBrief
  })
  const mcpTools = buildMcpBridgeTools(toolsCfg?.mcpServers, overrides?.conversationId, source)
  const allTools = filterToolsForChatSource(source, [...builtinTools, ...mcpTools])

  // 2. 获取模型配置，并确保 Pi 能找到 API key
  // 会话级解析：会话专属预设 > 全局默认；预设已删回退全局（picker 端有对应标注）。
  // key 经 withSessionStreamOptions 注入请求 options（pi-ai 显式 key 优先于 env）——并发互踩已根治；
  // ensurePiApiKeyFor 仍设 env 只作未覆盖路径的兜底。
  const resolvedModel = resolveConversationModelConfig(overrides?.modelPresetId)
  if (resolvedModel.danglingPresetId) {
    console.warn(`[Model] 会话预设 ${resolvedModel.danglingPresetId} 已不存在，回退全局默认`)
  }
  const mc = resolvedModel.config
  const model = buildModelFromConfig(mc)
  ensurePiApiKeyFor(model.provider, mc)
  // Pi 原生目录可能为用户未显式填写 contextWindow 的模型提供更准确的窗口值（如 Qwen Token Plan）。
  // 历史压缩和 usage 观测都必须按这个实际模型计算，不能回退到通用 131k 默认值。
  const modelContextWindow = Number((model as any).contextWindow)
  const historyModelConfig: ModelConfig = !mc.contextWindow && Number.isFinite(modelContextWindow) && modelContextWindow > 0
    ? { ...mc, contextWindow: modelContextWindow }
    : mc
  if (resolvedModel.source === 'conversation') {
    console.log(`[Model] conv=${convIdShort} 使用会话专属模型: ${mc.model}`)
  }

  // 3. 构建系统提示词。模型补丁跟随解析后的 preset，因此欢迎页选择、会话钉住和中途切换
  // 使用同一个不可歧义的模型配置；未配置补丁时与共同提示词逐字节一致。
  // 不走 buildSystemPrompt 包装，为的是拿到技能段原文做分区估算——render 参数与包装逐字节一致。
  const preparedPrompt = prepareOpenPipalSystemPrompt(source, overrides, { stablePrefix: true, modelConfig: mc })
  const skillSection = buildSkillPromptSection(preparedPrompt.skillContext)
  const systemPrompt = preparedPrompt.render(skillSection)
  // 用量卡分区：组装期各估算一次（口径见 context-usage-stats.ts 头注）
  const segmentEstimate = {
    systemPromptTokens: estimateTextTokens(systemPrompt),
    skillTokens: estimateTextTokens(skillSection),
    builtinToolTokens: estimateToolTokens(allTools.filter((t: any) => !isMcpToolName(t.name))),
    mcpToolTokens: estimateToolTokens(allTools.filter((t: any) => isMcpToolName(t.name)))
  }

  // 4. 创建 Pi Agent 实例
  // thinkingLevel 决策：
  //   1) 模型能力位：用户在 ModelConfig.supportsThinking 显式声明 → 优先；否则回落到 Pi 内置 model.reasoning
  //   2) 用户开关：overrides.thinkingEnabled 默认 true，用户在输入框关掉则为 false
  //   能力支持 + 用户想要 → 'low'，否则 'off'
  const modelSupportsThinking = mc.supportsThinking ?? !!(model as any).reasoning
  const userWantsThinking = overrides?.thinkingEnabled !== false
  // 档位：仅能力解析确认支持的模型采纳用户所选；纯开关模型回落 'low'。
  const dialLevel = (overrides?.thinkingLevel && supportsEffortDial(mc)) ? overrides.thinkingLevel : 'low'
  const thinkingLevel = (modelSupportsThinking && userWantsThinking) ? dialLevel : 'off'

  // 加载历史消息（先做"保近压远"压缩——只影响发给模型的载荷，UI/落盘历史不动）。
  // 仅按总 token 预算做整体历史压缩。工具轨迹和图片不再有独立的消息数/年龄窗口；
  // 它们与普通对话一起保留，直到整段历史接近模型上下文上限。
  const { contextWindow: usageContextWindow, budget: usageBudget } = getContextBudget(historyModelConfig)
  let historyForModel = history
  try {
    historyForModel = await compactHistoryForModel(history, overrides?.conversationId, historyModelConfig)
  } catch (err: any) {
    console.warn('[Compactor] 压缩流程异常，回退全量历史:', err?.message)
  }
  const piMessages = convertHistoryToPiMessages(historyForModel, overrides?.conversationId)
  // 轨迹实测：治理之后真正带出去多少——用量落盘据此回答"8000 预算配得对不对"
  // （let：溢出自愈重建历史后同步刷新，保证后续 usage 记录反映真实载荷）
  let trailMeasure = measureToolTrail(historyForModel)
  // context_usage 观测：本轮是否触发过压缩 + 同口径 contextWindow/budget（与 history-compactor 共用算法）
  // 传本会话解析出的 mc——会话专属模型的 contextWindow 可能与全局不同，预算按实际发往的模型算
  let historyCompacted = historyForModel.length < history.length

  // [CacheMiss] 告警用:留住最近一次请求的 system/tools 指纹,失配时对照 [Payload] 历史定位变动段
  let lastSysHash = ''
  let lastToolsHash = ''
  // Agent 在下面构造、观测器在稍后初始化；保留一个稳定闭包，确保每次 Provider
  // StreamFn 都能把本地边界回填到当时活跃的 OpenPipal turn。
  let recordStreamBoundary: (phase: StreamBoundaryPhase, attempt: number) => void = () => {}
  const sessionStreamFn = withSessionStreamOptions(
    createIsolatedStreamSimple({
      onStreamBoundary: (phase, attempt) => recordStreamBoundary(phase, attempt)
    }),
    mc
  )

  const agent = new Agent({
    initialState: {
      systemPrompt,
      model,
      tools: allTools,
      thinkingLevel,
      messages: [],
    },
    toolExecution: 'sequential',
    // 缓存路由键:pi-agent-core 原样转发给 provider("forwarded to providers for
    // cache-aware backends")。落线是门控的——OpenAI 官方 URL 才进请求体
    // prompt_cache_key,亲和 header 要 compat.sendSessionAffinityHeaders 显式开;
    // 第三方网关默认零请求变化,传了只赚不赔。
    sessionId: overrides?.conversationId,
    streamFn: sessionStreamFn,
    // ⚠️ 参数顺序:createSecurityHook(conversationId, onConfirmation)。
    // 之前误把 handler 当第一参传入 → conversationId 变成函数:
    //  (1) 不可结构化克隆 → 权限气泡序列化失败发不出去;
    //  (2) 站点轴 grant/decide 用函数当 key → 永不命中 → 每次写操作都重复弹确认。
    // conversationId 用真实会话 id,handler 作第二参回退(内联模式优先,弹窗模式兜底)。
    beforeToolCall: createSecurityHook(overrides?.conversationId, _permissionHandler, { workspaceId, workingDir }),
    // 只做与消息年龄无关的单条工具结果上限。旧工具结果、旧图片和工具入参不会在
    // assistant 消费后或跨过固定窗口时被改写；整体历史压缩由上面的 token 预算统一负责。
    transformContext: createStableContextTransform(),
    // Usage 观测 + 协议适配：先只读打点，再返回 GLM/Z.AI 等模型需要的兼容载荷。
    onPayload: (params: any) => {
      try {
        const messages: any[] = params?.messages || []
        const sysMsg = messages.find((m) => m?.role === 'system')
        const sysContent = sysMsg?.content
        const sysText = typeof sysContent === 'string' ? sysContent : JSON.stringify(sysContent ?? '')
        const sysHash = createHash('sha256').update(sysText).digest('hex').slice(0, 12)
        const toolsHash = createHash('sha256').update(JSON.stringify(params?.tools || [])).digest('hex').slice(0, 12)
        lastSysHash = sysHash
        lastToolsHash = toolsHash
        console.log(`[Payload] conv=${convIdShort} sys=${sysHash} sysLen=${sysText.length} msgs=${messages.length} tools=${toolsHash}`)
      } catch (err: any) {
        console.warn('[Payload] 观测失败:', err?.message)
      }
      return adaptModelRequestPayload(params, mc, thinkingLevel === 'off' ? undefined : { reasoningEffort: thinkingLevel })
    }
  })

    // 4b. 把 agent 句柄透出给调用方（用于 mid-loop steer / followUp 注入）
    onAgentReady?.({
      steer: ({ text, images }) => agent.steer(buildPiUserMessage(text, images)),
      followUp: ({ text, images }) => agent.followUp(buildPiUserMessage(text, images))
    })

  // 5. 事件适配器(queue 每轮新建,见 goal loop)
  const adapter = new PiEventAdapter()

  console.log(`[Pi] Agent 创建: ${allTools.length} 工具, 模型 ${model.id}/${model.provider}`)

  // 6. 处理中止信号(在所有 goal iteration 之间共享,每轮 queue 由各自 handler 收尾)
  let onAbort: (() => void) | undefined
  if (signal) {
    onAbort = () => {
      observeTurn('external_abort')
      agent.abort()
    }
    signal.addEventListener('abort', onAbort, { once: true })
  }

  // 7. 历史消息已在 Agent 构造前算好（piMessages），这里只负责灌入
  if (piMessages.length > 1) {
    for (let i = 0; i < piMessages.length - 1; i++) {
      agent.state.messages.push(piMessages[i])
    }
  }

  let currentMessage = piMessages[piMessages.length - 1]
  if (!currentMessage) {
    if (signal && onAbort) signal.removeEventListener('abort', onAbort)
    return
  }

  // 把 stablePrefix 从 system prompt 剔除的易变信息（时间/前台应用/产物清单）作为
  // 独立 user 消息追加在本轮首条用户消息之后。prompt cache 按字节前缀匹配：若快照
  // 不进历史，下一轮回放与缓存在"上一轮末条消息"处分歧，上一轮整段 assistant/tool
  // 流量全部 miss。因此除当轮追加外，还把快照原文经 runtime_context 事件回传渲染层，
  // 由渲染层作为 messageKind='runtime-context' 的隐藏消息落盘——下轮回放字节一致，
  // miss 收缩到最新一张纸条自身。
  // goal loop 的 continuation hint（下面 while 循环里重新赋值的 currentMessage）不再附加：
  // continuation 时已有更新过的当轮上下文，重复追加只会白白扩大不命中段。
  const runtimeContext = buildRuntimeContext(overrides?.conversationId)
  const runtimeContextMessage = runtimeContext ? buildRuntimeContextMessage(runtimeContext) : undefined
  let runtimeContextAnnounced = false
  // 独立 user 消息与首条用户消息连续；Anthropic(2024-10 起)与 OpenAI 系端点会合并为一个回合
  let promptPayload: AgentMessage | AgentMessage[] = runtimeContextMessage
    ? [currentMessage, runtimeContextMessage]
    : currentMessage

  // 溢出自愈：stopReason=length 且近零输出 = 载荷顶满窗口，盲目续跑只会更糟。
  // 撞墙的那次调用已把实报用量写进锚点（上面 recordMeasuredPromptTokens），
  // 这里强制压缩历史、整体重建 agent 状态，把重建后的末条 user 消息交回守卫重试。
  // 丢弃本轮已产生的中间消息是刻意的：它们正是挤爆窗口的载荷，模型会在压缩后的
  // 上下文里重做（工具本身幂等性由既有安全钩子把关，与普通重试同一风险面）。
  const rebuildAfterOverflow = async (): Promise<AgentMessage | AgentMessage[] | null> => {
    try {
      const compacted = await compactHistoryForModel(
        history, overrides?.conversationId, historyModelConfig, { force: true }
      )
      // 引用相等 = 压缩器判定无可压空间（极短会话/单条超大消息），自愈无从下手
      if (compacted === history) return null
      const rebuilt = convertHistoryToPiMessages(compacted, overrides?.conversationId)
      if (!rebuilt.length) return null
      historyForModel = compacted
      trailMeasure = measureToolTrail(compacted)
      historyCompacted = true
      const stateMessages = agent.state.messages
      stateMessages.length = 0
      for (let i = 0; i < rebuilt.length - 1; i++) stateMessages.push(rebuilt[i])
      const next = rebuilt[rebuilt.length - 1]
      console.log(`[Compactor] 溢出自愈：历史重建为压缩投影 ${rebuilt.length} 条，原地重试本轮`)
      return runtimeContextMessage ? [next, runtimeContextMessage] : next
    } catch (err: any) {
      console.warn('[Compactor] 溢出自愈压缩失败:', err?.message)
      return null
    }
  }

  // DEBUG: 仅首轮真实用户消息记录(continuation hint 是 plain text 不含图)
  const lmContent = (currentMessage as any).content
  if (Array.isArray(lmContent)) {
    const imgCount = lmContent.filter((c: any) => c.type === 'image').length
    const textCount = lmContent.filter((c: any) => c.type === 'text').length
    console.log(`[Pi] lastMessage: ${textCount} text + ${imgCount} image blocks`)
    if (imgCount > 0) {
      const img = lmContent.find((c: any) => c.type === 'image')
      console.log(`[Pi] image format: keys=${Object.keys(img).join(',')}, data.length=${img.data?.length || 'N/A'}`)
    }
  }

  // 8. Goal loop —— 无 goal 时只跑一次(等同历史行为);有 goal 时按 GoalChecker 反复 continuation
  // 克隆 goal,避免改到调用方对象;最终状态通过 yield 'goal_update' 让上层落盘
  const goal: ConversationGoal | undefined = overrides?.goal ? { ...overrides.goal } : undefined
  const MAX_CONSECUTIVE_BLOCKS = 3 // GoalChecker 连续判 false → 强停,防 evaluator 永远拒判

  // Usage 观测：本次 agentChat 内累计（跨 goal loop 多轮 LLM 调用）
  let usageCallSeq = 0
  let usageSumInput = 0
  let usageSumCacheRead = 0
  let usageSumCacheWrite = 0
  let usageSumOutput = 0
  // Runtime 试用期的最小可归因轨迹。只记阶段、时长和结果，绝不落 prompt、回复、
  // 凭据或底层异常。legacy 与 pi-core 必须同口径，否则“回滚后挂起”无法归因。
  let activeTurnObservation: {
    sequence: number
    startedAt: number
    firstModelEvent: boolean
  } | undefined
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
      runtime: 'legacy' as const,
      conv: convIdShort,
      model: mc.model,
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
  const markFirstModelEvent = (): void => {
    if (!activeTurnObservation || activeTurnObservation.firstModelEvent) return
    activeTurnObservation.firstModelEvent = true
    observeTurn('first_model_event')
  }
  recordStreamBoundary = (phase, attempt) => observeTurn(phase, undefined, attempt)

  try {
    while (true) {
      // 8.1 每轮新建 queue,复用 agent / adapter
      const eventQueue = new AsyncQueue<AgentEvent>()
      // 快照原文只广播一次（首轮）：渲染层据此落盘隐藏的 runtime-context 消息。
      // goal continuation 不重播——那会驱动渲染层在错误位置再插一张纸条。
      if (!runtimeContextAnnounced) {
        runtimeContextAnnounced = true
        if (runtimeContext) eventQueue.push({ type: 'runtime_context', text: runtimeContext })
      }
      const observation = {
        sequence: ++nextTurnObservation,
        startedAt: Date.now(),
        firstModelEvent: false
      }
      activeTurnObservation = observation
      observeTurn('started')
      let watchdogTriggered = false
      let promptFailed = false
      let promptStillEmpty = false
      let terminalStopReason: string | undefined
      let askUserBreak = false

      // 8.1b 静默看门狗 —— 只在"等模型说话"期间上弦
      //
      // 为什么要（永久架构，不是拐杖）：额度耗尽/网关限流时，服务方常常既不返错也不断流，
      // 只是把连接挂着。对话路径没有请求超时（config-manager 那套 timeoutMs 只服务连接测试），
      // 于是 agent 永远 await 一个不回的请求，UI 一直停在"深度思考"——用户看到的是应用卡死，
      // 而不是"服务商没额度了"。任何服务商、任何错误形态，都该有这层兜底。
      //
      // 工具执行期间必须撤弦：bash/render_artifact/subagent/MCP 本来就可能跑几分钟，
      // 权限气泡更是能等到 30 分钟。那段时间没有模型事件是正常的，不是卡死。
      const watchdog = createStallWatchdog(MODEL_STALL_TIMEOUT_MS, () => {
        if (watchdogTriggered) return
        watchdogTriggered = true
        observeTurn('watchdog')
        console.error(`[Pi] 静默 ${MODEL_STALL_TIMEOUT_MS}ms 无任何模型事件 —— 判定服务无响应，中断本轮`)
        eventQueue.push({
          type: 'error',
          // 语言中立哨兵，渲染层翻译——记录不得随界面语言变化（见 shared/runtime-notice.ts）
          content: formatModelStallNotice(MODEL_STALL_TIMEOUT_MS / 1000)
        })
        try { agent.abort() } catch { /* 已结束 */ }
        eventQueue.done()
      })
      const armStall = (): void => watchdog.arm()
      const disarmStall = (): void => watchdog.disarm()
      armStall()

      // 8.2 订阅本轮事件
      const unsubscribe = agent.subscribe(async (piEvent: PiAgentEvent) => {
        if (
          piEvent.type === 'message_update'
          || (
            piEvent.type === 'message_end'
            && !signal?.aborted
            && !watchdogTriggered
            && (piEvent.message as { role?: unknown } | undefined)?.role === 'assistant'
          )
        ) {
          markFirstModelEvent()
        }
        // 任何模型事件都算"还活着"；工具开跑撤弦、工具结束重新上弦
        if (piEvent.type === 'tool_execution_start') disarmStall()
        else armStall() // 触发后 arm 是空操作（看门狗自带上锁），迟到事件复活不了本轮
        if (piEvent.type === 'message_end') {
          const msg = piEvent.message as any
          if (msg?.role === 'assistant') terminalStopReason = msg.stopReason
          if (msg?.stopReason === 'error') {
            console.error(`[Pi] LLM 错误: ${msg.errorMessage}`)
            // 显式上报给前端,避免"静默无输出"——历史:stopReason==='error' 只 log 不上报,
            // 用户只看到发完即停、没有任何反馈(如图片格式被网关 400 拒绝)。
            eventQueue.push({ type: 'error', content: msg.errorMessage || 'LLM 返回错误(无内容)' })
          }
          // Usage 观测：每次 LLM 调用打一行，仅打点不改行为
          if (msg?.role === 'assistant' && msg.usage) {
            usageCallSeq += 1
            const input = msg.usage.input || 0
            const cacheRead = msg.usage.cacheRead || 0
            const cacheWrite = msg.usage.cacheWrite || 0
            const output = msg.usage.output || 0
            const denom = input + cacheRead + cacheWrite
            const hitPct = denom > 0 ? Math.round((cacheRead / denom) * 100) : 0
            // 证据式预算锚点：实报完整载荷喂回压缩判断（下一轮 compactHistoryForModel 读取）。
            // 字符估算漏报（代码密集/窗口配大/system+tools 不在估算范围）时，这条实测线兜底。
            recordMeasuredPromptTokens(overrides?.conversationId, mc.model, denom)
            usageSumInput += input
            usageSumCacheRead += cacheRead
            usageSumCacheWrite += cacheWrite
            usageSumOutput += output
            console.log(`[Usage] conv=${convIdShort} call#${usageCallSeq} input=${input} cacheRead=${cacheRead} cacheWrite=${cacheWrite} output=${output} hit=${hitPct}%`)
            // 同一份观测落盘一份：命中率与轨迹占比不可推断、只能实测（见 usage-log.ts）
            appendUsageRecord({
              kind: 'call', conv: convIdShort, model: mc.model, seq: usageCallSeq,
              input, cacheRead, cacheWrite, output, prompt: denom, hit: hitPct,
              trailTok: trailMeasure.tokens, trailMsgs: trailMeasure.count,
              histMsgs: historyForModel.length, compacted: historyCompacted,
              cost: (msg.usage as any)?.cost?.total || 0
            })
            // 缓存失配告警(仿 pi showCacheMissNotices):热上下文(轮内第 2+ 次调用,或带
            // 历史的会话轮)命中率骤低 = 前缀疑似被改写,带 sys/tools 指纹对照上一条
            // [Payload] 即可定位变动段。会话首轮全量写入是正常预热不告警;denom 门槛滤
            // 小上下文噪音。已知限制:从不上报缓存字段的 provider 在长会话里每次调用都
            // 会触发——那也是事实("该模型无缓存经济"),只进主进程日志,不进 UI。
            const warmContext = usageCallSeq > 1 || piMessages.length > 1
            if (warmContext && denom > 8000 && hitPct < 50) {
              console.warn(`[CacheMiss] conv=${convIdShort} call#${usageCallSeq} hit=${hitPct}% cacheWrite=${cacheWrite} input=${input} sys=${lastSysHash} tools=${lastToolsHash} ——前缀疑似失配`)
            }
            // 上下文用量圆环：真实 prompt tokens = input + cacheRead + cacheWrite。
            // usage/segments 供 hover 卡片累计命中率与分区占比——只透传已算好的数字。
            eventQueue.push({
              type: 'context_usage',
              promptTokens: denom,
              contextWindow: usageContextWindow,
              budget: usageBudget,
              compacted: historyCompacted,
              usage: { input, cacheRead, cacheWrite },
              segments: buildContextUsageSegments({ promptTokens: denom, ...segmentEstimate })
            })
          }
        }
        const openpipalEvents = adapter.adapt(piEvent)
        for (const evt of openpipalEvents) {
          eventQueue.push(evt)
        }
      })

      // 8.3 触发本轮 prompt
      promptWithEmptyCompletionRetry(agent, promptPayload, {
        signal,
        // 第二次 prompt 是新的模型 phase，清掉 adapter 的流式去重状态；
        // 已经进入 eventQueue 的第一次思考事件不受影响。
        onRetry: () => adapter.reset(),
        // 溢出分型证据 + 自愈通道：length+近零输出 → 压缩重建后原地重试，不走盲目续跑
        contextWindow: usageContextWindow,
        onOverflowRecover: rebuildAfterOverflow
      }).then(({ stillEmpty, overflow }) => {
        promptStillEmpty = stillEmpty
        if (stillEmpty && !signal?.aborted) {
          eventQueue.push({
            type: 'error',
            content: overflow
              ? '会话上下文已达模型窗口上限，自动压缩后仍无法继续。建议开个新会话继续这项工作，或把本会话切换到上下文窗口更大的模型。'
              : '模型连续两次结束，但都没有返回正文或工具调用。这通常是服务商的流式响应不完整，请重试或降低思考强度。'
          })
        }
        disarmStall()
        eventQueue.done()
      }).catch((err: any) => {
        promptFailed = true
        console.error('[Pi] Agent prompt 错误:', err.message, err.stack?.substring(0, 500))
        disarmStall()
        eventQueue.push({ type: 'error', content: err.message || 'Agent 执行失败' })
        eventQueue.done()
      })

      // 8.4 产出本轮事件
      for await (const event of eventQueue) {
        yield event
        if (event.type === 'ask_user' || event.type === 'questions_v2') {
          agent.abort()
          askUserBreak = true
          break
        }
      }

      disarmStall()   // 本轮出完：定时器必须收，否则 goal loop 的下一轮会被上一轮的弦误伤
      unsubscribe()
      adapter.reset()
      const outcome = watchdogTriggered
        ? 'watchdog'
        : signal?.aborted
          ? 'external_abort'
          : promptFailed || terminalStopReason === 'error'
            ? 'provider_error'
            : terminalStopReason === 'aborted'
              ? 'agent_aborted'
              : askUserBreak || terminalStopReason
                ? 'completed'
                : promptStillEmpty
                  ? 'failed_before_assistant'
                  : 'failed_before_assistant'
      observeTurn('settled', outcome)
      if (activeTurnObservation === observation) activeTurnObservation = undefined

      // 8.5 Goal checkpoint -------------------------------------------------
      if (askUserBreak) break // ask_user 永远打断 goal loop(需要用户回答)
      if (signal?.aborted) break // 用户 ESC
      if (!goal || goal.status !== 'active') break // 无 goal / 已停止

      // 安全闸 1: maxTurns
      if (goal.turnsUsed >= goal.maxTurns) {
        goal.status = 'exceeded'
        console.log(`[Goal] maxTurns 达到 (${goal.turnsUsed}/${goal.maxTurns}),停止 continuation`)
        yield { type: 'goal_update', goal: { ...goal } }
        break
      }

      // 安全闸 2: consecutiveBlocks(GoalChecker 连续拒判但 agent 没真正推进)
      if (goal.consecutiveBlocks >= MAX_CONSECUTIVE_BLOCKS) {
        goal.status = 'exceeded'
        console.log(`[Goal] 连续 ${MAX_CONSECUTIVE_BLOCKS} 轮 GoalChecker 仍判 false,强停`)
        yield { type: 'goal_update', goal: { ...goal } }
        break
      }

      // 调 GoalChecker
      let checkResult
      try {
        const llm = createPiGoalCheckerLLM(model, mc)
        checkResult = await checkGoal({
          goal,
          recentMessages: extractRecentForCheck(agent.state.messages),
          llm,
          signal
        })
      } catch (err: any) {
        // 双保险:checkGoal 内部已 try/catch,这里再兜一次
        console.error('[Goal] checkGoal 异常:', err?.message)
        checkResult = { ok: true, reason: 'checker exception', fallback: true }
      }

      goal.lastCheck = {
        ok: checkResult.ok,
        reason: checkResult.reason,
        fallback: checkResult.fallback,
        timestamp: Date.now()
      }

      console.log(
        `[Goal] checker → ok=${checkResult.ok} fallback=${!!checkResult.fallback} ` +
          `reason="${(checkResult.reason || '').slice(0, 80)}"`
      )

      // GoalChecker 失败按用户决策"放过":fallback=true 时 ok 也是 true,直接走完成路径
      if (checkResult.ok) {
        goal.status = 'done'
        yield { type: 'goal_update', goal: { ...goal } }
        break
      }

      // continuation:计数器 +1,append hint,下一轮 while
      goal.turnsUsed += 1
      goal.consecutiveBlocks += 1
      yield { type: 'goal_update', goal: { ...goal } }

      currentMessage = {
        role: 'user',
        content: buildContinuationHint(goal, checkResult)
      } as any
      promptPayload = currentMessage
    }
  } finally {
    if (signal && onAbort) signal.removeEventListener('abort', onAbort)
    if (activeTurnObservation) {
      observeTurn('settled', signal?.aborted ? 'external_abort' : 'lifecycle_abort')
      activeTurnObservation = undefined
    }
    // Usage 观测：本轮（本次 agentChat）汇总，正常/异常路径都会经过这里
    const turnDenom = usageSumInput + usageSumCacheRead + usageSumCacheWrite
    const turnHitPct = turnDenom > 0 ? Math.round((usageSumCacheRead / turnDenom) * 100) : 0
    console.log(`[Usage:turn] conv=${convIdShort} calls=${usageCallSeq} input=${usageSumInput} cacheRead=${usageSumCacheRead} hit=${turnHitPct}%`)
    if (usageCallSeq > 0) {
      appendUsageRecord({
        kind: 'turn', conv: convIdShort, model: mc.model, calls: usageCallSeq,
        input: usageSumInput, cacheRead: usageSumCacheRead, cacheWrite: usageSumCacheWrite,
        output: usageSumOutput, hit: turnHitPct
      })
    }
  }
}

// ---- 自动检测：模型是否支持 thinking ----

/**
 * 用一个临时 Pi Agent 实例发送测试 prompt，强制 reasoning=true，
 * 监听 thinking 类事件来判断模型是否真的会返回思考内容。
 *
 * 注意：
 * - 会消耗一次真实 API 调用（短 prompt + 30s 上限）
 * - 不污染全局 modelConfig；env var 临时被覆盖到测试 key，但下次 chat 会被
 *   ensurePiApiKey 重置回当前激活预设的 key
 * - 不知道 reasoning 字段名的兜底端点（Pi 的 Groq 模板）可能检测不到，
 *   此时返回 detected=false，用户仍可在 UI 手动勾选
 */
/**
 * 思考能力检测的返回形状。
 *
 * 这里只发 key 不发译文：Runtime 侧（含本文件）被 agent-runtime-boundary 测试
 * 禁止引入 UI 语言资源，翻译由渲染层用当前界面语言完成。外部文本（网关 message）
 * 走 `error` 原样透传。
 */
export interface ThinkingDetectionResult {
  detected: boolean
  error?: string
  errorKey?: string
  errorParams?: Record<string, string>
}

export async function testThinkingSupport(testConfig: ModelConfig): Promise<ThinkingDetectionResult> {
  let model: any
  try {
    model = buildModelFromConfig(testConfig)
    // 强制开 reasoning，让 Pi 在请求里塞 reasoning_effort / extended_thinking 等字段
    model = { ...model, reasoning: true }
  } catch (err: any) {
    return { detected: false, errorKey: 'settings.model.errors.modelConstructionFailed', errorParams: { detail: err.message } }
  }
  ensurePiApiKeyFor(model.provider, testConfig)

  return await new Promise((resolve) => {
    let resolved = false
    let detected = false

    const finish = (result: ThinkingDetectionResult) => {
      if (resolved) return
      resolved = true
      try { unsubscribe?.() } catch {}
      clearTimeout(timer)
      resolve(result)
    }

    let unsubscribe: (() => void) | undefined
    let agent: Agent
    try {
      agent = new Agent({
        initialState: {
          systemPrompt: '你是一个会逐步思考的助手。请在回答前展示完整推理过程。',
          model,
          tools: [],
          thinkingLevel: 'low' as const,
          messages: [],
        },
        toolExecution: 'sequential',
        streamFn: withSessionStreamOptions(isolatedStreamSimple, testConfig),
        onPayload: createModelPayloadAdapter(testConfig),
      })
    } catch (err: any) {
      resolve({ detected: false, errorKey: 'settings.model.errors.agentCreationFailed', errorParams: { detail: err.message } })
      return
    }

    unsubscribe = agent.subscribe((event: PiAgentEvent) => {
      const t = event.type as string
      // Pi 框架的 thinking 流式 / 完整事件
      if (t === 'thinking_delta' || t === 'thinking_start') {
        detected = true
      }
      if (t === 'message_end') {
        const msg = (event as any).message
        if (msg?.stopReason === 'error') {
          finish({
            detected: false,
            ...(msg.errorMessage ? { error: msg.errorMessage } : { errorKey: 'settings.model.errors.apiError' })
          })
          return
        }
        // 兜底：从最终消息内容中找 thinking block
        if (Array.isArray(msg?.content)) {
          for (const block of msg.content) {
            if (block?.type === 'thinking' && block.thinking) {
              detected = true
              break
            }
          }
        }
        finish({ detected })
      }
    })

    // 30s 上限，超时按当前累计判定
    const timer = setTimeout(() => {
      try { agent.abort() } catch {}
      finish(detected ? { detected: true } : { detected: false, errorKey: 'settings.model.errors.detectionTimeout' })
    }, 30_000)

    agent.prompt({
      role: 'user',
      content: [{ type: 'text', text: '请逐步思考：123 × 456 等于多少？' }],
      timestamp: Date.now()
    } as any).catch((err: any) => {
      finish({ detected: false, error: err?.message || '测试失败' })
    })
  })
}

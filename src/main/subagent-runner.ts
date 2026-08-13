/**
 * Subagent Runner — 同进程启动一个子 Agent 完成委派任务
 *
 * 设计原则：
 * - 子 Agent 是隔离上下文，主 Agent 的对话历史不传递给它；只传当前 task
 * - 工具白名单两层过滤：profile.tools 显式声明 → 严格按白名单；否则 = 全集 - 黑名单
 * - 黑名单是"面向用户的工具"（ask_user/create_artifact/...）——子 agent 应该把结果汇报给主 agent，
 *   由主 agent 决定要不要给用户产出
 * - 模型继承主 agent；profile.model 或 modelOverride 可改（但必须是 OpenPipal 已注册的）
 * - 事件订阅在 runner 内部消化，转成精简的 onUpdate 回调——child agent 的 token 级流式不直接上抛 IPC
 * - abort 沿用 OpenPipal 既有模式：外部 AbortSignal → agent.abort()
 *
 * P2 范围：runner 本体（库函数）。P3 才会把这个 runner 包装成 subagent pi-tool 暴露给主 agent。
 */

import { Agent, type AgentEvent as PiAgentEvent } from '@earendil-works/pi-agent-core'
import type { Message, Model } from '@earendil-works/pi-ai/compat'
import { getSubagentProfile, type SubagentProfile } from './subagent-manager'
import {
  buildOpenPipalProductTools,
  filterOpenPipalTools,
  AskUserResolver
} from './openpipal-product-tools'
import { buildMcpBridgeTools } from './pi-mcp-bridge'
import { buildPiCoreExecutionTools } from './agent-runtime/pi-core-execution-tools'
import { loadPiCoreSkillCatalog } from './agent-runtime/pi-core-skills'
import {
  getWorkingDir,
  buildModelFromConfig,
  listModelPresets,
  loadConfig,
  getModelPresetFull,
  ensurePiApiKeyFor,
  resolveConversationModelConfig,
  withSessionStreamOptions,
  createModelPayloadAdapter,
  type ModelConfig,
} from './config-manager'
import { createStableContextTransform } from './context-window-policy'
import { createSecurityHook } from './pi-security'
import { readToolsConfig } from './agent-workspace-store'
import { isolatedStreamSimple } from './isolated-stream-signal'
import type { AgentTool } from '@earendil-works/pi-agent-core'
import type { ChatSource } from './agent-runtime/contracts'
import { filterToolsForChatSource } from './agent-runtime/source-tool-policy'
import { formatSubagentMaxTurnsNotice } from '../shared/runtime-notice'

/**
 * subagent 不应使用的工具（面向最终用户的产出 / 中断类）。
 * 这些工具的语义是"主 agent 才能决定要不要呈现给用户"——子 agent 应把结果通过
 * 最终 message 汇报回去，由主 agent 决定下一步动作。
 *
 * 'subagent' 自身也在黑名单内：防止套娃（子 agent 再开子 agent → 主 agent 失去掌控）。
 */
const SUBAGENT_TOOL_BLACKLIST: ReadonlySet<string> = new Set([
  'ask_user',
  'questions_v2',
  'create_artifact',
  'create_visualizer',
  'generate_document',
  'present_to_user',
  'subagent', // P3 注册 subagent 工具后生效——同进程嵌套套娃
])

export interface RunChildAgentOptions {
  /** profile 名（必须在 ~/.openpipal/subagents/ 已注册） */
  profile: string
  /** 主 agent 委派的任务描述（会作为子 agent 的第一条 user message） */
  task: string
  /** 可选 inline system prompt，追加在 profile body 之后 */
  persona?: string
  /**
   * 可选 model override（字符串，必须能在 OpenPipal modelPresets 找到）。
   * 优先级：modelOverride > profile.model > 主 agent 当前模型
   */
  modelOverride?: string
  /** 外部 abort 信号（用户按 Esc 时触发） */
  signal?: AbortSignal
  /** Parent Runtime source; scheduler restrictions must survive delegation. */
  source?: ChatSource
  /** 流式回调，子 agent 每次 message_end / tool_execution_start/end 触发 */
  onUpdate?: (update: ChildAgentUpdate) => void
  /** 主 agent 的 workspaceId，传给 buildPiTools 让子 agent 用同一个 workspace */
  workspaceId?: string
  /** 主 agent 的 conversationId（让子 agent 的 MCP 调用归属同一会话） */
  conversationId?: string
  /**
   * 主会话已捕获的执行角色。子 Agent 不继承角色专属人格/技能，
   * 但共享的 product tools 必须沿用同一角色安全策略。
   */
  roleName?: string
  /** Parent turn's fully resolved working directory. */
  workingDir?: string
  /** Parent conversation's model preset selection; undefined follows the global default. */
  modelPresetId?: string
}

export interface ChildAgentUpdate {
  status: 'streaming' | 'complete' | 'error'
  /** 累积到当前的 child message 列表 */
  messages: Message[]
  /** 当前已观察到的 token / cost / turn 用量 */
  usage: ChildAgentUsage
  /** 最近一次工具调用（如有） */
  lastTool?: { name: string; args: any }
  /** 错误信息（status='error' 时） */
  errorMessage?: string
}

export interface ChildAgentResult {
  /** 子 agent 完整 message history */
  messages: Message[]
  /** 子 agent 最后一条 assistant message 的 text content（汇报给主 agent 的内容） */
  finalText: string
  /** 累积用量 */
  usage: ChildAgentUsage
  /** 实际使用的模型 id（UI 显示用） */
  modelId: string
  /** 实际使用的 profile name */
  profileName: string
  stopReason?: string
  errorMessage?: string
}

export interface ChildAgentUsage {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  cost: number
  turns: number
}

function emptyUsage(): ChildAgentUsage {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 }
}

/**
 * 解析 modelOverride 字符串 → Pi Model 对象。
 * 严格匹配 OpenPipal 已注册预设；找不到返回 undefined（caller fallback 到主 agent 模型）。
 */
function resolveModelOverride(modelOverride: string): { model: Model<any>; config: ModelConfig } | undefined {
  const presets = listModelPresets()
  // 精确匹配 model 字符串。服务商实体化后同名模型可跨服务商出现——多命中时
  // 优先全局激活预设（用户此刻信任的那家），否则取第一个并告警列出歧义。
  const matches = presets.filter(p => p.config.model === modelOverride)
  if (matches.length === 0) {
    console.warn(`[Subagent] modelOverride "${modelOverride}" 未匹配任何已注册预设，将 fallback 到主 agent 模型`)
    return undefined
  }
  const activeId = loadConfig().activePresetId
  const match = matches.length === 1 ? matches[0] : (matches.find(p => p.id === activeId) || matches[0])
  if (matches.length > 1) {
    console.warn(`[Subagent] modelOverride "${modelOverride}" 命中 ${matches.length} 个预设（跨服务商同名），已选 "${match.name}"；如需指定另一家，请让模型名在预设内唯一`)
  }
  // 连接字段必须走解析视图——providerId 挂接后 preset.config 里的 baseUrl/apiKey 是
  // 迁移遗留缓存，服务商换 key 后直接读会用旧凭证（listModelPresets 的最后一个裸消费方）
  const resolved = getModelPresetFull(match.id)?.config || match.config
  const model = buildModelFromConfig(resolved)
  ensurePiApiKeyFor(model.provider, resolved)
  return { model, config: resolved }
}

/**
 * 工具白名单 / 黑名单过滤。
 * - profile.tools 显式列出 → 严格按白名单（支持 `xxx_*` 通配前缀）
 * - profile.tools 为空 / 未设 → 全集 - 黑名单
 */
function filterTools(allTools: AgentTool[], profile: SubagentProfile): AgentTool[] {
  // 先剔黑名单
  let tools = allTools.filter(t => !SUBAGENT_TOOL_BLACKLIST.has(t.name))

  // 再按 profile 白名单过滤（如果有声明）
  if (profile.tools && profile.tools.length > 0) {
    const exact = new Set<string>()
    const prefixes: string[] = []
    for (const pat of profile.tools) {
      if (pat.endsWith('*')) prefixes.push(pat.slice(0, -1))
      else exact.add(pat)
    }
    tools = tools.filter(t => {
      if (exact.has(t.name)) return true
      for (const p of prefixes) {
        if (t.name.startsWith(p)) return true
      }
      return false
    })
  }
  return tools
}

/**
 * 启动一个子 Agent 完成委派任务。
 * 同进程 new Agent() — 与主 Agent 隔离 message history、隔离 token 计数，
 * 但共享 OpenPipal 工具栈和 MCP 连接。
 */
export async function runChildAgent(options: RunChildAgentOptions): Promise<ChildAgentResult> {
  const profile = getSubagentProfile(options.profile)
  if (!profile) {
    throw new Error(
      `Unknown subagent profile: "${options.profile}". ` +
      `Run 'ls ~/.openpipal/subagents/' to check available profiles.`
    )
  }

  // 1. system prompt: profile body + 可选 persona + 技能段
  //    子 agent 此前完全拿不到技能索引（不走 buildSystemPrompt）——这里补上，
  //    让委派出去的子 agent 也能按需 read SKILL.md 加载技能。
  const basePrompt = options.persona
    ? `${profile.systemPrompt}\n\n## 本次任务的附加指引（来自主 agent）\n${options.persona}`
    : profile.systemPrompt
  const skillCatalog = await loadPiCoreSkillCatalog({ workspaceId: options.workspaceId })
  const systemPrompt = basePrompt + skillCatalog.promptSection

  // 2. 工具构建：复用主 agent 的工具工厂（保证子 agent 看到的工具与主 agent 一致）
  //    askUserResolver 是 buildPiTools 强制需要的参数；子 agent 不会真用到 ask_user
  //    （已在黑名单），传一个空 resolver 即可
  const askUserResolver = new AskUserResolver()
  const source = options.source ?? 'desktop'
  const toolsCfg = options.workspaceId ? readToolsConfig(options.workspaceId) : undefined
  // The parent Runtime has already resolved this turn's cwd. Keep product tools,
  // execution backend and the security hook on that exact same directory.
  const workingDir = options.workingDir || toolsCfg?.workingDir || getWorkingDir()
  const execution = buildPiCoreExecutionTools(workingDir)
  try {
  const productTools = buildOpenPipalProductTools(source, askUserResolver, {
    roleName: options.roleName,
    workingDir,
    workspaceId: options.workspaceId,
    conversationId: options.conversationId,
    disabledTools: toolsCfg?.disabledTools,
    executeCodeBackend: execution.executeCode,
  })
  const executionTools: AgentTool[] = execution.tools.map((tool) => ({
    ...tool,
    execute: (toolCallId, params, signal, onUpdate) => (
      tool.execute(toolCallId, params, signal, onUpdate, execution.toolContext)
    )
  })) as AgentTool[]
  const builtinTools = filterOpenPipalTools(
    [...productTools, ...executionTools],
    {
      disabledTools: toolsCfg?.disabledTools,
      roleName: options.roleName,
      conversationId: options.conversationId
    }
  )
  const mcpTools = buildMcpBridgeTools(undefined, options.conversationId, source)
  // 双重保险，与主 pi-core 路径对齐（见 pi-core-tool-adapter.ts）：每个工具单独盖 executionMode:
  // 'sequential'，不只靠下面 Agent 的全局 toolExecution 兜底——万一某天全局开关被改掉/漏配，
  // 子 agent 的工具仍强制串行执行。
  const allTools = filterTools(
    filterToolsForChatSource(source, [...builtinTools, ...mcpTools]),
    profile
  ).map((tool) => ({ ...tool, executionMode: 'sequential' as const }))

  // 3. 模型路由：modelOverride > profile.model > 主 agent 当前会话模型。
  // 子 Agent 不能回退到进程全局 getPiModel()/getEffectiveModelConfig()，否则会话固定
  // preset 与全局默认不同时会悄悄换模型。
  const overrideStr = options.modelOverride || profile.model
  const overrideRoute = overrideStr ? resolveModelOverride(overrideStr) : undefined
  const parentRoute = resolveConversationModelConfig(options.modelPresetId)
  const modelConfig = overrideRoute?.config || parentRoute.config
  const model = overrideRoute?.model || buildModelFromConfig(modelConfig)
  // 降级不静默：advisor 这类档位的价值就在强模型，预设被删/改名后 fallback 到主（弱）模型
  // 必须让主 agent 和用户知道，否则以为在拿强模型第二意见、实际是弱模型自言自语
  const modelFallbackNote = overrideStr && !overrideRoute
    ? `⚠️ 模型预设 "${overrideStr}" 未在 OpenPipal Settings 里找到，本次已用主 agent 当前模型执行（非预期的强模型）。\n\n`
    : ''
  // 确保对应 provider 的 API key 已设到环境变量
  ensurePiApiKeyFor(model.provider, modelConfig)

  // 4. 创建子 Agent — 默认关 thinking（throw-away 上下文不值得 thinking 成本）
  const agent = new Agent({
    initialState: {
      systemPrompt,
      model,
      tools: allTools,
      thinkingLevel: 'off',
      messages: [],
    },
    toolExecution: 'sequential',
    // 子 agent 的档位（advisor 等）可能与主会话不同 provider key——同款注入防并发互踩
    streamFn: withSessionStreamOptions(isolatedStreamSimple, modelConfig),
    // 子 agent 同样过三层安全（分类/审计/路径黑名单）——不挂 hook 时 Pi 直接跳过整段检查，
    // advisor 的 read 可以无审计读 ~/.ssh。无 UI 通道 → needs_confirmation 由默认 handler 拒绝。
    beforeToolCall: createSecurityHook(options.conversationId, undefined, {
      workspaceId: options.workspaceId,
      workingDir,
    }),
    // 与主 Agent 同一口径：只限制异常大的单条工具结果，不按年龄/消息数卸载历史。
    transformContext: createStableContextTransform(),
    onPayload: createModelPayloadAdapter(modelConfig),
  })

  // 5. 状态累积
  const childMessages: Message[] = []
  const usage = emptyUsage()
  let lastError: string | undefined
  let stopReason: string | undefined
  let lastTool: { name: string; args: any } | undefined
  /** maxTurns 触发的主动中止标记 —— 让 caller 知道 stopReason='aborted' 是 maxTurns 而非用户/外部 signal */
  let abortedByMaxTurns = false

  const emit = (status: ChildAgentUpdate['status']) => {
    if (!options.onUpdate) return
    options.onUpdate({
      status,
      messages: childMessages.slice(),
      usage: { ...usage },
      lastTool,
      errorMessage: lastError,
    })
  }

  // 6. 事件订阅 — 只在语义边界触发 onUpdate，不在 token-level message_update 触发
  const unsubscribe = agent.subscribe((event: PiAgentEvent) => {
    switch (event.type) {
      case 'message_end': {
        const msg = event.message as any
        // 只 push 真实 LLM 消息（过滤可能的自定义 UI-only 消息）
        if (msg && (msg.role === 'assistant' || msg.role === 'user' || msg.role === 'toolResult')) {
          childMessages.push(msg)
        }
        if (msg?.role === 'assistant') {
          usage.turns++
          const u = msg.usage
          if (u) {
            usage.input += u.input || 0
            usage.output += u.output || 0
            usage.cacheRead += u.cacheRead || 0
            usage.cacheWrite += u.cacheWrite || 0
            usage.cost += u.cost?.total || 0
          }
          if (msg.stopReason) stopReason = msg.stopReason
          if (msg.errorMessage) lastError = msg.errorMessage
        }
        emit(lastError ? 'error' : 'streaming')
        break
      }
      case 'tool_execution_start':
        lastTool = { name: event.toolName, args: event.args }
        emit('streaming')
        break
      case 'tool_execution_end':
        // 工具结果会在后续 message_end 中以 toolResult message 出现，这里只触发一次 update
        emit('streaming')
        break
      case 'turn_end': {
        // maxTurns 防 runaway 检查 —— 注意 usage.turns 是在 message_end (role=assistant) 时累加
        // turn_end 比 message_end 后触发，此时 usage.turns 已是当前完成轮数。
        // 只有这一轮还想继续（assistant 消息带 toolCall）才算被腰斩；纯文本收尾=自然完成，
        // 不 abort 也不标错——否则 advisor 最典型的"读一次+给结论"两轮成功会被标成 isError。
        if (profile.maxTurns && usage.turns >= profile.maxTurns) {
          const lastAssistant = [...childMessages].reverse().find((m: any) => m.role === 'assistant') as any
          const wantsMore = Array.isArray(lastAssistant?.content) &&
            lastAssistant.content.some((c: any) => c.type === 'toolCall')
          if (wantsMore) {
            abortedByMaxTurns = true
            console.log(`[Subagent] profile="${profile.name}" 达到 maxTurns=${profile.maxTurns}，主动中止`)
            agent.abort()
          }
        }
        break
      }
      // message_update / agent_start/end / turn_start 等保持沉默
    }
  })

  // 7. abort 桥接：外部 signal → agent.abort()
  let onAbort: (() => void) | undefined
  if (options.signal) {
    if (options.signal.aborted) {
      unsubscribe()
      throw new Error('Subagent aborted before start')
    }
    onAbort = () => agent.abort()
    options.signal.addEventListener('abort', onAbort, { once: true })
  }

  try {
    // 8. 启动子 agent — 第一条 user message 是主 agent 委派的 task
    await agent.prompt(`Task: ${options.task}`)
    await agent.waitForIdle()
  } finally {
    unsubscribe()
    if (options.signal && onAbort) {
      options.signal.removeEventListener('abort', onAbort)
    }
  }

  // maxTurns 中止 → 把 errorMessage 改写得清晰（不然只是 "aborted" 用户看不懂）
  if (abortedByMaxTurns && !lastError) {
    lastError = formatSubagentMaxTurnsNotice(profile.maxTurns ?? 0)
  }

  const finalText = modelFallbackNote + extractFinalText(childMessages)
  emit(lastError ? 'error' : 'complete')

  return {
    messages: childMessages,
    finalText,
    usage,
    modelId: (model as any).id || 'unknown',
    profileName: profile.name,
    stopReason,
    errorMessage: lastError,
  }
  } finally {
    await execution.dispose()
  }
}

function extractFinalText(messages: Message[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i] as any
    if (m.role === 'assistant' && Array.isArray(m.content)) {
      for (const c of m.content) {
        if (c.type === 'text' && typeof c.text === 'string') return c.text
      }
    }
  }
  return ''
}

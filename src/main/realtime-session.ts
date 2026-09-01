/**
 * Realtime Voice Session Manager (Main Process)
 *
 * 管理与 Realtime API 的 WebSocket 连接。
 * 使用 Node.js ws 模块（支持自定义 auth headers）。
 * 通过 IPC 将事件双向转发到 Renderer。
 */

import WebSocket from 'ws'
import { BrowserWindow } from 'electron'
import { getRealtimeProvider, RealtimeProviderConfig } from './realtime-provider'
import { getEffectiveVoiceConfig, getDoubaoVoiceConfig, VoiceConfig } from './config-manager'
// DoubaoInterpretSession/DoubaoDuplexSession 只做类型引用（别名避免跟下方懒加载的同名 let 值绑定冲突）——
// 值绑定改惰性动态 import(见下方 ensureAgentService)，避免 doubao-interpret-session → doubao-ast-frame
// 的模块级 protobuf.parse() 拖进 boot 路径。
import type { DoubaoInterpretSession as DoubaoInterpretSessionType } from './doubao-interpret-session'
import type { DoubaoDuplexSession as DoubaoDuplexSessionType } from './doubao-duplex-session'
import { reduceVoiceTurn, TOOL_EXECUTED } from './voice-turn-policy'
import type { AgentOverrides } from './agent-runtime/contracts'
import { getCurrentRole } from './role-manager'
import { resolveAgentOverrides, resolveExecutionRoleName } from './agent-overrides'
import type { ConversationConfig } from './conversation-store'
import { mainError, type MainFailure } from './main-i18n'

/**
 * 服务端 / WebSocket 给了真实文本就原样透传（证据不可篡改）；
 * 什么都没给时才落到本进程自造的文案。
 */
function serverFailure(event: { error?: { message?: string }; message?: string }): MainFailure {
  const detail = event.error?.message || event.message
  return detail ? { error: String(detail) } : mainError('settings.voice.errors.serverError')
}

function socketFailure(err: { message?: string }): MainFailure {
  return err.message ? { error: err.message } : mainError('settings.voice.errors.connectionFailed')
}

/** 语音会话的 Agent 上下文 —— 与文字模式 chat:send 同源，用于复用同一套配置组装 */
export interface VoiceSessionContext {
  conversationId?: string
  agentId?: string
  workspaceId?: string
  conversationConfig?: ConversationConfig
  /** Conversation-scoped role captured when this voice session starts. */
  roleName?: string
}

/** 语音对话的输出礼仪 —— 附加到复用的系统提示词末尾（这是 voice 模态的能力边界适配） */
const VOICE_ETIQUETTE = `

---
【语音对话模式】你现在通过实时语音和用户对话。以下规则**覆盖**前面文字界面向的指示：

输出方式（口语优先）：
- 回答简短、口语化，像真人聊天。**忽略前面任何"用 Markdown / 表格 / 列表 / 代码块 / LaTeX 格式"的要求**——那是给文字界面的，逐字念出来体验很差。
- 数学用自然语言说（如"x 等于负 b 加减根号 b 方减 4ac，再除以 2a"），不要念 LaTeX 源码；代码同理，口头说思路，真要给代码就用工具放到面板。

工具与产物（能力跟文字模式完全一样，区别只是"交付靠说"）：
- **工具可以连续用**：根据任务需要调用工具；有依赖的操作按顺序使用真实返回值，完成后直接继续下一步，直到任务做完。内置工具和 MCP 工具都正常用。
- 需要用工具时**直接发起调用**——系统会自动播轻提示音填补等待,不会冷场,你不必为了"别让用户干等"而先说一堆。**最关键:一旦决定用工具,就在这一回合真的发起调用,绝不能只用嘴说"我帮你查/我去查"却不实际调用、说完就停等用户。** 可以顺带说半句"我查一下",但说了就必须紧接着真调。
- 要展示图表/文档/网页/长内容时，**照常调 create_visualizer / create_artifact / generate_document**——它们会渲染到聊天面板，用户看得到。你只需口头说一句话概括（"我做好了一张趋势图，放在面板里了"），**不要把内容念出来**。
- 前面出现的"侧边栏""对话气泡里看到 iframe""用户会看到两次"等是文字界面的描述：用户此刻主要靠听，但产物确实会渲染出来。所以**该生成就生成，不要因为"用户已经看到了"而跳过工具**。
- 改稿/迭代时，用工具结果里返回的**同一个 id 原地更新**（结果里会给你 id 和文件路径），不要新建一个。

打断：用户可能随时打断你，这很正常，顺着新话头继续即可。`

export interface RealtimeSessionConfig extends RealtimeProviderConfig {
  /** 解析后的 provider 名（已 lower-case） */
  provider: string
}

let activeSession: {
  ws: WebSocket
  config: RealtimeSessionConfig
  /** Present only while the initial connection promise is still pending. */
  cancelStart?: () => void
} | null = null

// 豆包同传会话(interpreter 角色 + 已配 voiceConfigDoubao 时启用)。与 activeSession 互斥:
// start 时二选一,send/stop 优先看 activeDoubao。讲豆包 Protobuf,对外发同构 IPC 事件。
let activeDoubao: DoubaoInterpretSessionType | null = null

// 豆包全双工对话会话(全局 voiceConfig.provider==='doubao' 时启用, 任意角色)。与 activeSession/activeDoubao 互斥。
// 讲豆包全双工 JSON, 对外发同构 IPC 事件; 原生支持客户端 function calling。
let activeDuplex: DoubaoDuplexSessionType | null = null

/** 当前是否走豆包同传:角色 = interpreter 且配了豆包凭证。返回豆包配置或 null。 */
function interpretDoubaoConfig(roleName?: string): VoiceConfig | null {
  try {
    if ((roleName || getCurrentRole().name) !== 'interpreter') return null
  } catch {
    return null
  }
  return getDoubaoVoiceConfig()
}

/** 当前是否走豆包全双工对话:全局 voiceConfig.provider==='doubao'(且非 interpreter 同传分流)。 */
function isDuplexDoubao(vc: VoiceConfig): boolean {
  return (vc.provider || '').toLowerCase() === 'doubao'
}

let sessionConfigSent = false
let sessionReady = false  // session.updated 收到后才允许转发音频
let audioSendCount = 0
// 是否有 response 正在进行 —— create_response=false 下由 main 接管回复创建,用它防重复 create(撞车)
let responseActive = false
// 本用户回合内已调工具数 —— >1 即证明"多工具链式"生效(parity 客观信号),committed 时归零
let voiceToolChainStep = 0
// 当前语音会话绑定的 conversationId —— 工具产出的 artifact 用它走 chat:* 管线渲染到聊天面板
let activeVoiceCid: string | null = null
// 当前语音会话的 Agent 上下文 —— 用于复用文字模式的 buildSystemPrompt / tools 组装
let activeVoiceCtx: VoiceSessionContext = {}
let activeVoiceOverrides: AgentOverrides | undefined

/** call_id → tool name 映射 —— 从 response.output_item.added (type='function_call') 维护
 *  当 .arguments.done 缺少 name 字段时（不同服务商行为可能不同）兜底查找
 */
const pendingFunctionCalls = new Map<string, string>()

let windowRef: (() => BrowserWindow | null) | null = null
export type RealtimeLifecycleState = 'idle' | 'error'
let lifecycleListener: ((state: RealtimeLifecycleState) => void) | null = null

export function setRealtimeWindowRef(getWindow: () => BrowserWindow | null): void {
  windowRef = getWindow
}

/** Main-process owner hook used to release the durable voice lease on transport loss. */
export function setRealtimeLifecycleListener(
  listener: ((state: RealtimeLifecycleState) => void) | null
): void {
  lifecycleListener = listener
}

/**
 * 获取 Realtime 配置（用于 renderer 查询当前 provider / 是否可用）
 * 数据源：config.json > .env > 默认值（由 getEffectiveVoiceConfig 负责）
 */
export function getRealtimeConfig(): {
  provider: string
  url: string
  model: string
  deployment: string
  apiVersion: string
  voice: string
  hasKey: boolean
  /** 采集采样率:OpenAI=24000;豆包同传=16000;豆包全双工=16000(渲染端 AudioEngine 据此采集) */
  sampleRate: number
  /** 播放采样率:多数 = sampleRate;豆包全双工出 24000(入 16k 出 24k 不对称) */
  outputSampleRate: number
} {
  const doubao = interpretDoubaoConfig()
  if (doubao) {
    return {
      provider: 'doubao',
      url: doubao.baseUrl,
      model: doubao.model || '',
      deployment: '',
      apiVersion: '',
      voice: '',
      hasKey: !!doubao.apiKey,
      sampleRate: 16000,
      outputSampleRate: 16000
    }
  }
  const vc = getEffectiveVoiceConfig()
  if (isDuplexDoubao(vc)) {
    return {
      provider: 'doubao',
      url: vc.baseUrl,
      model: vc.model || '',
      deployment: '',
      apiVersion: '',
      voice: vc.voice || '',
      hasKey: !!vc.apiKey,
      sampleRate: 16000,
      outputSampleRate: 24000
    }
  }
  return {
    provider: vc.provider,
    url: vc.baseUrl,
    model: vc.model,
    deployment: vc.deployment || vc.model,
    apiVersion: vc.apiVersion || '2025-04-01-preview',
    voice: vc.voice || 'alloy',
    hasKey: !!vc.apiKey,
    sampleRate: 24000,
    outputSampleRate: 24000
  }
}

/**
 * 启动 Realtime 语音会话
 * @param ctx 当前会话的 Agent 上下文（conversationId/agentId/workspaceId/conversationConfig）
 *            —— 与文字模式 chat:send 同源，用于复用同一套 systemPrompt + 工具组装
 */
// pi-agent 全链(含 realtime-tool-bridge → pi-tools 的 ~20 模块)是 out/main 最大单体——
// 惰性加载,不进 boot 路径。与原 import 同名,调用点零改动;未预热即调用会 throw 进既有
// catch、走默认 instructions(与旧行为的失败分支一致)。
let buildSystemPrompt!: typeof import('./agent-runtime/openpipal-prompt').buildOpenPipalSystemPrompt
let buildVoiceToolSchemas!: typeof import('./realtime-tool-bridge').buildVoiceToolSchemas
let executeVoiceTool!: typeof import('./realtime-tool-bridge').executeVoiceTool
// 豆包同传/全双工的会话类——同名 let 缓存，首次用到才 import（构造调用点都在 startRealtimeSession
// 分支内，该函数顶部已 await 过 ensureAgentService，调用点零改动）
let DoubaoInterpretSession!: typeof import('./doubao-interpret-session').DoubaoInterpretSession
let DoubaoDuplexSession!: typeof import('./doubao-duplex-session').DoubaoDuplexSession
async function ensureRealtimeDependencies(): Promise<void> {
  if (!buildSystemPrompt) {
    buildSystemPrompt = (await import('./agent-runtime/openpipal-prompt')).buildOpenPipalSystemPrompt
  }
  if (!buildVoiceToolSchemas) {
    const bridge = await import('./realtime-tool-bridge')
    buildVoiceToolSchemas = bridge.buildVoiceToolSchemas
    executeVoiceTool = bridge.executeVoiceTool
  }
  if (!DoubaoInterpretSession) {
    DoubaoInterpretSession = (await import('./doubao-interpret-session')).DoubaoInterpretSession
  }
  if (!DoubaoDuplexSession) {
    DoubaoDuplexSession = (await import('./doubao-duplex-session')).DoubaoDuplexSession
  }
}

export async function startRealtimeSession(ctx?: VoiceSessionContext | string): Promise<{ success: boolean; error?: string; sampleRate?: number; outputSampleRate?: number }> {
  // 兼容旧签名（只传 conversationId 字符串）
  const context: VoiceSessionContext = typeof ctx === 'string' ? { conversationId: ctx } : (ctx || {})
  await ensureRealtimeDependencies()
  return new Promise((resolve) => {
    if (activeSession) {
      stopRealtimeSession()
    }
    if (activeDoubao) {
      try { activeDoubao.close() } catch {}
      activeDoubao = null
    }
    if (activeDuplex) {
      try { activeDuplex.close() } catch {}
      activeDuplex = null
    }

    sessionConfigSent = false
    sessionReady = false
    audioSendCount = 0
    responseActive = false
    let resolvedOverrides: AgentOverrides | undefined
    try {
      resolvedOverrides = resolveAgentOverrides({
        agentId: context.agentId,
        workspaceId: context.workspaceId,
        conversationConfig: context.conversationConfig,
        conversationId: context.conversationId
      })
    } catch (err: any) {
      console.error('[RealtimeSession] resolveAgentOverrides failed:', err?.message)
    }
    const roleName = context.roleName || resolveExecutionRoleName(resolvedOverrides || {
      systemPrompt: '',
      conversationId: context.conversationId
    })
    activeVoiceCid = context.conversationId || null
    activeVoiceCtx = { ...context, roleName }
    activeVoiceOverrides = resolvedOverrides
      ? { ...resolvedOverrides, roleName }
      : { systemPrompt: '', conversationId: context.conversationId, roleName }
    pendingFunctionCalls.clear() // call_id 不跨 WS 重连存活,新会话清空避免累积陈旧映射

    // ── 豆包同传分流(interpreter 角色 + 已配豆包凭证)──
    // 不走 OpenAI WS,改用 DoubaoInterpretSession(裸 Protobuf),它把豆包事件归一化成
    // 同一套 'realtime:event' 发回渲染端,故渲染端零改动。采样率 16000 随 result 回传给 AudioEngine。
    const doubao = interpretDoubaoConfig(roleName)
    if (doubao) {
      if (!doubao.apiKey) {
        resolve({ success: false, error: 'Doubao API key not configured' })
        return
      }
      console.log(`[RealtimeSession] 同传分流 → 豆包 AST (${doubao.sourceLanguage}→${doubao.targetLanguage}, s2s)`)
      const session = new DoubaoInterpretSession({
        config: doubao,
        sourceLanguage: doubao.sourceLanguage || 'en',
        targetLanguage: doubao.targetLanguage || 'zh',
        mode: 's2s',
        sendEvent: sendEventToRenderer,
        sendState: sendStateToRenderer
      })
      activeDoubao = session
      session.connect().then((r) => resolve({ ...r, sampleRate: 16000 }))
      return
    }

    const vc = getEffectiveVoiceConfig()
    if (!vc.apiKey) {
      resolve({ success: false, error: 'Voice API key not configured' })
      return
    }

    // ── 豆包全双工对话分流(全局 voiceConfig.provider==='doubao')──
    // 纯 JSON 文本协议, 原生客户端 function calling。instructions/tools 在建 session 前组装好
    // (session.create 是握手第一步, 必须带上), 不像 OpenAI 路径等 session.created 再延迟发 session.update。
    if (isDuplexDoubao(vc)) {
      const toolSchemas = buildVoiceToolSchemas(activeVoiceCtx)
      let instructions = ''
      try {
        instructions = buildSystemPrompt('desktop', activeVoiceOverrides) + VOICE_ETIQUETTE
      } catch (err: any) {
        console.error('[RealtimeSession] buildSystemPrompt failed, using default:', err?.message)
      }
      console.log(`[RealtimeSession] 全双工分流 → 豆包对话 (voice=${vc.voice || 'default'}, ${toolSchemas.length} tools)`)
      const session = new DoubaoDuplexSession({
        config: vc,
        instructions,
        tools: toolSchemas,
        voiceCtx: activeVoiceCtx,
        sendEvent: sendEventToRenderer,
        sendState: sendStateToRenderer,
        emitToolArtifact: emitToolArtifactToChat
      })
      activeDuplex = session
      session.connect().then((r) => resolve({ ...r, sampleRate: 16000, outputSampleRate: 24000 }))
      return
    }

    let provider
    try {
      provider = getRealtimeProvider(vc.provider)
    } catch (err: any) {
      resolve({ success: false, error: err.message })
      return
    }

    const config: RealtimeSessionConfig = {
      provider: provider.name,
      baseUrl: vc.baseUrl,
      apiKey: vc.apiKey,
      model: vc.model,
      apiVersion: vc.apiVersion || '2025-04-01-preview',
      deployment: vc.deployment || vc.model
    }

    const wsUrl = provider.buildWebSocketURL(config)
    const headers = provider.buildAuthHeaders(config)

    console.log(`[RealtimeSession] Connecting via ${provider.name} to ${wsUrl.replace(/api-key=[^&]+/, 'api-key=***')}`)

    try {
      const ws = new WebSocket(wsUrl, { headers })
      let startSettled = false
      let opened = false
      const finishStart = (result: { success: boolean; error?: string; sampleRate?: number }): void => {
        if (startSettled) return
        startSettled = true
        resolve(result)
      }
      const ownedSession: NonNullable<typeof activeSession> = {
        ws,
        config,
        cancelStart: () => finishStart({ success: false, error: 'Voice connection cancelled' })
      }
      // Own the connecting socket immediately. Previously it became active
      // only after `open`, so hanging up during connection left an orphan that
      // could connect later and start listening after the UI had closed.
      activeSession = ownedSession

      ws.on('open', () => {
        if (activeSession?.ws !== ws) {
          try { ws.close() } catch { /* best-effort stale socket cleanup */ }
          finishStart({ success: false, error: 'Voice connection was superseded' })
          return
        }
        opened = true
        ownedSession.cancelStart = undefined
        console.log('[RealtimeSession] Connected, waiting for session.created...')
        sendStateToRenderer('connected')
        // 不在这里发 session.update，等 session.created 事件后再发
        finishStart({ success: true, sampleRate: 24000 })
      })

      ws.on('message', (data: WebSocket.Data) => {
        if (activeSession?.ws !== ws) return
        const str = typeof data === 'string' ? data : data.toString()
        try {
          const event = JSON.parse(str)

          // 收到 session.created 后才发送 session.update 配置（只发一次）
          if (event.type === 'session.created' && !sessionConfigSent) {
            sessionConfigSent = true
            // 延迟 200ms 再发 config — 给 302.ai / Azure 代理层留出就绪时间
            setTimeout(() => {
              if (!activeSession || activeSession.ws.readyState !== WebSocket.OPEN) return
              console.log('[RealtimeSession] Sending session config...')
              const toolSchemas = buildVoiceToolSchemas(activeVoiceCtx)
              // 复用文字模式的完整系统提示词（role + skills + memory + Agent 配置），
              // 末尾加语音礼仪。语音 = 同一个 agent 换输入通道。
              // 同传模式(当前角色 = interpreter):去对话礼仪(只翻译不寒暄)、剥工具(纯翻译不调工具)、
              // 转录语言自动检测(源语言可能是外语,不能偏置 'zh')。其余复用同一套会话组装。
              const isInterpret = activeVoiceCtx.roleName === 'interpreter'
              let instructions: string | undefined
              try {
                instructions = buildSystemPrompt('desktop', activeVoiceOverrides) + (isInterpret ? '' : VOICE_ETIQUETTE)
              } catch (err: any) {
                console.error('[RealtimeSession] buildSystemPrompt failed, using default:', err?.message)
              }
              console.log(`[RealtimeSession] Injecting ${isInterpret ? 0 : toolSchemas.length} voice tool schemas${isInterpret ? ' (同传模式:剥工具)' : ''} + ${instructions ? 'role system prompt' : 'default instructions'}`)
              const sessionUpdate = provider.getSessionConfig({
                voice: vc.voice || 'alloy',
                tools: isInterpret ? [] : toolSchemas,
                instructions,
                transcriptionLanguage: isInterpret ? null : undefined
              })
              activeSession.ws.send(JSON.stringify(sessionUpdate))
            }, 200)
          }

          // 记录所有关键事件（排除高频的 audio delta）
          if (event.type !== 'response.audio.delta' && event.type !== 'response.audio_transcript.delta') {
            console.log(`[RealtimeSession] Event: ${event.type}`)
          }

          // session.updated 表示服务端已就绪，可以开始转发音频
          if (event.type === 'session.updated') {
            sessionReady = true
            console.log('[RealtimeSession] Session ready, audio forwarding enabled')
          }

          // ── 手动接管 response 创建（create_response=false 配套）──
          // 跟踪 response 活跃态(防止重复 create 撞车),并在用户说完(committed)时建回复。
          // 工具回合的 response.create 在 handleVoiceFunctionCall 里发(工具结果注入之后),
          // 服务端不再抢先建"忽略工具结果"的回复 —— 这是修"答非所问 + conversation_already_has_active_response"的关键。
          // 用纯策略推进语音回合状态(可 headless 测试演示:多工具链式 + 无撞车 + 无死寂)
          {
            const decision = reduceVoiceTurn(
              { responseActive, toolChainStep: voiceToolChainStep },
              event.type
            )
            responseActive = decision.state.responseActive
            voiceToolChainStep = decision.state.toolChainStep
            if (decision.createResponse && activeSession && activeSession.ws.readyState === WebSocket.OPEN) {
              activeSession.ws.send(JSON.stringify({ type: 'response.create' }))
              console.log('[RealtimeSession] User turn committed → response.create')
            }
            if (decision.collisionAvoided) {
              console.warn('[voice-parity] committed while responseActive — skipped create (barge-in/race)')
            }
          }

          // ── Tool calling 追踪：response 中出现 function_call item 时记录 call_id → name 映射 ──
          if (event.type === 'response.output_item.added' && event.item?.type === 'function_call') {
            const callId = event.item.call_id
            const fnName = event.item.name
            if (callId && fnName) pendingFunctionCalls.set(callId, fnName)
          }

          // ── Tool calling: 收到完整的 function_call arguments ──
          // OpenAI Realtime 协议：.done 通常携带 name + arguments 字符串。
          // 兜底：name 缺失时从 pendingFunctionCalls 查 call_id 映射。
          if (event.type === 'response.function_call_arguments.done') {
            handleVoiceFunctionCall(event).catch((err) => {
              console.error('[RealtimeSession] function_call handling failed:', err)
            })
          }

          // 记录错误事件
          if (event.type === 'error') {
            console.error('[RealtimeSession] Server error:', JSON.stringify(event.error || event))
          }

          sendEventToRenderer(event)
        } catch {
          console.error('[RealtimeSession] Failed to parse message:', str.substring(0, 200))
        }
      })

      ws.on('error', (err) => {
        console.error('[RealtimeSession] WebSocket error:', err.message)
        if (activeSession?.ws === ws) sendStateToRenderer('error')
        if (!opened) finishStart({ success: false, error: err.message })
      })

      ws.on('close', (code, reason) => {
        console.log(`[RealtimeSession] Disconnected: code=${code} reason=${reason?.toString() || 'none'}`)
        if (activeSession?.ws === ws) {
          activeSession = null
          activeVoiceCid = null
          activeVoiceCtx = {}
          activeVoiceOverrides = undefined
          sendStateToRenderer('idle')
        }
        if (!opened) finishStart({ success: false, error: `Voice connection closed (${code})` })
      })

      // 连接超时
      setTimeout(() => {
        if (!opened && !startSettled) {
          if (activeSession?.ws === ws) activeSession = null
          ws.close()
          finishStart({ success: false, error: 'Connection timeout (10s)' })
        }
      }, 10000)

    } catch (err: any) {
      resolve({ success: false, error: err.message })
    }
  })
}

/**
 * 测试连接 — 用临时配置连一下，看是否能拿到 session.created
 * 不影响 activeSession（独立 WebSocket，验完即关）
 */
export function testRealtimeConnection(
  voiceConfig: VoiceConfig
): Promise<{ ok: true } | ({ ok: false } & MainFailure)> {
  // 豆包全双工: 走独立的 JSON 协议连接测试(OpenAI provider 接口不适用)。
  // 就地动态 import——testDoubaoDuplexConnection 只有这一个调用点，不必拖累 ensureAgentService
  // 里其余跟连接测试无关的 pi-agent-service/realtime-tool-bridge 链条。
  if ((voiceConfig.provider || '').toLowerCase() === 'doubao') {
    return import('./doubao-duplex-session').then((m) => m.testDoubaoDuplexConnection(voiceConfig))
  }
  return new Promise((resolve) => {
    if (!voiceConfig.apiKey) {
      resolve({ ok: false, ...mainError('settings.voice.errors.missingApiKey') })
      return
    }
    let provider
    try {
      provider = getRealtimeProvider(voiceConfig.provider)
    } catch (err: any) {
      resolve({ ok: false, error: err.message })
      return
    }

    const providerConfig: RealtimeProviderConfig = {
      baseUrl: voiceConfig.baseUrl,
      apiKey: voiceConfig.apiKey,
      model: voiceConfig.model,
      deployment: voiceConfig.deployment || voiceConfig.model,
      apiVersion: voiceConfig.apiVersion || '2025-04-01-preview'
    }

    let resolved = false
    let ws: WebSocket | null = null

    const finish = (result: { ok: true } | ({ ok: false } & MainFailure)): void => {
      if (resolved) return
      resolved = true
      try {
        ws?.close()
      } catch {}
      resolve(result)
    }

    try {
      ws = new WebSocket(provider.buildWebSocketURL(providerConfig), {
        headers: provider.buildAuthHeaders(providerConfig)
      })

      ws.on('open', () => {
        // 已建立 TCP/WS 握手；继续等 session.created 才算"真的能用"
      })

      ws.on('message', (data: WebSocket.Data) => {
        try {
          const event = JSON.parse(typeof data === 'string' ? data : data.toString())
          if (event.type === 'session.created') {
            finish({ ok: true })
          } else if (event.type === 'error') {
            finish({
              ok: false,
              ...serverFailure(event)
            })
          }
        } catch {
          // ignore parse errors
        }
      })

      ws.on('error', (err) => {
        finish({ ok: false, ...socketFailure(err) })
      })

      ws.on('close', (code) => {
        if (!resolved) {
          finish({ ok: false, ...mainError('settings.voice.errors.connectionClosed', { code: String(code) }) })
        }
      })

      setTimeout(() => finish({ ok: false, ...mainError('settings.voice.errors.connectTimeout') }), 8000)
    } catch (err: any) {
      finish({ ok: false, error: err.message })
    }
  })
}

// ─── 音色试听 ──────────────────────────────────────────────────────────────
// 独立 WS(不碰 activeSession):连上 → 设 voice → 让模型读一句固定样例 → 把
// response.audio.delta 流式推给 renderer('voice:preview-audio') → 播完即关。
// 音色 = 实际通话同一管线(同 provider.getSessionConfig / 同 pcm16),试听 100% 准。
let previewWs: WebSocket | null = null

const PREVIEW_SAMPLE = '你好，我是你的 AI 助手，很高兴为你服务。今天有什么可以帮你的吗？'

/** 取消正在进行的试听(切换音色 / 关闭面板时调用) */
export function stopVoicePreview(): void {
  if (previewWs) {
    try { previewWs.close() } catch {}
    previewWs = null
  }
}

export function previewVoice(
  voiceConfig: VoiceConfig,
  voice: string
): Promise<{ ok: true } | ({ ok: false } & MainFailure)> {
  return new Promise((resolve) => {
    if (!voiceConfig.apiKey) {
      resolve({ ok: false, ...mainError('settings.voice.errors.missingApiKey') })
      return
    }
    let provider
    try {
      provider = getRealtimeProvider(voiceConfig.provider)
    } catch (err: any) {
      resolve({ ok: false, error: err.message })
      return
    }

    const providerConfig: RealtimeProviderConfig = {
      baseUrl: voiceConfig.baseUrl,
      apiKey: voiceConfig.apiKey,
      model: voiceConfig.model,
      deployment: voiceConfig.deployment || voiceConfig.model,
      apiVersion: voiceConfig.apiVersion || '2025-04-01-preview'
    }

    // 取消上一段试听(快速点不同音色时)
    stopVoicePreview()

    let resolved = false
    let gotAudio = false
    let ws: WebSocket | null = null

    const sendToRenderer = (channel: string, ...args: any[]): void => {
      const win = windowRef?.()
      if (win && !win.isDestroyed()) win.webContents.send(channel, ...args)
    }
    const finish = (result: { ok: true } | ({ ok: false } & MainFailure)): void => {
      if (resolved) return
      resolved = true
      try { ws?.close() } catch {}
      if (previewWs === ws) previewWs = null
      resolve(result)
    }

    try {
      ws = new WebSocket(provider.buildWebSocketURL(providerConfig), {
        headers: provider.buildAuthHeaders(providerConfig)
      })
      previewWs = ws

      ws.on('message', (data: WebSocket.Data) => {
        let event: any
        try {
          event = JSON.parse(typeof data === 'string' ? data : data.toString())
        } catch {
          return
        }
        switch (event.type) {
          case 'session.created':
            // 设音色(复用实际通话的 session 配置,保证 pcm16 / modalities 一致)
            ws!.send(JSON.stringify(provider.getSessionConfig({ voice })))
            break
          case 'session.updated':
            // 让模型逐字朗读固定样例(per-response instructions 覆盖 session 指令)
            ws!.send(JSON.stringify({
              type: 'response.create',
              response: {
                modalities: ['audio', 'text'],
                instructions: `用自然亲切的语气朗读下面这句话，一字不差，不要添加任何额外内容：${PREVIEW_SAMPLE}`
              }
            }))
            break
          case 'response.audio.delta':
            if (event.delta) {
              gotAudio = true
              sendToRenderer('voice:preview-audio', event.delta)
            }
            break
          case 'response.audio.done':
          case 'response.done':
            finish({ ok: true })
            break
          case 'error':
            // marin/cedar 在 preview 模型上不被支持 → 服务端在这里报错,原文回给 UI 提示换模型
            finish({ ok: false, ...serverFailure(event) })
            break
        }
      })

      ws.on('error', (err) => finish({ ok: false, ...socketFailure(err) }))
      ws.on('close', (code) => {
        if (!resolved) finish(gotAudio ? { ok: true } : { ok: false, ...mainError('settings.voice.errors.connectionClosed', { code: String(code) }) })
      })

      // 兜底超时:有音频就算成功(播放在 renderer 侧),否则报超时
      setTimeout(() => {
        if (!resolved) finish(gotAudio ? { ok: true } : { ok: false, ...mainError('settings.voice.errors.previewTimeout') })
      }, 15000)
    } catch (err: any) {
      finish({ ok: false, error: err.message })
    }
  })
}

/**
 * 停止 Realtime 语音会话
 */
export function stopRealtimeSession(): void {
  pendingFunctionCalls.clear() // 挂断即释放本次会话的 call_id→name 映射,不留到下次通话
  const clearExecutionContext = (): void => {
    activeVoiceCid = null
    activeVoiceCtx = {}
    activeVoiceOverrides = undefined
  }
  if (activeDuplex) {
    console.log('[RealtimeSession] Stopping (豆包全双工)')
    try { activeDuplex.close() } catch {}
    activeDuplex = null
    clearExecutionContext()
    sendStateToRenderer('idle')
    return
  }
  if (activeDoubao) {
    console.log('[RealtimeSession] Stopping (豆包同传)')
    try { activeDoubao.close() } catch {}
    activeDoubao = null
    clearExecutionContext()
    sendStateToRenderer('idle')
    return
  }
  if (activeSession) {
    console.log('[RealtimeSession] Stopping')
    const session = activeSession
    activeSession = null
    session.cancelStart?.()
    try {
      session.ws.close()
    } catch { /* best-effort stop during teardown */ }
    clearExecutionContext()
    sendStateToRenderer('idle')
    return
  }
  clearExecutionContext()
}

/**
 * 从 Renderer 转发事件到 WebSocket
 */
export function sendRealtimeEvent(event: any): void {
  // 豆包全双工:append 直接转发(同名同形), response.cancel 转发, 其余忽略
  if (activeDuplex) {
    activeDuplex.handleClientEvent(event)
    return
  }
  // 豆包同传:把渲染端的 input_audio_buffer.append 转成豆包 TaskRequest(其余 OpenAI 专用事件忽略)
  if (activeDoubao) {
    activeDoubao.handleClientEvent(event)
    return
  }
  if (activeSession && activeSession.ws.readyState === WebSocket.OPEN) {
    // 只在 session 完全就绪后才转发音频数据
    if (event.type === 'input_audio_buffer.append' && !sessionReady) {
      return
    }
    if (event.type === 'input_audio_buffer.append') {
      // 每 50 次打一条日志，避免刷屏
      audioSendCount++
      if (audioSendCount % 50 === 1) {
        console.log(`[RealtimeSession] Sending audio chunk #${audioSendCount}, size=${event.audio?.length || 0}`)
      }
    }
    activeSession.ws.send(JSON.stringify(event))
  }
}

// ─── 内部辅助 ───────────────────────────────────────────

/**
 * 处理 voice 模式下的 function_call。
 *
 * Authorization lives in executeVoiceTool, the single final sink shared by
 * every realtime provider. Keeping it there prevents direct callers and future
 * provider adapters from bypassing the text-conversation policy.
 */
async function handleVoiceFunctionCall(event: any): Promise<void> {
  await ensureRealtimeDependencies() // 正常时序下 startRealtimeSession 已预热,这里是幂等保险

  if (!activeSession || activeSession.ws.readyState !== WebSocket.OPEN) return

  const callId: string | undefined = event.call_id
  const name: string | undefined = event.name || (callId ? pendingFunctionCalls.get(callId) : undefined)
  const argsJson: string = typeof event.arguments === 'string' ? event.arguments : JSON.stringify(event.arguments || {})

  if (!callId || !name) {
    console.error('[RealtimeSession] function_call.done missing call_id or name', { callId, name })
    return
  }

  // 清理追踪表（不论后续如何，这个 call_id 不会再用）
  pendingFunctionCalls.delete(callId)

  console.log(`[RealtimeSession] Voice tool call: ${name} (call_id=${callId})`)
  // parity 客观信号:本回合第 N 个工具。N>1 = 多工具链式生效(语音能像文字一样一个任务连调多工具)
  voiceToolChainStep = reduceVoiceTurn({ responseActive, toolChainStep: voiceToolChainStep }, TOOL_EXECUTED).state.toolChainStep
  console.log(`[voice-parity] tool-chain step ${voiceToolChainStep} this turn: ${name}`)

  // executeVoiceTool parses once, authorizes, and only then executes. A denied
  // call is returned as a normal tool error for the realtime model to explain.
  const execRes = await executeVoiceTool(name, argsJson, activeVoiceCtx).catch((err) => ({
    output: JSON.stringify({ error: err?.message || 'execution failed' }), raw: null
  }))

  // 把工具产出的 artifact/visualizer 渲染到聊天面板（复用文字模式的 chat:* 管线）
  emitToolArtifactToChat(name, execRes.raw)

  sendWsJson({
    type: 'conversation.item.create',
    item: { type: 'function_call_output', call_id: callId, output: execRes.output }
  })
  sendWsJson({ type: 'response.create' })
  console.log(`[RealtimeSession] Tool ${name} executed (${execRes.output.length} chars), triggered response.create`)
}

/**
 * 把语音工具的执行过程 + 产出发到 renderer，复用文字模式的 chat:* 渲染管线。
 * 让用户在聊天面板看到「调了什么工具 + 结果/可视化」，与文字模式一致。
 * 用 activeVoiceCid 作为会话 id，chatStore 的 onToolStart/onToolEnd/onArtifact 据此接住渲染。
 */
function emitToolArtifactToChat(name: string, raw: any): void {
  if (!raw) return
  const win = windowRef?.()
  if (!win || win.isDestroyed()) return
  const cid = activeVoiceCid || ''
  const d = raw.details || {}

  // 先建工具锚点（用户看到调了什么工具）
  win.webContents.send('chat:tool-start', cid, name)

  if (d.visualizer) {
    // create_visualizer → 内联可视化卡片
    win.webContents.send('chat:tool-end', cid, name, undefined, undefined, undefined, undefined, d.visualizer)
    console.log(`[RealtimeSession] Emitted visualizer to chat (cid=${cid})`)
  } else if (d.artifact) {
    // create_artifact → 侧栏 artifact
    win.webContents.send('chat:tool-end', cid, name)
    win.webContents.send('chat:artifact', cid, d.artifact)
    console.log(`[RealtimeSession] Emitted artifact to chat (cid=${cid})`)
  } else {
    // 通用工具（generate_document / web_search / execute_code 等）：
    // 把结果文本放到 chat:tool-end 的 mcpResult 位置（renderer 形参顺序：cid, name, screenshot, searchResults, mcpResult, mcpArgs, visualizer）
    // 注意：mcpResult 不是"mcp 工具才用"——它是"工具的文本结果通道"，所有通用工具都用它
    const text =
      d.displayResult ||
      (Array.isArray(raw.content)
        ? raw.content.filter((b: any) => b?.type === 'text').map((b: any) => b.text).join('\n')
        : '')
    const argsJson = d.args ? JSON.stringify(d.args) : undefined
    win.webContents.send(
      'chat:tool-end', cid, name,
      d.screenshot,     // screenshot
      d.searchResults,  // searchResults(必须是真正的搜索结果,别用 text 覆盖)
      text || undefined,// mcpResult(通用工具的结果通道)
      argsJson,         // mcpArgs
      undefined         // visualizer
    )
    console.log(`[RealtimeSession] Emitted tool card to chat: ${name} (cid=${cid}, textLen=${text.length})`)
  }
}

/** WS 安全发送 —— 如果 session 已关闭就静默丢弃 */
function sendWsJson(payload: any): void {
  if (!activeSession || activeSession.ws.readyState !== WebSocket.OPEN) return
  activeSession.ws.send(JSON.stringify(payload))
}

function sendEventToRenderer(event: any): void {
  const win = windowRef?.()
  if (win && !win.isDestroyed()) {
    win.webContents.send('realtime:event', event)
  }
}

function sendStateToRenderer(state: string): void {
  const win = windowRef?.()
  if (win && !win.isDestroyed()) {
    win.webContents.send('realtime:state', state)
  }
  if (state === 'idle' || state === 'error') {
    try {
      lifecycleListener?.(state)
    } catch (error) {
      console.error('[RealtimeSession] lifecycle listener failed:', error)
    }
  }
}

/**
 * Realtime Voice Provider 抽象层 (Main Process)
 *
 * 不同服务商的 URL 构造、鉴权 header、session 配置可能不同。
 * 把这些差异封装在 Provider 接口里，realtime-session.ts 通过 provider 名拿到具体实现。
 *
 * 当前支持：
 *   - openai     : OpenAI 直连或 302.ai 这类 OpenAI 兼容代理
 *   - azure      : Microsoft Azure OpenAI 部署（含 Azure AI Foundry 暴露的传统 Azure OpenAI endpoint）
 */

export interface RealtimeProviderConfig {
  baseUrl: string
  apiKey: string
  /** OpenAI 路径下作为 URL 查询参数 model；Azure 路径下若未单独配 deployment 则作为 deployment fallback */
  model: string
  /** Azure 专用：api-version 查询参数 */
  apiVersion?: string
  /** Azure 专用：部署名（用户在 Azure portal 给部署起的别名）。未提供时回落到 model */
  deployment?: string
}

export interface RealtimeSessionOptions {
  voice?: string
  instructions?: string
  /** 工具 schema，由 role-manager 注入。P3 启用 */
  tools?: Array<{ type: 'function'; name: string; description: string; parameters: object }>
  /** 覆盖 turn_detection 配置（不传则默认 semantic_vad）。用于模型不支持 semantic_vad 时回退 server_vad */
  turnDetection?: Record<string, unknown>
  /**
   * 输入转录(ASR)的源语言偏置。
   *  - undefined → 默认 'zh'(文字 chat 模式不变,偏置简体)
   *  - 具体语言码(如 'en') → 用它
   *  - null → 省略 language → 自动检测(同传模式:说话人源语言未知时用)
   */
  transcriptionLanguage?: string | null
}

export interface RealtimeEventMap {
  // Client → Server
  sessionUpdate: string
  inputAudioAppend: string
  inputAudioCommit: string
  responseCreate: string

  // Server → Client
  sessionCreated: string
  sessionUpdated: string
  speechStarted: string
  speechStopped: string
  audioBufferCommitted: string
  conversationItemCreated: string
  userTranscriptCompleted: string
  responseAudioDelta: string
  responseAudioDone: string
  responseTranscriptDelta: string
  responseTranscriptDone: string
  responseDone: string
  error: string
}

export interface RealtimeProvider {
  readonly name: string
  readonly eventMap: RealtimeEventMap

  buildWebSocketURL(config: RealtimeProviderConfig): string
  buildAuthHeaders(config: RealtimeProviderConfig): Record<string, string>
  getSessionConfig(options?: RealtimeSessionOptions): object
}

// ─── 公共：OpenAI 协议族的事件名（OpenAI / Azure / 302.ai 共用）────────────────
const OPENAI_EVENT_MAP: RealtimeEventMap = {
  sessionUpdate: 'session.update',
  inputAudioAppend: 'input_audio_buffer.append',
  inputAudioCommit: 'input_audio_buffer.commit',
  responseCreate: 'response.create',

  sessionCreated: 'session.created',
  sessionUpdated: 'session.updated',
  speechStarted: 'input_audio_buffer.speech_started',
  speechStopped: 'input_audio_buffer.speech_stopped',
  audioBufferCommitted: 'input_audio_buffer.committed',
  conversationItemCreated: 'conversation.item.created',
  userTranscriptCompleted: 'conversation.item.input_audio_transcription.completed',
  responseAudioDelta: 'response.audio.delta',
  responseAudioDone: 'response.audio.done',
  responseTranscriptDelta: 'response.audio_transcript.delta',
  responseTranscriptDone: 'response.audio_transcript.done',
  responseDone: 'response.done',
  error: 'error'
}

const DEFAULT_INSTRUCTIONS =
  'You are a helpful assistant. Respond naturally in the same language the user speaks.'

function buildSessionConfigPayload(options?: RealtimeSessionOptions): object {
  // 输入转录语言:undefined→默认 'zh';具体语言码→用它;null/'' →省略 language(自动检测,同传源语言未知时用)
  const transcription: Record<string, unknown> = { model: 'gpt-4o-transcribe' }
  if (options?.transcriptionLanguage === undefined) transcription.language = 'zh'
  else if (options.transcriptionLanguage) transcription.language = options.transcriptionLanguage
  const session: Record<string, unknown> = {
    modalities: ['text', 'audio'],
    voice: options?.voice || 'alloy',
    instructions: options?.instructions || DEFAULT_INSTRUCTIONS,
    input_audio_format: 'pcm16',
    output_audio_format: 'pcm16',
    // 输入转录(你说的话→文字)。gpt-4o-transcribe = 2025 新 ASR,中文/简体明显比 whisper-1 准。
    // 不带 prompt:gpt-4o-transcribe 会把 prompt 原文当转录回显(出现"请用简体中文转写。"这种),
    //   且 prompt 会在静音/短音频时"种"出幻觉(如"点赞订阅转发打赏")。只留 language='zh' 偏置简体。
    // 注:这是 ASR(转录),不是翻译。若 eeo 网关不支持该模型 → 回退 'gpt-4o-mini-transcribe' / 'whisper-1'。
    input_audio_transcription: transcription,
    // server_vad：按音频能量 + 静音时长判断轮替（而非 semantic_vad 的"语义判断说完没"）。
    //  - threshold=0.5：触发"检测到说话"的能量阈值
    //  - silence_duration_ms=700：连续静音超过这个时长才算"用户说完"。比默认 500 略高，
    //    为的是不把 AI 中英混排时的短停顿（中↔英切换 <300ms）误判成"用户插话/轮到我说"。
    //  - interrupt_response=true：真有用户音频才打断 AI（barge-in 服务端侧；客户端另有 flushPlayback）
    //  - create_response=FALSE：⚠️ 关键。不让服务端自动建回复 —— 由 main 在 input_audio_buffer.committed
    //    (用户说完) + 工具结果注入后,自己发 response.create。否则服务端会在 function_call 回合一结束就
    //    抢先建一个回复(早于 31s 后才回来的工具结果) → 那个回复忽略搜索结果(答"没查到") + 撞上我们的
    //    真·总结回复 → conversation_already_has_active_response。手动接管 = 永远等工具结果 + 单一创建者。
    // 历史教训：semantic_vad 在老模型(gpt-4o-realtime-preview-2024-12-17)+302.ai 上会在中英切换停顿处
    //    误判轮替 → interrupt_response 掐断 AI，表现为"每次到英文就中断"。回退 server_vad 规避。
    //    升级到 gpt-realtime 后想要更自然轮替，可经 options.turnDetection 传 semantic_vad 覆盖。
    turn_detection: options?.turnDetection || {
      type: 'server_vad',
      // threshold=0.7:能量门槛调高,过滤周边杂音(0.5 太低,环境噪声会越过门槛被当成说话→转录出杂音/幻觉)。
      // 若安静环境下反而漏掉小声说话,再下调到 0.6。
      threshold: 0.7,
      prefix_padding_ms: 300,
      silence_duration_ms: 700,
      create_response: false,
      interrupt_response: true
    }
  }
  if (options?.tools && options.tools.length > 0) {
    session.tools = options.tools
    session.tool_choice = 'auto'
  }
  return { type: 'session.update', session }
}

// ─── OpenAI / 302.ai ──────────────────────────────────────────────────────────
export class OpenAIRealtimeProvider implements RealtimeProvider {
  readonly name = 'openai'
  readonly eventMap = OPENAI_EVENT_MAP

  buildWebSocketURL(config: RealtimeProviderConfig): string {
    const wsUrl = config.baseUrl
      .replace(/^https:\/\//, 'wss://')
      .replace(/^http:\/\//, 'ws://')
    return `${wsUrl}?model=${encodeURIComponent(config.model)}`
  }

  buildAuthHeaders(config: RealtimeProviderConfig): Record<string, string> {
    return {
      Authorization: `Bearer ${config.apiKey}`,
      'OpenAI-Beta': 'realtime=v1'
    }
  }

  getSessionConfig(options?: RealtimeSessionOptions): object {
    return buildSessionConfigPayload(options)
  }
}

// ─── Azure OpenAI (含 Foundry 暴露的传统 Azure OpenAI endpoint) ───────────────
export class AzureRealtimeProvider implements RealtimeProvider {
  readonly name = 'azure'
  readonly eventMap = OPENAI_EVENT_MAP // 协议体与 OpenAI 同源

  buildWebSocketURL(config: RealtimeProviderConfig): string {
    let base = config.baseUrl
      .replace(/^https:\/\//, 'wss://')
      .replace(/^http:\/\//, 'ws://')
      .replace(/\/+$/, '')

    // 兼容两种用户填法：
    //   1. https://<resource>.openai.azure.com                       → 自动追加 /openai/realtime
    //   2. https://<resource>.openai.azure.com/openai/realtime       → 直接用
    if (!/\/openai\/realtime$/.test(base)) {
      base = `${base}/openai/realtime`
    }

    const deployment = config.deployment || config.model
    const apiVersion = config.apiVersion || '2025-04-01-preview'
    return `${base}?api-version=${encodeURIComponent(apiVersion)}&deployment=${encodeURIComponent(deployment)}`
  }

  buildAuthHeaders(config: RealtimeProviderConfig): Record<string, string> {
    return {
      'api-key': config.apiKey
    }
  }

  getSessionConfig(options?: RealtimeSessionOptions): object {
    return buildSessionConfigPayload(options)
  }
}

// ─── 注册表 ───────────────────────────────────────────────────────────────────
const providers: Record<string, RealtimeProvider> = {
  openai: new OpenAIRealtimeProvider(),
  azure: new AzureRealtimeProvider()
}

export function getRealtimeProvider(name: string = 'openai'): RealtimeProvider {
  const provider = providers[name.toLowerCase()]
  if (!provider) {
    throw new Error(
      `Unknown realtime provider: ${name}. Available: ${Object.keys(providers).join(', ')}`
    )
  }
  return provider
}

export function listRealtimeProviders(): string[] {
  return Object.keys(providers)
}

/**
 * 豆包全双工实时语音 3.0 (Seeduplex) — 协议常量 + 鉴权 + 事件归一化
 *
 * 端点:  wss://openspeech.bytedance.com/api/v3/duplex/realtime/dialogue
 * 产品:  Doubao 端到端实时语音「全双工版本」(2026-06 发布; 纯 JSON 文本帧, OpenAI-Realtime 风格)
 * 文档:  https://www.volcengine.com/docs/6561/2549778 (API) + 6561/2549732 (接入必读)
 *
 * 三条豆包语音路径勿混:
 *   - 同传 AST v4 (`/v4/ast/v2/translate`): 裸 Protobuf, 见 doubao-ast-*.ts (interpreter 角色专用)
 *   - 旧版直连 WS (`/v3/realtime/dialogue`): 二进制 4 字节头, 无 function calling
 *   - **本文件: 全双工 (`/v3/duplex/realtime/dialogue`)**: 纯 JSON 文本帧, 原生 function calling
 *
 * 设计原则(同 DoubaoInterpretSession): main 进程内部讲豆包全双工事件, 对外**只产出与
 * realtime-session.ts 完全同构的 OpenAI-Realtime IPC 事件** —— 渲染端(useRealtimeVoice / audio-engine)
 * 分不出后端是 GPT 还是豆包, 零改动。
 *
 * 全部为官方文档 + Go SDK(GizClaw/doubao-speech-go) 实锤, 非猜测。
 */

/** 全双工 WebSocket 端点(固定) */
export const DOUBAO_DUPLEX_ENDPOINT = 'wss://openspeech.bytedance.com/api/v3/duplex/realtime/dialogue'

/** 模型版本(文档死锁固定值, 必填) */
export const DOUBAO_DUPLEX_MODEL = '1.2.6.0'

/**
 * 鉴权 header: 新版控制台只需 X-Api-Key(放握手 header, 协议无 ephemeral token)。
 * OpenPipal 复用 VoiceConfig.apiKey 作为 X-Api-Key。
 */
export function buildDoubaoDuplexHeaders(apiKey: string, appId?: string): Record<string, string> {
  const headers: Record<string, string> = { 'X-Api-Key': apiKey }
  if (appId) headers['X-Api-App-Id'] = appId
  return headers
}

/** 上行事件 type (client → server) */
export const DuplexClientEvent = {
  SessionCreate: 'session.create',
  SessionUpdate: 'session.update',
  SessionClose: 'session.close',
  /** 发送音频(base64 PCM16/16k 在 audio 字段) */
  AudioAppend: 'input_audio_buffer.append',
  /** 强制判停一轮用户输入 */
  AudioCommit: 'input_audio_buffer.commit',
  /** 注入上下文 / FC 结果回传(items 数组) */
  ItemCreate: 'conversation.item.create',
  /** 客户端打断 */
  ResponseCancel: 'response.cancel'
} as const

/** 下行事件 type (server → client) */
export const DuplexServerEvent = {
  SessionCreated: 'session.created',
  SessionUpdated: 'session.updated',
  SessionClosed: 'session.closed',
  AudioCommitted: 'input_audio_buffer.committed',
  /** ASR 首字(打断本端播报用) */
  AsrStarted: 'conversation.item.input_audio_transcription.started',
  /** ASR 增量 */
  AsrDelta: 'conversation.item.input_audio_transcription.delta',
  /** ASR 完成(用户转录, transcript 字段) —— 与 OpenAI 同名, 直传 */
  AsrCompleted: 'conversation.item.input_audio_transcription.completed',
  AsrFailed: 'conversation.item.input_audio_transcription.failed',
  /** 助手文字增量(delta 字段) → remap 成 response.audio_transcript.delta */
  TextDelta: 'response.output_text.delta',
  /** 助手文字结束(text 字段) → remap 成 response.audio_transcript.done */
  TextDone: 'response.output_text.done',
  AudioStarted: 'response.output_audio.started',
  /** 助手音频增量(delta=base64 pcm16@24k) → remap 成 response.audio.delta */
  AudioDelta: 'response.output_audio.delta',
  /** 助手音频结束 → remap 成 response.audio.done */
  AudioDone: 'response.output_audio.done',
  /** 工具调用下发(items 数组, 无 .delta 流式) */
  FunctionCallDone: 'response.function_call_arguments.done',
  /** 一轮结束 + usage */
  ResponseDone: 'response.done',
  ResponseCanceled: 'response.canceled',
  Error: 'error'
} as const

/**
 * 音色(S2S-Omni 全双工仅 4 个 jupiter 音色; 用错报 InvalidSpeaker)。
 * 文档: https://www.volcengine.com/docs/6561/1257544
 */
export const DOUBAO_DUPLEX_VOICES = [
  { id: 'zh_female_vv_jupiter_bigtts', label: 'vivi（女）' },
  { id: 'zh_female_xiaohe_jupiter_bigtts', label: '小何（女）' },
  { id: 'zh_male_yunzhou_jupiter_bigtts', label: '云舟（男）' },
  { id: 'zh_male_xiaotian_jupiter_bigtts', label: '小天（男）' }
] as const

export const DOUBAO_DUPLEX_DEFAULT_VOICE = 'zh_female_vv_jupiter_bigtts'

const DOUBAO_DUPLEX_VOICE_IDS = new Set<string>(DOUBAO_DUPLEX_VOICES.map((v) => v.id))

/** 强制合法音色: 非全双工 4 音色之一(如残留的 OpenAI 'alloy')一律回退默认, 防服务端 InvalidSpeaker。 */
export function coerceDuplexVoice(v?: string): string {
  return v && DOUBAO_DUPLEX_VOICE_IDS.has(v) ? v : DOUBAO_DUPLEX_DEFAULT_VOICE
}

/**
 * 音频格式(文档硬约束)
 *  - 入: PCM16 / 单声道 / 16000 / 小端 (渲染端 AudioEngine 采集)
 *  - 出: pcm_s16le / 单声道 / 24000 / 小端 (= OpenAI realtime 输出同构, 渲染端播放零改)
 */
export const DOUBAO_DUPLEX_AUDIO = {
  inputRate: 16000,
  outputRate: 24000
} as const

/** OpenAI Realtime 工具 schema(扁平), 与 realtime-tool-bridge.buildVoiceToolSchemas 输出同构 */
export interface DuplexToolSchema {
  type: 'function'
  name: string
  description: string
  parameters: any
}

export interface BuildSessionCreateOpts {
  /** 系统提示词 → session.instructions */
  instructions: string
  /** 工具集(直接来自 buildVoiceToolSchemas) */
  tools: DuplexToolSchema[]
  /** 音色 */
  voice: string
  /** 接续历史对话的 dialog id(可选) */
  dialogId?: string
}

/** 构造 session.create payload(输出 pcm_s16le@24k, 不发 turn_detection —— 全双工服务端原生 VAD) */
export function buildSessionCreate(o: BuildSessionCreateOpts): Record<string, unknown> {
  const session: Record<string, unknown> = {
    type: 'realtime',
    model: DOUBAO_DUPLEX_MODEL,
    instructions: o.instructions,
    audio: {
      input: { format: { type: 'pcm', rate: DOUBAO_DUPLEX_AUDIO.inputRate } },
      output: {
        format: { type: 'pcm_s16le', rate: DOUBAO_DUPLEX_AUDIO.outputRate },
        speed: 0,
        loudness: 0,
        voice: o.voice
      }
    },
    tools: o.tools
  }
  if (o.dialogId) session.id = o.dialogId
  return {
    type: DuplexClientEvent.SessionCreate,
    session,
    // extension 透传专有能力(联网/克隆音色/热词等), 首版留空对象
    extension: { asr: {}, tts: {}, dialog: {} }
  }
}

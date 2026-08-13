/**
 * 豆包同声传译 2.0 (AST v2) — 协议常量 + 鉴权 + 事件语义归一化
 *
 * 端点:  wss://openspeech.bytedance.com/api/v4/ast/v2/translate
 * 文档:  https://www.volcengine.com/docs/6561/1756902
 *
 * 设计原则(勿增实体):本模块 + DoubaoInterpretSession 在 main 进程内部讲豆包的 Protobuf 二进制协议,
 * 但**对外只产出与 realtime-session.ts 完全同构的 OpenAI-Realtime IPC 事件**——渲染端
 * (useRealtimeVoice / audio-engine)分不出后端是 GPT 还是豆包,P1–P3 全栈零改动。
 *
 * 本文件只放**文档已 100% 确定、零猜测**的部分:端点 / 鉴权 / 事件码 / 事件→语义归一化表。
 *
 * ⚠️ 仍缺(在官方 protos.tar.gz / ast_python_client 里,拿到后落到 doubao-ast-frame.ts):
 *    - 二进制 framing 的 4 字节头字节布局(protocol version / header size / message type /
 *      message-type-specific flags / **serialization 方法 nibble(protobuf 取值)** / compression)
 *    - protobuf 各 message 的字段号(StartSession / TaskRequest / 各 *Response)
 *    这两项必须照 demo 来,不能从 JSON 示例反推。
 */

/** AST v2 WebSocket 端点(固定) */
export const DOUBAO_AST_ENDPOINT = 'wss://openspeech.bytedance.com/api/v4/ast/v2/translate'

/** Resource-Id —— 文档写死的同传服务资源标识 */
export const DOUBAO_AST_RESOURCE_ID = 'volc.service_type.10053'

/** 发送端事件码(client → server) */
export const ClientEvent = {
  /** 建联请求(第一个包) */
  StartSession: 100,
  /** 结束 session(不带音频,音频发完后发) */
  FinishSession: 102,
  /** 发送音频数据 */
  TaskRequest: 200,
  /** 会话中更新语料/干预词(不可切语言/mode) */
  UpdateConfig: 201
} as const

/** 接收端事件码(server → client) */
export const ServerEvent = {
  /** 建联成功 —— 收到后才能发参数包/音频包 */
  SessionStarted: 150,
  /** 会话正常结束 */
  SessionFinished: 152,
  /** 会话失败 */
  SessionFailed: 153,
  /** 计量计费(忽略/仅记日志) */
  UsageResponse: 154,
  /** VAD 静音事件(忽略) */
  AudioMuted: 250,
  /** TTS(译后音频)开始 */
  TTSSentenceStart: 350,
  /** TTS 结束 */
  TTSSentenceEnd: 351,
  /** TTS 数据 —— data 为译后音频(按 target_audio 格式) */
  TTSResponse: 352,
  /** 原文(你说的话)开始,带 start_time / spk_chg */
  SourceSubtitleStart: 650,
  /** 原文数据 —— text 为识别出的源文 */
  SourceSubtitleResponse: 651,
  /** 原文结束 */
  SourceSubtitleEnd: 652,
  /** 译文开始 */
  TranslationSubtitleStart: 653,
  /** 译文数据 —— text 为译文 */
  TranslationSubtitleResponse: 654,
  /** 译文结束 */
  TranslationSubtitleEnd: 655
} as const

export type ServerEventCode = (typeof ServerEvent)[keyof typeof ServerEvent]

/**
 * 鉴权 header 配置。
 *  - 新版控制台(推荐):只需 apiKey(X-Api-Key)+ resourceId
 *  - 旧版控制台:appId(X-Api-App-Id)+ accessKey(X-Api-Access-Key)+ resourceId
 */
export interface DoubaoAuthConfig {
  apiKey?: string
  appId?: string
  accessKey?: string
  resourceId?: string
}

/** 构造 WebSocket 握手 HTTP header(豆包 AST 把鉴权放在 header,不放 URL query) */
export function buildDoubaoAuthHeaders(cfg: DoubaoAuthConfig): Record<string, string> {
  const headers: Record<string, string> = {
    'X-Api-Resource-Id': cfg.resourceId || DOUBAO_AST_RESOURCE_ID
  }
  if (cfg.apiKey) headers['X-Api-Key'] = cfg.apiKey
  if (cfg.appId) headers['X-Api-App-Id'] = cfg.appId
  if (cfg.accessKey) headers['X-Api-Access-Key'] = cfg.accessKey
  return headers
}

/**
 * 豆包服务端事件 → 现有 OpenAI-Realtime IPC 事件 的归一化语义表。
 *
 * 这是整个适配器的"价值粘合层":DoubaoInterpretSession 解出 {event, text, data} 后照此表
 * 翻成渲染端早已在听的事件名,从而**复用** useRealtimeVoice 的字幕轨/音频播放/打断逻辑。
 *
 * 注:realtime-provider.OPENAI_EVENT_MAP 是这些目标事件名的权威来源。
 *  - 原文(你说的)≈ 用户语音转录 → userTranscriptCompleted
 *  - 译文(AI 给的)≈ 助手文字 → responseTranscriptDelta/Done
 *  - 译后音频 ≈ 助手音频 → responseAudioDelta/Done
 */
export const DOUBAO_EVENT_SEMANTICS: Record<
  number,
  { ipc: string; carries: 'text' | 'audio' | 'control' | 'ignore'; note: string }
> = {
  [ServerEvent.SessionStarted]: { ipc: 'session.updated', carries: 'control', note: '建联成功 → 允许转发音频(等价 session.updated 后 sessionReady=true)' },
  [ServerEvent.SourceSubtitleResponse]: { ipc: 'conversation.item.input_audio_transcription.completed', carries: 'text', note: '原文(源语种逐字稿)→ 用户转录完成,text→event.transcript' },
  [ServerEvent.TranslationSubtitleStart]: { ipc: 'response.created', carries: 'control', note: '译文开始 → 一轮回复开始' },
  [ServerEvent.TranslationSubtitleResponse]: { ipc: 'response.audio_transcript.delta', carries: 'text', note: '译文文本 → 助手字幕 delta,text→event.delta' },
  [ServerEvent.TranslationSubtitleEnd]: { ipc: 'response.audio_transcript.done', carries: 'text', note: '译文结束 → 助手字幕 done,text→event.transcript' },
  [ServerEvent.TTSResponse]: { ipc: 'response.audio.delta', carries: 'audio', note: '译后音频 → 助手音频 delta,data(base64/bytes)→event.delta' },
  [ServerEvent.TTSSentenceEnd]: { ipc: 'response.audio.done', carries: 'control', note: 'TTS 句末 → 助手音频 done' },
  [ServerEvent.SessionFinished]: { ipc: 'response.done', carries: 'control', note: '会话正常结束' },
  [ServerEvent.SessionFailed]: { ipc: 'error', carries: 'control', note: '会话失败 → 透传 response_meta.message' },
  [ServerEvent.UsageResponse]: { ipc: '', carries: 'ignore', note: '计量计费 → 仅记日志' },
  [ServerEvent.AudioMuted]: { ipc: '', carries: 'ignore', note: 'VAD 静音 → 忽略' },
  [ServerEvent.SourceSubtitleStart]: { ipc: '', carries: 'ignore', note: '原文开始(只带时间戳/说话人切换)→ 暂忽略,文本在 651 给' },
  [ServerEvent.SourceSubtitleEnd]: { ipc: '', carries: 'ignore', note: '原文结束 → 暂忽略' },
  [ServerEvent.TTSSentenceStart]: { ipc: '', carries: 'ignore', note: 'TTS 句首(只带时间戳)→ 暂忽略' }
}

/** 输入/输出音频格式(文档硬约束) */
export const DOUBAO_AUDIO = {
  /** 源音频:必须 16k / 16bit / 单声道 / wav 容器 / raw(pcm) 编码 / 建议 80ms 一包 */
  input: { format: 'wav', codec: 'raw', rate: 16000, bits: 16, channel: 1, packetMs: 80 } as const,
  /**
   * 目标音频(s2s):选 pcm/16000 → 16bit 整型,与现有 audio-engine 的 pcm16 同构(只是 16k 而非 24k)。
   * 避免 24k(pcm 在 24k 下是 32float)与 48k(ogg_opus)带来的解码/重采样负担。
   */
  output: { format: 'pcm', rate: 16000, bits: 16 } as const
}

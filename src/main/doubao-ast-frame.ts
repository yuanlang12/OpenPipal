/**
 * 豆包同声传译 2.0 (AST v2) — Protobuf 帧编解码
 *
 * 关键事实(实测确认,非猜测):AST **v4** 端点(`/api/v4/ast/v2/translate`)直接走
 * **裸 Protobuf over WebSocket**——没有字节跳动老版语音协议那套 4 字节头/序列化 nibble/压缩位/
 * event-int32 framing。WS 二进制帧的 payload 就是一条 `TranslateRequest`/`TranslateResponse`,
 * `event`(100/200/102…)是消息**字段**(field 2)而非帧头。所以:
 *    发送: TranslateRequest.encode(payload).finish()  → ws.send(buf)
 *    接收: TranslateResponse.decode(frame)
 *
 * 本文件是**自写 clean-room 实现**:下面的 .proto 只含我们要用的消息,字段**号**照字节跳动官方
 * 协议(互操作必需的事实,enum/int32 在 wire 上都是 varint,故 event 直接声明 int32 简化)。
 * 未参考/未拷贝任何 AGPL 第三方实现的源码,仅复用"协议事实"(字段号/端点/事件码)。
 *
 * 字段号权威来源(字节跳动官方 proto,Copyright ByteDance):
 *   TranslateRequest { request_meta=1, event=2, user=3, source_audio=4, target_audio=5, request=6 }
 *   TranslateResponse{ response_meta=1, event=2, data=3, text=4, start_time=5, end_time=6, spk_chg=7, muted_duration_ms=8 }
 *   RequestMeta { Endpoint=1, AppKey=2, AppID=3, ResourceID=4, ConnectionID=5, SessionID=6, Sequence=7 }
 *   ResponseMeta{ SessionID=1, Sequence=2, StatusCode=3, Message=4, Billing=5 }
 *   Audio { data=1, format=4, codec=5, rate=7, bits=8, channel=9, binary_data=14 }
 *   ReqParams { mode=1, source_language=2, target_language=3, speaker_id=4, corpus=100 }
 */

import protobuf from 'protobufjs'
import { ClientEvent, ServerEvent } from './doubao-ast-protocol'

// keepCase:true → JS 字段名与 .proto 声明一致(不转 camelCase),避免 SessionID↔sessionId 这类歧义。
const PROTO = `
syntax = "proto3";
package openpipal.doubao;

message RequestMeta {
  string Endpoint = 1;
  string AppKey = 2;
  string AppID = 3;
  string ResourceID = 4;
  string ConnectionID = 5;
  string SessionID = 6;
  int32  Sequence = 7;
}

message User {
  string uid = 1;
  string did = 2;
  string platform = 3;
  string sdk_version = 4;
}

message Corpus {
  repeated string hot_words_list = 9;
  map<string, string> glossary_list = 10;
  string correct_words = 11;
  string boosting_table_id = 2;
  string glossary_table_id = 14;
}

message Audio {
  string data = 1;
  string format = 4;
  string codec = 5;
  int32  rate = 7;
  int32  bits = 8;
  int32  channel = 9;
  bytes  binary_data = 14;
}

message ReqParams {
  string mode = 1;
  string source_language = 2;
  string target_language = 3;
  string speaker_id = 4;
  Corpus corpus = 100;
}

message TranslateRequest {
  RequestMeta request_meta = 1;
  int32       event = 2;
  User        user = 3;
  Audio       source_audio = 4;
  Audio       target_audio = 5;
  ReqParams   request = 6;
}

message BillingItem { string Unit = 1; float Quantity = 2; }
message Billing { repeated BillingItem Items = 1; int64 DurationMsec = 2; }

message ResponseMeta {
  string  SessionID = 1;
  int32   Sequence = 2;
  int32   StatusCode = 3;
  string  Message = 4;
  Billing Billing = 5;
}

message TranslateResponse {
  ResponseMeta response_meta = 1;
  int32        event = 2;
  bytes        data = 3;
  string       text = 4;
  int32        start_time = 5;
  int32        end_time = 6;
  bool         spk_chg = 7;
  int32        muted_duration_ms = 8;
}
`

const root = protobuf.parse(PROTO, { keepCase: true }).root
const TranslateRequest = root.lookupType('openpipal.doubao.TranslateRequest')
const TranslateResponse = root.lookupType('openpipal.doubao.TranslateResponse')

/** AST 成功状态码(类 HTTP 200)。非此且非 0 即视为错误。 */
export const DOUBAO_STATUS_OK = 20000000

/** 自定义词典/术语(可选,首版可不传) */
export interface DoubaoCorpus {
  hot_words_list?: string[]
  glossary_list?: Record<string, string>
  correct_words?: string
}

export interface StartSessionOpts {
  sessionId: string
  connectionId: string
  sequence: number
  resourceId: string
  /** 旧版控制台才需要(新版 X-Api-Key 鉴权时可省) */
  appKey?: string
  mode: 's2s' | 's2t'
  sourceLanguage: string
  targetLanguage: string
  /** 源音频采样率(必须 16000) */
  sourceRate?: number
  /** s2s 必填:目标音频格式(默认 pcm)。pcm/16000 → 16bit 整型,与现有 pcm16 播放同构 */
  targetFormat?: 'pcm' | 'ogg_opus'
  targetRate?: number
  /** 指定公版音色(可选,不传则复刻说话人) */
  speakerId?: string
  corpus?: DoubaoCorpus
}

/** 建联包(event=100)。s2t 不带 target_audio。 */
export function encodeStartSession(o: StartSessionOpts): Uint8Array {
  const payload: Record<string, unknown> = {
    request_meta: {
      // Endpoint 复用 ResourceID(实测可被网关接受;鉴权主体在 HTTP header 的 X-Api-Key)
      Endpoint: o.resourceId,
      ResourceID: o.resourceId,
      ConnectionID: o.connectionId,
      SessionID: o.sessionId,
      Sequence: o.sequence,
      ...(o.appKey ? { AppKey: o.appKey } : {})
    },
    event: ClientEvent.StartSession,
    user: { uid: 'openpipal-interpreter', platform: 'desktop' },
    source_audio: { format: 'pcm', codec: 'raw', rate: o.sourceRate ?? 16000, bits: 16, channel: 1 },
    request: {
      mode: o.mode,
      source_language: o.sourceLanguage,
      target_language: o.targetLanguage,
      ...(o.speakerId ? { speaker_id: o.speakerId } : {}),
      ...(o.corpus ? { corpus: o.corpus } : {})
    }
  }
  if (o.mode === 's2s') {
    payload.target_audio = { format: o.targetFormat ?? 'pcm', rate: o.targetRate ?? 16000 }
  }
  return TranslateRequest.encode(TranslateRequest.fromObject(payload)).finish()
}

export interface TaskMeta {
  sessionId: string
  connectionId: string
  sequence: number
}

/** 音频包(event=200)。音频走 source_audio.binary_data(field 14, bytes),建议 16k/16bit/mono/80ms 一包。 */
export function encodeTaskRequest(audio: Uint8Array, m: TaskMeta): Uint8Array {
  return TranslateRequest.encode(
    TranslateRequest.fromObject({
      request_meta: { SessionID: m.sessionId, ConnectionID: m.connectionId, Sequence: m.sequence },
      event: ClientEvent.TaskRequest,
      source_audio: { binary_data: audio }
    })
  ).finish()
}

/** 结束包(event=102),音频发完后发。 */
export function encodeFinishSession(m: TaskMeta): Uint8Array {
  return TranslateRequest.encode(
    TranslateRequest.fromObject({
      request_meta: { SessionID: m.sessionId, ConnectionID: m.connectionId, Sequence: m.sequence },
      event: ClientEvent.FinishSession
    })
  ).finish()
}

export interface DoubaoResponse {
  event: number
  eventName: string
  text?: string
  /** TTS 音频字节(按 target_audio 格式;pcm/16k = Int16 PCM) */
  data?: Uint8Array
  statusCode?: number
  message?: string
  sessionId?: string
  sequence?: number
  startTime?: number
  endTime?: number
  spkChg?: boolean
  mutedDurationMs?: number
}

const SERVER_EVENT_NAME: Record<number, string> = Object.fromEntries(
  Object.entries(ServerEvent).map(([k, v]) => [v as number, k])
)

/** 解一条服务端帧。data 以 Uint8Array 返回(不转 base64,音频直接喂播放管线)。 */
export function decodeResponse(frame: Uint8Array): DoubaoResponse {
  const msg = TranslateResponse.toObject(TranslateResponse.decode(frame), {
    bytes: Uint8Array,
    longs: Number,
    enums: Number,
    defaults: false
  }) as any
  const meta = msg.response_meta || {}
  const event: number = msg.event ?? 0
  return {
    event,
    eventName: SERVER_EVENT_NAME[event] || `unknown(${event})`,
    text: msg.text || undefined,
    data: msg.data && msg.data.length ? msg.data : undefined,
    statusCode: meta.StatusCode,
    message: meta.Message || undefined,
    sessionId: meta.SessionID || undefined,
    sequence: meta.Sequence,
    startTime: msg.start_time,
    endTime: msg.end_time,
    spkChg: msg.spk_chg || undefined,
    mutedDurationMs: msg.muted_duration_ms
  }
}

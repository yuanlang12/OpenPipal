/**
 * DoubaoInterpretSession —— 豆包同声传译 2.0 会话管理器 (Main Process)
 *
 * 对内:讲豆包 AST v2 的裸 Protobuf-over-WS(见 doubao-ast-frame.ts)。
 * 对外:只调用 sendEvent/sendState,产出**与 OpenAI Realtime 完全同构**的 IPC 事件——
 *       渲染端(useRealtimeVoice)分不出后端是 GPT 还是豆包,P1–P3 全栈零改动。
 *
 * 事件归一化(豆包 → 渲染端早已在听的事件):
 *   SessionStarted(150)            → session.created + session.updated(置 sessionReady,放行音频)
 *   SourceSubtitleEnd(652)         → conversation.item.input_audio_transcription.completed(用户=原文)
 *   TranslationSubtitleResponse(654)→ 仅句内累积(不发 delta;豆包会非前缀修订,append 模型无法回退)
 *   TranslationSubtitleEnd(655)    → response.audio_transcript.done(一次性发权威全文,字幕句粒度)
 *   TTSResponse(352)               → response.audio.delta(译后音频,base64(pcm16@16k))
 *   TTSSentenceEnd(351)            → response.audio.done
 *   SessionFinished(152)           → response.done
 *   SessionFailed(153)/状态码错误   → error
 *
 * 音频:入 16k/16bit/mono raw PCM(渲染端 AudioEngine 已按 16k 采集),走 source_audio.binary_data;
 *       出请求 pcm/16000 → 16bit 整型,直接 base64 喂渲染端 playAudio(同 pcm16 播放)。
 * 保活:仅在静默 >250ms(超出渲染端 ~85ms 采集间隔)时补 2560B 静音帧,防服务端等包超时;
 *       阈值压到 60ms 会把静音插进活跃语音 → 污染豆包 ASR。
 */

import WebSocket from 'ws'
import { randomUUID } from 'node:crypto'
import { buildDoubaoAuthHeaders, ServerEvent } from './doubao-ast-protocol'
import {
  encodeStartSession,
  encodeTaskRequest,
  encodeFinishSession,
  decodeResponse,
  DOUBAO_STATUS_OK
} from './doubao-ast-frame'
import type { VoiceConfig } from './config-manager'

export interface DoubaoInterpretOptions {
  config: VoiceConfig
  sourceLanguage: string
  targetLanguage: string
  mode?: 's2s' | 's2t'
  sendEvent: (event: any) => void
  sendState: (state: string) => void
}

// 1280 个 Int16 静音样本 = 2560 字节 = 80ms@16kHz(豆包建议 80ms 一包)
const SILENCE_FRAME = new Uint8Array(2560)

export class DoubaoInterpretSession {
  private ws: WebSocket | null = null
  private readonly sessionId = randomUUID()
  private readonly connectionId = randomUUID()
  private sequence = 0
  private ready = false
  private closed = false

  // 字幕分段 id(归一化到渲染端的 item_id)
  private seg = 0
  private srcItemId: string | null = null
  private trItemId: string | null = null
  private trPrev = '' // 译文已发文本,用于算 delta 增量
  private ttsItemId: string | null = null

  private keepalive: ReturnType<typeof setInterval> | null = null
  private lastAudioSent = 0
  private connectTimer: ReturnType<typeof setTimeout> | null = null

  constructor(private readonly opts: DoubaoInterpretOptions) {}

  /** 建连 + 发 StartSession。resolve 在 ws open(StartSession 已发)后返回。 */
  connect(): Promise<{ success: boolean; error?: string }> {
    return new Promise((resolve) => {
      const { config } = this.opts
      let settled = false
      let ws: WebSocket
      try {
        ws = new WebSocket(config.baseUrl, {
          headers: buildDoubaoAuthHeaders({ apiKey: config.apiKey, resourceId: config.resourceId })
        })
      } catch (err: any) {
        resolve({ success: false, error: err?.message || 'failed to open ws' })
        return
      }
      this.ws = ws

      ws.on('open', () => {
        console.log('[DoubaoInterpret] WS open → StartSession', {
          src: this.opts.sourceLanguage,
          tgt: this.opts.targetLanguage,
          mode: this.opts.mode || 's2s'
        })
        this.opts.sendState('connected')
        try {
          ws.send(
            encodeStartSession({
              sessionId: this.sessionId,
              connectionId: this.connectionId,
              sequence: this.sequence++,
              resourceId: config.resourceId || 'volc.service_type.10053',
              mode: this.opts.mode || 's2s',
              sourceLanguage: this.opts.sourceLanguage,
              targetLanguage: this.opts.targetLanguage,
              sourceRate: 16000,
              targetFormat: 'pcm',
              targetRate: 16000
            })
          )
        } catch (err: any) {
          console.error('[DoubaoInterpret] StartSession send failed:', err?.message)
        }
        if (!settled) {
          settled = true
          resolve({ success: true })
        }
        // SessionStarted(150) 超时守卫:账号未开通同传2.0 时握手过但永不发 150,
        // 否则渲染端卡 'connected' + socket 泄漏(对齐 OpenAI 路径的 10s 超时)。
        this.connectTimer = setTimeout(() => {
          this.fail('SessionStarted 超时(账号可能未开通同传2.0)')
        }, 10000)
      })

      ws.on('message', (data) => this.onFrame(data))

      ws.on('error', (err: any) => {
        console.error('[DoubaoInterpret] WS error:', err?.message)
        if (!settled) {
          settled = true
          resolve({ success: false, error: err?.message || 'ws error' })
        } else {
          this.fail(err?.message || 'ws error')
        }
      })

      ws.on('close', (code: number, reason: Buffer) => {
        this.stopKeepalive()
        console.log('[DoubaoInterpret] WS closed:', code, reason?.toString?.().slice(0, 120))
        if (!this.closed) this.opts.sendState('idle')
      })
    })
  }

  private onFrame(data: WebSocket.RawData): void {
    if (this.closed) return
    // node ws 给 Buffer / Buffer[] / ArrayBuffer
    let bytes: Uint8Array
    if (Buffer.isBuffer(data)) bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
    else if (Array.isArray(data)) bytes = new Uint8Array(Buffer.concat(data))
    else bytes = new Uint8Array(data as ArrayBuffer)

    let r
    try {
      r = decodeResponse(bytes)
    } catch (e: any) {
      console.error('[DoubaoInterpret] decode failed:', e?.message)
      return
    }

    // 状态码错误(成功码 20000000;0/缺省视为无状态的子事件)
    if (r.statusCode != null && r.statusCode !== 0 && r.statusCode !== DOUBAO_STATUS_OK) {
      console.error('[DoubaoInterpret] server error', r.statusCode, r.message)
      this.fail(r.message || `status ${r.statusCode}`)
      return
    }

    switch (r.event) {
      case ServerEvent.SessionStarted:
        if (this.connectTimer) {
          clearTimeout(this.connectTimer)
          this.connectTimer = null
        }
        this.ready = true
        this.opts.sendEvent({ type: 'session.created' })
        this.opts.sendEvent({ type: 'session.updated' })
        this.startKeepalive()
        console.log('[DoubaoInterpret] SessionStarted → ready')
        break

      case ServerEvent.SourceSubtitleStart:
        this.srcItemId = `src-${++this.seg}`
        break

      case ServerEvent.SourceSubtitleEnd: {
        const id = this.srcItemId || `src-${++this.seg}`
        const text = (r.text || '').trim()
        if (text) {
          this.opts.sendEvent({
            type: 'conversation.item.input_audio_transcription.completed',
            item_id: id,
            transcript: text
          })
        }
        this.srcItemId = null
        break
      }

      case ServerEvent.TranslationSubtitleStart:
        this.trItemId = `tr-${++this.seg}`
        this.trPrev = ''
        break

      case ServerEvent.TranslationSubtitleResponse: {
        if (!this.trItemId) this.trItemId = `tr-${++this.seg}`
        // 豆包同句多次重发,可前缀增长、也可非前缀修订(Hello→Hi)。渲染端 delta 是 append
        // 语义无法回退,故句内只累积权威全文,到 655 一次性 done 覆盖(字幕句粒度;译后音频仍实时流)。
        const text = r.text || ''
        if (text) this.trPrev = text
        break
      }

      case ServerEvent.TranslationSubtitleEnd: {
        const id = this.trItemId || `tr-${++this.seg}`
        const transcript = r.text || this.trPrev
        if (transcript) {
          this.opts.sendEvent({ type: 'response.audio_transcript.done', item_id: id, transcript })
        }
        this.trItemId = null
        this.trPrev = ''
        break
      }

      case ServerEvent.TTSSentenceStart:
        this.ttsItemId = `tts-${++this.seg}`
        break

      case ServerEvent.TTSResponse:
        if (r.data && r.data.length) {
          this.opts.sendEvent({
            type: 'response.audio.delta',
            item_id: this.ttsItemId || undefined,
            delta: Buffer.from(r.data).toString('base64')
          })
        }
        break

      case ServerEvent.TTSSentenceEnd:
        this.opts.sendEvent({ type: 'response.audio.done', item_id: this.ttsItemId || undefined })
        this.ttsItemId = null
        break

      case ServerEvent.SessionFinished:
        // buffer-to-done 下若末句无 655,flush 累积全文,避免最后一句字幕丢失
        if (this.trItemId && this.trPrev) {
          this.opts.sendEvent({
            type: 'response.audio_transcript.done',
            item_id: this.trItemId,
            transcript: this.trPrev
          })
          this.trItemId = null
          this.trPrev = ''
        }
        this.opts.sendEvent({ type: 'response.done' })
        break

      case ServerEvent.SessionFailed:
        this.fail(r.message || 'session failed')
        break

      // UsageResponse(154) / AudioMuted(250) / SourceSubtitleResponse(651 流式原文) / 其余:忽略
      default:
        break
    }
  }

  /** 接渲染端的 OpenAI 风格客户端事件。豆包只需要音频追加;其余(commit/history)忽略。 */
  handleClientEvent(event: any): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return
    if (event?.type === 'input_audio_buffer.append' && event.audio) {
      if (!this.ready) return
      this.appendAudio(event.audio)
    }
  }

  private appendAudio(base64: string): void {
    const bytes = new Uint8Array(Buffer.from(base64, 'base64'))
    this.lastAudioSent = Date.now()
    try {
      this.ws!.send(
        encodeTaskRequest(bytes, {
          sessionId: this.sessionId,
          connectionId: this.connectionId,
          sequence: this.sequence++
        })
      )
    } catch (err: any) {
      console.error('[DoubaoInterpret] appendAudio failed:', err?.message)
    }
  }

  private startKeepalive(): void {
    this.stopKeepalive()
    this.keepalive = setInterval(() => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return
      if (Date.now() - this.lastAudioSent > 250) {
        this.lastAudioSent = Date.now()
        try {
          this.ws.send(
            encodeTaskRequest(SILENCE_FRAME, {
              sessionId: this.sessionId,
              connectionId: this.connectionId,
              sequence: this.sequence++
            })
          )
        } catch {
          /* ignore */
        }
      }
    }, 80)
  }

  private stopKeepalive(): void {
    if (this.keepalive) {
      clearInterval(this.keepalive)
      this.keepalive = null
    }
  }

  /**
   * 错误终止:发 error 事件 + 置 'error' 态 + 拆 socket。
   * 渲染端只在 error/idle STATE 才 cleanup,故缺 sendState('error') 会让它挂死 + socket 泄漏。
   */
  private fail(message: string): void {
    if (this.closed) return
    console.error('[DoubaoInterpret] fail:', message)
    this.opts.sendEvent({ type: 'error', error: { message } })
    this.opts.sendState('error')
    this.teardown()
  }

  /** 静默拆连接(不发 FinishSession);close() 与 fail() 共用。 */
  private teardown(): void {
    this.closed = true
    this.stopKeepalive()
    if (this.connectTimer) {
      clearTimeout(this.connectTimer)
      this.connectTimer = null
    }
    try {
      this.ws?.close()
    } catch {
      /* ignore */
    }
    this.ws = null
  }

  close(): void {
    if (this.closed) {
      this.teardown()
      return
    }
    try {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(
          encodeFinishSession({
            sessionId: this.sessionId,
            connectionId: this.connectionId,
            sequence: this.sequence++
          })
        )
      }
    } catch {
      /* ignore */
    }
    this.teardown()
  }
}

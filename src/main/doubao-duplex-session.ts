/**
 * DoubaoDuplexSession —— 豆包全双工实时语音 3.0 会话管理器 (Main Process)
 *
 * 对内: 讲豆包全双工的纯 JSON 文本协议(见 doubao-duplex-protocol.ts)。
 * 对外: 只调 sendEvent/sendState, 产出**与 OpenAI Realtime 完全同构**的 IPC 事件——
 *       渲染端(useRealtimeVoice / audio-engine)分不出后端是 GPT 还是豆包, 零改动。
 *
 * 事件归一化(豆包全双工 → 渲染端早已在听的 OpenAI 事件):
 *   session.created                                  → session.created + session.updated(放行音频)
 *   conversation.item.input_audio_transcription.*    → 同名直传(用户转录)
 *   response.output_text.delta / .done               → response.audio_transcript.delta / .done(助手字幕)
 *   response.output_audio.delta / .done              → response.audio.delta / .done(助手音频, base64 pcm16@24k)
 *   response.function_call_arguments.done(items[])   → 执行工具 + 回传 conversation.item.create(role:tool)
 *   response.done / error                            → 同名直传
 *
 * 与 OpenAI 路径的差异(全双工更简单):
 *   - 服务端原生 VAD/回合管理, 不发 turn_detection, FC 回传后**不发 response.create**(服务端自动续)。
 *   - FC 是 items[] 数组(支持并行多调用), 回传形状 {call_id, role:'tool', content:[{type:'input_text',text}]}。
 *
 * 音频: 入 pcm16/16k(渲染端 input_audio_buffer.append 直接转发); 出 pcm16/24k(base64, 同 OpenAI 播放)。
 */

import WebSocket from 'ws'
import {
  DOUBAO_DUPLEX_ENDPOINT,
  DuplexClientEvent,
  DuplexServerEvent,
  buildDoubaoDuplexHeaders,
  buildSessionCreate,
  coerceDuplexVoice,
  type DuplexToolSchema
} from './doubao-duplex-protocol'
import type { VoiceToolContext } from './realtime-tool-bridge'
import type { VoiceConfig } from './config-manager'
import { mainError, tMain, type MainFailure } from './main-i18n'

/** 服务端给了真实文本就原样透传，什么都没给才落到本进程自造的文案。 */
function duplexServerFailure(ev: { error?: { message?: string; code?: string } }): MainFailure {
  const detail = ev.error?.message || ev.error?.code
  return detail ? { error: String(detail) } : mainError('settings.voice.errors.serverError')
}

export interface DoubaoDuplexOptions {
  config: VoiceConfig
  /** 系统提示词(已含角色 + 语音礼仪) */
  instructions: string
  /** 工具集(来自 buildVoiceToolSchemas, 扁平 OpenAI 格式) */
  tools: DuplexToolSchema[]
  /** 工具执行上下文(conversationId/workspaceId 等) */
  voiceCtx: VoiceToolContext
  sendEvent: (event: any) => void
  sendState: (state: string) => void
  /** 把工具产出渲染到聊天面板(复用 realtime-session.emitToolArtifactToChat) */
  emitToolArtifact: (name: string, raw: any) => void
}

export class DoubaoDuplexSession {
  private ws: WebSocket | null = null
  private ready = false
  private closed = false
  private connectTimer: ReturnType<typeof setTimeout> | null = null

  constructor(private readonly opts: DoubaoDuplexOptions) {}

  /** 建连 + 发 session.create。resolve 在 ws open(session.create 已发)后返回。 */
  connect(): Promise<{ success: boolean; error?: string }> {
    return new Promise((resolve) => {
      const { config } = this.opts
      const endpoint = config.baseUrl || DOUBAO_DUPLEX_ENDPOINT
      let settled = false
      let ws: WebSocket
      try {
        // 豆包用 deployment 字段承载 App ID(X-Api-App-Id) —— 全双工握手需 App-Id + Key 两者
        ws = new WebSocket(endpoint, { headers: buildDoubaoDuplexHeaders(config.apiKey, config.deployment) })
      } catch (err: any) {
        resolve({ success: false, error: err?.message || 'failed to open ws' })
        return
      }
      this.ws = ws

      // 握手非 101(如 401/403): 读响应体拿服务端真实原因(否则只看到笼统 'Unexpected server response: 401')
      ws.on('unexpected-response', (_req, res) => {
        let body = ''
        res.on('data', (c: Buffer) => (body += c.toString()))
        res.on('end', () => {
          const msg = `握手失败 ${res.statusCode}: ${body.slice(0, 300) || '(无响应体)'}`
          if (!settled) {
            settled = true
            resolve({ success: false, error: msg })
          } else {
            this.fail(msg)
          }
        })
      })

      ws.on('open', () => {
        const voice = coerceDuplexVoice(config.voice)
        console.log('[DoubaoDuplex] WS open → session.create', { voice, tools: this.opts.tools.length })
        this.opts.sendState('connected')
        try {
          ws.send(
            JSON.stringify(
              buildSessionCreate({
                instructions: this.opts.instructions,
                tools: this.opts.tools,
                voice
              })
            )
          )
        } catch (err: any) {
          console.error('[DoubaoDuplex] session.create send failed:', err?.message)
        }
        if (!settled) {
          settled = true
          resolve({ success: true })
        }
        // session.created 超时守卫(账号未开通 / key 无效时握手过但永不回 created)
        this.connectTimer = setTimeout(() => {
          this.fail('session.created 超时(账号可能未开通全双工 / API Key 无效)')
        }, 10000)
      })

      ws.on('message', (data) => this.onMessage(data))

      ws.on('error', (err: any) => {
        console.error('[DoubaoDuplex] WS error:', err?.message)
        if (!settled) {
          settled = true
          resolve({ success: false, error: err?.message || 'ws error' })
        } else {
          this.fail(err?.message || 'ws error')
        }
      })

      ws.on('close', (code: number, reason: Buffer) => {
        console.log('[DoubaoDuplex] WS closed:', code, reason?.toString?.().slice(0, 120))
        if (!this.closed) this.opts.sendState('idle')
      })
    })
  }

  private onMessage(data: WebSocket.RawData): void {
    if (this.closed) return
    let event: any
    try {
      event = JSON.parse(typeof data === 'string' ? data : data.toString())
    } catch {
      return
    }
    const type: string = event?.type
    if (!type) return

    switch (type) {
      case DuplexServerEvent.SessionCreated:
        if (this.connectTimer) {
          clearTimeout(this.connectTimer)
          this.connectTimer = null
        }
        this.ready = true
        // 双发: session.created 给渲染端建会话, session.updated 翻 sessionReady → 放行麦克风音频
        this.opts.sendEvent({ type: 'session.created' })
        this.opts.sendEvent({ type: 'session.updated' })
        console.log('[DoubaoDuplex] session.created → ready')
        break

      // 用户转录: 全双工与 OpenAI 同名同形(item_id / transcript / delta), 直传
      case DuplexServerEvent.AsrStarted:
      case DuplexServerEvent.AsrDelta:
      case DuplexServerEvent.AsrCompleted:
        this.opts.sendEvent(event)
        break

      // 助手字幕: output_text.* → audio_transcript.*(轮次 id 用 response_id)
      case DuplexServerEvent.TextDelta:
        this.opts.sendEvent({
          type: 'response.audio_transcript.delta',
          item_id: event.response_id || undefined,
          delta: event.delta || ''
        })
        break
      case DuplexServerEvent.TextDone:
        this.opts.sendEvent({
          type: 'response.audio_transcript.done',
          item_id: event.response_id || undefined,
          transcript: event.text || ''
        })
        break

      // 助手音频: output_audio.* → audio.*(base64 pcm16@24k 直接喂播放)
      case DuplexServerEvent.AudioDelta:
        if (event.delta) {
          this.opts.sendEvent({
            type: 'response.audio.delta',
            item_id: event.response_id || undefined,
            delta: event.delta
          })
        }
        break
      case DuplexServerEvent.AudioDone:
        this.opts.sendEvent({ type: 'response.audio.done', item_id: event.response_id || undefined })
        break

      case DuplexServerEvent.FunctionCallDone:
        this.handleFunctionCall(event).catch((err) =>
          console.error('[DoubaoDuplex] function_call handling failed:', err?.message)
        )
        break

      case DuplexServerEvent.ResponseDone:
        this.opts.sendEvent({ type: 'response.done' })
        break

      case DuplexServerEvent.AsrFailed:
      case DuplexServerEvent.Error:
        this.opts.sendEvent({ type: 'error', error: event.error || { message: 'doubao duplex error' } })
        break

      // session.updated / input_audio_buffer.committed / response.output_audio.started /
      // conversation.item.added / response.canceled / response.done usage 等: 不需要渲染端动作, 忽略
      default:
        break
    }
  }

  /** 接渲染端的 OpenAI 风格客户端事件。append 直接转发(同名同形); cancel 转发; 其余忽略。 */
  handleClientEvent(event: any): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return
    const type = event?.type
    if (type === DuplexClientEvent.AudioAppend) {
      if (!this.ready || !event.audio) return
      this.send({ type: DuplexClientEvent.AudioAppend, audio: event.audio })
    } else if (type === DuplexClientEvent.ResponseCancel) {
      this.send({ type: DuplexClientEvent.ResponseCancel })
    }
  }

  /**
   * 处理一次工具调用下发(items[] 可并行)。每个 call 分别走风险分类 + 执行 + artifact 渲染,
   * 聚合后在一条 conversation.item.create 里全部回传(call_id 一一对应)。全双工服务端自动续, 不发 response.create。
   */
  private async handleFunctionCall(event: any): Promise<void> {
    const items: any[] = Array.isArray(event?.items) ? event.items : []
    if (!items.length) return
    const results = await Promise.all(items.map((it) => this.execOneCall(it)))
    const resultItems = results.filter(Boolean)
    if (!resultItems.length) return
    this.send({ type: DuplexClientEvent.ItemCreate, items: resultItems })
  }

  private async execOneCall(it: any): Promise<any | null> {
    const callId: string | undefined = it?.call_id
    const name: string | undefined = it?.name
    if (!callId || !name) return null
    const argsJson: string =
      typeof it.arguments === 'string' ? it.arguments : JSON.stringify(it.arguments || {})

    console.log(`[DoubaoDuplex] tool call: ${name} (call_id=${callId})`)

    // 惰性 import:realtime-tool-bridge → pi-tools 全链不进 boot 解析路径。
    // 统一 sink 在内部完成 parse + authorization + execute，避免 provider
    // 分支漏掉 risky 拒绝或二次解析后丢失浏览器 host 绑定。
    const { executeVoiceTool } = await import('./realtime-tool-bridge')
    const res = await executeVoiceTool(name, argsJson, this.opts.voiceCtx).catch((err: any) => ({
      output: JSON.stringify({ error: err?.message || 'execution failed' }),
      raw: null
    }))
    this.opts.emitToolArtifact(name, res.raw)
    return this.toolResultItem(callId, res.output)
  }

  private toolResultItem(callId: string, text: string): any {
    return { call_id: callId, role: 'tool', content: [{ type: 'input_text', text }] }
  }

  private send(payload: any): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return
    try {
      this.ws.send(JSON.stringify(payload))
    } catch (err: any) {
      console.error('[DoubaoDuplex] send failed:', err?.message)
    }
  }

  /** 错误终止: 发 error + 'error' 态 + 拆 socket(渲染端只在 error/idle 才 cleanup)。 */
  private fail(message: string): void {
    if (this.closed) return
    console.error('[DoubaoDuplex] fail:', message)
    this.opts.sendEvent({ type: 'error', error: { message } })
    this.opts.sendState('error')
    this.teardown()
  }

  private teardown(): void {
    this.closed = true
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

  /** 优雅关闭: 先发 session.close 再拆(直接断会触发服务端 ContextCanceled)。 */
  close(): void {
    if (this.closed) {
      this.teardown()
      return
    }
    try {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.send({ type: DuplexClientEvent.SessionClose })
      }
    } catch {
      /* ignore */
    }
    this.teardown()
  }
}

/**
 * 全双工连接测试(独立 WS, 不碰 activeDuplex): 连上 → 发最小 session.create → 收到 session.created 即 ok。
 * 供 VoiceSettings 的「测试连接」对豆包 provider 使用(OpenAI provider 接口不适用豆包)。
 */
export function testDoubaoDuplexConnection(
  config: VoiceConfig
): Promise<{ ok: true } | ({ ok: false } & MainFailure)> {
  return new Promise((resolve) => {
    if (!config.apiKey) {
      resolve({ ok: false, ...mainError('settings.voice.errors.missingApiKey') })
      return
    }
    const endpoint = config.baseUrl || DOUBAO_DUPLEX_ENDPOINT
    let resolved = false
    let ws: WebSocket | null = null
    const finish = (r: { ok: true } | ({ ok: false } & MainFailure)): void => {
      if (resolved) return
      resolved = true
      try {
        ws?.close()
      } catch {
        /* ignore */
      }
      resolve(r)
    }
    try {
      // 豆包用 deployment 字段承载 App ID(X-Api-App-Id) —— 全双工握手需 App-Id + Key 两者
      const headers = buildDoubaoDuplexHeaders(config.apiKey, config.deployment)
      console.log(
        `[DoubaoDuplex][test] → ${endpoint} | headers sent: ${Object.keys(headers).join(', ')} | ` +
          `X-Api-Key len=${config.apiKey?.length || 0}, X-Api-App-Id="${config.deployment || '(空)'}"`
      )
      ws = new WebSocket(endpoint, { headers })
      // 握手非 101(如 401/403): 读响应体拿服务端真实原因
      ws.on('unexpected-response', (_req, res) => {
        let body = ''
        res.on('data', (c: Buffer) => (body += c.toString()))
        res.on('end', () => {
          console.error(
            `[DoubaoDuplex][test] 握手失败 status=${res.statusCode} ` +
              `resp-headers=${JSON.stringify(res.headers)} body=${body.slice(0, 500) || '(无响应体)'}`
          )
          finish({
            ok: false,
            ...mainError('settings.voice.errors.handshakeFailed', {
              status: String(res.statusCode),
              detail: body.slice(0, 300) || tMain('settings.voice.errors.emptyBody')
            })
          })
        })
      })
      ws.on('open', () => {
        try {
          ws!.send(
            JSON.stringify(
              buildSessionCreate({ instructions: '连接测试', tools: [], voice: coerceDuplexVoice(config.voice) })
            )
          )
        } catch {
          /* ignore */
        }
      })
      ws.on('message', (data) => {
        let ev: any
        try {
          ev = JSON.parse(typeof data === 'string' ? data : data.toString())
        } catch {
          return
        }
        if (ev?.type === DuplexServerEvent.SessionCreated) finish({ ok: true })
        else if (ev?.type === DuplexServerEvent.Error)
          finish({ ok: false, ...duplexServerFailure(ev) })
      })
      ws.on('error', (err: any) =>
        finish({
          ok: false,
          ...(err?.message ? { error: String(err.message) } : mainError('settings.voice.errors.connectionFailed'))
        })
      )
      ws.on('close', (code: number) => {
        if (!resolved) finish({ ok: false, ...mainError('settings.voice.errors.connectionClosed', { code: String(code) }) })
      })
      setTimeout(() => finish({ ok: false, ...mainError('settings.voice.errors.connectTimeout') }), 8000)
    } catch (err: any) {
      finish({ ok: false, error: err?.message })
    }
  })
}

/**
 * useRealtimeVoice — 实时语音对话状态管理
 *
 * 核心职责：
 * 1. 管理语音会话生命周期（连接/断开）
 * 2. 协调音频引擎（麦克风采集 + 扬声器播放）
 * 3. 防文字错乱的转录管理（按 item_id 追踪）
 * 4. 通话时长计时
 */

import { useState, useRef, useCallback, useEffect } from 'react'
import type { VoiceTranscriptItem, VoiceSessionState } from '../types'
import { AudioEngine } from '../services/audio-engine'
import { useChatStore } from '../stores/chatStore'
import { useAppStore } from '../stores/appStore'
import { rendererI18n } from '../i18n'
import { buildInterpretTranscriptArchive } from '../chat/voiceArchiveDisplay'

declare global {
  interface Window {
    api: {
      getRealtimeConfig: () => Promise<{ url: string; model: string; hasKey: boolean }>
      startRealtime: (ctx?: { conversationId?: string; agentId?: string; workspaceId?: string; conversationConfig?: any }) => Promise<{ success: boolean; error?: string }>
      stopRealtime: () => void
      sendRealtimeEvent: (event: any) => void
      onRealtimeEvent: (callback: (event: any) => void) => () => void
      onRealtimeState: (callback: (state: string) => void) => () => void
      [key: string]: any
    }
  }
}

/**
 * 同传模式判定 —— 当前角色 = interpreter。渲染端用它放宽 ASR 幻觉过滤(多语种逐字稿不该被中文规则误删)
 * 并跳过会话记忆抽取(同传是翻译不是对话,不应进记忆)。主进程侧另有同款 getCurrentRole() 判定。
 */
function isInterpretMode(): boolean {
  return useAppStore.getState().currentRole?.name === 'interpreter'
}

/**
 * P5 最小:同传挂断时把本会话逐字稿(源/译)归档到 ~/.openpipal/outputs/{date}_同传.md。
 * 仅 interpreter 角色 + 逐字稿 ≥2 条才落盘(护栏:测试两句不归档)。笔记总结/转交留待后续。
 */
function archiveInterpretTranscript(): void {
  if (!isInterpretMode()) return
  const msgs = useChatStore.getState().messages.filter((m: any) => m.voiceItemId && (m.content || '').trim())
  if (msgs.length < 2) return
  const archive = buildInterpretTranscriptArchive(msgs, rendererI18n.t)
  window.api.archiveTranscript?.(archive.title, archive.content).catch(() => {})
}

/**
 * 判断用户输入转录是否是 ASR 幻觉(静音/噪声被 Whisper 家族转成训练集里的水印/字幕词)。
 * 典型:"...YOUTUBE.COM""MING PAO""请订阅""谢谢观看"。中文语音场景里这些基本不是用户真说的。
 * 保守命中(宁可漏判也别误删真内容):URL/英文水印 或 独立的字幕套话。
 */
function isLikelyAsrHallucination(text: string): boolean {
  const s = (text || '').trim()
  if (!s) return true
  if (!/[a-z0-9一-鿿]/i.test(s)) return true // 没有字母/数字/中文 = 纯标点符号噪声
  const hasCJK = /[一-鿿]/.test(s)
  // URL/英文水印:仅当整句无中文才判幻觉 —— 否则会误删"搜一下 openai.com 的新闻"这类真句
  if (!hasCJK && /youtube\.com|\.(com|net|org|cn)\b|ming\s*pao|by\s+\w+\s+(news|media)/i.test(s)) return true
  if (/^(请[关注订阅]+|点赞|转发|打赏|谢谢(大家)?(观看|收看)|字幕[由志制]|关注我们|未经允许)[\s。，、!！?？.…]*$/.test(s)) return true // 字幕套话
  return false
}

// ── 回听:PCM16 base64 累积工具(base64 不能直接拼,必须解成字节再拼,最后统一编码) ──
function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64)
  const u = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i)
  return u
}
function bytesToB64(bytes: Uint8Array): string {
  let bin = ''
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i])
  return btoa(bin)
}
function concatBytes(chunks: Uint8Array[]): Uint8Array {
  let total = 0
  for (const c of chunks) total += c.length
  const out = new Uint8Array(total)
  let off = 0
  for (const c of chunks) { out.set(c, off); off += c.length }
  return out
}
/**
 * 语音会话结束触发记忆提取 —— 对齐文字模式(文字每轮 stream-end 提取,语音批在会话结束做)。
 * 取本会话 user/assistant 文本转录(去占位"…"/工具卡),交给同一套 evolver 管线。
 * 放在 cleanupSession(所有结束路径的公共出口),per-conversation cursor 门控保证重复调用安全。
 */
function triggerVoiceMemoryExtraction(): void {
  if (isInterpretMode()) return // 同传是翻译不是对话,不抽记忆
  try {
    const cs = useChatStore.getState()
    const convId = cs.activeConversationId
    if (!convId) return
    const history = cs.messages
      .filter((m) =>
        (m.role === 'user' || m.role === 'assistant') &&
        typeof m.content === 'string' && m.content.trim().length > 0 && m.content !== '…' &&
        m.messageKind !== 'tool' && m.messageKind !== 'thinking'
      )
      .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content }))
    if (history.length >= 2) window.api.extractConversationMemory?.(history, convId)
  } catch (err) {
    console.warn('[RealtimeVoice] 记忆提取触发失败:', err)
  }
}

/** 把某段累积的 PCM16 存成 WAV(main 落盘),成功后把路径挂到对应语音消息(回听) */
function saveSegmentAudio(itemId: string, role: 'user' | 'assistant', chunks: Uint8Array[]): void {
  if (!chunks.length) return
  const bytes = concatBytes(chunks)
  if (bytes.length === 0) return
  const convId = useChatStore.getState().activeConversationId
  if (!convId) return
  window.api.saveVoiceAudio?.(convId, itemId, role, bytesToB64(bytes)).then((r: any) => {
    if (r?.path) useChatStore.getState().setVoiceMessageAudio(itemId, r.path)
  })
}

export function useRealtimeVoice() {
  const [sessionState, setSessionState] = useState<VoiceSessionState>('idle')
  const [isUserSpeaking, setIsUserSpeaking] = useState(false)
  const [isAISpeaking, setIsAISpeaking] = useState(false)
  const [duration, setDuration] = useState(0)
  const [voiceAvailable, setVoiceAvailable] = useState(false)
  const [inputLevel, setInputLevel] = useState(0)
  const [outputLevel, setOutputLevel] = useState(0)

  // 内部状态（不触发重渲染）
  const audioEngineRef = useRef<AudioEngine | null>(null)
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const levelTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const cleanupEventRef = useRef<(() => void) | null>(null)
  const cleanupStateRef = useRef<(() => void) | null>(null)
  const sessionReadyRef = useRef(false) // session.updated 后才允许发音频

  // 本次会话内出现过的 itemId（用于挂断时把整段对话标记为终态 / 派生 transcripts）
  const sessionItemIdsRef = useRef<Set<string>>(new Set())
  // 当前正在播放的 AI 音频 item_id —— barge-in 时用于 conversation.item.truncate
  const currentAudioItemIdRef = useRef<string | null>(null)
  // 待注入的历史上下文 —— session.updated(就绪)后一次性灌进 realtime session
  const pendingHistoryRef = useRef<Array<{ role: 'user' | 'assistant'; text: string }>>([])
  // 被 barge-in 打断的 AI item_id —— 这些 item 的文字定格在打断处，忽略后续 delta/done（避免显示完整文本）
  const truncatedItemsRef = useRef<Set<string>>(new Set())
  // ── 转录按音频时钟揭示(嘴和字同步) ──
  // 文字不再按 delta 到达速度刷出(delta 1~2s 内全到、音频要播 ~10s → 文字会跑到音频前面),
  // 而是按 playedMs/receivedMs 比例揭示累积全文,音频播到哪文字露到哪。
  const transcriptBufRef = useRef<Map<string, string>>(new Map())  // 每个 item 累积/权威全文
  const revealedLenRef = useRef<Map<string, number>>(new Map())     // 每个 item 已揭示字数(单调不回退)
  const transcriptDoneRef = useRef<Set<string>>(new Set())          // 收到 audio_transcript.done 的 item
  const audioDoneRef = useRef<Set<string>>(new Set())               // 收到 response.audio.done 的 item
  const pacingItemIdRef = useRef<string | null>(null)               // 当前按音频节拍揭示的 item
  // 回听:输出音频按 item_id 攒;输入音频在 speech_started→committed 窗口攒,关联到 user item
  const outputAudioRef = useRef<Map<string, Uint8Array[]>>(new Map())
  const inputAudioRef = useRef<Uint8Array[]>([])
  const inputCapturingRef = useRef(false)
  const pacingTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)

  /** 清空所有转录揭示状态（用于会话结束 / 重新连接） */
  const flushAllTranscriptTimers = useCallback((): void => {
    transcriptBufRef.current.clear()
    revealedLenRef.current.clear()
    transcriptDoneRef.current.clear()
    audioDoneRef.current.clear()
    pacingItemIdRef.current = null
  }, [])

  /**
   * 音频节拍:把当前正在播放 item 的转录全文,按已播比例揭示。
   * 每 ~80ms 跑一次。揭示长度 = floor(全文长 × min(1, playedMs/receivedMs)),单调不回退;
   * 音频播完且转录已 done 时补齐全文并标记终态。无音频信息(纯文本回复)则在 done 时直接全显。
   */
  const paceTranscript = useCallback((): void => {
    const id = pacingItemIdRef.current
    if (!id || truncatedItemsRef.current.has(id)) return
    const full = transcriptBufRef.current.get(id) ?? ''
    if (!full) return
    const upsert = useChatStore.getState().upsertVoiceMessage
    const prog = audioEngineRef.current?.getAudioProgress() ?? { playedMs: 0, receivedMs: 0 }
    const { playedMs, receivedMs } = prog
    const noAudio = receivedMs <= 0
    const transcriptFinished = transcriptDoneRef.current.has(id)
    const fullyPlayed = !noAudio && playedMs >= receivedMs - 1
    const finalize = transcriptFinished && (noAudio || (audioDoneRef.current.has(id) && fullyPlayed))

    let target: number
    if (noAudio) {
      // 音频还没来 → 先不揭示(等音频);若已 done 仍无音频 = 纯文本回复 → 全显
      target = transcriptFinished ? full.length : 0
    } else {
      target = Math.round(full.length * Math.min(1, playedMs / receivedMs))
    }
    if (finalize) target = full.length

    const prev = revealedLenRef.current.get(id) ?? 0
    const next = Math.max(prev, Math.min(full.length, target))  // 单调
    const willFinalize = finalize && next >= full.length
    if (next !== prev || willFinalize) {
      revealedLenRef.current.set(id, next)
      upsert(id, 'assistant', full.slice(0, next), willFinalize)
      if (willFinalize && pacingItemIdRef.current === id) pacingItemIdRef.current = null
    }
  }, [])

  /**
   * 转录路由 — 直接写入 chatStore.messages
   *
   * 关键设计：
   * - chatStore 是 transcripts 唯一来源（不再有 hook 内 Map）
   * - 按 item_id upsert，*.delta 增量更新内容，*.done 标记终态并持久化
   * - VoiceCallOverlay / VoiceCallStrip 都从 chatStore 读，不重复存储
   */

  /** 处理 Realtime API 事件 */
  const handleRealtimeEvent = useCallback(
    (event: any) => {
      const type = event.type as string
      const upsert = useChatStore.getState().upsertVoiceMessage

      // 一个 item 的 transcript.done 和 audio.done 都到了 → 立刻定格全文(不依赖节拍 tick)。
      // 修"调工具前那条口语消息文字回显不全":它说完(audio.done)+转录完(transcript.done)后,
      // 紧接着工具/下一条回复的音频会 beginAudioTurn 抢走节拍 → 这条若没及时收尾就卡在半截。
      const finalizeItem = (itemId: string): void => {
        if (truncatedItemsRef.current.has(itemId)) return
        const full = transcriptBufRef.current.get(itemId) || ''
        revealedLenRef.current.set(itemId, full.length)
        if (pacingItemIdRef.current === itemId) pacingItemIdRef.current = null
        upsert(itemId, 'assistant', full, true)
      }

      switch (type) {
        // ─── 用户消息项创建（早于 AI 回复）—— 提前占位，保证消息顺序 ───
        // 用户语音转写(Whisper)是异步的、晚到的；若等转写完成才建气泡，会排到 AI 回复之后。
        // conversation.item.created 在 response.created 之前到达，此时建占位 → 顺序正确。
        case 'conversation.item.created': {
          const item = event.item
          // 只对「真实语音输入」(content 含 input_audio) 建占位。
          // 注入的历史/文本消息(input_text)也会触发本事件，必须跳过，否则历史会被重复渲染。
          const isAudioItem = Array.isArray(item?.content) &&
            item.content.some((c: any) => c.type === 'input_audio')
          if (item?.type === 'message' && item.role === 'user' && item.id && isAudioItem) {
            if (!sessionItemIdsRef.current.has(item.id)) {
              sessionItemIdsRef.current.add(item.id)
              const pre = item.content.find((c: any) => c.transcript)?.transcript || '…'
              upsert(item.id, 'user', pre, false)
            }
            // 回听:把刚才说话窗口攒的 PCM16 关联到这个 user item 并落盘
            if (inputAudioRef.current.length) {
              saveSegmentAudio(item.id, 'user', inputAudioRef.current)
              inputAudioRef.current = []
            }
            inputCapturingRef.current = false
          }
          break
        }

        // ─── 用户语音转文字（最终结果）—— 填充上面的占位 ───
        case 'conversation.item.input_audio_transcription.completed': {
          const itemId = event.item_id
          if (!itemId) break
          sessionItemIdsRef.current.add(itemId)
          // ASR 幻觉(静音/噪声转成水印/字幕词)→ 删掉占位气泡,不显示这条"用户没说过"的内容
          // 同传模式放宽:多语种逐字稿(英文/含 URL/外语短句)会被这套中文规则误删,故跳过过滤
          if (!isInterpretMode() && isLikelyAsrHallucination(event.transcript || '')) {
            console.warn('[voice-parity] 丢弃疑似 ASR 幻觉转录:', (event.transcript || '').slice(0, 60))
            useChatStore.getState().removeVoiceMessage(itemId)
            break
          }
          upsert(itemId, 'user', event.transcript || '', true)
          break
        }

        // ─── AI 响应转录（流式增量） ───
        // 只累积全文,不直接显示 —— 由 paceTranscript 按音频已播比例揭示(嘴和字同步)。
        // 不再按 delta 到达速度刷出:delta 1~2s 全到、音频播 ~10s,直接显示会让文字跑到音频前面。
        case 'response.audio_transcript.delta': {
          const itemId = event.item_id
          if (!itemId) break
          // 已被 barge-in 打断的 item：文字定格在打断处，忽略后续 delta
          if (truncatedItemsRef.current.has(itemId)) break
          sessionItemIdsRef.current.add(itemId)
          const prev = transcriptBufRef.current.get(itemId) || ''
          transcriptBufRef.current.set(itemId, prev + (event.delta || ''))
          break
        }

        // ─── AI 响应转录（最终确认） ───
        // 用权威全文覆盖累积,标记 transcript 已完结。揭示进度仍由音频时钟驱动:
        // 该 item 正在播音频 → 交给 paceTranscript 播到哪露到哪;不在播(纯文本/音频未到)→ 直接全显终态。
        case 'response.audio_transcript.done': {
          const itemId = event.item_id
          if (!itemId) break
          // 被打断的 item：保留定格内容（已在 barge-in 时标记终态），不要用完整 transcript 覆盖
          if (truncatedItemsRef.current.has(itemId)) break
          sessionItemIdsRef.current.add(itemId)
          transcriptBufRef.current.set(itemId, event.transcript || transcriptBufRef.current.get(itemId) || '')
          transcriptDoneRef.current.add(itemId)
          // 这条根本没音频跟随(纯文本/音频未到)→ 立即全显,避免永远停在揭示中途。
          // (有音频的:揭示交给节拍按已播比例推进;真正播完由"切到下一条音频项"时 finalizeItem 收尾)
          if (pacingItemIdRef.current !== itemId && currentAudioItemIdRef.current !== itemId) {
            finalizeItem(itemId)
          }
          break
        }

        // ─── 语音活动检测 + Barge-in（用户开口立即打断 AI）───
        case 'input_audio_buffer.speech_started': {
          setIsUserSpeaking(true)
          // 回听:开始攒这一段用户输入音频(committed/item.created 时关联到 user item 并落盘)
          inputCapturingRef.current = true
          inputAudioRef.current = []

          // WebSocket 模式下服务端会取消响应，但本地缓冲的音频必须客户端自己停。
          // 这是"AI 说话被打断"的关键：立即停播 + 告诉服务端用户实际听到了多少。
          const playedMs = audioEngineRef.current?.flushPlayback() ?? 0
          setIsAISpeaking(false)

          // 关键:回退到 pacingItemIdRef。currentAudioItemIdRef 在 response.audio.done 时已置 null,
          // 但客户端可能还在播缓冲的尾巴(队列没排空)。这种"晚到的打断"若只看 currentAudioItemIdRef
          // 会拿到 null → 跳过文字定格 → flushPlayback 把音频砍了、节拍却把全文露出来(文字超前音频)。
          const interruptedItemId = currentAudioItemIdRef.current ?? pacingItemIdRef.current
          if (interruptedItemId) {
            // 1) 文字定格：登记到 truncatedItems → paceTranscript 不再揭示这一项(防止它揭示到全文)。
            //    当前已显示内容 = 用户已听到的部分(揭示跟着音频),其后补省略号即「听到哪停哪」。
            truncatedItemsRef.current.add(interruptedItemId)
            if (pacingItemIdRef.current === interruptedItemId) pacingItemIdRef.current = null
            // 回听:被打断的 AI 这段已播音频也存下来(否则 audio.done 不来,这段就丢了)
            const cutChunks = outputAudioRef.current.get(interruptedItemId)
            if (cutChunks?.length) {
              saveSegmentAudio(interruptedItemId, 'assistant', cutChunks)
              outputAudioRef.current.delete(interruptedItemId)
            }
            const cur = useChatStore.getState().messages.find((m) => m.voiceItemId === interruptedItemId)
            if (cur && cur.content && cur.content !== '…') {
              upsert(interruptedItemId, 'assistant', cur.content.trimEnd() + ' …', true)
            }
            // 2) 截断服务端上下文：只对"仍在流式中的那条"(currentAudioItemId 非 null)发 truncate;
            //    已 done 的尾巴条目不发(服务端会拒绝截断已完成的 response)。
            if (currentAudioItemIdRef.current) {
              window.api.sendRealtimeEvent({
                type: 'conversation.item.truncate',
                item_id: currentAudioItemIdRef.current,
                content_index: 0,
                audio_end_ms: playedMs
              })
              currentAudioItemIdRef.current = null
            }
          }
          break
        }

        case 'input_audio_buffer.speech_stopped':
          setIsUserSpeaking(false)
          // 回听:停止攒输入(buffer 留着,等 conversation.item.created 关联到 user item)
          inputCapturingRef.current = false
          // 用户说完 → 启动"思考中"轻提示音，AI 第一个 token 出来时关掉
          audioEngineRef.current?.startIndicator()
          break

        // ─── 丝滑:工具执行期间填补静默 ───
        // AI 决定调工具(function_call 参数已完整),接下来 main 要执行工具(可能几十秒,如 web_search)。
        // 这段时间没有 AI 音频 → 会死寂。重新起"思考中"提示音,直到工具结果回来 AI 开口(audio.delta)时关掉。
        case 'response.function_call_arguments.done':
          audioEngineRef.current?.startIndicator()
          break

        // ─── AI 音频播放 ───
        case 'response.audio.delta': {
          if (event.delta && audioEngineRef.current) {
            const itemId = event.item_id
            // 新的一段 AI 音频(item_id 变化)→ 重置音频计时,开始按音频节拍揭示这一项的转录
            if (itemId && itemId !== currentAudioItemIdRef.current) {
              // 切新音频项前,先把上一条收尾:音频是单队列顺序播,新项开始=上一条音频早已播完,
              // 此刻定格它的全文是对的(否则它会被节拍抢走、卡在半截 = "预告消息文字回显不全")
              const prev = pacingItemIdRef.current
              if (prev && prev !== itemId && transcriptDoneRef.current.has(prev)) finalizeItem(prev)
              audioEngineRef.current.beginAudioTurn()
              currentAudioItemIdRef.current = itemId
              pacingItemIdRef.current = itemId
            }
            audioEngineRef.current.stopIndicator()  // AI 开始说话，关掉提示音
            audioEngineRef.current.playAudio(event.delta)
            setIsAISpeaking(true)
            // 回听:按 item_id 攒 AI 输出音频(audio.done 时落盘)
            if (itemId) {
              const arr = outputAudioRef.current.get(itemId) || []
              arr.push(b64ToBytes(event.delta))
              outputAudioRef.current.set(itemId, arr)
            }
          }
          break
        }

        case 'response.audio.done': {
          setIsAISpeaking(false)
          // 服务端音频发完,但客户端队列可能还在排空(缓冲了好几秒)。
          // 标记 audioDone 让 paceTranscript 在播完后补齐全文/收尾;但保持 pacingItemIdRef 直到真播完。
          const doneId = currentAudioItemIdRef.current
          if (doneId) audioDoneRef.current.add(doneId)
          // 回听:这段 AI 输出音频落盘(event.item_id 优先,回落到 currentAudioItemId)
          const audioItemId = event.item_id || doneId
          if (audioItemId) {
            const chunks = outputAudioRef.current.get(audioItemId)
            if (chunks?.length) {
              saveSegmentAudio(audioItemId, 'assistant', chunks)
              outputAudioRef.current.delete(audioItemId)
            }
          }
          // 清掉当前 item —— 下次 barge-in 不会误截断已正常说完的回复(节拍揭示走 pacingItemIdRef,不受影响)
          currentAudioItemIdRef.current = null
          break
        }

        // ─── 会话事件 ───
        case 'session.created':
          console.log(`[RealtimeVoice] ${type}`)
          break

        // session.updated = 服务端已确认配置，现在可以安全发送音频
        case 'session.updated': {
          console.log('[RealtimeVoice] Session ready, starting audio capture')
          sessionReadyRef.current = true

          // 注入历史上下文（只做一次）—— 把之前的聊天记录作为会话项灌入，让语音模型有上下文
          const history = pendingHistoryRef.current
          if (history.length > 0) {
            console.log(`[RealtimeVoice] Injecting ${history.length} history messages as context`)
            for (const h of history) {
              window.api.sendRealtimeEvent({
                type: 'conversation.item.create',
                item: {
                  type: 'message',
                  role: h.role,
                  // user 用 input_text，assistant 用 text（OpenAI Realtime 规范）
                  content: [{ type: h.role === 'user' ? 'input_text' : 'text', text: h.text }]
                }
              })
            }
            pendingHistoryRef.current = []
          }
          break
        }

        case 'error':
          console.error('[RealtimeVoice] Server error:', event.error)
          break
      }
    },
    []
  )

  /** 检查语音功能是否可用 */
  useEffect(() => {
    window.api.getRealtimeConfig().then((config) => {
      setVoiceAvailable(config.hasKey)
    })
  }, [])

  /** 启动语音会话 */
  const startSession = useCallback(async () => {
    if (sessionState !== 'idle') return

    setSessionState('connecting')

    // 确保有 active conversation —— transcripts 将作为 chat 消息流入
    const currentRoleName = useAppStore.getState().currentRole?.name || 'learner'
    await useChatStore.getState().ensureVoiceConversation(currentRoleName)

    // 捕获已有聊天历史 —— session 就绪后注入，让语音模型带上下文（取最近 12 条纯文本 user/assistant 消息）
    const allMsgs = useChatStore.getState().messages
    pendingHistoryRef.current = allMsgs
      .filter((m) =>
        (m.role === 'user' || m.role === 'assistant') &&
        typeof m.content === 'string' && m.content.trim().length > 0 &&
        m.messageKind !== 'tool' && m.messageKind !== 'thinking' &&
        m.messageKind !== 'task-trigger' && m.messageKind !== 'inject-notice'
      )
      .slice(-30)  // 注入更多历史(文字模式带全量上下文;语音之前只给 12 条,长对话会丢早期上下文)
      .map((m) => ({ role: m.role as 'user' | 'assistant', text: m.content }))

    // 重置本会话 itemId 集合 + 打断登记 + 转录揭示状态 + 回听音频缓冲
    sessionItemIdsRef.current.clear()
    truncatedItemsRef.current.clear()
    currentAudioItemIdRef.current = null
    outputAudioRef.current.clear()
    inputAudioRef.current = []
    inputCapturingRef.current = false
    flushAllTranscriptTimers()
    setDuration(0)

    // 注册事件监听
    cleanupEventRef.current = window.api.onRealtimeEvent(handleRealtimeEvent)
    cleanupStateRef.current = window.api.onRealtimeState((state: string) => {
      setSessionState(state as VoiceSessionState)
      if (state === 'error' || state === 'idle') {
        cleanupSession()
      }
    })

    // 启动 WebSocket 连接 —— 带上完整 Agent 上下文，让语音复用文字模式同一套配置
    // (role 系统提示词 / skills / memory / MCP / Agent 文件夹)。语音 = 同一个 agent 换输入通道。
    const cs = useChatStore.getState()
    const result = await window.api.startRealtime({
      conversationId: cs.activeConversationId || undefined,
      agentId: cs.activeAgentId || undefined,
      workspaceId: cs.activeWorkspaceId || undefined,
      conversationConfig: cs.conversationConfig || undefined
    })
    if (!result.success) {
      console.error('[RealtimeVoice] Failed to start:', result.error)
      setSessionState('error')
      cleanupSession()
      return
    }

    // 启动音频引擎（先创建，但只在 session.updated 后才发送数据）
    try {
      // 采样率随后端定:OpenAI=24000,豆包同传=16000,豆包全双工=入16k/出24k(主进程在 startRealtime 结果里回传)
      const engine = new AudioEngine({
        sampleRate: (result as any).sampleRate || 24000,
        outputSampleRate: (result as any).outputSampleRate || (result as any).sampleRate || 24000
      })
      engine.onAudioData = (pcm16Base64: string) => {
        // 回听:用户说话窗口内同时攒一份输入音频(speech_started→speech_stopped 之间)
        if (inputCapturingRef.current) inputAudioRef.current.push(b64ToBytes(pcm16Base64))
        // 关键：只有 session 配置完成后才发送音频，避免 302.ai 报 bad_response
        if (sessionReadyRef.current) {
          window.api.sendRealtimeEvent({
            type: 'input_audio_buffer.append',
            audio: pcm16Base64
          })
        }
      }
      await engine.startCapture()
      audioEngineRef.current = engine
    } catch (err) {
      console.error('[RealtimeVoice] Microphone access failed:', err)
      window.api.stopRealtime()
      setSessionState('error')
      cleanupSession()
      return
    }

    // 启动计时器
    timerRef.current = setInterval(() => {
      setDuration((d) => d + 1)
    }, 1000)

    // 启动音量级别轮询
    levelTimerRef.current = setInterval(() => {
      if (audioEngineRef.current) {
        setInputLevel(audioEngineRef.current.inputLevel)
        setOutputLevel(audioEngineRef.current.outputLevel)
      }
    }, 100)

    // 启动转录音频节拍 —— 把文字揭示节流到音频已播进度(嘴和字同步)
    pacingTimerRef.current = setInterval(paceTranscript, 80)
  }, [sessionState, handleRealtimeEvent, paceTranscript])

  /** 停止语音会话。
   *  历史返回值是 finalTranscripts —— P3a 起 transcripts 已实时进 chatStore，
   *  这里返回空数组只是为了向后兼容现有调用方（App.tsx 的 handleHangup），
   *  P3b 整理 UI 时一并清理签名。
   */
  const stopSession = useCallback((): VoiceTranscriptItem[] => {
    window.api.stopRealtime()
    archiveInterpretTranscript()  // 同传:挂断归档逐字稿(非 interpreter / 太短自动跳过)
    cleanupSession()
    setSessionState('idle')
    return []
  }, [])

  /** 清理资源 */
  const cleanupSession = useCallback(() => {
    // 会话结束(挂断/出错/idle)→ 先触发记忆提取(对齐文字模式),再拆音频/计时器
    triggerVoiceMemoryExtraction()
    // 停掉音频节拍 + 清空转录揭示状态
    if (pacingTimerRef.current) {
      clearInterval(pacingTimerRef.current)
      pacingTimerRef.current = null
    }
    flushAllTranscriptTimers()
    // 释放本次会话缓冲的 PCM 音频/itemId 登记(镜像 startSession 顶部的 reset 块)—— 挂断即释放
    // 数 MB 的回听 PCM,而不是等下次通话 startSession 才清空。
    sessionItemIdsRef.current.clear()
    truncatedItemsRef.current.clear()
    currentAudioItemIdRef.current = null
    outputAudioRef.current.clear()
    inputAudioRef.current = []
    if (audioEngineRef.current) {
      audioEngineRef.current.destroy()
      audioEngineRef.current = null
    }
    if (timerRef.current) {
      clearInterval(timerRef.current)
      timerRef.current = null
    }
    if (levelTimerRef.current) {
      clearInterval(levelTimerRef.current)
      levelTimerRef.current = null
    }
    if (cleanupEventRef.current) {
      cleanupEventRef.current()
      cleanupEventRef.current = null
    }
    if (cleanupStateRef.current) {
      cleanupStateRef.current()
      cleanupStateRef.current = null
    }
    setIsUserSpeaking(false)
    setIsAISpeaking(false)
    setInputLevel(0)
    setOutputLevel(0)
    sessionReadyRef.current = false
  }, [])

  // 组件卸载时清理
  useEffect(() => {
    return () => {
      if (sessionState !== 'idle') {
        window.api.stopRealtime()
        cleanupSession()
      }
    }
  }, [])

  return {
    sessionState,
    isUserSpeaking,
    isAISpeaking,
    duration,
    inputLevel,
    outputLevel,
    voiceAvailable,
    startSession,
    stopSession
  }
}

import type { TranscriptPersistenceRenderer } from './desktop-transcript-persistence'
import {
  awaitTranscriptPersistence,
  type TranscriptPersistenceBarrierResult,
} from './desktop-transcript-persistence'
import {
  acquireConversationExecution,
  type ConversationExecutionLease,
} from './conversation-execution-coordinator'
import {
  beginConversationOperation,
  finishConversationOperation,
  getConversation,
} from './conversation-service'
import {
  setRealtimeLifecycleListener,
  startRealtimeSession,
  stopRealtimeSession,
  type RealtimeLifecycleState,
  type VoiceSessionContext,
} from './realtime-session'

type VoiceStartResult = Awaited<ReturnType<typeof startRealtimeSession>>

interface ActiveVoiceExecution {
  conversationId: string
  renderer: TranscriptPersistenceRenderer
  lease: ConversationExecutionLease
  durableRunId: string | null
  onLeaseAbort?: () => void
  closing?: Promise<VoiceCloseResult>
}

interface VoiceCloseResult {
  ok: boolean
  persistence?: TranscriptPersistenceBarrierResult
}

interface CloseVoiceOptions {
  outcome: 'completed' | 'aborted' | 'failed'
  code: string
  message: string
  flushTranscript: boolean
  timeoutMs?: number
}

let initialized = false
let activeVoiceExecution: ActiveVoiceExecution | null = null
let pendingStart: AbortController | null = null

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function closeVoiceExecution(
  execution: ActiveVoiceExecution,
  options: CloseVoiceOptions
): Promise<VoiceCloseResult> {
  if (execution.closing) return execution.closing
  execution.closing = (async () => {
    if (activeVoiceExecution === execution) activeVoiceExecution = null

    // Stop microphone/provider/tool traffic before waiting for the renderer's
    // final transcript write. The lifecycle callback is idempotent because the
    // active owner has already been detached above.
    stopRealtimeSession()

    let persistence: TranscriptPersistenceBarrierResult | undefined
    if (options.flushTranscript) {
      persistence = await awaitTranscriptPersistence({
        renderer: execution.renderer,
        conversationId: execution.conversationId,
        executionId: execution.lease.executionId,
        ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
      })
    }

    const persistenceFailed = Boolean(persistence && persistence.status !== 'acknowledged')
    const outcome = persistenceFailed ? 'failed' : options.outcome
    const finished = await finishConversationOperation(
      execution.conversationId,
      execution.durableRunId,
      outcome,
      outcome === 'failed'
        ? {
            code: persistenceFailed ? 'voice_transcript_not_persisted' : options.code,
            message: persistence?.error || options.message,
          }
        : undefined
    )
    if (!finished && execution.durableRunId) {
      console.error(`[Voice] 无法关闭会话运行记录 ${execution.durableRunId}`)
    }
    return { ok: finished && !persistenceFailed, ...(persistence ? { persistence } : {}) }
  })().catch((error) => {
    console.error('[Voice] 结束会话失败:', error)
    return { ok: false }
  }).finally(() => {
    if (execution.onLeaseAbort) {
      execution.lease.signal.removeEventListener('abort', execution.onLeaseAbort)
    }
    execution.lease.release()
  })
  return execution.closing
}

async function handleTransportTerminal(state: RealtimeLifecycleState): Promise<void> {
  const execution = activeVoiceExecution
  if (!execution) return
  await closeVoiceExecution(execution, {
    outcome: 'failed',
    code: state === 'error' ? 'voice_transport_error' : 'voice_transport_closed',
    message: state === 'error'
      ? 'Voice transport reported an error before the session completed'
      : 'Voice transport closed before the user ended the session',
    flushTranscript: true,
  })
}

/** Install the transport-loss hook once when desktop IPC is registered. */
export function initializeDurableVoiceSession(): void {
  if (initialized) return
  initialized = true
  setRealtimeLifecycleListener((state) => {
    void handleTransportTerminal(state)
  })
}

/**
 * Start one voice session under the same per-conversation ownership and
 * durable-operation rules as desktop, ACP and scheduler turns.
 */
export async function startDurableVoiceSession(
  context: VoiceSessionContext | undefined,
  renderer: TranscriptPersistenceRenderer
): Promise<VoiceStartResult> {
  initializeDurableVoiceSession()
  const conversationId = context?.conversationId
  if (!conversationId) {
    return { success: false, error: '无法开始语音：当前会话尚未准备好，请重试。' }
  }
  if (!await getConversation(conversationId)) {
    return { success: false, error: '无法开始语音：当前会话不存在，请重新打开后重试。' }
  }

  pendingStart?.abort()
  const startAbort = new AbortController()
  pendingStart = startAbort
  const previous = activeVoiceExecution
  if (previous) {
    await closeVoiceExecution(previous, {
      outcome: 'aborted',
      code: 'voice_replaced',
      message: 'A newer voice session replaced this session',
      flushTranscript: true,
    })
  } else {
    // Also cancel a transport that predates durable ownership (for example an
    // older renderer after hot reload) before a new operation is recorded.
    stopRealtimeSession()
  }

  let lease: ConversationExecutionLease
  try {
    lease = await acquireConversationExecution({
      conversationId,
      owner: { entrypoint: 'voice', ownerId: 'realtime' },
      policy: 'supersede',
      signal: startAbort.signal,
    })
  } catch (error) {
    if (pendingStart === startAbort) pendingStart = null
    return { success: false, error: errorText(error) }
  }

  if (startAbort.signal.aborted) {
    lease.release()
    if (pendingStart === startAbort) pendingStart = null
    return { success: false, error: '语音连接已取消。' }
  }

  let durableRunId: string | null
  try {
    durableRunId = await beginConversationOperation(conversationId, 'voice')
  } catch (error) {
    lease.release()
    if (pendingStart === startAbort) pendingStart = null
    return { success: false, error: `无法安全开始语音：${errorText(error)}` }
  }

  const execution: ActiveVoiceExecution = {
    conversationId,
    renderer,
    lease,
    durableRunId,
  }
  activeVoiceExecution = execution
  if (pendingStart === startAbort) pendingStart = null

  // A newer foreground desktop turn uses coordinator supersede semantics.
  // Voice must react to that abort and release after its transcript barrier;
  // otherwise the new turn would wait forever behind a still-open microphone.
  execution.onLeaseAbort = () => {
    void closeVoiceExecution(execution, {
      outcome: 'aborted',
      code: 'voice_superseded',
      message: 'A newer conversation turn superseded the voice session',
      flushTranscript: true,
    })
  }
  lease.signal.addEventListener('abort', execution.onLeaseAbort, { once: true })
  if (lease.signal.aborted) {
    execution.onLeaseAbort()
    await execution.closing
    return { success: false, error: '语音会话已被新的对话请求接替。' }
  }

  let result: VoiceStartResult
  try {
    result = await startRealtimeSession(context)
  } catch (error) {
    result = { success: false, error: errorText(error) }
  }
  if (!result.success) {
    await closeVoiceExecution(execution, {
      outcome: 'failed',
      code: 'voice_start_failed',
      message: result.error || 'Voice session failed to start',
      flushTranscript: false,
    })
    return result
  }
  if (activeVoiceExecution !== execution || execution.closing) {
    await execution.closing
    return { success: false, error: '语音连接在完成前已结束。' }
  }
  return result
}

/** User hangup. Transcript acknowledgement happens before the lease is released. */
export async function stopDurableVoiceSession(): Promise<VoiceCloseResult> {
  pendingStart?.abort()
  pendingStart = null
  const execution = activeVoiceExecution
  if (!execution) {
    stopRealtimeSession()
    return { ok: true }
  }
  return closeVoiceExecution(execution, {
    outcome: 'completed',
    code: 'voice_stopped',
    message: 'Voice session stopped',
    flushTranscript: true,
  })
}

/** App-quit path: bounded transcript flush, no automatic replay next launch. */
export async function shutdownDurableVoiceSession(): Promise<void> {
  pendingStart?.abort()
  pendingStart = null
  const execution = activeVoiceExecution
  if (!execution) {
    stopRealtimeSession()
    return
  }
  await closeVoiceExecution(execution, {
    outcome: 'aborted',
    code: 'app_quit',
    message: 'Application quit while voice session was active',
    flushTranscript: true,
    timeoutMs: 3_000,
  })
}

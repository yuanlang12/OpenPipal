/**
 * Desktop transcript persistence barrier.
 *
 * The Agent runtime owns a process-wide conversation lease while it streams.
 * The renderer owns the desktop transcript projection, so the lease may only
 * be released after that renderer has attempted to persist the completed turn.
 * Requests and acknowledgements are keyed by the coordinator execution id;
 * late/duplicate acknowledgements can therefore never release a newer run.
 */

export interface TranscriptPersistenceRenderer {
  isDestroyed?: () => boolean
  send: (channel: string, ...args: unknown[]) => void
  once?: (event: 'destroyed', listener: () => void) => unknown
  removeListener?: (event: 'destroyed', listener: () => void) => unknown
}

export interface TranscriptPersistenceAck {
  conversationId: string
  executionId: string
  ok: boolean
  error?: string
}

export type TranscriptPersistenceBarrierStatus =
  | 'acknowledged'
  | 'failed'
  | 'timeout'
  | 'renderer-unavailable'
  | 'renderer-unsupported'
  | 'send-failed'

export interface TranscriptPersistenceBarrierResult {
  status: TranscriptPersistenceBarrierStatus
  error?: string
}

interface PendingBarrier {
  conversationId: string
  renderer: TranscriptPersistenceRenderer
  finish: (result: TranscriptPersistenceBarrierResult) => void
}

const readyRenderers = new WeakSet<object>()
const pendingByExecution = new Map<string, PendingBarrier>()

export const DEFAULT_TRANSCRIPT_PERSISTENCE_TIMEOUT_MS = 8_000

export function markTranscriptPersistenceRendererReady(renderer: TranscriptPersistenceRenderer): void {
  readyRenderers.add(renderer as object)
}

export function markTranscriptPersistenceRendererUnavailable(renderer: TranscriptPersistenceRenderer): void {
  readyRenderers.delete(renderer as object)
  for (const [executionId, pending] of Array.from(pendingByExecution.entries())) {
    if (pending.renderer !== renderer) continue
    pendingByExecution.delete(executionId)
    pending.finish({
      status: 'renderer-unavailable',
      error: 'renderer became unavailable before transcript persistence acknowledgement'
    })
  }
}

/**
 * Accept an acknowledgement only from the renderer and execution that own the
 * pending request. Returns false for malformed, stale, duplicate, or spoofed
 * acknowledgements.
 */
export function acknowledgeTranscriptPersistence(
  renderer: TranscriptPersistenceRenderer,
  ack: TranscriptPersistenceAck
): boolean {
  if (!ack || typeof ack.executionId !== 'string' || typeof ack.conversationId !== 'string') return false
  const pending = pendingByExecution.get(ack.executionId)
  if (!pending || pending.renderer !== renderer || pending.conversationId !== ack.conversationId) return false
  pendingByExecution.delete(ack.executionId)
  pending.finish(ack.ok
    ? { status: 'acknowledged' }
    : { status: 'failed', error: typeof ack.error === 'string' ? ack.error.slice(0, 1_000) : 'renderer persistence failed' })
  return true
}

export interface AwaitTranscriptPersistenceOptions {
  renderer: TranscriptPersistenceRenderer
  conversationId: string
  executionId: string
  timeoutMs?: number
}

export function awaitTranscriptPersistence(
  options: AwaitTranscriptPersistenceOptions
): Promise<TranscriptPersistenceBarrierResult> {
  const { renderer, conversationId, executionId } = options
  if (!conversationId) return Promise.resolve({ status: 'acknowledged' })
  if (renderer.isDestroyed?.()) {
    return Promise.resolve({ status: 'renderer-unavailable', error: 'renderer is destroyed' })
  }
  // Old renderers and lightweight test mocks never advertise the protocol.
  // They retain their previous immediate-release behavior instead of stalling
  // every turn until the timeout. The current preload advertises readiness as
  // soon as chatStore installs its persistence listener.
  if (!readyRenderers.has(renderer as object)) {
    return Promise.resolve({ status: 'renderer-unsupported', error: 'renderer did not advertise transcript persistence acknowledgements' })
  }
  if (!executionId || pendingByExecution.has(executionId)) {
    return Promise.resolve({ status: 'send-failed', error: 'invalid or duplicate transcript persistence execution id' })
  }

  const timeoutMs = Math.max(100, Math.min(options.timeoutMs ?? DEFAULT_TRANSCRIPT_PERSISTENCE_TIMEOUT_MS, 60_000))
  return new Promise<TranscriptPersistenceBarrierResult>((resolve) => {
    let settled = false
    const timerState: { timer?: ReturnType<typeof setTimeout> } = {}
    const onDestroyed = (): void => finish({
      status: 'renderer-unavailable',
      error: 'renderer was destroyed before transcript persistence acknowledgement'
    })
    const finish = (result: TranscriptPersistenceBarrierResult): void => {
      if (settled) return
      settled = true
      if (timerState.timer) clearTimeout(timerState.timer)
      renderer.removeListener?.('destroyed', onDestroyed)
      if (pendingByExecution.get(executionId)?.finish === finish) pendingByExecution.delete(executionId)
      resolve(result)
    }

    pendingByExecution.set(executionId, { conversationId, renderer, finish })
    renderer.once?.('destroyed', onDestroyed)
    timerState.timer = setTimeout(() => finish({
      status: 'timeout',
      error: `renderer did not acknowledge transcript persistence within ${timeoutMs}ms`
    }), timeoutMs)

    try {
      renderer.send('chat:transcript-persistence-request', { conversationId, executionId })
    } catch (error) {
      finish({ status: 'send-failed', error: error instanceof Error ? error.message : String(error) })
    }
  })
}

/** Test-only reset for the module-level protocol registry. */
export function resetTranscriptPersistenceBarrierForTests(): void {
  for (const [executionId, pending] of Array.from(pendingByExecution.entries())) {
    pendingByExecution.delete(executionId)
    pending.finish({ status: 'renderer-unavailable', error: 'test reset' })
  }
}

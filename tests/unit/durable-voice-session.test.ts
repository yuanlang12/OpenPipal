import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  conversationExists: true,
  startResult: { success: true, sampleRate: 24_000 } as any,
  persistenceResult: { status: 'acknowledged' } as any,
  lifecycleListener: null as null | ((value: 'idle' | 'error') => void),
  leases: [] as any[],
}))

vi.mock('../../src/main/conversation-service', () => ({
  getConversation: vi.fn(async (id: string) => state.conversationExists ? { id } : null),
  beginConversationOperation: vi.fn(async () => 'voice-run-1'),
  finishConversationOperation: vi.fn(async () => true),
}))

vi.mock('../../src/main/conversation-execution-coordinator', () => ({
  acquireConversationExecution: vi.fn(async (options: any) => {
    const controller = new AbortController()
    if (options.signal) {
      options.signal.addEventListener('abort', () => controller.abort(options.signal.reason), { once: true })
      if (options.signal.aborted) controller.abort(options.signal.reason)
    }
    const lease = {
      conversationId: options.conversationId,
      executionId: `execution-${state.leases.length + 1}`,
      owner: options.owner,
      signal: controller.signal,
      controller,
      isCurrent: () => true,
      abort: vi.fn(),
      release: vi.fn(),
    }
    state.leases.push(lease)
    return lease
  }),
}))

vi.mock('../../src/main/desktop-transcript-persistence', () => ({
  awaitTranscriptPersistence: vi.fn(async () => state.persistenceResult),
}))

vi.mock('../../src/main/realtime-session', () => ({
  setRealtimeLifecycleListener: vi.fn((listener: (value: 'idle' | 'error') => void) => {
    state.lifecycleListener = listener
  }),
  startRealtimeSession: vi.fn(async () => state.startResult),
  stopRealtimeSession: vi.fn(),
}))

const conversationService = await import('../../src/main/conversation-service')
const coordinator = await import('../../src/main/conversation-execution-coordinator')
const persistence = await import('../../src/main/desktop-transcript-persistence')
const realtime = await import('../../src/main/realtime-session')
const voice = await import('../../src/main/durable-voice-session')

const renderer = {
  send: vi.fn(),
  isDestroyed: () => false,
}

describe('durable voice session ownership', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    state.conversationExists = true
    state.startResult = { success: true, sampleRate: 24_000 }
    state.persistenceResult = { status: 'acknowledged' }
    state.leases.length = 0
  })

  afterEach(async () => {
    await voice.stopDurableVoiceSession()
  })

  it('holds one conversation lease from provider start through transcript acknowledgement', async () => {
    await expect(voice.startDurableVoiceSession({ conversationId: 'voice-1' }, renderer))
      .resolves.toMatchObject({ success: true, sampleRate: 24_000 })

    expect(coordinator.acquireConversationExecution).toHaveBeenCalledWith(expect.objectContaining({
      conversationId: 'voice-1',
      owner: { entrypoint: 'voice', ownerId: 'realtime' },
      policy: 'supersede',
    }))
    expect(conversationService.beginConversationOperation)
      .toHaveBeenCalledWith('voice-1', 'voice')
    expect(state.leases[0].release).not.toHaveBeenCalled()

    await expect(voice.stopDurableVoiceSession()).resolves.toMatchObject({ ok: true })
    expect(persistence.awaitTranscriptPersistence).toHaveBeenCalledWith(expect.objectContaining({
      conversationId: 'voice-1',
      executionId: 'execution-1',
    }))
    expect(conversationService.finishConversationOperation)
      .toHaveBeenCalledWith('voice-1', 'voice-run-1', 'completed', undefined)
    expect(state.leases[0].release).toHaveBeenCalledOnce()
  })

  it('closes an unexpected transport error as failed without replaying tools', async () => {
    await voice.startDurableVoiceSession({ conversationId: 'voice-error' }, renderer)
    state.lifecycleListener?.('error')

    await vi.waitFor(() => {
      expect(conversationService.finishConversationOperation).toHaveBeenCalledWith(
        'voice-error',
        'voice-run-1',
        'failed',
        expect.objectContaining({ code: 'voice_transport_error' })
      )
    })
    expect(state.leases[0].release).toHaveBeenCalledOnce()
  })

  it('marks a missing transcript acknowledgement as failed but always releases ownership', async () => {
    state.persistenceResult = { status: 'failed', error: 'disk unavailable' }
    await voice.startDurableVoiceSession({ conversationId: 'voice-save-fail' }, renderer)
    await expect(voice.stopDurableVoiceSession()).resolves.toMatchObject({ ok: false })

    expect(conversationService.finishConversationOperation).toHaveBeenCalledWith(
      'voice-save-fail',
      'voice-run-1',
      'failed',
      {
        code: 'voice_transcript_not_persisted',
        message: 'disk unavailable',
      }
    )
    expect(state.leases[0].release).toHaveBeenCalledOnce()
  })

  it('releases voice when a newer conversation execution supersedes its lease', async () => {
    await voice.startDurableVoiceSession({ conversationId: 'voice-superseded' }, renderer)
    state.leases[0].controller.abort(new Error('superseded'))

    await vi.waitFor(() => expect(state.leases[0].release).toHaveBeenCalledOnce())
    expect(conversationService.finishConversationOperation).toHaveBeenCalledWith(
      'voice-superseded',
      'voice-run-1',
      'aborted',
      undefined
    )
    expect(persistence.awaitTranscriptPersistence).toHaveBeenCalled()
  })

  it('fails closed before the provider when the UI has no persisted conversation', async () => {
    await expect(voice.startDurableVoiceSession(undefined, renderer))
      .resolves.toMatchObject({ success: false })
    expect(realtime.startRealtimeSession).not.toHaveBeenCalled()
    expect(coordinator.acquireConversationExecution).not.toHaveBeenCalled()
  })
})

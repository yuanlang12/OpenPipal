import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  acknowledgeTranscriptPersistence,
  awaitTranscriptPersistence,
  markTranscriptPersistenceRendererReady,
  markTranscriptPersistenceRendererUnavailable,
  resetTranscriptPersistenceBarrierForTests,
  type TranscriptPersistenceRenderer
} from '../../src/main/desktop-transcript-persistence'
import { acquireConversationExecution } from '../../src/main/conversation-execution-coordinator'

class FakeRenderer extends EventEmitter implements TranscriptPersistenceRenderer {
  destroyed = false
  sent: Array<{ channel: string; args: unknown[] }> = []

  isDestroyed(): boolean { return this.destroyed }
  send(channel: string, ...args: unknown[]): void { this.sent.push({ channel, args }) }
  destroy(): void {
    this.destroyed = true
    this.emit('destroyed')
  }
}

afterEach(() => {
  vi.useRealTimers()
  resetTranscriptPersistenceBarrierForTests()
})

describe('desktop transcript persistence barrier', () => {
  it('holds the coordinator lease until the matching execution acknowledgement', async () => {
    const cid = `desktop-ack-${Date.now()}`
    const renderer = new FakeRenderer()
    markTranscriptPersistenceRendererReady(renderer)
    const desktop = await acquireConversationExecution({
      conversationId: cid,
      owner: { entrypoint: 'desktop', ownerId: 'renderer' },
      policy: 'supersede'
    })

    const barrier = awaitTranscriptPersistence({
      renderer,
      conversationId: cid,
      executionId: desktop.executionId,
      timeoutMs: 2_000
    })
    const releaseAfterBarrier = barrier.then((result) => {
      desktop.release()
      return result
    })
    let waiterGranted = false
    const waiter = acquireConversationExecution({
      conversationId: cid,
      owner: { entrypoint: 'scheduler', ownerId: 'task' },
      policy: 'wait'
    }).then((lease) => {
      waiterGranted = true
      return lease
    })

    await Promise.resolve()
    expect(waiterGranted).toBe(false)
    expect(acknowledgeTranscriptPersistence(renderer, {
      conversationId: cid,
      executionId: 'a-late-or-wrong-execution',
      ok: true
    })).toBe(false)
    await Promise.resolve()
    expect(waiterGranted).toBe(false)

    expect(acknowledgeTranscriptPersistence(renderer, {
      conversationId: cid,
      executionId: desktop.executionId,
      ok: true
    })).toBe(true)
    await expect(releaseAfterBarrier).resolves.toEqual({ status: 'acknowledged' })
    const next = await waiter
    expect(waiterGranted).toBe(true)
    next.release()
  })

  it('releases only after the bounded timeout when a ready renderer never acknowledges', async () => {
    vi.useFakeTimers()
    const cid = 'desktop-timeout'
    const renderer = new FakeRenderer()
    markTranscriptPersistenceRendererReady(renderer)
    const desktop = await acquireConversationExecution({
      conversationId: cid,
      owner: { entrypoint: 'desktop', ownerId: 'renderer' },
      policy: 'supersede'
    })
    const barrier = awaitTranscriptPersistence({
      renderer,
      conversationId: cid,
      executionId: desktop.executionId,
      timeoutMs: 200
    }).then((result) => {
      desktop.release()
      return result
    })
    let waiterGranted = false
    const waiter = acquireConversationExecution({
      conversationId: cid,
      owner: { entrypoint: 'http', ownerId: 'request' },
      policy: 'wait'
    }).then((lease) => {
      waiterGranted = true
      return lease
    })

    await vi.advanceTimersByTimeAsync(199)
    expect(waiterGranted).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    await expect(barrier).resolves.toMatchObject({ status: 'timeout' })
    const next = await waiter
    expect(waiterGranted).toBe(true)
    next.release()
  })

  it('reports renderer save failure and renderer destruction without deadlocking', async () => {
    const failedRenderer = new FakeRenderer()
    markTranscriptPersistenceRendererReady(failedRenderer)
    const failed = awaitTranscriptPersistence({
      renderer: failedRenderer,
      conversationId: 'failed-cid',
      executionId: 'failed-exec'
    })
    acknowledgeTranscriptPersistence(failedRenderer, {
      conversationId: 'failed-cid', executionId: 'failed-exec', ok: false, error: 'disk full'
    })
    await expect(failed).resolves.toEqual({ status: 'failed', error: 'disk full' })

    const destroyedRenderer = new FakeRenderer()
    markTranscriptPersistenceRendererReady(destroyedRenderer)
    const destroyed = awaitTranscriptPersistence({
      renderer: destroyedRenderer,
      conversationId: 'destroyed-cid',
      executionId: 'destroyed-exec'
    })
    destroyedRenderer.destroy()
    await expect(destroyed).resolves.toMatchObject({ status: 'renderer-unavailable' })
  })

  it('keeps old renderer/test mocks compatible and ignores acknowledgements after unready', async () => {
    const renderer = new FakeRenderer()
    await expect(awaitTranscriptPersistence({
      renderer,
      conversationId: 'legacy-cid',
      executionId: 'legacy-exec'
    })).resolves.toMatchObject({ status: 'renderer-unsupported' })
    expect(renderer.sent).toHaveLength(0)

    markTranscriptPersistenceRendererReady(renderer)
    const pending = awaitTranscriptPersistence({
      renderer,
      conversationId: 'unready-cid',
      executionId: 'unready-exec'
    })
    markTranscriptPersistenceRendererUnavailable(renderer)
    await expect(pending).resolves.toMatchObject({ status: 'renderer-unavailable' })
    expect(acknowledgeTranscriptPersistence(renderer, {
      conversationId: 'unready-cid', executionId: 'unready-exec', ok: true
    })).toBe(false)
  })

  it('pins memory extraction to the conversation role captured at execution start', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/main/ipc-handlers.ts'), 'utf8')
    expect(source).toContain(
      'executionRoleName = overrides?.roleName || getCurrentRole().name'
    )
    expect(source).toContain(
      "const roleName = capturedRoleName || (conversationId ? getConversation(conversationId)?.role : undefined) || getCurrentRole().name"
    )
    expect(source).toContain('executeExtraction(messages, conversationId || null, executionRoleName!')
    expect(source).not.toMatch(/executeExtraction\(messages, conversationId \|\| null, getCurrentRole\(\)\.name/)
  })

  it('rejects a desktop turn without a durable conversation id before Runtime acquisition', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/main/ipc-handlers.ts'), 'utf8')
    const guard = source.indexOf("if (!conversationId) {")
    const acquire = source.indexOf('execution = await acquireConversationExecution', guard)
    expect(guard).toBeGreaterThanOrEqual(0)
    expect(source.slice(guard, acquire)).toContain("mainWindow.webContents.send('chat:stream-end', '', message)")
    expect(source.slice(guard, acquire)).toMatch(/return\s*\n\s*}/)
    expect(acquire).toBeGreaterThan(guard)
  })
})

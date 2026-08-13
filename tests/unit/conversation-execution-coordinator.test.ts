import { describe, expect, it } from 'vitest'
import {
  acquireConversationExecution,
  ConversationExecutionBusyError,
  getConversationExecution,
  isCurrentConversationExecution
} from '../../src/main/conversation-execution-coordinator'

describe('process-wide conversation execution coordinator', () => {
  it('keeps HTTP reject semantics across desktop and scheduler entrypoints', async () => {
    const desktop = await acquireConversationExecution({
      conversationId: 'cross-http',
      owner: { entrypoint: 'desktop', ownerId: 'renderer' },
      policy: 'supersede'
    })

    await expect(acquireConversationExecution({
      conversationId: 'cross-http',
      owner: { entrypoint: 'http', ownerId: 'acp' },
      policy: 'reject'
    })).rejects.toBeInstanceOf(ConversationExecutionBusyError)

    desktop.release()
    const http = await acquireConversationExecution({
      conversationId: 'cross-http',
      owner: { entrypoint: 'http', ownerId: 'acp' },
      policy: 'reject'
    })
    expect(getConversationExecution('cross-http')).toMatchObject({
      executionId: http.executionId,
      owner: { entrypoint: 'http', ownerId: 'acp' }
    })
    http.release()
  })

  it('preserves latest-wins desktop supersede without overlapping owner lifecycles', async () => {
    const first = await acquireConversationExecution({
      conversationId: 'desktop-supersede',
      owner: { entrypoint: 'desktop', ownerId: 'first' },
      policy: 'supersede'
    })
    const secondPending = acquireConversationExecution({
      conversationId: 'desktop-supersede',
      owner: { entrypoint: 'desktop', ownerId: 'second' },
      policy: 'supersede'
    })
    expect(first.signal.aborted).toBe(true)
    expect(getConversationExecution('desktop-supersede')?.owner.ownerId).toBe('first')
    expect(getConversationExecution('desktop-supersede')?.aborted).toBe(true)
    expect(isCurrentConversationExecution('desktop-supersede', first.executionId)).toBe(false)

    const thirdPending = acquireConversationExecution({
      conversationId: 'desktop-supersede',
      owner: { entrypoint: 'desktop', ownerId: 'third' },
      policy: 'supersede'
    })
    await expect(secondPending).rejects.toMatchObject({ name: 'AbortError' })
    first.release()

    const third = await thirdPending
    expect(third.owner.ownerId).toBe('third')
    third.release()
  })

  it('lets a scheduler waiter be cancelled without releasing or bypassing the active owner', async () => {
    const holder = await acquireConversationExecution({
      conversationId: 'scheduler-wait',
      owner: { entrypoint: 'http', ownerId: 'holder' },
      policy: 'reject'
    })
    const abort = new AbortController()
    const scheduler = acquireConversationExecution({
      conversationId: 'scheduler-wait',
      owner: { entrypoint: 'scheduler', ownerId: 'task-1' },
      policy: 'wait',
      signal: abort.signal
    })
    abort.abort()

    await expect(scheduler).rejects.toMatchObject({ name: 'AbortError' })
    expect(getConversationExecution('scheduler-wait')?.executionId).toBe(holder.executionId)

    await expect(acquireConversationExecution({
      conversationId: 'scheduler-wait',
      owner: { entrypoint: 'http', ownerId: 'other' },
      policy: 'reject'
    })).rejects.toBeInstanceOf(ConversationExecutionBusyError)
    holder.release()
  })

  it('gives a desktop superseder priority over queued scheduler work but waits for persistence release', async () => {
    const holder = await acquireConversationExecution({
      conversationId: 'priority',
      owner: { entrypoint: 'http', ownerId: 'holder' },
      policy: 'reject'
    })
    const scheduler = acquireConversationExecution({
      conversationId: 'priority',
      owner: { entrypoint: 'scheduler', ownerId: 'task' },
      policy: 'wait'
    })
    const desktop = acquireConversationExecution({
      conversationId: 'priority',
      owner: { entrypoint: 'desktop', ownerId: 'renderer' },
      policy: 'supersede'
    })

    expect(holder.signal.aborted).toBe(true)
    expect(getConversationExecution('priority')?.owner.ownerId).toBe('holder')
    holder.release()

    const desktopLease = await desktop
    expect(desktopLease.owner.entrypoint).toBe('desktop')
    desktopLease.release()
    const schedulerLease = await scheduler
    expect(schedulerLease.owner.entrypoint).toBe('scheduler')
    schedulerLease.release()
  })

  it('does not let an old execution identity authorize a later owner of the same conversation', async () => {
    const oldExecution = await acquireConversationExecution({
      conversationId: 'permission-owner',
      owner: { entrypoint: 'desktop', ownerId: 'old' },
      policy: 'supersede'
    })
    expect(isCurrentConversationExecution('permission-owner', oldExecution.executionId)).toBe(true)
    oldExecution.release()

    const nextExecution = await acquireConversationExecution({
      conversationId: 'permission-owner',
      owner: { entrypoint: 'http', ownerId: 'new' },
      policy: 'reject'
    })
    expect(isCurrentConversationExecution('permission-owner', oldExecution.executionId)).toBe(false)
    expect(isCurrentConversationExecution('permission-owner', nextExecution.executionId)).toBe(true)
    nextExecution.release()
  })
})

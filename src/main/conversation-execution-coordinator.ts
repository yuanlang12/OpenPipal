import { randomUUID } from 'node:crypto'

export type ConversationExecutionEntrypoint = 'desktop' | 'http' | 'scheduler'
export type ConversationExecutionPolicy = 'reject' | 'wait' | 'supersede'

export interface ConversationExecutionOwner {
  entrypoint: ConversationExecutionEntrypoint
  /** Human-readable owner identity for diagnostics (for example a task id). */
  ownerId: string
}

export interface ConversationExecutionLease {
  readonly conversationId: string
  readonly executionId: string
  readonly owner: Readonly<ConversationExecutionOwner>
  /** Coordinator-owned signal. Supersede and the caller's signal both abort it. */
  readonly signal: AbortSignal
  isCurrent(): boolean
  abort(reason?: unknown): void
  release(): void
}

export interface AcquireConversationExecutionOptions {
  conversationId: string
  owner: ConversationExecutionOwner
  policy: ConversationExecutionPolicy
  signal?: AbortSignal
}

export class ConversationExecutionBusyError extends Error {
  readonly code = 'CONVERSATION_EXECUTION_BUSY'

  constructor(readonly conversationId: string) {
    super(`Conversation ${conversationId} already has an active execution`)
    this.name = 'ConversationExecutionBusyError'
  }
}

function abortError(message: string, reason?: unknown): Error {
  if (reason instanceof Error) return reason
  const error = new Error(message)
  error.name = 'AbortError'
  return error
}

interface Waiter {
  executionId: string
  owner: Readonly<ConversationExecutionOwner>
  policy: Exclude<ConversationExecutionPolicy, 'reject'>
  externalSignal?: AbortSignal
  onExternalAbort?: () => void
  resolve: (lease: ConversationExecutionLease) => void
  reject: (error: Error) => void
}

interface ActiveExecution {
  executionId: string
  owner: Readonly<ConversationExecutionOwner>
  controller: AbortController
  externalSignal?: AbortSignal
  onExternalAbort?: () => void
  released: boolean
}

interface ConversationState {
  active?: ActiveExecution
  queue: Waiter[]
}

const states = new Map<string, ConversationState>()

function cleanupState(conversationId: string, state: ConversationState): void {
  if (!state.active && state.queue.length === 0 && states.get(conversationId) === state) {
    states.delete(conversationId)
  }
}

function removeWaiter(conversationId: string, state: ConversationState, waiter: Waiter): boolean {
  const index = state.queue.indexOf(waiter)
  if (index < 0) return false
  state.queue.splice(index, 1)
  if (waiter.externalSignal && waiter.onExternalAbort) {
    waiter.externalSignal.removeEventListener('abort', waiter.onExternalAbort)
  }
  cleanupState(conversationId, state)
  return true
}

function grant(
  conversationId: string,
  state: ConversationState,
  executionId: string,
  owner: Readonly<ConversationExecutionOwner>,
  externalSignal?: AbortSignal
): ConversationExecutionLease {
  const controller = new AbortController()
  const active: ActiveExecution = {
    executionId,
    owner,
    controller,
    externalSignal,
    released: false
  }

  if (externalSignal) {
    active.onExternalAbort = () => {
      if (!controller.signal.aborted) {
        controller.abort(abortError('Conversation execution was cancelled', externalSignal.reason))
      }
    }
    externalSignal.addEventListener('abort', active.onExternalAbort, { once: true })
    if (externalSignal.aborted) active.onExternalAbort()
  }

  state.active = active

  return Object.freeze({
    conversationId,
    executionId,
    owner,
    signal: controller.signal,
    isCurrent: () => states.get(conversationId)?.active === active && !active.released,
    abort: (reason?: unknown) => {
      if (!controller.signal.aborted) {
        controller.abort(abortError('Conversation execution was aborted', reason))
      }
    },
    release: () => {
      if (active.released) return
      active.released = true
      if (active.externalSignal && active.onExternalAbort) {
        active.externalSignal.removeEventListener('abort', active.onExternalAbort)
      }
      if (states.get(conversationId)?.active === active) {
        state.active = undefined
        dispatchNext(conversationId, state)
      }
    }
  })
}

function dispatchNext(conversationId: string, state: ConversationState): void {
  if (state.active) return

  while (state.queue.length > 0) {
    const waiter = state.queue.shift()!
    if (waiter.externalSignal && waiter.onExternalAbort) {
      waiter.externalSignal.removeEventListener('abort', waiter.onExternalAbort)
    }
    if (waiter.externalSignal?.aborted) {
      waiter.reject(abortError('Conversation execution was cancelled while waiting', waiter.externalSignal.reason))
      continue
    }
    waiter.resolve(grant(
      conversationId,
      state,
      waiter.executionId,
      waiter.owner,
      waiter.externalSignal
    ))
    return
  }

  cleanupState(conversationId, state)
}

/**
 * Acquire process-wide ownership of a persisted conversation execution.
 *
 * - reject: fail immediately when any entrypoint owns or is queued for the id.
 * - wait: FIFO and AbortSignal-cancellable (scheduler semantics).
 * - supersede: abort the active execution and replace older queued superseders,
 *   then wait for the old owner to finish its persistence/finally lifecycle.
 */
export function acquireConversationExecution(
  options: AcquireConversationExecutionOptions
): Promise<ConversationExecutionLease> {
  const conversationId = options.conversationId
  if (!conversationId) {
    return Promise.reject(new TypeError('conversationId is required for coordinated execution'))
  }
  if (options.signal?.aborted) {
    return Promise.reject(abortError('Conversation execution was cancelled', options.signal.reason))
  }

  const owner = Object.freeze({ ...options.owner })
  let state = states.get(conversationId)
  if (!state) {
    state = { queue: [] }
    states.set(conversationId, state)
  }

  if (!state.active && state.queue.length === 0) {
    return Promise.resolve(grant(conversationId, state, randomUUID(), owner, options.signal))
  }

  const queuePolicy = options.policy
  if (queuePolicy === 'reject') {
    return Promise.reject(new ConversationExecutionBusyError(conversationId))
  }

  if (queuePolicy === 'supersede') {
    state.active?.controller.abort(abortError(
      'Conversation execution was superseded by a newer desktop request'
    ))
    // Rapid desktop sends are latest-wins. An older queued superseder must not
    // start between the current owner and the newest user request.
    for (const queued of [...state.queue]) {
      if (queued.policy !== 'supersede') continue
      removeWaiter(conversationId, state, queued)
      queued.reject(abortError('Conversation execution was superseded before it started'))
    }
  }

  return new Promise<ConversationExecutionLease>((resolve, reject) => {
    const waiter: Waiter = {
      executionId: randomUUID(),
      owner,
      policy: queuePolicy,
      externalSignal: options.signal,
      resolve,
      reject
    }
    if (options.signal) {
      waiter.onExternalAbort = () => {
        if (!removeWaiter(conversationId, state!, waiter)) return
        reject(abortError('Conversation execution was cancelled while waiting', options.signal!.reason))
      }
      options.signal.addEventListener('abort', waiter.onExternalAbort, { once: true })
    }

    if (queuePolicy === 'supersede') {
      const firstWaiter = state!.queue.findIndex((queued) => queued.policy === 'wait')
      if (firstWaiter < 0) state!.queue.push(waiter)
      else state!.queue.splice(firstWaiter, 0, waiter)
    } else {
      state!.queue.push(waiter)
    }
    if (options.signal?.aborted) waiter.onExternalAbort?.()
  })
}

export interface ConversationExecutionSnapshot {
  conversationId: string
  executionId: string
  owner: Readonly<ConversationExecutionOwner>
  /** Aborted owners retain the lease until cleanup/persistence, but cannot authorize new work. */
  aborted: boolean
}

export function getConversationExecution(conversationId: string): ConversationExecutionSnapshot | undefined {
  const active = states.get(conversationId)?.active
  if (!active || active.released) return undefined
  return Object.freeze({
    conversationId,
    executionId: active.executionId,
    owner: active.owner,
    aborted: active.controller.signal.aborted
  })
}

export function isCurrentConversationExecution(conversationId: string, executionId: string): boolean {
  const execution = getConversationExecution(conversationId)
  return execution?.executionId === executionId && !execution.aborted
}

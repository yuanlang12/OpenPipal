import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  clearSessionApprovals,
  MCP_PERMISSION_TIMEOUT_MS,
  pendingPermissionResolvers,
  requestUserConfirmation,
  resolvePermissionRequest,
  setInlinePermissionSender,
  setPermissionRequestSettlementHandler
} from '../../src/main/pi-security'

afterEach(() => {
  for (const requestId of [...pendingPermissionResolvers.keys()]) {
    resolvePermissionRequest(requestId, false)
  }
  clearSessionApprovals()
  setInlinePermissionSender(null, () => null)
  setPermissionRequestSettlementHandler(null)
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('nested MCP permission cancellation', () => {
  it('settles false and removes the resolver immediately when the run aborts', async () => {
    vi.useFakeTimers()
    const settlements = vi.fn()
    setPermissionRequestSettlementHandler(settlements)
    let requestId = ''
    setInlinePermissionSender((_getWindow, request) => {
      requestId = request.requestId
    }, () => null)

    const controller = new AbortController()
    const pending = requestUserConfirmation(
      'remote_write',
      { value: 'x' },
      'writes remote data',
      'permission-abort-conversation',
      controller.signal
    )

    expect(requestId).not.toBe('')
    expect(pendingPermissionResolvers.has(requestId)).toBe(true)
    expect(vi.getTimerCount()).toBe(1)
    controller.abort()

    await expect(pending).resolves.toBe(false)
    expect(pendingPermissionResolvers.has(requestId)).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
    expect(settlements).toHaveBeenCalledOnce()
    expect(settlements).toHaveBeenCalledWith({
      requestId,
      approved: false,
      cause: 'abort'
    })
  })

  it('does not let a stale approval win after cancellation', async () => {
    let requestId = ''
    setInlinePermissionSender((_getWindow, request) => {
      requestId = request.requestId
    }, () => null)

    const controller = new AbortController()
    const pending = requestUserConfirmation(
      'remote_delete',
      { id: 'item-1' },
      'deletes remote data',
      'permission-race-conversation',
      controller.signal
    )

    controller.abort()
    resolvePermissionRequest(requestId, true)

    await expect(pending).resolves.toBe(false)
    expect(pendingPermissionResolvers.has(requestId)).toBe(false)
  })

  it('does not create a resolver for a signal that is already aborted', async () => {
    let sent = false
    setInlinePermissionSender(() => {
      sent = true
    }, () => null)
    const controller = new AbortController()
    controller.abort()

    await expect(requestUserConfirmation(
      'remote_write',
      {},
      'writes remote data',
      'permission-pre-abort-conversation',
      controller.signal
    )).resolves.toBe(false)

    expect(sent).toBe(false)
    expect(pendingPermissionResolvers.size).toBe(0)
  })

  it('removes the abort listener and timeout after a normal approval', async () => {
    vi.useFakeTimers()
    const settlements = vi.fn()
    setPermissionRequestSettlementHandler(settlements)
    let requestId = ''
    setInlinePermissionSender((_getWindow, request) => {
      requestId = request.requestId
    }, () => null)
    const controller = new AbortController()
    const removeListener = vi.spyOn(controller.signal, 'removeEventListener')

    const pending = requestUserConfirmation(
      'remote_write',
      { value: 'x' },
      'writes remote data',
      'permission-cleanup-conversation',
      controller.signal
    )
    expect(vi.getTimerCount()).toBe(1)
    resolvePermissionRequest(requestId, true)

    await expect(pending).resolves.toBe(true)
    expect(removeListener).toHaveBeenCalledWith('abort', expect.any(Function))
    expect(vi.getTimerCount()).toBe(0)
    expect(pendingPermissionResolvers.has(requestId)).toBe(false)
    controller.abort()
    expect(settlements).toHaveBeenCalledOnce()
    expect(settlements).toHaveBeenCalledWith({
      requestId,
      approved: true,
      cause: 'response'
    })
  })

  it('fails closed and cleans up if sending the permission prompt throws', async () => {
    vi.useFakeTimers()
    const settlements = vi.fn()
    setPermissionRequestSettlementHandler(settlements)
    setInlinePermissionSender(() => {
      throw new Error('renderer unavailable')
    }, () => null)

    await expect(requestUserConfirmation(
      'remote_write',
      {},
      'writes remote data',
      'permission-send-failure-conversation',
      new AbortController().signal
    )).resolves.toBe(false)

    expect(pendingPermissionResolvers.size).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
    expect(settlements).toHaveBeenCalledWith(expect.objectContaining({
      approved: false,
      cause: 'send-failed'
    }))
  })

  it('notifies timeout settlement exactly once and releases all resources', async () => {
    vi.useFakeTimers()
    let requestId = ''
    const settlements = vi.fn()
    setPermissionRequestSettlementHandler(settlements)
    setInlinePermissionSender((_getWindow, request) => {
      requestId = request.requestId
    }, () => null)

    const pending = requestUserConfirmation(
      'remote_write',
      {},
      'writes remote data',
      'permission-timeout-conversation',
      new AbortController().signal
    )
    expect(MCP_PERMISSION_TIMEOUT_MS).toBe(3_600_000)
    await vi.advanceTimersByTimeAsync(MCP_PERMISSION_TIMEOUT_MS)

    await expect(pending).resolves.toBe(false)
    expect(pendingPermissionResolvers.has(requestId)).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
    expect(settlements).toHaveBeenCalledOnce()
    expect(settlements).toHaveBeenCalledWith({
      requestId,
      approved: false,
      cause: 'timeout'
    })
  })
})

import { describe, expect, it, vi } from 'vitest'
import {
  executeInQuickJS,
  QUICKJS_DEFAULT_CPU_TIMEOUT_MS,
  QUICKJS_LOG_MAX_BYTES,
  QUICKJS_RPC_REQUEST_MAX_BYTES,
  QUICKJS_RPC_RESPONSE_MAX_BYTES,
  type ToolsApi
} from '../../src/main/quickjs-sandbox'
import {
  clearSessionApprovals,
  requestUserConfirmation,
  resolvePermissionRequest,
  setInlinePermissionSender
} from '../../src/main/pi-security'

function createToolsApi(overrides: Partial<ToolsApi> = {}): ToolsApi {
  return {
    search: vi.fn(async () => []),
    describe: vi.fn(async () => 'schema'),
    call: vi.fn(async () => 'ok'),
    ...overrides
  }
}

describe('QuickJS worker cancellation', () => {
  it('executes the production worker RPC bridge', async () => {
    const call = vi.fn(async (_name: string, args: Record<string, unknown>) => (
      JSON.stringify({ echoed: args.value })
    ))

    const result = await executeInQuickJS(
      'var value = tools.call("remote_read", { value: 7 }); console.log(value.echoed);',
      createToolsApi({ call }),
      { timeoutMs: 5_000 }
    )

    expect(result.error).toBeUndefined()
    expect(result.logs).toEqual(['7'])
    expect(call).toHaveBeenCalledWith('remote_read', { value: 7 }, undefined)
  }, 10_000)

  it('forwards the server returned by search through real worker describe/call RPC', async () => {
    const search = vi.fn(async () => [{
      name: 'shared_read',
      server: 'allowed-server',
      description: 'allowed duplicate'
    }])
    const describe = vi.fn(async () => 'allowed schema')
    const call = vi.fn(async () => 'allowed result')

    const result = await executeInQuickJS(
      'var rows = tools.search("shared");' +
      'console.log(tools.describe(rows[0].name, rows[0].server));' +
      'console.log(tools.call(rows[0].name, {}, rows[0].server));',
      createToolsApi({ search, describe, call }),
      { timeoutMs: 5_000, wallTimeoutMs: 10_000 }
    )

    expect(result.error).toBeUndefined()
    expect(result.logs).toEqual(['allowed schema', 'allowed result'])
    expect(describe).toHaveBeenCalledWith('shared_read', 'allowed-server')
    expect(call).toHaveBeenCalledWith('shared_read', {}, 'allowed-server')
  }, 10_000)

  it('preempts a pure loop when the caller aborts', async () => {
    const controller = new AbortController()
    const startedAt = Date.now()
    const pending = executeInQuickJS(
      'while (true) {}',
      createToolsApi(),
      { timeoutMs: 5_000, signal: controller.signal }
    )

    setTimeout(() => {
      controller.abort(new DOMException('superseded', 'AbortError'))
    }, 25)

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    expect(Date.now() - startedAt).toBeLessThan(1_500)
  }, 10_000)

  it('cancels an async host-tool wait and releases the worker promptly', async () => {
    const controller = new AbortController()
    let notifyStarted!: () => void
    const callStarted = new Promise<void>((resolve) => { notifyStarted = resolve })
    let hostObservedAbort = false

    const call = vi.fn(() => new Promise<string>((resolve, reject) => {
      notifyStarted()
      const onAbort = (): void => {
        hostObservedAbort = true
        controller.signal.removeEventListener('abort', onAbort)
        reject(controller.signal.reason)
      }
      if (controller.signal.aborted) {
        onAbort()
        return
      }
      controller.signal.addEventListener('abort', onAbort, { once: true })
      void resolve
    }))

    const pending = executeInQuickJS(
      'console.log(tools.call("remote_wait", {}));',
      createToolsApi({ call }),
      { timeoutMs: 5_000, signal: controller.signal }
    )

    await callStarted
    const abortedAt = Date.now()
    controller.abort(new DOMException('stopped', 'AbortError'))

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    expect(hostObservedAbort).toBe(true)
    expect(Date.now() - abortedAt).toBeLessThan(1_000)
  }, 10_000)

  it('aborts trusted host work when the VM deadline expires', async () => {
    const hostController = new AbortController()
    const result = await executeInQuickJS(
      'while (true) {}',
      createToolsApi(),
      {
        timeoutMs: 100,
        onTimeout: () => hostController.abort(new Error('sandbox timeout'))
      }
    )

    expect(hostController.signal.aborted).toBe(true)
    expect(result.error).toContain('执行超时')
  }, 10_000)

  it('does not charge a trusted approval wait against the pure VM CPU budget', async () => {
    setInlinePermissionSender((_getWindow, request) => {
      setTimeout(() => resolvePermissionRequest(request.requestId, true), 250)
    }, () => null)
    const call = vi.fn(async () => {
      const approved = await requestUserConfirmation(
        'remote_write',
        { value: 'x' },
        'writes remote data',
        'real-worker-approval'
      )
      return approved ? 'approved' : 'denied'
    })
    const startedAt = Date.now()

    try {
      const result = await executeInQuickJS(
        'console.log(tools.call("approval", {}));',
        createToolsApi({ call }),
        { timeoutMs: 100, wallTimeoutMs: 2_000 }
      )

      expect(result.error).toBeUndefined()
      expect(result.logs).toEqual(['approved'])
      expect(Date.now() - startedAt).toBeGreaterThanOrEqual(200)
      expect(call).toHaveBeenCalledOnce()
      expect(QUICKJS_DEFAULT_CPU_TIMEOUT_MS).toBe(30_000)
    } finally {
      clearSessionApprovals()
      setInlinePermissionSender(null, () => null)
    }
  }, 10_000)

  it('still applies the end-to-end wall ceiling while the host is waiting', async () => {
    const hostController = new AbortController()
    let notifyStarted!: () => void
    const started = new Promise<void>((resolve) => { notifyStarted = resolve })
    const call = vi.fn(() => new Promise<string>((_resolve, reject) => {
      notifyStarted()
      hostController.signal.addEventListener('abort', () => reject(hostController.signal.reason), { once: true })
    }))

    const pending = executeInQuickJS(
      'console.log(tools.call("approval", {}));',
      createToolsApi({ call }),
      {
        timeoutMs: 50,
        wallTimeoutMs: 250,
        onTimeout: () => hostController.abort(new Error('wall timeout'))
      }
    )
    await started
    const result = await pending

    expect(hostController.signal.aborted).toBe(true)
    expect(result.timedOut).toBe(true)
    expect(result.error).toContain('总时限')
  }, 10_000)

  it('bounds console output by UTF-8 bytes and emits an explicit truncation marker', async () => {
    const result = await executeInQuickJS(
      'for (var i = 0; i < 400; i++) console.log("界".repeat(1000));',
      createToolsApi(),
      { timeoutMs: 5_000, wallTimeoutMs: 10_000 }
    )
    const joined = result.logs.join('\n')

    expect(result.error).toBeUndefined()
    expect(Buffer.byteLength(joined, 'utf8')).toBeLessThanOrEqual(QUICKJS_LOG_MAX_BYTES)
    expect(joined).toContain('QuickJS logs truncated')
  }, 15_000)

  it('bounds oversized host RPC responses before they cross into QuickJS', async () => {
    const call = vi.fn(async () => '界'.repeat(QUICKJS_RPC_RESPONSE_MAX_BYTES))
    const result = await executeInQuickJS(
      'var value = tools.call("large", {}); console.log(value.slice(-200));',
      createToolsApi({ call }),
      { timeoutMs: 5_000, wallTimeoutMs: 10_000 }
    )

    expect(result.error).toBeUndefined()
    expect(result.logs.join('\n')).toContain('MCP RPC response truncated')
    expect(call).toHaveBeenCalledOnce()
  }, 15_000)

  it('rejects oversized QuickJS RPC requests before invoking the trusted host', async () => {
    const call = vi.fn(async () => 'unexpected')
    const result = await executeInQuickJS(
      `tools.call("large", { value: "x".repeat(${QUICKJS_RPC_REQUEST_MAX_BYTES + 1}) });`,
      createToolsApi({ call }),
      { timeoutMs: 5_000, wallTimeoutMs: 10_000 }
    )

    expect(result.error).toContain('request exceeds')
    expect(call).not.toHaveBeenCalled()
  }, 15_000)
})

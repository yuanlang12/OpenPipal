import { describe, expect, it, vi } from 'vitest'
import type { PermissionHandler } from '../../src/main/pi-security'
import type { OpenPipalAgentRuntime } from '../../src/main/agent-runtime/contracts'
import { createAgentRuntimeHost } from '../../src/main/agent-runtime/runtime-host'

function fakeRuntime(setPermissionHandler = vi.fn()): OpenPipalAgentRuntime {
  return {
    kind: 'legacy',
    agentChat: async function* () {},
    setPermissionHandler,
    testThinkingSupport: async () => ({ detected: false })
  }
}

describe('Agent Runtime host stability', () => {
  it('loads once for concurrent callers and keeps one process-lifetime instance', async () => {
    const runtime = fakeRuntime()
    const loader = vi.fn(async () => runtime)
    const host = createAgentRuntimeHost(loader)

    const [first, second] = await Promise.all([host.getRuntime(), host.getRuntime()])
    expect(first).toBe(runtime)
    expect(second).toBe(runtime)
    expect(loader).toHaveBeenCalledTimes(1)
    expect(await host.getRuntime()).toBe(runtime)
  })

  it('applies a permission handler registered before lazy loading', async () => {
    const setPermissionHandler = vi.fn()
    const runtime = fakeRuntime(setPermissionHandler)
    const host = createAgentRuntimeHost(async () => runtime)
    const handler = vi.fn() as unknown as PermissionHandler

    host.setPermissionHandler(handler)
    await host.getRuntime()

    expect(setPermissionHandler).toHaveBeenCalledOnce()
    expect(setPermissionHandler).toHaveBeenCalledWith(handler)
  })

  it('updates the active runtime when the permission handler changes', async () => {
    const setPermissionHandler = vi.fn()
    const host = createAgentRuntimeHost(async () => fakeRuntime(setPermissionHandler))
    await host.getRuntime()
    const handler = vi.fn() as unknown as PermissionHandler

    host.setPermissionHandler(handler)

    expect(setPermissionHandler).toHaveBeenCalledOnce()
    expect(setPermissionHandler).toHaveBeenCalledWith(handler)
  })

  it('applies the latest permission handler exactly once when loading completes', async () => {
    let finishLoading!: (runtime: OpenPipalAgentRuntime) => void
    const setPermissionHandler = vi.fn()
    const runtime = fakeRuntime(setPermissionHandler)
    const host = createAgentRuntimeHost(() => new Promise((resolve) => {
      finishLoading = resolve
    }))
    const handler = vi.fn() as unknown as PermissionHandler

    const loading = host.getRuntime()
    host.setPermissionHandler(handler)
    finishLoading(runtime)
    await loading

    expect(setPermissionHandler).toHaveBeenCalledOnce()
    expect(setPermissionHandler).toHaveBeenCalledWith(handler)
  })

  it('retries a failed pre-run module load instead of caching a rejection forever', async () => {
    const runtime = fakeRuntime()
    const loader = vi.fn()
      .mockRejectedValueOnce(new Error('temporary load failure'))
      .mockResolvedValueOnce(runtime)
    const host = createAgentRuntimeHost(loader)

    await expect(host.getRuntime()).rejects.toThrow('temporary load failure')
    await expect(host.getRuntime()).resolves.toBe(runtime)
    expect(loader).toHaveBeenCalledTimes(2)
  })
})

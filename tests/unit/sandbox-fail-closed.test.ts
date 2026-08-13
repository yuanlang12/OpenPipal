import fs from 'node:fs'
import path from 'node:path'
import { NodeExecutionEnv } from '@earendil-works/pi-agent-core/node'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  wrapWithSandbox: vi.fn(),
  initialize: vi.fn(),
  reset: vi.fn()
}))

vi.mock('@anthropic-ai/sandbox-runtime', () => ({
  SandboxManager: {
    isSupportedPlatform: () => true,
    initialize: mocks.initialize,
    isSandboxingEnabled: () => true,
    wrapWithSandbox: mocks.wrapWithSandbox,
    reset: mocks.reset,
    getConfig: vi.fn()
  }
}))

const sandbox = await import('../../src/main/sandbox-manager')
const { OpenPipalNodeExecutionEnv } = await import('../../src/main/openpipal-execution-env')

describe('sandbox wrapper failure is fail-closed', () => {
  beforeAll(async () => {
    expect(await sandbox.initSandbox()).toBe(true)
  })

  afterAll(async () => {
    await sandbox.resetSandbox()
  })

  it('does not call the public execution backend when strict wrapping fails', async () => {
    mocks.wrapWithSandbox.mockRejectedValueOnce(new Error('synthetic SRT failure'))
    const baseExec = vi.spyOn(NodeExecutionEnv.prototype, 'exec')
    const env = new OpenPipalNodeExecutionEnv(process.cwd())
    try {
      const result = await env.exec('printf should-not-run')
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error.message).toContain('synthetic SRT failure')
      expect(baseExec).not.toHaveBeenCalled()
    } finally {
      baseExec.mockRestore()
      await env.cleanup()
    }
  })

  it('does not spawn after cleanup wins a pending sandbox-wrapper race', async () => {
    let releaseWrapper!: (command: string) => void
    const wrapperPending = new Promise<string>(resolve => { releaseWrapper = resolve })
    mocks.wrapWithSandbox.mockReturnValueOnce(wrapperPending)
    const callsBefore = mocks.wrapWithSandbox.mock.calls.length
    const env = new OpenPipalNodeExecutionEnv(process.cwd())

    const execution = env.exec('printf must-not-run-after-cleanup')
    await vi.waitFor(() => {
      expect(mocks.wrapWithSandbox).toHaveBeenCalledTimes(callsBefore + 1)
    })
    await env.cleanup()
    releaseWrapper('printf must-not-run-after-cleanup')

    const result = await execution
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('aborted')

    const afterCleanup = await env.exec('printf still-must-not-run')
    expect(afterCleanup.ok).toBe(false)
    if (!afterCleanup.ok) expect(afterCleanup.error.code).toBe('aborted')
  })

  it('wires the default legacy facade to the same strict wrapper', () => {
    const legacySource = fs.readFileSync(path.resolve('src/main/pi-tools.ts'), 'utf8')
    const executionSource = fs.readFileSync(path.resolve('src/main/openpipal-execution-env.ts'), 'utf8')
    expect(legacySource).toContain("await import('./openpipal-execution-env')")
    expect(executionSource).toContain('wrapCommandStrict')
    expect(legacySource).not.toMatch(/\bwrapCommand(?:Strict)?\(/)
  })
})

import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { isPiCoreNodeVersionSupported } from '../../src/main/agent-runtime/pi-core-compatibility'

describe('pi-core 0.84.1 Agent public contract in Electron', () => {
  it('runs Agent offline and fails closed if the unimplemented Harness is selected', () => {
    const electron = path.resolve(
      'node_modules/.bin',
      process.platform === 'win32' ? 'electron.cmd' : 'electron'
    )
    const fixture = path.resolve('tests/fixtures/pi-core-electron-contract.mjs')
    const stdout = execFileSync(electron, [fixture], {
      encoding: 'utf8',
      timeout: 15_000,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
    })
    const result = JSON.parse(stdout)

    expect(result.text).toBe('ok')
    expect(result.messageCount).toBeGreaterThanOrEqual(2)
    expect(result.electronVersion).toBe('43.3.0')
    expect(result.nodeVersion).toBe('24.18.1')
    expect(result.modulesVersion).toBe('148')
    expect(isPiCoreNodeVersionSupported(result.nodeVersion)).toBe(true)
    expect(result.events).toContain('agent_start')
    expect(result.events).toContain('turn_start')
    expect(result.events).toContain('message_end')
    expect(result.events).toContain('turn_end')
    expect(result.events).toContain('agent_end')
    expect(result.listenerSettlement).toEqual({
      isStreamingDuringAgentEnd: true,
      promptPendingDuringAgentEnd: true,
      waitForIdlePendingDuringAgentEnd: true
    })
    expect(result.harnessPromptError).toEqual({
      name: 'HarnessNotImplemented',
      operation: 'prompt',
      message: 'AgentHarness.prompt is not implemented yet'
    })
  })
})

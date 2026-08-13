import os from 'node:os'
import path from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  readExecutions: 0,
  safeReadArgs: [] as Array<Record<string, unknown>>,
  authorizeArgs: [] as Array<Record<string, unknown>>,
}))

vi.mock('electron', () => ({
  app: { isPackaged: false, getAppPath: () => process.cwd() },
  BrowserWindow: class BrowserWindow {},
  screen: {},
  desktopCapturer: {},
  clipboard: {},
}))

vi.mock('../../src/main/config-manager', () => ({
  getWorkingDir: () => os.tmpdir(),
  getEffectiveModelConfig: () => ({}),
  resolveConversationModelConfig: () => ({ source: 'global', config: {} }),
  loadConfig: () => ({}),
  listModelPresets: () => [],
}))

vi.mock('../../src/main/agent-overrides', () => ({
  resolveAgentOverrides: ({ conversationId }: { conversationId?: string }) => ({
    systemPrompt: '',
    conversationId,
    roleName: 'general',
  }),
  resolveExecutionRoleName: () => 'general',
}))

vi.mock('../../src/main/agent-workspace-store', () => ({
  readToolsConfig: () => undefined,
}))

vi.mock('../../src/main/pi-tools', () => ({
  AskUserResolver: class AskUserResolver {},
  buildPiTools: () => [{
    name: 'read',
    label: 'read',
    description: 'test read',
    parameters: { type: 'object' },
    async execute(_id: string, args: Record<string, unknown>) {
      state.readExecutions += 1
      state.safeReadArgs.push(args)
      return { content: [{ type: 'text', text: 'safe read result' }], details: {} }
    },
  }],
}))

vi.mock('../../src/main/pi-mcp-bridge', () => ({
  buildMcpBridgeTools: () => [],
}))

vi.mock('../../src/main/pi-security', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/main/pi-security')>()
  return {
    ...actual,
    authorizeToolCall: vi.fn(async (
      _name: string,
      args: Record<string, unknown>,
    ) => {
      state.authorizeArgs.push(args)
      return typeof args.path === 'string' && args.path.endsWith('config.json')
        ? { block: true, reason: 'credential path blocked' }
        : undefined
    }),
  }
})

const { executeVoiceTool } = await import('../../src/main/realtime-tool-bridge')

describe('realtime tool final authorization sink', () => {
  beforeEach(() => {
    state.readExecutions = 0
    state.safeReadArgs.length = 0
    state.authorizeArgs.length = 0
  })

  it('blocks a credential read before the tool execute sink', async () => {
    const result = await executeVoiceTool(
      'read',
      JSON.stringify({ path: path.join(os.homedir(), '.openpipal', 'config.json') }),
      { conversationId: 'voice-security' }
    )

    expect(state.readExecutions).toBe(0)
    expect(result.raw).toBeNull()
    expect(result.output).toContain('credential path blocked')
  })

  it('authorizes and executes using the exact same parsed args object', async () => {
    const result = await executeVoiceTool(
      'read',
      JSON.stringify({ path: path.join(os.tmpdir(), 'public.txt') }),
      { conversationId: 'voice-security' }
    )

    expect(result.output).toContain('safe read result')
    expect(state.readExecutions).toBe(1)
    expect(state.authorizeArgs).toHaveLength(1)
    expect(state.safeReadArgs).toHaveLength(1)
    expect(state.safeReadArgs[0]).toBe(state.authorizeArgs[0])
  })
})

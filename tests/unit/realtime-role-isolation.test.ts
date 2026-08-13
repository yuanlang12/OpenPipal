import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  currentRole: 'general',
  conversationRoles: new Map<string, string>(),
  voiceConfig: {
    provider: 'openai',
    baseUrl: 'wss://voice.invalid',
    apiKey: 'test-key',
    model: 'voice-test',
    voice: 'alloy'
  } as any,
  doubaoConfig: null as any,
  sockets: [] as any[],
  sessionConfigs: [] as any[],
  interpretSessions: [] as any[]
}))

class MockWebSocket extends EventEmitter {
  static OPEN = 1
  readyState = MockWebSocket.OPEN
  sent: string[] = []

  constructor(..._args: unknown[]) {
    super()
    state.sockets.push(this)
  }

  send(payload: string): void {
    this.sent.push(payload)
  }

  close(): void {
    this.readyState = 3
  }
}

vi.mock('ws', () => ({ default: MockWebSocket }))
vi.mock('electron', () => ({ BrowserWindow: class {} }))
vi.mock('../../src/main/config-manager', () => ({
  getEffectiveVoiceConfig: () => state.voiceConfig,
  getDoubaoVoiceConfig: () => state.doubaoConfig
}))
vi.mock('../../src/main/role-manager', () => ({
  getCurrentRole: () => ({ name: state.currentRole })
}))
vi.mock('../../src/main/agent-overrides', () => ({
  resolveAgentOverrides: ({ conversationId }: { conversationId?: string }) => ({
    systemPrompt: '',
    conversationId,
    roleName: state.conversationRoles.get(conversationId || '') || state.currentRole
  }),
  resolveExecutionRoleName: (overrides?: { roleName?: string; conversationId?: string }) => (
    overrides?.roleName
    || state.conversationRoles.get(overrides?.conversationId || '')
    || state.currentRole
  )
}))
vi.mock('../../src/main/realtime-provider', () => ({
  getRealtimeProvider: () => ({
    name: 'openai',
    buildWebSocketURL: () => 'wss://voice.invalid',
    buildAuthHeaders: () => ({}),
    getSessionConfig: (options: unknown) => {
      state.sessionConfigs.push(options)
      return { type: 'session.update', options }
    }
  })
}))
vi.mock('../../src/main/agent-runtime/openpipal-prompt', () => ({
  buildOpenPipalSystemPrompt: (_source: unknown, overrides?: { roleName?: string }) => (
    `PROMPT:${overrides?.roleName || 'missing'}`
  )
}))
vi.mock('../../src/main/realtime-tool-bridge', () => ({
  buildVoiceToolSchemas: (context?: { roleName?: string }) => ([{
    type: 'function',
    name: `tool-${context?.roleName || 'missing'}`
  }]),
  executeVoiceTool: async () => ({ output: '', raw: null })
}))
vi.mock('../../src/main/doubao-interpret-session', () => ({
  DoubaoInterpretSession: class {
    constructor(readonly options: unknown) {
      state.interpretSessions.push(this)
    }
    async connect(): Promise<{ success: boolean }> { return { success: true } }
    close(): void {}
    handleClientEvent(): void {}
  }
}))
vi.mock('../../src/main/doubao-duplex-session', () => ({
  DoubaoDuplexSession: class {
    async connect(): Promise<{ success: boolean }> { return { success: true } }
    close(): void {}
    handleClientEvent(): void {}
  }
}))
vi.mock('../../src/main/voice-turn-policy', () => ({
  TOOL_EXECUTED: 'tool-executed',
  reduceVoiceTurn: (value: any) => ({ state: value, commands: [] })
}))
vi.mock('../../src/main/pi-security', () => ({
  classifyToolRisk: () => ({ level: 'safe', reason: '' }),
  requestUserConfirmation: async () => true
}))

const { startRealtimeSession, stopRealtimeSession } = await import('../../src/main/realtime-session')

describe('Realtime voice role isolation', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    stopRealtimeSession()
    state.currentRole = 'general'
    state.conversationRoles.clear()
    state.doubaoConfig = null
    state.sockets.length = 0
    state.sessionConfigs.length = 0
    state.interpretSessions.length = 0
  })

  afterEach(() => {
    stopRealtimeSession()
    vi.useRealTimers()
  })

  it('selects interpreter transport from the conversation role instead of the global role', async () => {
    state.conversationRoles.set('voice-interpreter', 'interpreter')
    state.doubaoConfig = {
      provider: 'doubao',
      apiKey: 'doubao-key',
      sourceLanguage: 'en',
      targetLanguage: 'zh'
    }

    await expect(startRealtimeSession({ conversationId: 'voice-interpreter' }))
      .resolves.toMatchObject({ success: true, sampleRate: 16000 })
    expect(state.interpretSessions).toHaveLength(1)
    expect(state.sockets).toHaveLength(0)
  })

  it('keeps the captured interpreter role through a delayed session.created callback', async () => {
    state.conversationRoles.set('voice-interpreter', 'interpreter')
    state.doubaoConfig = null

    const starting = startRealtimeSession({ conversationId: 'voice-interpreter' })
    await vi.waitFor(() => expect(state.sockets).toHaveLength(1))
    const socket = state.sockets[0] as MockWebSocket
    socket.emit('open')
    await expect(starting).resolves.toMatchObject({ success: true })

    // Another surface changes the UI default while the provider's delayed
    // handshake is pending. The active voice session must remain interpreter.
    state.currentRole = 'teacher'
    socket.emit('message', JSON.stringify({ type: 'session.created' }))
    await vi.advanceTimersByTimeAsync(250)

    expect(state.sessionConfigs).toHaveLength(1)
    expect(state.sessionConfigs[0]).toMatchObject({
      tools: [],
      transcriptionLanguage: null,
      instructions: 'PROMPT:interpreter'
    })
  })
})

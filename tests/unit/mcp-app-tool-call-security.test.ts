import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  isMcpToolFromBoundServer: vi.fn(),
  callMcpToolStructuredFromBoundServer: vi.fn(),
  extractTextFromContentBlocks: vi.fn(),
  classifyToolRisk: vi.fn(),
  requestUserConfirmation: vi.fn()
}))

vi.mock('../../src/main/mcp-manager', () => ({
  isMcpToolFromBoundServer: mocks.isMcpToolFromBoundServer,
  callMcpToolStructuredFromBoundServer: mocks.callMcpToolStructuredFromBoundServer,
  extractTextFromContentBlocks: mocks.extractTextFromContentBlocks
}))

vi.mock('../../src/main/pi-security', () => ({
  classifyToolRisk: mocks.classifyToolRisk,
  requestUserConfirmation: mocks.requestUserConfirmation
}))

const { callMcpToolFromApp } = await import('../../src/main/mcp-app-tool-call')
const SERVER_BINDING = '7de4ca3e-4a80-495d-9774-9c167d22a936'

describe('MCP App reverse tool-call authorization', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.isMcpToolFromBoundServer.mockReturnValue(true)
    mocks.classifyToolRisk.mockReturnValue({ level: 'safe', reason: 'read only' })
    mocks.requestUserConfirmation.mockResolvedValue(false)
    mocks.callMcpToolStructuredFromBoundServer.mockResolvedValue({
      content: [{ type: 'text', text: 'ok' }],
      structuredContent: { value: 1 }
    })
    mocks.extractTextFromContentBlocks.mockReturnValue('ok')
  })

  it('rejects cross-server calls before classification or execution', async () => {
    mocks.isMcpToolFromBoundServer.mockReturnValue(false)

    await expect(callMcpToolFromApp({
      serverName: 'ui-server',
      serverBinding: SERVER_BINDING,
      toolName: 'other_server_tool',
      args: {},
      conversationId: 'conv-1'
    })).resolves.toMatchObject({ ok: false, error: expect.stringContaining('跨 server') })

    expect(mocks.classifyToolRisk).not.toHaveBeenCalled()
    expect(mocks.requestUserConfirmation).not.toHaveBeenCalled()
    expect(mocks.callMcpToolStructuredFromBoundServer).not.toHaveBeenCalled()
  })

  it('hard-rejects risky tools without opening a confirmation path', async () => {
    mocks.classifyToolRisk.mockReturnValue({ level: 'risky', reason: 'blocked path' })

    await expect(callMcpToolFromApp({
      serverName: 'ui-server',
      serverBinding: SERVER_BINDING,
      toolName: 'delete_everything',
      args: { force: true },
      conversationId: 'conv-1'
    })).resolves.toMatchObject({ ok: false, error: expect.stringContaining('安全策略阻止') })

    expect(mocks.requestUserConfirmation).not.toHaveBeenCalled()
    expect(mocks.callMcpToolStructuredFromBoundServer).not.toHaveBeenCalled()
  })

  it('does not execute a needs-confirmation tool when the user denies it', async () => {
    const args = { title: 'draft' }
    mocks.classifyToolRisk.mockReturnValue({ level: 'needs_confirmation', reason: 'writes remote data' })
    mocks.requestUserConfirmation.mockResolvedValue(false)

    await expect(callMcpToolFromApp({
      serverName: 'ui-server',
      serverBinding: SERVER_BINDING,
      toolName: 'create_record',
      args,
      conversationId: 'conv-1'
    })).resolves.toMatchObject({ ok: false, error: expect.stringContaining('用户拒绝') })

    expect(mocks.requestUserConfirmation).toHaveBeenCalledWith(
      'create_record',
      args,
      'writes remote data',
      'conv-1',
      undefined,
      { namespace: `mcp:ui-server:${SERVER_BINDING}`, argumentScoped: true }
    )
    expect(mocks.callMcpToolStructuredFromBoundServer).not.toHaveBeenCalled()
  })

  it('rejects a same-name replacement after asynchronous approval', async () => {
    mocks.classifyToolRisk.mockReturnValue({ level: 'needs_confirmation', reason: 'writes remote data' })
    mocks.requestUserConfirmation.mockResolvedValue(true)
    // Initial membership is valid, then the manager's exact-bound sink cannot
    // find the old connection after it is replaced during confirmation.
    mocks.callMcpToolStructuredFromBoundServer.mockResolvedValueOnce(null)

    await expect(callMcpToolFromApp({
      serverName: 'ui-server',
      serverBinding: SERVER_BINDING,
      toolName: 'create_record',
      args: { title: 'draft' },
      conversationId: 'conv-1'
    })).resolves.toMatchObject({ ok: false, error: expect.stringContaining('不再可用') })

    expect(mocks.callMcpToolStructuredFromBoundServer).toHaveBeenCalledWith(
      SERVER_BINDING,
      'ui-server',
      'create_record',
      { title: 'draft' },
      'conv-1'
    )
  })

  it('executes a needs-confirmation tool only after explicit approval', async () => {
    mocks.classifyToolRisk.mockReturnValue({ level: 'needs_confirmation', reason: 'writes remote data' })
    mocks.requestUserConfirmation.mockResolvedValue(true)

    await expect(callMcpToolFromApp({
      serverName: 'ui-server',
      serverBinding: SERVER_BINDING,
      toolName: 'create_record',
      args: { title: 'approved' },
      conversationId: 'conv-1'
    })).resolves.toEqual({
      ok: true,
      content: [{ type: 'text', text: 'ok' }],
      structuredContent: { value: 1 },
      result: 'ok'
    })

    expect(mocks.requestUserConfirmation).toHaveBeenCalledOnce()
    expect(mocks.callMcpToolStructuredFromBoundServer).toHaveBeenCalledWith(
      SERVER_BINDING,
      'ui-server',
      'create_record',
      { title: 'approved' },
      'conv-1'
    )
  })

  it('preserves streaming poll calls after the canonical confirmation gate', async () => {
    mocks.classifyToolRisk.mockReturnValue({
      level: 'needs_confirmation',
      reason: 'remote MCP tool requires confirmation'
    })
    mocks.requestUserConfirmation.mockResolvedValue(true)

    await expect(callMcpToolFromApp({
      serverName: 'say-server',
      serverBinding: SERVER_BINDING,
      toolName: 'poll_tts_audio',
      args: { queueId: 'queue-1' },
      conversationId: 'conv-voice'
    })).resolves.toMatchObject({ ok: true, result: 'ok' })

    expect(mocks.classifyToolRisk).toHaveBeenCalledWith(
      'poll_tts_audio',
      { queueId: 'queue-1' },
      { origin: 'mcp' }
    )
    expect(mocks.requestUserConfirmation).toHaveBeenCalledWith(
      'poll_tts_audio',
      { queueId: 'queue-1' },
      'remote MCP tool requires confirmation',
      'conv-voice',
      undefined,
      { namespace: `mcp:say-server:${SERVER_BINDING}`, argumentScoped: true }
    )
    expect(mocks.callMcpToolStructuredFromBoundServer).toHaveBeenCalledOnce()
  })

  it('fails closed for historical views that have no connection binding', async () => {
    await expect(callMcpToolFromApp({
      serverName: 'ui-server',
      serverBinding: '',
      toolName: 'read_record',
      args: {},
      conversationId: 'conv-1'
    })).resolves.toMatchObject({ ok: false, error: expect.stringContaining('参数无效') })

    expect(mocks.isMcpToolFromBoundServer).not.toHaveBeenCalled()
    expect(mocks.classifyToolRisk).not.toHaveBeenCalled()
    expect(mocks.callMcpToolStructuredFromBoundServer).not.toHaveBeenCalled()
  })
})

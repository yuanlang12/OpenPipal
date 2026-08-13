import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

const sdk = vi.hoisted(() => ({
  callTool: vi.fn(),
  callServers: [] as string[],
  listTools: vi.fn(),
  readResource: vi.fn(),
  close: vi.fn(async () => undefined)
}))

vi.mock('electron', () => ({
  app: { isPackaged: false }
}))

vi.mock('../../src/main/mcp-oauth', () => ({
  createOAuthProvider: vi.fn(),
  awaitAuthorizationCode: vi.fn(),
  hasPersistedOAuthSession: vi.fn(() => false),
  revokeOAuthSession: vi.fn()
}))

vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: class MockMcpClient {
    private readonly clientName: string

    constructor(options: { name: string }) {
      this.clientName = options.name
    }

    connect = vi.fn(async () => undefined)
    listTools = vi.fn(() => sdk.listTools(this.clientName))
    readResource = vi.fn((request) => sdk.readResource(this.clientName, request))
    callTool = vi.fn((...args) => {
      sdk.callServers.push(this.clientName)
      return sdk.callTool(...args)
    })
    close = sdk.close
  }
}))

vi.mock('@modelcontextprotocol/sdk/client/stdio.js', () => ({
  StdioClientTransport: class MockStdioTransport {}
}))

vi.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => ({
  StreamableHTTPClientTransport: class MockHttpTransport {}
}))

const {
  callMcpTool,
  callMcpToolStructured,
  callMcpToolStructuredFromBoundServer,
  describeMcpTool,
  getMcpTools,
  getMcpToolUi,
  isMcpToolFromBoundServer,
  registerSessionMcpServers,
  resolveMcpToolServerIdentity,
  resolveMcpToolServerName,
  searchMcpTools,
  shutdownMcp
} = await import('../../src/main/mcp-manager')

describe('MCP manager AbortSignal forwarding', () => {
  beforeEach(async () => {
    await shutdownMcp()
    vi.clearAllMocks()
    sdk.callServers.length = 0
    sdk.listTools.mockResolvedValue({
      tools: [{
        name: 'remote_write',
        description: 'writes remote data',
        inputSchema: { type: 'object', properties: {} }
      }]
    })
    sdk.readResource.mockResolvedValue({ contents: [] })
    sdk.callTool.mockResolvedValue({ content: [{ type: 'text', text: 'ok' }] })
    const registration = await registerSessionMcpServers('abort-session', [{
      name: 'test-server',
      config: { url: 'https://mcp.invalid.test' }
    }])
    expect(registration.failed).toEqual([])
  })

  afterAll(async () => {
    await shutdownMcp()
  })

  it('rejects a pre-aborted request without calling the SDK', async () => {
    const controller = new AbortController()
    controller.abort(new DOMException('already stopped', 'AbortError'))

    await expect(callMcpTool(
      'remote_write',
      { value: 'x' },
      'abort-session',
      controller.signal
    )).rejects.toMatchObject({ name: 'AbortError' })

    expect(sdk.callTool).not.toHaveBeenCalled()
  })

  it('passes the signal to an in-flight SDK call and settles on abort', async () => {
    let notifyStarted!: () => void
    const started = new Promise<void>((resolve) => { notifyStarted = resolve })
    sdk.callTool.mockImplementation((_params, _schema, options) => (
      new Promise((_resolve, reject) => {
        notifyStarted()
        const signal = options?.signal as AbortSignal
        const onAbort = (): void => reject(signal.reason)
        if (signal.aborted) onAbort()
        else signal.addEventListener('abort', onAbort, { once: true })
      })
    ))

    const controller = new AbortController()
    const pending = callMcpTool(
      'remote_write',
      { value: 'x' },
      'abort-session',
      controller.signal
    )
    await started
    controller.abort(new DOMException('superseded', 'AbortError'))

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    expect(sdk.callTool).toHaveBeenCalledWith(
      { name: 'remote_write', arguments: { value: 'x' } },
      undefined,
      { signal: controller.signal }
    )
  })

  it('forwards the signal on the structured MCP path too', async () => {
    const controller = new AbortController()
    sdk.callTool.mockResolvedValue({
      content: [{ type: 'text', text: 'ok' }],
      structuredContent: { id: 'result-1' }
    })

    await expect(callMcpToolStructured(
      'remote_write',
      { value: 'x' },
      'abort-session',
      controller.signal
    )).resolves.toEqual({
      content: [{ type: 'text', text: 'ok' }],
      structuredContent: { id: 'result-1' }
    })

    expect(sdk.callTool.mock.calls[0][2]).toEqual({ signal: controller.signal })
  })

  it('re-applies the workspace server scope to search, describe, UI, and calls', async () => {
    await shutdownMcp()
    sdk.callServers.length = 0
    sdk.listTools.mockImplementation(async (clientName: string) => {
      if (clientName.endsWith('-hidden-server')) {
        return { tools: [{
          name: 'hidden_read',
          description: 'must stay hidden',
          inputSchema: { type: 'object', properties: {} }
        }] }
      }
      if (clientName.endsWith('-allowed-server')) {
        return { tools: [{
          name: 'shared_read',
          description: 'allowed duplicate with UI',
          inputSchema: { type: 'object', properties: { source: { type: 'string' } } },
          _meta: { ui: { resourceUri: 'ui://allowed', visibility: ['model'] } }
        }] }
      }
      if (clientName.endsWith('-other-server')) {
        return { tools: [{
          name: 'shared_read',
          description: 'forbidden duplicate',
          inputSchema: { type: 'object', properties: {} }
        }] }
      }
      return { tools: [{
        name: 'app_only',
        description: 'renderer-only tool',
        inputSchema: { type: 'object', properties: {} },
        _meta: { ui: { resourceUri: 'ui://app-only', visibility: ['app'] } }
      }] }
    })
    sdk.readResource.mockImplementation(async (_clientName: string, request: { uri: string }) => ({
      contents: [{ uri: request.uri, mimeType: 'text/html', text: `<p>${request.uri}</p>` }]
    }))
    sdk.callTool.mockResolvedValue({ content: [{ type: 'text', text: 'scoped-ok' }] })

    const registration = await registerSessionMcpServers('scope-session', [
      { name: 'hidden-server', config: { url: 'https://hidden.invalid.test' } },
      { name: 'allowed-server', config: { url: 'https://allowed.invalid.test' } },
      { name: 'other-server', config: { url: 'https://other.invalid.test' } },
      { name: 'app-server', config: { url: 'https://app.invalid.test' } }
    ])
    expect(registration.failed).toEqual([])

    const modelScope = {
      serverFilter: ['allowed-server', 'app-server'],
      modelVisibleOnly: true
    }
    expect(searchMcpTools('', 20, [...modelScope.serverFilter], true, 'scope-session'))
      .toEqual([{ name: 'shared_read', server: 'allowed-server', description: 'allowed duplicate with UI', inputSchema: {} }])
    expect(getMcpTools('scope-session', modelScope).map(tool => tool.name)).toEqual(['shared_read'])
    expect(describeMcpTool('hidden_read', 'scope-session', modelScope)).toBeNull()
    expect(getMcpToolUi('app_only', 'scope-session', modelScope)).toBeNull()

    await expect(callMcpTool('hidden_read', {}, 'scope-session', undefined, modelScope))
      .resolves.toContain('未找到')
    await expect(callMcpTool('app_only', {}, 'scope-session', undefined, modelScope))
      .resolves.toContain('未找到')
    expect(sdk.callTool).not.toHaveBeenCalled()

    const exactScope = { ...modelScope, serverName: 'allowed-server' }
    expect(resolveMcpToolServerName('shared_read', 'scope-session', exactScope)).toBe('allowed-server')
    expect(describeMcpTool('shared_read', 'scope-session', exactScope)).toContain('(allowed-server)')
    expect(getMcpToolUi('shared_read', 'scope-session', exactScope)).toMatchObject({
      serverName: 'allowed-server',
      serverBinding: expect.any(String),
      resourceUri: 'ui://allowed'
    })
    await expect(callMcpTool('shared_read', { source: 'test' }, 'scope-session', undefined, exactScope))
      .resolves.toBe('scoped-ok')
    expect(sdk.callServers.at(-1)).toContain('allowed-server')

    const forbiddenExactScope = { ...modelScope, serverName: 'other-server' }
    expect(resolveMcpToolServerName('hidden_read', 'scope-session', forbiddenExactScope)).toBeNull()
    await expect(callMcpTool('shared_read', {}, 'scope-session', undefined, forbiddenExactScope))
      .resolves.toContain('未找到')
    expect(sdk.callTool).toHaveBeenCalledOnce()
  })

  it('keeps same-name servers isolated by session and invalidates a binding on replacement', async () => {
    await shutdownMcp()
    sdk.callServers.length = 0
    sdk.listTools.mockResolvedValue({
      tools: [{
        name: 'shared_tool',
        description: 'same name in each session',
        inputSchema: { type: 'object', properties: {} },
        _meta: { ui: { resourceUri: 'ui://shared', visibility: ['model'] } }
      }]
    })
    sdk.readResource.mockResolvedValue({
      contents: [{ uri: 'ui://shared', mimeType: 'text/html', text: '<p>shared</p>' }]
    })
    sdk.callTool.mockResolvedValue({ content: [{ type: 'text', text: 'session result' }] })

    await registerSessionMcpServers('session-one', [{
      name: 'same-name',
      config: { url: 'https://one.invalid.test' }
    }])
    await registerSessionMcpServers('session-two', [{
      name: 'same-name',
      config: { url: 'https://two.invalid.test' }
    }])

    const one = resolveMcpToolServerIdentity('shared_tool', 'session-one', { serverName: 'same-name' })!
    const two = resolveMcpToolServerIdentity('shared_tool', 'session-two', { serverName: 'same-name' })!
    expect(one.serverName).toBe(two.serverName)
    expect(one.serverBinding).not.toBe(two.serverBinding)
    expect(isMcpToolFromBoundServer(one.serverBinding, 'same-name', 'shared_tool', 'session-one')).toBe(true)
    expect(isMcpToolFromBoundServer(one.serverBinding, 'same-name', 'shared_tool', 'session-two')).toBe(false)
    await expect(callMcpToolStructuredFromBoundServer(
      one.serverBinding,
      'same-name',
      'shared_tool',
      { source: 'one' },
      'session-one'
    )).resolves.toMatchObject({ content: [{ type: 'text', text: 'session result' }] })
    expect(sdk.callServers.at(-1)).toContain('session-one-same-name')
    const callsAfterBoundCall = sdk.callTool.mock.calls.length
    await expect(callMcpToolStructuredFromBoundServer(
      one.serverBinding,
      'same-name',
      'shared_tool',
      { source: 'wrong-session' },
      'session-two'
    )).resolves.toBeNull()
    expect(sdk.callTool).toHaveBeenCalledTimes(callsAfterBoundCall)

    await registerSessionMcpServers('session-one', [{
      name: 'same-name',
      config: { url: 'https://replacement.invalid.test' }
    }])
    const replacement = resolveMcpToolServerIdentity('shared_tool', 'session-one', { serverName: 'same-name' })!
    expect(replacement.serverBinding).not.toBe(one.serverBinding)
    expect(isMcpToolFromBoundServer(one.serverBinding, 'same-name', 'shared_tool', 'session-one')).toBe(false)
    expect(isMcpToolFromBoundServer(replacement.serverBinding, 'same-name', 'shared_tool', 'session-one')).toBe(true)
    await expect(callMcpToolStructuredFromBoundServer(
      one.serverBinding,
      'same-name',
      'shared_tool',
      { source: 'stale-view' },
      'session-one'
    )).resolves.toBeNull()
  })
})

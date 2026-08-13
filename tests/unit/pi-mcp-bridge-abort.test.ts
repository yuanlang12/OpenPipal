import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SCHEDULER_BLOCKED_TOOL_NAMES } from '../../src/main/agent-runtime/source-tool-policy'

const mocks = vi.hoisted(() => ({
  searchMcpTools: vi.fn(),
  describeMcpTool: vi.fn(),
  callMcpTool: vi.fn(),
  callMcpToolStructured: vi.fn(),
  getMcpTools: vi.fn(),
  getMcpToolUi: vi.fn(),
  resolveMcpToolServerIdentity: vi.fn(),
  executeInQuickJS: vi.fn(),
  requestUserConfirmation: vi.fn(),
  classifyToolRisk: vi.fn()
}))

vi.mock('../../src/main/mcp-manager', () => ({
  searchMcpTools: mocks.searchMcpTools,
  callMcpTool: mocks.callMcpTool,
  callMcpToolStructured: mocks.callMcpToolStructured,
  describeMcpTool: mocks.describeMcpTool,
  isMcpTool: vi.fn(() => true),
  getMcpTools: mocks.getMcpTools,
  getMcpToolUi: mocks.getMcpToolUi,
  resolveMcpToolServerIdentity: mocks.resolveMcpToolServerIdentity,
  extractTextFromContentBlocks: vi.fn(() => '')
}))

vi.mock('../../src/main/pi-security', () => ({
  MCP_PERMISSION_TIMEOUT_MS: 3_600_000,
  classifyToolRisk: mocks.classifyToolRisk,
  requestUserConfirmation: mocks.requestUserConfirmation
}))

vi.mock('../../src/main/quickjs-sandbox', () => ({
  QUICKJS_DEFAULT_CPU_TIMEOUT_MS: 30_000,
  executeInQuickJS: mocks.executeInQuickJS,
  utf8ByteLength(value: string) {
    return Buffer.byteLength(value, 'utf8')
  },
  serializedUtf8ByteLength(value: unknown) {
    const serialized = JSON.stringify(value)
    return Buffer.byteLength(serialized === undefined ? 'null' : serialized, 'utf8')
  },
  truncateUtf8WithMarker(value: string, maxBytes: number, label: string) {
    if (Buffer.byteLength(value, 'utf8') <= maxBytes) return value
    const marker = `\n…[${label} truncated]…`
    const budget = Math.max(0, maxBytes - Buffer.byteLength(marker, 'utf8'))
    let low = 0
    let high = value.length
    while (low < high) {
      const mid = Math.ceil((low + high) / 2)
      if (Buffer.byteLength(value.slice(0, mid), 'utf8') <= budget) low = mid
      else high = mid - 1
    }
    return value.slice(0, low) + marker
  }
}))

const {
  buildMcpBridgeTools,
  MCP_EXECUTION_CPU_TIMEOUT_MS,
  MCP_EXECUTION_WALL_TIMEOUT_MS,
  MCP_FINAL_TOOL_RESULT_MAX_BYTES,
  MCP_APP_HTML_MAX_BYTES,
  MCP_APP_CONTENT_BLOCKS_MAX_BYTES,
  MCP_APP_STRUCTURED_CONTENT_MAX_BYTES,
  MCP_APP_ARGS_MAX_BYTES,
  MCP_APP_METADATA_MAX_BYTES,
  MCP_APP_INLINE_MAX_BYTES
} = await import('../../src/main/pi-mcp-bridge')

const UI_SERVER_BINDING = 'd3b66db8-324f-4b96-a871-cb463697d495'
const TEST_SERVER_BINDING = '0d6bf327-17c2-4a70-a9de-52c92a0c0b2c'

describe('mcp_execute cancellation propagation', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.searchMcpTools.mockReturnValue([])
    mocks.describeMcpTool.mockReturnValue('schema')
    mocks.callMcpTool.mockResolvedValue('ok')
    mocks.getMcpTools.mockReturnValue([{ name: 'remote_write', description: 'write', parameters: {} }])
    mocks.getMcpToolUi.mockReturnValue(null)
    mocks.resolveMcpToolServerIdentity.mockImplementation((_toolName, _conversationId, scope) => ({
      serverName: scope?.serverName || 'test-server',
      serverBinding: scope?.serverBinding || TEST_SERVER_BINDING,
    }))
    mocks.requestUserConfirmation.mockResolvedValue(true)
    mocks.classifyToolRisk.mockReturnValue({ level: 'needs_confirmation', reason: 'writes remote data' })
    mocks.executeInQuickJS.mockImplementation(async (_code, toolsApi, options) => {
      const value = await toolsApi.call('remote_write', { value: 'x' })
      return { logs: [value], elapsedMs: 1, signal: options?.signal }
    })
  })

  it('uses one linked signal for permission, QuickJS, and the MCP SDK bridge', async () => {
    const controller = new AbortController()
    const tool = buildMcpBridgeTools(undefined, 'mcp-abort-conversation')[0]
    expect(tool.executionMode).toBe('sequential')

    await tool.execute('call-1', { code: 'tools.call("remote_write", {})' }, controller.signal)

    const operationSignal = mocks.executeInQuickJS.mock.calls[0][2].signal as AbortSignal
    expect(operationSignal).not.toBe(controller.signal)
    expect(operationSignal.aborted).toBe(false)
    expect(mocks.requestUserConfirmation.mock.calls[0][4]).toBe(operationSignal)
    expect(mocks.requestUserConfirmation.mock.calls[0][5]).toEqual({
      namespace: `mcp:test-server:${TEST_SERVER_BINDING}`,
      argumentScoped: true
    })
    expect(mocks.callMcpTool).toHaveBeenCalledWith(
      'remote_write',
      { value: 'x' },
      'mcp-abort-conversation',
      operationSignal,
      { serverFilter: undefined, serverName: 'test-server', serverBinding: TEST_SERVER_BINDING, modelVisibleOnly: true }
    )
    expect(mocks.executeInQuickJS.mock.calls[0][2]).toMatchObject({
      timeoutMs: MCP_EXECUTION_CPU_TIMEOUT_MS,
      wallTimeoutMs: MCP_EXECUTION_WALL_TIMEOUT_MS
    })
    expect(MCP_EXECUTION_WALL_TIMEOUT_MS).toBeGreaterThan(3_600_000)
  })

  it('rechecks cancellation after approval and never starts the remote side effect', async () => {
    const controller = new AbortController()
    mocks.requestUserConfirmation.mockImplementation(async () => {
      controller.abort(new DOMException('superseded', 'AbortError'))
      return true
    })
    const tool = buildMcpBridgeTools(undefined, 'mcp-race-conversation')[0]

    await expect(tool.execute(
      'call-2',
      { code: 'tools.call("remote_write", {})' },
      controller.signal
    )).rejects.toMatchObject({ name: 'AbortError' })

    expect(mocks.callMcpTool).not.toHaveBeenCalled()
  })

  it('rejects a same-name connection replacement during confirmation', async () => {
    mocks.resolveMcpToolServerIdentity
      .mockReturnValueOnce({ serverName: 'test-server', serverBinding: TEST_SERVER_BINDING })
      .mockReturnValueOnce(null)
    const tool = buildMcpBridgeTools(undefined, 'mcp-replaced-conversation')[0]

    await expect(tool.execute(
      'call-replaced',
      { code: 'tools.call("remote_write", {})' },
      new AbortController().signal
    )).rejects.toThrow('确认后不再可用')

    expect(mocks.requestUserConfirmation).toHaveBeenCalledWith(
      'remote_write',
      { value: 'x' },
      'writes remote data',
      'mcp-replaced-conversation',
      expect.any(AbortSignal),
      { namespace: `mcp:test-server:${TEST_SERVER_BINDING}`, argumentScoped: true }
    )
    expect(mocks.getMcpToolUi).not.toHaveBeenCalled()
    expect(mocks.callMcpTool).not.toHaveBeenCalled()
    expect(mocks.callMcpToolStructured).not.toHaveBeenCalled()
  })

  it('fails before starting QuickJS when the Agent signal is already aborted', async () => {
    const controller = new AbortController()
    controller.abort(new DOMException('already stopped', 'AbortError'))
    const tool = buildMcpBridgeTools(undefined, 'mcp-pre-abort-conversation')[0]

    await expect(tool.execute(
      'call-3',
      { code: 'tools.call("remote_write", {})' },
      controller.signal
    )).rejects.toMatchObject({ name: 'AbortError' })

    expect(mocks.executeInQuickJS).not.toHaveBeenCalled()
    expect(mocks.requestUserConfirmation).not.toHaveBeenCalled()
    expect(mocks.callMcpTool).not.toHaveBeenCalled()
  })

  it('carries the search result server through describe, UI lookup, and exact call resolution', async () => {
    mocks.getMcpToolUi.mockReturnValue({
      serverName: 'allowed-server',
      serverBinding: UI_SERVER_BINDING,
      toolName: 'shared_read',
      resourceUri: 'ui://allowed',
      html: '<p>allowed</p>'
    })
    mocks.callMcpToolStructured.mockResolvedValue({
      content: [{ type: 'text', text: 'from allowed' }],
      structuredContent: { source: 'allowed-server' }
    })
    mocks.executeInQuickJS.mockImplementation(async (_code, toolsApi) => {
      const schema = await toolsApi.describe('shared_read', 'allowed-server')
      const value = await toolsApi.call('shared_read', { id: '1' }, 'allowed-server')
      return { logs: [schema, value], elapsedMs: 2 }
    })

    const tool = buildMcpBridgeTools(['allowed-server'], 'exact-server-conversation')[0]
    await tool.execute('call-exact', { code: 'exact server' }, new AbortController().signal)

    const scope = {
      serverFilter: ['allowed-server'],
      serverName: 'allowed-server',
      serverBinding: TEST_SERVER_BINDING,
      modelVisibleOnly: true
    }
    expect(mocks.describeMcpTool).toHaveBeenCalledWith(
      'shared_read',
      'exact-server-conversation',
      scope
    )
    expect(mocks.getMcpToolUi).toHaveBeenCalledWith(
      'shared_read',
      'exact-server-conversation',
      scope
    )
    expect(mocks.callMcpToolStructured).toHaveBeenCalledWith(
      'shared_read',
      { id: '1' },
      'exact-server-conversation',
      expect.any(AbortSignal),
      scope
    )
    expect(mocks.callMcpTool).not.toHaveBeenCalled()
  })

  it('applies workspace visibility before registering the gateway', () => {
    mocks.getMcpTools.mockReturnValue([])

    expect(buildMcpBridgeTools(['allowed-server'], 'filtered-conversation')).toEqual([])
    expect(mocks.getMcpTools).toHaveBeenCalledWith('filtered-conversation', {
      serverFilter: ['allowed-server'],
      modelVisibleOnly: true
    })
  })

  it('rejects a hidden or app-only known name before asking for permission', async () => {
    mocks.describeMcpTool.mockReturnValue(null)
    mocks.executeInQuickJS.mockImplementation(async (_code, toolsApi) => {
      await toolsApi.call('hidden_write', {}, 'hidden-server')
      return { logs: [], elapsedMs: 1 }
    })
    const tool = buildMcpBridgeTools(['allowed-server'], 'hidden-direct-conversation')[0]

    await expect(tool.execute(
      'call-hidden',
      { code: 'tools.call("hidden_write", {}, "hidden-server")' },
      new AbortController().signal
    )).rejects.toThrow('不存在或不允许')

    expect(mocks.requestUserConfirmation).not.toHaveBeenCalled()
    expect(mocks.getMcpToolUi).not.toHaveBeenCalled()
    expect(mocks.callMcpTool).not.toHaveBeenCalled()
    expect(mocks.callMcpToolStructured).not.toHaveBeenCalled()
  })

  describe('scheduler source policy inside the production MCP gateway', () => {
    const blockedNames = [
      ...SCHEDULER_BLOCKED_TOOL_NAMES,
      'browser_navigate',
      'browser_future_mcp_collision'
    ]

    it('hides every interactive and browser namespace tool from tools.search', async () => {
      mocks.searchMcpTools.mockReturnValue([
        ...blockedNames.map(name => ({ name, server: 'remote', description: name })),
        { name: 'safe_remote_read', server: 'remote', description: 'safe' }
      ])
      let discovered: Array<{ name: string }> = []
      mocks.executeInQuickJS.mockImplementation(async (_code, toolsApi) => {
        discovered = await toolsApi.search('', 50)
        return { logs: [JSON.stringify(discovered)], elapsedMs: 1 }
      })

      const tool = buildMcpBridgeTools(undefined, 'scheduler-search', 'scheduler')[0]
      await tool.execute('call-search', { code: 'tools.search("")' }, new AbortController().signal)

      expect(discovered.map(tool => tool.name)).toEqual(['safe_remote_read'])
      expect(mocks.searchMcpTools).toHaveBeenCalledWith(
        '',
        50,
        undefined,
        true,
        'scheduler-search'
      )
    })

    it('makes blocked tools undiscoverable through direct tools.describe', async () => {
      const descriptions = new Map<string, string>()
      mocks.executeInQuickJS.mockImplementation(async (_code, toolsApi) => {
        for (const name of blockedNames) {
          descriptions.set(name, await toolsApi.describe(name, 'remote'))
        }
        descriptions.set('safe_remote_read', await toolsApi.describe('safe_remote_read', 'remote'))
        return { logs: [...descriptions.values()], elapsedMs: 1 }
      })

      const tool = buildMcpBridgeTools(undefined, 'scheduler-describe', 'scheduler')[0]
      await tool.execute('call-describe', { code: 'tools.describe("...")' }, new AbortController().signal)

      for (const name of blockedNames) {
        expect(descriptions.get(name)).toContain('不允许在后台调度任务中使用')
      }
      expect(descriptions.get('safe_remote_read')).toBe('schema')
      expect(mocks.describeMcpTool).toHaveBeenCalledTimes(1)
      expect(mocks.describeMcpTool).toHaveBeenCalledWith(
        'safe_remote_read',
        'scheduler-describe',
        { serverFilter: undefined, serverName: 'remote', modelVisibleOnly: true }
      )
    })

    it('rejects direct blocked calls before risk, permission, UI, or MCP execution', async () => {
      const errors = new Map<string, string>()
      mocks.executeInQuickJS.mockImplementation(async (_code, toolsApi) => {
        for (const name of blockedNames) {
          try {
            await toolsApi.call(name, {}, 'remote')
          } catch (error) {
            errors.set(name, (error as Error).message)
          }
        }
        return { logs: [...errors.values()], elapsedMs: 1 }
      })

      const tool = buildMcpBridgeTools(undefined, 'scheduler-call-blocked', 'scheduler')[0]
      await tool.execute('call-blocked', { code: 'tools.call("...")' }, new AbortController().signal)

      for (const name of blockedNames) {
        expect(errors.get(name)).toContain('不允许在后台调度任务中使用')
      }
      expect(mocks.describeMcpTool).not.toHaveBeenCalled()
      expect(mocks.classifyToolRisk).not.toHaveBeenCalled()
      expect(mocks.requestUserConfirmation).not.toHaveBeenCalled()
      expect(mocks.getMcpToolUi).not.toHaveBeenCalled()
      expect(mocks.callMcpTool).not.toHaveBeenCalled()
      expect(mocks.callMcpToolStructured).not.toHaveBeenCalled()
    })

    it('keeps a safe MCP tool callable for scheduler turns', async () => {
      mocks.classifyToolRisk.mockReturnValue({ level: 'safe', reason: 'read only' })
      mocks.callMcpTool.mockResolvedValue('safe result')
      mocks.executeInQuickJS.mockImplementation(async (_code, toolsApi) => {
        const value = await toolsApi.call('safe_remote_read', { id: '1' }, 'remote')
        return { logs: [value], elapsedMs: 1 }
      })

      const tool = buildMcpBridgeTools(undefined, 'scheduler-call-safe', 'scheduler')[0]
      const result = await tool.execute('call-safe', { code: 'tools.call("safe")' }, new AbortController().signal)

      expect((result.content[0] as { text: string }).text).toBe('safe result')
      expect(mocks.classifyToolRisk).toHaveBeenCalledWith(
        'safe_remote_read',
        { id: '1' },
        { origin: 'mcp' }
      )
      expect(mocks.requestUserConfirmation).not.toHaveBeenCalled()
      expect(mocks.callMcpTool).toHaveBeenCalledWith(
        'safe_remote_read',
        { id: '1' },
        'scheduler-call-safe',
        expect.any(AbortSignal),
        { serverFilter: undefined, serverName: 'remote', serverBinding: TEST_SERVER_BINDING, modelVisibleOnly: true }
      )
    })

    it('does not apply scheduler-only blocking to interactive sources', async () => {
      mocks.classifyToolRisk.mockReturnValue({ level: 'safe', reason: 'interactive source' })
      mocks.callMcpTool.mockResolvedValue('interactive result')
      mocks.executeInQuickJS.mockImplementation(async (_code, toolsApi) => {
        const value = await toolsApi.call('browser_navigate', { url: 'https://example.test' }, 'remote')
        return { logs: [value], elapsedMs: 1 }
      })

      const tool = buildMcpBridgeTools(undefined, 'desktop-call', 'desktop')[0]
      const result = await tool.execute('call-desktop', { code: 'tools.call("browser_navigate")' }, new AbortController().signal)

      expect((result.content[0] as { text: string }).text).toBe('interactive result')
      expect(mocks.callMcpTool).toHaveBeenCalledOnce()
    })
  })

  it('caps the final tool content and mirrored display result in UTF-8 bytes', async () => {
    mocks.executeInQuickJS.mockResolvedValue({
      logs: ['界'.repeat(MCP_FINAL_TOOL_RESULT_MAX_BYTES)],
      elapsedMs: 1
    })
    const tool = buildMcpBridgeTools(undefined, 'large-result-conversation')[0]

    const result = await tool.execute('call-large', { code: 'large' }, new AbortController().signal)
    const contentText = (result.content[0] as { text: string }).text

    expect(Buffer.byteLength(contentText, 'utf8')).toBeLessThanOrEqual(MCP_FINAL_TOOL_RESULT_MAX_BYTES)
    expect(contentText).toContain('MCP final tool result truncated')
    expect(Buffer.byteLength(result.details.displayResult, 'utf8')).toBeLessThanOrEqual(MCP_FINAL_TOOL_RESULT_MAX_BYTES)
    expect(result.details.displayResult).toContain('MCP final display result truncated')
  })

  it('omits oversized MCP App HTML and gives the model an explicit text downgrade', async () => {
    mocks.getMcpToolUi.mockReturnValue({
      serverName: 'allowed-server',
      serverBinding: UI_SERVER_BINDING,
      toolName: 'ui_read',
      resourceUri: 'ui://oversized-html',
      html: '界'.repeat(MCP_APP_HTML_MAX_BYTES)
    })
    mocks.callMcpTool.mockResolvedValue('text fallback')
    mocks.executeInQuickJS.mockImplementation(async (_code, toolsApi) => {
      const value = await toolsApi.call('ui_read', {}, 'allowed-server')
      return { logs: [value], elapsedMs: 1 }
    })
    const tool = buildMcpBridgeTools(['allowed-server'], 'oversized-html-conversation')[0]

    const result = await tool.execute('call-ui-html', { code: 'ui html' }, new AbortController().signal)
    const contentText = (result.content[0] as { text: string }).text

    expect(contentText).toContain('text fallback')
    expect(contentText).toContain('MCP App UI 已降级为文本')
    expect(contentText).toContain('HTML 超过')
    expect(result.details.mcpAppInline).toBeUndefined()
    expect(mocks.callMcpToolStructured).not.toHaveBeenCalled()
    expect(mocks.callMcpTool).toHaveBeenCalledOnce()
  })

  it('keeps oversized MCP App fields structurally valid and bounds the complete inline payload', async () => {
    mocks.getMcpToolUi.mockReturnValue({
      serverName: 'allowed-server',
      serverBinding: UI_SERVER_BINDING,
      toolName: 'ui_read',
      resourceUri: 'ui://bounded-payload',
      html: '<p>bounded app</p>',
      permissions: ['p'.repeat(MCP_APP_METADATA_MAX_BYTES)],
      csp: { connectDomains: ['c'.repeat(MCP_APP_METADATA_MAX_BYTES)] }
    })
    mocks.callMcpToolStructured.mockResolvedValue({
      content: [{ type: 'text', text: '界'.repeat(MCP_APP_CONTENT_BLOCKS_MAX_BYTES) }],
      structuredContent: { data: 's'.repeat(MCP_APP_STRUCTURED_CONTENT_MAX_BYTES) }
    })
    const oversizedArgs = { value: 'a'.repeat(MCP_APP_ARGS_MAX_BYTES) }
    mocks.executeInQuickJS.mockImplementation(async (_code, toolsApi) => {
      const value = await toolsApi.call('ui_read', oversizedArgs, 'allowed-server')
      return { logs: [value], elapsedMs: 1 }
    })
    const tool = buildMcpBridgeTools(['allowed-server'], 'oversized-payload-conversation')[0]

    const result = await tool.execute('call-ui-payload', { code: 'ui payload' }, new AbortController().signal)
    const inline = result.details.mcpAppInline
    const contentText = (result.content[0] as { text: string }).text

    expect(inline).toBeDefined()
    expect(inline.conversationId).toBe('oversized-payload-conversation')
    expect(inline.serverBinding).toBe(UI_SERVER_BINDING)
    expect(inline.args._openpipalTruncated).toMatchObject({ field: 'args' })
    expect(inline.contentBlocks).toHaveLength(1)
    expect(inline.contentBlocks[0]).toMatchObject({
      type: 'text',
      _meta: { field: 'contentBlocks' }
    })
    expect(inline.structuredContent._openpipalTruncated).toMatchObject({ field: 'structuredContent' })
    expect(inline.permissions[0]).toContain('oversized MCP App permissions')
    expect(inline.csp._openpipalTruncated).toMatchObject({ field: 'permissions/csp' })
    expect(Buffer.byteLength(JSON.stringify(inline), 'utf8')).toBeLessThanOrEqual(MCP_APP_INLINE_MAX_BYTES)
    expect(contentText).toContain('MCP App 内联数据已限流')
    expect(contentText).toContain('已替换为合法占位')
  })

  it('drops an individually valid UI payload when serialized fields exceed the aggregate cap', async () => {
    mocks.getMcpToolUi.mockReturnValue({
      serverName: 'allowed-server',
      serverBinding: UI_SERVER_BINDING,
      toolName: 'ui_read',
      resourceUri: 'ui://aggregate-limit',
      // Backslashes stay below the raw HTML cap but double in JSON encoding.
      html: '\\'.repeat(MCP_APP_HTML_MAX_BYTES - 1),
      permissions: ['p'.repeat(MCP_APP_METADATA_MAX_BYTES - 1_000)],
      csp: null
    })
    mocks.callMcpToolStructured.mockResolvedValue({
      content: [{ type: 'text', text: 'c'.repeat(MCP_APP_CONTENT_BLOCKS_MAX_BYTES - 1_000) }],
      structuredContent: { data: 's'.repeat(MCP_APP_STRUCTURED_CONTENT_MAX_BYTES - 1_000) }
    })
    const nearLimitArgs = { value: 'a'.repeat(MCP_APP_ARGS_MAX_BYTES - 1_000) }
    mocks.executeInQuickJS.mockImplementation(async (_code, toolsApi) => {
      const value = await toolsApi.call('ui_read', nearLimitArgs, 'allowed-server')
      return { logs: [value], elapsedMs: 1 }
    })
    const tool = buildMcpBridgeTools(['allowed-server'], 'aggregate-limit-conversation')[0]

    const result = await tool.execute('call-ui-total', { code: 'ui total' }, new AbortController().signal)
    const contentText = (result.content[0] as { text: string }).text

    expect(result.details.mcpAppInline).toBeUndefined()
    expect(contentText).toContain('MCP App UI 已降级为文本')
    expect(contentText).toContain('完整内联载荷')
    expect(contentText).toContain(`${MCP_APP_INLINE_MAX_BYTES} bytes 总上限`)
  })
})

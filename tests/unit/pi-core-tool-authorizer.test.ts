import {
  Agent,
  type AfterToolCallContext,
  type AgentTool,
  type BeforeToolCallContext
} from '@earendil-works/pi-agent-core'
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall
} from '@earendil-works/pi-ai'
import { Type } from 'typebox'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const security = vi.hoisted(() => ({ authorizeToolCall: vi.fn() }))
vi.mock('../../src/main/pi-security', () => ({ authorizeToolCall: security.authorizeToolCall }))

import {
  bindHarnessToolContext,
  buildPiCoreAfterToolCallPatch,
  PiCoreToolAuthorizer,
  toSequentialHarnessTool
} from '../../src/main/agent-runtime/pi-core-tool-adapter'

function beforeToolContext(toolName: string, args: unknown): BeforeToolCallContext {
  return {
    assistantMessage: {},
    toolCall: { id: `call-${toolName}`, name: toolName, arguments: args },
    args,
    context: { systemPrompt: '', messages: [], tools: [] }
  } as unknown as BeforeToolCallContext
}

describe('pi-core Agent authorization signal bridge', () => {
  beforeEach(() => {
    security.authorizeToolCall.mockReset()
    security.authorizeToolCall.mockResolvedValue(undefined)
  })

  it('fails closed without a live hook signal and passes validated args with the exact signal', async () => {
    const authorizer = new PiCoreToolAuthorizer({ conversationId: 'conv' })
    const context = beforeToolContext('read', { path: '/tmp/a' })
    await expect(authorizer.authorize(context)).resolves.toMatchObject({ block: true })

    const aborted = new AbortController()
    aborted.abort()
    await expect(authorizer.authorize(context, aborted.signal)).resolves.toMatchObject({ block: true })

    await expect(authorizer.authorize(beforeToolContext('read', 'not-an-object'), new AbortController().signal))
      .resolves.toMatchObject({ block: true })

    const live = new AbortController()
    await authorizer.authorize(context, live.signal)

    expect(security.authorizeToolCall).toHaveBeenCalledWith(
      'read',
      { path: '/tmp/a' },
      { conversationId: 'conv' },
      live.signal
    )
    expect(security.authorizeToolCall).toHaveBeenCalledTimes(1)
  })

  it('converts an authorization exception into a blocked decision', async () => {
    security.authorizeToolCall.mockRejectedValueOnce(new Error('authorization backend unavailable'))
    const authorizer = new PiCoreToolAuthorizer({})

    await expect(authorizer.authorize(
      beforeToolContext('read', { path: '/tmp/a' }),
      new AbortController().signal
    )).resolves.toMatchObject({ block: true })
  })

  it('maps OpenPipal interaction and error details into Agent afterToolCall patches', () => {
    expect(buildPiCoreAfterToolCallPatch({
      result: { details: { askUser: true, error: 'failed' } }
    } as unknown as AfterToolCallContext)).toEqual({ terminate: true, isError: true })
    expect(buildPiCoreAfterToolCallPatch({
      result: { details: { subagent: { status: 'error' } } }
    } as unknown as AfterToolCallContext)).toEqual({ isError: true })
    expect(buildPiCoreAfterToolCallPatch({
      result: { details: {} }
    } as unknown as AfterToolCallContext)).toBeUndefined()
  })

  it('releases a permission wait on Agent abort and never executes the tool', async () => {
    let executed = false
    security.authorizeToolCall.mockImplementation((_name, _input, _options, signal: AbortSignal) =>
      new Promise((resolve) => {
        if (signal.aborted) resolve({ block: true, reason: 'aborted' })
        else signal.addEventListener('abort', () => resolve({ block: true, reason: 'aborted' }), { once: true })
      })
    )
    const tool: AgentTool = {
      name: 'danger',
      label: 'danger',
      description: 'danger',
      parameters: Type.Object({}),
      async execute() {
        executed = true
        return { content: [{ type: 'text', text: 'bad' }], details: {} }
      }
    }
    const faux = fauxProvider()
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall('danger', {}, { id: 'call-danger' }), { stopReason: 'toolUse' })
    ])
    const models = createModels()
    models.setProvider(faux.provider)
    const authorizer = new PiCoreToolAuthorizer({})
    const agent = new Agent({
      initialState: {
        model: faux.getModel(),
        tools: [bindHarnessToolContext(toSequentialHarnessTool(tool), undefined)],
        systemPrompt: 'test',
        messages: []
      },
      streamFn: models.streamSimple.bind(models),
      beforeToolCall: (context, signal) => authorizer.authorize(context, signal)
    })

    const run = agent.prompt('run danger')
    for (let attempt = 0; attempt < 50 && security.authorizeToolCall.mock.calls.length === 0; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 2))
    }
    expect(security.authorizeToolCall).toHaveBeenCalledTimes(1)

    agent.abort()
    await run
    expect(executed).toBe(false)
  })

  it('allows a safe call exactly once between Agent start and execution', async () => {
    const order: string[] = []
    security.authorizeToolCall.mockImplementation(async () => {
      order.push('authorize')
      return undefined
    })
    const tool: AgentTool = {
      name: 'read',
      label: 'read',
      description: 'read',
      parameters: Type.Object({}),
      async execute() {
        order.push('execute')
        return { content: [{ type: 'text', text: 'ok' }], details: {} }
      }
    }
    const faux = fauxProvider()
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall('read', {}, { id: 'call-safe' }), { stopReason: 'toolUse' }),
      fauxAssistantMessage('done')
    ])
    const models = createModels()
    models.setProvider(faux.provider)
    const authorizer = new PiCoreToolAuthorizer({})
    const agent = new Agent({
      initialState: {
        model: faux.getModel(),
        tools: [bindHarnessToolContext(toSequentialHarnessTool(tool), undefined)],
        systemPrompt: 'test',
        messages: []
      },
      streamFn: models.streamSimple.bind(models),
      beforeToolCall: (context, signal) => authorizer.authorize(context, signal)
    })
    agent.subscribe((event) => {
      if (event.type === 'tool_execution_start') order.push('start')
      if (event.type === 'tool_execution_end') order.push('end')
    })

    await agent.prompt('read')

    expect(order).toEqual(['start', 'authorize', 'execute', 'end'])
    expect(security.authorizeToolCall).toHaveBeenCalledTimes(1)
  })
})

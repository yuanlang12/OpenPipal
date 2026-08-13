import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  Agent,
  type AgentHarnessTool,
  type AgentTool
} from '@earendil-works/pi-agent-core'
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall
} from '@earendil-works/pi-ai'
import { Type } from 'typebox'
import { describe, expect, it } from 'vitest'
import {
  bindHarnessToolContext,
  toSequentialHarnessTool
} from '../../src/main/agent-runtime/pi-core-tool-adapter'
import { buildPiCoreExecutionTools } from '../../src/main/agent-runtime/pi-core-execution-tools'

describe('pi-core Agent tool bridge', () => {
  it('binds the exact Harness context and forwards the Agent run signal', async () => {
    const context = { marker: 'bound-context' }
    const controller = new AbortController()
    let observedContext: typeof context | undefined
    let observedSignal: AbortSignal | undefined
    const tool: AgentHarnessTool<typeof context> = {
      name: 'context_probe',
      label: 'context probe',
      description: 'context probe',
      parameters: Type.Object({ value: Type.String() }),
      async execute(_toolCallId, params, signal, _onUpdate, toolContext) {
        observedContext = toolContext
        observedSignal = signal
        return { content: [{ type: 'text', text: params.value }], details: {} }
      }
    }

    const bound = bindHarnessToolContext(tool, context)
    const result = await bound.execute(
      'call-context',
      { value: 'ok' },
      controller.signal
    )

    expect(bound.executionMode).toBe('sequential')
    expect(observedContext).toBe(context)
    expect(observedSignal).toBe(controller.signal)
    expect((result.content[0] as { text?: string }).text).toBe('ok')
  })

  it('marks every adapted tool sequential and prevents overlapping Agent execution', async () => {
    let active = 0
    let maxActive = 0
    const order: string[] = []
    const makeTool = (name: string): AgentTool => ({
      name,
      label: name,
      description: name,
      parameters: Type.Object({}),
      async execute() {
        active += 1
        maxActive = Math.max(maxActive, active)
        order.push(`${name}:start`)
        await new Promise((resolve) => setTimeout(resolve, 10))
        order.push(`${name}:end`)
        active -= 1
        return { content: [{ type: 'text', text: name }], details: {} }
      }
    })
    const tools = [
      bindHarnessToolContext(toSequentialHarnessTool(makeTool('a')), undefined),
      bindHarnessToolContext(toSequentialHarnessTool(makeTool('b')), undefined)
    ]
    expect(tools.every((tool) => tool.executionMode === 'sequential')).toBe(true)

    const faux = fauxProvider()
    faux.setResponses([
      fauxAssistantMessage([
        fauxToolCall('a', {}, { id: 'call-a' }),
        fauxToolCall('b', {}, { id: 'call-b' })
      ], { stopReason: 'toolUse' }),
      fauxAssistantMessage('done')
    ])
    const models = createModels()
    models.setProvider(faux.provider)
    const agent = new Agent({
      initialState: {
        model: faux.getModel(),
        tools,
        systemPrompt: 'test',
        messages: []
      },
      streamFn: models.streamSimple.bind(models)
    })

    await agent.prompt('run both')
    expect(maxActive).toBe(1)
    expect(order).toEqual(['a:start', 'a:end', 'b:start', 'b:end'])
  })

  it('composes only public execution tools, binds cwd, and scrubs credentials', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'openpipal-pi-core-tools-'))
    const previous = process.env.OPENPIPAL_PHASE5_TOKEN
    process.env.OPENPIPAL_PHASE5_TOKEN = 'must-not-leak'
    const bundle = buildPiCoreExecutionTools(cwd)
    try {
      expect(bundle.tools.map((tool) => tool.name)).toEqual([
        'read', 'bash', 'edit', 'write', 'grep', 'find', 'ls'
      ])
      expect(bundle.tools.every((tool) => tool.executionMode === 'sequential')).toBe(true)

      const byName = new Map(bundle.tools.map((tool) => [tool.name, tool]))
      await byName.get('write')!.execute(
        'write-1',
        { path: 'note.txt', content: 'hello\nworld' },
        undefined,
        undefined,
        bundle.toolContext
      )
      await byName.get('edit')!.execute(
        'edit-1',
        { path: 'note.txt', edits: [{ oldText: 'world', newText: 'core' }] },
        undefined,
        undefined,
        bundle.toolContext
      )
      const read = await byName.get('read')!.execute(
        'read-1',
        { path: 'note.txt' },
        undefined,
        undefined,
        bundle.toolContext
      )
      expect((read.content[0] as { text?: string }).text).toBe('hello\ncore')

      const bash = await byName.get('bash')!.execute(
        'bash-1',
        { command: 'printf %s "$OPENPIPAL_PHASE5_TOKEN"' },
        undefined,
        undefined,
        bundle.toolContext
      )
      expect((bash.content[0] as { text?: string }).text).toBe('(no output)')
    } finally {
      await bundle.dispose()
      if (previous === undefined) delete process.env.OPENPIPAL_PHASE5_TOKEN
      else process.env.OPENPIPAL_PHASE5_TOKEN = previous
      fs.rmSync(cwd, { recursive: true, force: true })
    }
  })
})

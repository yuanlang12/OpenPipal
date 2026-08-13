import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SCHEDULER_BLOCKED_TOOL_NAMES } from '../../src/main/agent-runtime/source-tool-policy'

const state = vi.hoisted(() => ({
  productTools: [] as Array<{ name: string }>,
  executionTools: [] as Array<{ name: string }>,
  mcpBuildCalls: [] as Array<{ serverFilter: unknown; conversationId?: string; source?: string }>
}))

vi.mock('../../src/main/openpipal-product-tools', () => ({
  AskUserResolver: class AskUserResolver {},
  buildOpenPipalProductTools: () => state.productTools,
  filterOpenPipalTools: (tools: Array<{ name: string }>) => tools
}))

vi.mock('../../src/main/pi-mcp-bridge', () => ({
  buildMcpBridgeTools: (serverFilter: unknown, conversationId?: string, source?: string) => {
    state.mcpBuildCalls.push({ serverFilter, conversationId, source })
    // Production exposes one gateway; real MCP names are filtered inside it.
    return [{ name: 'mcp_execute' }]
  }
}))

vi.mock('../../src/main/agent-runtime/pi-core-execution-tools', () => ({
  buildPiCoreExecutionTools: () => ({
    tools: state.executionTools,
    toolContext: {},
    executeCode: vi.fn(),
    dispose: vi.fn()
  })
}))

vi.mock('../../src/main/agent-runtime/pi-core-tool-adapter', () => ({
  toSequentialHarnessTool: (tool: { name: string }) => ({ ...tool, executionMode: 'sequential' }),
  bindHarnessToolsContext: (tools: Array<{ name: string }>) => (
    tools.map(tool => ({ ...tool, executionMode: 'sequential' }))
  )
}))

import {
  buildPiCoreAgentTools,
  buildPiCoreHarnessTools
} from '../../src/main/agent-runtime/pi-core-tool-bridge'

describe('scheduler pi-core tool surface', () => {
  beforeEach(() => {
    state.mcpBuildCalls = []
    state.productTools = [
      ...SCHEDULER_BLOCKED_TOOL_NAMES.map(name => ({ name })),
      { name: 'browser_click' },
      { name: 'create_artifact' }
    ]
    state.executionTools = [{ name: 'read' }, { name: 'browser_fill' }]
  })

  it('applies scheduler policy and passes the source into the real MCP gateway build', () => {
    const bundle = buildPiCoreHarnessTools({
      source: 'scheduler',
      workingDir: '/tmp',
      mcpServers: ['remote'],
      overrides: { systemPrompt: '', conversationId: 'conversation-1' }
    })

    expect(bundle.tools.map(tool => tool.name)).toEqual(['create_artifact', 'read', 'mcp_execute'])
    expect(state.mcpBuildCalls).toEqual([{
      serverFilter: ['remote'],
      conversationId: 'conversation-1',
      source: 'scheduler'
    }])
  })

  it('keeps product, execution, and MCP tools in the Agent-ready sequential bundle', () => {
    const bundle = buildPiCoreAgentTools({
      source: 'scheduler',
      workingDir: '/tmp',
      mcpServers: ['remote'],
      overrides: { systemPrompt: '', conversationId: 'conversation-1' }
    })

    expect(bundle.tools.map(tool => tool.name)).toEqual(['create_artifact', 'read', 'mcp_execute'])
    expect(bundle.tools.every(tool => tool.executionMode === 'sequential')).toBe(true)
  })
})

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SCHEDULER_BLOCKED_TOOL_NAMES } from '../../src/main/agent-runtime/source-tool-policy'

const state = vi.hoisted(() => ({
  productTools: [] as Array<{ name: string }>,
  codingTools: [] as Array<{ name: string }>,
  discoveryTools: [] as Array<{ name: string }>
}))

vi.mock('../../src/main/config-manager', () => ({
  getWorkingDir: () => '/tmp'
}))

vi.mock('../../src/main/openpipal-product-tools', () => ({
  AskUserResolver: class AskUserResolver {},
  buildOpenPipalProductTools: () => state.productTools,
  filterOpenPipalTools: (tools: Array<{ name: string }>) => tools
}))

vi.mock('../../src/main/scheduler', () => ({}))

vi.mock('../../node_modules/@earendil-works/pi-coding-agent/dist/core/tools/index.js', () => ({
  createCodingTools: () => state.codingTools,
  createGrepTool: () => state.discoveryTools[0],
  createFindTool: () => state.discoveryTools[1],
  createLsTool: () => state.discoveryTools[2]
}))

import { buildPiTools } from '../../src/main/pi-tools'

describe('scheduler legacy tool surface', () => {
  beforeEach(() => {
    state.productTools = [
      ...SCHEDULER_BLOCKED_TOOL_NAMES.map(name => ({ name })),
      { name: 'browser_click' },
      { name: 'safe_product_tool' }
    ]
    state.codingTools = [
      { name: 'read' },
      { name: 'browser_fill' }
    ]
    state.discoveryTools = [
      { name: 'grep' },
      { name: 'find' },
      { name: 'ls' }
    ]
  })

  it('removes user-interaction and every browser namespace tool after legacy composition', () => {
    const tools = buildPiTools('scheduler', {} as never)

    expect(tools.map(tool => tool.name)).toEqual([
      'safe_product_tool',
      'read',
      'grep',
      'find',
      'ls'
    ])
  })
})

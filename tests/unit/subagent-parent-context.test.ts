import fs from 'node:fs'
import path from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  profile: {
    name: 'explorer',
    systemPrompt: 'Explore carefully',
    model: undefined as string | undefined,
    tools: undefined as string[] | undefined,
    maxTurns: undefined as number | undefined
  },
  toolsConfig: undefined as { workingDir?: string; disabledTools?: string[] } | undefined,
  globalWorkingDir: '/global/workspace',
  presets: [] as Array<{ id: string; name: string; config: any }>,
  globalPresetId: 'global-preset',
  parentConfigs: new Map<string | undefined, any>(),
  parentPresetLookups: [] as Array<string | undefined>,
  agentOptions: [] as any[],
  executionWorkingDirs: [] as string[],
  executionDisposeCalls: 0,
  productSources: [] as string[],
  productOptions: [] as any[],
  productTools: [] as any[],
  securityScopes: [] as any[],
  mcpBuildCalls: [] as Array<{ conversationId?: string; source?: string }>
}))

vi.mock('@earendil-works/pi-agent-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@earendil-works/pi-agent-core')>()
  return {
    ...actual,
    Agent: class FakeAgent {
    state = { messages: [] as any[] }
    private subscribers = new Set<(event: any) => void>()

    constructor(options: any) {
      state.agentOptions.push(options)
    }

    subscribe(callback: (event: any) => void): () => void {
      this.subscribers.add(callback)
      return () => this.subscribers.delete(callback)
    }

    async prompt(): Promise<void> {}
    async waitForIdle(): Promise<void> {}
    abort(): void {}
    }
  }
})

vi.mock('../../src/main/subagent-manager', () => ({
  getSubagentProfile: () => state.profile
}))

vi.mock('../../src/main/agent-runtime/pi-core-skills', () => ({
  loadPiCoreSkillCatalog: async () => ({ promptSection: '', skills: [] })
}))

vi.mock('../../src/main/agent-workspace-store', () => ({
  readToolsConfig: () => state.toolsConfig
}))

vi.mock('../../src/main/config-manager', () => ({
  getWorkingDir: () => state.globalWorkingDir,
  listModelPresets: () => state.presets,
  loadConfig: () => ({ activePresetId: state.globalPresetId }),
  getModelPresetFull: (id: string) => state.presets.find(preset => preset.id === id),
  buildModelFromConfig: (config: any) => ({
    id: config.model,
    provider: config.provider,
    configMarker: config.marker
  }),
  ensurePiApiKeyFor: vi.fn(),
  resolveConversationModelConfig: (presetId?: string) => {
    state.parentPresetLookups.push(presetId)
    const config = state.parentConfigs.get(presetId) || state.parentConfigs.get(undefined)
    return { source: presetId ? 'conversation' : 'global', config }
  },
  withSessionStreamOptions: (stream: unknown) => stream,
  createModelPayloadAdapter: () => (payload: unknown) => payload
}))

vi.mock('../../src/main/openpipal-product-tools', () => ({
  AskUserResolver: class AskUserResolver {},
  buildOpenPipalProductTools: (source: string, _resolver: unknown, options: any) => {
    state.productSources.push(source)
    state.productOptions.push(options)
    return state.productTools
  },
  filterOpenPipalTools: (tools: unknown[]) => tools
}))

vi.mock('../../src/main/pi-mcp-bridge', () => ({
  buildMcpBridgeTools: (_servers: unknown, conversationId?: string, source?: string) => {
    state.mcpBuildCalls.push({ conversationId, source })
    return source === 'scheduler' ? [{ name: 'browser_mcp_collision' }] : []
  }
}))

vi.mock('../../src/main/agent-runtime/pi-core-execution-tools', () => ({
  buildPiCoreExecutionTools: (workingDir: string) => {
    state.executionWorkingDirs.push(workingDir)
    return {
      tools: [],
      executeCode: vi.fn(),
      toolContext: {},
      dispose: async () => { state.executionDisposeCalls += 1 }
    }
  }
}))

vi.mock('../../src/main/pi-security', () => ({
  createSecurityHook: (_conversationId: string | undefined, _handler: unknown, scope: any) => {
    state.securityScopes.push(scope)
    return vi.fn()
  }
}))

vi.mock('../../src/main/context-window-policy', () => ({
  createStableContextTransform: () => vi.fn()
}))

vi.mock('../../src/main/isolated-stream-signal', () => ({
  isolatedStreamSimple: vi.fn()
}))

// The legacy facade imports the scheduler for its historical startup side effect.
// This test only exercises tool-context propagation and must not start background work.
vi.mock('../../src/main/scheduler', () => ({}))

import { runChildAgent } from '../../src/main/subagent-runner'
import { buildPiTools, AskUserResolver } from '../../src/main/pi-tools'
import { buildPiCoreHarnessTools } from '../../src/main/agent-runtime/pi-core-tool-bridge'

function modelConfig(model: string, marker: string): any {
  return {
    provider: 'openai-compatible',
    baseUrl: 'http://127.0.0.1:1',
    apiKey: 'test-only',
    model,
    marker
  }
}

async function run(options: Partial<Parameters<typeof runChildAgent>[0]> = {}): Promise<void> {
  await runChildAgent({
    profile: 'explorer',
    task: 'inspect context propagation',
    workspaceId: 'workspace-1',
    conversationId: 'conversation-1',
    modelPresetId: 'parent-preset',
    ...options
  })
}

describe('subagent parent execution context', () => {
  beforeEach(() => {
    state.profile = {
      name: 'explorer',
      systemPrompt: 'Explore carefully',
      model: undefined,
      tools: undefined,
      maxTurns: undefined
    }
    state.toolsConfig = undefined
    state.globalWorkingDir = '/global/workspace'
    state.presets = [
      { id: 'global-preset', name: 'Global', config: modelConfig('global-model', 'global') }
    ]
    state.globalPresetId = 'global-preset'
    state.parentConfigs.clear()
    state.parentConfigs.set('parent-preset', modelConfig('parent-model', 'parent'))
    state.parentConfigs.set(undefined, modelConfig('global-model', 'global'))
    state.parentPresetLookups.length = 0
    state.agentOptions.length = 0
    state.executionWorkingDirs.length = 0
    state.executionDisposeCalls = 0
    state.productSources.length = 0
    state.productOptions.length = 0
    state.productTools.length = 0
    state.securityScopes.length = 0
    state.mcpBuildCalls.length = 0
  })

  it.each([
    {
      label: 'parent turn before workspace and global',
      parentWorkingDir: '/parent/turn',
      workspaceWorkingDir: '/workspace/config',
      expected: '/parent/turn'
    },
    {
      label: 'workspace before global when parent omitted',
      parentWorkingDir: undefined,
      workspaceWorkingDir: '/workspace/config',
      expected: '/workspace/config'
    },
    {
      label: 'global only when parent and workspace omitted',
      parentWorkingDir: undefined,
      workspaceWorkingDir: undefined,
      expected: '/global/workspace'
    }
  ])('resolves workingDir from $label', async ({ parentWorkingDir, workspaceWorkingDir, expected }) => {
    state.toolsConfig = workspaceWorkingDir ? { workingDir: workspaceWorkingDir } : undefined

    await run({ workingDir: parentWorkingDir })

    expect(state.executionWorkingDirs).toEqual([expected])
    expect(state.productOptions).toHaveLength(1)
    expect(state.productOptions[0].workingDir).toBe(expected)
    expect(state.securityScopes).toEqual([{ workspaceId: 'workspace-1', workingDir: expected }])
    expect(state.executionDisposeCalls).toBe(1)
  })

  it('uses explicit tool model before profile model and parent conversation preset', async () => {
    state.profile.model = 'profile-model'
    state.presets.push(
      { id: 'explicit', name: 'Explicit', config: modelConfig('explicit-model', 'explicit') },
      { id: 'profile', name: 'Profile', config: modelConfig('profile-model', 'profile') }
    )

    await run({ modelOverride: 'explicit-model' })

    expect(state.agentOptions[0].initialState.model).toMatchObject({
      id: 'explicit-model',
      configMarker: 'explicit'
    })
    expect(state.parentPresetLookups).toEqual(['parent-preset'])
  })

  it('uses profile model before the parent conversation preset', async () => {
    state.profile.model = 'profile-model'
    state.presets.push(
      { id: 'profile', name: 'Profile', config: modelConfig('profile-model', 'profile') }
    )

    await run()

    expect(state.agentOptions[0].initialState.model).toMatchObject({
      id: 'profile-model',
      configMarker: 'profile'
    })
  })

  it('inherits the parent conversation preset when no override exists', async () => {
    await run()

    expect(state.agentOptions[0].initialState.model).toMatchObject({
      id: 'parent-model',
      configMarker: 'parent'
    })
    expect(state.parentPresetLookups).toEqual(['parent-preset'])
  })

  it('falls back from an invalid explicit override to the parent session, never the global preset', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      await run({ modelOverride: 'missing-model' })
    } finally {
      warn.mockRestore()
    }

    expect(state.agentOptions[0].initialState.model).toMatchObject({
      id: 'parent-model',
      configMarker: 'parent'
    })
    expect(state.agentOptions[0].initialState.model.id).not.toBe('global-model')
    expect(state.parentPresetLookups).toEqual(['parent-preset'])
  })

  it('passes the same resolved cwd to execution, product tools, and security authorization', async () => {
    await run({ workingDir: '/one/resolved/cwd' })

    expect(state.executionWorkingDirs[0]).toBe('/one/resolved/cwd')
    expect(state.productOptions[0].workingDir).toBe('/one/resolved/cwd')
    expect(state.securityScopes[0].workingDir).toBe('/one/resolved/cwd')
  })

  it('preserves scheduler source restrictions across subagent delegation', async () => {
    await run({ source: 'scheduler' })

    expect(state.productSources).toEqual(['scheduler'])
    expect(state.mcpBuildCalls).toEqual([{
      conversationId: 'conversation-1',
      source: 'scheduler'
    }])
    expect(state.agentOptions[0].initialState.tools).toEqual([])
  })

  it('passes resolved parent cwd and model preset through the legacy product-tool adapter', () => {
    buildPiTools('desktop', new AskUserResolver(), {
      workingDir: '/legacy/resolved/cwd',
      modelPresetId: 'legacy-parent-preset',
      workspaceId: 'legacy-workspace',
      conversationId: 'legacy-conversation'
    })

    expect(state.productOptions.at(-1)).toMatchObject({
      workingDir: '/legacy/resolved/cwd',
      modelPresetId: 'legacy-parent-preset',
      workspaceId: 'legacy-workspace',
      conversationId: 'legacy-conversation'
    })
  })

  it('passes resolved parent cwd and model preset through the pi-core product-tool adapter', async () => {
    const bundle = buildPiCoreHarnessTools({
      source: 'desktop',
      workingDir: '/pi-core/resolved/cwd',
      overrides: {
        modelPresetId: 'pi-core-parent-preset',
        workspaceId: 'pi-core-workspace',
        conversationId: 'pi-core-conversation'
      }
    })
    await bundle.dispose()

    expect(state.productOptions.at(-1)).toMatchObject({
      workingDir: '/pi-core/resolved/cwd',
      modelPresetId: 'pi-core-parent-preset',
      workspaceId: 'pi-core-workspace',
      conversationId: 'pi-core-conversation'
    })
  })

  it('double-insures every subagent tool with per-tool executionMode sequential, on top of the global toolExecution flag', async () => {
    state.productTools = [
      { name: 'fake_tool_a', label: 'Fake A', execute: vi.fn() },
      { name: 'fake_tool_b', label: 'Fake B', execute: vi.fn() }
    ]

    await run()

    const options = state.agentOptions[0]
    expect(options.toolExecution).toBe('sequential')
    expect(options.initialState.tools.length).toBeGreaterThan(0)
    for (const tool of options.initialState.tools) {
      expect(tool.executionMode).toBe('sequential')
    }
  })

  it('keeps the product subagent tool wired to the same parent cwd and model preset', () => {
    const product = fs.readFileSync(path.resolve('src/main/openpipal-product-tools.ts'), 'utf8')

    expect(product).toMatch(
      /runChildAgent\(\{[\s\S]*?workingDir: overrides\?\.workingDir,[\s\S]*?modelPresetId: overrides\?\.modelPresetId/
    )
  })
})

import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const service = vi.hoisted(() => ({
  evaluations: 0,
  agentChat: vi.fn(async function* () {
    yield { type: 'text' as const, content: 'mock' }
  }),
  setPermissionHandler: vi.fn(),
  testThinkingSupport: vi.fn(async () => ({ detected: true }))
}))

const coreService = vi.hoisted(() => ({
  evaluations: 0,
  loadPiCoreAgentRuntime: vi.fn(),
  runtime: Object.freeze({
    kind: 'pi-core' as const,
    agentChat: async function* () {},
    setPermissionHandler: vi.fn(),
    testThinkingSupport: vi.fn(async () => ({ detected: true }))
  })
}))

vi.mock('../../src/main/pi-agent-service', () => {
  service.evaluations += 1
  return {
    agentChat: service.agentChat,
    setPermissionHandler: service.setPermissionHandler,
    testThinkingSupport: service.testThinkingSupport
  }
})

vi.mock('../../src/main/agent-runtime/pi-core-runtime', () => {
  coreService.evaluations += 1
  return {
    loadPiCoreAgentRuntime: coreService.loadPiCoreAgentRuntime
  }
})

describe('Agent Runtime boundary', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    service.evaluations = 0
    coreService.evaluations = 0
    coreService.loadPiCoreAgentRuntime.mockReset()
    coreService.loadPiCoreAgentRuntime.mockResolvedValue(coreService.runtime)
    delete process.env.OPENPIPAL_AGENT_RUNTIME
  })

  afterEach(() => {
    delete process.env.OPENPIPAL_AGENT_RUNTIME
  })

  it('does not evaluate either implementation merely by importing the Runtime router', async () => {
    const runtimeRouter = await import('../../src/main/agent-runtime')
    expect(service.evaluations).toBe(0)
    expect(coreService.evaluations).toBe(0)

    // 显式回滚只求值 legacy 实现，新路径不得被顺带拉起（默认值本身由 selection 测试覆盖）
    process.env.OPENPIPAL_AGENT_RUNTIME = 'legacy'
    const runtime = await runtimeRouter.getAgentRuntime()
    expect(runtime.kind).toBe('legacy')
    expect(service.evaluations).toBe(1)
    expect(coreService.evaluations).toBe(0)
  })

  it('loads pi-core lazily and fixes the selection for the process lifetime', async () => {
    process.env.OPENPIPAL_AGENT_RUNTIME = 'pi-core'
    const runtimeRouter = await import('../../src/main/agent-runtime')

    expect(coreService.evaluations).toBe(0)
    const runtime = await runtimeRouter.getAgentRuntime()
    expect(runtime).toBe(coreService.runtime)
    expect(coreService.evaluations).toBe(1)
    expect(coreService.loadPiCoreAgentRuntime).toHaveBeenCalledOnce()
    expect(service.evaluations).toBe(0)

    process.env.OPENPIPAL_AGENT_RUNTIME = 'legacy'
    expect(await runtimeRouter.getAgentRuntime()).toBe(runtime)
    expect(coreService.loadPiCoreAgentRuntime).toHaveBeenCalledOnce()
    expect(service.evaluations).toBe(0)
  })

  it('propagates a pi-core load failure without fallback and permits a retry', async () => {
    const loadFailure = new Error('explicit pi-core load failure')
    coreService.loadPiCoreAgentRuntime
      .mockRejectedValueOnce(loadFailure)
      .mockResolvedValueOnce(coreService.runtime)
    process.env.OPENPIPAL_AGENT_RUNTIME = 'pi-core'
    const runtimeRouter = await import('../../src/main/agent-runtime')

    await expect(runtimeRouter.getAgentRuntime()).rejects.toBe(loadFailure)
    expect(service.evaluations).toBe(0)
    await expect(runtimeRouter.getAgentRuntime()).resolves.toBe(coreService.runtime)
    expect(coreService.loadPiCoreAgentRuntime).toHaveBeenCalledTimes(2)
    expect(service.evaluations).toBe(0)
  })

  it('exposes the legacy implementation through a frozen, exact adapter', async () => {
    const { loadLegacyAgentRuntime } = await import('../../src/main/agent-runtime/legacy-runtime')
    const runtime = await loadLegacyAgentRuntime()

    expect(Object.isFrozen(runtime)).toBe(true)
    expect(runtime.agentChat).toBe(service.agentChat)
    expect(runtime.setPermissionHandler).toBe(service.setPermissionHandler)
    expect(runtime.testThinkingSupport).toBe(service.testThinkingSupport)
  })

  it('keeps the default legacy product layer independent from the pi-core execution backend', () => {
    const productTools = fs.readFileSync(path.resolve('src/main/openpipal-product-tools.ts'), 'utf8')
    const legacyTools = fs.readFileSync(path.resolve('src/main/pi-tools.ts'), 'utf8')

    expect(productTools).not.toContain('openpipal-execution-env')
    expect(productTools).not.toContain('@earendil-works/pi-agent-core/node')
    expect(legacyTools).not.toMatch(/from ['"].*openpipal-execution-env/)
    expect(legacyTools).toContain("await import('./openpipal-execution-env')")
    expect(legacyTools).not.toContain('@earendil-works/pi-agent-core/node')
  })

  it('documents the rollback boundary for shared nested subagent execution', () => {
    const subagent = fs.readFileSync(path.resolve('src/main/subagent-runner.ts'), 'utf8')
    const migration = fs.readFileSync(path.resolve('docs/architecture/runtime-v2-migration.md'), 'utf8')
    expect(subagent).toContain("from './agent-runtime/pi-core-execution-tools'")
    expect(subagent).toContain("from './agent-runtime/pi-core-skills'")
    expect(migration).toContain('rolls back the top-level Agent loop, not child execution internals')
  })

  it('keeps subagent execution cwd and cleanup aligned with its security hook', () => {
    const subagent = fs.readFileSync(path.resolve('src/main/subagent-runner.ts'), 'utf8')
    expect(subagent).toContain('const workingDir = options.workingDir || toolsCfg?.workingDir || getWorkingDir()')
    expect(subagent).toMatch(/createSecurityHook\([\s\S]*?workingDir,/)
    expect(subagent).not.toContain('workingDir: toolsCfg?.workingDir')
    expect(subagent).toMatch(/finally \{\s*await execution\.dispose\(\)/)
  })

  it('resolves scheduler control before mutating task storage', () => {
    const productTools = fs.readFileSync(path.resolve('src/main/openpipal-product-tools.ts'), 'utf8')
    const createCase = productTools.slice(
      productTools.indexOf("case 'create':"),
      productTools.indexOf("case 'update':")
    )
    const updateCase = productTools.slice(
      productTools.indexOf("case 'update':"),
      productTools.indexOf("case 'delete':")
    )
    const toggleCase = productTools.slice(
      productTools.indexOf("case 'toggle':"),
      productTools.indexOf('default:', productTools.indexOf("case 'toggle':"))
    )
    expect(createCase.indexOf('getTaskSchedulerControl()')).toBeLessThan(createCase.indexOf('createTask({'))
    expect(updateCase.indexOf('getTaskSchedulerControl()')).toBeLessThan(updateCase.indexOf('updateTask('))
    expect(toggleCase.indexOf('getTaskSchedulerControl()')).toBeLessThan(toggleCase.indexOf('updateTask('))
  })

  it('prevents application entry points from bypassing the Runtime boundary', () => {
    const entryPoints = ['ipc-handlers.ts', 'http-server.ts', 'scheduler.ts']
    const directLegacyImport = /(?:from\s+|import\()\s*['"]\.\/pi-agent-service['"]/

    for (const file of entryPoints) {
      const source = fs.readFileSync(path.resolve('src/main', file), 'utf8')
      expect(source, file).not.toMatch(directLegacyImport)
    }

    const contract = fs.readFileSync(path.resolve('src/main/agent-runtime/contracts.ts'), 'utf8')
    expect(contract).not.toContain('@earendil-works/pi-agent-core')
    expect(contract).not.toContain('../pi-event-adapter')
  })

  it('keeps CLI Agent and package-internal imports out of the Runtime layer', () => {
    const runtimeDir = path.resolve('src/main/agent-runtime')
    const runtimeFiles = fs.readdirSync(runtimeDir)
      .filter((file) => file.endsWith('.ts'))

    for (const file of runtimeFiles) {
      const source = fs.readFileSync(path.join(runtimeDir, file), 'utf8')
      expect(source, file).not.toContain('@earendil-works/pi-coding-agent')
      const coreSpecifiers = [...source.matchAll(/(?:from\s+|import\()\s*['"](@earendil-works\/pi-agent-core[^'"]*)['"]/g)]
        .map((match) => match[1])
      expect(
        coreSpecifiers.every((specifier) => (
          specifier === '@earendil-works/pi-agent-core'
          || specifier === '@earendil-works/pi-agent-core/node'
        )),
        `${file}: ${coreSpecifiers.join(', ')}`
      ).toBe(true)
      expect(source, file).not.toMatch(/(?:^|['"])\.\.?(?:\/\.\.)*\/node_modules\//m)
    }
  })

  it('keeps UI locale resources out of Runtime prompts and tool contracts', () => {
    const runtimeFiles = fs.readdirSync(path.resolve('src/main/agent-runtime'))
      .filter((file) => file.endsWith('.ts'))
      .map((file) => path.resolve('src/main/agent-runtime', file))
    const adjacentRuntimeFiles = [
      'src/main/pi-agent-service.ts',
      'src/main/pi-tools.ts',
      'src/main/pi-security.ts',
      'src/main/openpipal-product-tools.ts',
      'src/main/subagent-runner.ts',
    ].map((file) => path.resolve(file))

    for (const file of [...runtimeFiles, ...adjacentRuntimeFiles]) {
      const source = fs.readFileSync(file, 'utf8')
      const importSpecifiers = [...source.matchAll(/(?:from\s+|import\()\s*['"]([^'"]+)['"]/g)]
        .map((match) => match[1])

      expect(
        importSpecifiers.filter((specifier) => (
          specifier.includes('/i18n')
          || specifier.includes('main-i18n')
        )),
        path.relative(process.cwd(), file)
      ).toEqual([])
    }
  })

  it('keeps pi-coding-agent out of the complete pi-core source graph', () => {
    const entry = path.resolve('src/main/agent-runtime/pi-core-runtime.ts')
    const pending = [{ file: entry, chain: [entry] }]
    const seen = new Set<string>()
    const forbidden: string[] = []
    const resolveLocal = (from: string, specifier: string): string | undefined => {
      if (!specifier.startsWith('.')) return undefined
      const base = path.resolve(path.dirname(from), specifier)
      for (const candidate of [`${base}.ts`, path.join(base, 'index.ts')]) {
        if (fs.existsSync(candidate)) return candidate
      }
      return undefined
    }

    while (pending.length > 0) {
      const { file, chain } = pending.pop()!
      if (seen.has(file)) continue
      seen.add(file)
      const source = fs.readFileSync(file, 'utf8')
      const specifiers = [...source.matchAll(/(?:from\s+|import\()\s*['"]([^'"]+)['"]/g)]
        .map((match) => match[1])
      for (const specifier of specifiers) {
        if (specifier.includes('@earendil-works/pi-coding-agent') || specifier.includes('/node_modules/')) {
          forbidden.push(
            `${chain.map((item) => path.relative(process.cwd(), item)).join(' -> ')} -> ${specifier}`
          )
        }
        const local = resolveLocal(file, specifier)
        if (local) pending.push({ file: local, chain: [...chain, local] })
      }
    }

    expect(forbidden).toEqual([])
    expect(seen.size).toBeGreaterThan(10)
  })

  it('uses only the pi-agent-core package root and the runnable in-memory Agent', () => {
    const runtime = fs.readFileSync(
      path.resolve('src/main/agent-runtime/pi-core-runtime.ts'),
      'utf8'
    )

    const coreSpecifiers = [...runtime.matchAll(/from\s+['"](@earendil-works\/pi-agent-core[^'"]*)['"]/g)]
      .map((match) => match[1])
    expect(coreSpecifiers).toEqual(['@earendil-works/pi-agent-core'])
    expect(runtime).toMatch(/new Agent\s*\(/)
    expect(runtime).not.toContain('AgentHarness')
    expect(runtime).not.toContain('HarnessNotImplemented')
    expect(runtime).not.toContain('InMemorySessionRepo')
    expect(runtime).not.toContain('JsonlSessionRepo')
    expect(runtime).not.toMatch(/@earendil-works\/pi-agent-core\/dist\//)
    expect(runtime).not.toMatch(/\.compact\s*\(/)
  })

  it('routes both adapters through the same prompt and history projections', () => {
    const legacy = fs.readFileSync(path.resolve('src/main/pi-agent-service.ts'), 'utf8')
    const core = fs.readFileSync(path.resolve('src/main/agent-runtime/pi-core-runtime.ts'), 'utf8')

    expect(legacy).toContain("from './agent-runtime/openpipal-prompt'")
    expect(core).toContain("from './openpipal-prompt-core'")
    expect(legacy).toContain("from './agent-runtime/pi-message-conversion'")
    expect(core).toContain("from './pi-message-conversion'")
    expect(legacy).not.toContain('function buildSystemPrompt(')
    expect(legacy).not.toContain('function buildRuntimeContext(')
    expect(legacy).not.toContain('function convertHistoryToPiMessages(')
  })
})

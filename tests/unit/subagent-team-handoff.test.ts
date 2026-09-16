/**
 * subagent.pal = 交接给团队成员（设计稿 §4）：成员以自己的身份起跑（人设 / 记忆 / 技能 / 工具配置 / 租户边界都按成员算），
 * 叠团队层成员版；工具 = 成员 ∩ 团队；工作目录 = 父级本轮的；不在名单 → 报错；深度 1 由黑名单保证。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  scope: null as null | Record<string, unknown>,
  workspaces: new Map<string, any>(),
  toolsConfigs: new Map<string, any>(),
  agentOptions: [] as any[],
  productOptions: [] as any[],
  filterOptions: [] as any[],
  securityHooks: [] as Array<{ scope: any; tier: any }>,
  authorizers: [] as any[],
  hookScopes: [] as any[],
  hooks: [] as any[],
  mcpFilters: [] as Array<string[] | undefined>,
  skillWorkspaces: [] as Array<string | undefined>,
  /** 假 Agent 在"跑"的时候替我们调 beforeToolCall：规则与授权看的生命周期信号只在这段时间有效 */
  probeCalls: [] as any[],
  probeResults: [] as any[]
}))

vi.mock('@earendil-works/pi-agent-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@earendil-works/pi-agent-core')>()
  return {
    ...actual,
    Agent: class FakeAgent {
      constructor(private readonly options: any) { state.agentOptions.push(options) }
      subscribe(): () => void { return () => undefined }
      async prompt(): Promise<void> {
        for (const call of state.probeCalls) {
          state.probeResults.push(await this.options.beforeToolCall(call, new AbortController().signal))
        }
      }
      async waitForIdle(): Promise<void> {}
      abort(): void {}
    }
  }
})
vi.mock('../../src/main/subagent-manager', () => ({ getSubagentProfile: () => undefined }))
vi.mock('../../src/main/agent-runtime/pi-core-skills', () => ({
  loadPiCoreSkillCatalog: async (o: { workspaceId?: string }) => { state.skillWorkspaces.push(o.workspaceId); return { promptSection: '', skills: [] } }
}))
vi.mock('../../src/main/agent-workspace-store', () => ({
  readToolsConfig: (id: string) => state.toolsConfigs.get(id) ?? {},
  getWorkspace: (id: string) => state.workspaces.get(id) ?? null
}))
vi.mock('../../src/main/team-store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/main/team-store')>()
  return { ...actual, resolveTeamScope: () => state.scope }
})
vi.mock('../../src/main/config-manager', () => ({
  getWorkingDir: () => '/global',
  listModelPresets: () => [],
  loadConfig: () => ({}),
  getModelPresetFull: () => undefined,
  buildModelFromConfig: (config: any) => ({ id: config.model, provider: 'openai-compatible' }),
  ensurePiApiKeyFor: vi.fn(),
  resolveConversationModelConfig: () => ({ source: 'global', config: { provider: 'openai-compatible', model: 'm', baseUrl: 'http://127.0.0.1:1', apiKey: 'k' } }),
  withSessionStreamOptions: (stream: unknown) => stream,
  createModelPayloadAdapter: () => (payload: unknown) => payload
}))
vi.mock('../../src/main/openpipal-product-tools', () => ({
  AskUserResolver: class AskUserResolver {},
  buildOpenPipalProductTools: (_s: string, _r: unknown, options: any) => { state.productOptions.push(options); return [{ name: 'read' }, { name: 'subagent' }, { name: 'ask_user' }] },
  filterOpenPipalTools: (tools: unknown[], options: any) => { state.filterOptions.push(options); return tools }
}))
vi.mock('../../src/main/pi-mcp-bridge', () => ({ buildMcpBridgeTools: (filter?: string[]) => { state.mcpFilters.push(filter); return [] } }))
vi.mock('../../src/main/agent-runtime/pi-core-execution-tools', () => ({
  buildPiCoreExecutionTools: () => ({ tools: [], executeCode: vi.fn(), toolContext: {}, dispose: async () => undefined })
}))
vi.mock('../../src/main/pi-security', () => ({
  createSecurityHook: (_c: unknown, _h: unknown, scope: any, tier: any) => { state.securityHooks.push({ scope, tier }); return vi.fn() },
  authorizeToolCall: vi.fn(async () => undefined),
  writeHookBlockAudit: vi.fn()
}))
// 成员走与主链路同一份组合（规则 → 安全员）：授权器记下拿到的范围与档位，组合函数用真的
vi.mock('../../src/main/agent-runtime/pi-core-tool-adapter', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/main/agent-runtime/pi-core-tool-adapter')>()
  return {
    ...actual,
    PiCoreToolAuthorizer: class FakeAuthorizer {
      constructor(options: any) { state.authorizers.push(options) }
      async authorize(): Promise<undefined> { return undefined }
    }
  }
})
vi.mock('../../src/main/hooks/hook-registry', () => ({
  loadActiveHooks: async (_o: unknown, scope: any) => { state.hookScopes.push(scope); return { hooks: state.hooks, failures: [], report: state.hooks.map((h: any) => ({ id: h.id, source: { kind: 'team', id: 't', name: 'x' }, file: h.file, description: h.description, status: 'ok', events: ['tool_call'] })) } },
  formatHookStatusForPrompt: (report: any[]) => (report.length ? `<rules>${report.map(r => r.description).join(',')}</rules>` : '')
}))
vi.mock('../../src/main/context-window-policy', () => ({ createStableContextTransform: () => vi.fn() }))
vi.mock('../../src/main/isolated-stream-signal', () => ({ isolatedStreamSimple: vi.fn() }))
vi.mock('../../src/main/scheduler', () => ({}))

import { runChildAgent } from '../../src/main/subagent-runner'

const LEAD = 'lead-id'
const MEMBER = 'member-id'

describe('交接给团队成员', () => {
  beforeEach(() => {
    state.scope = {
      teamId: 'team-1', name: '教研组', lead: LEAD, tier: 'auto', approvers: [], handoffBudget: 6,
      members: [{ id: LEAD, name: '备课 Pal' }, { id: MEMBER, name: '出题 Pal', description: '出题' }],
      workingDir: '/teams/team-1/shared', sharedDir: '/teams/team-1/shared', charters: [{ label: '教研组', body: '章程。' }],
      memoryIndexes: [], memoryWriteDir: '/teams/team-1/memory', toolsConfig: { mcpServers: ['y', 'z'], disabledTools: ['web_search'] }, rulesDirs: []
    }
    state.workspaces.set(MEMBER, { meta: { id: MEMBER, name: '出题 Pal' }, agentMd: '---\nskills: x\n---\n# 出题人设\n', meMd: '', memories: [{ name: 'note', content: '---\ndescription: d\n---\n喜欢选择题。' }], skills: [], toolsConfig: {}, dir: '/agents/member-id' })
    state.toolsConfigs.set(MEMBER, { mcpServers: ['x', 'y'], disabledTools: ['bash'], workingDir: '/member/own' })
    state.agentOptions.length = 0; state.productOptions.length = 0; state.filterOptions.length = 0
    state.securityHooks.length = 0; state.mcpFilters.length = 0; state.skillWorkspaces.length = 0
    state.authorizers.length = 0; state.hookScopes.length = 0; state.hooks = []
    state.probeCalls = []; state.probeResults = []
  })

  it('成员以自己的身份起跑：人设 + 团队层（成员版）+ 记忆；工具 = 成员 ∩ 团队；边界按成员与团队算', async () => {
    const result = await runChildAgent({ pal: MEMBER, teamId: 'team-1', task: '出 3 道题', workspaceId: LEAD, conversationId: 'conv-1', workingDir: '/teams/team-1/shared' })
    expect(result.palId).toBe(MEMBER)
    expect(result.profileName).toBe('出题 Pal')
    const prompt: string = state.agentOptions[0].initialState.systemPrompt
    expect(prompt.indexOf('# 出题人设')).toBeGreaterThanOrEqual(0)
    expect(prompt).not.toContain('skills: x')
    expect(prompt.indexOf('你是这个团队的成员')).toBeGreaterThan(prompt.indexOf('# 出题人设'))
    expect(prompt.indexOf('喜欢选择题。')).toBeGreaterThan(prompt.indexOf('你是这个团队的成员'))
    expect(prompt).toContain(`- 出题 Pal（就是你） id: ${MEMBER}`)
    expect(state.skillWorkspaces).toEqual([MEMBER])
    expect(state.productOptions[0]).toMatchObject({ workspaceId: MEMBER, workingDir: '/teams/team-1/shared', disabledTools: ['bash', 'web_search'] })
    expect(state.mcpFilters).toEqual([['y']])
    // 安全员拿到的是成员的身份 + 团队（租户边界按成员与团队算），不再是父级的
    expect(state.securityHooks).toEqual([])
    expect(state.authorizers).toEqual([{ conversationId: 'conv-1', scope: { workspaceId: MEMBER, workingDir: '/teams/team-1/shared', teamId: 'team-1' }, tier: undefined }])
    // 规则按成员 + 团队装
    expect(state.hookScopes).toEqual([{ workspaceId: MEMBER, teamId: 'team-1' }])
    // 深度 1：成员拿不到 subagent，也不能问用户
    const toolNames = state.agentOptions[0].initialState.tools.map((t: any) => t.name)
    expect(toolNames).toEqual(['read'])
  })

  it('团队天花板 readonly 压到成员的工具与安全钩子上', async () => {
    state.scope = { ...state.scope!, tier: 'readonly' }
    await runChildAgent({ pal: MEMBER, teamId: 'team-1', task: 't', conversationId: 'conv-1', workingDir: '/w' })
    expect(state.productOptions[0].permissionTier).toBe('readonly')
    expect(state.filterOptions[0].permissionTier).toBe('readonly')
    expect(state.authorizers[0].tier).toBe('readonly')
  })

  it('团队规则对成员生效：规则拦下的调用到不了安全员；清单进成员的系统提示', async () => {
    state.hooks = [{
      id: 'team:team-1/no-bash', pluginName: 'team:team-1', file: '/teams/team-1/rules/no-bash.ts', description: '团队里不许跑 bash',
      handlers: { tool_call: [(event: any) => (event.toolName === 'bash' ? { block: true, reason: 'no' } : undefined)], tool_result: [], before_agent_start: [] }
    }]
    state.scope = { ...state.scope!, channel: '批改' }
    state.probeCalls = [
      { toolCall: { id: 'c1', name: 'bash', arguments: {} }, args: { command: 'ls' } },
      { toolCall: { id: 'c2', name: 'read', arguments: {} }, args: { path: '/w/a' } }
    ]
    await runChildAgent({ pal: MEMBER, teamId: 'team-1', channel: '批改', task: 't', conversationId: 'conv-1', workingDir: '/w' })
    expect(state.hookScopes).toEqual([{ workspaceId: MEMBER, teamId: 'team-1', channel: '批改' }])
    expect(state.agentOptions[0].initialState.systemPrompt).toContain('<rules>团队里不许跑 bash</rules>')
    const [blocked, allowed] = state.probeResults
    expect(blocked?.block).toBe(true)
    expect(blocked?.reason).toContain('团队里不许跑 bash')
    expect(allowed).toBeUndefined()
  })

  it('不在名单 / 没有 teamId / 团队不存在 都报错，不起跑', async () => {
    await expect(runChildAgent({ pal: 'stranger', teamId: 'team-1', task: 't' })).rejects.toThrow(/不在团队名单里/)
    await expect(runChildAgent({ pal: MEMBER, task: 't' })).rejects.toThrow(/缺 teamId/)
    state.scope = null
    await expect(runChildAgent({ pal: MEMBER, teamId: 'team-1', task: 't' })).rejects.toThrow(/不存在或没有成员/)
    expect(state.agentOptions).toHaveLength(0)
  })

  it('既没 profile 也没 pal → 未知 profile 报错', async () => {
    await expect(runChildAgent({ task: 't' })).rejects.toThrow(/Unknown subagent profile/)
  })
})

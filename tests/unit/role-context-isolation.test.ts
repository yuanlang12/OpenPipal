import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => {
  const roles: Record<string, any> = {
    general: {
      name: 'general',
      displayName: 'General',
      icon: '',
      systemPrompt: 'SYSTEM:general',
      tools: ['create_artifact', 'manage_task'],
      memoryEnabled: true
    },
    design: {
      name: 'design',
      displayName: 'Design',
      icon: '',
      systemPrompt: 'SYSTEM:design',
      tools: ['create_artifact', 'manage_task'],
      memoryEnabled: true
    },
    teacher: {
      name: 'teacher',
      displayName: 'Teacher',
      icon: '',
      systemPrompt: 'SYSTEM:teacher',
      tools: ['create_artifact', 'manage_task'],
      memoryEnabled: true
    }
  }
  return {
    currentRole: 'general',
    roles,
    conversations: new Map<string, any>(),
    createdTasks: [] as any[],
    artifactUpserts: [] as any[]
  }
})

vi.mock('../../src/main/role-manager', () => ({
  getCurrentRole: () => state.roles[state.currentRole],
  getRoleConfig: (roleName: string) => state.roles[roleName] || null,
  switchRole: (roleName: string) => {
    const role = state.roles[roleName]
    if (!role) return null
    state.currentRole = roleName
    return role
  },
  isToolAllowed: (toolName: string) => state.roles[state.currentRole].tools.includes(toolName),
  getDsReview: () => undefined
}))

vi.mock('../../src/main/conversation-store', () => ({
  getConversation: (id: string) => state.conversations.get(id) || null
}))

vi.mock('../../src/main/agent-workspace-store', () => ({
  getWorkspace: () => null,
  readMeMd: () => '',
  readToolsConfig: () => ({})
}))

vi.mock('../../src/main/agent-template-manager', () => ({ getAgentTemplate: () => null }))
// 记忆总开关的产品默认已改为关闭；本文件测的是"记忆快照是否按会话角色隔离"，
// 与默认值无关，故显式打开，避免用例被产品默认值静默架空
vi.mock('../../src/main/config-manager', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/main/config-manager')>()),
  isAutoMemoryEnabled: () => true
}))
vi.mock('../../src/main/memory-store', () => ({ buildMemoryContext: () => '' }))
vi.mock('../../src/main/memory-manager', () => ({
  getRecentMemories: (roleName: string) => [{ roleName }],
  formatMemoriesForPrompt: (memories: Array<{ roleName: string }>) => `MEMORY:${memories[0]?.roleName || 'none'}`,
  saveOutput: () => ''
}))
vi.mock('../../src/main/mcp-manager', () => ({ getMcpToolIndex: () => '' }))
vi.mock('../../src/main/cli-registry', () => ({ formatCliPrompt: () => '' }))
vi.mock('../../src/main/window-tracker', () => ({
  getCurrentConfig: () => ({ displayName: 'OpenPipal', processName: 'OpenPipal' }),
  getEnvironmentSnapshot: () => ({ mode: 'docked' })
}))
vi.mock('../../src/main/web-search', () => ({
  webSearch: async () => ({ results: [] }),
  formatSearchResults: () => ''
}))
vi.mock('../../src/main/screenshot', () => ({ captureTargetWindow: async () => null }))
vi.mock('../../src/main/accessibility', () => ({
  getActiveContext: async () => null,
  formatContext: () => ''
}))
vi.mock('../../src/main/browser-tools', () => ({
  isBrowserControlAvailable: () => false,
  createBrowserControlTools: () => []
}))
vi.mock('../../src/main/subagent-manager', () => ({
  listSubagentProfiles: () => [],
  describeAvailableProfiles: () => ''
}))
vi.mock('../../src/main/artifact-store', () => ({
  listConversationArtifacts: () => [],
  compileJsxArtifact: () => ({ error: '' }),
  findSimilarArtifact: () => undefined,
  coarseTypeFromFile: () => 'html',
  normalizeArtifactLanguage: ({ language }: any) => language
}))
vi.mock('../../src/main/artifact-registry', () => ({
  getArtifactStore: () => ({
    getRecord: () => undefined,
    upsert: (...args: any[]) => state.artifactUpserts.push(args)
  }),
  evaluateArtifactWriteGuard: () => ({ blocked: false }),
  buildExternalEditEvidence: () => undefined
}))
vi.mock('../../src/main/task-store', () => ({
  listTasks: () => [],
  getTask: () => null,
  createTask: (input: any) => {
    state.createdTasks.push(input)
    return { ...input, id: `task-${state.createdTasks.length}` }
  },
  updateTask: () => null,
  deleteTask: () => true
}))
vi.mock('../../src/main/task-scheduler-control', () => ({
  getTaskSchedulerControl: () => ({ schedule: () => undefined, unschedule: () => undefined })
}))

const { resolveAgentOverrides } = await import('../../src/main/agent-overrides')
const { prepareOpenPipalSystemPrompt } = await import('../../src/main/agent-runtime/openpipal-prompt-core')
const { AskUserResolver, buildOpenPipalProductTools } = await import('../../src/main/openpipal-product-tools')

describe('conversation-scoped role execution context', () => {
  beforeEach(() => {
    state.currentRole = 'general'
    state.conversations.clear()
    state.createdTasks.length = 0
    state.artifactUpserts.length = 0
    state.conversations.set('conv-design', { role: 'design', config: {} })
    state.conversations.set('conv-general', { role: 'general', config: {} })
  })

  it('keeps prompt, role brief, assets, skills and memory on the captured conversation role', () => {
    const design = resolveAgentOverrides({
      conversationId: 'conv-design',
      conversationConfig: {
        roleBrief: {
          design: { taskType: '动画' },
          general: { taskType: '文档' }
        },
        projectName: 'Design project'
      }
    })!

    // Resolving conversations must not mutate the compatibility/UI default.
    const general = resolveAgentOverrides({
      conversationId: 'conv-general',
      conversationConfig: { roleBrief: { general: { taskType: '文档' } } }
    })!
    expect(state.currentRole).toBe('general')
    expect(design.roleName).toBe('design')
    expect(general.roleName).toBe('general')

    // An explicit UI switch in another surface must not affect the execution.
    const prepared = prepareOpenPipalSystemPrompt('desktop', design, { stablePrefix: true })
    state.currentRole = 'teacher'
    const prompt = prepared.render('SKILL:design')

    expect(prepared.skillContext).toEqual({ workspaceId: undefined, roleName: 'design' })
    expect(prompt).toContain('SYSTEM:design')
    expect(prompt).not.toContain('SYSTEM:teacher')
    expect(prompt).toContain('assets/design/')
    expect(prompt).toContain('<taskType>动画</taskType>')
    expect(prompt).not.toContain('<taskType>文档</taskType>')
    expect(prompt).toContain('MEMORY:design')
    expect(prompt).toContain('SKILL:design')

    // Compatibility entry points such as scheduled tasks historically carried
    // only conversationId. Prompt preparation pins the disk role onto that
    // overrides object before pi-core's asynchronous skill load.
    const compatibilityOverrides = { systemPrompt: '', conversationId: 'conv-design' }
    state.currentRole = 'general'
    const compatibilityPrompt = prepareOpenPipalSystemPrompt(
      'desktop',
      compatibilityOverrides,
      { stablePrefix: true }
    )
    expect(compatibilityOverrides).toMatchObject({ roleName: 'design' })
    expect(compatibilityPrompt.skillContext.roleName).toBe('design')
  })

  it('keeps artifact guards and scheduled-task role on each original conversation after role switches', async () => {
    const design = resolveAgentOverrides({
      conversationId: 'conv-design',
      conversationConfig: { roleBrief: { design: { taskType: '网页' } } }
    })!
    const designTools = buildOpenPipalProductTools('acp', new AskUserResolver(), design)

    const general = resolveAgentOverrides({ conversationId: 'conv-general' })!
    const generalTools = buildOpenPipalProductTools('acp', new AskUserResolver(), general)

    const plainHtml = {
      type: 'html',
      title: 'Plain page',
      content: '<!doctype html><html><body>plain</body></html>'
    }
    // Flip the process default after both tool graphs have been built. Tools
    // must use their captured role rather than this mutable value.
    state.currentRole = 'teacher'
    const designResult = await designTools.find(tool => tool.name === 'create_artifact')!
      .execute('design-artifact', { ...plainHtml })
    state.currentRole = 'design'
    const generalResult = await generalTools.find(tool => tool.name === 'create_artifact')!
      .execute('general-artifact', { ...plainHtml })

    expect((designResult.content[0] as any).text).toContain('已拒绝')
    expect((designResult.content[0] as any).text).toContain('Design Component')
    expect((generalResult.content[0] as any).text).toContain('已创建')
    expect(state.artifactUpserts).toHaveLength(1)

    state.currentRole = 'general'
    await designTools.find(tool => tool.name === 'manage_task')!.execute('design-task', {
      action: 'create',
      name: 'Design follow-up',
      prompt: 'Continue the design',
      trigger_type: 'interval',
      interval_minutes: 30
    })
    state.currentRole = 'teacher'
    await generalTools.find(tool => tool.name === 'manage_task')!.execute('general-task', {
      action: 'create',
      name: 'General follow-up',
      prompt: 'Continue the general task',
      trigger_type: 'interval',
      interval_minutes: 30
    })

    expect(state.createdTasks.map(task => task.role)).toEqual(['design', 'general'])
  })

  it('does not reuse a previous role memory snapshot after the conversation role changes', () => {
    state.conversations.set('conv-role-change', { role: 'design', config: {} })
    const design = resolveAgentOverrides({ conversationId: 'conv-role-change' })!
    const designPrompt = prepareOpenPipalSystemPrompt('desktop', design, { stablePrefix: true }).render()
    expect(designPrompt).toContain('MEMORY:design')

    state.conversations.set('conv-role-change', { role: 'general', config: {} })
    const general = resolveAgentOverrides({ conversationId: 'conv-role-change' })!
    const generalPrompt = prepareOpenPipalSystemPrompt('desktop', general, { stablePrefix: true }).render()
    expect(generalPrompt).toContain('MEMORY:general')
    expect(generalPrompt).not.toContain('MEMORY:design')
  })
})

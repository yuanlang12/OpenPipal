import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { once } from 'node:events'
import type { Server } from 'node:http'
import { connect } from 'node:net'
import type { AgentEvent } from '../../src/main/agent-runtime/events'

const state = vi.hoisted(() => {
  const conversations = new Map<string, any>()
  return {
    conversations,
    nativeToken: 't'.repeat(43),
    agentChat: vi.fn(),
    appendMessages: vi.fn(),
    executeExtraction: vi.fn(async () => []),
    getLocaleState: vi.fn(),
    updateLocalePreference: vi.fn(),
    localeState: { preference: 'system', locale: 'zh-CN' },
    autoMemoryEnabled: false,
    currentRoleName: 'general',
    appFollowingEnabled: true,
    disabledApps: [] as string[],
    setAppFollowingEnabled: vi.fn(),
    setDisabledApps: vi.fn(),
    updateConversationRole: vi.fn(async (id: string, role: string) => {
      const conversation = conversations.get(id)
      if (!conversation || (conversation.messages?.length ?? 0) > 0) return false
      conversation.role = role
      // 与真实 conversation-store 一致：写成功即广播，否则这条链路在测试里是断的
      const { publishConversationChange } = await import('../../src/main/conversation-events')
      publishConversationChange(id, 'persona')
      return true
    }),
    updateConversationWorkspace: vi.fn(async (id: string, workspaceId: string | undefined) => {
      const conversation = conversations.get(id)
      if (!conversation || (conversation.messages?.length ?? 0) > 0) return false
      if (workspaceId) conversation.workspaceId = workspaceId
      else delete conversation.workspaceId
      // 与真实 conversation-store 一致：不广播的话，"切自定义 Agent 会即时推送"
      // 这条链路删掉生产代码里那行也没有测试会红
      const { publishConversationChange } = await import('../../src/main/conversation-events')
      publishConversationChange(id, 'persona')
      return true
    }),
    mutateConversationConfig: vi.fn(async (id: string, mutate: (config: any) => any) => {
      const conversation = conversations.get(id)
      if (!conversation) return false
      const next = mutate({ ...(conversation.config || {}) })
      if (!next) return false
      conversation.config = next
      return true
    }),
    updateConversationConfig: vi.fn(async (id: string, config: any) => {
      const conversation = conversations.get(id)
      if (!conversation) return false
      conversation.config = config
      return true
    })
  }
})

vi.mock('../../src/main/agent-runtime', () => ({
  getAgentRuntime: async () => ({ agentChat: state.agentChat })
}))

vi.mock('../../src/main/agent-overrides', () => ({
  resolveAgentOverrides: vi.fn(() => undefined)
}))

vi.mock('../../src/main/conversation-store', () => ({
  listConversations: vi.fn(() => []),
  createConversation: vi.fn(),
  getConversationMessages: vi.fn(() => []),
  getConversationMessagesSerialized: vi.fn(async () => []),
  getConversation: vi.fn((id: string) => state.conversations.get(id) || null),
  appendMessages: state.appendMessages,
  deleteConversation: vi.fn(async () => true),
  updateConversationTitle: vi.fn(async () => true),
  updateConversationRole: state.updateConversationRole,
  updateConversationWorkspace: state.updateConversationWorkspace,
  updateConversationConfig: state.updateConversationConfig,
  mutateConversationConfig: state.mutateConversationConfig,
  replaceMessages: vi.fn(async () => true),
  shouldReplayStoredMessage: vi.fn(() => true)
}))

vi.mock('../../src/main/config-manager', () => ({
  isAutoMemoryEnabled: vi.fn(() => state.autoMemoryEnabled),
  getEffectiveModelConfig: vi.fn(),
  saveModelConfig: vi.fn(),
  getProviders: vi.fn(() => []),
  testConnection: vi.fn(),
  hasApiKey: vi.fn(() => false),
  isUserCustomConfig: vi.fn(() => false),
  clearModelConfig: vi.fn()
}))

vi.mock('../../src/main/locale-manager', () => ({
  getLocaleState: state.getLocaleState,
  updateLocalePreference: state.updateLocalePreference
}))

vi.mock('../../src/main/memory-extractor', () => ({ executeExtraction: state.executeExtraction }))
vi.mock('../../src/main/memory-store', () => ({
  listArchivedMemories: vi.fn(() => []),
  restoreArchivedMemory: vi.fn(() => false),
  getGlobalMemoryDir: vi.fn(() => '/tmp/openpipal-test-memory'),
  isWithinMemoryRoot: vi.fn(() => false)
}))
vi.mock('../../src/main/role-manager', () => ({
  initRoles: vi.fn(),
  switchRole: vi.fn(),
  getAllRoles: vi.fn(() => []),
  getCurrentRole: vi.fn(() => ({ name: state.currentRoleName })),
  getRoleConfig: vi.fn((roleName: string) => ['general', 'design', 'office', 'learner', 'teacher', 'translator'].includes(roleName)
    ? { name: roleName }
    : null),
  getRoleAssetsDir: vi.fn(() => '/tmp'),
  getDisabledApps: vi.fn(() => state.disabledApps),
  getDetectedApps: vi.fn(() => []),
  getDetectedAppLabels: vi.fn(() => ({})),
  isAppFollowingEnabled: vi.fn(() => state.appFollowingEnabled),
  setAppFollowingEnabled: state.setAppFollowingEnabled,
  setDisabledApps: state.setDisabledApps
}))
vi.mock('../../src/main/skill-manager', () => ({
  listSkillsMeta: vi.fn(() => [{ name: 'docx-render', description: '生成 Word', enabled: true }])
}))
vi.mock('../../src/main/agent-workspace-store', () => ({
  listWorkspaces: vi.fn(() => [{ id: 'agent-1', name: '我的法务助手' }]),
  getWorkspace: vi.fn((id: string) => (id === 'agent-1' ? { id, agentMd: '', memories: [] } : null))
}))
vi.mock('../../src/main/app-detector', () => ({ BROWSER_APPS: new Set<string>() }))
vi.mock('../../src/main/extension-page', () => ({
  getExtensionPageHtml: vi.fn((locale: string) => `extension:${locale}`)
}))
vi.mock('../../src/main/browser-control', () => ({ attachBrowserControlWss: vi.fn() }))
vi.mock('../../src/main/browser-policy-store', () => ({ setActiveBrowserUrl: vi.fn() }))
vi.mock('../../src/main/pdf-context', () => ({
  resolvePdfIntoCache: vi.fn(async () => undefined),
  fillPdfPageContentFromCache: vi.fn()
}))
vi.mock('../../src/main/mcp-manager', () => ({
  registerSessionMcpServers: vi.fn(async () => ({ registrations: [] })),
  unregisterSessionMcpServers: vi.fn(async () => undefined)
}))
vi.mock('../../src/main/acp-auth', () => ({
  ACP_MCP_AUTH_HEADER: 'x-openpipal-acp-token',
  ensureAcpMcpToken: vi.fn(() => state.nativeToken),
  isAcpMcpTokenValid: vi.fn((supplied: unknown) => supplied === state.nativeToken)
}))
vi.mock('../../src/main/browser-context-store', () => ({
  getBrowserContext: vi.fn(() => null),
  markExtensionActive: vi.fn(),
  setBrowserContext: vi.fn()
}))

import {
  setInlinePermissionResolver,
  startHttpServer,
  writePermissionToStream
} from '../../src/main/http-server'
import {
  publishConversationChange,
  resetConversationChangeListeners,
  subscribeConversationChanges
} from '../../src/main/conversation-events'
import {
  acquireConversationExecution,
  getConversationExecution
} from '../../src/main/conversation-execution-coordinator'

let server: Server | undefined
let browserToken = ''
const extensionOrigin = `chrome-extension://${'a'.repeat(32)}`

async function listen(): Promise<string> {
  server = startHttpServer(0)
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('HTTP test server did not bind a TCP port')
  const base = `http://127.0.0.1:${address.port}`
  const session = await fetch(`${base}/extension/session`, {
    method: 'POST',
    headers: { Origin: extensionOrigin }
  })
  if (!session.ok) throw new Error(`Failed to establish browser test session: ${session.status}`)
  browserToken = String((await session.json() as { token?: string }).token || '')
  return base
}

async function closeServer(): Promise<void> {
  if (!server) return
  const current = server
  server = undefined
  current.closeAllConnections()
  await new Promise<void>((resolve) => current.close(() => resolve()))
}

async function rawHttp(port: number, request: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: '127.0.0.1', port })
    let response = ''
    socket.setEncoding('utf8')
    socket.once('error', reject)
    socket.on('data', (chunk: string) => { response += chunk })
    socket.once('end', () => {
      const status = Number(/^HTTP\/1\.1\s+(\d{3})\b/.exec(response)?.[1])
      if (!Number.isInteger(status)) {
        reject(new Error(`Raw HTTP response did not include a status: ${response}`))
        return
      }
      resolve({ status, body: response })
    })
    socket.once('connect', () => socket.end(request))
  })
}

function eventsFrom(body: string): any[] {
  return body
    .split('\n')
    .filter(line => line.startsWith('data: '))
    .map(line => JSON.parse(line.slice(6)))
}

function chatHeaders(source: 'extension' | 'acp'): Record<string, string> {
  return source === 'acp'
    ? { 'Content-Type': 'application/json', 'X-OpenPipal-ACP-Token': state.nativeToken }
    : { 'Content-Type': 'application/json', 'X-OpenPipal-Browser-Token': browserToken }
}

async function* finiteEvents(events: AgentEvent[]): AsyncGenerator<AgentEvent> {
  for (const event of events) yield event
}

beforeEach(() => {
  state.conversations.clear()
  state.agentChat.mockReset()
  state.appendMessages.mockReset()
  state.executeExtraction.mockClear()
  state.localeState = { preference: 'system', locale: 'zh-CN' }
  state.getLocaleState.mockReset().mockImplementation(() => ({ ...state.localeState }))
  state.updateLocalePreference.mockReset().mockImplementation((preference: 'system' | 'zh-CN' | 'en') => {
    state.localeState = {
      preference,
      locale: preference === 'system' ? 'zh-CN' : preference
    }
    return { ...state.localeState }
  })
  state.autoMemoryEnabled = false
  state.currentRoleName = 'general'
  state.appFollowingEnabled = true
  state.disabledApps = ['Xcode']
  state.setAppFollowingEnabled.mockReset().mockImplementation((enabled: boolean) => {
    state.appFollowingEnabled = enabled
  })
  state.setDisabledApps.mockReset().mockImplementation((apps: string[]) => {
    state.disabledApps = apps
  })
  state.updateConversationRole.mockClear()
  state.updateConversationConfig.mockClear()
  state.appendMessages.mockResolvedValue(true)
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(async () => {
  // 订阅是进程级的：不在每个用例后清干净，SSE 用例的订阅者会活到后面的用例里
  resetConversationChangeListeners()
  setInlinePermissionResolver(null)
  await closeServer()
  vi.restoreAllMocks()
})

describe('/chat/stream HTTP and ACP safety', () => {
  it('rejects malformed raw request targets without taking down the local server', async () => {
    const base = await listen()
    const port = Number(new URL(base).port)
    const malformed = await rawHttp(port, [
      'GET http://[::1 HTTP/1.1',
      `Host: 127.0.0.1:${port}`,
      'Connection: close',
      '',
      ''
    ].join('\r\n'))
    const rejectedHost = await rawHttp(port, [
      'GET http://[::1 HTTP/1.1',
      `Host: openpipal.invalid:${port}`,
      'Connection: close',
      '',
      ''
    ].join('\r\n'))

    expect(malformed.status).toBe(400)
    expect(rejectedHost.status).toBe(421)

    const health = await fetch(`${base}/health`)
    expect(health.status).toBe(200)
    await expect(health.json()).resolves.toMatchObject({ status: 'ok', app: 'openpipal' })
  })

  it('serves the same bounded locale contract to browser and native principals', async () => {
    const base = await listen()

    const browserState = await fetch(`${base}/api/locale`, {
      headers: chatHeaders('extension')
    })
    expect(browserState.status).toBe(200)
    await expect(browserState.json()).resolves.toEqual({ preference: 'system', locale: 'zh-CN' })

    const browserUpdate = await fetch(`${base}/api/locale`, {
      method: 'PUT',
      headers: chatHeaders('extension'),
      body: JSON.stringify({ preference: 'en' })
    })
    expect(browserUpdate.status).toBe(200)
    await expect(browserUpdate.json()).resolves.toEqual({ preference: 'en', locale: 'en' })

    const nativeUpdate = await fetch(`${base}/api/locale`, {
      method: 'PUT',
      headers: chatHeaders('acp'),
      body: JSON.stringify({ preference: 'zh-CN' })
    })
    expect(nativeUpdate.status).toBe(200)
    await expect(nativeUpdate.json()).resolves.toEqual({ preference: 'zh-CN', locale: 'zh-CN' })
    expect(state.updateLocalePreference.mock.calls.map(call => call[0])).toEqual(['en', 'zh-CN'])
  })

  it('renders the extension guide from the current locale without caching it', async () => {
    const base = await listen()
    state.localeState = { preference: 'en', locale: 'en' }

    const response = await fetch(`${base}/extension`)

    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8')
    await expect(response.text()).resolves.toBe('extension:en')
  })

  it('rejects invalid, expanded, and oversized locale writes before persistence', async () => {
    const base = await listen()
    const request = (body: string) => fetch(`${base}/api/locale`, {
      method: 'PUT',
      headers: chatHeaders('extension'),
      body
    })

    const invalid = await request(JSON.stringify({ preference: 'fr' }))
    const expanded = await request(JSON.stringify({ preference: 'en', config: true }))
    const malformed = await request('{"preference":')
    const oversized = await request(JSON.stringify({ preference: 'en', padding: 'x'.repeat(300) }))
    const wrongMethod = await fetch(`${base}/api/locale`, {
      method: 'POST',
      headers: chatHeaders('extension'),
      body: JSON.stringify({ preference: 'en' })
    })

    expect([invalid.status, expanded.status, malformed.status, oversized.status, wrongMethod.status])
      .toEqual([400, 400, 400, 413, 403])
    expect(state.updateLocalePreference).not.toHaveBeenCalled()
  })

  it('serves and strictly updates the app-following contract without changing per-app choices', async () => {
    const base = await listen()
    const headers = chatHeaders('extension')

    const initial = await fetch(`${base}/settings/apps`, { headers })
    expect(initial.status).toBe(200)
    await expect(initial.json()).resolves.toMatchObject({ enabled: true, disabled: ['Xcode'] })

    const pause = await fetch(`${base}/settings/app-following`, {
      method: 'POST', headers, body: JSON.stringify({ enabled: false })
    })
    expect(pause.status).toBe(200)
    await expect(pause.json()).resolves.toEqual({ ok: true, enabled: false })
    expect(state.setAppFollowingEnabled).toHaveBeenCalledWith(false)
    expect(state.disabledApps).toEqual(['Xcode'])

    for (const body of [
      JSON.stringify({ enabled: 'false' }),
      JSON.stringify({ enabled: false, extra: true }),
      JSON.stringify(false)
    ]) {
      const invalid = await fetch(`${base}/settings/app-following`, { method: 'POST', headers, body })
      expect(invalid.status).toBe(400)
    }
    const oversized = await fetch(`${base}/settings/app-following`, {
      method: 'POST', headers, body: JSON.stringify({ enabled: false, padding: 'x'.repeat(300) })
    })
    expect(oversized.status).toBe(413)

    state.setAppFollowingEnabled.mockImplementationOnce(() => { throw new Error('disk full') })
    const failedSave = await fetch(`${base}/settings/app-following`, {
      method: 'POST', headers, body: JSON.stringify({ enabled: true })
    })
    expect(failedSave.status).toBe(500)
    await expect(failedSave.json()).resolves.toEqual({ error: 'Unable to save app following setting' })
    expect(state.setAppFollowingEnabled).toHaveBeenCalledTimes(2)
  })

  it('persists the browser config snapshot before Runtime sees the first turn', async () => {
    const conversationId = 'extension-first-config'
    const conversationConfig = {
      workingDir: '/tmp/openpipal-first-turn',
      modelPresetId: 'preset-browser',
      roleBrief: { design: { taskType: '网页' } }
    }
    state.conversations.set(conversationId, {
      id: conversationId,
      role: 'design',
      config: { modelPresetId: 'stale-preset' },
      messages: []
    })
    state.agentChat.mockImplementation(() => finiteEvents([{ type: 'text', content: 'ok' }]))

    const base = await listen()
    const response = await fetch(`${base}/chat/stream`, {
      method: 'POST',
      headers: chatHeaders('extension'),
      body: JSON.stringify({
        source: 'extension',
        conversationId,
        conversationConfig,
        messages: [{ role: 'user', content: '使用刚选的配置' }]
      })
    })
    const events = eventsFrom(await response.text())

    expect(response.status).toBe(200)
    expect(events.map(event => event.type)).toEqual(['text', 'done'])
    expect(state.updateConversationConfig).toHaveBeenCalledWith(conversationId, conversationConfig)
    expect(state.conversations.get(conversationId)?.config).toEqual(conversationConfig)
    expect(state.updateConversationConfig.mock.invocationCallOrder[0])
      .toBeLessThan(state.agentChat.mock.invocationCallOrder[0])
  })

  it('supports browser role selection only while the conversation is empty', async () => {
    const conversationId = 'extension-role-selection'
    state.conversations.set(conversationId, {
      id: conversationId,
      role: 'general',
      config: {},
      messages: []
    })

    const base = await listen()
    const first = await fetch(`${base}/api/conversations/${conversationId}`, {
      method: 'PATCH',
      headers: chatHeaders('extension'),
      body: JSON.stringify({ role: 'design' })
    })
    expect(first.status).toBe(200)
    expect(state.updateConversationRole).toHaveBeenCalledWith(conversationId, 'design')
    expect(state.conversations.get(conversationId)?.role).toBe('design')

    state.conversations.get(conversationId).messages.push({ role: 'user', content: 'started' })
    const locked = await fetch(`${base}/api/conversations/${conversationId}`, {
      method: 'PATCH',
      headers: chatHeaders('extension'),
      body: JSON.stringify({ role: 'general' })
    })
    expect(locked.status).toBe(409)
    expect(state.conversations.get(conversationId)?.role).toBe('design')
  })

  it('switches a conversation between a builtin role and a saved agent, and locks both after the first message', async () => {
    const conversationId = 'persona-switch'
    state.conversations.set(conversationId, { id: conversationId, role: 'learner', config: {}, messages: [] })
    const base = await listen()
    const patch = (body: Record<string, unknown>): Promise<Response> => fetch(
      `${base}/api/conversations/${conversationId}`,
      { method: 'PATCH', headers: chatHeaders('acp'), body: JSON.stringify(body) }
    )

    expect((await patch({ workspaceId: 'agent-1' })).status).toBe(200)
    expect(state.conversations.get(conversationId).workspaceId).toBe('agent-1')

    // 未知 Agent 在落盘前就被挡掉
    expect((await patch({ workspaceId: 'agent-nope' })).status).toBe(400)
    expect(state.conversations.get(conversationId).workspaceId).toBe('agent-1')

    // 切回内置角色必须同时清空绑定，否则 workspace 的 systemPrompt 仍然压过角色
    expect((await patch({ role: 'design', workspaceId: null })).status).toBe(200)
    expect(state.conversations.get(conversationId).workspaceId).toBeUndefined()
    expect(state.conversations.get(conversationId).role).toBe('design')

    // 开聊之后人格锁定,与 role 同一把锁
    state.conversations.get(conversationId).messages = [{ role: 'user', content: 'hi' }]
    const locked = await patch({ workspaceId: 'agent-1' })
    expect(locked.status).toBe(409)
    expect((await locked.json() as { error: string }).error).toContain('locked after the first message')
    expect(state.conversations.get(conversationId).workspaceId).toBeUndefined()
  })

  it('pushes conversation changes to a native subscriber and refuses the browser principal', async () => {
    const conversationId = 'push-channel'
    state.conversations.set(conversationId, { id: conversationId, role: 'learner', config: {}, messages: [] })
    const base = await listen()

    // 浏览器主体拿不到这条通道（它有自己的 SSE，不该再多一条全局广播）
    expect((await fetch(`${base}/api/acp/events`, { headers: chatHeaders('extension') })).status).toBe(403)

    const abort = new AbortController()
    const response = await fetch(`${base}/api/acp/events`, {
      headers: { 'X-OpenPipal-ACP-Token': state.nativeToken },
      signal: abort.signal
    })
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('text/event-stream')

    const reader = response.body!.getReader()
    const decoder = new TextDecoder()
    let buffered = ''
    const readUntil = async (needle: string): Promise<void> => {
      while (!buffered.includes(needle)) {
        const { value, done } = await reader.read()
        if (done) throw new Error(`stream ended before ${needle}`)
        buffered += decoder.decode(value, { stream: true })
      }
    }

    // 先给 ready：适配器据此确认通道真的建起来了
    await readUntil('"type":"ready"')

    await fetch(`${base}/api/conversations/${conversationId}`, {
      method: 'PATCH',
      headers: chatHeaders('acp'),
      body: JSON.stringify({ role: 'design' })
    })
    await readUntil('"type":"conversation_changed"')

    // 切自定义 Agent 走的是另一个写函数（updateConversationWorkspace），同样要推——
    // 只测 role 的话，把生产代码里那行 publish 删掉也没有测试会红
    await fetch(`${base}/api/conversations/${conversationId}`, {
      method: 'PATCH',
      headers: chatHeaders('acp'),
      body: JSON.stringify({ workspaceId: 'agent-1' })
    })
    const parsePushes = (): Array<Record<string, unknown>> => buffered
      .split('\n')
      .filter(line => line.startsWith('data: '))
      .map(line => JSON.parse(line.slice(6)))
      .filter(event => event.type === 'conversation_changed')
    while (parsePushes().length < 2) {
      const { value, done } = await reader.read()
      if (done) throw new Error('stream ended before the agent-switch push')
      buffered += decoder.decode(value, { stream: true })
    }
    expect(parsePushes()).toEqual([
      { type: 'conversation_changed', conversationId, kind: 'persona' },
      { type: 'conversation_changed', conversationId, kind: 'persona' }
    ])

    abort.abort()
    await reader.cancel().catch(() => undefined)
  })

  it('never lets a broken subscriber escape into the conversation write path', () => {
    const healthy = vi.fn()
    subscribeConversationChanges(() => { throw new Error('subscriber exploded') })
    subscribeConversationChanges(healthy)

    // 发布点在 conversation-store 的写函数里：这里抛出去就会把落盘一起带走
    expect(() => publishConversationChange('conv-1', 'persona')).not.toThrow()
    expect(healthy).toHaveBeenCalledWith({ conversationId: 'conv-1', kind: 'persona' })
  })

  it('refuses a workspaceId that would escape the agents directory before listing skills', async () => {
    const base = await listen()
    const ask = (query: string): Promise<Response> => fetch(
      `${base}/api/skills${query}`,
      { headers: chatHeaders('acp') }
    )

    // workspaceId 会被拼进 dataPath('agents', id, 'skills')——不校验就能读到数据目录外面
    expect((await ask('?workspaceId=..%2F..%2F..%2F..%2Ftmp')).status).toBe(400)
    expect((await ask('?workspaceId=agent-nope')).status).toBe(400)

    const known = await ask('?workspaceId=agent-1')
    expect(known.status).toBe(200)
    expect((await known.json() as { skills: unknown[] }).skills).toHaveLength(1)
  })

  it('validates every field of a conversation PATCH before writing any of them', async () => {
    const conversationId = 'patch-atomic'
    state.conversations.set(conversationId, { id: conversationId, role: 'learner', config: {}, messages: [] })
    const base = await listen()

    // 半写：role 先落盘、再发现 workspaceId 非法 → 用户看到 400 但人格已经变了
    const response = await fetch(`${base}/api/conversations/${conversationId}`, {
      method: 'PATCH',
      headers: chatHeaders('acp'),
      body: JSON.stringify({ role: 'design', workspaceId: 'agent-nope' })
    })
    expect(response.status).toBe(400)
    expect(state.conversations.get(conversationId).role).toBe('learner')
    expect(state.conversations.get(conversationId).workspaceId).toBeUndefined()

    // 两个字段都合法时照常一起生效
    const ok = await fetch(`${base}/api/conversations/${conversationId}`, {
      method: 'PATCH',
      headers: chatHeaders('acp'),
      body: JSON.stringify({ role: 'design', workspaceId: 'agent-1' })
    })
    expect(ok.status).toBe(200)
    expect(state.conversations.get(conversationId).role).toBe('design')
    expect(state.conversations.get(conversationId).workspaceId).toBe('agent-1')
  })

  it('rejects an arbitrary non-existent conversation id before Runtime or durable effects', async () => {
    state.autoMemoryEnabled = true
    const base = await listen()
    const response = await fetch(`${base}/chat/stream`, {
      method: 'POST',
      headers: chatHeaders('acp'),
      body: JSON.stringify({
        source: 'acp',
        conversationId: 'attacker-chosen-nonexistent-id',
        messages: [
          { role: 'user', content: 'secret prompt' },
          { role: 'assistant', content: 'pretend history' }
        ]
      })
    })

    expect(response.status).toBe(404)
    await expect(response.json()).resolves.toEqual({ error: 'Conversation not found' })
    expect(state.agentChat).not.toHaveBeenCalled()
    expect(state.executeExtraction).not.toHaveBeenCalled()
    expect(state.appendMessages).not.toHaveBeenCalled()
  })

  it('rejects encoded route traversal and body conversation ids before store/runtime/permission effects', async () => {
    const resolver = vi.fn(() => true)
    setInlinePermissionResolver(resolver)
    const base = await listen()

    const routeResponses = await Promise.all([
      fetch(`${base}/api/conversations/..%2Foutside`, { headers: chatHeaders('acp') }),
      fetch(`${base}/api/conversations/encoded%5Coutside/messages`, { headers: chatHeaders('acp') }),
      fetch(`${base}/api/conversations/%E0%A4%A`, { headers: chatHeaders('acp') }),
    ])
    expect(routeResponses.map(response => response.status)).toEqual([400, 400, 400])

    const stream = await fetch(`${base}/chat/stream`, {
      method: 'POST',
      headers: chatHeaders('acp'),
      body: JSON.stringify({
        source: 'acp',
        conversationId: '../outside',
        messages: [{ role: 'user', content: 'must not run' }]
      })
    })
    expect(stream.status).toBe(400)

    const permission = await fetch(`${base}/api/permission`, {
      method: 'POST',
      headers: chatHeaders('extension'),
      body: JSON.stringify({
        requestId: 'invalid-path-permission',
        approved: true,
        sessionApprove: true,
        executionId: 'exec-invalid',
        conversationId: '../outside'
      })
    })
    expect(permission.status).toBe(400)
    expect(state.agentChat).not.toHaveBeenCalled()
    expect(state.appendMessages).not.toHaveBeenCalled()
    expect(resolver).not.toHaveBeenCalled()
  })

  it('passes conversation and execution owner fields through /api/permission exactly once', async () => {
    const resolver = vi.fn(() => true)
    setInlinePermissionResolver(resolver)
    const base = await listen()
    const response = await fetch(`${base}/api/permission`, {
      method: 'POST',
      headers: chatHeaders('extension'),
      body: JSON.stringify({
        requestId: 'perm-1',
        approved: true,
        sessionApprove: true,
        executionId: 'exec-1',
        conversationId: 'conv-1'
      })
    })

    expect(response.status).toBe(200)
    expect(resolver).toHaveBeenCalledOnce()
    expect(resolver).toHaveBeenCalledWith('perm-1', true, true, 'exec-1', 'conv-1')
  })

  it('routes permission SSE to the owning HTTP stream (extension or ACP) and never to a mismatched owner', async () => {
    const extensionConversation = 'extension-permission'
    const acpConversation = 'acp-permission'
    state.conversations.set(extensionConversation, { id: extensionConversation, config: {}, messages: [] })
    state.conversations.set(acpConversation, { id: acpConversation, config: {}, messages: [] })
    state.agentChat.mockImplementation((_messages: unknown, _signal: AbortSignal, source: string) => (
      async function* (): AsyncGenerator<AgentEvent> {
        const conversationId = source === 'extension' ? extensionConversation : acpConversation
        const executionId = getConversationExecution(conversationId)?.executionId
        const wrongOwnerRouted = writePermissionToStream(conversationId, {
          requestId: `wrong-permission-${source}`,
          conversationId,
          executionId: 'wrong-owner'
        })
        const routed = writePermissionToStream(conversationId, {
          requestId: `permission-${source}`,
          conversationId,
          executionId
        })
        yield { type: 'text', content: `${wrongOwnerRouted}/${routed}` }
      }
    )())

    const base = await listen()
    const request = async (source: 'extension' | 'acp', conversationId: string) => {
      const response = await fetch(`${base}/chat/stream`, {
        method: 'POST',
        headers: chatHeaders(source),
        body: JSON.stringify({ source, conversationId, messages: [{ role: 'user', content: '权限路由' }] })
      })
      return eventsFrom(await response.text())
    }
    const extensionEvents = await request('extension', extensionConversation)
    const acpEvents = await request('acp', acpConversation)

    expect(extensionEvents.map(event => event.type)).toEqual(['permission', 'text', 'done'])
    expect(extensionEvents.find(event => event.type === 'text')?.content).toBe('false/true')
    // ACP 现在也在自己的流上确认（适配器反向调 session/request_permission），
    // 但 owner 不匹配的那次仍然必须被挡掉。
    expect(acpEvents.map(event => event.type)).toEqual(['permission', 'text', 'done'])
    expect(acpEvents.find(event => event.type === 'text')?.content).toBe('false/true')
  })

  it('accepts a native permission response only from its own live ACP stream', async () => {
    const conversationId = 'acp-permission-response'
    state.conversations.set(conversationId, { id: conversationId, config: {}, messages: [] })
    const resolver = vi.fn(() => true)
    setInlinePermissionResolver(resolver)
    const base = await listen()

    const statuses: Record<string, number> = {}
    let executionId = ''
    state.agentChat.mockImplementation(() => (async function* (): AsyncGenerator<AgentEvent> {
      executionId = getConversationExecution(conversationId)?.executionId || ''
      const post = (body: Record<string, unknown>): Promise<number> => fetch(`${base}/api/permission`, {
        method: 'POST',
        headers: chatHeaders('acp'),
        body: JSON.stringify(body)
      }).then(response => response.status)
      statuses.wrongExecution = await post({ requestId: 'p1', approved: true, executionId: 'not-this-run', conversationId })
      statuses.otherConversation = await post({ requestId: 'p1', approved: true, executionId, conversationId: 'someone-else' })
      statuses.noExecution = await post({ requestId: 'p1', approved: true, conversationId })
      statuses.own = await post({ requestId: 'p1', approved: true, sessionApprove: true, executionId, conversationId })
      yield { type: 'text', content: 'ok' }
    })())

    const response = await fetch(`${base}/chat/stream`, {
      method: 'POST',
      headers: chatHeaders('acp'),
      body: JSON.stringify({ source: 'acp', conversationId, messages: [{ role: 'user', content: '授权回传' }] })
    })
    await response.text()

    expect(statuses).toEqual({ wrongExecution: 403, otherConversation: 403, noExecution: 403, own: 200 })
    expect(resolver).toHaveBeenCalledOnce()
    expect(resolver).toHaveBeenCalledWith('p1', true, true, executionId, conversationId)

    // 流已经结束：同一条裁决不再被接受，native 令牌也不行
    const afterStream = await fetch(`${base}/api/permission`, {
      method: 'POST',
      headers: chatHeaders('acp'),
      body: JSON.stringify({ requestId: 'p1', approved: true, executionId, conversationId })
    })
    expect(afterStream.status).toBe(403)
    expect(resolver).toHaveBeenCalledOnce()
  })

  it('rejects untrusted, desktop, and transport-mismatched HTTP chat sources before Runtime', async () => {
    const base = await listen()
    const attempts = [
      fetch(`${base}/chat/stream`, {
        method: 'POST',
        headers: chatHeaders('extension'),
        body: JSON.stringify({ source: 'desktop', messages: [] })
      }),
      fetch(`${base}/chat`, {
        method: 'POST',
        headers: chatHeaders('extension'),
        body: JSON.stringify({ source: 'not-a-source', messages: [] })
      }),
      fetch(`${base}/chat/stream`, {
        method: 'POST',
        headers: chatHeaders('extension'),
        body: JSON.stringify({ source: 'acp', messages: [] })
      }),
      fetch(`${base}/chat`, {
        method: 'POST',
        headers: chatHeaders('acp'),
        body: JSON.stringify({ source: 'extension', messages: [] })
      }),
      fetch(`${base}/chat/stream`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-OpenPipal-ACP-Token': 'w'.repeat(43) },
        body: JSON.stringify({ source: 'acp', messages: [] })
      })
    ]

    const responses = await Promise.all(attempts)
    expect(responses.map(response => response.status)).toEqual([400, 403, 403, 400, 403])
    expect(state.agentChat).not.toHaveBeenCalled()
  })

  it('downgrades stateless HTTP session approval to one-shot approval', async () => {
    const resolver = vi.fn(() => true)
    setInlinePermissionResolver(resolver)
    const base = await listen()
    const response = await fetch(`${base}/api/permission`, {
      method: 'POST',
      headers: chatHeaders('extension'),
      body: JSON.stringify({
        requestId: 'stateless-permission',
        approved: true,
        sessionApprove: true,
        executionId: 'stateless-execution'
      })
    })

    expect(response.status).toBe(200)
    expect(resolver).toHaveBeenCalledWith(
      'stateless-permission', true, false, 'stateless-execution', undefined
    )
  })

  it('returns 409 when the same conversation is owned by another process entrypoint', async () => {
    const conversationId = 'desktop-owned'
    state.conversations.set(conversationId, { id: conversationId, config: {}, messages: [] })
    const desktop = await acquireConversationExecution({
      conversationId,
      owner: { entrypoint: 'desktop', ownerId: 'renderer' },
      policy: 'supersede'
    })

    try {
      const base = await listen()
      const response = await fetch(`${base}/chat/stream`, {
        method: 'POST',
        headers: chatHeaders('acp'),
        body: JSON.stringify({
          source: 'acp', conversationId,
          messages: [{ role: 'user', content: '不应启动' }]
        })
      })

      expect(response.status).toBe(409)
      await expect(response.json()).resolves.toEqual({ error: 'Conversation already has an active stream' })
      expect(state.agentChat).not.toHaveBeenCalled()
    } finally {
      desktop.release()
    }
  })

  it('lets a newer desktop turn supersede HTTP without overlapping or persisting a partial ACP success', async () => {
    const conversationId = 'desktop-supersedes-http'
    state.conversations.set(conversationId, { id: conversationId, config: {}, messages: [] })
    let started!: () => void
    const agentStarted = new Promise<void>(resolve => { started = resolve })
    state.agentChat.mockImplementation((_messages: unknown, signal: AbortSignal) => (
      async function* (): AsyncGenerator<AgentEvent> {
        yield { type: 'text', content: '部分输出' }
        started()
        await new Promise<void>(resolve => {
          if (signal.aborted) resolve()
          else signal.addEventListener('abort', () => resolve(), { once: true })
        })
      }
    )())

    const base = await listen()
    const response = await fetch(`${base}/chat/stream`, {
      method: 'POST',
      headers: chatHeaders('acp'),
      body: JSON.stringify({
        source: 'acp', conversationId,
        messages: [{ role: 'user', content: '旧 HTTP 回合' }]
      })
    })
    await agentStarted

    const desktopPending = acquireConversationExecution({
      conversationId,
      owner: { entrypoint: 'desktop', ownerId: 'renderer' },
      policy: 'supersede'
    })
    const events = eventsFrom(await response.text())
    const desktop = await desktopPending

    try {
      expect(events.map(event => event.type)).toEqual(['text', 'error'])
      expect(events.some(event => event.type === 'done')).toBe(false)
      expect(state.appendMessages).not.toHaveBeenCalled()
    } finally {
      desktop.release()
    }
  })

  it('persists goal_update before completing the HTTP stream and preserves other config', async () => {
    const conversationId = 'goal-conversation'
    const goal = {
      text: '完成架构迁移', status: 'done' as const, turnsUsed: 2, maxTurns: 8,
      consecutiveBlocks: 0, createdAt: 1
    }
    state.conversations.set(conversationId, {
      id: conversationId,
      config: { workingDir: '/tmp/work', projectName: 'OpenPipal' },
      messages: []
    })
    state.agentChat.mockImplementation(() => finiteEvents([
      { type: 'goal_update', goal },
      { type: 'text', content: '完成' }
    ]))

    const base = await listen()
    const response = await fetch(`${base}/chat/stream`, {
      method: 'POST',
      headers: chatHeaders('acp'),
      body: JSON.stringify({
        source: 'acp', conversationId,
        messages: [{ role: 'user', content: '继续' }]
      })
    })
    const events = eventsFrom(await response.text())

    expect(response.status).toBe(200)
    expect(events.map(event => event.type)).toEqual(['goal_update', 'text', 'done'])
    // 落盘走加锁的读改写：并发的 /goal clear 等写入不会被整份快照盖掉，
    // 而 config 里原有的字段也必须原样保留
    expect(state.conversations.get(conversationId).config).toEqual({
      workingDir: '/tmp/work', projectName: 'OpenPipal', goal
    })
    expect(state.appendMessages).toHaveBeenCalledOnce()
    expect(state.mutateConversationConfig.mock.invocationCallOrder[0])
      .toBeLessThan(state.appendMessages.mock.invocationCallOrder[0])
  })

  it('awaits ACP transcript persistence and emits error without a fake done on failure', async () => {
    const conversationId = 'persist-failure'
    state.conversations.set(conversationId, { id: conversationId, config: {}, messages: [] })
    state.agentChat.mockImplementation(() => finiteEvents([{ type: 'text', content: '尚未写稳' }]))
    state.appendMessages.mockRejectedValueOnce(new Error('disk full'))

    const base = await listen()
    const response = await fetch(`${base}/chat/stream`, {
      method: 'POST',
      headers: chatHeaders('acp'),
      body: JSON.stringify({
        source: 'acp', conversationId,
        messages: [{ role: 'user', content: '保存这一轮' }]
      })
    })
    const events = eventsFrom(await response.text())

    expect(response.status).toBe(200)
    expect(events.map(event => event.type)).toEqual(['text', 'error'])
    expect(events.at(-1)).toMatchObject({
      type: 'error', content: 'disk full', conversationId
    })
    expect(events.some(event => event.type === 'done')).toBe(false)
    expect(console.error).toHaveBeenCalledWith('[HTTP] SSE streaming 错误:', 'disk full')
  })

  it('treats an AgentEvent.error as terminal and never persists a success transcript', async () => {
    const conversationId = 'runtime-error'
    state.conversations.set(conversationId, { id: conversationId, config: {}, messages: [] })
    let generatorClosed = false
    let runtimeSignal: AbortSignal | undefined
    state.agentChat.mockImplementation((_messages: unknown, signal: AbortSignal) => {
      runtimeSignal = signal
      return (async function* (): AsyncGenerator<AgentEvent> {
        try {
          yield { type: 'text', content: '失败前的部分输出' }
          yield { type: 'error', content: '模型运行失败' }
          yield { type: 'text', content: '不应继续输出' }
        } finally {
          generatorClosed = true
        }
      })()
    })

    const base = await listen()
    const response = await fetch(`${base}/chat/stream`, {
      method: 'POST',
      headers: chatHeaders('acp'),
      body: JSON.stringify({
        source: 'acp', conversationId,
        messages: [{ role: 'user', content: '执行这一轮' }]
      })
    })
    const events = eventsFrom(await response.text())

    expect(response.status).toBe(200)
    expect(events).toEqual([
      { type: 'text', content: '失败前的部分输出', conversationId },
      { type: 'error', content: '模型运行失败', conversationId }
    ])
    expect(events.filter(event => event.type === 'error')).toHaveLength(1)
    expect(events.some(event => event.type === 'done')).toBe(false)
    expect(state.appendMessages).not.toHaveBeenCalled()
    expect(runtimeSignal?.aborted).toBe(true)
    expect(generatorClosed).toBe(true)
  })

  it('rejects a concurrent stream for the same conversation with 409 and releases the lock afterwards', async () => {
    const conversationId = 'exclusive-conversation'
    state.conversations.set(conversationId, { id: conversationId, config: {}, messages: [] })

    let releaseFirst!: () => void
    const firstGate = new Promise<void>(resolve => { releaseFirst = resolve })
    let calls = 0
    state.agentChat.mockImplementation(() => {
      calls += 1
      if (calls === 1) {
        return (async function* (): AsyncGenerator<AgentEvent> {
          yield { type: 'thinking', content: '运行中' }
          await firstGate
          yield { type: 'text', content: '第一条完成' }
        })()
      }
      return finiteEvents([{ type: 'text', content: '后续完成' }])
    })

    const base = await listen()
    const firstResponse = await fetch(`${base}/chat/stream`, {
      method: 'POST',
      headers: chatHeaders('acp'),
      body: JSON.stringify({ source: 'acp', conversationId, messages: [{ role: 'user', content: 'first' }] })
    })

    const concurrent = await fetch(`${base}/chat/stream`, {
      method: 'POST',
      headers: chatHeaders('acp'),
      body: JSON.stringify({ source: 'acp', conversationId, messages: [{ role: 'user', content: 'second' }] })
    })
    expect(concurrent.status).toBe(409)
    await expect(concurrent.json()).resolves.toEqual({ error: 'Conversation already has an active stream' })
    expect(state.agentChat).toHaveBeenCalledOnce()

    releaseFirst()
    expect(eventsFrom(await firstResponse.text()).at(-1)).toMatchObject({ type: 'done' })

    const afterCompletion = await fetch(`${base}/chat/stream`, {
      method: 'POST',
      headers: chatHeaders('acp'),
      body: JSON.stringify({ source: 'acp', conversationId, messages: [{ role: 'user', content: 'third' }] })
    })
    expect(afterCompletion.status).toBe(200)
    expect(eventsFrom(await afterCompletion.text()).at(-1)).toMatchObject({ type: 'done' })
    expect(state.agentChat).toHaveBeenCalledTimes(2)
  })

  it('aborts on client disconnect but holds the conversation lock until transcript persistence settles', async () => {
    const conversationId = 'disconnect-conversation'
    state.conversations.set(conversationId, { id: conversationId, config: {}, messages: [] })

    let sawAbort!: () => void
    const aborted = new Promise<void>(resolve => { sawAbort = resolve })
    let finishPersistence!: (ok: boolean) => void
    const persistence = new Promise<boolean>(resolve => { finishPersistence = resolve })
    state.appendMessages.mockImplementationOnce(async (id: string, messages: any[]) => {
      const persisted = await persistence
      if (persisted) state.conversations.get(id)?.messages.push(...messages)
      return persisted
    }).mockResolvedValue(true)

    let calls = 0
    state.agentChat.mockImplementation((_messages: unknown, signal: AbortSignal) => {
      calls += 1
      if (calls === 1) {
        return (async function* (): AsyncGenerator<AgentEvent> {
          yield {
            type: 'tool_end', name: 'read', toolCallId: 'completed-read',
            mcpResult: '已完成的工具证据'
          }
          yield { type: 'text', content: '部分输出' }
          await new Promise<void>(resolve => {
            if (signal.aborted) {
              sawAbort()
              resolve()
              return
            }
            signal.addEventListener('abort', () => {
              sawAbort()
              resolve()
            }, { once: true })
          })
        })()
      }
      return finiteEvents([{ type: 'text', content: '重连完成' }])
    })

    const base = await listen()
    const controller = new AbortController()
    const first = await fetch(`${base}/chat/stream`, {
      method: 'POST',
      headers: chatHeaders('acp'),
      signal: controller.signal,
      body: JSON.stringify({ source: 'acp', conversationId, messages: [{ role: 'user', content: 'first' }] })
    })
    expect(first.status).toBe(200)
    controller.abort()
    await aborted
    await vi.waitFor(() => expect(state.appendMessages).toHaveBeenCalledOnce())
    expect(state.appendMessages.mock.calls[0][1].map((message: any) => message.role)).toEqual(['user', 'tool'])
    expect(state.appendMessages.mock.calls[0][1].some((message: any) => message.content === '部分输出')).toBe(false)
    expect(state.appendMessages.mock.calls[0][1].some((message: any) => message.content === '已完成的工具证据')).toBe(true)

    const whilePersisting = await fetch(`${base}/chat/stream`, {
      method: 'POST',
      headers: chatHeaders('acp'),
      body: JSON.stringify({ source: 'acp', conversationId, messages: [{ role: 'user', content: 'too soon' }] })
    })
    expect(whilePersisting.status).toBe(409)

    finishPersistence(true)
    await new Promise<void>(resolve => setImmediate(resolve))

    const afterPersistence = await fetch(`${base}/chat/stream`, {
      method: 'POST',
      headers: chatHeaders('acp'),
      body: JSON.stringify({ source: 'acp', conversationId, messages: [{ role: 'user', content: 'retry' }] })
    })
    expect(afterPersistence.status).toBe(200)
    expect(eventsFrom(await afterPersistence.text()).at(-1)).toMatchObject({ type: 'done' })
    const replayedMessages = state.agentChat.mock.calls[1][0] as Array<{ content?: string }>
    expect(replayedMessages.some(message => message.content === '部分输出')).toBe(false)
    expect(replayedMessages.some(message => message.content === '已完成的工具证据')).toBe(true)
  })

  it('keeps stateless extension streams independent and does not persist them as ACP transcripts', async () => {
    state.autoMemoryEnabled = true
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    state.agentChat.mockImplementation(() => (async function* (): AsyncGenerator<AgentEvent> {
      yield { type: 'thinking', content: '运行中' }
      await gate
      yield { type: 'text', content: '完成' }
    })())

    const base = await listen()
    const request = () => fetch(`${base}/chat/stream`, {
      method: 'POST',
      headers: chatHeaders('extension'),
      body: JSON.stringify({
        source: 'extension',
        messages: [
          { role: 'user', content: 'stateless' },
          { role: 'assistant', content: 'still stateless' }
        ]
      })
    })
    const [first, second] = await Promise.all([request(), request()])
    expect(first.status).toBe(200)
    expect(second.status).toBe(200)
    expect(state.agentChat).toHaveBeenCalledTimes(2)

    release()
    await Promise.all([first.text(), second.text()])
    expect(state.appendMessages).not.toHaveBeenCalled()
    expect(state.executeExtraction).not.toHaveBeenCalled()
  })

  it('pins each conversation role for memory extraction across concurrent global role changes', async () => {
    state.autoMemoryEnabled = true
    state.currentRoleName = 'global-before'
    state.conversations.set('role-a-conversation', {
      id: 'role-a-conversation', role: 'role-a', config: {}, messages: []
    })
    state.conversations.set('role-b-conversation', {
      id: 'role-b-conversation', role: 'role-b', config: {}, messages: []
    })
    let call = 0
    state.agentChat.mockImplementation(() => {
      state.currentRoleName = `global-during-${++call}`
      return finiteEvents([{ type: 'text', content: 'done' }])
    })

    const base = await listen()
    const run = async (conversationId: string) => {
      const response = await fetch(`${base}/chat/stream`, {
        method: 'POST',
        headers: chatHeaders('extension'),
        body: JSON.stringify({
          source: 'extension',
          conversationId,
          messages: [
            { role: 'user', content: 'remember role' },
            { role: 'assistant', content: 'role-specific history' }
          ]
        })
      })
      expect(response.status).toBe(200)
      await response.text()
    }

    await Promise.all([run('role-a-conversation'), run('role-b-conversation')])
    expect(state.executeExtraction).toHaveBeenCalledTimes(2)
    expect(state.executeExtraction.mock.calls.map(callArgs => [callArgs[1], callArgs[2]]))
      .toEqual(expect.arrayContaining([
        ['role-a-conversation', 'role-a'],
        ['role-b-conversation', 'role-b']
      ]))
  })
})

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createConversation,
  deleteConversation,
  getConversation,
  getConversationMessages,
  listAgents,
  listConversations,
  probeDesktop,
  registerSessionMcpServers,
  streamChat,
  unregisterSessionMcpServers,
  updateConversationRole,
} from '../../openpipal-acp/src/http-client'

const token = 'a'.repeat(43)
const received: Array<{
  method?: string
  path?: string
  token?: string
  source?: string
  role?: string
}> = []
const baseUrl = 'http://openpipal.test'
let previousToken: string | undefined

beforeAll(() => {
  previousToken = process.env.OPENPIPAL_ACP_TOKEN
  process.env.OPENPIPAL_ACP_TOKEN = token
})

beforeEach(() => {
  received.length = 0
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url)
    const headers = new Headers(init?.headers)
    const rawBody = typeof init?.body === 'string' ? init.body : ''
    const body = rawBody ? JSON.parse(rawBody) : undefined
    received.push({
      method: init?.method,
      path: url.pathname,
      token: headers.get('x-openpipal-acp-token') || undefined,
      source: body?.source,
      role: body?.role,
    })
    const responseBody = url.pathname === '/chat/stream'
      ? 'data: {"type":"done"}\n\n'
      : url.pathname === '/api/conversations' && init?.method === 'POST'
        ? JSON.stringify({ id: 'session-new', role: 'general' })
        : JSON.stringify({ registered: [], failed: [] })
    return new Response(responseBody, {
      status: 200,
      headers: {
        'Content-Type': url.pathname === '/chat/stream' ? 'text/event-stream' : 'application/json'
      }
    })
  }))
})

afterAll(() => {
  if (previousToken === undefined) delete process.env.OPENPIPAL_ACP_TOKEN
  else process.env.OPENPIPAL_ACP_TOKEN = previousToken
  vi.unstubAllGlobals()
})

describe('ACP HTTP client authorization', () => {
  it('sends the local token for chat and session MCP operations', async () => {
    const stream = await streamChat(
      { messages: [{ role: 'user', content: 'hello' }], conversationId: 'session-1' },
      new AbortController().signal,
      baseUrl,
    )
    await stream.cancel()
    await registerSessionMcpServers('session-1', [], baseUrl)
    await unregisterSessionMcpServers('session-1', baseUrl)

    expect(received).toEqual([
      { method: 'POST', path: '/chat/stream', token, source: 'acp' },
      { method: 'POST', path: '/api/acp/sessions/session-1/mcp', token, source: undefined },
      { method: 'DELETE', path: '/api/acp/sessions/session-1/mcp', token, source: undefined },
    ])
  })

  it('sends the native token for every dynamic ACP client route', async () => {
    await createConversation('new', baseUrl, { workingDir: '/tmp/acp-auth-contract' })
    await listConversations(baseUrl)
    await getConversation('session-1', baseUrl)
    await getConversationMessages('session-1', baseUrl)
    await deleteConversation('session-1', baseUrl)
    await updateConversationRole('session-1', 'general', baseUrl)
    await listAgents(baseUrl)

    expect(received.map(({ method, path, token: supplied }) => ({ method, path, token: supplied }))).toEqual([
      { method: 'POST', path: '/api/conversations', token },
      { method: 'PATCH', path: '/api/conversations/session-new', token },
      { method: 'GET', path: '/api/conversations', token },
      { method: 'GET', path: '/api/conversations/session-1', token },
      { method: 'GET', path: '/api/conversations/session-1/messages', token },
      { method: 'DELETE', path: '/api/conversations/session-1', token },
      { method: 'PATCH', path: '/api/conversations/session-1', token },
      { method: 'GET', path: '/api/agents/list', token },
    ])
    expect(received).not.toContainEqual(expect.objectContaining({ path: '/role/switch' }))
    expect(received).toContainEqual(expect.objectContaining({
      method: 'PATCH',
      path: '/api/conversations/session-1',
      role: 'general',
    }))
  })

  it('preserves the desktop role-lock message from a failed conversation PATCH', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify({
      error: 'Conversation role is locked after the first message',
    }), {
      status: 409,
      statusText: 'Conflict',
      headers: { 'Content-Type': 'application/json' },
    }))

    await expect(updateConversationRole('session-locked', 'design', baseUrl))
      .rejects.toThrow('Conversation role is locked after the first message')
    const [input, init] = vi.mocked(fetch).mock.calls.at(-1)!
    expect(input).toBe(`${baseUrl}/api/conversations/session-locked`)
    expect(init?.method).toBe('PATCH')
    expect(new Headers(init?.headers).get('x-openpipal-acp-token')).toBe(token)
    expect(JSON.parse(String(init?.body))).toEqual({ role: 'design' })
  })

  it('keeps the health probe public', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify({ status: 'ok', app: 'openpipal' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }))

    await expect(probeDesktop(baseUrl)).resolves.toBe(true)
    const call = vi.mocked(fetch).mock.calls.at(-1)
    expect(call?.[0]).toBe(`${baseUrl}/health`)
    expect(new Headers(call?.[1]?.headers).has('x-openpipal-acp-token')).toBe(false)
  })
})

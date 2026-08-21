import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  conversations: [] as any[],
  sessionMcp: new Map<string, { name: string; toolCount: number }[]>(),
  workspaces: [] as { id: string; name: string }[],
  listWorkspacesCalls: 0,
  listeningPort: 3031 as number | null,
  adapter: null as { command: string; args: string[]; env: Record<string, string> } | null
}))

vi.mock('../../src/main/conversation-store', () => ({
  listConversations: () => state.conversations
}))
vi.mock('../../src/main/mcp-manager', () => ({
  listSessionMcpServers: (sessionId: string) => state.sessionMcp.get(sessionId) || []
}))
vi.mock('../../src/main/http-server', () => ({
  getHttpListeningPort: () => state.listeningPort
}))
vi.mock('../../src/main/agent-workspace-store', () => ({
  listWorkspaces: () => {
    state.listWorkspacesCalls += 1
    return state.workspaces
  }
}))
vi.mock('../../src/main/acp-adapter-launch', () => ({
  resolveAcpAdapterLaunch: () => state.adapter
}))
vi.mock('../../src/main/credential-paths', () => ({
  getAcpMcpTokenPath: () => '/tmp/openpipal-test/acp-mcp.token'
}))

import { buildAcpStatus } from '../../src/main/acp-status'
import {
  endAcpStream,
  forgetAcpSession,
  noteAcpActivity,
  noteAcpHandshake,
  resetAcpLiveState,
  setAcpStatusListener,
  startAcpStream
} from '../../src/main/acp-session-registry'
import { parseAcpStatus } from '../../src/shared/acp-status-contract'

function acpConversation(id: string, overrides: Record<string, unknown> = {}): any {
  return {
    id,
    title: `[ACP] ${id}`,
    role: 'general',
    updatedAt: 1_000,
    messageCount: 0,
    config: { workingDir: `/tmp/${id}`, acp: { adapter: 'openpipal-acp', client: 'Zed', protocolVersion: 2 } },
    ...overrides
  }
}

beforeEach(() => {
  resetAcpLiveState()
  state.conversations = []
  state.sessionMcp = new Map()
  state.workspaces = [{ id: 'agent-1', name: '我的法务助手' }]
  state.listWorkspacesCalls = 0
  state.listeningPort = 3031
})

describe('ACP connection status snapshot', () => {
  it('lists only conversations the adapter marked, with its reported editor and protocol', () => {
    state.conversations = [
      acpConversation('acp-1'),
      { id: 'desktop-1', title: '普通对话', role: 'general', updatedAt: 2_000, messageCount: 3, config: {} },
      acpConversation('acp-2', { config: { workingDir: '/tmp/acp-2', acp: { adapter: 'openpipal-acp' } } })
    ]

    const status = buildAcpStatus()

    expect(status.sessions.map(session => session.conversationId)).toEqual(['acp-1', 'acp-2'])
    expect(status.sessions[0]).toMatchObject({ client: 'Zed', protocolVersion: 2, cwd: '/tmp/acp-1' })
    // 老适配器不写 client/protocolVersion——如实留空，不猜一个出来
    expect(status.sessions[1].client).toBeUndefined()
    expect(status.sessions[1].protocolVersion).toBeUndefined()
  })

  it('answers "is it running now" from memory and falls back to the stored updatedAt', () => {
    state.conversations = [acpConversation('acp-1'), acpConversation('acp-2', { updatedAt: 5_000 })]
    startAcpStream('acp-1', 9_000)

    const streaming = buildAcpStatus()
    expect(streaming.sessions.map(s => [s.conversationId, s.streaming, s.lastActivityAt])).toEqual([
      ['acp-1', true, 9_000],
      ['acp-2', false, 5_000]
    ])

    endAcpStream('acp-1', 10_000)
    const idle = buildAcpStatus()
    expect(idle.sessions[0]).toMatchObject({ conversationId: 'acp-1', streaming: false, lastActivityAt: 10_000 })
  })

  it('drops live state for a session that went away, keeping the stored fallback', () => {
    state.conversations = [acpConversation('acp-1')]
    noteAcpActivity('acp-1', 8_000)
    expect(buildAcpStatus().sessions[0].lastActivityAt).toBe(8_000)

    forgetAcpSession('acp-1')
    expect(buildAcpStatus().sessions[0].lastActivityAt).toBe(1_000)
  })

  it('reports the port honestly and never invents one when the server is down', () => {
    state.listeningPort = null
    expect(buildAcpStatus().port).toBeNull()

    state.listeningPort = 3031
    expect(buildAcpStatus().port).toBe(3031)
  })

  it('surfaces only the pending permissions that belong to an ACP session', () => {
    state.conversations = [acpConversation('acp-1')]
    const pending = [
      { tool: 'execute_command', risk: 'high', conversationId: 'acp-1', requestedAt: 7_000 },
      { tool: 'write_file', conversationId: 'desktop-1', requestedAt: 7_100 },
      { tool: 'browser_click', requestedAt: 7_200 }
    ]

    expect(buildAcpStatus(pending).pendingPermissions).toEqual([pending[0]])
  })

  it('names the custom Agent a session is pinned to, and stays silent when it was deleted', () => {
    state.conversations = [
      acpConversation('acp-agent', { workspaceId: 'agent-1' }),
      acpConversation('acp-builtin'),
      acpConversation('acp-gone', { workspaceId: 'agent-deleted' })
    ]

    const byId = new Map(buildAcpStatus().sessions.map(session => [session.conversationId, session]))
    expect(byId.get('acp-agent')?.agent).toBe('我的法务助手')
    expect(byId.get('acp-builtin')?.agent).toBeUndefined()
    // Agent 已被删：留空,不拿一个不存在的名字充数
    expect(byId.get('acp-gone')?.agent).toBeUndefined()
  })

  it('does not scan the workspace directory when no session uses a custom Agent', () => {
    state.conversations = [acpConversation('acp-builtin')]
    buildAcpStatus()
    expect(state.listWorkspacesCalls).toBe(0)

    state.conversations = [acpConversation('acp-agent', { workspaceId: 'agent-1' })]
    buildAcpStatus()
    expect(state.listWorkspacesCalls).toBe(1)
  })

  it('shows the MCP servers injected into that one session', () => {
    state.conversations = [acpConversation('acp-1'), acpConversation('acp-2')]
    state.sessionMcp.set('acp-1', [{ name: 'context7', toolCount: 4 }])

    const status = buildAcpStatus()
    expect(status.sessions.find(s => s.conversationId === 'acp-1')?.mcpServers)
      .toEqual([{ name: 'context7', toolCount: 4 }])
    expect(status.sessions.find(s => s.conversationId === 'acp-2')?.mcpServers).toEqual([])
  })

  it('pushes a change signal instead of making the renderer poll', () => {
    const listener = vi.fn()
    setAcpStatusListener(listener)

    noteAcpHandshake(1)
    startAcpStream('acp-1', 2)
    endAcpStream('acp-1', 3)
    forgetAcpSession('acp-1')

    expect(listener.mock.calls.length).toBeGreaterThanOrEqual(4)
    expect(buildAcpStatus().lastHandshakeAt).toBe(1)
  })

  /**
   * 适配器随包分发之后，面板和"复制给 AI"都按这条命令告诉用户怎么启动。
   * 文件不在就必须报 null——报一条跑不通的命令，用户只会以为是自己配错了。
   */
  it('只有适配器文件真在时才报启动命令', () => {
    expect(buildAcpStatus().adapter).toBeNull()

    state.adapter = {
      command: '/Applications/OpenPipal.app/Contents/MacOS/OpenPipal',
      args: ['/Applications/OpenPipal.app/Contents/Resources/acp/openpipal-acp.mjs'],
      env: { ELECTRON_RUN_AS_NODE: '1' }
    }
    const status = buildAcpStatus()
    expect(status.adapter?.command).toContain('OpenPipal')
    expect(status.adapter?.args[0]).toContain('openpipal-acp.mjs')
    expect(status.adapter?.env.ELECTRON_RUN_AS_NODE).toBe('1')
    // 过一遍 preload 的解析器：字段一个都不能掉
    expect(parseAcpStatus(JSON.parse(JSON.stringify(status))).adapter).toEqual(status.adapter)
  })

  it('survives the preload contract parser without losing a field', () => {
    state.conversations = [acpConversation('acp-1', { workspaceId: 'agent-1' })]
    state.sessionMcp.set('acp-1', [{ name: 'context7', toolCount: 4 }])
    startAcpStream('acp-1', 9_000)
    noteAcpHandshake(8_000)
    const pending = [{ tool: 'execute_command', risk: 'high', conversationId: 'acp-1', requestedAt: 7_000 }]

    const status = buildAcpStatus(pending)
    expect(parseAcpStatus(JSON.parse(JSON.stringify(status)))).toEqual(status)
  })
})

/**
 * OpenPipal ACP v1/v2 agent surfaces.
 *
 * ACP v2 is intentionally kept as a thin, opt-in protocol layer. Both versions
 * share one OpenPipal runtime so desktop probing, session persistence, MCP
 * injection, cancellation, and SSE translation cannot drift apart.
 */

import { randomUUID } from 'node:crypto'
import * as v1 from '@agentclientprotocol/sdk'
import * as v2 from '@agentclientprotocol/sdk/experimental/v2'
import {
  DEFAULT_BASE,
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
} from './http-client.js'
import { parseSSE } from './sse-parser.js'
import { EventTranslator, type AcpProtocolVersion, type SessionUpdateEmitter } from './translator.js'

const ADAPTER_VERSION = '0.2.0'
const ROLE_CONFIG_ID = 'openpipal.role'

type AgentInventory = Awaited<ReturnType<typeof listAgents>>

interface SessionState {
  conversationId: string
  role: string
  active: boolean
  currentAbort?: AbortController
  currentTurn?: Promise<void>
  roleChangeInProgress?: boolean
  hasInjectedMcp?: boolean
}

class PromptStreamFailure extends Error {
  constructor(
    message: string,
    readonly reportedToClient = false,
  ) {
    super(message)
    this.name = 'PromptStreamFailure'
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function normalizeStreamError(content: unknown): string {
  const message = typeof content === 'string' ? content.trim() : ''
  return (message || 'OpenPipal stream reported an error').replace(/^\[Error\]\s*/i, '')
}

export class OpenPipalAgentRuntime {
  private readonly baseUrl: string
  private agentInventory: AgentInventory | null = null
  private readonly sessions = new Map<string, SessionState>()
  private exitHookInstalled = false

  constructor(baseUrl: string = DEFAULT_BASE) {
    this.baseUrl = baseUrl
    this.installExitCleanup()
  }

  async initialize(): Promise<void> {
    if (!(await probeDesktop(this.baseUrl))) {
      throw new v1.RequestError(
        -32000,
        'OpenPipal 桌面端未启动。请先打开 OpenPipal，然后重新连接 ACP client。',
      )
    }

    try {
      this.agentInventory = await listAgents(this.baseUrl)
    } catch (error) {
      console.error(`[openpipal-acp] failed to list agents: ${(error as Error).message}`)
    }
  }

  getInventoryMeta(): Record<string, unknown> | undefined {
    if (!this.agentInventory) return undefined
    return {
      'openpipal.io/agents': {
        builtins: this.agentInventory.builtins.map((builtin) => ({
          name: builtin.name,
          displayName: builtin.displayName,
          icon: builtin.icon,
        })),
        agents: this.agentInventory.agents,
      },
    }
  }

  async newV1Session(params: v1.NewSessionRequest): Promise<v1.NewSessionResponse> {
    const session = await this.createSession(params.cwd, params.mcpServers, params._meta)
    const builtins = this.agentInventory?.builtins || []
    const availableModes = builtins.map((builtin) => ({
      id: builtin.name,
      name: builtin.displayName || builtin.name,
      description: `${builtin.icon || ''} ${builtin.displayName || builtin.name}`.trim(),
    }))

    return {
      sessionId: session.conversationId,
      ...(availableModes.length > 0 && {
        modes: {
          availableModes,
          currentModeId: session.role,
        },
      }),
    }
  }

  async newV2Session(params: v2.NewSessionRequest): Promise<v2.NewSessionResponse> {
    if (params.additionalDirectories?.length) {
      throw new v2.RequestError(-32602, 'OpenPipal ACP 暂不支持 additionalDirectories。')
    }
    const session = await this.createSession(params.cwd, params.mcpServers, params._meta)
    return {
      sessionId: session.conversationId,
      configOptions: this.getRoleConfigOptions(session.role),
    }
  }

  async listV2Sessions(params: v2.ListSessionsRequest): Promise<v2.ListSessionsResponse> {
    if (params.cursor) {
      throw new v2.RequestError(-32602, 'OpenPipal ACP session/list 当前一次返回全部结果，不接受 cursor。')
    }
    const conversations = await listConversations(this.baseUrl)
    const sessions = conversations
      .filter((conversation) => {
        const cwd = conversation.config?.workingDir
        return conversation.config?.acp?.adapter === 'openpipal-acp'
          && typeof cwd === 'string'
          && (!params.cwd || cwd === params.cwd)
      })
      .map((conversation) => ({
        sessionId: conversation.id,
        cwd: conversation.config!.workingDir!,
        title: conversation.title,
        updatedAt: new Date(conversation.updatedAt).toISOString(),
      }))
    return { sessions }
  }

  async resumeV2Session(
    params: v2.ResumeSessionRequest,
    emitUpdate: SessionUpdateEmitter,
  ): Promise<v2.ResumeSessionResponse> {
    if (params.additionalDirectories?.length) {
      throw new v2.RequestError(-32602, 'OpenPipal ACP 暂不支持 additionalDirectories。')
    }
    const conversation = await getConversation(params.sessionId, this.baseUrl)
    if (!conversation) {
      throw new v2.RequestError(-32602, `Unknown session: ${params.sessionId}`)
    }
    const storedCwd = conversation.config?.workingDir
    if (!storedCwd || conversation.config?.acp?.adapter !== 'openpipal-acp') {
      throw new v2.RequestError(-32602, `Session ${params.sessionId} 不是可恢复的 ACP v2 会话。`)
    }
    if (storedCwd !== params.cwd) {
      throw new v2.RequestError(
        -32602,
        `Session ${params.sessionId} belongs to ${storedCwd}, not ${params.cwd}`,
      )
    }

    const session: SessionState = this.sessions.get(params.sessionId) || {
      conversationId: params.sessionId,
      role: conversation.role,
      active: true,
    }
    session.active = true
    session.role = conversation.role
    this.sessions.set(params.sessionId, session)
    await this.injectMcpServers(session, params.mcpServers)

    if (params.replayFrom?.type === 'start') {
      const messages = await getConversationMessages(params.sessionId, this.baseUrl)
      for (const [index, message] of messages.entries()) {
        if ((message.role !== 'user' && message.role !== 'assistant') || !message.content) continue
        await emitUpdate({
          sessionUpdate: message.role === 'user' ? 'user_message' : 'agent_message',
          messageId: message.id || `sw-history-${index}`,
          content: [{ type: 'text', text: message.content }],
        })
      }
    } else if (params.replayFrom) {
      throw new v2.RequestError(-32602, `Unsupported replay cursor: ${params.replayFrom.type}`)
    }

    return { configOptions: this.getRoleConfigOptions(session.role) }
  }

  async closeV2Session(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId)
    if (session) {
      session.currentAbort?.abort()
      await session.currentTurn
      await unregisterSessionMcpServers(sessionId, this.baseUrl)
      session.hasInjectedMcp = false
      session.active = false
      return
    }

    const conversation = await getConversation(sessionId, this.baseUrl)
    if (!conversation?.config?.workingDir || conversation.config?.acp?.adapter !== 'openpipal-acp') {
      throw new v2.RequestError(-32602, `Unknown session: ${sessionId}`)
    }
  }

  async deleteV2Session(sessionId: string): Promise<void> {
    await this.closeV2Session(sessionId)
    await deleteConversation(sessionId, this.baseUrl)
    this.sessions.delete(sessionId)
  }

  async setV1Mode(params: v1.SetSessionModeRequest): Promise<void> {
    await this.setRole(params.sessionId, params.modeId)
  }

  async setV2ConfigOption(
    params: v2.SetSessionConfigOptionRequest,
  ): Promise<v2.SetSessionConfigOptionResponse> {
    if (params.configId !== ROLE_CONFIG_ID || params.type !== 'id' || typeof params.value !== 'string') {
      throw new v2.RequestError(-32602, `Unsupported config option: ${params.configId}`)
    }
    await this.setRole(params.sessionId, params.value)
    return { configOptions: this.getRoleConfigOptions(params.value) }
  }

  async promptV1(params: v1.PromptRequest, client: v1.AgentContext): Promise<v1.PromptResponse> {
    const session = this.requireActiveSession(params.sessionId)
    if (session.roleChangeInProgress) {
      throw new v1.RequestError(-32600, `Session ${params.sessionId} is updating its role`)
    }
    if (session.currentTurn) {
      throw new v1.RequestError(-32600, `Session ${params.sessionId} is already processing a prompt`)
    }

    const controller = new AbortController()
    session.currentAbort = controller
    const turn = this.executePrompt(
      session,
      params.prompt,
      1,
      (update) => client.notify(v1.methods.client.session.update, {
        sessionId: params.sessionId,
        update: update as v1.SessionUpdate,
      }),
      controller.signal,
    )
    session.currentTurn = turn.then(() => undefined, () => undefined)

    try {
      return { stopReason: await turn }
    } catch (error) {
      if (error instanceof v1.RequestError) throw error
      throw new v1.RequestError(-32000, errorMessage(error))
    } finally {
      session.currentAbort = undefined
      session.currentTurn = undefined
    }
  }

  startV2Prompt(params: v2.PromptRequest, client: v2.AgentContext): void {
    const session = this.requireActiveSession(params.sessionId)
    if (session.roleChangeInProgress) {
      throw new v2.RequestError(-32600, `Session ${params.sessionId} is updating its role`)
    }
    if (session.currentTurn) {
      throw new v2.RequestError(-32600, `Session ${params.sessionId} is already processing a prompt`)
    }

    const controller = new AbortController()
    session.currentAbort = controller
    const emitUpdate: SessionUpdateEmitter = (update) => client.notify(
      v2.methods.client.session.update,
      { sessionId: params.sessionId, update: update as v2.SessionUpdate },
    )

    const responseQueued = new Promise<void>((resolve) => setTimeout(resolve, 0))
    const turn = responseQueued
      .then(() => this.runV2Turn(session, params.prompt, emitUpdate, controller.signal))
      .catch((error) => console.error(`[openpipal-acp/v2] turn failed: ${(error as Error).message}`))
      .finally(() => {
        if (session.currentTurn === turn) {
          session.currentAbort = undefined
          session.currentTurn = undefined
        }
      })
    session.currentTurn = turn
  }

  async cancel(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId)
    session?.currentAbort?.abort()
    await session?.currentTurn
  }

  private async runV2Turn(
    session: SessionState,
    prompt: v2.ContentBlock[],
    emitUpdate: SessionUpdateEmitter,
    signal: AbortSignal,
  ): Promise<void> {
    const userMessageId = `sw-user-${randomUUID()}`
    await emitUpdate({
      sessionUpdate: 'user_message',
      messageId: userMessageId,
      content: prompt,
    })
    await emitUpdate({ sessionUpdate: 'state_update', state: 'running' })

    let stopReason: v2.StopReason
    try {
      stopReason = await this.executePrompt(session, prompt, 2, emitUpdate, signal)
    } catch (error) {
      if (signal.aborted) {
        stopReason = 'cancelled'
      } else {
        stopReason = 'error'
        if (!(error instanceof PromptStreamFailure && error.reportedToClient)) {
          await emitUpdate({
            sessionUpdate: 'agent_message',
            messageId: `sw-error-${randomUUID()}`,
            content: [{ type: 'text', text: `[Error] ${errorMessage(error)}` }],
          })
        }
      }
    }

    await emitUpdate({
      sessionUpdate: 'state_update',
      state: 'idle',
      stopReason,
    })
  }

  private async executePrompt(
    session: SessionState,
    prompt: Array<v1.ContentBlock | v2.ContentBlock>,
    protocolVersion: AcpProtocolVersion,
    emitUpdate: SessionUpdateEmitter,
    signal: AbortSignal,
  ): Promise<v1.StopReason> {
    const userText = this.promptToText(prompt)
    const translator = new EventTranslator(emitUpdate, protocolVersion)
    if (!userText.trim()) {
      await translator.handle({ type: 'error', content: 'OpenPipal 当前无法处理这个空提示或内容类型。' })
      return 'end_turn'
    }

    try {
      const body = await streamChat(
        {
          messages: [{ role: 'user', content: userText }],
          conversationId: session.conversationId,
        },
        signal,
        this.baseUrl,
      )

      let receivedDone = false
      for await (const event of parseSSE(body, signal)) {
        if (signal.aborted) return 'cancelled'
        if (event.type === 'done') {
          receivedDone = true
          break
        }
        if (event.type === 'error') {
          const message = normalizeStreamError(event.content)
          if (protocolVersion === 2) {
            await translator.handle({ ...event, content: message })
          }
          throw new PromptStreamFailure(`Prompt failed: ${message}`, protocolVersion === 2)
        }
        await translator.handle(event)
      }
      if (signal.aborted) return 'cancelled'
      if (!receivedDone) {
        throw new PromptStreamFailure('Prompt failed: OpenPipal stream ended before the terminal done event')
      }
      return 'end_turn'
    } catch (error: unknown) {
      if ((error as { name?: string })?.name === 'AbortError' || signal.aborted) return 'cancelled'
      if (error instanceof PromptStreamFailure) throw error
      throw new PromptStreamFailure(`Prompt failed: ${errorMessage(error)}`)
    }
  }

  private promptToText(blocks: Array<v1.ContentBlock | v2.ContentBlock>): string {
    return blocks
      .map((block: any) => {
        if (block.type === 'text') return block.text || ''
        if (block.type === 'resource_link') {
          return `[Resource: ${block.name || block.uri}](${block.uri})`
        }
        if (block.type === 'resource' && block.resource?.text) {
          return `\n\n[Embedded resource: ${block.resource.uri}]\n${block.resource.text}`
        }
        return ''
      })
      .filter(Boolean)
      .join('\n')
  }

  private async createSession(
    cwd: string,
    mcpServers: unknown[] | undefined,
    meta: Record<string, unknown> | null | undefined,
  ): Promise<SessionState> {
    const cwdName = cwd.split('/').filter(Boolean).pop() || 'ACP session'
    const requestedAgent = (meta as any)?.['openpipal.io/agentId'] as string | undefined
    const createOptions: { role?: string; workspaceId?: string; workingDir: string } = { workingDir: cwd }
    let titleSuffix = ''

    if (requestedAgent && this.agentInventory) {
      const builtin = this.agentInventory.builtins.find((item) => item.name === requestedAgent)
      if (builtin) {
        createOptions.role = builtin.name
        titleSuffix = ` · ${builtin.displayName || builtin.name}`
      } else {
        const userAgent = this.agentInventory.agents.find((item) => item.id === requestedAgent)
        if (!userAgent) {
          throw new v1.RequestError(
            -32000,
            `Unknown agent id "${requestedAgent}". 用 initialize._meta.openpipal.io/agents 列表查询可用 id。`,
          )
        }
        createOptions.workspaceId = userAgent.id
        titleSuffix = ` · ${userAgent.name}`
      }
    }

    try {
      const conversation = await createConversation(
        `[ACP] ${cwdName}${titleSuffix}`,
        this.baseUrl,
        createOptions,
      )
      const session: SessionState = {
        conversationId: conversation.id,
        role: createOptions.role || conversation.role || 'general',
        active: true,
      }
      this.sessions.set(conversation.id, session)
      await this.injectMcpServers(session, mcpServers)
      return session
    } catch (error) {
      if (error instanceof v1.RequestError) throw error
      throw new v1.RequestError(-32000, `创建会话失败: ${(error as Error).message}`)
    }
  }

  private async injectMcpServers(session: SessionState, mcpServers: unknown[] | undefined): Promise<void> {
    if (!Array.isArray(mcpServers) || mcpServers.length === 0) return
    try {
      const result = await registerSessionMcpServers(
        session.conversationId,
        mcpServers,
        this.baseUrl,
      )
      session.hasInjectedMcp = true
      const registered = result.registered.map((item) => `${item.name}(${item.toolCount})`).join(', ') || '(无)'
      console.error(`[openpipal-acp] session=${session.conversationId} 注入 MCP: ${registered}`)
      for (const failure of result.failed) {
        console.error(`[openpipal-acp]   ✗ ${failure.name}: ${failure.error}`)
      }
    } catch (error) {
      console.error(`[openpipal-acp] MCP 注入失败, session 仍可用: ${(error as Error).message}`)
    }
  }

  private getRoleConfigOptions(currentRole: string): v2.SessionConfigOption[] {
    const builtins = this.agentInventory?.builtins || []
    if (builtins.length === 0) return []
    const selected = builtins.some((item) => item.name === currentRole)
      ? currentRole
      : builtins[0].name
    return [{
      type: 'select',
      configId: ROLE_CONFIG_ID,
      name: 'OpenPipal Agent',
      description: '选择本会话使用的 OpenPipal 内置角色',
      category: 'mode',
      currentValue: selected,
      options: builtins.map((builtin) => ({
        value: builtin.name,
        name: builtin.displayName || builtin.name,
        description: builtin.icon || undefined,
      })),
    }]
  }

  private async setRole(sessionId: string, role: string): Promise<void> {
    const session = this.requireActiveSession(sessionId)
    if (session.currentTurn) {
      throw new v1.RequestError(-32600, `Session ${sessionId} is already processing a prompt`)
    }
    if (session.roleChangeInProgress) {
      throw new v1.RequestError(-32600, `Session ${sessionId} is already updating its role`)
    }
    if (!(this.agentInventory?.builtins || []).some((item) => item.name === role)) {
      throw new v1.RequestError(
        -32000,
        `Mode "${role}" 不是 OpenPipal 内置角色。自定义 Agent 请在 session/new 时选择。`,
      )
    }
    session.roleChangeInProgress = true
    try {
      await updateConversationRole(session.conversationId, role, this.baseUrl)
      session.role = role
    } catch (error) {
      throw new v1.RequestError(-32000, errorMessage(error))
    } finally {
      session.roleChangeInProgress = false
    }
  }

  private requireActiveSession(sessionId: string): SessionState {
    const session = this.sessions.get(sessionId)
    if (!session || !session.active) {
      throw new v1.RequestError(-32000, `Unknown or closed session: ${sessionId}`)
    }
    return session
  }

  private installExitCleanup(): void {
    if (this.exitHookInstalled) return
    this.exitHookInstalled = true
    const cleanup = async (signal: string) => {
      const sessions = [...this.sessions.values()].filter((session) => session.hasInjectedMcp)
      if (sessions.length === 0) return
      console.error(`[openpipal-acp] ${signal} → 清理 ${sessions.length} 个 session 的 MCP server`)
      await Promise.all(
        sessions.map((session) => unregisterSessionMcpServers(session.conversationId, this.baseUrl)),
      )
    }

    for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
      process.on(signal, async () => {
        await cleanup(signal)
        process.exit(0)
      })
    }
    process.on('beforeExit', async () => cleanup('beforeExit'))
  }
}

export function createV1Agent(runtime: OpenPipalAgentRuntime): v1.AgentApp {
  return v1.agent({ name: 'openpipal-acp-v1' })
    .onRequest(v1.methods.agent.initialize, async () => {
      await runtime.initialize()
      return {
        protocolVersion: v1.PROTOCOL_VERSION,
        agentCapabilities: {
          loadSession: false,
          mcpCapabilities: { http: true, sse: true },
        },
        agentInfo: { name: 'openpipal-acp', title: 'OpenPipal', version: ADAPTER_VERSION },
        _meta: runtime.getInventoryMeta(),
      }
    })
    .onRequest(v1.methods.agent.authenticate, () => ({}))
    .onRequest(v1.methods.agent.session.new, ({ params }) => runtime.newV1Session(params))
    .onRequest(v1.methods.agent.session.setMode, async ({ params }) => runtime.setV1Mode(params))
    .onRequest(v1.methods.agent.session.prompt, ({ params, client }) => runtime.promptV1(params, client))
    .onNotification(v1.methods.agent.session.cancel, ({ params }) => runtime.cancel(params.sessionId))
}

export function createV2Agent(runtime: OpenPipalAgentRuntime): v2.AgentApp {
  return v2.agent({ name: 'openpipal-acp-v2' })
    .onRequest(v2.methods.agent.initialize, async () => {
      await runtime.initialize()
      return {
        protocolVersion: v2.PROTOCOL_VERSION,
        info: { name: 'openpipal-acp', title: 'OpenPipal', version: ADAPTER_VERSION },
        capabilities: {
          session: {
            mcp: { stdio: {}, http: {} },
            delete: {},
          },
        },
        _meta: runtime.getInventoryMeta(),
      }
    })
    .onRequest(v2.methods.agent.session.new, ({ params }) => runtime.newV2Session(params))
    .onRequest(v2.methods.agent.session.list, ({ params }) => runtime.listV2Sessions(params))
    .onRequest(v2.methods.agent.session.resume, ({ params, client }) => runtime.resumeV2Session(
      params,
      (update) => client.notify(v2.methods.client.session.update, {
        sessionId: params.sessionId,
        update: update as v2.SessionUpdate,
      }),
    ))
    .onRequest(v2.methods.agent.session.close, async ({ params }) => {
      await runtime.closeV2Session(params.sessionId)
      return {}
    })
    .onRequest(v2.methods.agent.session.delete, async ({ params }) => {
      await runtime.deleteV2Session(params.sessionId)
      return {}
    })
    .onRequest(v2.methods.agent.session.setConfigOption, ({ params }) => runtime.setV2ConfigOption(params))
    .onRequest(v2.methods.agent.session.prompt, ({ params, client }) => {
      runtime.startV2Prompt(params, client)
      return {}
    })
    .onNotification(v2.methods.agent.session.cancel, ({ params }) => runtime.cancel(params.sessionId))
}

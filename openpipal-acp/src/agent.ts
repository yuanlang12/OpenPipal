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
  listSkills,
  getConversationGoal,
  openDesktopEventStream,
  setConversationGoal,
  clearConversationGoal,
  probeDesktop,
  registerSessionMcpServers,
  respondPermission,
  streamChat,
  unregisterSessionMcpServers,
  updateConversationPersona,
} from './http-client.js'
import { parseSSE } from './sse-parser.js'
import {
  EventTranslator,
  type AcpProtocolVersion,
  type PermissionBridge,
  type PermissionRequestPayload,
  type SessionUpdateEmitter,
} from './translator.js'

const ADAPTER_VERSION = '0.2.0'
const ROLE_CONFIG_ID = 'openpipal.role'
/**
 * 人格选项值的命名空间：内置角色用裸名（learner/design/…），用户保存的 Agent 用
 * `agent:<uuid>`。一个下拉同时列两类，和桌面端 AgentSwitcher 的呈现一致——
 * 编辑器的 mode/config 选择器是用户唯一够得着的入口，分成两个选项只会更难选。
 */
const AGENT_VALUE_PREFIX = 'agent:'
/** session/list 每页条数。会话多了以后一次性全量返回会把 JSON-RPC 单帧撑得很大 */
const SESSION_PAGE_SIZE = 50

/**
 * session/list 的游标：keyset（按 createdAt 降序 + id 升序破平），不是 offset。
 *
 * 排序键必须**不可变**。曾经用 updatedAt：降序 + 可变键的组合下，任何一条在翻第一页
 * 和第二页之间被改过的会话（`/goal` 写一次、适配器 PATCH 一次 config 都算）都会跳到
 * 游标前面去，于是**哪一页都不再返回它**——静默漏条。createdAt 出生即定，翻页期间
 * 只可能新增在最前面（下一次从头翻才看得到），不会把已有的挤掉。
 */
interface SessionListCursor {
  v: 1
  createdAt: number
  id: string
}

function encodeSessionCursor(cursor: SessionListCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url')
}

function decodeSessionCursor(raw: string): SessionListCursor {
  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'))
  } catch {
    throw new v2.RequestError(-32602, 'Invalid session/list cursor')
  }
  const candidate = parsed as Partial<SessionListCursor>
  if (candidate?.v !== 1 || typeof candidate.createdAt !== 'number' || typeof candidate.id !== 'string') {
    throw new v2.RequestError(-32602, 'Invalid session/list cursor')
  }
  return { v: 1, createdAt: candidate.createdAt, id: candidate.id }
}

/**
 * 授权选项。OpenPipal 没有"会话级拒绝名单"，所以不提供 reject_always——
 * 给一个点了不生效的选项，比不给更糟。
 */
/**
 * 编辑器一直不答复时的兜底上限。桌面端自己也有超时（普通工具 30 分钟、MCP 60 分钟），
 * 这里取更短的一档：超时即按拒绝**并把裁决送回去**，桌面端立刻解锁，不用干等它的长超时。
 */
const PERMISSION_REQUEST_TIMEOUT_MS = 15 * 60_000
/** 裁决回传失败时的重试节奏——丢了裁决等于把桌面端挂到它自己的长超时 */
const PERMISSION_RESPOND_RETRY_DELAYS_MS = [200, 800]

const PERMISSION_OPTIONS = [
  { optionId: 'allow_once', name: '允许一次', kind: 'allow_once' as const },
  { optionId: 'allow_always', name: '本次会话内始终允许', kind: 'allow_always' as const },
  { optionId: 'reject_once', name: '拒绝', kind: 'reject_once' as const },
]

type PermissionOutcome = { outcome?: { outcome?: string; optionId?: string } | null } | null | undefined

type AgentInventory = Awaited<ReturnType<typeof listAgents>>

/**
 * 按 sessionId 发 session/update。命令列表要在 session/new 的响应之后才发，
 * 那时 sessionId 才存在，所以这里收 sessionId 而不是提前把它闭包进去。
 */
type SessionNotifier = (sessionId: string, update: Record<string, unknown>) => Promise<void>

interface SessionState {
  conversationId: string
  role: string
  /** 挂在自定义 Agent 上时的 workspace id；内置角色为 undefined */
  workspaceId?: string
  /** 本会话可用的技能名，用来把 `/技能名` 还原成产品自己的强调格式 */
  skills?: string[]
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

/** 这条会话当前的人格值（自定义 Agent 优先——它压过角色的 systemPrompt） */
function personaValue(session: Pick<SessionState, 'role' | 'workspaceId'>): string {
  return session.workspaceId ? `${AGENT_VALUE_PREFIX}${session.workspaceId}` : session.role
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
  // 一个适配器进程 = 一条客户端连接，所以协商结果记在 runtime 上就够
  private clientName?: string
  private negotiatedVersion?: AcpProtocolVersion
  /** 常驻推送用的回调与生命周期——一个适配器进程只服务一条客户端连接 */
  private notifyClient?: SessionNotifier
  private desktopEvents?: AbortController

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

  /**
   * 接上常驻推送：桌面端改了人格之后不必等下一轮开跑，编辑器立刻收到通知。
   * 掉线不影响正确性——每轮开跑前还有 `syncPersonaFromDisk` 那道对账兜底。
   */
  attachClient(notify: SessionNotifier): void {
    this.notifyClient = notify
    if (this.desktopEvents) return
    this.desktopEvents = new AbortController()
    void this.runDesktopEventLoop(this.desktopEvents.signal)
  }

  private async runDesktopEventLoop(signal: AbortSignal): Promise<void> {
    let backoffMs = 1_000
    let loggedFailure = false
    while (!signal.aborted) {
      try {
        const body = await openDesktopEventStream(signal, this.baseUrl)
        backoffMs = 1_000
        if (loggedFailure) {
          console.error('[openpipal-acp] 桌面端推送通道已恢复')
          loggedFailure = false
        }
        for await (const event of parseSSE(body, signal)) {
          if (signal.aborted) return
          if (event?.type === 'conversation_changed' && typeof event.conversationId === 'string') {
            await this.onConversationChanged(event.conversationId, event.kind)
          }
        }
      } catch (error) {
        if (signal.aborted) return
        if (!loggedFailure) {
          // 只在状态翻转时说一次，别把编辑器的 stderr 刷满
          console.error(`[openpipal-acp] 桌面端推送通道断开，退避重连: ${errorMessage(error)}`)
          loggedFailure = true
        }
      }
      if (signal.aborted) return
      await new Promise((resolve) => {
        // unref：退避等待期间不该把 Node 事件循环钉住（否则编辑器退出后进程还活着）
        const timer = setTimeout(resolve, backoffMs)
        timer.unref?.()
      })
      backoffMs = Math.min(backoffMs * 2, 30_000)
    }
  }

  private async onConversationChanged(conversationId: string, kind: unknown): Promise<void> {
    if (kind !== 'persona') return
    const session = this.sessions.get(conversationId)
    const notify = this.notifyClient
    if (!session || !session.active || !notify || !this.negotiatedVersion) return
    // 本轮自己正在跑或正在改人格：那两条路各自会把结果推出去，这里插一脚只会互相打架
    if (session.currentTurn || session.roleChangeInProgress) return
    await this.syncPersonaFromDisk(
      session,
      this.negotiatedVersion,
      (update) => notify(session.conversationId, update),
    )
  }

  /** initialize 时记下对方是谁，创建会话时写进桌面端的 config.acp */
  noteClient(
    info: { name?: string | null; title?: string | null } | null | undefined,
    version: AcpProtocolVersion,
  ): void {
    this.clientName = info?.title || info?.name || undefined
    this.negotiatedVersion = version
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

  async newV1Session(
    params: v1.NewSessionRequest,
    notify?: SessionNotifier,
  ): Promise<v1.NewSessionResponse> {
    const session = await this.createSession(params.cwd, params.mcpServers, params._meta)
    if (notify) this.schedulePublishCommands(session, notify)
    await this.ensurePersonaKnown(personaValue(session))
    const availableModes = this.personaOptionsIncluding(personaValue(session)).map((option) => ({
      id: option.value,
      name: option.name,
      description: `${option.description || ''} ${option.name}`.trim(),
    }))

    return {
      sessionId: session.conversationId,
      ...(availableModes.length > 0 && {
        modes: {
          availableModes,
          currentModeId: personaValue(session),
        },
      }),
    }
  }

  async newV2Session(
    params: v2.NewSessionRequest,
    notify?: SessionNotifier,
  ): Promise<v2.NewSessionResponse> {
    if (params.additionalDirectories?.length) {
      throw new v2.RequestError(-32602, 'OpenPipal ACP 暂不支持 additionalDirectories。')
    }
    const session = await this.createSession(params.cwd, params.mcpServers, params._meta)
    if (notify) this.schedulePublishCommands(session, notify)
    await this.ensurePersonaKnown(personaValue(session))
    return {
      sessionId: session.conversationId,
      configOptions: this.getPersonaConfigOptions(personaValue(session)),
    }
  }

  async listV2Sessions(params: v2.ListSessionsRequest): Promise<v2.ListSessionsResponse> {
    const cursor = params.cursor ? decodeSessionCursor(params.cursor) : null
    const conversations = await listConversations(this.baseUrl)
    const ordered = conversations
      .filter((conversation) => {
        const cwd = conversation.config?.workingDir
        return conversation.config?.acp?.adapter === 'openpipal-acp'
          && typeof cwd === 'string'
          && (!params.cwd || cwd === params.cwd)
      })
      // 排序必须是全序：只按 createdAt 排，同毫秒的两条在两次请求里可能换位置，
      // 游标就会漏掉其中一条。id 升序做破平键。
      .sort((a, b) => b.createdAt - a.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))

    const remaining = cursor
      ? ordered.filter((conversation) => (
        conversation.createdAt < cursor.createdAt
        || (conversation.createdAt === cursor.createdAt && conversation.id > cursor.id)
      ))
      : ordered
    const page = remaining.slice(0, SESSION_PAGE_SIZE)
    const last = page[page.length - 1]

    return {
      sessions: page.map((conversation) => ({
        sessionId: conversation.id,
        cwd: conversation.config!.workingDir!,
        title: conversation.title,
        updatedAt: new Date(conversation.updatedAt).toISOString(),
      })),
      ...(remaining.length > page.length && last
        ? { nextCursor: encodeSessionCursor({ v: 1, createdAt: last.createdAt, id: last.id }) }
        : {}),
    }
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
    // 磁盘是事实源：会话挂在哪个自定义 Agent 上由落盘的 workspaceId 说了算
    session.workspaceId = conversation.workspaceId
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

    this.schedulePublishCommands(session, (_sessionId, update) => emitUpdate(update))
    // 恢复的是一条早就存在的会话，它绑的 Agent 可能是本次连接建立之后才存的
    await this.ensurePersonaKnown(personaValue(session))
    return { configOptions: this.getPersonaConfigOptions(personaValue(session)) }
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

  async setV1Mode(params: v1.SetSessionModeRequest, notify?: SessionNotifier): Promise<void> {
    const session = await this.setPersona(params.sessionId, params.modeId)
    if (notify) this.schedulePublishCommands(session, notify)
  }

  async setV2ConfigOption(
    params: v2.SetSessionConfigOptionRequest,
    notify?: SessionNotifier,
  ): Promise<v2.SetSessionConfigOptionResponse> {
    if (params.configId !== ROLE_CONFIG_ID || params.type !== 'id' || typeof params.value !== 'string') {
      throw new v2.RequestError(-32602, `Unsupported config option: ${params.configId}`)
    }
    const session = await this.setPersona(params.sessionId, params.value)
    if (notify) this.schedulePublishCommands(session, notify)
    return { configOptions: this.getPersonaConfigOptions(personaValue(session)) }
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
    const emitUpdate: SessionUpdateEmitter = (update) => client.notify(
      v1.methods.client.session.update,
      { sessionId: params.sessionId, update: update as v1.SessionUpdate },
    )
    await this.syncPersonaFromDisk(session, 1, emitUpdate)
    const turn = this.executePrompt(
      session,
      params.prompt,
      1,
      emitUpdate,
      controller.signal,
      this.createPermissionBridge(
        params.sessionId,
        1,
        (payload) => client.request(v1.methods.client.session.requestPermission, payload as any) as Promise<PermissionOutcome>,
        controller.signal,
      ),
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

    const permissionBridge = this.createPermissionBridge(
      params.sessionId,
      2,
      (payload) => client.request(v2.methods.client.session.requestPermission, payload as any) as Promise<PermissionOutcome>,
      controller.signal,
    )

    const responseQueued = new Promise<void>((resolve) => setTimeout(resolve, 0))
    const turn = responseQueued
      .then(() => this.runV2Turn(session, params.prompt, emitUpdate, controller.signal, permissionBridge))
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
    permissionBridge: PermissionBridge,
  ): Promise<void> {
    await this.syncPersonaFromDisk(session, 2, emitUpdate)

    const userMessageId = `sw-user-${randomUUID()}`
    await emitUpdate({
      sessionUpdate: 'user_message',
      messageId: userMessageId,
      content: prompt,
    })
    await emitUpdate({ sessionUpdate: 'state_update', state: 'running' })

    let stopReason: v2.StopReason
    try {
      stopReason = await this.executePrompt(session, prompt, 2, emitUpdate, signal, permissionBridge)
    } catch (error) {
      if (signal.aborted) {
        stopReason = 'cancelled'
      } else {
        // v2 的 StopReason 是开放枚举，但自定义值必须以 `_` 开头（裸 'error' 占用的是
        // ACP 保留给未来版本的命名空间）。
        stopReason = '_openpipal_error'
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

  /**
   * 磁盘是人格的事实源。这条会话还空着的时候，桌面端、浏览器插件、另一个 ACP 客户端
   * 都可能把角色或 Agent 改掉，编辑器那边显示的还是旧值。每轮开跑前对一次账，
   * 变了就按协议回推（v1 `current_mode_update` / v2 `config_option_update`）。
   *
   * 为什么"开跑前"就够：人格在首条消息之后锁死，对完这一次就再也不会变。所以这次对账
   * 一定发生在"改掉的人格真正开始起作用"之前——中间那段编辑器显示旧标签，只是标签旧，
   * 不会拿错人格去跑。要做到改完立刻推，得给桌面端→适配器加一条常驻推送通道。
   *
   * 读不到会话（网络抖动 / 已删）就沿用内存里的值：对账失败不该让这一轮跑不起来。
   */
  private async syncPersonaFromDisk(
    session: SessionState,
    protocolVersion: AcpProtocolVersion,
    emitUpdate: SessionUpdateEmitter,
  ): Promise<void> {
    const before = personaValue(session)
    let conversation: Awaited<ReturnType<typeof getConversation>>
    try {
      conversation = await getConversation(session.conversationId, this.baseUrl)
    } catch (error) {
      console.error(`[openpipal-acp] 人格对账失败，沿用内存里的值: ${errorMessage(error)}`)
      return
    }
    if (!conversation) return

    if (conversation.role) session.role = conversation.role
    session.workspaceId = conversation.workspaceId
    const after = personaValue(session)
    if (after === before) return

    console.error(`[openpipal-acp] 人格已被外部改动: ${before} → ${after}`)
    await this.ensurePersonaKnown(after)
    await emitUpdate(protocolVersion === 2
      ? { sessionUpdate: 'config_option_update', configOptions: this.getPersonaConfigOptions(after) }
      : { sessionUpdate: 'current_mode_update', currentModeId: after })
    // 换人格就是换技能：不重报命令列表，编辑器的斜杠菜单还停在上一个人格。
    // 这里直接 await 而不是 schedulePublishCommands——对账发生在开跑之前，报完再跑，
    // 这一轮的 `/技能名` 就已经按新人格展开（排在响应之后的顾虑只对 session/new 成立）。
    await this.publishCommands(session, (_sessionId, update) => emitUpdate(update))
  }

  /** 命令列表用通知发，必须排在本次请求的响应之后——客户端得先知道 sessionId */
  private schedulePublishCommands(session: SessionState, notify: SessionNotifier): void {
    setTimeout(() => { void this.publishCommands(session, notify) }, 0)
  }

  /**
   * 把本会话的技能报成编辑器的斜杠命令。换人格后要重报——自定义 Agent 只带它自己的技能。
   *
   * 拉不到就不报：编辑器少一个菜单，总好过报一份上一个人格的旧列表。
   */
  private async publishCommands(
    session: SessionState,
    notify: SessionNotifier,
  ): Promise<void> {
    try {
      const skills = await listSkills(session.workspaceId, session.role, this.baseUrl)
      session.skills = skills.map((skill) => skill.name)
      await notify(session.conversationId, {
        sessionUpdate: 'available_commands_update',
        availableCommands: [
          {
            name: 'goal',
            description: '给本会话设个目标：每轮结束自动判定有没有达成，没达成就接着跑，到上限或判定完成为止。`show` 看进度，`clear` 清掉',
            input: { type: 'text', hint: '要达成什么（或 show / clear）' },
          },
          ...skills.map((skill) => ({
            name: skill.name,
            description: skill.description,
            input: { type: 'text', hint: '要它做什么（可留空）' },
          })),
        ],
      })
    } catch (error) {
      console.error(`[openpipal-acp] 技能列表拉取失败，本会话暂时没有斜杠命令: ${errorMessage(error)}`)
    }
  }

  /**
   * `/goal` 不进模型：它改的是会话状态（目标 + 每轮结束的自动判定循环），
   * 与桌面端 InputBar 的拦截同一套语义——`/goal <文本>` 设、`/goal show` 看、
   * `/goal clear` 清。返回 null 表示这条不是 goal 命令，照常往下走。
   */
  private async handleGoalCommand(session: SessionState, text: string): Promise<string | null> {
    const trimmed = text.trim()
    if (!trimmed.startsWith('/goal')) return null
    const rest = trimmed.slice('/goal'.length).trim()

    try {
      if (rest === '' || rest === 'show') {
        const goal = await getConversationGoal(session.conversationId, this.baseUrl)
        return goal
          ? `🎯 当前目标：${goal.text}\n进度：${goal.turnsUsed}/${goal.maxTurns} 轮 · 状态 ${goal.status}`
            + (goal.lastCheck ? `\n上次判定：${goal.lastCheck.ok ? '已达成' : '未达成'} —— ${goal.lastCheck.reason}` : '')
          : '这条会话还没有目标。用 `/goal <要达成什么>` 设一个。'
      }
      if (rest === 'clear') {
        await clearConversationGoal(session.conversationId, this.baseUrl)
        return '🎯 目标已清除，后续回合不再自动续跑。'
      }
      const goal = await setConversationGoal(session.conversationId, rest, this.baseUrl)
      return `🎯 目标已设定：${goal.text}\n之后每轮结束会自动判定有没有达成，没达成就接着跑，最多 ${goal.maxTurns} 轮。`
    } catch (error) {
      return `🎯 目标操作失败：${errorMessage(error)}`
    }
  }

  /**
   * 编辑器把斜杠命令插成 `/技能名 补充说明`。OpenPipal 自己的强调格式是
   * `<skill-request>名</skill-request>`（桌面端由 expandSkillMentions 生成），
   * 这里翻成同一份措辞——点一下命令和在桌面端 @技能 是同一件事，不是"发了段带斜杠的文本"。
   */
  private applySkillCommand(session: SessionState, text: string): string {
    const match = /^\/([^\s/]+)(?:\s+([\s\S]*))?$/.exec(text.trim())
    if (!match) return text
    const name = session.skills?.find((skill) => skill.toLowerCase() === match[1].toLowerCase())
    if (!name) return text
    const tag = `<skill-request>${name}</skill-request>`
    const rest = (match[2] || '').trim()
    return rest
      ? `请使用技能 ${tag} 完成以下任务：\n\n${rest}`
      : `请使用技能 ${tag} 来帮我完成`
  }

  private async executePrompt(
    session: SessionState,
    prompt: Array<v1.ContentBlock | v2.ContentBlock>,
    protocolVersion: AcpProtocolVersion,
    emitUpdate: SessionUpdateEmitter,
    signal: AbortSignal,
    permissionBridge?: PermissionBridge,
  ): Promise<v1.StopReason> {
    const rawText = this.promptToText(prompt)
    const translator = new EventTranslator(emitUpdate, protocolVersion, permissionBridge)

    // /goal 改的是会话状态，不该进模型，也不该消耗一轮对话
    const goalReply = await this.handleGoalCommand(session, rawText)
    if (goalReply !== null) {
      await translator.handle({ type: 'text', content: goalReply })
      return 'end_turn'
    }

    const userText = this.applySkillCommand(session, rawText)
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
    const createOptions: {
      role?: string
      workspaceId?: string
      workingDir: string
      client?: string
      protocolVersion?: number
    } = { workingDir: cwd, client: this.clientName, protocolVersion: this.negotiatedVersion }
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
        workspaceId: createOptions.workspaceId,
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

  /**
   * 一次授权的完整往返：问编辑器 → 把裁决回传桌面端。
   *
   * 桌面端此刻正 block 在等这个裁决，所以任何失败路径（客户端不支持、报错、
   * 用户取消）都必须落到"拒绝"并且照样回传——否则这一轮会一直挂着。
   */
  private createPermissionBridge(
    sessionId: string,
    protocolVersion: AcpProtocolVersion,
    ask: (params: Record<string, unknown>) => Promise<PermissionOutcome>,
    signal: AbortSignal,
  ): PermissionBridge {
    return async (request: PermissionRequestPayload, toolCallId: string) => {
      const requestId = request.requestId
      if (!requestId) return

      const toolName = request.tool || '工具'
      const title = `${toolName} 需要授权`
      const description = [request.reason, request.risk ? `风险: ${request.risk}` : '']
        .filter(Boolean)
        .join('\n') || undefined
      const toolCall = {
        toolCallId,
        title,
        kind: 'execute' as const,
        status: 'pending' as const,
        rawInput: request.args,
      }

      let optionId = 'reject_once'
      let bridgeError: Error | null = null
      try {
        // 三件事赛跑：编辑器答复 / 这一轮被取消 / 兜底超时。
        // 不设赛跑的话，用户不理那个框，`session/prompt` 就永远不返回，
        // 连 `session/cancel` 和 `session/close` 都跟着卡死（它们要 await 这一轮）。
        const response = await this.raceUserDecision(
          ask(
            protocolVersion === 2
              ? {
                sessionId,
                title,
                description,
                subject: { type: 'tool_call', toolCall },
                options: PERMISSION_OPTIONS,
              }
              : { sessionId, toolCall, options: PERMISSION_OPTIONS },
          ),
          signal,
        )
        const outcome = response?.outcome
        if (outcome?.outcome === 'selected' && typeof outcome.optionId === 'string') {
          optionId = outcome.optionId
        }
      } catch (error) {
        bridgeError = error instanceof Error ? error : new Error(String(error))
        console.error(`[openpipal-acp] 授权请求失败，按拒绝处理: ${bridgeError.message}`)
      }

      const approved = optionId === 'allow_once' || optionId === 'allow_always'
      // 裁决**必须**送到：这一步失败等于用户点的"允许"凭空消失，桌面端一直卡到自己的
      // 长超时。所以重试几次；实在送不到就抛出去，让上层如实告诉用户，而不是假称已拒绝。
      let lastError: Error | null = null
      for (let attempt = 0; attempt <= PERMISSION_RESPOND_RETRY_DELAYS_MS.length; attempt += 1) {
        try {
          await respondPermission(
            {
              requestId,
              approved,
              // reject_always 不映射：OpenPipal 没有会话级拒绝名单，只当作本次拒绝
              sessionApprove: optionId === 'allow_always',
              executionId: request.executionId,
              conversationId: request.conversationId || sessionId,
            },
            this.baseUrl,
          )
          lastError = null
          break
        } catch (error) {
          lastError = error instanceof Error ? error : new Error(String(error))
          const delay = PERMISSION_RESPOND_RETRY_DELAYS_MS[attempt]
          if (delay === undefined) break
          await new Promise((resolve) => setTimeout(resolve, delay))
        }
      }
      if (lastError) {
        throw new Error(`裁决未能送达桌面端（${lastError.message}）——这一轮可能一直等到桌面端自己超时`)
      }
      if (bridgeError) throw bridgeError
    }
  }

  /** 编辑器答复 / 本轮取消 / 兜底超时，谁先到算谁 */
  private raceUserDecision(
    pending: Promise<PermissionOutcome>,
    signal: AbortSignal,
  ): Promise<PermissionOutcome> {
    if (signal.aborted) return Promise.reject(new Error('这一轮已取消'))
    return new Promise<PermissionOutcome>((resolve, reject) => {
      let settled = false
      const finish = (run: () => void): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        signal.removeEventListener('abort', onAbort)
        run()
      }
      const onAbort = (): void => finish(() => reject(new Error('这一轮已取消')))
      const timer = setTimeout(
        () => finish(() => reject(new Error('编辑器超时未答复授权请求'))),
        PERMISSION_REQUEST_TIMEOUT_MS,
      )
      signal.addEventListener('abort', onAbort, { once: true })
      pending.then(
        (value) => finish(() => resolve(value)),
        (error) => finish(() => reject(error)),
      )
    })
  }

  /**
   * 重拉一次人格清单。`initialize` 那一次拉到的表会过期：编辑器连上之后用户在桌面端
   * 新存了 Agent，这张表里就没有它——切过去被当成非法值拒绝，绑着它的会话还会被
   * 报成"第一个内置角色"。只在认不出某个值时刷（而不是每轮无条件重拉）。
   */
  private async refreshInventory(): Promise<void> {
    try {
      this.agentInventory = await listAgents(this.baseUrl)
    } catch (error) {
      console.error(`[openpipal-acp] Agent 清单刷新失败，沿用上一次的: ${errorMessage(error)}`)
    }
  }

  /** 认得出就直说，认不出先刷新一次再判——返回刷新后到底认不认得 */
  private async ensurePersonaKnown(value: string): Promise<boolean> {
    if (this.personaOptions().some((option) => option.value === value)) return true
    await this.refreshInventory()
    return this.personaOptions().some((option) => option.value === value)
  }

  /**
   * 报给客户端的人格列表：**保证含当前值**。刷新之后还认不出（Agent 已被删）就补一条
   * 占位，绝不把列表里的第一个当成"当前人格"——那等于让编辑器显示一个用户从没选过的角色。
   */
  private personaOptionsIncluding(
    currentValue: string,
  ): { value: string; name: string; description?: string }[] {
    const options = this.personaOptions()
    if (options.length === 0) return options
    if (!currentValue || options.some((option) => option.value === currentValue)) return options
    const id = currentValue.startsWith(AGENT_VALUE_PREFIX)
      ? currentValue.slice(AGENT_VALUE_PREFIX.length)
      : currentValue
    return [...options, { value: currentValue, name: `${id}（已不存在）` }]
  }

  /** 内置角色 + 用户保存的 Agent，一个列表两类人格 */
  private personaOptions(): { value: string; name: string; description?: string }[] {
    const builtins = this.agentInventory?.builtins || []
    const agents = this.agentInventory?.agents || []
    return [
      ...builtins.map((builtin) => ({
        value: builtin.name,
        name: builtin.displayName || builtin.name,
        description: builtin.icon || undefined,
      })),
      ...agents.map((agent) => ({
        value: `${AGENT_VALUE_PREFIX}${agent.id}`,
        name: agent.name,
        description: agent.icon || undefined,
      })),
    ]
  }

  private getPersonaConfigOptions(currentValue: string): v2.SessionConfigOption[] {
    const options = this.personaOptionsIncluding(currentValue)
    if (options.length === 0) return []
    return [{
      type: 'select',
      configId: ROLE_CONFIG_ID,
      name: 'OpenPipal Agent',
      description: '选择本会话使用的内置角色或你保存的 Agent',
      category: 'mode',
      currentValue,
      options,
    }]
  }

  /**
   * 切换这条会话的人格。桌面端对"开聊之后换人格"是拒绝的（角色与 Agent 共用
   * 同一把锁），这里如实把 409 转成协议错误，不自作主张地开新会话。
   */
  private async setPersona(sessionId: string, value: string): Promise<SessionState> {
    const session = this.requireActiveSession(sessionId)
    if (session.currentTurn) {
      throw new v1.RequestError(-32600, `Session ${sessionId} is already processing a prompt`)
    }
    if (session.roleChangeInProgress) {
      throw new v1.RequestError(-32600, `Session ${sessionId} is already updating its role`)
    }

    const workspaceId = value.startsWith(AGENT_VALUE_PREFIX)
      ? value.slice(AGENT_VALUE_PREFIX.length)
      : undefined
    if (!(await this.ensurePersonaKnown(value))) {
      throw new v1.RequestError(
        -32000,
        workspaceId !== undefined
          ? `"${value}" 不是已保存的 OpenPipal Agent。可选值见 session/new 返回的 modes / configOptions。`
          : `"${value}" 既不是 OpenPipal 内置角色，也不是 ${AGENT_VALUE_PREFIX}<id> 形式的已保存 Agent。`,
      )
    }

    session.roleChangeInProgress = true
    try {
      await updateConversationPersona(
        session.conversationId,
        // 切回内置角色必须同时清空 workspace 绑定，否则等于没切
        workspaceId !== undefined ? { workspaceId } : { role: value, workspaceId: null },
        this.baseUrl,
      )
      if (workspaceId !== undefined) {
        session.workspaceId = workspaceId
      } else {
        session.role = value
        session.workspaceId = undefined
      }
      return session
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

  /**
   * 收摊：断开常驻通道 + 注销注入过的 MCP。
   *
   * 编辑器结束适配器的方式是**关掉 stdio**，不发信号。此前常驻通道一直握着一个活
   * handle（打开的 SSE 或退避定时器），`beforeExit` 因此永远不触发，进程就此变成孤儿，
   * 还占着桌面端那边的订阅和 15 秒心跳。
   */
  async shutdown(): Promise<void> {
    this.desktopEvents?.abort()
    this.desktopEvents = undefined
    const sessions = [...this.sessions.values()].filter((session) => session.hasInjectedMcp)
    await Promise.all(
      sessions.map((session) => unregisterSessionMcpServers(session.conversationId, this.baseUrl)),
    )
  }

  private installExitCleanup(): void {
    if (this.exitHookInstalled) return
    this.exitHookInstalled = true
    const cleanup = async (signal: string) => {
      this.desktopEvents?.abort()
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
    .onRequest(v1.methods.agent.initialize, async ({ params, client }) => {
      runtime.noteClient(params.clientInfo, 1)
      runtime.attachClient((sessionId, update) => client.notify(v1.methods.client.session.update, {
        sessionId,
        update: update as v1.SessionUpdate,
      }))
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
    .onRequest(v1.methods.agent.session.new, ({ params, client }) => runtime.newV1Session(
      params,
      (sessionId, update) => client.notify(v1.methods.client.session.update, {
        sessionId,
        update: update as v1.SessionUpdate,
      }),
    ))
    .onRequest(v1.methods.agent.session.setMode, async ({ params, client }) => runtime.setV1Mode(
      params,
      (sessionId, update) => client.notify(v1.methods.client.session.update, {
        sessionId,
        update: update as v1.SessionUpdate,
      }),
    ))
    .onRequest(v1.methods.agent.session.prompt, ({ params, client }) => runtime.promptV1(params, client))
    .onNotification(v1.methods.agent.session.cancel, ({ params }) => runtime.cancel(params.sessionId))
}

export function createV2Agent(runtime: OpenPipalAgentRuntime): v2.AgentApp {
  return v2.agent({ name: 'openpipal-acp-v2' })
    .onRequest(v2.methods.agent.initialize, async ({ params, client }) => {
      runtime.noteClient(params.info, 2)
      runtime.attachClient((sessionId, update) => client.notify(v2.methods.client.session.update, {
        sessionId,
        update: update as v2.SessionUpdate,
      }))
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
    .onRequest(v2.methods.agent.session.new, ({ params, client }) => runtime.newV2Session(
      params,
      (sessionId, update) => client.notify(v2.methods.client.session.update, {
        sessionId,
        update: update as v2.SessionUpdate,
      }),
    ))
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
    .onRequest(v2.methods.agent.session.setConfigOption, ({ params, client }) => runtime.setV2ConfigOption(
      params,
      (sessionId, update) => client.notify(v2.methods.client.session.update, {
        sessionId,
        update: update as v2.SessionUpdate,
      }),
    ))
    .onRequest(v2.methods.agent.session.prompt, ({ params, client }) => {
      runtime.startV2Prompt(params, client)
      return {}
    })
    .onNotification(v2.methods.agent.session.cancel, ({ params }) => runtime.cancel(params.sessionId))
}

/**
 * ACP 外部连接状态契约（主进程 → 渲染层只读快照）。
 *
 * 这里描述的是"此刻"：会话是不是正在跑、有没有授权在等你。**一律不落盘**——
 * 进程重启即清空，重启后要等下一次活动才重新出现。会话的描述性字段（cwd /
 * 编辑器 / 协议版本）来自会话存储里适配器写的 `config.acp`，不在这里复制一份。
 */

export interface AcpSessionStatus {
  conversationId: string
  title: string
  role: string
  cwd?: string
  /** 编辑器自报的名字（ACP initialize 的 info/clientInfo），旧版本适配器可能没有 */
  client?: string
  protocolVersion?: number
  /** 挂在自定义 Agent 上时它的名字；内置角色或该 Agent 已被删则为空 */
  agent?: string
  mcpServers: { name: string; toolCount: number }[]
  /** 会话存储的 updatedAt；本进程见过活动则是那次活动的时间 */
  lastActivityAt: number
  /** 此刻正有一轮在流式 */
  streaming: boolean
}

export interface AcpPendingPermission {
  tool: string
  risk?: string
  conversationId?: string
  requestedAt: number
}

/** 编辑器直接 spawn 的那条命令；这个版本没随包带适配器时为 null */
export interface AcpAdapterLaunch {
  command: string
  args: string[]
  env: Record<string, string>
}

export interface AcpStatus {
  /** 本机服务端口；未监听时为 null */
  port: number | null
  /** 随包带的适配器怎么启动；没带就是 null */
  adapter: AcpAdapterLaunch | null
  tokenPath: string
  /** 本进程最近一次收到适配器握手（/api/agents/list）的时间，没有则为 null */
  lastHandshakeAt: number | null
  sessions: AcpSessionStatus[]
  pendingPermissions: AcpPendingPermission[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function parseMcpServers(value: unknown): { name: string; toolCount: number }[] {
  if (!Array.isArray(value)) return []
  return value.flatMap(item => (
    isRecord(item) && typeof item.name === 'string' && typeof item.toolCount === 'number'
      ? [{ name: item.name, toolCount: item.toolCount }]
      : []
  ))
}

function parseSession(value: unknown): AcpSessionStatus | null {
  if (!isRecord(value)) return null
  if (typeof value.conversationId !== 'string' || typeof value.title !== 'string') return null
  if (typeof value.role !== 'string' || typeof value.lastActivityAt !== 'number') return null
  return {
    conversationId: value.conversationId,
    title: value.title,
    role: value.role,
    cwd: optionalString(value.cwd),
    client: optionalString(value.client),
    protocolVersion: typeof value.protocolVersion === 'number' ? value.protocolVersion : undefined,
    agent: optionalString(value.agent),
    mcpServers: parseMcpServers(value.mcpServers),
    lastActivityAt: value.lastActivityAt,
    streaming: value.streaming === true
  }
}

function parseAdapterLaunch(value: unknown): AcpAdapterLaunch | null {
  if (!isRecord(value) || typeof value.command !== 'string' || !Array.isArray(value.args)) return null
  const env = isRecord(value.env) ? value.env : {}
  return {
    command: value.command,
    args: value.args.filter((arg): arg is string => typeof arg === 'string'),
    env: Object.fromEntries(
      Object.entries(env).flatMap(([key, item]) => (typeof item === 'string' ? [[key, item]] : []))
    )
  }
}

function parsePendingPermission(value: unknown): AcpPendingPermission | null {
  if (!isRecord(value) || typeof value.tool !== 'string') return null
  return {
    tool: value.tool,
    risk: optionalString(value.risk),
    conversationId: optionalString(value.conversationId),
    requestedAt: typeof value.requestedAt === 'number' ? value.requestedAt : 0
  }
}

export function parseAcpStatus(value: unknown): AcpStatus {
  if (!isRecord(value) || typeof value.tokenPath !== 'string') {
    throw new Error('OpenPipal ACP status response is invalid')
  }
  return {
    port: typeof value.port === 'number' ? value.port : null,
    adapter: parseAdapterLaunch(value.adapter),
    tokenPath: value.tokenPath,
    lastHandshakeAt: typeof value.lastHandshakeAt === 'number' ? value.lastHandshakeAt : null,
    sessions: Array.isArray(value.sessions)
      ? value.sessions.map(parseSession).filter((item): item is AcpSessionStatus => item !== null)
      : [],
    pendingPermissions: Array.isArray(value.pendingPermissions)
      ? value.pendingPermissions
        .map(parsePendingPermission)
        .filter((item): item is AcpPendingPermission => item !== null)
      : []
  }
}

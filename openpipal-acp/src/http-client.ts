/**
 * OpenPipal 桌面端 HTTP 客户端
 *
 * 翻译器封装：把 ACP 的请求转成桌面端 :3031 的 HTTP 调用。
 * openpipal-acp 自身无 Agent 逻辑——所有真活在桌面端做。
 */

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

// Node 20+ 内置 fetch（基于 undici）—— 不再 bundle undici
// 优势：dist 体积减半 + 无 ESM/CJS 互操作问题

const DEFAULT_BASE = process.env.OPENPIPAL_BASE_URL || 'http://127.0.0.1:3031'
const ACP_MCP_TOKEN_PATH = join(homedir(), '.openpipal', 'acp-mcp.token')
const ACP_MCP_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/

/**
 * The desktop app writes this local secret with mode 0600 before accepting
 * dynamic ACP adapter calls. OPENPIPAL_ACP_TOKEN supports an explicitly
 * configured adapter environment without exposing a token through HTTP.
 */
export function getAcpMcpToken(): string {
  const configured = process.env.OPENPIPAL_ACP_TOKEN?.trim()
  let token = configured
  if (!token) {
    try {
      token = readFileSync(ACP_MCP_TOKEN_PATH, 'utf8').trim()
    } catch {
      throw new Error('OpenPipal local authorization token is unavailable. Start the OpenPipal desktop app first, or set OPENPIPAL_ACP_TOKEN.')
    }
  }

  if (!ACP_MCP_TOKEN_PATTERN.test(token)) {
    throw new Error('OpenPipal local authorization token is invalid.')
  }
  return token
}

function acpMcpAuthHeaders(): Record<string, string> {
  return { 'X-OpenPipal-ACP-Token': getAcpMcpToken() }
}

function nativeJsonHeaders(): Record<string, string> {
  return { 'Content-Type': 'application/json', ...acpMcpAuthHeaders() }
}

/** 桌面端是否运行 */
export async function probeDesktop(baseUrl: string = DEFAULT_BASE): Promise<boolean> {
  try {
    const res = await fetch(`${baseUrl}/health`, {
      method: 'GET',
      signal: AbortSignal.timeout(2000),
    })
    if (!res.ok) return false
    const data = (await res.json()) as { status?: string; app?: string }
    return data.status === 'ok' && data.app === 'openpipal'
  } catch {
    return false
  }
}

/** 创建会话——返回桌面端的 conversation id 作为 ACP sessionId
 *
 * Stage 8: 可选传 role / workspaceId 关联到特定 Agent
 * - role: 内置角色之一（含通用默认 "general"）
 * - workspaceId: 用户保存的自定义 Agent UUID(覆盖 role 的 systemPrompt,走 agent.md+memories)
 */
export async function createConversation(
  title: string,
  baseUrl: string = DEFAULT_BASE,
  options?: {
    role?: string
    workspaceId?: string
    agentId?: string
    workingDir?: string
    client?: string
    protocolVersion?: number
  },
): Promise<{ id: string; role: string; config?: Record<string, unknown> }> {
  const body: Record<string, any> = { title }
  if (options?.role) body.role = options.role
  if (options?.workspaceId) body.workspaceId = options.workspaceId
  if (options?.agentId) body.agentId = options.agentId

  const res = await fetch(`${baseUrl}/api/conversations`, {
    method: 'POST',
    headers: nativeJsonHeaders(),
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    throw new Error(`Failed to create conversation: ${res.status} ${res.statusText}`)
  }
  const data = (await res.json()) as { id: string; role: string; config?: Record<string, unknown> }
  if (options?.workingDir) {
    const patch = await fetch(`${baseUrl}/api/conversations/${encodeURIComponent(data.id)}`, {
      method: 'PATCH',
      headers: nativeJsonHeaders(),
      body: JSON.stringify({
        config: {
          ...(data.config || {}),
          workingDir: options.workingDir,
          acp: {
            adapter: 'openpipal-acp',
            // 桌面端设置页据此显示"Zed · ACP v2"；老适配器不带这两个字段，显示成未知编辑器
            ...(options.client ? { client: options.client } : {}),
            ...(options.protocolVersion ? { protocolVersion: options.protocolVersion } : {}),
          },
        },
      }),
    })
    if (!patch.ok) {
      throw new Error(`Failed to persist ACP working directory: ${patch.status} ${patch.statusText}`)
    }
  }
  return data
}

export interface ConversationSummary {
  id: string
  title: string
  role: string
  workspaceId?: string
  config?: {
    workingDir?: string
    acp?: { adapter?: string }
    [key: string]: unknown
  }
  createdAt: number
  updatedAt: number
  messageCount: number
}

export interface ConversationRecord extends ConversationSummary {
  messages?: StoredConversationMessage[]
}

export interface StoredConversationMessage {
  id: string
  role: string
  content?: string
  timestamp?: number
}

/** ACP v2 session/list 的持久化来源。 */
export async function listConversations(
  baseUrl: string = DEFAULT_BASE,
): Promise<ConversationSummary[]> {
  const res = await fetch(`${baseUrl}/api/conversations`, { method: 'GET', headers: acpMcpAuthHeaders() })
  if (!res.ok) throw new Error(`Failed to list conversations: ${res.status}`)
  return (await res.json()) as ConversationSummary[]
}

/** ACP v2 session/resume 用于验证会话及恢复 cwd/角色。 */
export async function getConversation(
  conversationId: string,
  baseUrl: string = DEFAULT_BASE,
): Promise<ConversationRecord | null> {
  const res = await fetch(`${baseUrl}/api/conversations/${encodeURIComponent(conversationId)}`, {
    method: 'GET',
    headers: acpMcpAuthHeaders(),
  })
  if (res.status === 404) return null
  if (!res.ok) throw new Error(`Failed to get conversation: ${res.status}`)
  return (await res.json()) as ConversationRecord
}

/** replayFrom:start 使用服务端已经落盘的用户/助手消息。 */
export async function getConversationMessages(
  conversationId: string,
  baseUrl: string = DEFAULT_BASE,
): Promise<StoredConversationMessage[]> {
  const res = await fetch(
    `${baseUrl}/api/conversations/${encodeURIComponent(conversationId)}/messages`,
    { method: 'GET', headers: acpMcpAuthHeaders() },
  )
  if (!res.ok) throw new Error(`Failed to get conversation messages: ${res.status}`)
  return (await res.json()) as StoredConversationMessage[]
}

export async function deleteConversation(
  conversationId: string,
  baseUrl: string = DEFAULT_BASE,
): Promise<void> {
  const res = await fetch(`${baseUrl}/api/conversations/${encodeURIComponent(conversationId)}`, {
    method: 'DELETE',
    headers: acpMcpAuthHeaders(),
  })
  if (!res.ok) throw new Error(`Failed to delete conversation: ${res.status}`)
}

/** 流式聊天——返回 fetch response body，调用方用 SSE parser 处理 */
export async function streamChat(
  body: {
    messages: Array<{ role: 'user' | 'assistant' | 'system'; content: string }>
    conversationId?: string
  },
  signal: AbortSignal,
  baseUrl: string = DEFAULT_BASE,
): Promise<ReadableStream<Uint8Array>> {
  const res = await fetch(`${baseUrl}/chat/stream`, {
    method: 'POST',
    headers: nativeJsonHeaders(),
    body: JSON.stringify({
      ...body,
      // 'acp' 让桌面端知道 renderer 不在场：服务端负责会话落盘 + 从存储重建跨轮历史。
      // 放在 spread 之后 = 调用方不可覆盖（此前 spread 在后曾让硬编码 'extension' 静默压掉它）
      source: 'acp',
    }),
    signal,
  })
  if (!res.ok) {
    throw new Error(`/chat/stream failed: ${res.status} ${res.statusText}`)
  }
  if (!res.body) {
    throw new Error('/chat/stream returned no body')
  }
  return res.body
}

/** 持久化单个 ACP conversation 的 role，不改变桌面端全局角色。 */
/**
 * 改这条会话用哪个人格：内置角色传 `{ role, workspaceId: null }`（必须同时清掉
 * workspace 绑定，否则自定义 Agent 的 systemPrompt 仍然压过角色，"切回去"等于没切）；
 * 自定义 Agent 传 `{ workspaceId }`，角色留着当工具基线。
 */
export async function updateConversationPersona(
  conversationId: string,
  patch: { role?: string; workspaceId?: string | null },
  baseUrl: string = DEFAULT_BASE,
): Promise<void> {
  const res = await fetch(`${baseUrl}/api/conversations/${encodeURIComponent(conversationId)}`, {
    method: 'PATCH',
    headers: nativeJsonHeaders(),
    body: JSON.stringify(patch),
  })
  if (!res.ok) {
    let detail = ''
    try {
      const body = (await res.json()) as { error?: unknown }
      if (typeof body.error === 'string') detail = body.error.trim()
    } catch {
      // Preserve the HTTP fallback when a non-JSON intermediary responds.
    }
    throw new Error(detail || `Failed to update conversation persona: ${res.status} ${res.statusText}`.trim())
  }
}

/** 列出所有可用 Agent（4 内置 + 用户保存的） */
export async function listAgents(
  baseUrl: string = DEFAULT_BASE,
): Promise<{ builtins: Array<{ name: string; displayName?: string; icon?: string }>; agents: Array<{ id: string; name: string; icon: string }> }> {
  const res = await fetch(`${baseUrl}/api/agents/list`, { method: 'GET', headers: acpMcpAuthHeaders() })
  if (!res.ok) {
    throw new Error(`Failed to list agents: ${res.status}`)
  }
  return (await res.json()) as any
}

/**
 * 桌面端 → 适配器的常驻推送通道。一直挂着，只在桌面端/插件/别的客户端改了会话时
 * 吐一条 `{type:'conversation_changed', conversationId, kind}`。内容不带，收到信号
 * 自己回读磁盘——磁盘才是事实源。
 */
export async function openDesktopEventStream(
  signal: AbortSignal,
  baseUrl: string = DEFAULT_BASE,
): Promise<ReadableStream<Uint8Array>> {
  const res = await fetch(`${baseUrl}/api/acp/events`, {
    method: 'GET',
    headers: acpMcpAuthHeaders(),
    signal,
  })
  if (!res.ok || !res.body) {
    throw new Error(`Failed to open desktop event stream: ${res.status} ${res.statusText}`.trim())
  }
  return res.body
}

/** 会话目标（`/goal` 背后的状态）。桌面端设完之后每轮结束会自动判定有没有达成。 */
export interface ConversationGoalState {
  text: string
  maxTurns: number
  turnsUsed: number
  status: 'active' | 'paused' | 'done' | 'exceeded'
  lastCheck?: { ok: boolean; reason: string; timestamp: number; fallback?: boolean }
}

export async function getConversationGoal(
  conversationId: string,
  baseUrl: string = DEFAULT_BASE,
): Promise<ConversationGoalState | null> {
  const res = await fetch(`${baseUrl}/api/conversations/${encodeURIComponent(conversationId)}/goal`, {
    method: 'GET',
    headers: acpMcpAuthHeaders(),
  })
  if (!res.ok) throw new Error(`Failed to read conversation goal: ${res.status}`)
  return ((await res.json()) as { goal?: ConversationGoalState | null }).goal || null
}

export async function setConversationGoal(
  conversationId: string,
  text: string,
  baseUrl: string = DEFAULT_BASE,
): Promise<ConversationGoalState> {
  const res = await fetch(`${baseUrl}/api/conversations/${encodeURIComponent(conversationId)}/goal`, {
    method: 'POST',
    headers: nativeJsonHeaders(),
    body: JSON.stringify({ text }),
  })
  if (!res.ok) throw new Error(`Failed to set conversation goal: ${res.status}`)
  return ((await res.json()) as { goal: ConversationGoalState }).goal
}

export async function clearConversationGoal(
  conversationId: string,
  baseUrl: string = DEFAULT_BASE,
): Promise<void> {
  const res = await fetch(`${baseUrl}/api/conversations/${encodeURIComponent(conversationId)}/goal`, {
    method: 'DELETE',
    headers: acpMcpAuthHeaders(),
  })
  if (!res.ok) throw new Error(`Failed to clear conversation goal: ${res.status}`)
}

/**
 * 本会话可用的技能。自定义 Agent 只带它自己的，内置角色带全局启用的那批——
 * 换人格之后要重拉，否则编辑器的斜杠命令列表是上一个人格的。
 */
export async function listSkills(
  workspaceId: string | undefined,
  role: string | undefined,
  baseUrl: string = DEFAULT_BASE,
): Promise<Array<{ name: string; description: string }>> {
  // 两档作用域二选一：绑了自定义 Agent 就只看它自己的技能，否则按内置角色取
  // （全局技能 + 这个角色的专属技能）。role 不传就漏掉角色专属那批。
  const query = workspaceId
    ? `?workspaceId=${encodeURIComponent(workspaceId)}`
    : role
      ? `?role=${encodeURIComponent(role)}`
      : ''
  const res = await fetch(`${baseUrl}/api/skills${query}`, { method: 'GET', headers: acpMcpAuthHeaders() })
  if (!res.ok) throw new Error(`Failed to list skills: ${res.status}`)
  const body = (await res.json()) as { skills?: Array<{ name?: string; description?: string }> }
  return (body.skills || [])
    .filter((skill): skill is { name: string; description?: string } => typeof skill.name === 'string' && skill.name.length > 0)
    .map((skill) => ({ name: skill.name, description: skill.description || skill.name }))
}

/**
 * 把 ACP NewSessionRequest.mcpServers 透传给桌面端,session 范围注册。
 * mcpServers 直接是 ACP McpServer[] 形态(http/sse/stdio),http-server 端转
 * 成 mcp-manager 配置。返回 { registered, failed }——单个 server 失败不
 * 抛错,只在结果里报告,不阻塞 session 创建。
 */
export async function registerSessionMcpServers(
  sessionId: string,
  mcpServers: unknown[],
  baseUrl: string = DEFAULT_BASE,
): Promise<{ registered: { name: string; toolCount: number }[]; failed: { name: string; error: string }[] }> {
  const res = await fetch(`${baseUrl}/api/acp/sessions/${encodeURIComponent(sessionId)}/mcp`, {
    method: 'POST',
    headers: nativeJsonHeaders(),
    body: JSON.stringify({ mcpServers }),
  })
  if (!res.ok) {
    throw new Error(`Failed to register session MCP: ${res.status} ${res.statusText}`)
  }
  return (await res.json()) as { registered: { name: string; toolCount: number }[]; failed: { name: string; error: string }[] }
}

/** 注销某 session 范围下所有 MCP server。进程退出 / session 显式结束时调。 */
export async function unregisterSessionMcpServers(
  sessionId: string,
  baseUrl: string = DEFAULT_BASE,
): Promise<void> {
  // 用短 timeout——退出清理时桌面端可能已挂,不要因此 hang 住 process.exit
  try {
    await fetch(`${baseUrl}/api/acp/sessions/${encodeURIComponent(sessionId)}/mcp`, {
      method: 'DELETE',
      headers: acpMcpAuthHeaders(),
      signal: AbortSignal.timeout(2000),
    })
  } catch {
    // best-effort 清理,失败不该阻塞退出
  }
}

export { DEFAULT_BASE }

/**
 * 权限确认回传（对称于浏览器侧栏的 POST /api/permission）。
 *
 * 桌面端只接受"回答自己那条还活着的流"的 native 请求，所以 executionId /
 * conversationId 必须原样带回——两者来自权限事件本身，适配器不构造也不猜。
 */
export async function respondPermission(
  decision: {
    requestId: string
    approved: boolean
    sessionApprove?: boolean
    executionId?: string
    conversationId?: string
  },
  baseUrl: string = DEFAULT_BASE,
): Promise<void> {
  const res = await fetch(`${baseUrl}/api/permission`, {
    method: 'POST',
    headers: nativeJsonHeaders(),
    body: JSON.stringify(decision),
  })
  if (!res.ok) {
    throw new Error(`Failed to submit permission decision: ${res.status} ${res.statusText}`)
  }
}

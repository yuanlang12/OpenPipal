/**
 * 拼装设置页「外部连接」看到的那份快照。
 *
 * 三个来源各答各的：会话存储答"有哪些 ACP 会话、来自哪个编辑器"（适配器写的
 * `config.acp`），内存注册表答"此刻在不在跑"，权限队列答"有没有在等你点头"。
 * 这里只做合并，不新增任何持久化。
 */

import type { AcpPendingPermission, AcpSessionStatus, AcpStatus } from '../shared/acp-status-contract'
import { getAcpMcpTokenPath } from './credential-paths'
import { getAcpLastHandshakeAt, getAcpLiveEntry } from './acp-session-registry'
import { listConversations } from './conversation-store'
import { listSessionMcpServers } from './mcp-manager'
import { listWorkspaces } from './agent-workspace-store'
import { getHttpListeningPort } from './http-server'
import { resolveAcpAdapterLaunch } from './acp-adapter-launch'

/** 适配器给会话打的标记（openpipal-acp 的 createConversation 之后 PATCH 上去） */
const ACP_ADAPTER = 'openpipal-acp'

export function buildAcpStatus(pendingPermissions: AcpPendingPermission[] = []): AcpStatus {
  // 只有真有会话挂在自定义 Agent 上才去扫 workspace 目录——大多数时候一次都不扫
  let workspaceNames: Map<string, string> | null = null
  const workspaceName = (id: string | undefined): string | undefined => {
    if (!id) return undefined
    if (!workspaceNames) workspaceNames = new Map(listWorkspaces().map(item => [item.id, item.name]))
    return workspaceNames.get(id)
  }

  const sessions: AcpSessionStatus[] = []
  for (const conversation of listConversations()) {
    const acp = conversation.config?.acp
    if (acp?.adapter !== ACP_ADAPTER) continue
    const live = getAcpLiveEntry(conversation.id)
    sessions.push({
      conversationId: conversation.id,
      title: conversation.title,
      role: conversation.role,
      cwd: conversation.config?.workingDir,
      client: acp.client,
      protocolVersion: acp.protocolVersion,
      // Agent 被删掉后留空,不拿一个已经不存在的名字充数
      agent: workspaceName(conversation.workspaceId),
      mcpServers: listSessionMcpServers(conversation.id),
      lastActivityAt: live?.lastActivityAt ?? conversation.updatedAt,
      streaming: live?.streaming === true
    })
  }
  sessions.sort((a, b) => b.lastActivityAt - a.lastActivityAt)

  const acpConversationIds = new Set(sessions.map(session => session.conversationId))
  return {
    port: getHttpListeningPort(),
    // 每次现算：只是一次 existsSync，换来的是"文件真在才敢报这条命令"
    adapter: resolveAcpAdapterLaunch(),
    tokenPath: getAcpMcpTokenPath(),
    lastHandshakeAt: getAcpLastHandshakeAt(),
    sessions,
    // 桌面/插件自己的确认气泡有各自的 UI，这里只列属于 ACP 会话的那些
    pendingPermissions: pendingPermissions.filter(pending => (
      pending.conversationId !== undefined && acpConversationIds.has(pending.conversationId)
    ))
  }
}

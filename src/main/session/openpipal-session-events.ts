import type { JsonValue } from '@earendil-works/pi-agent-core'
import type { ConversationConfig, StoredMessage } from '../conversation-store'
import { DEFAULT_AGENT_ID } from '../../shared/agent-identity'

export const OPENPIPAL_MESSAGE_EVENT = 'openpipal.message-event.v1'
export const OPENPIPAL_PRODUCT_SNAPSHOT = 'openpipal.product-snapshot.v1'
export const OPENPIPAL_SESSION_SCHEMA = 1

export type OpenPipalSessionCreatedBy = 'desktop' | 'acp' | 'scheduler' | 'voice' | 'test'

export interface OpenPipalSessionHeader {
  openpipalSchema: 1
  conversationId: string
  createdBy: OpenPipalSessionCreatedBy
  initialRole: string
  initialTitle: string
  initialCreatedAt: number
  initialAgentId?: string
  initialWorkspaceId?: string
  /** 统一的 Agent 身份；老文件没有，读侧派生 */
  initialAgent?: string
  /** 团队话题：建会话时定、之后不可改（只在文件头，快照不带） */
  initialTeamId?: string
  initialChannel?: string
}

export interface OpenPipalMessageEvent {
  schema: 1
  operation: 'append' | 'update'
  message: StoredMessage
}

/** Full product snapshot on its own lane; it never enters model history. */
export interface OpenPipalProductSnapshot {
  schema: 1
  title: string
  role: string
  agentId?: string
  workspaceId?: string
  agent?: string
  config?: ConversationConfig
  updatedAt: number
}

export function toJsonValue(value: unknown): JsonValue {
  const encoded = JSON.stringify(value)
  if (encoded === undefined) throw new Error('Session event is not JSON serializable')
  return JSON.parse(encoded) as JsonValue
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

export function readMessageEvent(value: unknown): OpenPipalMessageEvent | null {
  if (!isRecord(value) || value.schema !== OPENPIPAL_SESSION_SCHEMA) return null
  if (value.operation !== 'append' && value.operation !== 'update') return null
  if (!isRecord(value.message)) return null
  const message = value.message
  if (
    typeof message.id !== 'string' || !message.id ||
    (message.role !== 'user' && message.role !== 'assistant' && message.role !== 'tool') ||
    typeof message.content !== 'string' ||
    typeof message.timestamp !== 'number' || !Number.isFinite(message.timestamp)
  ) return null
  return value as unknown as OpenPipalMessageEvent
}

export function readProductSnapshot(value: unknown): OpenPipalProductSnapshot | null {
  if (!isRecord(value) || value.schema !== OPENPIPAL_SESSION_SCHEMA) return null
  if (
    typeof value.title !== 'string' ||
    typeof value.updatedAt !== 'number' || !Number.isFinite(value.updatedAt)
  ) return null
  if (value.agentId !== undefined && typeof value.agentId !== 'string') return null
  if (value.workspaceId !== undefined && typeof value.workspaceId !== 'string') return null
  if (value.agent !== undefined && typeof value.agent !== 'string') return null
  // role 与 agent 至少要有一个：今天写侧两个都写；将来只写 agent 的文件，这一版也得打得开（role 回落到中性值）
  if (typeof value.role !== 'string') {
    if (typeof value.agent !== 'string' || !value.agent) return null
    return { ...(value as unknown as OpenPipalProductSnapshot), role: DEFAULT_AGENT_ID }
  }
  if (value.config !== undefined && !isRecord(value.config)) return null
  return value as unknown as OpenPipalProductSnapshot
}

export function readSessionHeader(value: unknown): OpenPipalSessionHeader | null {
  if (!isRecord(value) || value.openpipalSchema !== OPENPIPAL_SESSION_SCHEMA) return null
  if (
    typeof value.conversationId !== 'string' ||
    typeof value.createdBy !== 'string' ||
    typeof value.initialTitle !== 'string' ||
    typeof value.initialCreatedAt !== 'number' || !Number.isFinite(value.initialCreatedAt)
  ) return null
  if (value.initialAgentId !== undefined && typeof value.initialAgentId !== 'string') return null
  if (value.initialWorkspaceId !== undefined && typeof value.initialWorkspaceId !== 'string') return null
  if (value.initialAgent !== undefined && typeof value.initialAgent !== 'string') return null
  if (value.initialTeamId !== undefined && typeof value.initialTeamId !== 'string') return null
  if (value.initialChannel !== undefined && typeof value.initialChannel !== 'string') return null
  // initialRole 与 initialAgent 至少要有一个（同 readProductSnapshot）
  if (typeof value.initialRole !== 'string') {
    if (typeof value.initialAgent !== 'string' || !value.initialAgent) return null
    return { ...(value as unknown as OpenPipalSessionHeader), initialRole: DEFAULT_AGENT_ID }
  }
  return value as unknown as OpenPipalSessionHeader
}

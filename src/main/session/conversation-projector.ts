import type { Entry, JsonlSessionMetadata, Session } from '@earendil-works/pi-agent-core'
import type { Conversation, ConversationSummary, StoredMessage } from '../conversation-store'
import { normalizeStoredMessage } from '../conversation-store'
import {
  OPENPIPAL_MESSAGE_EVENT,
  OPENPIPAL_PRODUCT_SNAPSHOT,
  readMessageEvent,
  readProductSnapshot,
  readSessionHeader,
  type OpenPipalProductSnapshot,
} from './openpipal-session-events'

export interface ProjectedMessageBranch {
  messages: StoredMessage[]
  /** Entry that represented each message after its latest in-branch update. */
  anchors: string[]
}

function customEntries(entries: Entry[], customType: string): Entry[] {
  return entries.filter((entry) => entry.type === 'custom' && entry.customType === customType)
}

export async function projectMessageBranch(session: Session<JsonlSessionMetadata>): Promise<ProjectedMessageBranch> {
  const entries = customEntries(
    await session.findEntriesOnBranch({ order: 'oldestFirst' }),
    OPENPIPAL_MESSAGE_EVENT
  )
  const messages: StoredMessage[] = []
  const anchors: string[] = []
  const positions = new Map<string, number>()

  for (const entry of entries) {
    if (entry.type !== 'custom') continue
    const event = readMessageEvent(entry.data)
    if (!event) continue
    const message = normalizeStoredMessage(event.message)
    if (event.operation === 'update') {
      const position = positions.get(message.id)
      if (position !== undefined) {
        messages[position] = message
        anchors[position] = entry.id
        continue
      }
    }
    positions.set(message.id, messages.length)
    messages.push(message)
    anchors.push(entry.id)
  }
  return { messages, anchors }
}

async function projectProductSnapshot(
  session: Session<JsonlSessionMetadata>
): Promise<OpenPipalProductSnapshot | null> {
  const entries = await session.view('product').findEntriesOnBranch({
    type: 'custom',
    customType: OPENPIPAL_PRODUCT_SNAPSHOT,
    order: 'newestFirst',
    limit: 1,
  })
  const entry = entries[0]
  return entry?.type === 'custom' ? readProductSnapshot(entry.data) : null
}

export async function projectConversation(
  session: Session<JsonlSessionMetadata>
): Promise<Conversation> {
  const metadata = await session.getMetadata()
  const header = readSessionHeader(metadata.metadata)
  if (!header || header.conversationId !== metadata.id) {
    throw new Error(`Session ${metadata.id} is not an OpenPipal JSONL session`)
  }
  const [{ messages }, product] = await Promise.all([
    projectMessageBranch(session),
    projectProductSnapshot(session),
  ])
  const messageUpdatedAt = messages.reduce((latest, message) => Math.max(latest, message.timestamp), 0)
  const agentId = product ? product.agentId : header.initialAgentId
  const workspaceId = product ? product.workspaceId : header.initialWorkspaceId
  return {
    id: metadata.id,
    title: product?.title ?? header.initialTitle,
    role: product?.role ?? header.initialRole,
    ...(agentId ? { agentId } : {}),
    ...(workspaceId ? { workspaceId } : {}),
    ...(product?.config ? { config: product.config } : {}),
    createdAt: header.initialCreatedAt,
    updatedAt: product?.updatedAt ?? Math.max(header.initialCreatedAt, messageUpdatedAt),
    messages,
  }
}

function isSummaryCandidate(message: StoredMessage): boolean {
  if (message.role === 'tool' || message.messageKind === 'thinking' || message.permissionRequest) return false
  return Boolean((message.askQuestion || message.content || '').trim())
}

export function summarizeConversation(conversation: Conversation): ConversationSummary {
  const last = [...conversation.messages].reverse().find(isSummaryCandidate)
  const text = (last?.askQuestion || last?.content || '').replace(/\n/g, ' ').trim()
  return {
    id: conversation.id,
    title: conversation.title,
    role: conversation.role,
    ...(conversation.agentId ? { agentId: conversation.agentId } : {}),
    ...(conversation.workspaceId ? { workspaceId: conversation.workspaceId } : {}),
    ...(conversation.config ? { config: conversation.config } : {}),
    createdAt: conversation.createdAt,
    updatedAt: conversation.updatedAt,
    messageCount: conversation.messages.length,
    ...(text ? { lastMessage: text.substring(0, 80) } : {}),
  }
}

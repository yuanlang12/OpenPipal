import type { Conversation, ConversationSummary, StoredMessage } from '../conversation-store'
import type { OpenPipalSessionCreatedBy, OpenPipalProductSnapshot } from './openpipal-session-events'

export type OpenPipalSessionStorageKind = 'legacy-json' | 'pi-jsonl-v4'
export type OpenPipalOperationSource = 'desktop' | 'acp' | 'scheduler' | 'voice'
export type OpenPipalOperationOutcome = 'completed' | 'aborted' | 'failed' | 'declined'

export interface OpenPipalSessionRef {
  conversationId: string
  storage: 'pi-jsonl-v4'
  createdAt: number
}

export interface CreateOpenPipalSession {
  conversation: Conversation
  createdBy?: OpenPipalSessionCreatedBy
}

export interface OpenPipalSessionStore {
  create(input: CreateOpenPipalSession): Promise<OpenPipalSessionRef>
  open(conversationId: string): Promise<OpenPipalSessionRef | null>
  project(conversationId: string): Promise<Conversation | null>
  list(): Promise<ConversationSummary[]>
  appendMessages(conversationId: string, messages: StoredMessage[]): Promise<boolean>
  replaceMessages(conversationId: string, messages: StoredMessage[]): Promise<boolean>
  updateProduct(
    conversationId: string,
    update: Partial<Omit<OpenPipalProductSnapshot, 'schema' | 'updatedAt'>>
  ): Promise<boolean>
  beginOperation(
    conversationId: string,
    source: OpenPipalOperationSource
  ): Promise<string | null>
  finishOperation(
    conversationId: string,
    runId: string,
    outcome: OpenPipalOperationOutcome,
    error?: { code: string; message: string }
  ): Promise<boolean>
  recoverInterruptedOperation(conversationId: string): Promise<boolean>
  delete(conversationId: string): Promise<boolean>
  drain(): Promise<void>
}

/**
 * Controlled rollout only. The current Conversation Service remains the
 * authority until it can consume the async store contract end-to-end.
 */
export function resolveNewSessionStorageKind(
  value = process.env.OPENPIPAL_SESSION_STORE
): OpenPipalSessionStorageKind {
  return value?.trim().toLowerCase() === 'pi-jsonl-v4' ? 'pi-jsonl-v4' : 'legacy-json'
}

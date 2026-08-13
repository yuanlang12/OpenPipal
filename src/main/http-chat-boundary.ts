import type { ChatSource } from './agent-runtime/contracts'

export type HttpChatSource = Extract<ChatSource, 'extension' | 'acp'>

export interface HttpChatBoundaryFailure {
  ok: false
  status: 400 | 403
  error: string
}

/**
 * Treat body.source as a compatibility assertion, never as authority. This
 * also fails closed for the desktop-only tool surface on either HTTP route.
 */
export function validateHttpChatBodySource(
  assertedSource: unknown,
  transportSource: HttpChatSource,
): HttpChatBoundaryFailure | null {
  if (assertedSource === undefined || assertedSource === transportSource) return null
  if (assertedSource === 'acp') {
    return { ok: false, status: 403, error: 'ACP authorization required' }
  }
  if (assertedSource === 'extension') {
    return { ok: false, status: 400, error: 'Chat source does not match the authenticated transport' }
  }
  return { ok: false, status: 400, error: 'Unsupported HTTP chat source' }
}

/** Empty/non-string ids are stateless and must not acquire durable effects. */
export function normalizeHttpConversationId(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined
}

export function isDurableHttpTurn(conversationId: string | undefined): conversationId is string {
  return typeof conversationId === 'string' && conversationId.length > 0
}

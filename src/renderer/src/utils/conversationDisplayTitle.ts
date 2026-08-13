export const PERSISTED_DEFAULT_CONVERSATION_TITLE = '新对话'

export interface ConversationTitleFields {
  title: string
  messageCount: number
  agentId?: string
  workspaceId?: string
}

export type TranslateConversationTitle = (key: 'shell.history.defaultConversationTitle') => string

/**
 * Only the exact, empty, unbound persisted sentinel is UI copy. Every title
 * with user/agent/workspace meaning remains opaque dynamic content.
 */
export function isPersistedDefaultConversationTitle(conversation: ConversationTitleFields): boolean {
  return conversation.title === PERSISTED_DEFAULT_CONVERSATION_TITLE
    && conversation.messageCount === 0
    && !conversation.agentId
    && !conversation.workspaceId
}

export function getConversationDisplayTitle(
  conversation: ConversationTitleFields,
  t: TranslateConversationTitle,
): string {
  return isPersistedDefaultConversationTitle(conversation)
    ? t('shell.history.defaultConversationTitle')
    : conversation.title
}

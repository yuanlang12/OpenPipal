/**
 * MemoryNotice — 对话流中的记忆更新次级提醒
 *
 * 当自动记忆提取或 Dream 整理完成后，在最后一条消息下方
 * 显示一条小而不干扰的提示条，8 秒后自动消失。
 */

import type { TFunction } from 'i18next'
import { useTranslation } from 'react-i18next'
import { useChatStore } from '../stores/chatStore'

const SCOPE_LABEL_KEYS: Record<string, string> = {
  global: 'chat.memoryNotice.scopes.global',
  conversation: 'chat.memoryNotice.scopes.conversation'
}

const TYPE_ICONS: Record<string, string> = {
  user: '👤',
  feedback: '💡',
  project: '📋',
  reference: '🔗'
}

export function MemoryNotice() {
  const { t } = useTranslation()
  const notification = useChatStore(s => s.memoryNotification)
  if (!notification) return null

  return (
    <div className="flex justify-center my-2 animate-fade-in">
      <div className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-brand-50/60 dark:bg-brand-900/20 border border-brand-100/50 dark:border-brand-800/40 text-[11px] text-brand-600 dark:text-brand-400 max-w-[90%]">
        <MemoryIcon />
        <span className="truncate">
          {notification.type === 'extracted' ? (
            <ExtractedContent memories={notification.memories} t={t} />
          ) : (
            <DreamedContent actionsApplied={notification.actionsApplied} summary={notification.summary} t={t} />
          )}
        </span>
      </div>
    </div>
  )
}

function MemoryIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="flex-shrink-0 opacity-60">
      <path d="M12 2a7 7 0 0 1 7 7c0 2.38-1.19 4.47-3 5.74V17a1 1 0 0 1-1 1H9a1 1 0 0 1-1-1v-2.26C6.19 13.47 5 11.38 5 9a7 7 0 0 1 7-7z" />
      <line x1="9" y1="21" x2="15" y2="21" />
      <line x1="10" y1="24" x2="14" y2="24" />
    </svg>
  )
}

function ExtractedContent({
  memories,
  t,
}: {
  memories?: { name: string; type: string; scope: string }[]
  t: TFunction
}) {
  if (!memories?.length) return <span>{t('chat.memoryNotice.updated')}</span>

  if (memories.length === 1) {
    const m = memories[0]
    const icon = TYPE_ICONS[m.type] || '📝'
    const scopeKey = SCOPE_LABEL_KEYS[m.scope]
    const scope = scopeKey ? t(scopeKey) : m.scope
    return <span>{icon} {t('chat.memoryNotice.rememberedOne', { name: m.name, scope })}</span>
  }

  const globalCount = memories.filter(m => m.scope === 'global').length
  const convCount = memories.filter(m => m.scope === 'conversation').length
  const parts: string[] = []
  if (globalCount > 0) parts.push(t('chat.memoryNotice.globalCount', { count: globalCount }))
  if (convCount > 0) parts.push(t('chat.memoryNotice.conversationCount', { count: convCount }))

  return <span>📝 {t('chat.memoryNotice.rememberedMany', { parts: parts.join(' + ') })}</span>
}

function DreamedContent({
  actionsApplied,
  summary,
  t,
}: {
  actionsApplied?: number
  summary?: string
  t: TFunction
}) {
  const count = actionsApplied || 0
  const text = summary
    ? t('chat.memoryNotice.organizedWithSummary', { count, summary })
    : t('chat.memoryNotice.organized', { count })
  return <span>🌙 {text}</span>
}

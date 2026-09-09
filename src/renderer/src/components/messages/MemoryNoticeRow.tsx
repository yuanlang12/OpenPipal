/**
 * MemoryNoticeRow —— 对话流里「已记住：…」那枚胶囊。
 *
 * 记忆是顺手记下的一件事，不是这轮的主线任务：居中、小，长期留在它发生的位置
 * ——以前是 8 秒消失的浮条，用户回头找不到"记了什么"。与规则胶囊（HookNoticeRow）同族，壳在 NoticeCapsule。
 */
import type { TFunction } from 'i18next'
import { Lightbulb } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { ChatMessage, MemoryNotice } from '../../types'
import { NoticeCapsule } from './shared/NoticeCapsule'

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

export function MemoryNoticeRow({ message }: { message: ChatMessage }) {
  const { t } = useTranslation()
  const notice = message.memoryNotice
  if (!notice) return null

  return (
    <NoticeCapsule subtype="memory" icon={<Lightbulb className="w-3.5 h-3.5" />}>
      <span className="truncate">
        {notice.type === 'extracted' ? (
          <ExtractedContent memories={notice.memories} t={t} />
        ) : (
          <DreamedContent actionsApplied={notice.actionsApplied} summary={notice.summary} t={t} />
        )}
      </span>
    </NoticeCapsule>
  )
}

function ExtractedContent({ memories, t }: { memories: MemoryNotice['memories']; t: TFunction }) {
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

function DreamedContent({ actionsApplied, summary, t }: { actionsApplied?: number; summary?: string; t: TFunction }) {
  const count = actionsApplied || 0
  const text = summary
    ? t('chat.memoryNotice.organizedWithSummary', { count, summary })
    : t('chat.memoryNotice.organized', { count })
  return <span>🌙 {text}</span>
}

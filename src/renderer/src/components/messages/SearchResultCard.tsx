import { Search } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { ChatMessage } from '../../types'

export function SearchResultCard({ message }: { message: ChatMessage }) {
  const { t } = useTranslation()
  return (
    <div className="flex justify-start mb-msg animate-fade-in">
      <div className="max-w-msg w-full pl-3 pr-2 py-1.5 border-l border-border">
        <div className="flex items-center gap-1.5 mb-1">
          <Search className="w-3 h-3 text-brand-500 shrink-0" strokeWidth={1.75} />
          <span className="text-chat-meta font-medium text-ink-secondary">{t('chat.searchResult.title')}</span>
        </div>
        <div className="text-chat-meta text-ink-tertiary whitespace-pre-wrap leading-relaxed max-h-32 overflow-y-auto">
          {message.searchResults}
        </div>
      </div>
    </div>
  )
}

import { FileText, FolderOutput, Image as ImageIcon, Loader2, Palette, RefreshCw, Search } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useAppStore } from '../stores/appStore'
import { useChatStore } from '../stores/chatStore'
import { useWorkspaceStore } from '../stores/workspaceStore'
import { useTranslation } from 'react-i18next'
import { formatByteSize, formatRecentTimestamp } from '../i18n/formatters'

type ArtifactHistoryEntry = {
  id: string
  type: string
  title: string
  conversationId: string
  conversationTitle: string
  updatedAt: number
  thumbnail?: string
}

type FileHistoryEntry = {
  name: string
  path: string
  size: number
  updatedAt: number
  ext: string
  scope: 'global' | 'agent'
  workspaceId?: string
  workspaceName?: string
}

type LibraryEntry =
  | ({ kind: 'artifact' } & ArtifactHistoryEntry)
  | ({ kind: 'file' } & FileHistoryEntry)

function iconForFile(entry: FileHistoryEntry) {
  if (['png', 'jpg', 'jpeg', 'webp', 'gif', 'svg'].includes(entry.ext)) return ImageIcon
  return FileText
}

/**
 * 全局作品：只在用户主动打开时读跨会话历史。
 * 它与会话右侧的“输出”完全分开，避免当前任务被其他 Agent 的文件污染。
 */
export function OutputCenterPanel() {
  const { t, i18n } = useTranslation()
  const locale = i18n.resolvedLanguage || i18n.language
  const [artifacts, setArtifacts] = useState<ArtifactHistoryEntry[]>([])
  const [files, setFiles] = useState<FileHistoryEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [query, setQuery] = useState('')

  const refresh = useCallback(async () => {
    setLoading(true)
    const api = window.api
    try {
      const [artifactResult, fileResult] = await Promise.all([
        api?.listArtifactHistory?.(undefined, 200),
        api?.listOutputHistory?.()
      ])
      setArtifacts(Array.isArray(artifactResult) ? artifactResult : [])
      setFiles(Array.isArray(fileResult) ? fileResult : [])
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void refresh() }, [refresh])

  const entries = useMemo<LibraryEntry[]>(() => {
    const keyword = query.trim().toLowerCase()
    const merged: LibraryEntry[] = [
      ...artifacts.map(item => ({ ...item, kind: 'artifact' as const })),
      ...files.map(item => ({ ...item, kind: 'file' as const }))
    ].sort((a, b) => b.updatedAt - a.updatedAt)
    if (!keyword) return merged
    return merged.filter(entry => {
      const haystack = entry.kind === 'artifact'
        ? `${entry.title} ${entry.conversationTitle}`
        : `${entry.name} ${entry.workspaceName || ''} ${entry.scope === 'global'
            ? t('outputCenter.scope.global')
            : t('outputCenter.scope.agent')}`
      return haystack.toLowerCase().includes(keyword)
    })
  }, [artifacts, files, query, i18n.resolvedLanguage, i18n.language, t])

  const openEntry = async (entry: LibraryEntry): Promise<void> => {
    if (entry.kind === 'file') {
      useAppStore.getState().setActiveView('chat')
      useWorkspaceStore.getState().openTab({ kind: 'file', title: entry.name, filePath: entry.path })
      return
    }
    await useChatStore.getState().switchConversation(entry.conversationId)
    useAppStore.getState().setActiveView('chat')
    useWorkspaceStore.getState().openTab({
      kind: 'artifact',
      title: entry.title || t('outputCenter.fallback.untitled'),
      artifactId: entry.id
    })
  }

  return (
    <div className="flex-1 min-h-0 overflow-y-auto bg-surface-50" data-testid="output-center">
      <div className="max-w-4xl mx-auto px-6 py-7">
        <div className="flex items-start gap-3 mb-6">
          <div className="w-10 h-10 shrink-0 rounded-xl bg-brand-50 dark:bg-brand-900/30 text-brand-600 dark:text-brand-300 flex items-center justify-center">
            <FolderOutput className="w-5 h-5" />
          </div>
          <div className="min-w-0 flex-1">
            <h1 className="text-lg font-semibold text-surface-800">{t('outputCenter.title')}</h1>
            <p className="mt-1 text-sw-sm text-surface-500 break-words">{t('outputCenter.description')}</p>
          </div>
          <button
            onClick={() => { void refresh() }}
            className="shrink-0 p-2 rounded-md text-surface-400 hover:text-surface-700 hover:bg-surface-100 transition-colors"
            title={t('outputCenter.refresh')}
          >
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
          </button>
        </div>

        <div className="relative mb-4">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-surface-400" />
          <input
            value={query}
            onChange={event => setQuery(event.target.value)}
            placeholder={t('outputCenter.searchPlaceholder')}
            data-testid="output-center-search"
            className="w-full rounded-lg border border-surface-200 bg-surface-0 dark:bg-surface-50 pl-9 pr-3 py-2 text-sw-base text-surface-700 outline-none focus:border-brand-300 focus:ring-1 focus:ring-brand-100"
          />
        </div>

        {loading && entries.length === 0 ? (
          <div className="py-14 flex items-center justify-center gap-2 text-sw-sm text-surface-400"><Loader2 className="w-4 h-4 animate-spin" />{t('outputCenter.loading')}</div>
        ) : entries.length === 0 ? (
          <div className="py-14 text-center text-sw-sm text-surface-400">{query ? t('outputCenter.empty.search') : t('outputCenter.empty.default')}</div>
        ) : (
          <div className="rounded-xl overflow-hidden border border-surface-200 bg-surface-0 dark:bg-surface-50 divide-y divide-surface-100">
            {entries.map(entry => {
              const Icon = entry.kind === 'artifact' ? Palette : iconForFile(entry)
              const title = entry.kind === 'artifact' ? entry.title || t('outputCenter.fallback.untitled') : entry.name
              const subtitle = entry.kind === 'artifact'
                ? entry.conversationTitle || t('outputCenter.fallback.originalConversation')
                : entry.scope === 'agent'
                  ? `${entry.workspaceName || t('outputCenter.fallback.agent')} · ${formatByteSize(entry.size, locale)}`
                  : `${t('outputCenter.scope.global')} · ${formatByteSize(entry.size, locale)}`
              return (
                <button
                  key={entry.kind === 'artifact' ? `artifact:${entry.id}` : `file:${entry.path}`}
                  onClick={() => { void openEntry(entry) }}
                  data-testid="output-center-item"
                  className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-surface-50 dark:hover:bg-surface-50/70 transition-colors group"
                  title={title}
                >
                  {entry.kind === 'artifact' && entry.thumbnail ? (
                    <img src={entry.thumbnail} alt="" className="w-12 h-8 object-cover rounded-md bg-surface-100 shrink-0" draggable={false} />
                  ) : (
                    <div className="w-12 h-8 rounded-md bg-surface-100 flex items-center justify-center shrink-0">
                      <Icon className="w-4 h-4 text-surface-400 group-hover:text-brand-500 transition-colors" />
                    </div>
                  )}
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sw-base font-medium text-surface-700">{title}</span>
                    <span className="block mt-0.5 text-sw-sm text-surface-400 break-words">{subtitle}</span>
                  </span>
                  <span className="shrink-0 text-sw-xs text-surface-400">{formatRecentTimestamp(entry.updatedAt, locale)}</span>
                </button>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}

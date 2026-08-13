/**
 * SourcesPanel —— Cave 模式资料区主面板
 *
 * 渲染在 WorkspaceTabHost 的 SOURCES_TAB_ID 分支下,只在 learner + study mode 出现
 *
 * 视觉设计原则(来自 P1 "丝滑+愉悦"硬约束):
 *   - 留白和呼吸感优先 —— 学习场景对比设计场景,字号更大、间距更宽、色温更冷
 *   - 状态指示器克制 —— pending/ingesting 用低饱和的呼吸点,不用 spinner 满天飞
 *   - 空状态文案像同伴 —— "把你想搞懂的资料丢进来,我们一起读"
 */

import { useEffect, useState, DragEvent as ReactDragEvent } from 'react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import { FileText, Globe, FileType2, Image as ImageIcon, FileCode, FileQuestion, Trash2, Loader2, Plus } from 'lucide-react'
import { useSourcesStore } from '../../stores/sourcesStore'
import type { Source, SourceType, AddSourceParams } from '../../types'

/**
 * 从文件路径推断 source 类型 —— 用扩展名,不读 magic bytes
 */
function inferSourceType(filePath: string): SourceType {
  const m = filePath.toLowerCase().match(/\.([a-z0-9]+)$/)
  const ext = m ? m[1] : ''
  switch (ext) {
    case 'pdf': return 'pdf'
    case 'md':
    case 'markdown': return 'md'
    case 'html':
    case 'htm': return 'html'
    case 'txt':
    case 'text': return 'txt'
    case 'png':
    case 'jpg':
    case 'jpeg':
    case 'gif':
    case 'webp':
    case 'bmp': return 'image'
    default: return 'other'
  }
}

function fileNameFromPath(filePath: string): string {
  const m = filePath.match(/([^/\\]+)$/)
  if (!m) return filePath
  const name = m[1]
  // 去扩展名
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(0, dot) : name
}

function iconForType(type: SourceType): React.ComponentType<any> {
  switch (type) {
    case 'pdf': return FileText
    case 'html': return Globe
    case 'md': return FileCode
    case 'txt': return FileType2
    case 'image': return ImageIcon
    case 'url': return Globe
    default: return FileQuestion
  }
}

function fmtBytes(n?: number): string {
  if (!n) return ''
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

function StatusIndicator({ status, t }: { status: Source['status']; t: TFunction }) {
  if (status === 'ready') {
    return (
      <div className="flex items-center gap-1 text-[10px] text-emerald-600 dark:text-emerald-400">
        <div className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
        <span>{t('shell.workspace.sourceLibrary.status.ready')}</span>
      </div>
    )
  }
  if (status === 'pending' || status === 'ingesting') {
    return (
      <div className="flex items-center gap-1.5 text-[10px] text-surface-500">
        <Loader2 size={10} className="animate-spin" />
        <span>{t(`shell.workspace.sourceLibrary.status.${status}`)}</span>
      </div>
    )
  }
  if (status === 'failed') {
    return (
      <div className="flex items-center gap-1 text-[10px] text-rose-600 dark:text-rose-400">
        <div className="w-1.5 h-1.5 rounded-full bg-rose-500" />
        <span>{t('shell.workspace.sourceLibrary.status.failed')}</span>
      </div>
    )
  }
  return null
}

function SourceCard({ source, t }: { source: Source; t: TFunction }) {
  const removeOptimistic = useSourcesStore(s => s.removeOptimistic)
  const Icon = iconForType(source.type)
  const isPending = source.status === 'pending' || source.status === 'ingesting'

  return (
    <div
      className={[
        'group relative rounded-lg border bg-surface-0 dark:bg-surface-50',
        'border-surface-100',
        'p-4 transition-all hover:border-brand-200 dark:hover:border-brand-700 hover:shadow-sm',
        isPending ? 'animate-pulse' : ''
      ].join(' ')}
    >
      {/* 角标(citation index) */}
      {typeof source.citationIndex === 'number' && (
        <div
          className="absolute -top-1.5 -left-1.5 w-5 h-5 rounded-full bg-brand-500 text-ink-on-accent text-[10px] font-medium flex items-center justify-center shadow-sm"
          title={t('shell.workspace.sourceLibrary.citationNumber', { index: source.citationIndex })}
        >
          {source.citationIndex}
        </div>
      )}

      {/* 删除按钮 —— hover 才显示 */}
      <button
        type="button"
        onClick={() => {
          if (confirm(t('shell.workspace.sourceLibrary.confirmRemove', { title: source.title }))) {
            removeOptimistic(source.id)
          }
        }}
        className="absolute top-2 right-2 p-1 rounded-md opacity-0 group-hover:opacity-100 text-surface-400 hover:text-rose-500 hover:bg-rose-50 dark:hover:bg-rose-950/40 transition-all"
        title={t('shell.workspace.sourceLibrary.remove')}
      >
        <Trash2 size={12} />
      </button>

      {/* 类型 icon + 标题 */}
      <div className="flex items-start gap-2.5">
        <div className="shrink-0 w-9 h-9 rounded-md bg-surface-50 dark:bg-surface-50/40 flex items-center justify-center text-surface-500">
          <Icon size={18} />
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-[13px] font-medium text-surface-800 leading-tight line-clamp-2">
            {source.title}
          </div>
          {source.byteSize && (
            <div className="text-[10px] text-surface-400 mt-1">
              {fmtBytes(source.byteSize)}
            </div>
          )}
        </div>
      </div>

      {/* Summary preview (ready 后) */}
      {source.summary && source.status === 'ready' && (
        <p className="mt-3 text-[11px] text-surface-500 leading-relaxed line-clamp-2">
          {source.summary}
        </p>
      )}

      {/* 状态条 */}
      <div className="mt-3 pt-2.5 border-t border-surface-50 dark:border-surface-100/50 flex items-center justify-between">
        <StatusIndicator status={source.status} t={t} />
        {source.sourceUrl && (
          <a
            href={source.sourceUrl}
            target="_blank"
            rel="noreferrer"
            className="text-[10px] text-surface-400 hover:text-brand-500 truncate max-w-[120px]"
            title={source.sourceUrl}
          >
            {t('shell.workspace.sourceLibrary.sourceLink')}
          </a>
        )}
      </div>
    </div>
  )
}

function EmptyState({ t }: { t: TFunction }) {
  return (
    <div className="h-full flex flex-col items-center justify-center px-8 py-12 text-center">
      <div className="w-16 h-16 rounded-2xl bg-surface-50 dark:bg-surface-50/40 flex items-center justify-center mb-5">
        <FileText size={28} className="text-surface-400" />
      </div>
      <h3 className="text-base font-medium text-surface-700 mb-2">
        {t('shell.workspace.sourceLibrary.emptyTitle')}
      </h3>
      <p className="text-[13px] text-surface-500 leading-relaxed max-w-xs">
        {t('shell.workspace.sourceLibrary.emptyIntro')}<br />
        {t('shell.workspace.sourceLibrary.supported')}
      </p>
      <div className="mt-6 text-[11px] text-surface-400">
        {t('shell.workspace.sourceLibrary.dropHint')}
      </div>
    </div>
  )
}

export function SourcesPanel() {
  const { t } = useTranslation()
  const sources = useSourcesStore(s => s.sources)
  const loaded = useSourcesStore(s => s.loaded)
  const refresh = useSourcesStore(s => s.refresh)
  const addOptimistic = useSourcesStore(s => s.addOptimistic)
  const [isDragOver, setIsDragOver] = useState(false)

  // 首次挂载时拉一次
  useEffect(() => {
    if (!loaded) refresh()
  }, [loaded, refresh])

  // ---- 拖拽 ingest(P3.4 B 路径)----
  const handleDragOver = (e: ReactDragEvent<HTMLDivElement>): void => {
    e.preventDefault()
    e.stopPropagation()
    if (!isDragOver) setIsDragOver(true)
  }
  const handleDragLeave = (e: ReactDragEvent<HTMLDivElement>): void => {
    e.preventDefault()
    e.stopPropagation()
    // 仅在离开容器外才清除（避免子元素 drag 触发误清）
    const related = (e.nativeEvent as DragEvent).relatedTarget as Node | null
    if (related && (e.currentTarget as HTMLElement).contains(related)) return
    setIsDragOver(false)
  }
  const handleDrop = async (e: ReactDragEvent<HTMLDivElement>): Promise<void> => {
    e.preventDefault()
    e.stopPropagation()
    setIsDragOver(false)

    const files = e.dataTransfer?.files
    if (!files || files.length === 0) return

    for (let i = 0; i < files.length; i++) {
      const file = files[i]
      const filePath = (file as any).path as string | undefined
      if (!filePath) continue  // 浏览器模式没有 path，跳过（P3 阶段桌面优先）
      const type = inferSourceType(filePath)
      const params: AddSourceParams = {
        title: fileNameFromPath(filePath),
        type,
        filePath
      }
      await addOptimistic(params)
    }
  }

  const dropProps = {
    onDragOver: handleDragOver,
    onDragLeave: handleDragLeave,
    onDrop: handleDrop
  }

  return (
    <div className="relative h-full" {...dropProps}>
      {/* 拖拽 overlay —— dragenter 时蓝色覆盖,克制不喧宾夺主 */}
      {isDragOver && (
        <div className="absolute inset-0 z-10 pointer-events-none flex items-center justify-center bg-brand-500/10 dark:bg-brand-400/10 border-2 border-dashed border-brand-400 dark:border-brand-500 rounded-lg m-2">
          <div className="bg-surface-0 dark:bg-surface-50 px-5 py-3 rounded-lg shadow-md flex items-center gap-2.5 text-sm text-brand-700 dark:text-brand-300">
            <Plus size={16} className="opacity-80" />
            {t('shell.workspace.sourceLibrary.dropOverlay')}
          </div>
        </div>
      )}

      {/* 内容区 */}
      {!loaded ? (
        <div className="h-full flex items-center justify-center text-[12px] text-surface-400">
          {t('shell.workspace.sourceLibrary.loading')}
        </div>
      ) : sources.length === 0 ? (
        <EmptyState t={t} />
      ) : (
        <div className="h-full overflow-y-auto px-5 py-5">
          <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
            <h2 className="min-w-0 text-[13px] font-medium text-surface-600">
              {t('shell.workspace.sourceLibrary.count', { count: sources.length })}
            </h2>
            <button
              type="button"
              onClick={refresh}
              className="text-[11px] text-surface-400 hover:text-brand-500 transition-colors"
              title={t('shell.workspace.sourceLibrary.refresh')}
            >
              {t('shell.workspace.sourceLibrary.refresh')}
            </button>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {sources.map(source => (
              <SourceCard key={source.id} source={source} t={t} />
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

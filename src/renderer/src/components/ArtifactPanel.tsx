import { useState, useRef, useEffect } from 'react'
import { X, Eye, Code2, Loader2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useArtifactStore, Artifact } from '../stores/artifactStore'
import { HtmlPreview } from './artifacts/HtmlPreview'
import { CodePreview } from './artifacts/CodePreview'
import { stripDcSuffix } from '../utils/format'
import { Markdown } from './shared/Markdown'

type ViewMode = 'preview' | 'code'

function ArtifactContent({ artifact, viewMode, streaming }: { artifact: Artifact | { type: string; title: string; content: string; language?: string }; viewMode: ViewMode; streaming?: boolean }) {
  const { t } = useTranslation()
  const codeRef = useRef<HTMLPreElement>(null)

  // 代码模式：自动滚到底部
  useEffect(() => {
    if (viewMode === 'code' && codeRef.current) {
      codeRef.current.scrollTop = codeRef.current.scrollHeight
    }
  }, [artifact.content, viewMode])

  // 代码视图：显示原始源码
  if (viewMode === 'code') {
    return (
      <pre
        ref={codeRef}
        className="flex-1 overflow-auto p-4 text-sw-sm font-mono text-surface-700 bg-surface-50 whitespace-pre-wrap break-all leading-relaxed"
      >
        {artifact.content}
        {streaming && <span className="inline-block w-1.5 h-4 bg-brand-500 animate-pulse ml-0.5 align-text-bottom" />}
      </pre>
    )
  }

  // 预览视图
  switch (artifact.type) {
    case 'html':
    case 'svg':
      return <HtmlPreview content={artifact.content} streaming={streaming} />
    case 'code':
      return <CodePreview content={artifact.content} language={(artifact as Artifact).language} title={artifact.title} />
    case 'markdown':
      return (
        <div className="flex-1 overflow-auto p-4 prose-light">
          <Markdown content={artifact.content} />
        </div>
      )
    default:
      return <div className="p-4 text-surface-400 text-sw-base">{t('artifacts.shell.unsupportedTypeGeneric')}</div>
  }
}

export function ArtifactPanel() {
  const { t } = useTranslation()
  const { artifacts, activeId, closePanel, setActive, streamingArtifact } = useArtifactStore()
  const [viewMode, setViewMode] = useState<ViewMode>('preview')

  const active = artifacts.find(a => a.id === activeId) || artifacts[artifacts.length - 1]
  const isStreaming = !!streamingArtifact
  // 流式生成中显示 streamingArtifact，否则显示已完成的 active
  const displayArtifact = streamingArtifact || active

  if (!displayArtifact) return null

  const displayTitle = stripDcSuffix(displayArtifact.title) || t('artifacts.shell.generating')
  const displayType = displayArtifact.type || 'html'

  return (
    <div className="flex flex-col h-full border-l border-surface-100 bg-surface-0 dark:bg-surface-50">
      {/* 标题栏：Preview/Code toggle + tabs + close */}
      <div className="flex items-center gap-1.5 px-3 py-2 border-b border-surface-100 bg-surface-50 shrink-0">
        {/* Preview/Code 切换 */}
        <div className="flex bg-surface-100 rounded p-0.5 mr-2 shrink-0">
          <button
            onClick={() => setViewMode('preview')}
            className={`p-1 rounded transition-colors ${
              viewMode === 'preview'
                ? 'bg-surface-0 dark:bg-surface-50 text-brand-600 dark:text-brand-400 shadow-sm'
                : 'text-surface-400 hover:text-surface-600'
            }`}
            title={t('artifacts.shell.actions.preview')}
          >
            <Eye className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={() => setViewMode('code')}
            className={`p-1 rounded transition-colors ${
              viewMode === 'code'
                ? 'bg-surface-0 dark:bg-surface-50 text-brand-600 dark:text-brand-400 shadow-sm'
                : 'text-surface-400 hover:text-surface-600'
            }`}
            title={t('artifacts.shell.actions.source')}
          >
            <Code2 className="w-3.5 h-3.5" />
          </button>
        </div>

        {/* 流式状态标签 */}
        {isStreaming && (
          <div className="flex items-center gap-1 text-sw-xs text-brand-600 dark:text-brand-400 bg-brand-50 dark:bg-brand-900/30 px-2 py-0.5 rounded shrink-0">
            <Loader2 className="w-3 h-3 animate-spin" />
            {t('artifacts.shell.generating')}
          </div>
        )}

        {/* 标题 / Tab 栏 */}
        <div className="flex items-center gap-1 flex-1 overflow-x-auto min-w-0">
          {isStreaming ? (
            <span className="text-sw-sm text-surface-600 font-medium truncate">
              {displayTitle} · {displayType.toUpperCase()}
            </span>
          ) : (
            artifacts.map(a => {
              const tabTitle = stripDcSuffix(a.title)
              return (
                <button
                  key={a.id}
                  onClick={() => setActive(a.id)}
                  className={`text-sw-sm px-2 py-1 rounded shrink-0 transition-colors ${
                    a.id === active?.id
                      ? 'bg-brand-50 dark:bg-brand-900/30 text-brand-700 dark:text-brand-300 font-medium'
                      : 'text-surface-400 hover:text-surface-600 hover:bg-surface-100'
                  }`}
                >
                  {tabTitle.length > 16 ? tabTitle.substring(0, 16) + '…' : tabTitle}
                </button>
              )
            })
          )}
        </div>

        <button
          onClick={closePanel}
          title={t('common.actions.close')}
          className="text-surface-400 hover:text-surface-600 p-1 rounded hover:bg-surface-100 transition-colors shrink-0"
        >
          <X className="w-3.5 h-3.5" />
        </button>
      </div>

      {/* 内容区 */}
      <div className="flex-1 overflow-hidden">
        <ArtifactContent artifact={displayArtifact as any} viewMode={viewMode} streaming={isStreaming} />
      </div>
    </div>
  )
}

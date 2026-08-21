import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  ChevronDown, FileText, FileSpreadsheet, Presentation,
  File, FolderOpen, ExternalLink, Eye
} from 'lucide-react'
import { Markdown } from '../shared/Markdown'
import { ChatMessage } from '../../types'
import { CopyButton } from './shared/CopyButton'
import { PasteButton } from './shared/PasteButton'
import { fmtSize } from '../../utils/format'
import { openInWorkspace } from '../../utils/openInWorkspace'

const FILE_TYPES: Record<string, { icon: typeof FileText; color: string; label: string }> = {
  docx: { icon: FileText, color: 'text-blue-600 dark:text-blue-400', label: 'Word' },
  doc:  { icon: FileText, color: 'text-blue-600 dark:text-blue-400', label: 'Word' },
  xlsx: { icon: FileSpreadsheet, color: 'text-green-600 dark:text-green-400', label: 'Excel' },
  xls:  { icon: FileSpreadsheet, color: 'text-green-600 dark:text-green-400', label: 'Excel' },
  pptx: { icon: Presentation, color: 'text-orange-600 dark:text-orange-400', label: 'PowerPoint' },
  ppt:  { icon: Presentation, color: 'text-orange-600 dark:text-orange-400', label: 'PowerPoint' },
  pdf:  { icon: FileText, color: 'text-red-600 dark:text-red-400', label: 'PDF' },
}

function tryParseArgs(msg: ChatMessage): Record<string, any> | null {
  if (!msg.toolArgs) return null
  try { return JSON.parse(msg.toolArgs) } catch { return null }
}

function FileCard({ a }: { a: Record<string, any> }) {
  const { t } = useTranslation()
  const ft = a.fileType || ''
  const info = FILE_TYPES[ft] || { icon: File, color: 'text-surface-500', label: ft.toUpperCase() }
  const Icon = info.icon
  const name = a.fileName || a.filePath?.split('/').pop() || t('shell.workspace.fallback.untitledFile')

  const handlePreview = () => {
    if (a.filePath) openInWorkspace(a.filePath, { title: a.title || name })
  }

  return (
    <div className="flex justify-start mb-msg animate-fade-in">
      <div className="max-w-msg w-full pl-3 pr-2 border-l border-border">
        <button
          onClick={handlePreview}
          className="w-full flex items-center gap-3 py-2 text-left rounded hover:bg-surface-50 dark:hover:bg-surface-50/50 transition-colors"
          title={t('chat.document.previewFileTitle')}
        >
          <Icon className={`w-8 h-8 shrink-0 ${info.color}`} strokeWidth={1.75} />
          <div className="flex-1 min-w-0">
            <div className="text-chat font-medium text-surface-700 truncate">{a.title || name}</div>
            <div className="text-chat-meta text-surface-400 flex items-center gap-2 mt-0.5">
              <span>{info.label}</span>
              {a.fileSize > 0 && <><span>·</span><span>{fmtSize(a.fileSize)}</span></>}
              {a.docType && <><span>·</span><span>{a.docType}</span></>}
            </div>
          </div>
          <Eye className="w-3.5 h-3.5 shrink-0 text-surface-400" />
        </button>
        <div className="flex flex-wrap items-center gap-1 py-1.5 border-t border-border">
          <button
            onClick={handlePreview}
            className="flex items-center gap-1.5 px-3 py-1.5 text-chat-meta font-medium text-brand-600 dark:text-brand-400 hover:bg-brand-50 dark:hover:bg-brand-900/30 rounded-md transition-colors"
          >
            <Eye className="w-3.5 h-3.5" />{t('chat.document.previewInWorkspace')}
          </button>
          <button
            onClick={() => a.filePath && (window.api as any)?.openFile?.(a.filePath)}
            className="flex items-center gap-1.5 px-3 py-1.5 text-chat-meta font-medium text-surface-500 hover:bg-surface-100 rounded-md transition-colors"
          >
            <ExternalLink className="w-3.5 h-3.5" />{t('chat.document.openExternal')}
          </button>
          <button
            onClick={() => a.filePath && (window.api as any)?.revealFile?.(a.filePath)}
            className="flex items-center gap-1.5 px-3 py-1.5 text-chat-meta font-medium text-surface-500 hover:bg-surface-100 rounded-md transition-colors"
          >
            <FolderOpen className="w-3.5 h-3.5" />{t('shell.workspace.filePreview.finder')}
          </button>
        </div>
      </div>
    </div>
  )
}

function MarkdownDocCard({ message, appName }: { message: ChatMessage; appName?: string }) {
  const { t } = useTranslation()
  const [expanded, setExpanded] = useState(true)
  const lines = message.content.split('\n')
  const separatorIdx = lines.indexOf('---')
  const docContent = separatorIdx >= 0 ? lines.slice(separatorIdx + 1).join('\n').trim() : message.content
  const titleLine = lines[0] || ''
  const args = tryParseArgs(message)
  const filePath = args?.filePath as string | undefined

  return (
    <div className="flex justify-start mb-msg animate-fade-in">
      <div className="group/doc max-w-msg w-full">
        <div className="flex items-center gap-1">
          <button
            onClick={() => setExpanded(!expanded)}
            className="flex-1 min-w-0 flex items-center gap-2 rounded-lg px-3 py-2 bg-brand-50/50 dark:bg-brand-900/30 border border-brand-200/60 dark:border-brand-700 hover:bg-brand-50 dark:hover:bg-brand-900/40 transition-colors text-left"
          >
            <span className="text-sm shrink-0">📄</span>
            <span className="text-chat-label font-medium text-brand-700 dark:text-brand-300 truncate flex-1">{titleLine}</span>
            <ChevronDown
              className={`w-3.5 h-3.5 text-brand-400 shrink-0 transition duration-200 ${expanded ? 'rotate-180' : ''} opacity-0 group-hover/doc:opacity-100 group-has-[:focus-visible]/doc:opacity-100`}
            />
          </button>
          {filePath && (
            <button
              onClick={() => openInWorkspace(filePath, { title: titleLine })}
              className="shrink-0 h-[28px] px-2 rounded-lg bg-brand-50/50 dark:bg-brand-900/30 border border-brand-200/60 dark:border-brand-700 hover:bg-brand-50 dark:hover:bg-brand-900/40 transition-all text-brand-700 dark:text-brand-300 text-chat-meta flex items-center gap-1 opacity-0 group-hover/doc:opacity-100 group-has-[:focus-visible]/doc:opacity-100"
              title={t('chat.document.previewDocumentTitle')}
            >
              <Eye className="w-3 h-3" />{t('chat.fileResult.actions.preview')}
            </button>
          )}
        </div>

        {expanded && (
          <div className="mt-1 pl-3 py-1 border-l border-border animate-fade-in">
            <div className="prose-light text-chat-label max-h-[32rem] overflow-y-auto">
              <Markdown content={docContent} />
            </div>
            <div className="flex items-center gap-1 mt-2 pt-2 border-t border-surface-100">
              <CopyButton text={docContent} />
              {appName && <PasteButton text={docContent} appName={appName} />}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

export function DocumentCard({ message, appName }: { message: ChatMessage; appName?: string }) {
  const args = tryParseArgs(message)
  const ft = args?.fileType
  if (ft && ft !== 'md' && ft !== 'txt' && ft in FILE_TYPES) return <FileCard a={args!} />
  return <MarkdownDocCard message={message} appName={appName} />
}

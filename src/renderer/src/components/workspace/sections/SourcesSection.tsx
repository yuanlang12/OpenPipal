import { FileImage, Link, Paperclip } from 'lucide-react'
import { useChatStore } from '../../../stores/chatStore'
import { useWorkspaceStore } from '../../../stores/workspaceStore'
import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { collectConversationSources, resolveWorkspaceEntryLabel, type ConversationSourceEntry } from '../workspaceEntries'

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char] || char))
}

function imagePreviewDocument(name: string, base64: string, mime = 'image/png'): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(name)}</title><style>html,body{margin:0;min-height:100%;background:#f8fafc}body{display:grid;place-items:center;padding:24px;box-sizing:border-box}img{max-width:100%;max-height:calc(100vh - 48px);object-fit:contain;box-shadow:0 1px 3px #0002}</style></head><body><img alt="${escapeHtml(name)}" src="data:${mime};base64,${base64}"></body></html>`
}

/**
 * 当前对话的输入来源：只展示用户明确上传、拖放或粘贴的材料。
 * 过程截图、工具轨迹和历史产物不属于来源，避免把 Agent 工作痕迹误当用户输入。
 */
export function SourcesSection() {
  const { t } = useTranslation()
  const messages = useChatStore(s => s.messages)
  const conversationId = useChatStore(s => s.activeConversationId)

  const sources = useMemo(() => collectConversationSources(messages), [messages])

  const openSource = async (source: ConversationSourceEntry): Promise<void> => {
    const workspace = useWorkspaceStore.getState()
    if (source.path) {
      workspace.openTab({ kind: 'file', title: source.name, titleKey: source.labelKey, titleParams: source.labelParams, filePath: source.path })
      return
    }
    if (source.url) {
      workspace.openTab({ kind: 'preview', title: source.name, titleKey: source.labelKey, titleParams: source.labelParams, url: source.url })
      return
    }
    if (source.kind !== 'image') return

    let base64 = source.imageData
    let mime = 'image/png'
    if (!base64 && conversationId && source.imagePath) {
      const filename = source.imagePath.split('/').pop()
      if (filename) {
        const uploaded = await window.api.readUploadAsset?.(conversationId, filename)
        base64 = uploaded?.base64
        mime = uploaded?.mime || mime
      }
    }
    if (!base64) return
    const previewName = source.imagePath?.split('/').pop() || resolveWorkspaceEntryLabel(source, t)
    workspace.openTab({
      kind: 'preview',
      title: source.name,
      titleKey: source.labelKey,
      titleParams: source.labelParams,
      srcdoc: imagePreviewDocument(previewName, base64, mime)
    })
  }

  if (sources.length === 0) {
    return <div className="text-sw-sm text-surface-400 px-3 py-2 leading-relaxed">{t('shell.workspace.sectionEmpty.sources')}<br /><span className="opacity-70">{t('shell.workspace.sectionEmpty.sourcesHint')}</span></div>
  }

  return (
    <div className="py-0.5">
      {sources.map((s) => {
        const Icon = s.kind === 'image' ? FileImage : s.kind === 'url' ? Link : Paperclip
        const title = resolveWorkspaceEntryLabel(s, t)
        return (
          <button
            key={s.id}
            onClick={() => { void openSource(s) }}
            className="w-full flex items-center gap-2 px-3 py-1.5 text-left text-sw-base text-surface-700 hover:bg-surface-100 dark:hover:bg-surface-100/50 transition-colors group"
            title={s.path || s.url || s.imagePath || title}
          >
            <Icon size={13} className="shrink-0 text-surface-400 group-hover:text-brand-500 transition-colors" />
            <span className="truncate flex-1">{title}</span>
          </button>
        )
      })}
    </div>
  )
}

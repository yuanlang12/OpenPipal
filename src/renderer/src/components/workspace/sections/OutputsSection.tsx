import { FileText, Palette } from 'lucide-react'
import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { useArtifactStore } from '../../../stores/artifactStore'
import { useChatStore } from '../../../stores/chatStore'
import { useWorkspaceStore } from '../../../stores/workspaceStore'
import { collectConversationOutputs, resolveWorkspaceEntryLabel } from '../workspaceEntries'
import { workspaceOutputTypeLabel } from '../workspaceLabels'

/** 当前会话唯一的交付入口：可回看的 artifact 与明确导出的文件合并展示。 */
export function OutputsSection() {
  const { t } = useTranslation()
  const artifacts = useArtifactStore(s => s.artifacts)
  const messages = useChatStore(s => s.messages)
  const outputs = useMemo(() => collectConversationOutputs(artifacts, messages), [artifacts, messages])

  if (outputs.length === 0) {
    return <div className="text-sw-sm text-surface-400 px-3 py-2 leading-relaxed">{t('shell.workspace.sectionEmpty.outputs')}<br /><span className="opacity-70">{t('shell.workspace.sectionEmpty.outputsHint')}</span></div>
  }

  return (
    <div className="py-0.5">
      {outputs.map(output => {
        const Icon = output.kind === 'artifact' ? Palette : FileText
        const title = resolveWorkspaceEntryLabel(output, t)
        return (
          <button
            key={output.id}
            onClick={() => useWorkspaceStore.getState().openTab(
              output.kind === 'artifact'
                ? { kind: 'artifact', title: output.title, titleKey: output.labelKey, titleParams: output.labelParams, artifactId: output.artifactId }
                : { kind: 'file', title: output.title, titleKey: output.labelKey, titleParams: output.labelParams, filePath: output.filePath }
            )}
            className="w-full flex items-center gap-2 px-3 py-1.5 text-left text-sw-base text-surface-700 hover:bg-surface-100 dark:hover:bg-surface-100/50 transition-colors group"
            title={title}
          >
            <Icon size={13} className="shrink-0 text-surface-400 group-hover:text-brand-500 transition-colors" />
            <span className="truncate flex-1">{title}</span>
            <span className="shrink-0 text-sw-xs text-surface-400 uppercase opacity-70">{workspaceOutputTypeLabel(output.type, t)}</span>
          </button>
        )
      })}
    </div>
  )
}

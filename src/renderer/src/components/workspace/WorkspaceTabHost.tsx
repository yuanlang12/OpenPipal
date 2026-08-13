import { useWorkspaceStore, SUMMARY_TAB_ID, SOURCES_TAB_ID } from '../../stores/workspaceStore'
import { WorkspaceSidebar } from './WorkspaceSidebar'
import { ArtifactTab } from './tabs/ArtifactTab'
import { FileTab } from './tabs/FileTab'
import { PreviewTab } from './tabs/PreviewTab'
import { SourcesPanel } from './SourcesPanel'
import { useTranslation } from 'react-i18next'
import { workspaceRendererName, workspaceTabTitle } from './workspaceLabels'

/**
 * Tab 内容宿主 —— 按 tab.kind 分发到对应渲染器。
 * 所有 tab 同时挂载（visibility 隐藏非激活的），保留 iframe/滚动/状态，切 tab 不丢。
 * 两个虚拟 pinned tab：
 *   - SUMMARY_TAB_ID：摘要（WorkspaceSidebar）
 *   - SOURCES_TAB_ID：Cave 模式资料区（SourcesPanel）—— 只在 learner+study 下从 header 入口
 */
export function WorkspaceTabHost() {
  const { t } = useTranslation()
  const tabs = useWorkspaceStore(s => s.tabs)
  const activeTabId = useWorkspaceStore(s => s.activeTabId)

  return (
    <div className="flex-1 min-h-0 relative flex flex-col">
      {/* 摘要 pinned tab —— 常驻挂载 */}
      <div
        className={[
          'absolute inset-0 flex flex-col',
          activeTabId === SUMMARY_TAB_ID ? '' : 'invisible pointer-events-none'
        ].join(' ')}
        aria-hidden={activeTabId !== SUMMARY_TAB_ID}
      >
        <WorkspaceSidebar />
      </div>

      {/* Sources pinned tab —— Cave 模式专属,常驻挂载（即使 header 不显示入口） */}
      <div
        className={[
          'absolute inset-0 flex flex-col',
          activeTabId === SOURCES_TAB_ID ? '' : 'invisible pointer-events-none'
        ].join(' ')}
        aria-hidden={activeTabId !== SOURCES_TAB_ID}
      >
        <SourcesPanel />
      </div>

      {tabs.map(tab => {
        const visible = tab.id === activeTabId
        return (
          <div
            key={tab.id}
            className={[
              'absolute inset-0 flex flex-col',
              visible ? '' : 'invisible pointer-events-none'
            ].join(' ')}
            aria-hidden={!visible}
          >
            {tab.kind === 'artifact' && tab.artifactId && (
              <ArtifactTab artifactId={tab.artifactId} />
            )}
            {tab.kind === 'file' && tab.filePath && (
              <FileTab filePath={tab.filePath} />
            )}
            {tab.kind === 'preview' && (
              <PreviewTab
                url={tab.url}
                srcdoc={tab.srcdoc}
                title={workspaceTabTitle(tab, t)}
              />
            )}
            {!['artifact', 'file', 'preview'].includes(tab.kind) && (
              <div className="flex-1 flex items-center justify-center text-surface-400 text-xs">
                {t('shell.workspace.rendererComingSoon', { name: workspaceRendererName(tab.kind, t) })}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

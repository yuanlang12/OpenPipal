import { X, Plus, ListTree, FileText, Palette, Globe, BarChart3, ListChecks, BookOpen } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useWorkspaceStore, SUMMARY_TAB_ID, SOURCES_TAB_ID, WorkspaceTab, WorkspaceTabKind } from '../../stores/workspaceStore'
import { useSourcesStore } from '../../stores/sourcesStore'
import { WorkspaceTabHost } from './WorkspaceTabHost'
import { ResizeHandle } from './ResizeHandle'
import { workspaceTabTitle } from './workspaceLabels'

function iconFor(kind: WorkspaceTabKind) {
  switch (kind) {
    case 'file': return FileText
    case 'artifact': return Palette
    case 'preview': return Globe
    case 'visualizer': return BarChart3
    case 'task': return ListChecks
    default: return FileText
  }
}

function TabPill({
  active,
  Icon,
  title,
  closeLabel,
  onClick,
  onClose
}: {
  active: boolean
  Icon: React.ComponentType<any>
  title: string
  closeLabel: string
  onClick: () => void
  onClose?: (e: React.MouseEvent) => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={[
        'group relative flex items-center gap-1.5 px-2 h-6 rounded cursor-pointer select-none',
        'text-[11px] border transition-colors max-w-[160px] shrink-0',
        active
          ? 'bg-surface-0 dark:bg-surface-50 border-surface-200 text-surface-800'
          : 'bg-transparent border-transparent text-surface-500 hover:bg-surface-50 dark:hover:bg-surface-50/50 hover:text-surface-700'
      ].join(' ')}
      title={title}
    >
      <Icon size={11} className="shrink-0 opacity-70" />
      <span className="truncate">{title}</span>
      {onClose && (
        <span
          role="button"
          aria-label={closeLabel}
          onClick={onClose}
          className="ml-0.5 shrink-0 opacity-0 group-hover:opacity-100 hover:bg-surface-200 rounded p-0.5 transition-opacity flex items-center"
        >
          <X size={10} />
        </span>
      )}
    </button>
  )
}

/**
 * Workspace 面板 —— 摘要（常驻）+ 浏览器预览 tabs。
 *
 * 两种 layoutMode：
 *   - 'sidebar'（默认）：右侧固定宽度栏，左边缘 ResizeHandle 拖宽，header 右侧有关闭按钮
 *   - 'study'（Cave 模式 / 沉浸式学习）：升主舞台，flex-1 占主区，无 resize、无关闭按钮，
 *     视觉走更宽更克制的阅读体感（参考 NotebookLM / Reader View）
 *
 * Header 状态：
 *   - 无浏览器 tab：[ListTree] 摘要
 *   - 有浏览器 tab：[摘要 pinned][browser tabs...][+]
 */
interface Props {
  layoutMode?: 'sidebar' | 'study'
}

export function WorkspacePanel({ layoutMode = 'sidebar' }: Props) {
  const { t } = useTranslation()
  const width = useWorkspaceStore(s => s.width)
  const setWidth = useWorkspaceStore(s => s.setWidth)
  const setOpen = useWorkspaceStore(s => s.setOpen)
  const tabs = useWorkspaceStore(s => s.tabs)
  const activeTabId = useWorkspaceStore(s => s.activeTabId)
  const focusTab = useWorkspaceStore(s => s.focusTab)
  const focusSummary = useWorkspaceStore(s => s.focusSummary)
  const closeTab = useWorkspaceStore(s => s.closeTab)
  const sourcesCount = useSourcesStore(s => s.sources.length)

  const hasBrowserTabs = tabs.length > 0
  const isStudy = layoutMode === 'study'
  // study 模式下展示 Sources pinned tab 入口（其他模式即使有 sources 也不在 header 露出）
  const showSourcesPin = isStudy

  return (
    <div
      className={[
        'relative flex flex-col bg-surface-0 dark:bg-surface-50',
        isStudy
          ? 'flex-1 min-w-0 border-r border-surface-100'
          : 'shrink-0 border-l border-surface-100'
      ].join(' ')}
      style={isStudy ? undefined : { width }}
    >
      {/* Resize handle 仅 sidebar 模式有 —— study 模式由 chat 侧栏决定宽度 */}
      {!isStudy && (
        <ResizeHandle side="left" getWidth={() => useWorkspaceStore.getState().width} setWidth={setWidth} />
      )}

      {/* 单行 header
          - Study 模式：[Sources][摘要][browser tabs...]，Sources 默认 pinned
          - Sidebar 模式：[ListTree] 摘要 + ×  或  [摘要 pinned][browser tabs...] + ×  */}
      <div className={[
        'shrink-0 flex items-center gap-1.5 border-b border-surface-100 overflow-x-auto scrollbar-thin',
        isStudy ? 'h-12 px-5' : 'h-10 px-3'
      ].join(' ')}>
        {showSourcesPin && (
          <TabPill
            active={activeTabId === SOURCES_TAB_ID}
            Icon={BookOpen}
            title={sourcesCount > 0 ? t('shell.workspace.sourcesWithCount', { count: sourcesCount }) : t('shell.workspace.sources')}
            closeLabel={t('shell.workspace.closeTab')}
            onClick={() => focusTab(SOURCES_TAB_ID)}
          />
        )}

        <TabPill
          active={activeTabId === SUMMARY_TAB_ID}
          Icon={ListTree}
          title={t('shell.workspace.summary')}
          closeLabel={t('shell.workspace.closeTab')}
          onClick={focusSummary}
        />
        {tabs.map((tab: WorkspaceTab) => (
          <TabPill
            key={tab.id}
            active={tab.id === activeTabId}
            Icon={iconFor(tab.kind)}
            title={workspaceTabTitle(tab, t)}
            closeLabel={t('shell.workspace.closeTab')}
            onClick={() => focusTab(tab.id)}
            onClose={(e) => { e.stopPropagation(); closeTab(tab.id) }}
          />
        ))}
        {hasBrowserTabs && (
          <button
            className="shrink-0 h-6 w-6 flex items-center justify-center rounded text-surface-400 hover:bg-surface-100 dark:hover:bg-surface-100/60 hover:text-surface-700 transition-colors"
            title={t('shell.workspace.newTabUnavailable')}
            disabled
            aria-disabled
          >
            <Plus size={11} />
          </button>
        )}

        {/* 关闭按钮仅 sidebar 模式 —— study 模式不允许关闭主舞台 */}
        {!isStudy && (
          <button
            onClick={() => setOpen(false)}
            className="ml-auto shrink-0 p-1 rounded-md text-surface-400 hover:text-surface-700 hover:bg-surface-100 dark:hover:bg-surface-100/60 transition-colors"
            title={t('shell.workspace.collapsePanel')}
          >
            <X size={13} />
          </button>
        )}
      </div>

      <WorkspaceTabHost />
    </div>
  )
}

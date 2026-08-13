import { ChevronRight, ChevronDown, FolderOutput, ListChecks, Paperclip } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useWorkspaceStore, SidebarSectionId } from '../../stores/workspaceStore'
import { TasksSection } from './sections/TasksSection'
import { OutputsSection } from './sections/OutputsSection'
import { SourcesSection } from './sections/SourcesSection'

interface SectionConfig {
  id: SidebarSectionId
  titleKey: string
  icon: React.ComponentType<any>
  Body: React.ComponentType
}

const SECTIONS: SectionConfig[] = [
  { id: 'outputs', titleKey: 'shell.workspace.sections.outputs', icon: FolderOutput, Body: OutputsSection },
  { id: 'tasks', titleKey: 'shell.workspace.sections.tasks', icon: ListChecks, Body: TasksSection },
  { id: 'sources', titleKey: 'shell.workspace.sections.sources', icon: Paperclip, Body: SourcesSection }
]

function SectionHeader({ cfg, title, collapsed }: { cfg: SectionConfig; title: string; collapsed: boolean }) {
  const toggleSection = useWorkspaceStore(s => s.toggleSection)
  const Chevron = collapsed ? ChevronRight : ChevronDown
  const { icon: Icon, id } = cfg
  return (
    <button
      onClick={() => toggleSection(id)}
      className="w-full flex items-center gap-1.5 px-2 py-1.5 text-sw-sm font-medium text-surface-500 hover:text-surface-800 transition-colors uppercase tracking-wider"
    >
      <Chevron size={11} className="shrink-0 opacity-70" />
      <Icon size={12} className="shrink-0" />
      <span className="truncate">{title}</span>
    </button>
  )
}

/**
 * 摘要视图 —— 作为 Preview Panel 的 pinned tab 内容。
 * 展示当前会话的输出、任务、来源；点击项目会在同面板打开对应预览 tab。
 * 跨会话历史属于全局“作品”，不在这里混入当前任务。
 */
export function WorkspaceSidebar() {
  const { t } = useTranslation()
  const collapsedMap = useWorkspaceStore(s => s.sectionCollapsed)

  return (
    <div className="w-full h-full flex flex-col bg-surface-50/50 dark:bg-surface-50/30 overflow-y-auto scrollbar-thin">
      {SECTIONS.map(cfg => {
        const collapsed = !!collapsedMap[cfg.id]
        const { Body } = cfg
        return (
          <div key={cfg.id} className="shrink-0">
            <SectionHeader cfg={cfg} title={t(cfg.titleKey)} collapsed={collapsed} />
            {!collapsed && <Body />}
          </div>
        )
      })}
    </div>
  )
}

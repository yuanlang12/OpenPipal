import { useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { Plus, Settings } from 'lucide-react'
import { useChatStore } from '../stores/chatStore'
import { useAppStore } from '../stores/appStore'
import { AgentSwitcher } from './AgentSwitcher'
import { HistoryPopover } from './HistoryPopover'

/**
 * 浏览器模式顶栏（精简布局）—— 取代桌面的左侧 Sidebar。
 * 左：统一智能体选择器（全局角色 + 我的 Agents）；右：历史浮层 + 新建 + 设置。
 * 桌面端不渲染本组件（App.tsx 按 isBrowser 分支）。
 */
export function BrowserTopBar() {
  const { t } = useTranslation()
  const currentRole = useAppStore(s => s.currentRole)
  const setActiveView = useAppStore(s => s.setActiveView)
  const newConversation = useChatStore(s => s.newConversation)

  const handleNew = useCallback(async () => {
    await newConversation(currentRole?.name || 'learner')
    setActiveView('chat')
  }, [newConversation, currentRole?.name, setActiveView])

  return (
    <div className="flex items-center w-full h-full px-2 gap-1">
      <AgentSwitcher />
      <div className="flex-1" />
      <HistoryPopover />
      <button
        onClick={handleNew}
        title={t('shell.navigation.newConversation')}
        className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-[13px] font-medium bg-brand-500 text-ink-on-accent hover:bg-brand-600 transition-colors active:scale-[0.98]"
      >
        <Plus className="w-4 h-4" />
        <span className="hidden sm:inline">{t('shell.navigation.newShort')}</span>
      </button>
      <button
        onClick={() => setActiveView('settings')}
        title={t('shell.navigation.settings')}
        className="p-1.5 rounded-md text-surface-400 hover:text-surface-600 hover:bg-sidebar-hover dark:hover:bg-surface-50 transition-colors"
      >
        <Settings className="w-4 h-4" />
      </button>
    </div>
  )
}

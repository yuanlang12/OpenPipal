import { Bot, PanelLeft, PanelRight, FolderOpen } from 'lucide-react'
import { TargetAppStatus } from '../types'
import { useChatStore } from '../stores/chatStore'
import { useAgentStore } from '../stores/agentStore'
import { useAppStore } from '../stores/appStore'
import { useWorkspaceStore } from '../stores/workspaceStore'
import { useCallback, useState } from 'react'
import { useTranslation } from 'react-i18next'

interface StatusBarProps {
  status: TargetAppStatus
  onClear: () => void
  onSwitchRole: (roleName: string) => void
}

export function StatusBar({ status }: StatusBarProps) {
  const { t } = useTranslation()
  const isStreaming = useChatStore(s => s.isStreaming)
  const messageCount = useChatStore(s => s.messages.length)
  const activeConversationId = useChatStore(s => s.activeConversationId)
  const activeWorkspaceId = useChatStore(s => s.activeWorkspaceId)
  const { createFromConversation, creating: creatingAgent } = useAgentStore()
  const activeView = useAppStore(s => s.activeView)
  const workspacePanelOpen = useAppStore(s => s.workspacePanelOpen)
  const previewOpen = useWorkspaceStore(s => s.open)
  const previewTabsCount = useWorkspaceStore(s => s.tabs.length)
  const filesPanelOpen = useWorkspaceStore(s => s.filesPanelOpen)
  const isBrowser = (window as any).__OPENPIPAL_ENV__ === 'browser'
  const [saved, setSaved] = useState(false)

  const handleSave = useCallback(async () => {
    if (!activeConversationId || creatingAgent) return
    try {
      await createFromConversation(activeConversationId)
      setSaved(true)
      setTimeout(() => setSaved(false), 3000)
    } catch (err) {
      console.error('[StatusBar] Failed to save Agent:', err)
    }
  }, [activeConversationId, creatingAgent, createFromConversation])

  const showSaveButton = activeView === 'chat' && !isStreaming && messageCount >= 4 && activeConversationId

  return (
    <div className="flex items-center flex-1 px-3">
      <div className="flex-1 flex items-center justify-center gap-3">
        {!isBrowser && status.connected && status.appName && (
          <div className="flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-brand-50 dark:bg-brand-900/30 border border-brand-100 dark:border-brand-800">
            <div className="w-1.5 h-1.5 rounded-full bg-brand-500" />
            <span className="text-[11px] font-medium text-brand-700 dark:text-brand-300">{status.appName}</span>
          </div>
        )}
      </div>

      {/* 右侧：保存为 Agent + 3 个独立开关 */}
      {showSaveButton && (
        <button
          onClick={handleSave}
          disabled={creatingAgent}
          title={t('shell.statusBar.saveAsAgent')}
          className="shrink-0 flex items-center gap-1 px-2 py-1 rounded-md text-[11px] text-surface-400 hover:text-brand-600 dark:hover:text-brand-400 hover:bg-brand-50 dark:hover:bg-brand-900/20 transition-colors disabled:opacity-50"
          style={{ WebkitAppRegion: 'no-drag' } as any}
        >
          {saved ? (
            <span className="text-emerald-500">{t('shell.statusBar.saved')}</span>
          ) : creatingAgent ? (
            <div
              className="w-3 h-3 border-2 border-brand-300 border-t-brand-600 rounded-full animate-spin"
              role="status"
              aria-label={t('shell.statusBar.savingAgent')}
            />
          ) : (
            <>
              <Bot className="w-3 h-3" />
              <span>{t('shell.statusBar.saveAsAgent')}</span>
            </>
          )}
        </button>
      )}

      {/* Agent Inspector 开关 — 仅 chat view + 是 Agent 会话时显示 */}
      {activeView === 'chat' && activeWorkspaceId && (
        <button
          onClick={() => useAppStore.getState().setWorkspacePanelOpen(!workspacePanelOpen)}
          className={[
            'shrink-0 ml-1 p-1.5 rounded-md transition-colors',
            workspacePanelOpen
              ? 'bg-brand-50 dark:bg-brand-900/30 text-brand-600 dark:text-brand-400'
              : 'text-surface-400 hover:text-brand-600 dark:hover:text-brand-400 hover:bg-brand-50 dark:hover:bg-brand-900/20'
          ].join(' ')}
          style={{ WebkitAppRegion: 'no-drag' } as any}
          title={t(workspacePanelOpen
            ? 'shell.statusBar.collapseAgentInfo'
            : 'shell.statusBar.expandAgentInfo')}
        >
          <PanelLeft className="w-3.5 h-3.5" />
        </button>
      )}

      {/* Preview 面板开关 —— 摘要 + 浏览器预览 tabs，内容入口 */}
      <button
        onClick={() => useWorkspaceStore.getState().setOpen(!previewOpen)}
        className={[
          'shrink-0 ml-1 p-1.5 rounded-md transition-colors flex items-center gap-1',
          previewOpen
            ? 'bg-brand-50 dark:bg-brand-900/30 text-brand-600 dark:text-brand-400'
            : 'text-surface-400 hover:text-brand-600 dark:hover:text-brand-400 hover:bg-brand-50 dark:hover:bg-brand-900/20'
        ].join(' ')}
        style={{ WebkitAppRegion: 'no-drag' } as any}
        title={t(previewOpen
          ? 'shell.statusBar.collapseSummary'
          : 'shell.statusBar.expandSummary')}
      >
        <PanelRight className="w-3.5 h-3.5" />
        {previewTabsCount > 0 && (
          <span className="text-[10px] leading-none font-medium">{previewTabsCount}</span>
        )}
      </button>

      {/* Files 面板开关 —— 纯 Agent 文件夹浏览器，独立开关 */}
      <button
        onClick={() => useWorkspaceStore.getState().toggleFilesPanel()}
        className={[
          'shrink-0 ml-1 p-1.5 rounded-md transition-colors',
          filesPanelOpen
            ? 'bg-brand-50 dark:bg-brand-900/30 text-brand-600 dark:text-brand-400'
            : 'text-surface-400 hover:text-brand-600 dark:hover:text-brand-400 hover:bg-brand-50 dark:hover:bg-brand-900/20'
        ].join(' ')}
        style={{ WebkitAppRegion: 'no-drag' } as any}
        title={t(filesPanelOpen
          ? 'shell.statusBar.collapseWorkspace'
          : 'shell.statusBar.expandWorkspace')}
      >
        <FolderOpen className="w-3.5 h-3.5" />
      </button>
    </div>
  )
}

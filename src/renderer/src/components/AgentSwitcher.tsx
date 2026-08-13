import { useState, useRef, useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronDown, Check } from 'lucide-react'
import { useAppStore } from '../stores/appStore'
import { useChatStore } from '../stores/chatStore'
import { useAgentStore } from '../stores/agentStore'
import { RoleAvatar } from './shared/RoleAvatar'
import { getBuiltinRoleNameKey } from '../../../shared/i18n/resources'

/**
 * 统一智能体选择器 —— 一个下拉同时切换「全局角色」和「我的 Agents（独立 workspace）」。
 * 主要用于浏览器顶栏（精简布局，无侧边栏）。直接读 store，不做 prop drilling，
 * 与 Sidebar 的切换语义保持一致：选角色→switchRole+清空；选 Agent→以该 Agent 开新会话。
 */
export function AgentSwitcher() {
  const { t } = useTranslation()
  const allRoles = useAppStore(s => s.allRoles)
  const currentRole = useAppStore(s => s.currentRole)
  const switchRole = useAppStore(s => s.switchRole)
  const setActiveView = useAppStore(s => s.setActiveView)
  const activeWorkspaceId = useChatStore(s => s.activeWorkspaceId)
  const isStreaming = useChatStore(s => s.isStreaming)
  const isThinking = useChatStore(s => s.isThinking)
  const clearMessages = useChatStore(s => s.clearMessages)
  const newConversationFromWorkspace = useChatStore(s => s.newConversationFromWorkspace)
  const workspaces = useAgentStore(s => s.workspaces)
  const loadWorkspaces = useAgentStore(s => s.loadWorkspaces)

  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)

  // 确保下拉里有数据（顶栏可能在 AgentsPanel 打开前就用到）
  useEffect(() => { loadWorkspaces() }, [])

  // 点击外部关闭
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false)
    }
    window.addEventListener('mousedown', onDown)
    return () => window.removeEventListener('mousedown', onDown)
  }, [open])

  const roleName = currentRole?.name || 'learner'
  const activeWorkspace = activeWorkspaceId ? workspaces.find(w => w.id === activeWorkspaceId) : undefined
  const activeRoleStatus = isThinking ? 'thinking' : isStreaming ? 'generating' : 'idle'
  const roleDisplayName = (role: { name: string; displayName?: string }): string => {
    const key = getBuiltinRoleNameKey(role.name)
    return key ? t(key) : (role.displayName || role.name)
  }

  const selectRole = useCallback(async (name: string) => {
    setOpen(false)
    if (name === currentRole?.name && !activeWorkspaceId) { setActiveView('chat'); return }
    await switchRole(name)
    clearMessages()
    setActiveView('chat')
  }, [currentRole?.name, activeWorkspaceId, switchRole, clearMessages, setActiveView])

  const selectWorkspace = useCallback(async (id: string, name: string) => {
    setOpen(false)
    if (id === activeWorkspaceId) { setActiveView('chat'); return }
    await newConversationFromWorkspace(roleName, id, name)
    setActiveView('chat')
  }, [activeWorkspaceId, newConversationFromWorkspace, roleName, setActiveView])

  const rowClass = (active: boolean) =>
    `w-full flex items-center gap-2.5 px-2.5 py-2 rounded-md text-[13px] text-left transition-colors ${
      active
        ? 'text-brand-600 dark:text-brand-400 bg-brand-50 dark:bg-brand-900/30'
        : 'text-surface-600 hover:bg-sidebar-hover dark:hover:bg-surface-50'
    }`

  return (
    <div ref={rootRef} className="relative" style={{ WebkitAppRegion: 'no-drag' } as any}>
      <button
        onClick={() => setOpen(v => !v)}
        aria-label={t('shell.agentSwitcher.menuLabel')}
        aria-expanded={open}
        className="flex items-center gap-2 px-2.5 py-1.5 rounded-md text-[13px] font-medium text-surface-700 hover:bg-sidebar-hover dark:hover:bg-surface-50 transition-colors max-w-[200px]"
      >
        {activeWorkspace
          ? <span className="text-sm leading-none shrink-0">{activeWorkspace.icon || '🤖'}</span>
          : <RoleAvatar role={{ name: roleName, avatarDataUrl: currentRole?.avatarDataUrl }} status={activeRoleStatus} animated size={20} className="shrink-0" />}
        <span className="truncate">
          {activeWorkspace
            ? activeWorkspace.name
            : currentRole
              ? roleDisplayName(currentRole)
              : t('shell.agentSwitcher.selectAgent')}
        </span>
        <ChevronDown className={`w-3.5 h-3.5 shrink-0 text-surface-400 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>

      {open && (
        <div data-testid="agent-switcher-menu" className="op-menu absolute left-0 top-full mt-1 w-64 max-h-[70vh] overflow-y-auto z-50 p-1.5">
          {/* 全局角色 */}
          <div className="px-2 pt-1 pb-1">
            <span className="text-[10px] font-semibold text-surface-300 uppercase tracking-wider">
              {t('shell.agentSwitcher.globalRoles')}
            </span>
          </div>
          {allRoles.map(r => {
            const active = !activeWorkspaceId && r.name === currentRole?.name
            return (
              <button key={r.name} onClick={() => selectRole(r.name)} className={rowClass(active)}>
                <RoleAvatar role={{ name: r.name, avatarDataUrl: r.avatarDataUrl }} size={16} className="text-surface-500 shrink-0" />
                <span className="truncate flex-1">{roleDisplayName(r)}</span>
                {active && <Check className="w-3.5 h-3.5 shrink-0" />}
              </button>
            )
          })}

          {/* 我的 Agents */}
          <div className="px-2 pt-2.5 pb-1">
            <span className="text-[10px] font-semibold text-surface-300 uppercase tracking-wider">
              {t('shell.navigation.myAgents')}
            </span>
          </div>
          {workspaces.length === 0 ? (
            <div className="px-2.5 py-2 text-[12px] text-surface-300">
              {t('shell.agentSwitcher.noIndependentAgents')}
            </div>
          ) : (
            workspaces.map(w => {
              const active = activeWorkspaceId === w.id
              return (
                <button key={w.id} onClick={() => selectWorkspace(w.id, w.name)} className={rowClass(active)}>
                  <span className="text-sm leading-none shrink-0">{w.icon || '🤖'}</span>
                  <span className="truncate flex-1">{w.name}</span>
                  {active && <Check className="w-3.5 h-3.5 shrink-0" />}
                </button>
              )
            })
          )}
        </div>
      )}
    </div>
  )
}

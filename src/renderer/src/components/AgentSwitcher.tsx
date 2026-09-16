import { useState, useRef, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronDown, Check } from 'lucide-react'
import { useAppStore } from '../stores/appStore'
import { useChatStore } from '../stores/chatStore'
import { RoleAvatar } from './shared/RoleAvatar'
import { AgentAvatar } from './shared/AgentAvatar'
import { builtinDisplayName } from '../../../shared/i18n/resources'
import { DEFAULT_AGENT_ID } from '../../../shared/agent-identity'
import { startConversationWith } from '../utils/startConversationWith'

/**
 * Agent 选择器 —— 一份列表两个分区（内置 / 我的 Pal），选任何一行都是"用它开一条对话"（统一身份第 4 段）。
 * 主要用于浏览器顶栏（精简布局，无侧边栏）。直接读 store，不做 prop drilling。
 */
export function AgentSwitcher() {
  const { t } = useTranslation()
  const currentRole = useAppStore(s => s.currentRole)
  const setActiveView = useAppStore(s => s.setActiveView)
  const activeWorkspaceId = useChatStore(s => s.activeWorkspaceId)
  const isStreaming = useChatStore(s => s.isStreaming)
  const isThinking = useChatStore(s => s.isThinking)
  const agents = useAppStore(s => s.agents)
  const loadAgents = useAppStore(s => s.loadAgents)

  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)

  // 确保下拉里有数据（顶栏可能在 AgentsPanel 打开前就用到）
  useEffect(() => { void loadAgents() }, [])

  // 点击外部关闭
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false)
    }
    window.addEventListener('mousedown', onDown)
    return () => window.removeEventListener('mousedown', onDown)
  }, [open])

  const roleName = currentRole?.name || DEFAULT_AGENT_ID
  // 触发按钮上显示当前对话属于谁：Pal 从统一列表里找，否则是当前内置角色
  const activeAgent = agents.find(a => a.kind === 'pal' && a.id === activeWorkspaceId)
  const activeRoleStatus = isThinking ? 'thinking' : isStreaming ? 'generating' : 'idle'
  const roleDisplayName = (role: { name: string; displayName?: string }): string => builtinDisplayName(t, role.name, role.displayName || role.name)

  const isActive = (agent: { id: string; kind: string }): boolean =>
    agent.kind === 'builtin' ? (!activeWorkspaceId && agent.id === currentRole?.name) : activeWorkspaceId === agent.id
  const select = async (agent: { id: string; kind: 'builtin' | 'pal'; name: string }): Promise<void> => {
    setOpen(false)
    if (isActive(agent)) { setActiveView('chat'); return }
    await startConversationWith(agent)
  }
  const builtins = agents.filter(a => a.kind === 'builtin')
  const mine = agents.filter(a => a.kind === 'pal')
  const agentDisplayName = (agent: { id: string; kind: string; name: string }): string =>
    agent.kind === 'builtin' ? builtinDisplayName(t, agent.id, agent.name) : agent.name

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
        {activeAgent
          ? <AgentAvatar agent={activeAgent} status={activeRoleStatus} animated size={20} className="text-sm leading-none shrink-0" />
          : <RoleAvatar role={{ name: roleName, avatarDataUrl: currentRole?.avatarDataUrl }} status={activeRoleStatus} animated size={20} className="shrink-0" />}
        <span className="truncate">
          {activeAgent
            ? activeAgent.name
            : currentRole
              ? roleDisplayName(currentRole)
              : t('shell.agentSwitcher.selectAgent')}
        </span>
        <ChevronDown className={`w-3.5 h-3.5 shrink-0 text-surface-400 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>

      {open && (
        <div data-testid="agent-switcher-menu" className="op-menu absolute left-0 top-full mt-1 w-64 max-h-[70vh] overflow-y-auto z-50 p-1.5">
          {/* 内置 */}
          <div className="px-2 pt-1 pb-1">
            <span className="text-[10px] font-semibold text-surface-300 uppercase tracking-wider">
              {t('shell.agentSwitcher.builtins')}
            </span>
          </div>
          {builtins.map(agent => {
            const active = isActive(agent)
            return (
              <button key={agent.id} onClick={() => { void select(agent) }} className={rowClass(active)} data-agent-kind={agent.kind} data-agent-id={agent.id}>
                <AgentAvatar agent={agent} size={16} className="text-surface-500 shrink-0" />
                <span className="truncate flex-1">{agentDisplayName(agent)}</span>
                {active && <Check className="w-3.5 h-3.5 shrink-0" />}
              </button>
            )
          })}

          {/* 我的 Pal */}
          <div className="px-2 pt-2.5 pb-1">
            <span className="text-[10px] font-semibold text-surface-300 uppercase tracking-wider">
              {t('shell.navigation.myAgents')}
            </span>
          </div>
          {mine.length === 0 ? (
            <div className="px-2.5 py-2 text-[12px] text-surface-300">
              {t('shell.agentSwitcher.noIndependentAgents')}
            </div>
          ) : (
            mine.map(agent => {
              const active = isActive(agent)
              return (
                <button key={agent.id} onClick={() => { void select(agent) }} className={rowClass(active)} data-agent-kind={agent.kind} data-agent-id={agent.id}>
                  <AgentAvatar agent={agent} size={16} className="text-sm leading-none shrink-0" />
                  <span className="truncate flex-1">{agent.name}</span>
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

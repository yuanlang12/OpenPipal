import { create } from 'zustand'
import { AgentSummary, RoleInfo } from '../types'
import { DEFAULT_AGENT_ID } from '../../../shared/agent-identity'

export type ThemeMode = 'system' | 'light' | 'dark'
export type ActiveView = 'chat' | 'tools' | 'settings' | 'agents' | 'tasks' | 'artifacts'
/** 插件页的四个标签；对话胶囊的「查看」要能直达「规则」，所以标签状态住在这里而不是页面本地 */
export type ToolsHubTab = 'plugins' | 'skills' | 'tools' | 'rules'

interface AppState {
  initialized: boolean
  /**
   * 正看着的内置角色 = 活跃会话记录的 role（App 里一个 effect 从 chatStore 同步过来）；
   * 还没聊起来时是欢迎页的待定选择（默认通用助手）。不是全局设置、不落盘——"当前角色"这个全局概念已经退场（统一身份第 4 段）。
   * Pal 的会话 role 是中性值，所以这里是通用助手；Pal 的身份看 chatStore.activeWorkspaceId。
   */
  currentRole: RoleInfo | null
  allRoles: RoleInfo[]
  /** 统一身份的一份列表：内置 → Pal（选择器 / 我的 Pal 页 / 欢迎页共用） */
  agents: AgentSummary[]
  showSettings: boolean
  showConversations: boolean
  theme: ThemeMode
  activeView: ActiveView
  toolsHubTab: ToolsHubTab
  /** Agent workspace panel 是否展开（仅在 activeWorkspaceId 存在时生效） */
  workspacePanelOpen: boolean
  /** Focus 模式:turn 完成后台面只留 user/过程摘要条/交付物/结论,收起中间过程消息。默认开。 */
  focusStream: boolean
}

interface AppActions {
  init: () => Promise<void>
  loadAgents: () => Promise<void>
  /**
   * 按名字对上 allRoles 里的一份；认不出（公开版没有的角色、老会话）回落通用助手。
   * 两个来源：App 从活跃会话同步；欢迎页点头像（空会话 / 还没有会话时的待定选择，首条消息才落成会话的 role）
   */
  setCurrentRoleName: (name: string | undefined) => void
  setShowSettings: (v: boolean) => void
  setShowConversations: (v: boolean) => void
  setTheme: (theme: ThemeMode) => void
  setActiveView: (view: ActiveView) => void
  setToolsHubTab: (tab: ToolsHubTab) => void
  /** 切到插件页并停在指定标签（胶囊「查看」→ 规则） */
  openToolsHub: (tab: ToolsHubTab) => void
  toggleWorkspacePanel: () => void
  setWorkspacePanelOpen: (open: boolean) => void
  toggleFocusStream: () => void
}

// 模块一加载就读 localStorage；纯 node 单测（i18n 用例经 MessageBubble → HookNoticeRow 间接引到本模块）
// 没有这个全局，读不到就按默认值——正式运行时行为不变
const readPref = (key: string): string | null =>
  typeof localStorage === 'undefined' ? null : localStorage.getItem(key)

let agentsInFlight: Promise<void> | null = null

const pickRole = (roles: RoleInfo[], name: string | undefined): RoleInfo | null =>
  roles.find(r => r.name === name) ?? roles.find(r => r.name === DEFAULT_AGENT_ID) ?? roles[0] ?? null

export const useAppStore = create<AppState & AppActions>((set) => ({
  initialized: false,
  currentRole: null,
  allRoles: [],
  agents: [],
  showSettings: false,
  showConversations: false,
  theme: (readPref('openpipal-theme') as ThemeMode) || 'system',
  activeView: 'chat' as ActiveView,
  toolsHubTab: 'plugins' as ToolsHubTab,
  workspacePanelOpen: readPref('openpipal-workspace-panel') !== 'false',
  focusStream: readPref('openpipal-focus-stream') !== 'false',

  init: async () => {
    const roles = await window.api.getAllRoles()
    set({ allRoles: roles, currentRole: pickRole(roles, DEFAULT_AGENT_ID), initialized: true })
    void useAppStore.getState().loadAgents()
  },

  loadAgents: () => {
    // 三处入口（切换器 / 我的 Pal 页 / 欢迎页）挂载时都会要这份列表：同一时刻只发一次 IPC，后来的等同一个结果
    if (!agentsInFlight) {
      agentsInFlight = (async () => {
        try {
          const agents = await window.api.listAgents?.()
          if (Array.isArray(agents)) set({ agents })
        } catch { /* 拿不到就保持上一份 */ } finally { agentsInFlight = null }
      })()
    }
    return agentsInFlight
  },

  setCurrentRoleName: (name) => set((s) => {
    const next = pickRole(s.allRoles, name)
    return next === s.currentRole ? {} : { currentRole: next }
  }),

  setShowSettings: (v) => set({ showSettings: v }),
  setShowConversations: (v) => set({ showConversations: v }),
  setActiveView: (view) => set({ activeView: view }),
  setToolsHubTab: (tab) => set({ toolsHubTab: tab }),
  openToolsHub: (tab) => set({ activeView: 'tools', toolsHubTab: tab }),
  setTheme: (theme) => {
    localStorage.setItem('openpipal-theme', theme)
    set({ theme })
  },
  toggleWorkspacePanel: () => set((s) => {
    const next = !s.workspacePanelOpen
    localStorage.setItem('openpipal-workspace-panel', String(next))
    return { workspacePanelOpen: next }
  }),
  setWorkspacePanelOpen: (open) => {
    localStorage.setItem('openpipal-workspace-panel', String(open))
    set({ workspacePanelOpen: open })
  },
  toggleFocusStream: () => set((s) => {
    const next = !s.focusStream
    localStorage.setItem('openpipal-focus-stream', String(next))
    return { focusStream: next }
  }),
}))

// 暴露给 E2E 测试 —— 与 chatStore.__chatStore 同款约定（视图切换等 UI 编排 action）
if (typeof window !== 'undefined') {
  ;(window as any).__appStore = useAppStore
}

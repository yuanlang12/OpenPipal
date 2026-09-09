import { create } from 'zustand'
import { RoleInfo } from '../types'

export type ThemeMode = 'system' | 'light' | 'dark'
export type ActiveView = 'chat' | 'tools' | 'settings' | 'agents' | 'tasks' | 'artifacts'
/** 插件页的四个标签；对话胶囊的「查看」要能直达「规则」，所以标签状态住在这里而不是页面本地 */
export type ToolsHubTab = 'plugins' | 'skills' | 'tools' | 'rules'

interface AppState {
  initialized: boolean
  currentRole: RoleInfo | null
  allRoles: RoleInfo[]
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
  switchRole: (name: string) => Promise<void>
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

export const useAppStore = create<AppState & AppActions>((set) => ({
  initialized: false,
  currentRole: null,
  allRoles: [],
  showSettings: false,
  showConversations: false,
  theme: (readPref('openpipal-theme') as ThemeMode) || 'system',
  activeView: 'chat' as ActiveView,
  toolsHubTab: 'plugins' as ToolsHubTab,
  workspacePanelOpen: readPref('openpipal-workspace-panel') !== 'false',
  focusStream: readPref('openpipal-focus-stream') !== 'false',

  init: async () => {
    const [initState, roles] = await Promise.all([
      window.api.getRoleInitState(),
      window.api.getAllRoles()
    ])
    set({
      allRoles: roles,
      currentRole: initState.hasRole ? initState.role : null,
      initialized: true
    })
  },

  switchRole: async (name) => {
    const role = await window.api.switchRole(name)
    if (role) set({ currentRole: role })
  },

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

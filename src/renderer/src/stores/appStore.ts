import { create } from 'zustand'
import { RoleInfo } from '../types'

export type ThemeMode = 'system' | 'light' | 'dark'
export type ActiveView = 'chat' | 'tools' | 'settings' | 'agents' | 'tasks' | 'artifacts'

interface AppState {
  initialized: boolean
  currentRole: RoleInfo | null
  allRoles: RoleInfo[]
  showSettings: boolean
  showConversations: boolean
  theme: ThemeMode
  activeView: ActiveView
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
  toggleWorkspacePanel: () => void
  setWorkspacePanelOpen: (open: boolean) => void
  toggleFocusStream: () => void
}

export const useAppStore = create<AppState & AppActions>((set) => ({
  initialized: false,
  currentRole: null,
  allRoles: [],
  showSettings: false,
  showConversations: false,
  theme: (localStorage.getItem('openpipal-theme') as ThemeMode) || 'system',
  activeView: 'chat' as ActiveView,
  workspacePanelOpen: localStorage.getItem('openpipal-workspace-panel') !== 'false',
  focusStream: localStorage.getItem('openpipal-focus-stream') !== 'false',

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

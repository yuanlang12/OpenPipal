import { create } from 'zustand'

// ---- Workspace Agent（文件系统驱动）----

export interface WorkspaceSummary {
  id: string
  name: string
  icon: string
  description: string
  category?: string
  createdAt: number
  updatedAt: number
  memoryCount: number
  skillCount: number
  taskCount: number
}

export interface WorkspaceSkill {
  name: string
  description: string
  content: string
}

export interface Workspace {
  meta: {
    id: string
    name: string
    icon: string
    description: string
    sourceConversationId?: string
    createdAt: number
    updatedAt: number
  }
  agentMd: string
  meMd: string
  memories: { name: string; content: string }[]
  skills: WorkspaceSkill[]
  toolsConfig: { workingDir?: string; mcpServers?: string[]; disabledTools?: string[] }
  dir: string
}

// ---- 团队（teams/<id>/）----

export type TeamTier = 'readonly' | 'auto' | 'full'

export interface TeamSummary {
  id: string
  name: string
  lead: string
  members: string[]
  tier: TeamTier
  channels: string[]
  createdAt: number
  updatedAt: number
}

interface AgentState {
  workspaces: WorkspaceSummary[]
  teams: TeamSummary[]
  loading: boolean
  creating: boolean
}

interface AgentActions {
  // Workspace
  loadWorkspaces: () => Promise<void>
  createFromConversation: (conversationId: string) => Promise<Workspace>
  deleteWorkspace: (id: string) => Promise<void>
  // Team
  loadTeams: () => Promise<void>
  /** 团队目录变了（主进程 team:changed / 话题跑完兜底）：团队列表与 Pal 列表（组长刚建的成员）一起重拉 */
  refreshTeams: () => Promise<void>
  /** 组建：主进程先造默认组长 + 团队目录；名字、章程、成员都在话题里跟组长聊出来 */
  foundTeam: () => Promise<TeamSummary>
  createTeam: (data: { name: string; members: string[]; lead?: string; tier?: TeamTier; charter?: string }) => Promise<TeamSummary>
  deleteTeam: (id: string) => Promise<void>
}

export const useAgentStore = create<AgentState & AgentActions>((set, get) => ({
  workspaces: [],
  teams: [],
  loading: false,
  creating: false,

  // ---- Team ----

  loadTeams: async () => {
    try {
      const list = await window.api.listTeams?.() || []
      set({ teams: list })
    } catch (err) {
      console.error('[AgentStore] 团队加载失败:', err)
    }
  },

  refreshTeams: async () => {
    await Promise.all([get().loadTeams(), get().loadWorkspaces()])
  },

  foundTeam: async () => {
    const team = await window.api.foundTeam!()
    const [teams, workspaces] = await Promise.all([window.api.listTeams?.() || [], window.api.listAgentWorkspaces?.() || []])
    set({ teams, workspaces })
    return team
  },

  createTeam: async (data) => {
    const team = await window.api.createTeam!(data)
    const list = await window.api.listTeams?.() || []
    set({ teams: list })
    return team
  },

  deleteTeam: async (id) => {
    await window.api.deleteTeam!(id)
    const list = await window.api.listTeams?.() || []
    set({ teams: list })
  },


  // ---- Workspace ----

  loadWorkspaces: async () => {
    try {
      const list = await window.api.listAgentWorkspaces?.() || []
      set({ workspaces: list })
    } catch (err) {
      console.error('[AgentStore] Workspace 加载失败:', err)
    }
  },

  createFromConversation: async (conversationId: string) => {
    set({ creating: true })
    try {
      const workspace = await window.api.createAgentFromConversation!(conversationId)
      // 刷新列表
      const list = await window.api.listAgentWorkspaces?.() || []
      set({ workspaces: list, creating: false })
      return workspace
    } catch (err) {
      set({ creating: false })
      throw err
    }
  },

  deleteWorkspace: async (id: string) => {
    await window.api.deleteAgentWorkspace!(id)
    const list = await window.api.listAgentWorkspaces?.() || []
    set({ workspaces: list })
  }
}))

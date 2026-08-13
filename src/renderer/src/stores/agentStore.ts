import { create } from 'zustand'

export interface AgentTemplateSummary {
  id: string
  name: string
  description: string
  icon: string
  workingDir?: string
  createdAt: number
  updatedAt: number
}

export interface AgentTemplate extends AgentTemplateSummary {
  systemPrompt: string
  tools?: string[]
}

// ---- Workspace Agent（文件系统驱动）----

export interface WorkspaceSummary {
  id: string
  name: string
  icon: string
  description: string
  createdAt: number
  updatedAt: number
  hasAgentMd: boolean
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

interface AgentState {
  templates: AgentTemplateSummary[]
  workspaces: WorkspaceSummary[]
  loading: boolean
  creating: boolean
}

interface AgentActions {
  loadTemplates: () => Promise<void>
  createTemplate: (data: Omit<AgentTemplate, 'id' | 'createdAt' | 'updatedAt'>) => Promise<AgentTemplate>
  updateTemplate: (id: string, data: Partial<AgentTemplate>) => Promise<void>
  deleteTemplate: (id: string) => Promise<void>
  // Workspace
  loadWorkspaces: () => Promise<void>
  createFromConversation: (conversationId: string) => Promise<Workspace>
  deleteWorkspace: (id: string) => Promise<void>
}

export const useAgentStore = create<AgentState & AgentActions>((set) => ({
  templates: [],
  workspaces: [],
  loading: false,
  creating: false,

  loadTemplates: async () => {
    set({ loading: true })
    try {
      const list = await window.api.listAgentTemplates!()
      set({ templates: list })
    } catch (err) {
      console.error('[AgentStore] 加载失败:', err)
    } finally {
      set({ loading: false })
    }
  },

  createTemplate: async (data) => {
    const created = await window.api.createAgentTemplate!(data)
    const list = await window.api.listAgentTemplates!()
    set({ templates: list })
    return created
  },

  updateTemplate: async (id, data) => {
    await window.api.updateAgentTemplate!(id, data)
    const list = await window.api.listAgentTemplates!()
    set({ templates: list })
  },

  deleteTemplate: async (id) => {
    await window.api.deleteAgentTemplate!(id)
    const list = await window.api.listAgentTemplates!()
    set({ templates: list })
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

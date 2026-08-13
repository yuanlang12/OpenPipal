/**
 * Task Store — 统一的任务 store（取代旧 scheduledTaskStore + agentStore.trigger 分支）
 */

import { create } from 'zustand'
import type { Task } from '../types'

interface TaskState {
  tasks: Task[]
  loading: boolean
}

interface TaskActions {
  /** 加载所有任务（可选过滤 workspace） */
  loadTasks: (filter?: { workspaceId?: string }) => Promise<void>
  createTask: (data: Omit<Task, 'id' | 'createdAt' | 'updatedAt'>) => Promise<Task>
  updateTask: (id: string, data: Partial<Task>) => Promise<void>
  deleteTask: (id: string) => Promise<void>
  toggleTask: (id: string, enabled: boolean) => Promise<void>
  /** 立即触发执行一次（无视 nextRun，fire-and-forget） */
  triggerNow: (id: string) => Promise<{ ok: boolean; error?: string }>
  /** 更新单个任务的本地状态（用于 task:executed 推送） */
  patchTask: (id: string, patch: Partial<Task>) => void
}

export const useTaskStore = create<TaskState & TaskActions>((set) => ({
  tasks: [],
  loading: false,

  loadTasks: async (filter) => {
    set({ loading: true })
    try {
      const list = await window.api.listTasks!(filter)
      set({ tasks: list })
    } catch (err) {
      console.error('[TaskStore] 加载失败:', err)
    } finally {
      set({ loading: false })
    }
  },

  createTask: async (data) => {
    const created = await window.api.createTask!(data)
    const list = await window.api.listTasks!()
    set({ tasks: list })
    return created
  },

  updateTask: async (id, data) => {
    await window.api.updateTask!(id, data)
    const list = await window.api.listTasks!()
    set({ tasks: list })
  },

  deleteTask: async (id) => {
    await window.api.deleteTask!(id)
    const list = await window.api.listTasks!()
    set({ tasks: list })
  },

  toggleTask: async (id, enabled) => {
    await window.api.toggleTask!(id, enabled)
    const list = await window.api.listTasks!()
    set({ tasks: list })
  },

  triggerNow: async (id) => {
    return await window.api.triggerTaskNow!(id)
  },

  patchTask: (id, patch) => {
    set(state => ({
      tasks: state.tasks.map(t => t.id === id ? { ...t, ...patch } : t)
    }))
  }
}))

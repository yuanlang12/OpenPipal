/**
 * Sources Store —— Cave 模式资料区的 renderer 端状态
 *
 * 数据流：
 *   - IPC 是真相来源（disk-backed by ~/.openpipal/workspace/sources/<id>/）
 *   - 这里只是 UI 缓存 + 乐观更新管理器
 *   - 所有变更 IPC 调完成功后回写 store；失败时回滚
 *
 * 乐观 UI 原则（来自 P1 拍板的"丝滑+愉悦"硬约束）：
 *   - addSource: 立即把 pending 卡片塞进列表（status='pending'，骨架屏），IPC 完成后用真实 source 替换占位
 *   - removeSource: 立即从列表移除，IPC 失败时回滚
 *   - 用户不应该看到任何等待时间 >100ms
 */

import { create } from 'zustand'
import type { Source, AddSourceParams, SourceStatus, SourceStatusPatch } from '../types'

interface SourcesState {
  /** 完整列表，按 addedAt 降序（IPC list 已排好） */
  sources: Source[]
  /** 首次加载完成（用于区分"还没加载"和"加载完是空"） */
  loaded: boolean
  /** 正在加载（initial load 或 refresh） */
  loading: boolean
}

interface SourcesActions {
  /** 从 IPC 拉取完整列表，覆盖本地 */
  refresh: () => Promise<void>
  /** 乐观新增 —— 立即塞临时卡片，IPC 完成后替换 */
  addOptimistic: (params: AddSourceParams) => Promise<Source | null>
  /** 乐观删除 —— 立即移除，IPC 失败回滚 */
  removeOptimistic: (id: string) => Promise<boolean>
  /** 内部：把 IPC 返回的 source 写回 store（添加或替换） */
  upsertLocal: (source: Source) => void
  /** 内部：直接从 store 移除（不调 IPC） */
  removeLocal: (id: string) => void
  /** Ingest 任务调 IPC 更新状态后，同步更新本地 */
  patchStatus: (id: string, status: SourceStatus, patch?: SourceStatusPatch) => Promise<void>
}

function makePendingPlaceholder(params: AddSourceParams): Source {
  return {
    id: `__pending_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    title: params.title,
    type: params.type,
    status: 'pending',
    sourceUrl: params.sourceUrl,
    addedAt: Date.now(),
    citationIndex: undefined
  }
}

/** 重新赋 citationIndex（按 addedAt 升序，最新在最后，编号从 1 开始） */
function reassignCitationIndex(list: Source[]): Source[] {
  const asc = [...list].sort((a, b) => a.addedAt - b.addedAt)
  asc.forEach((s, i) => { s.citationIndex = i + 1 })
  return [...list].sort((a, b) => b.addedAt - a.addedAt)
}

export const useSourcesStore = create<SourcesState & SourcesActions>((set, get) => ({
  sources: [],
  loaded: false,
  loading: false,

  refresh: async () => {
    set({ loading: true })
    try {
      const list = await window.api.listSources()
      set({ sources: list, loaded: true, loading: false })
    } catch (err) {
      console.warn('[SourcesStore] refresh 失败:', err)
      set({ loading: false })
    }
  },

  addOptimistic: async (params) => {
    const placeholder = makePendingPlaceholder(params)
    // 乐观插入：立即塞 placeholder，UI 立刻渲染骨架屏
    set(s => ({ sources: reassignCitationIndex([placeholder, ...s.sources]) }))

    try {
      const created = await window.api.addSource(params)
      // 用真实 source 替换 placeholder（按 placeholder.id 找）
      set(s => {
        const replaced = s.sources.map(src => src.id === placeholder.id ? created : src)
        return { sources: reassignCitationIndex(replaced) }
      })
      return created
    } catch (err) {
      console.warn('[SourcesStore] addSource 失败,回滚:', err)
      // 回滚：移除 placeholder
      set(s => ({ sources: s.sources.filter(src => src.id !== placeholder.id) }))
      return null
    }
  },

  removeOptimistic: async (id) => {
    const snapshot = get().sources
    // 乐观移除：立即从列表去掉
    set({ sources: reassignCitationIndex(snapshot.filter(s => s.id !== id)) })

    try {
      const result = await window.api.removeSource(id)
      if (!result.ok) throw new Error(result.error || 'remove failed')
      return true
    } catch (err) {
      console.warn('[SourcesStore] removeSource 失败,回滚:', err)
      // 回滚：恢复快照
      set({ sources: snapshot })
      return false
    }
  },

  upsertLocal: (source) => set(s => {
    const exists = s.sources.find(x => x.id === source.id)
    const next = exists
      ? s.sources.map(x => x.id === source.id ? source : x)
      : [source, ...s.sources]
    return { sources: reassignCitationIndex(next) }
  }),

  removeLocal: (id) => set(s => ({
    sources: reassignCitationIndex(s.sources.filter(x => x.id !== id))
  })),

  patchStatus: async (id, status, patch) => {
    try {
      const updated = await window.api.updateSourceStatus(id, status, patch)
      if (updated) {
        get().upsertLocal(updated)
      }
    } catch (err) {
      console.warn('[SourcesStore] updateSourceStatus 失败:', err)
    }
  }
}))

import { create } from 'zustand'

/**
 * Artifact 类型 —— 表示 AI 创建的一等"作品"形态：
 * - html / svg / code / markdown：文本/代码类，已有稳定渲染
 * - document：结构化富文本文档（Google Docs / Notion 风格），阶段 6 占位
 * - canvas：自由画布（白板、图形、Figma-lite），阶段 6 占位
 * - mcp-app：MCP Apps Extension,server 提供的可交互 HTML(iframe 沙盒 + postMessage);content 为 JSON
 * 文档与画布后续扩展时复用 workspaceStore 的 tab 视图，不改存储结构。
 */
export type ArtifactType = 'html' | 'code' | 'markdown' | 'svg' | 'document' | 'canvas' | 'questions' | 'todos' | 'mcp-app' | 'goal' | 'design-system'

export interface Artifact {
  id: string
  type: ArtifactType
  title: string
  /** Stable OpenPipal-owned fallback label. Dynamic model/user titles never use this field. */
  titleKey?: string
  content: string
  language?: string
  messageId: string
  createdAt: number
  /** 会话切换重灌灌入的历史产物。workspace 桥接据此区分"新产物"（自动开 tab）与"重灌"
   *  （tab 恢复由 chatStore 按会话记忆决定，桥接不插手）——用数据自带来源，不依赖时序窗口。 */
  rehydrated?: boolean
}

export interface StreamingArtifact {
  id: string
  type: string
  title: string
  titleKey?: string
  content: string
}

interface ArtifactState {
  artifacts: Artifact[]
  activeId: string | null
  panelOpen: boolean
  streamingArtifact: StreamingArtifact | null
}

interface ArtifactActions {
  addArtifact: (artifact: Artifact) => void
  removeArtifact: (id: string) => void
  setActive: (id: string) => void
  togglePanel: () => void
  closePanel: () => void
  clearArtifacts: () => void
  startStreaming: (id: string, type?: string, title?: string, titleKey?: string) => void
  updateStreaming: (title?: string, type?: string, content?: string) => void
  finalizeStreaming: (artifact: Artifact) => void
  discardStreaming: () => void
}

export const useArtifactStore = create<ArtifactState & ArtifactActions>((set) => ({
  artifacts: [],
  activeId: null,
  panelOpen: false,
  streamingArtifact: null,

  // upsert 语义：如果同 id 已存在 → 替换（迭代更新）；否则 → 新增
  // 这样 agent 可以传同一个 id 反复 create_artifact 来"原地修改"，UI tab 不会越积越多
  addArtifact: (artifact) => set(s => {
    const idx = s.artifacts.findIndex(a => a.id === artifact.id)
    const artifacts = idx >= 0
      ? s.artifacts.map((a, i) => i === idx ? artifact : a)
      : [...s.artifacts, artifact]
    return { artifacts, activeId: artifact.id, panelOpen: true }
  }),

  removeArtifact: (id) => set(s => {
    const artifacts = s.artifacts.filter(a => a.id !== id)
    return {
      artifacts,
      activeId: s.activeId === id ? (artifacts[artifacts.length - 1]?.id ?? null) : s.activeId
    }
  }),

  setActive: (id) => set({ activeId: id, panelOpen: true }),

  togglePanel: () => set(s => ({ panelOpen: !s.panelOpen })),

  closePanel: () => set({ panelOpen: false }),

  clearArtifacts: () => set({ artifacts: [], activeId: null, panelOpen: false, streamingArtifact: null }),

  startStreaming: (id, type = 'html', title = '', titleKey) => set({
    streamingArtifact: { id, type, title, titleKey, content: '' },
    panelOpen: true
  }),

  updateStreaming: (title, type, content) => set(s => {
    if (!s.streamingArtifact) return s
    return {
      streamingArtifact: {
        ...s.streamingArtifact,
        ...(title && { title }),
        ...(type && { type }),
        ...(content !== undefined && { content })
      }
    }
  }),

  finalizeStreaming: (artifact) => set(s => ({
    streamingArtifact: null,
    artifacts: [...s.artifacts, artifact],
    activeId: artifact.id,
    panelOpen: true
  })),

  // create_artifact 被门闩拒绝时没有 artifact 完成事件——丢弃残留的流式稿。
  // 不清的话，重试的首个空 delta 会把预览"原地擦除重播"（用户视角=又生成了一遍）
  discardStreaming: () => set({ streamingArtifact: null })
}))

// dev-only：E2E 可通过 window.__artifactStore 直接驱动流程
if (typeof window !== 'undefined' && import.meta.env?.DEV) {
  ;(window as any).__artifactStore = useArtifactStore
}

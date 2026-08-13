import { create } from 'zustand'

export interface Visualizer {
  id: string
  messageId: string
  type: 'html' | 'svg' | 'chart'
  title: string
  content: string
  height?: number
  createdAt: number
}

export interface StreamingVisualizer {
  id: string
  title: string
  content: string
  height: number
}

interface VisualizerState {
  visualizers: Map<string, Visualizer>
  streamingVisualizer: StreamingVisualizer | null
}

interface VisualizerActions {
  getVisualizer: (messageId: string) => Visualizer | undefined
  setVisualizer: (messageId: string, visualizer: Visualizer) => void
  deleteVisualizer: (messageId: string) => void
  clearAll: () => void
  startStreaming: (id: string, title?: string, height?: number) => void
  updateStreaming: (title?: string, content?: string, height?: number) => void
  finalizeStreaming: () => void
}

export const useVisualizerStore = create<VisualizerState & VisualizerActions>((set, get) => ({
  visualizers: new Map(),
  streamingVisualizer: null,

  getVisualizer: (messageId) => get().visualizers.get(messageId),

  setVisualizer: (messageId, visualizer) => set((state) => {
    const newMap = new Map(state.visualizers)
    newMap.set(messageId, visualizer)
    return { visualizers: newMap }
  }),

  deleteVisualizer: (messageId) => set((state) => {
    const newMap = new Map(state.visualizers)
    newMap.delete(messageId)
    return { visualizers: newMap }
  }),

  clearAll: () => set({ visualizers: new Map(), streamingVisualizer: null }),

  startStreaming: (id, title = '生成中...', height = 300) => set({
    streamingVisualizer: { id, title, content: '', height }
  }),

  updateStreaming: (title, content, height) => set(s => {
    if (!s.streamingVisualizer) return s
    return {
      streamingVisualizer: {
        ...s.streamingVisualizer,
        ...(title && { title }),
        ...(content !== undefined && { content }),
        ...(height !== undefined && { height })
      }
    }
  }),

  finalizeStreaming: () => set({ streamingVisualizer: null })
}))

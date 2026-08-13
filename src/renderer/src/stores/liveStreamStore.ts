import { create } from 'zustand'

/**
 * 实时流式投影 store —— 与 visualizerStore 同构(升级现有轮子,非新造)。
 *
 * 持有"每个 token / 每次工具 tick 都在变"的临时显示状态:流式文字 + 工具指示。
 * 这些字段从 chatStore 搬出来,使得高频 set 的"重渲染半径 = 订阅它的那个叶子组件",
 * 不再像放在 chatStore 时那样牵动 ChatPanel / 整条消息列表。
 *
 * 不变量:
 * - 本 store 的字段是 ephemeral —— 提交即弃、永不持久化。
 * - 权威文本源仍是 chatStore 的模块级 `streamBuf`;本 store 只是它的"反应式投影"
 *   (像 visualizerStore.streamingVisualizer 之于流式 HTML)。
 * - messages[] 才是 canonical(持久化、决定消息顺序),与本 store 完全解耦。
 */
interface LiveStreamState {
  /** 当前正在流的助手文字(已做 NO_REPLY 静默投影:静默时为 '') */
  text: string
  /** 正在执行的工具名(null=无) */
  toolStatus: string | null
  /** 工具写入进度字符数(仅作流式滚动跟随的触发,目前不直接渲染) */
  toolProgressChars: number
  /** 工具流式标题(从 JSON 参数里提取) */
  toolStreamingTitle: string
  /** 文件类工具(edit/write/read)运行期的目标文件路径——参数流里一提取到就随 progress 携带 */
  toolStreamingPath: string | null
}

interface LiveStreamActions {
  setText: (text: string) => void
  setToolStatus: (toolStatus: string | null) => void
  setToolProgress: (toolProgressChars: number, path?: string) => void
  setToolStreamingTitle: (toolStreamingTitle: string) => void
  reset: () => void
}

export const useLiveStreamStore = create<LiveStreamState & LiveStreamActions>((set) => ({
  text: '',
  toolStatus: null,
  toolProgressChars: 0,
  toolStreamingTitle: '',
  toolStreamingPath: null,
  setText: (text) => set({ text }),
  // 新工具开始 → 上一个调用的文件名不再适用,随状态一起清
  setToolStatus: (toolStatus) => set({ toolStatus, toolStreamingPath: null }),
  setToolProgress: (toolProgressChars, path) =>
    set(path !== undefined ? { toolProgressChars, toolStreamingPath: path } : { toolProgressChars }),
  setToolStreamingTitle: (toolStreamingTitle) => set({ toolStreamingTitle }),
  reset: () => set({ text: '', toolStatus: null, toolProgressChars: 0, toolStreamingTitle: '', toolStreamingPath: null }),
}))

/**
 * 正文 setText 的节流合帧器 —— SSE 每个 token delta 都调 setTextThrottled 而非同步 setText，
 * 下游订阅者(StreamingArea 的 markdown+KaTeX 全量重解析)因此从 O(chunk 数) 降到 O(帧数)。
 * 用 setTimeout(~66ms) 而非 requestAnimationFrame：窗口隐藏时 rAF 会暂停，导致尾部文本冻结；
 * setTimeout 不受窗口可见性影响。
 *
 * 权威数据不受影响：这只改"推给展示层的时机"，chatStore 里的 streamBuf/最终 commit 逻辑
 * 照读不误，节流的只是 liveStream.text 这一份 ephemeral 投影。
 */
let pendingText: string | null = null
let flushTimer: ReturnType<typeof setTimeout> | null = null

/** 取消挂起的节流 timer——立即写入(setText)/reset 前必须先调用，否则 timer 会在边界之后
 *  延迟触发，用旧文本覆盖掉已经清空/提交的展示状态。 */
function cancelPendingFlush(): void {
  if (flushTimer) {
    clearTimeout(flushTimer)
    flushTimer = null
  }
  pendingText = null
}

/**
 * 非响应式写入入口 —— 供 chatStore 各事件 handler 调用(避免每处都写 getState())。
 * 与 visualizerStore 在 chatStore 里 `useVisualizerStore.getState().xxx()` 同样的用法。
 */
export const liveStream = {
  /** 节流写入正文——仅供高频 SSE delta 路径使用(chatStore onStreamChunk)。 */
  setTextThrottled: (text: string) => {
    pendingText = text
    if (flushTimer) return
    flushTimer = setTimeout(() => {
      flushTimer = null
      if (pendingText !== null) {
        useLiveStreamStore.getState().setText(pendingText)
        pendingText = null
      }
    }, 66)
  },
  // 立即写入——reset 前一律先取消挂起的节流 timer，保证边界处不会被延迟的旧文本覆盖。
  setText: (text: string) => {
    cancelPendingFlush()
    useLiveStreamStore.getState().setText(text)
  },
  setToolStatus: (s: string | null) => useLiveStreamStore.getState().setToolStatus(s),
  setToolProgress: (n: number, path?: string) => useLiveStreamStore.getState().setToolProgress(n, path),
  setToolStreamingTitle: (t: string) => useLiveStreamStore.getState().setToolStreamingTitle(t),
  reset: () => {
    cancelPendingFlush()
    useLiveStreamStore.getState().reset()
  },
}

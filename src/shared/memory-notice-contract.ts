/**
 * 记忆提取 / 整理完成后给对话流的胶囊提醒（inject-notice/memory）的数据。
 * 主进程发事件、渲染层落成消息、会话存储持久化——三边同一份形状。纯展示，不进模型载荷。
 */
export interface MemoryNotice {
  type: 'extracted' | 'dreamed'
  memories?: { name: string; type: string; scope: string }[]
  actionsApplied?: number
  summary?: string
  /** 团队话题里的整理：落的是团队记忆，胶囊要说清是哪个团队 */
  team?: string
}

/**
 * 会话变更的进程内广播。
 *
 * 存在的理由：适配器（openpipal-acp）此前只能"主动来问"，桌面端改了人格 / 标题 /
 * 目标之后没有任何办法捅它一下，编辑器那边只能等下一轮开跑才更正。这里给出唯一
 * 一个"谁改了会话"的出口，由 `/api/acp/events` 转成一条常驻 SSE 推给适配器。
 *
 * 只广播"哪条会话的哪一类东西变了"，**不带内容**：内容的事实源始终是磁盘，
 * 订阅方收到信号后自己去读。把内容塞进事件等于让同一份状态有两个来源。
 */

export type ConversationChangeKind = 'persona' | 'title' | 'config'

export interface ConversationChange {
  conversationId: string
  kind: ConversationChangeKind
}

type Listener = (change: ConversationChange) => void

const listeners = new Set<Listener>()

export function subscribeConversationChanges(listener: Listener): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

export function publishConversationChange(conversationId: string, kind: ConversationChangeKind): void {
  if (!conversationId || listeners.size === 0) return
  for (const listener of Array.from(listeners)) {
    try {
      listener({ conversationId, kind })
    } catch (error) {
      // 一个订阅者炸了不能连累写盘路径——发布点全在 conversation-store 的写函数里
      console.warn('[ConvEvents] 订阅者处理失败:', (error as Error)?.message)
    }
  }
}

/** 测试用：把进程级订阅清回出厂 */
export function resetConversationChangeListeners(): void {
  listeners.clear()
}

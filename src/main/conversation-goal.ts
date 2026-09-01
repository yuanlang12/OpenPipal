/**
 * 会话目标的读写（`/goal` 背后的那点状态）。
 *
 * 抽出来是因为现在有两个入口：桌面端的 `chat:set-goal` IPC 和给 ACP 用的
 * HTTP 路由。目标对象的形状（尤其 maxTurns）是 goal loop 的行为契约，
 * 两处各写一遍迟早会漂。UI 推送留在 IPC 那边——ACP 没有渲染层要推。
 */

import type { ConversationGoal } from './goal-checker'
import { mutateConversationConfig, peekConversation } from './conversation-service'

/** 与 Claude Code Stop hook 的 BLOCK_CAP 对齐（见 goal-checker.ts 的字段注释） */
export const GOAL_MAX_TURNS = 8

export function buildConversationGoal(text: string, now: number = Date.now()): ConversationGoal {
  return {
    text: text.trim(),
    maxTurns: GOAL_MAX_TURNS,
    turnsUsed: 0,
    status: 'active',
    consecutiveBlocks: 0,
    createdAt: now
  }
}

/**
 * 设目标。会话不存在或文本为空返回 null——调用方据此决定报什么错。
 *
 * 走 `mutateConversationConfig` 而不是"先读整份 config 再整份写回"：设目标常常和这条
 * 会话正在跑的那一轮撞上（goal loop 每次续跑都会写回 turnsUsed/status），锁外读的快照
 * 会把对方的写整个盖掉。
 */
export async function setConversationGoal(
  conversationId: string,
  text: string
): Promise<ConversationGoal | null> {
  if (!conversationId || !text?.trim()) return null
  const goal = buildConversationGoal(text)
  const persisted = await mutateConversationConfig(conversationId, (config) => ({ ...config, goal }))
  return persisted ? goal : null
}

/**
 * 清目标。返回值是"这次真的清掉了一个目标"——本来就没有时**不写盘**：
 * 空写会白 bump 一次 `updatedAt`，而 ACP 的 session/list 游标正是钉在时间上的，
 * 一次无谓的 bump 就可能让某条会话在翻页中被跳过。
 */
export function clearConversationGoal(conversationId: string): Promise<boolean> {
  if (!conversationId) return Promise.resolve(false)
  return mutateConversationConfig(conversationId, (config) => {
    if (config.goal === undefined) return null
    const rest = { ...config }
    delete rest.goal
    return rest
  })
}

export function readConversationGoal(conversationId: string): ConversationGoal | null {
  if (!conversationId) return null
  return peekConversation(conversationId)?.config?.goal || null
}

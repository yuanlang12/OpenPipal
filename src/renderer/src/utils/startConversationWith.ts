import { useAppStore } from '../stores/appStore'
import { useChatStore } from '../stores/chatStore'
import type { AgentSummary } from '../types'

/**
 * "用它开一条对话"——切换器、欢迎页、我的 Pal 页三处同一个动词（统一身份第 4 段）。
 *
 * 内置 Agent：开一条它的空会话，落到它的欢迎页（前置页 / 头像）——角色是会话自己的，没有全局"当前角色"可切。
 * Pal：没有前置页，直接开一条它的会话（模板已并入 Pal，第三种身份没了）。
 */
export async function startConversationWith(agent: Pick<AgentSummary, 'id' | 'kind' | 'name'>): Promise<void> {
  const app = useAppStore.getState()
  const chat = useChatStore.getState()
  if (agent.kind === 'builtin') {
    await chat.newConversation(agent.id)
  } else {
    await chat.newConversationFromWorkspace(agent.id, agent.name)
  }
  app.setActiveView('chat')
}

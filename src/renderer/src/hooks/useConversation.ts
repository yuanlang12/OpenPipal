import { useState, useCallback, useEffect } from 'react'
import { ChatMessage } from '../types'

export interface ConversationSummary {
  id: string
  title: string
  role: string
  createdAt: number
  updatedAt: number
  messageCount: number
  lastMessage?: string
}

export function useConversation(currentRoleName: string) {
  const [conversations, setConversations] = useState<ConversationSummary[]>([])
  const [activeConversationId, setActiveConversationId] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  // 加载对话列表
  const refreshList = useCallback(async () => {
    const list = await window.api.listConversations()
    setConversations(list)
    return list
  }, [])

  // 初始化：加载列表并恢复最近对话
  useEffect(() => {
    async function init() {
      const list = await refreshList()
      // 如果有当前角色的对话，恢复最近的一个
      const roleConvs = list.filter((c: ConversationSummary) => c.role === currentRoleName)
      if (roleConvs.length > 0) {
        setActiveConversationId(roleConvs[0].id)
      }
      setLoading(false)
    }
    init()
  }, [currentRoleName, refreshList])

  // 创建新对话
  const createNew = useCallback(async (): Promise<string> => {
    const conv = await window.api.createConversation(currentRoleName)
    setActiveConversationId(conv.id)
    await refreshList()
    return conv.id
  }, [currentRoleName, refreshList])

  // 切换对话
  const switchTo = useCallback(async (id: string): Promise<ChatMessage[]> => {
    setActiveConversationId(id)
    const messages = await window.api.getConversationMessages(id)
    return messages
  }, [])

  // 保存消息到当前对话
  const saveMessages = useCallback(async (messages: ChatMessage[]) => {
    if (!activeConversationId) return
    await window.api.replaceMessages(activeConversationId, messages)
    // 静默刷新列表以更新标题和时间
    refreshList()
  }, [activeConversationId, refreshList])

  // 追加消息
  const appendMessage = useCallback(async (messages: ChatMessage[]) => {
    if (!activeConversationId) return
    await window.api.appendMessages(activeConversationId, messages)
    refreshList()
  }, [activeConversationId, refreshList])

  // 删除对话
  const deleteConv = useCallback(async (id: string) => {
    await window.api.deleteConversation(id)
    if (activeConversationId === id) {
      setActiveConversationId(null)
    }
    await refreshList()
  }, [activeConversationId, refreshList])

  // 确保有活跃对话（如果没有则创建）
  const ensureActiveConversation = useCallback(async (): Promise<string> => {
    if (activeConversationId) return activeConversationId
    return createNew()
  }, [activeConversationId, createNew])

  return {
    conversations,
    activeConversationId,
    loading,
    createNew,
    switchTo,
    saveMessages,
    appendMessage,
    deleteConv,
    refreshList,
    ensureActiveConversation
  }
}

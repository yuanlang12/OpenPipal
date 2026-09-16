/**
 * 跨会话消息在界面上的样子：主进程拼的头尾说明只给模型看，界面只显示正文 + 来源小字；
 * 这条消息就是一条用户消息（开新 turn），不是过程步骤。
 */
import { describe, expect, it } from 'vitest'
import { composePeerMessage, parsePeerMessage, PEER_MESSAGE_KIND } from '../../src/shared/peer-message-contract'
import { inferMessageKind, normalizeChatMessage } from '../../src/renderer/src/chat/messages'
import { formatMessageContentForDisplay } from '../../src/renderer/src/chat/messageDisplay'
import { groupTurns } from '../../src/renderer/src/chat/groupTurns'
import type { ChatMessage } from '../../src/renderer/src/types'

const FROM = '「落地页设计」（设计助手）'
const ID = 'c0c0c0c0-0000-4000-8000-000000000006'
const t = ((key: string, opts?: Record<string, unknown>) => `${key}${opts ? JSON.stringify(opts) : ''}`) as never

describe('peer message 契约', () => {
  it('拼出来能拆回去：来源、id、正文；正文里的换行与方括号不受影响', () => {
    const body = '进度到哪了？\n[补充] 明天要交'
    const composed = composePeerMessage(FROM, ID, body)
    expect(composed.split('\n')[0]).toBe(`[来自另一条对话 ${FROM} 的消息 · 对话 id ${ID}]`)
    expect(parsePeerMessage(composed)).toEqual({ from: FROM, fromId: ID, body })
    expect(parsePeerMessage('普通消息')).toBeNull()
  })

  it('渲染层：归成 user、开新 turn；显示正文不显示头尾说明', () => {
    const msg: ChatMessage = { id: 'p1', role: 'user', content: composePeerMessage(FROM, ID, '进度到哪了？'), timestamp: 1, messageKind: PEER_MESSAGE_KIND }
    expect(inferMessageKind(msg)).toBe('user')
    expect(normalizeChatMessage(msg).messageKind).toBe(PEER_MESSAGE_KIND) // 加载归一化不能把来源标记冲掉
    expect(formatMessageContentForDisplay(msg, t)).toBe('进度到哪了？')
    const turns = groupTurns([
      { id: 'u0', role: 'user', content: '你好', timestamp: 0 },
      { id: 'a0', role: 'assistant', content: '在', timestamp: 0 },
      msg,
      { id: 'a1', role: 'assistant', content: '做到一半', timestamp: 2 }
    ])
    expect(turns).toHaveLength(2)
    expect(turns[1].userMsg.id).toBe('p1')
  })
})

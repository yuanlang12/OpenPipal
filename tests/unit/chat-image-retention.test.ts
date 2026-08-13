import { describe, expect, it } from 'vitest'
import { toApiMessages } from '../../src/renderer/src/stores/chatStore'
import type { ChatMessage } from '../../src/renderer/src/types'

function userImage(id: string): ChatMessage {
  return {
    id,
    role: 'user',
    content: `homework-${id}`,
    images: [`data:image/png;base64,${id}`],
    imagePaths: [`uploads/${id}.png`],
    timestamp: 1
  }
}

function assistant(id: string): ChatMessage {
  return { id, role: 'assistant', content: `reply-${id}`, timestamp: 1 }
}

describe('toApiMessages 图片保留', () => {
  it('图片不会被大量后续消息或工具调用挤出上下文', () => {
    const first = userImage('first')
    const history: ChatMessage[] = [
      first,
      ...Array.from({ length: 80 }, (_, i) => assistant(`a-${i}`)),
      { id: 'followup', role: 'user', content: '继续按刚才原图批改', timestamp: 1 }
    ]
    const payload = toApiMessages(history)
    const replayed = payload.find(message => message.content === first.content)
    expect(replayed?.images).toEqual(first.images)
    expect(replayed?.imagePaths).toEqual(first.imagePaths)
  })

  it('旧版本 imagesDroppedFromPayload 标记不再导致第二轮看不到原图', () => {
    const legacy = { ...userImage('legacy'), imagesDroppedFromPayload: true }
    const [payload] = toApiMessages([legacy])
    expect(payload.images).toEqual(legacy.images)
    expect(payload.screenshot).toBe(legacy.images?.[0])
  })

  it('工具截图与附件引用一起进入主进程，压缩后再按需重内联', () => {
    const tool: ChatMessage = {
      id: 'tool-1',
      role: 'tool',
      content: '已捕获截图',
      toolName: 'capture_screenshot',
      toolCallId: 'call-1',
      screenshotRef: 'tool-1.png',
      timestamp: 1
    }
    const [payload] = toApiMessages([tool])
    expect(payload.screenshotRef).toBe('tool-1.png')
    expect(payload.toolCallId).toBe('call-1')
  })

  it('UI 卡片展示数据不会覆盖模型真正调用工具时的参数', () => {
    const tool: ChatMessage = {
      id: 'tool-subagent',
      role: 'tool',
      content: '完整子 Agent 结论',
      toolName: 'subagent',
      toolArgs: JSON.stringify({ profile: 'reviewer', messages: [] }),
      modelToolArgs: JSON.stringify({ task: '批改六张作业图', profile: 'reviewer' }),
      timestamp: 1
    }
    const [payload] = toApiMessages([tool])
    expect(JSON.parse(payload.toolArgs!)).toEqual({ task: '批改六张作业图', profile: 'reviewer' })
  })
})

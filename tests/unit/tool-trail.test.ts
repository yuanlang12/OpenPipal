import { describe, expect, it } from 'vitest'
import {
  buildToolPairMessages,
  isReplayableToolMessage,
  measureToolTrail
} from '../../src/main/tool-trail'
import { shouldSendMessageToModel } from '../../src/renderer/src/chat/messages'

describe('工具轨迹完整回放', () => {
  it('finalized 工具消息可回放，空锚点不可回放', () => {
    expect(isReplayableToolMessage({ role: 'tool', toolName: 'read', content: '原文' })).toBe(true)
    expect(isReplayableToolMessage({ role: 'tool', toolName: 'read', content: '' })).toBe(false)
  })

  it('工具入参和结果原样恢复成配对消息', () => {
    const args = { path: '/tmp/homework.png', rubric: '15分6维度' }
    const [assistant, result] = buildToolPairMessages({
      role: 'tool',
      id: 'tool-1',
      toolCallId: 'call-1',
      toolName: 'read',
      toolArgs: JSON.stringify(args),
      content: '完整读取结果'
    }, 0, [{ type: 'text', text: '我先读取图片。' }])

    expect((assistant.content as any[])[0].text).toBe('我先读取图片。')
    expect((assistant.content as any[])[1]).toMatchObject({
      type: 'toolCall',
      id: 'call-1',
      name: 'read',
      arguments: args
    })
    expect(result).toMatchObject({
      role: 'toolResult',
      toolCallId: 'call-1',
      toolName: 'read'
    })
    expect((result.content as any[])[0].text).toBe('完整读取结果')
  })

  it('缺 toolCallId 的老消息使用自身 id，不随数组下标漂移', () => {
    const message = { role: 'tool', id: 'tool-legacy', toolName: 'bash', content: 'ok' }
    const [at0] = buildToolPairMessages(message, 0, [])
    const [at9] = buildToolPairMessages(message, 9, [])
    expect((at0.content as any[])[0].id).toBe('hist-tool-legacy')
    expect((at9.content as any[])[0].id).toBe('hist-tool-legacy')
  })

  it('工具截图随 toolResult 回放，不被文本轨迹规则卸载', () => {
    const [, result] = buildToolPairMessages({
      role: 'tool',
      id: 'tool-shot',
      toolName: 'capture_screenshot',
      content: '已捕获截图',
      screenshot: 'iVBOR' + 'A'.repeat(100)
    }, 0, [])
    expect((result.content as any[]).map(block => block.type)).toEqual(['text', 'image'])
    expect((result.content as any[])[1].mimeType).toBe('image/png')
  })

  it('轨迹观测统计包含正文、入参与截图成本，但不改变消息', () => {
    const trail = [{
      role: 'tool',
      toolName: 'read',
      content: 'x'.repeat(400),
      toolArgs: JSON.stringify({ path: '/tmp/a' }),
      screenshot: 'base64'
    }]
    const measured = measureToolTrail(trail)
    expect(measured.count).toBe(1)
    expect(measured.tokens).toBeGreaterThan(1300)
    expect(trail[0].content).toHaveLength(400)
  })
})

describe('模型历史过滤', () => {
  it('只放行已完成的 role:tool；thinking、权限卡和空工具锚点不进入模型', () => {
    expect(shouldSendMessageToModel({
      id: 'tool',
      role: 'tool',
      content: '结果',
      toolName: 'bash',
      timestamp: 0
    } as any)).toBe(true)
    expect(shouldSendMessageToModel({
      id: 'empty',
      role: 'tool',
      content: '',
      toolName: 'bash',
      timestamp: 0
    } as any)).toBe(false)
    expect(shouldSendMessageToModel({
      id: 'thinking',
      role: 'assistant',
      content: '',
      thinkingContent: '内部思考',
      messageKind: 'thinking',
      timestamp: 0
    } as any)).toBe(false)
  })
})

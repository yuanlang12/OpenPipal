import { describe, expect, it } from 'vitest'
import {
  compactSubagentCardData,
  containsReceiptPlaceholder
} from '../../src/main/tool-content-compactor'

describe('tool-content-compactor 仅服务 UI/旧数据防护', () => {
  it('识别旧版本的回执占位，防止模型把占位写回产物', () => {
    expect(containsReceiptPlaceholder('[内容已保存，11390 字符；需要时重新读取]')).toBe(true)
    expect(containsReceiptPlaceholder('<html>[内容已保存，10 字符；…]</html>')).toBe(true)
    expect(containsReceiptPlaceholder('正常作业正文')).toBe(false)
    expect(containsReceiptPlaceholder(undefined)).toBe(false)
  })

  it('subagent 展开卡数据收窄不影响主对话的模型轨迹', () => {
    const source = {
      finalText: '结论'.repeat(1000),
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'T'.repeat(3000) }] },
        {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: '内部推理'.repeat(500) },
            { type: 'text', text: '短回复' },
            { type: 'toolCall', id: 'call-1', name: 'read', arguments: { path: '/tmp/a.md', content: 'x'.repeat(5000) } }
          ]
        },
        {
          role: 'toolResult',
          toolCallId: 'call-1',
          toolName: 'read',
          content: [
            { type: 'text', text: 'R'.repeat(8000) },
            { type: 'image', data: 'B'.repeat(50_000), mimeType: 'image/png' }
          ]
        }
      ]
    }

    const compacted = compactSubagentCardData(source)
    const messages = compacted.messages as any[]
    expect(messages[0].content[0].text).toContain('已截断')
    expect(messages[1].content.map((block: any) => block.type)).toEqual(['text', 'toolCall'])
    expect(messages[2].content[1]).toEqual({ type: 'text', text: '[图片已省略]' })
    expect(compacted.finalText).toContain('已截断')
    // UI 投影不修改原始 child transcript。
    expect(source.messages[1].content).toHaveLength(3)
  })

  it('subagent 卡片消息条数超限时只保留最近一段', () => {
    const messages = Array.from({ length: 80 }, (_, i) => ({
      role: 'assistant',
      content: [{ type: 'text', text: `step-${i}` }]
    }))
    const compacted = compactSubagentCardData({ messages })
    expect(compacted.messages).toHaveLength(60)
    expect((compacted.messages as any[])[0].content[0].text).toBe('step-20')
  })
})

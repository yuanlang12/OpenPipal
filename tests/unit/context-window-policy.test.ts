import { describe, expect, it } from 'vitest'
import {
  MAX_TOOL_RESULT_TOKENS,
  capToolResultText,
  createStableContextTransform,
  estimateContextTextTokens,
  prepareContextForModel
} from '../../src/main/context-window-policy'

function toolResult(toolName: string, text: string, extra: Record<string, unknown> = {}): any {
  return {
    role: 'toolResult',
    toolName,
    toolCallId: `call-${toolName}`,
    content: [{ type: 'text', text }],
    ...extra
  }
}

function assistant(text: string): any {
  return { role: 'assistant', content: [{ type: 'text', text }] }
}

describe('单条工具结果确定性限长', () => {
  it('异常大的结果从第一次进入模型时就保留头尾并限制在预算内', () => {
    const source = `HEAD\n${'x'.repeat(70_000)}\nTAIL`
    const capped = capToolResultText(source)
    expect(capped).toContain('HEAD')
    expect(capped).toContain('TAIL')
    expect(capped).toContain('单条工具结果已确定性限长')
    expect(estimateContextTextTokens(capped)).toBeLessThanOrEqual(MAX_TOOL_RESULT_TOKENS)
  })

  it('短结果逐字节原样返回', () => {
    const source = '读取成功：15分制，6个维度'
    expect(capToolResultText(source)).toBe(source)
  })

  it('同一输入重复投影逐字节一致，不随时间或消息年龄变化', async () => {
    const source = 'a'.repeat(80_000)
    const messages = [toolResult('read', source)]
    const transform = createStableContextTransform()
    const first = await transform(messages)
    const second = await transform([...messages, assistant('我已读取')])

    expect(JSON.stringify(second[0])).toBe(JSON.stringify(first[0]))
    expect((messages[0] as any).content[0].text).toBe(source)
  })

  it('保留非文本块，不因文本限长丢掉工具图片', () => {
    const image = { type: 'image', data: 'A'.repeat(20_000), mimeType: 'image/png' }
    const result = prepareContextForModel([
      toolResult('render_artifact', 'z'.repeat(80_000), {
        content: [
          { type: 'text', text: 'z'.repeat(80_000) },
          image
        ]
      })
    ])
    expect((result[0] as any).content.some((block: any) => block.type === 'image')).toBe(true)
  })
})

describe('不再按消息年龄卸载', () => {
  it('给本地回放的 assistant 消息补零 usage，兼容 Pi 上下文估算', () => {
    const historicalAssistant = assistant('上一轮已完成')
    const projected = prepareContextForModel([
      historicalAssistant,
      { role: 'user', content: [{ type: 'text', text: '继续' }] } as any
    ])

    expect((projected[0] as any).usage).toMatchObject({
      input: 0,
      output: 0,
      totalTokens: 0
    })
    // 原始历史不被改写；只在发往 Pi 的一次性投影中补齐兼容字段。
    expect((historicalAssistant as any).usage).toBeUndefined()
  })

  it('大量后续消息不会改写旧工具结果', async () => {
    const original = toolResult('bash', 'result'.repeat(500))
    const messages = [
      original,
      ...Array.from({ length: 120 }, (_, i) => assistant(`step-${i}`))
    ]
    const result = await createStableContextTransform()(messages)
    expect(result[0]).toBe(original)
  })

  it('工具调用参数保持完整，交给整体 token 压缩统一处理', () => {
    const args = { path: '/tmp/homework.png', rubric: 'r'.repeat(30_000) }
    const toolCall: any = {
      role: 'assistant',
      content: [{ type: 'toolCall', id: 'call-1', name: 'grade', arguments: args }]
    }
    const result = prepareContextForModel([toolCall])
    expect((result[0] as any).content[0].arguments).toEqual(args)
  })

  it('用户图片不属于工具结果，投影完全不碰', () => {
    const userImage: any = {
      role: 'user',
      content: [
        { type: 'image', data: 'B'.repeat(100_000), mimeType: 'image/png' },
        { type: 'text', text: '按图片批改' }
      ]
    }
    expect(prepareContextForModel([userImage])[0]).toBe(userImage)
  })
})

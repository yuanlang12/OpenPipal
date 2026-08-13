import { describe, expect, it } from 'vitest'
import { AsyncQueue } from '../../src/main/agent-runtime/async-queue'
import {
  convertHistoryToPiMessages,
  runtimeInputToPrompt,
  toPiImageBlock
} from '../../src/main/agent-runtime/pi-message-conversion'

describe('shared Agent Runtime primitives', () => {
  it('drains events that were queued before the producer closes', async () => {
    const queue = new AsyncQueue<number>()
    queue.push(1)
    queue.push(2)
    queue.done()

    const received: number[] = []
    for await (const value of queue) received.push(value)
    expect(received).toEqual([1, 2])
  })

  it('wakes a pending consumer when the producer closes', async () => {
    const queue = new AsyncQueue<number>()
    const next = queue[Symbol.asyncIterator]().next()
    queue.done()
    await expect(next).resolves.toEqual({ value: undefined, done: true })
  })

  it.each([
    ['data:image/png;base64,AAAA', 'image/png', 'AAAA'],
    ['iVBORraw', 'image/png', 'iVBORraw'],
    ['R0lGODraw', 'image/gif', 'R0lGODraw'],
    ['UklGRraw', 'image/webp', 'UklGRraw']
  ])('preserves public image semantics for %s', (input, mimeType, data) => {
    expect(toPiImageBlock(input)).toEqual({ type: 'image', mimeType, data })
  })

  it('projects history once and keeps tool calls paired with their result', () => {
    const messages = convertHistoryToPiMessages([
      { role: 'user', content: 'inspect this', images: ['iVBORimage'] },
      { role: 'assistant', content: 'I will read it.' },
      {
        role: 'tool',
        content: '42 lines',
        toolName: 'read',
        toolCallId: 'call-42',
        toolArgs: '{"path":"/tmp/a.ts"}'
      },
      { role: 'user', content: 'continue' }
    ]) as any[]

    expect(messages).toHaveLength(4)
    expect(messages[0].role).toBe('user')
    expect(messages[0].content).toEqual([
      { type: 'image', data: 'iVBORimage', mimeType: 'image/png' },
      { type: 'text', text: 'inspect this' }
    ])
    expect(messages[1].content).toEqual([
      { type: 'text', text: 'I will read it.' },
      { type: 'toolCall', id: 'call-42', name: 'read', arguments: { path: '/tmp/a.ts' } }
    ])
    expect(messages[2]).toMatchObject({
      role: 'toolResult',
      toolCallId: 'call-42',
      toolName: 'read'
    })
    expect(messages[3]).toMatchObject({ role: 'user' })
  })

  it('maps product input to Harness text plus public image blocks', () => {
    expect(runtimeInputToPrompt({ text: '', images: ['R0lGODx'] })).toEqual({
      text: '请分析这些图片',
      images: [{ type: 'image', data: 'R0lGODx', mimeType: 'image/gif' }]
    })
  })
})

import { describe, expect, it } from 'vitest'
import { PiEventAdapter } from '../../src/main/pi-event-adapter'
import { MAX_TOOL_RESULT_TOKENS, estimateContextTextTokens } from '../../src/main/context-window-policy'

function update(type: string, contentIndex: number, block: any, delta = ''): any {
  return {
    type: 'message_update',
    assistantMessageEvent: {
      type,
      contentIndex,
      delta,
      partial: { content: Array.from({ length: contentIndex + 1 }, (_, i) => i === contentIndex ? block : null) }
    }
  }
}

describe('PiEventAdapter 工具调用按 toolCallId 配对', () => {
  it('同一 assistant message 内两个同名 bash 不会串参数和结果', () => {
    const adapter = new PiEventAdapter()
    const starts = [
      ...adapter.adapt(update('toolcall_start', 0, { type: 'toolCall', id: 'call-a', name: 'bash' })),
      ...adapter.adapt(update('toolcall_delta', 0, { type: 'toolCall', id: 'call-a', name: 'bash' }, '{"command":"grep alpha file"}')),
      ...adapter.adapt(update('toolcall_start', 1, { type: 'toolCall', id: 'call-b', name: 'bash' })),
      ...adapter.adapt(update('toolcall_delta', 1, { type: 'toolCall', id: 'call-b', name: 'bash' }, '{"command":"find ./skills"}')),
    ]
    expect(starts.filter((e: any) => e.type === 'tool_start').map((e: any) => e.toolCallId)).toEqual(['call-a', 'call-b'])

    adapter.adapt({ type: 'tool_execution_start', toolCallId: 'call-a', toolName: 'bash', args: { command: 'grep alpha file' } } as any)
    const endA = adapter.adapt({
      type: 'tool_execution_end', toolCallId: 'call-a', toolName: 'bash',
      result: { content: [{ type: 'text', text: 'alpha result' }], details: {} }, isError: false
    } as any).find((e: any) => e.type === 'tool_end') as any

    adapter.adapt({ type: 'tool_execution_start', toolCallId: 'call-b', toolName: 'bash', args: { command: 'find ./skills' } } as any)
    const endB = adapter.adapt({
      type: 'tool_execution_end', toolCallId: 'call-b', toolName: 'bash',
      result: { content: [{ type: 'text', text: 'SKILL.md' }], details: {} }, isError: false
    } as any).find((e: any) => e.type === 'tool_end') as any

    expect(endA.toolCallId).toBe('call-a')
    expect(JSON.parse(endA.mcpArgs).command).toBe('grep alpha file')
    expect(endA.mcpResult).toBe('alpha result')
    expect(endB.toolCallId).toBe('call-b')
    expect(JSON.parse(endB.mcpArgs).command).toBe('find ./skills')
    expect(endB.mcpResult).toBe('SKILL.md')
  })

  it('合法空结果(如 read 读到 0 字节文件)给非空占位,不留空工具卡', () => {
    const adapter = new PiEventAdapter()
    adapter.adapt({ type: 'tool_execution_start', toolCallId: 'call-empty', toolName: 'read', args: { path: '/tmp/empty.md' } } as any)
    const end = adapter.adapt({
      type: 'tool_execution_end', toolCallId: 'call-empty', toolName: 'read',
      result: { content: [{ type: 'text', text: '' }], details: {} }, isError: false
    } as any).find((e: any) => e.type === 'tool_end') as any

    expect(end.toolCallId).toBe('call-empty')
    expect(end.mcpResult).toBe('(无输出)')
  })

  it('跨轮记录保留完整工具入参，只对异常大的单条结果做第一次即固定的头尾限长', () => {
    const adapter = new PiEventAdapter()
    const args = { path: '/tmp/homework.png', rubric: 'R'.repeat(30_000) }
    adapter.adapt({
      type: 'tool_execution_start',
      toolCallId: 'call-long',
      toolName: 'grade',
      args
    } as any)
    const source = `HEAD\n${'x'.repeat(80_000)}\nTAIL`
    const end = adapter.adapt({
      type: 'tool_execution_end',
      toolCallId: 'call-long',
      toolName: 'grade',
      result: { content: [{ type: 'text', text: source }], details: {} },
      isError: false
    } as any).find((event: any) => event.type === 'tool_end') as any

    expect(JSON.parse(end.mcpArgs)).toEqual(args)
    expect(end.mcpResult).toContain('HEAD')
    expect(end.mcpResult).toContain('TAIL')
    expect(end.mcpResult).toContain('单条工具结果已确定性限长')
    expect(estimateContextTextTokens(end.mcpResult)).toBeLessThanOrEqual(MAX_TOOL_RESULT_TOKENS)
  })

  it('子 Agent 的 UI 卡片数据与模型真实入参分开保存，完整结论进入跨轮结果', () => {
    const adapter = new PiEventAdapter()
    const args = { task: '检查六张作业图', profile: 'reviewer' }
    adapter.adapt({
      type: 'tool_execution_start',
      toolCallId: 'call-subagent',
      toolName: 'subagent',
      args
    } as any)
    const finalText = '完整批改结论：' + '细节'.repeat(300)
    const end = adapter.adapt({
      type: 'tool_execution_end',
      toolCallId: 'call-subagent',
      toolName: 'subagent',
      result: {
        content: [{ type: 'text', text: finalText }],
        details: {
          subagent: {
            profileName: 'reviewer',
            task: args.task,
            finalText,
            messages: [{ role: 'assistant', content: finalText }],
            stopReason: 'stop'
          }
        }
      },
      isError: false
    } as any).find((event: any) => event.type === 'tool_end') as any

    expect(JSON.parse(end.modelToolArgs)).toEqual(args)
    expect(JSON.parse(end.mcpArgs).profile).toBe('reviewer')
    expect(end.mcpResult).toBe(finalText)
  })
})

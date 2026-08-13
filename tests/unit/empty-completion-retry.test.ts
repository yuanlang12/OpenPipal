import { describe, expect, it, vi } from 'vitest'
import type { AgentMessage } from '@earendil-works/pi-agent-core'
import {
  isContextOverflowCompletion,
  isEmptySuccessfulAssistantMessage,
  promptWithEmptyCompletionRetry
} from '../../src/main/empty-completion-guard'

function assistant(
  content: Array<Record<string, unknown>>,
  stopReason: 'stop' | 'length' | 'toolUse' | 'error' | 'aborted' = 'stop'
): AgentMessage {
  return {
    role: 'assistant',
    content,
    api: 'openai-responses',
    provider: 'openai',
    model: 'grok-4.5',
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
    },
    stopReason,
    timestamp: Date.now()
  } as AgentMessage
}

const userMessage = {
  role: 'user',
  content: [{ type: 'text', text: '完成这个任务' }],
  timestamp: 1
} as AgentMessage

class FakeAgent {
  state: { messages: AgentMessage[] } = { messages: [] }
  prompts: AgentMessage[] = []

  constructor(private readonly replies: AgentMessage[]) {}

  async prompt(message: AgentMessage): Promise<void> {
    this.prompts.push(message)
    this.state.messages.push(message)
    const reply = this.replies.shift()
    if (reply) this.state.messages.push(reply)
  }
}

describe('空完成自动续跑', () => {
  it('thinking-only 或空 content 视为空完成', () => {
    expect(isEmptySuccessfulAssistantMessage(assistant([
      { type: 'thinking', thinking: '我需要先检查' }
    ]))).toBe(true)
    expect(isEmptySuccessfulAssistantMessage(assistant([]))).toBe(true)
    expect(isEmptySuccessfulAssistantMessage(assistant([
      { type: 'text', text: '   ' }
    ]))).toBe(true)
  })

  it('有正文或 toolCall 时不误判，error/aborted 交给原错误链路', () => {
    expect(isEmptySuccessfulAssistantMessage(assistant([
      { type: 'thinking', thinking: '思考' },
      { type: 'text', text: '已完成' }
    ]))).toBe(false)
    expect(isEmptySuccessfulAssistantMessage(assistant([
      { type: 'toolCall', id: 't1', name: 'read', arguments: {} }
    ], 'toolUse'))).toBe(false)
    expect(isEmptySuccessfulAssistantMessage(assistant([], 'error'))).toBe(false)
    expect(isEmptySuccessfulAssistantMessage(assistant([], 'aborted'))).toBe(false)
  })

  it('第一次只有思考时自动追加内部提示，第二次有正文则成功', async () => {
    const agent = new FakeAgent([
      assistant([{ type: 'thinking', thinking: '先分析' }]),
      assistant([{ type: 'text', text: '最终答复' }])
    ])
    const onRetry = vi.fn()

    const result = await promptWithEmptyCompletionRetry(agent, userMessage, { onRetry })

    expect(result).toEqual({ retried: true, stillEmpty: false })
    expect(agent.prompts).toHaveLength(2)
    expect((agent.prompts[1] as any).content[0].text).toContain('不要再只返回思考')
    expect(onRetry).toHaveBeenCalledTimes(1)

    // 续跑成功后内部脚手架从 agent 状态拆除：goal-loop 后续请求与 GoalChecker
    // 只看到 [user(原始), assistant(有效回复)]，注入提示不再被永久复读
    expect(agent.state.messages).toHaveLength(2)
    expect((agent.state.messages[0] as any).content[0].text).toBe('完成这个任务')
    expect((agent.state.messages[1] as any).content[0].text).toBe('最终答复')
    expect(JSON.stringify(agent.state.messages)).not.toContain('自动续跑')
  })

  it('自动续跑后仍只有思考时返回 stillEmpty，不无限重试', async () => {
    const agent = new FakeAgent([
      assistant([{ type: 'thinking', thinking: '第一次' }]),
      assistant([{ type: 'thinking', thinking: '第二次' }])
    ])

    const result = await promptWithEmptyCompletionRetry(agent, userMessage)

    expect(result).toEqual({ retried: true, stillEmpty: true })
    expect(agent.prompts).toHaveLength(2)
    // 仍为空时不做状态清理——错误链路要靠现场诊断（此时本轮通常以 error 结束）
    expect(agent.state.messages).toHaveLength(4)
  })

  it('首次已有正文时不增加额外请求', async () => {
    const agent = new FakeAgent([assistant([{ type: 'text', text: '正常回复' }])])

    const result = await promptWithEmptyCompletionRetry(agent, userMessage)

    expect(result).toEqual({ retried: false, stillEmpty: false })
    expect(agent.prompts).toHaveLength(1)
  })
})

describe('上下文溢出分型与自愈', () => {
  // 溢出指纹：length 截停 + 输出只有个位数 token（max_tokens 被夹到贴地）+ 实报载荷巨大
  const overflowReply = (output = 2): AgentMessage => ({
    role: 'assistant',
    content: [{ type: 'thinking', thinking: '…' }],
    api: 'openai-completions',
    provider: 'custom',
    model: 'ds-flash',
    usage: {
      input: 300,
      output,
      cacheRead: 129_000,
      cacheWrite: 0,
      totalTokens: 129_302,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
    },
    stopReason: 'length',
    timestamp: Date.now()
  } as AgentMessage)

  it('length+近零输出判定为溢出；大输出靠载荷占窗口比例兜底；非 length 一律不算', () => {
    expect(isContextOverflowCompletion(overflowReply(2))).toBe(true)
    expect(isContextOverflowCompletion(overflowReply(2000))).toBe(false)
    expect(isContextOverflowCompletion(overflowReply(2000), 131_072)).toBe(true)
    expect(isContextOverflowCompletion(assistant([], 'stop'))).toBe(false)
  })

  it('溢出时走压缩自愈而不是续跑提示，重试成功后不置位 overflow', async () => {
    const agent = new FakeAgent([
      overflowReply(),
      assistant([{ type: 'text', text: '压缩后完成' }])
    ])
    const rebuiltUser = { role: 'user', content: [{ type: 'text', text: '当前问题' }], timestamp: 2 } as AgentMessage
    const onOverflowRecover = vi.fn(async () => {
      // 模拟宿主：整体重建 agent 状态为压缩投影，返回要重试的末条 user 消息
      agent.state.messages.length = 0
      agent.state.messages.push({ role: 'user', content: [{ type: 'text', text: '【前情提要】…' }], timestamp: 1 } as AgentMessage)
      return rebuiltUser
    })
    const onRetry = vi.fn()

    const result = await promptWithEmptyCompletionRetry(agent, userMessage, {
      onRetry,
      contextWindow: 131_072,
      onOverflowRecover
    })

    expect(result).toEqual({ retried: true, stillEmpty: false })
    expect(onOverflowRecover).toHaveBeenCalledTimes(1)
    expect(onRetry).toHaveBeenCalledTimes(1)
    expect(agent.prompts).toHaveLength(2)
    expect(agent.prompts[1]).toBe(rebuiltUser)
    expect(JSON.stringify(agent.prompts)).not.toContain('自动续跑')
  })

  it('压不动时不再盲目续跑，返回 overflow 让上层报真话', async () => {
    const agent = new FakeAgent([overflowReply()])

    const result = await promptWithEmptyCompletionRetry(agent, userMessage, {
      contextWindow: 131_072,
      onOverflowRecover: vi.fn(async () => null)
    })

    expect(result).toEqual({ retried: false, stillEmpty: true, overflow: true })
    expect(agent.prompts).toHaveLength(1)
  })

  it('普通空完成（stopReason=stop）不触发自愈，仍走续跑提示', async () => {
    const agent = new FakeAgent([
      assistant([{ type: 'thinking', thinking: '只想不说' }]),
      assistant([{ type: 'text', text: '好了' }])
    ])
    const onOverflowRecover = vi.fn(async () => null)

    const result = await promptWithEmptyCompletionRetry(agent, userMessage, {
      contextWindow: 131_072,
      onOverflowRecover
    })

    expect(result).toEqual({ retried: true, stillEmpty: false })
    expect(onOverflowRecover).not.toHaveBeenCalled()
    expect((agent.prompts[1] as any).content[0].text).toContain('自动续跑')
  })
})

import { beforeEach, describe, expect, it, vi } from 'vitest'

const conversationStore = vi.hoisted(() => ({
  getConversation: vi.fn(),
  updateConversationConfig: vi.fn(async () => true)
}))

vi.mock('../../src/main/simple-completion', () => ({
  simpleComplete: vi.fn(async () => '【目标】继续完成任务\n【已完成】已读取原始资料\n【未决事项】继续处理')
}))

vi.mock('../../src/main/conversation-store', () => conversationStore)

import { simpleComplete } from '../../src/main/simple-completion'
import {
  compactHistoryForModel,
  digestHistoryPrefix,
  estimateHistoryMessageTokens,
  getContextBudget,
  recordMeasuredPromptTokens,
  serializeForSummary
} from '../../src/main/history-compactor'

const user = (content: string, extra: Record<string, unknown> = {}): any => ({ role: 'user', content, ...extra })
const assistant = (content: string): any => ({ role: 'assistant', content })
const tool = (name: string, args: unknown, content: string): any => ({
  role: 'tool',
  toolName: name,
  toolCallId: `call-${name}`,
  toolArgs: JSON.stringify(args),
  content
})

describe('history-compactor 统一 token 阈值', () => {
  beforeEach(() => {
    vi.mocked(simpleComplete).mockClear()
    conversationStore.getConversation.mockReset()
    conversationStore.updateConversationConfig.mockClear()
  })

  it('低上下文模型的历史预算不会被固定下限抬高到超过真实窗口', () => {
    expect(getContextBudget({ contextWindow: 32_000 })).toEqual({ contextWindow: 32_000, budget: 16_000 })
    expect(getContextBudget({ contextWindow: 8_000 })).toEqual({ contextWindow: 8_000, budget: 4_000 })
  })

  it('消息很多但 token 很少时完全不压缩', async () => {
    const history = Array.from({ length: 200 }, (_, i) =>
      i % 2 === 0 ? user(`q${i}`) : assistant(`a${i}`)
    )
    const result = await compactHistoryForModel(history, undefined, { contextWindow: 40_000 })
    expect(result).toBe(history)
    expect(simpleComplete).not.toHaveBeenCalled()
  })

  it('工具入参与结果计入同一总预算，越线后才整体摘要', async () => {
    const huge = 'R'.repeat(55_000)
    const history = [
      user('开始任务'),
      tool('read', { path: '/tmp/a', query: huge }, huge),
      assistant('已读取第一份'),
      user('继续'),
      tool('bash', { command: huge }, huge),
      assistant('已执行'),
      user('现在做最终处理'),
      assistant('准备完成')
    ]

    const result = await compactHistoryForModel(history, undefined, { contextWindow: 40_000 })
    expect(result).not.toBe(history)
    expect(result[0].content).toContain('前情提要')
    expect(simpleComplete).toHaveBeenCalledTimes(1)
    const prompt = vi.mocked(simpleComplete).mock.calls[0][0].prompt
    expect(prompt).toContain('工具 read')
    expect(prompt).toContain('[工具入参]')
    expect(prompt).toContain('[工具结果]')
  })

  it('最近保留区的工具参数和图片仍是原文，不再二次卸载', async () => {
    const old = 'O'.repeat(100_000)
    const recentImage = 'data:image/png;base64,abc'
    const recentTool = tool('grade', { rubric: '15分6维度' }, '批改结果原文')
    const history = [
      user('旧问题'),
      assistant(old),
      user('旧问题2'),
      assistant(old),
      user('看这张作业图', { images: [recentImage] }),
      recentTool,
      assistant('我看到了'),
      user('继续按原图检查')
    ]

    const result = await compactHistoryForModel(history, undefined, { contextWindow: 40_000 })
    expect(result[0].content).toContain('前情提要')
    const keptImage = result.find(message => message.content === '看这张作业图')
    const keptTool = result.find(message => message.role === 'tool' && message.toolName === 'grade')
    expect(keptImage?.images).toEqual([recentImage])
    expect(keptTool?.toolArgs).toBe(recentTool.toolArgs)
    expect(keptTool?.content).toBe('批改结果原文')
  })

  it('编辑已摘要的同条数历史会失效缓存，并继续使用该会话自己的模型配置来重摘', async () => {
    const modelConfig = {
      provider: 'custom',
      baseUrl: 'https://example.invalid/v1',
      apiKey: 'session-only-key',
      model: 'session-model',
      contextWindow: 40_000
    }
    const history = [
      user('最早的问题'),
      assistant('A'.repeat(50_000)),
      user('第二个问题'),
      assistant('B'.repeat(50_000)),
      user('当前问题'),
      assistant('当前回答')
    ]
    conversationStore.getConversation.mockReturnValue({
      config: {
        historyCompaction: {
          summary: '旧摘要',
          coveredCount: 2,
          coveredDigest: digestHistoryPrefix(history, 2)
        }
      }
    })

    await compactHistoryForModel(history, 'conversation-1', modelConfig)
    expect(simpleComplete).not.toHaveBeenCalled()

    const edited = [...history]
    edited[1] = assistant('C'.repeat(50_000))
    await compactHistoryForModel(edited, 'conversation-1', modelConfig)

    expect(simpleComplete).toHaveBeenCalledTimes(1)
    expect(vi.mocked(simpleComplete).mock.calls[0][0].modelConfig).toBe(modelConfig)
    expect(conversationStore.updateConversationConfig).toHaveBeenCalledWith(
      'conversation-1',
      expect.objectContaining({
        historyCompaction: expect.objectContaining({
          coveredDigest: digestHistoryPrefix(edited, 2)
        })
      })
    )
  })
})

describe('证据式预算锚点与强制压缩', () => {
  beforeEach(() => {
    vi.mocked(simpleComplete).mockClear()
    conversationStore.getConversation.mockReset()
    conversationStore.updateConversationConfig.mockClear()
  })

  it('估算未越线但上一轮实报载荷超预算时按实测触发压缩，且锚点不跨模型沿用', async () => {
    const big = 'A'.repeat(40_000) // ~10k token/条，总估算 ~30k，远低于 131k 窗口的 99k 预算
    const history = [
      user('第一问'), assistant(big),
      user('第二问'), assistant(big),
      user('第三问'), assistant(big),
      user('当前问题'), assistant('好的')
    ]
    const mc: any = { model: 'ds-flash', contextWindow: 131_072 }

    // 控制组：无锚点 → 估算不越线 → 不压缩
    expect(await compactHistoryForModel(history, 'conv-anchor-1', mc)).toBe(history)

    // 换了模型的旧锚点不作数（分词器不同）
    recordMeasuredPromptTokens('conv-anchor-1', 'other-model', 120_000)
    expect(await compactHistoryForModel(history, 'conv-anchor-1', mc)).toBe(history)

    // 同模型实测 120k > 预算 99k → 估算沉默也要压
    recordMeasuredPromptTokens('conv-anchor-1', 'ds-flash', 120_000)
    const result = await compactHistoryForModel(history, 'conv-anchor-1', mc)
    expect(result).not.toBe(history)
    expect(result[0].content).toContain('前情提要')
  })

  it('force 模式绕过阈值直接压缩（溢出自愈用）', async () => {
    const big = 'B'.repeat(40_000)
    const history = [user('q1'), assistant(big), user('q2'), assistant(big), user('q3'), assistant('ok')]
    const result = await compactHistoryForModel(history, undefined, { contextWindow: 131_072 } as any, { force: true })
    expect(result).not.toBe(history)
    expect(result[0].content).toContain('前情提要')
  })

  it('force 遇到极短会话仍原样返回——自愈方据引用相等判定压不动', async () => {
    const history = [user('q'), assistant('a')]
    expect(await compactHistoryForModel(history, undefined, undefined, { force: true })).toBe(history)
  })

  it('cancels an in-flight summary through the caller signal', async () => {
    const controller = new AbortController()
    vi.mocked(simpleComplete).mockImplementationOnce(async ({ signal }) =>
      await new Promise<string>((resolve) => {
        const finish = () => resolve('must-not-be-used')
        if (signal?.aborted) finish()
        else signal?.addEventListener('abort', finish, { once: true })
      })
    )
    const history = [
      user('one'),
      assistant('A'.repeat(40_000)),
      user('two'),
      assistant('B'.repeat(40_000)),
      user('three'),
      assistant('C'.repeat(40_000))
    ]

    const compacting = compactHistoryForModel(
      history,
      undefined,
      { contextWindow: 40_000 },
      { force: true, signal: controller.signal }
    )
    for (let attempt = 0; attempt < 20 && vi.mocked(simpleComplete).mock.calls.length === 0; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 1))
    }
    controller.abort()

    await expect(compacting).rejects.toThrow('summarize aborted')
    expect(vi.mocked(simpleComplete).mock.calls[0][0].signal).toBe(controller.signal)
  })
})

describe('压缩估算与摘要取材', () => {
  it('图片的 screenshot 兼容字段不与 images 重复计数', () => {
    const one = estimateHistoryMessageTokens(user('x', { images: ['a'], screenshot: 'a' }))
    const two = estimateHistoryMessageTokens(user('x', { images: ['a', 'b'], screenshot: 'a' }))
    expect(two - one).toBe(1200)
  })

  it('摘要取材明确标记工具名、入参和结果，并仅在摘要请求中收窄超长工具字段', () => {
    const text = serializeForSummary([
      tool('read', { path: '/tmp/a.md', payload: 'x'.repeat(5000) }, 'y'.repeat(5000))
    ])
    expect(text).toContain('工具 read')
    expect(text).toContain('/tmp/a.md')
    expect(text).toContain('[工具结果]')
    expect(text).toContain('压缩摘要取材时省略')
  })
})

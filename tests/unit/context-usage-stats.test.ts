import { describe, expect, it } from 'vitest'
import {
  buildContextUsageSegments,
  estimateTextTokens,
  estimateToolTokens,
  isMcpToolName
} from '../../src/main/context-usage-stats'
import { estimateTokens } from '../../src/main/history-compactor'

describe('context-usage-stats', () => {
  it('估算公式与 history-compactor.estimateTokens 逐字节同口径（防两处漂移）', () => {
    const samples = ['', 'plain ascii text 123', '中文混排 English 混排', '混合123 abc！@#', 'a'.repeat(1000)]
    for (const text of samples) {
      expect(estimateTextTokens(text)).toBe(estimateTokens(text))
    }
  })

  it('MCP 工具命名识别：mcp_execute 网关与 mcp: 前缀', () => {
    expect(isMcpToolName('mcp_execute')).toBe(true)
    expect(isMcpToolName('mcp:server:tool')).toBe(true)
    expect(isMcpToolName('read')).toBe(false)
    expect(isMcpToolName(undefined)).toBe(false)
  })

  it('工具 schema 估算随定义单调增长，空列表为 0', () => {
    expect(estimateToolTokens([])).toBe(0)
    const small = estimateToolTokens([{ name: 'read', description: 'a', parameters: { type: 'object' } }])
    const big = estimateToolTokens([{ name: 'read', description: 'a'.repeat(200), parameters: { type: 'object', properties: { a: { type: 'string', description: 'x'.repeat(100) } } } }])
    expect(big).toBeGreaterThan(small)
  })

  it('分区：system 不含技能段；messages 为扣减余量且 clamp 到 0', () => {
    const segs = buildContextUsageSegments({
      promptTokens: 10_000,
      systemPromptTokens: 3_000,
      skillTokens: 800,
      builtinToolTokens: 1_200,
      mcpToolTokens: 300
    })
    expect(segs).toEqual({
      systemPrompt: 2_200,
      skills: 800,
      toolsBuiltin: 1_200,
      toolsMcp: 300,
      messages: 10_000 - 3_000 - 1_200 - 300
    })

    // 估算偏大（system+tools 之和超过实报）时消息桶不出现负数
    const clamped = buildContextUsageSegments({
      promptTokens: 1_000,
      systemPromptTokens: 900,
      skillTokens: 0,
      builtinToolTokens: 500,
      mcpToolTokens: 0
    })
    expect(clamped.messages).toBe(0)
    expect(clamped.systemPrompt).toBe(900)
  })
})

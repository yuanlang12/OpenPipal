import { describe, expect, it } from 'vitest'
import {
  buildContextUsageSegments,
  buildSegmentBaseline,
  isMcpToolName
} from '../../src/main/context-usage-stats'
import { estimateTokens } from '../../src/main/token-estimate'

describe('context-usage-stats', () => {
  it('MCP 工具命名识别：mcp_execute 网关与 mcp: 前缀', () => {
    expect(isMcpToolName('mcp_execute')).toBe(true)
    expect(isMcpToolName('mcp:server:tool')).toBe(true)
    expect(isMcpToolName('read')).toBe(false)
    expect(isMcpToolName(undefined)).toBe(false)
  })

  it('基线：文本走 history-compactor 同一个估算器，工具按 MCP/内置分桶', () => {
    const systemPrompt = '系统提示词 system prompt 正文'
    const skillSection = '技能段 skills'
    const baseline = buildSegmentBaseline({
      systemPrompt,
      skillSection,
      tools: [
        { name: 'read', description: 'a', parameters: { type: 'object' } },
        { name: 'mcp_execute', description: 'gateway', parameters: { type: 'object' } },
        { name: 'mcp:server:tool', description: 'remote', parameters: { type: 'object' } }
      ]
    })
    expect(baseline.systemPromptTokens).toBe(estimateTokens(systemPrompt))
    expect(baseline.skillTokens).toBe(estimateTokens(skillSection))
    expect(baseline.builtinToolTokens).toBeGreaterThan(0)
    expect(baseline.mcpToolTokens).toBeGreaterThan(baseline.builtinToolTokens)
  })

  it('基线：工具估算随 schema 增长，空工具列表为 0', () => {
    const empty = buildSegmentBaseline({ systemPrompt: '', skillSection: '', tools: [] })
    expect(empty).toEqual({ systemPromptTokens: 0, skillTokens: 0, builtinToolTokens: 0, mcpToolTokens: 0 })
    const small = buildSegmentBaseline({ systemPrompt: '', skillSection: '', tools: [{ name: 'read', description: 'a', parameters: { type: 'object' } }] })
    const big = buildSegmentBaseline({ systemPrompt: '', skillSection: '', tools: [{ name: 'read', description: 'a'.repeat(200), parameters: { type: 'object', properties: { a: { type: 'string', description: 'x'.repeat(100) } } } }] })
    expect(big.builtinToolTokens).toBeGreaterThan(small.builtinToolTokens)
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

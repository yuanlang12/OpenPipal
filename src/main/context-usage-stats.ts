/**
 * context_usage 事件的载荷分区估算 —— 用量信息卡（输入框圆环 hover 展开）的数据源。
 *
 * 口径纪律：
 * - 总量（promptTokens）一律用服务商实报值，不用估算——实报免费且精确；
 * - 分区只是展示用的近似：system prompt / 技能段 / 工具 schema 在组装期各
 *   估算一次（字符口径，直接复用 token-estimate.estimateTokens），messages
 *   = 实报总量 - 其余各项，clamp 到 0（估算偏大时不出现负数）；
 * - 估算只在回合组装期做一次，不挂在每次请求/渲染帧上重复算——这是这张卡
 *   对运行时性能"无可感知影响"的前提（见注释尾部的成本注记）。
 *
 * 成本注记：131k token 窗口 ≈ 500KB 字符；一次线性扫描在毫秒级，相对一次
 * 网络往返（秒级）不可见。工具 schema 的 JSON 序列化与 [Payload] 观测钩子
 * 的哈希计算同量级（KB 级字符串），同样不可见。
 */
import { estimateTokens } from './token-estimate'

export interface ToolLike {
  name?: string
  description?: string
  parameters?: unknown
}

/** mcp_execute 网关（pi-mcp-bridge 的单一入口）与 mcp: 前缀工具都算 MCP 桶。 */
export function isMcpToolName(name: string | undefined): boolean {
  return name === 'mcp_execute' || (!!name && name.startsWith('mcp:'))
}

function estimateToolTokens(tools: ToolLike[]): number {
  if (!tools?.length) return 0
  return estimateTokens(JSON.stringify(tools))
}

export interface ContextUsageSegments {
  systemPrompt: number
  skills: number
  toolsBuiltin: number
  toolsMcp: number
  messages: number
}

export interface ContextSegmentBaseline {
  systemPromptTokens: number
  skillTokens: number
  builtinToolTokens: number
  mcpToolTokens: number
}

/**
 * 组装期的一次性基线估算——两个运行时共用同一份分桶策略（什么算内置、什么算 MCP、
 * 技能段是否计在系统提示词内），策略只有这一处实现，两边不会各自漂移。
 */
export function buildSegmentBaseline(input: {
  systemPrompt: string
  skillSection: string
  tools: ToolLike[]
}): ContextSegmentBaseline {
  const isMcp = (tool: ToolLike): boolean => isMcpToolName(tool.name)
  return {
    systemPromptTokens: estimateTokens(input.systemPrompt),
    skillTokens: estimateTokens(input.skillSection),
    builtinToolTokens: estimateToolTokens(input.tools.filter(t => !isMcp(t))),
    mcpToolTokens: estimateToolTokens(input.tools.filter(isMcp))
  }
}

/**
 * 分区 = {systemPrompt(不含技能段), skills, toolsBuiltin, toolsMcp, messages(余额)}。
 * systemPromptTokens 是含技能段的完整系统提示词长度；messages 是扣减后的余量，
 * 包含真实对话、工具轨迹与图片 token——实报与估算的偏差最终都落在这个桶里。
 */
export function buildContextUsageSegments(
  input: ContextSegmentBaseline & { promptTokens: number }
): ContextUsageSegments {
  return {
    systemPrompt: Math.max(0, input.systemPromptTokens - input.skillTokens),
    skills: input.skillTokens,
    toolsBuiltin: input.builtinToolTokens,
    toolsMcp: input.mcpToolTokens,
    messages: Math.max(
      0,
      input.promptTokens - input.systemPromptTokens - input.builtinToolTokens - input.mcpToolTokens
    )
  }
}

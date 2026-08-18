/**
 * context_usage 事件的载荷分区估算 —— 用量信息卡（输入框圆环 hover 展开）的数据源。
 *
 * 口径纪律：
 * - 总量（promptTokens）一律用服务商实报值，不用估算——实报免费且精确；
 * - 分区只是展示用的近似：system prompt / 技能段 / 工具 schema 在组装期各
 *   估算一次（字符口径，与 history-compactor.estimateTokens 同公式），messages
 *   = 实报总量 - 其余各项，clamp 到 0（估算偏大时不出现负数）；
 * - 估算只在回合组装期做一次，不挂在每次请求/渲染帧上重复算——这是这张卡
 *   对运行时性能"无可感知影响"的前提（见注释尾部的成本注记）。
 *
 * 成本注记：131k token 窗口 ≈ 500KB 字符；一次线性扫描在毫秒级，相对一次
 * 网络往返（秒级）不可见。工具 schema 的 JSON 序列化与 [Payload] 观测钩子
 * 的哈希计算同量级（KB 级字符串），同样不可见。
 */

/** 与 history-compactor.estimateTokens 逐字节同公式；单测钉住两者不漂移。 */
function estimateTokensLocal(text: string): number {
  if (!text) return 0
  let ascii = 0
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) < 128) ascii++
  }
  const nonAscii = text.length - ascii
  return Math.ceil(ascii / 4 + nonAscii / 1.6)
}

export interface ToolLike {
  name?: string
  description?: string
  parameters?: unknown
}

/** mcp_execute 网关（pi-mcp-bridge 的单一入口）与 mcp: 前缀工具都算 MCP 桶。 */
export function isMcpToolName(name: string | undefined): boolean {
  return name === 'mcp_execute' || (!!name && name.startsWith('mcp:'))
}

export function estimateToolTokens(tools: ToolLike[]): number {
  if (!tools?.length) return 0
  return estimateTokensLocal(JSON.stringify(tools))
}

export interface ContextUsageSegments {
  systemPrompt: number
  skills: number
  toolsBuiltin: number
  toolsMcp: number
  messages: number
}

export function estimateTextTokens(text: string): number {
  return estimateTokensLocal(text)
}

/**
 * 分区 = {systemPrompt(不含技能段), skills, toolsBuiltin, toolsMcp, messages(余额)}。
 * systemPromptTokens 是含技能段的完整系统提示词长度；messages 是扣减后的余量，
 * 包含真实对话、工具轨迹与图片 token——实报与估算的偏差最终都落在这个桶里。
 */
export function buildContextUsageSegments(input: {
  promptTokens: number
  systemPromptTokens: number
  skillTokens: number
  builtinToolTokens: number
  mcpToolTokens: number
}): ContextUsageSegments {
  const skills = Math.max(0, input.skillTokens)
  const systemPrompt = Math.max(0, input.systemPromptTokens - skills)
  const messages = Math.max(
    0,
    input.promptTokens - input.systemPromptTokens - input.builtinToolTokens - input.mcpToolTokens
  )
  return {
    systemPrompt,
    skills,
    toolsBuiltin: Math.max(0, input.builtinToolTokens),
    toolsMcp: Math.max(0, input.mcpToolTokens),
    messages
  }
}

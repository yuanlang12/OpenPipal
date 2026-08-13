/**
 * Realtime Voice — Tool Bridge
 *
 * 把 OpenPipal 的 pi-tools 接入 Realtime API 的 function calling：
 *   1. buildVoiceToolSchemas(): 把 pi 工具转成 OpenAI Realtime tools schema
 *      （注入 session.update.tools，让模型知道它能调用什么）
 *   2. executeVoiceTool(name, argsJson): 收到 function_call 后真正执行工具
 *   3. 截断策略：保护 voice context 不被大结果吃光
 *
 * 关键设计：
 *   - 复用现有 pi-tools / role-manager 完整链路（不重复造轮子）
 *   - Voice 模式排除阻塞性 / 复杂面板工具（ask_user / questions_v2）
 *   - Artifact 类工具只回 ack —— 真实内容已经在 chat 面板，不喂回 voice context
 */

import { homedir } from 'os'
import { join } from 'path'
import type { AgentTool } from '@earendil-works/pi-agent-core'
import { buildPiTools, AskUserResolver } from './pi-tools'
import { buildMcpBridgeTools } from './pi-mcp-bridge'
import { readToolsConfig } from './agent-workspace-store'
import { resolveAgentOverrides, resolveExecutionRoleName } from './agent-overrides'
import { truncateForVoice, ARTIFACT_TOOLS, MAX_VOICE_RESULT_CHARS } from './voice-tool-truncate'
import { dataPath } from './data-root'
import { authorizeToolCall } from './pi-security'

/** 语音工具组装上下文 —— 与文字模式 agentChat 同源（结构兼容 realtime-session 的 VoiceSessionContext） */
export interface VoiceToolContext {
  conversationId?: string
  agentId?: string
  workspaceId?: string
  conversationConfig?: any
  /** Captured when the voice session first composes tools. */
  roleName?: string
}

/** OpenAI Realtime API 的工具 schema 格式 */
export interface RealtimeToolSchema {
  type: 'function'
  name: string
  description: string
  parameters: any
}

/** Voice 模式排除的工具 —— 这些工具不适合实时语音对话：
 *   - ask_user / questions_v2: 阻塞性 + 复杂面板，voice 自己走 turn detection
 *   - subagent: 长任务延迟太高，voice 体验差
 */
const VOICE_INCOMPATIBLE_TOOLS = new Set([
  'ask_user',
  'questions_v2',
  'subagent'
])

/**
 * 组装语音模式的完整工具集 —— 与文字模式 agentChat 的 allTools 对齐：
 *   内置工具(按角色白名单过滤) + MCP 网关(mcp_execute，含 classin 等)。
 * 语音 = 同一个 agent 换语音输入，工具能力完全复用，含 Agent 文件夹(workspaceId)的 tools/config.json。
 */
interface VoiceToolGraph {
  tools: AgentTool[]
  workspaceId?: string
  workingDir: string
}

function getVoiceToolGraph(ctx?: VoiceToolContext): VoiceToolGraph {
  // Voice 是一条独立入口，因此在每次组装/执行工具时从会话捕获角色快照。
  // 有 conversationId 时与文字 Runtime 同源；无会话的临时语音才由
  // buildPiTools 在同步组装期捕获 UI 默认角色作兼容回退。
  let executionOverrides: ReturnType<typeof resolveAgentOverrides>
  try {
    executionOverrides = resolveAgentOverrides({
      agentId: ctx?.agentId,
      workspaceId: ctx?.workspaceId,
      conversationConfig: ctx?.conversationConfig,
      conversationId: ctx?.conversationId
    })
  } catch (err: any) {
    console.warn('[VoiceTools] 会话角色快照解析失败，回退到组装期 UI 默认角色:', err?.message)
  }
  const roleName = ctx?.roleName || executionOverrides?.roleName || resolveExecutionRoleName({
    conversationId: ctx?.conversationId
  })
  if (ctx && !ctx.roleName) ctx.roleName = roleName

  // 与 agentChat 同源：workspaceId → tools/config.json（MCP server 列表 + workingDir）
  const workspaceId = executionOverrides?.workspaceId || ctx?.workspaceId
  const toolsCfg = workspaceId ? readToolsConfig(workspaceId) : undefined
  const globalWs = dataPath('workspace')
  const workingDir = executionOverrides?.workingDir || toolsCfg?.workingDir || globalWs

  // 内置工具（source='desktop': voice 仅桌面）按角色白名单过滤
  const builtin = buildPiTools('desktop', new AskUserResolver(), {
    tools: executionOverrides?.tools,
    roleName,
    roleBrief: executionOverrides?.roleBrief,
    workingDir,
    workspaceId,
    conversationId: ctx?.conversationId,
    disabledTools: toolsCfg?.disabledTools
  }).filter((t) => {
    return !VOICE_INCOMPATIBLE_TOOLS.has(t.name)
  })
  // MCP 网关：用 workspace 的 mcpServers 过滤（与文字模式一致），无 MCP 时返回 []
  const mcp = buildMcpBridgeTools(toolsCfg?.mcpServers, ctx?.conversationId)
  return {
    tools: [...builtin, ...mcp],
    workspaceId,
    workingDir,
  }
}

/**
 * 构建 Voice 模式的工具 schema 数组（喂给 session.update.tools）
 */
export function buildVoiceToolSchemas(ctx?: VoiceToolContext): RealtimeToolSchema[] {
  return getVoiceToolGraph(ctx).tools.map((t) => ({
    type: 'function',
    name: t.name,
    description: t.description || '',
    // TypeBox 的 schema 对象本身就是 JSON Schema 兼容，直接透传
    parameters: t.parameters as any
  }))
}

export interface VoiceToolExecResult {
  /** 截断/格式化后的字符串，作为 function_call_output 写回 realtime session（给模型看） */
  output: string
  /** 原始 AgentToolResult —— 供 UI 侧 emit artifact/visualizer 渲染（给用户看） */
  raw: any | null
}

/**
 * 执行一次 voice tool call
 * @param name 工具名
 * @param argsJson 来自 response.function_call_arguments.done 的 arguments 字符串
 * @returns { output: 给模型的截断文本, raw: 原始结果供 UI 渲染 }
 */
export async function executeVoiceTool(name: string, argsJson: string, ctx?: VoiceToolContext): Promise<VoiceToolExecResult> {
  const graph = getVoiceToolGraph(ctx)
  const tools = graph.tools
  const tool = tools.find((t) => t.name === name)
  if (!tool) {
    return { output: JSON.stringify({ error: `Unknown or unavailable tool in voice mode: ${name}` }), raw: null }
  }

  let args: any
  try {
    args = argsJson ? JSON.parse(argsJson) : {}
  } catch {
    return { output: JSON.stringify({ error: `Invalid JSON args for ${name}` }), raw: null }
  }

  try {
    // This is the final execution sink shared by every realtime provider.
    // Authorize the exact same parsed object that is handed to execute():
    // browser authorization binds its concrete tab/host to object identity,
    // so reparsing after a confirmation wait would discard that binding.
    const authorization = await authorizeToolCall(name, args, {
      conversationId: ctx?.conversationId,
      scope: {
        workspaceId: graph.workspaceId,
        workingDir: graph.workingDir,
      },
    })
    if (authorization?.block) {
      return {
        output: JSON.stringify({
          error: authorization.reason || `Tool execution was not authorized: ${name}`,
        }),
        raw: null,
      }
    }
    const result = await tool.execute(`voice-${Date.now()}`, args)
    return { output: truncateForVoice(name, result), raw: result }
  } catch (err: any) {
    return { output: JSON.stringify({ error: err?.message || 'Tool execution failed' }), raw: null }
  }
}

// 导出常量供调试/集成层使用（已抽到 voice-tool-truncate.ts 测试）
export const _internals = {
  VOICE_INCOMPATIBLE_TOOLS,
  ARTIFACT_TOOLS,
  MAX_VOICE_RESULT_CHARS
}

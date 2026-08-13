import type {
  AfterToolCallContext,
  AfterToolCallResult,
  AgentEvent as PiAgentEvent,
  AgentHarnessTool,
  AgentTool,
  BeforeToolCallContext,
  BeforeToolCallResult
} from '@earendil-works/pi-agent-core'
import {
  authorizeToolCall,
  type ToolAuthorizationOptions
} from '../pi-security'

export function toSequentialHarnessTool<TContext extends object | undefined = undefined>(
  tool: AgentTool
): AgentHarnessTool<TContext> {
  return {
    ...tool,
    executionMode: 'sequential',
    execute(toolCallId, params, signal, onUpdate) {
      return tool.execute(toolCallId, params, signal, onUpdate)
    }
  }
}

/** Preserve a native Harness tool's context-aware execute function. */
export function forceSequentialHarnessTool<TContext extends object | undefined>(
  tool: AgentHarnessTool<TContext>
): AgentHarnessTool<TContext> {
  return { ...tool, executionMode: 'sequential' }
}

/** Bind one Harness execution tool to a conversation-scoped context for Agent. */
export function bindHarnessToolContext<TContext extends object | undefined>(
  tool: AgentHarnessTool<TContext>,
  context: TContext
): AgentTool {
  return {
    ...tool,
    executionMode: 'sequential',
    execute(toolCallId, params, signal, onUpdate) {
      return tool.execute(toolCallId, params, signal, onUpdate, context)
    }
  }
}

/** Bind a fixed turn context without weakening the per-tool sequential contract. */
export function bindHarnessToolsContext<TContext extends object | undefined>(
  tools: AgentHarnessTool<TContext>[],
  context: TContext
): AgentTool[] {
  return tools.map((tool) => bindHarnessToolContext(tool, context))
}

const MISSING_TOOL_SECURITY_CONTEXT = '工具安全上下文缺失或已取消'

function isToolArgs(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Authorize directly from Agent's validated beforeToolCall context and run signal. */
export class PiCoreToolAuthorizer {
  constructor(private readonly options: ToolAuthorizationOptions) {}

  async authorize(
    context: BeforeToolCallContext,
    signal?: AbortSignal
  ): Promise<BeforeToolCallResult | undefined> {
    const toolName = context?.toolCall?.name
    if (!signal || signal.aborted || typeof toolName !== 'string' || !isToolArgs(context?.args)) {
      return { block: true, reason: MISSING_TOOL_SECURITY_CONTEXT }
    }
    try {
      return await authorizeToolCall(toolName, context.args, this.options, signal)
    } catch (error) {
      // 阻止是对的，但静默阻止不是：授权路径里的任何异常都会让全部工具无声失效，
      // 现象是「模型什么也没做」，而日志里一个字都没有。留下证据再阻止。
      console.error(`[Security] 工具授权异常，已安全阻止: ${toolName}`, error)
      return { block: true, reason: '工具授权失败，已安全阻止执行' }
    }
  }
}

/** Preserve OpenPipal's error/interaction metadata on Agent tool results. */
export function buildPiCoreAfterToolCallPatch(
  context: AfterToolCallContext
): AfterToolCallResult | undefined {
  const details = context.result.details as {
    askUser?: unknown
    questionsV2?: unknown
    isError?: unknown
    error?: unknown
    subagent?: { status?: unknown; errorMessage?: unknown }
  } | undefined
  const terminate = !!(details?.askUser || details?.questionsV2)
  const isError = !!(
    details?.isError
    || details?.error
    || details?.subagent?.status === 'error'
    || details?.subagent?.errorMessage
  )
  return terminate || isError
    ? { ...(terminate ? { terminate: true } : {}), ...(isError ? { isError: true } : {}) }
    : undefined
}

const PI_AGENT_EVENT_TYPES = new Set<PiAgentEvent['type']>([
  'agent_start',
  'agent_end',
  'turn_start',
  'turn_end',
  'message_start',
  'message_update',
  'message_end',
  'tool_execution_start',
  'tool_execution_update',
  'tool_execution_end'
])

export function isPiAgentEvent(event: unknown): event is PiAgentEvent {
  if (!event || typeof event !== 'object') return false
  const type = (event as { type?: unknown }).type
  return typeof type === 'string' && PI_AGENT_EVENT_TYPES.has(type as PiAgentEvent['type'])
}

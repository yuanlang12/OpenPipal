import type {
  AfterToolCallContext,
  AfterToolCallResult,
  AgentEvent as PiAgentEvent,
  AgentHarnessTool,
  AgentTool,
  BeforeToolCallContext,
  BeforeToolCallResult
} from '@earendil-works/pi-agent-core'
import { validateToolArguments } from '@earendil-works/pi-ai'
import {
  authorizeToolCall,
  writeHookBlockAudit,
  type ToolAuthorizationOptions
} from '../pi-security'
import {
  hasHandlers,
  runToolCallHooks,
  runToolResultHooks,
  type HookChain
} from '../hooks/hook-chain'
import type { HookContent } from '../hooks/hook-types'

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
  const details = context.result.details as { askUser?: unknown; questionsV2?: unknown } | undefined
  const terminate = !!(details?.askUser || details?.questionsV2)
  const isError = resultDetailsSignalError(context.result.details)
  return terminate || isError
    ? { ...(terminate ? { terminate: true } : {}), ...(isError ? { isError: true } : {}) }
    : undefined
}

/** OpenPipal 工具用 details 表达"其实失败了"的唯一口径——Agent 循环与规则借工具（hook-tool-bridge）共用 */
export function resultDetailsSignalError(rawDetails: unknown): boolean {
  const details = rawDetails as {
    isError?: unknown
    error?: unknown
    subagent?: { status?: unknown; errorMessage?: unknown }
  } | undefined
  return !!(
    details?.isError
    || details?.error
    || details?.subagent?.status === 'error'
    || details?.subagent?.errorMessage
  )
}

/**
 * 规则改过参数之后按工具 schema 重新校验（与 Agent 循环同一个校验器）：改坏了就拦下，
 * 不让一个类型错的参数穿到工具里变成莫名其妙的 TypeError。校验通过的、转换过的值
 * 写回**同一个对象**——Agent 循环执行工具用的就是它。
 */
function revalidateMutatedArgs(context: BeforeToolCallContext, toolName: string): string | undefined {
  const tool = context.context?.tools?.find((candidate) => candidate.name === toolName)
  if (!tool) return undefined
  try {
    const validated = validateToolArguments(tool, { ...context.toolCall, arguments: context.args as Record<string, unknown> })
    if (isToolArgs(validated) && isToolArgs(context.args)) {
      for (const key of Object.keys(context.args)) delete context.args[key]
      Object.assign(context.args, validated)
    }
    return undefined
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

export interface PiCoreBeforeToolCallComposition {
  authorizer: PiCoreToolAuthorizer
  /** 没有规则时传 undefined，代码路径与从前逐字节一致 */
  hookChain?: HookChain
  isInterrupted: () => boolean
  /** 安全员放行、工具真要开跑之前的钩子（规则文件指纹基线在这里刷新，探针只看这条命令期间的变化） */
  onToolStart?: (toolName: string, args: Record<string, unknown>) => void
}

export interface PiCoreAfterToolCallComposition {
  hookChain?: HookChain
  onInterrupt: () => void
  /**
   * 写文件类工具成功之后的探针：命中规则文件就返回要回给模型的那句话（追加进工具结果），
   * 对话流提醒由实现方自己发。工具出错时不调用——文件没写成。
   */
  probeWrittenFile?: (toolName: string, args: Record<string, unknown>) => Promise<string | undefined>
}

const QUESTION_INTERRUPT_RESULT: BeforeToolCallResult = {
  block: true,
  reason: '等待用户回答，已阻止同批次中的后续工具调用',
  terminate: true
}

/**
 * 工具调用前的组合顺序（永久机制，不随模型强弱变化）：
 *   问答中断 → 用户规则（可改参 / 可拦） → 宿主安全员审**最终**参数 → 执行
 * 规则排在安全员前面不是让它「更外层」，恰恰相反：安全员必须看到真正要执行的那份参数。
 * 规则改完再审，规则就永远绕不过安全员；规则拦下的，安全员根本不用问用户。
 */
export function composePiCoreBeforeToolCall(
  composition: PiCoreBeforeToolCallComposition
): (context: BeforeToolCallContext, signal?: AbortSignal) => Promise<BeforeToolCallResult | undefined> {
  const { authorizer, hookChain, isInterrupted, onToolStart } = composition
  return async (context, signal) => {
    if (isInterrupted()) return QUESTION_INTERRUPT_RESULT
    const toolName = context?.toolCall?.name
    if (hookChain && hasHandlers(hookChain, 'tool_call') && typeof toolName === 'string' && isToolArgs(context.args)) {
      const verdict = await runToolCallHooks(hookChain, {
        type: 'tool_call',
        toolName,
        toolCallId: context.toolCall.id,
        input: context.args
      })
      if (verdict?.block) {
        // 规则拦下的不经安全员，但审计不能少一行
        writeHookBlockAudit(toolName, context.args, verdict.reason || '')
        return { block: true, reason: verdict.reason }
      }
      const invalid = revalidateMutatedArgs(context, toolName)
      if (invalid) {
        const reason = `规则把参数改坏了，已拦下：${invalid}`
        writeHookBlockAudit(toolName, context.args, reason)
        return { block: true, reason }
      }
    }
    const verdict = await authorizer.authorize(context, signal)
    if (!verdict?.block && onToolStart && typeof toolName === 'string' && isToolArgs(context.args)) {
      try {
        onToolStart(toolName, context.args)
      } catch (error) {
        console.warn('[Hooks] 工具开跑前的钩子出错，忽略:', error instanceof Error ? error.message : String(error))
      }
    }
    return verdict
  }
}

/**
 * 工具结果的组合顺序：宿主先算 terminate / isError，规则再打补丁。
 * 宿主的 terminate 不可覆盖；terminate 时 details 也不许动——ask_user 卡片靠它渲染。
 */
export function composePiCoreAfterToolCall(
  composition: PiCoreAfterToolCallComposition
): (context: AfterToolCallContext) => Promise<AfterToolCallResult | undefined> {
  const { hookChain, onInterrupt, probeWrittenFile } = composition
  return async (context) => {
    const hostPatch = buildPiCoreAfterToolCallPatch(context)
    if (hostPatch?.terminate) onInterrupt()
    const toolName = context?.toolCall?.name
    if (typeof toolName !== 'string') return hostPatch
    let patch: AfterToolCallResult | undefined = hostPatch
    if (hookChain && hasHandlers(hookChain, 'tool_result')) {
      const hookPatch = await runToolResultHooks(hookChain, {
        type: 'tool_result',
        toolName,
        toolCallId: context.toolCall.id,
        input: isToolArgs(context.args) ? context.args : {},
        content: (context.result?.content ?? []) as HookContent[],
        details: context.result?.details,
        isError: hostPatch?.isError ?? context.isError
      })
      if (hookPatch) {
        const merged: AfterToolCallResult = { ...(hostPatch ?? {}) }
        if (hookPatch.content) merged.content = hookPatch.content as AfterToolCallResult['content']
        if (hookPatch.details !== undefined && !hostPatch?.terminate) merged.details = hookPatch.details
        if (typeof hookPatch.isError === 'boolean') merged.isError = hookPatch.isError
        patch = merged
      }
    }
    const failed = patch?.isError ?? context.isError
    if (probeWrittenFile && !failed && isToolArgs(context.args)) {
      // 探针自己出错不能连累工具结果：Agent 循环会把 afterToolCall 的异常折成"工具失败"回给模型
      let note: string | undefined
      try {
        note = await probeWrittenFile(toolName, context.args)
      } catch (error) {
        console.warn('[Hooks] 规则探针出错，忽略:', error instanceof Error ? error.message : String(error))
      }
      if (note) {
        const baseContent = (patch?.content ?? context.result?.content ?? []) as NonNullable<AfterToolCallResult['content']>
        patch = { ...(patch ?? {}), content: [...baseContent, { type: 'text', text: note }] }
      }
    }
    return patch
  }
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

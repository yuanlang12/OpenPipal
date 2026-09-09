/**
 * 规则借助手的工具干活：ctx.callTool('bash', { command }) 的宿主实现。
 *
 * 不新造能力对象，直接复用助手这一轮真正挂着的工具（含 MCP 工具）——于是自动得到：
 *   同一套 pi-security 审核（越界路径、危险命令、git 凭据门、浏览器策略）、
 *   同一个沙箱、同样的授权卡（onConfirmation 就是本会话的 permissionHandler）、
 *   同样的参数校验（pi-ai 的 validateToolArguments：克隆 + 可选字段 null 归一 + 类型转换，
 *   与 Agent 循环一字不差）、同样的"结果算不算出错"口径（details 里的 isError/error/subagent）。
 *   规则能做的 = 助手能做的，一个不多。
 *
 * 不经过 Agent 循环，所以规则发起的调用不再触发 tool_call / tool_result 规则（不递归），
 * 也不进对话流的工具卡片（只留主进程日志）。
 */
import type { AgentTool } from '@earendil-works/pi-agent-core'
import { validateToolArguments } from '@earendil-works/pi-ai'
import { resultDetailsSignalError } from '../agent-runtime/pi-core-tool-adapter'
import { authorizeToolCall, type ToolAuthorizationOptions } from '../pi-security'
import type { HookToolCaller } from './hook-chain'
import type { HookContent } from './hook-types'

export interface HookToolCallLog {
  toolName: string
  ms: number
  /** 被安全员拒绝的原因 */
  blocked?: string
  /** 工具自己抛出的错误 */
  error?: string
}

export interface HookToolCallerOptions {
  tools: AgentTool[]
  authorization: ToolAuthorizationOptions
  onCall?: (log: HookToolCallLog) => void
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function createHookToolCaller(options: HookToolCallerOptions): HookToolCaller {
  const byName = new Map(options.tools.map((tool) => [tool.name, tool] as const))
  let sequence = 0
  return async (toolName, input, signal) => {
    const started = Date.now()
    const log = (extra: Partial<HookToolCallLog> = {}): void => {
      options.onCall?.({ toolName, ms: Date.now() - started, ...extra })
    }
    const tool = byName.get(toolName)
    if (!tool) throw new Error(`没有叫「${toolName}」的工具`)
    if (!isPlainObject(input)) throw new Error('工具参数必须是对象')
    const toolCallId = `hook-${started}-${++sequence}`
    let prepared: Record<string, unknown>
    try {
      const raw = tool.prepareArguments ? tool.prepareArguments(input) : input
      // 与 Agent 循环同一个校验器：内部先 structuredClone，所以规则手里那份对象之后再改也影响不到执行
      prepared = validateToolArguments(tool, { type: 'toolCall', id: toolCallId, name: toolName, arguments: raw as Record<string, unknown> }) as Record<string, unknown>
    } catch (error) {
      throw new Error(`参数不合法：${error instanceof Error ? error.message : String(error)}`)
    }
    if (signal.aborted) throw new Error('已取消')
    const verdict = await authorizeToolCall(toolName, prepared, options.authorization, signal)
    if (verdict?.block) {
      const reason = verdict.reason || '不允许'
      log({ blocked: reason })
      throw new Error(`被安全员拒绝：${reason}`)
    }
    if (signal.aborted) throw new Error('已取消')
    try {
      const result = await tool.execute(toolCallId, prepared, signal, () => {})
      log()
      return {
        content: (result.content ?? []) as HookContent[],
        details: result.details,
        isError: resultDetailsSignalError(result.details)
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      log({ error: message })
      return { content: [{ type: 'text', text: message }], details: undefined, isError: true }
    }
  }
}

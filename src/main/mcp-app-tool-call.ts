import {
  callMcpToolStructuredFromBoundServer,
  extractTextFromContentBlocks,
  isMcpToolFromBoundServer
} from './mcp-manager'
import { classifyToolRisk, requestUserConfirmation } from './pi-security'

export interface McpAppToolCallRequest {
  serverName: string
  /** Opaque identity of the exact connection that produced this App view. */
  serverBinding: string
  toolName: string
  args: Record<string, unknown>
  conversationId?: string
}

export interface McpAppToolCallResult {
  ok: boolean
  result?: string
  content?: any[]
  structuredContent?: any
  error?: string
}

/**
 * Authorize and execute one reverse tools/call from a sandboxed MCP App.
 * The iframe is untrusted: every call is rebound to its source server and
 * independently classified, even if the App's parent tool was already approved.
 */
export async function callMcpToolFromApp(
  request: McpAppToolCallRequest
): Promise<McpAppToolCallResult> {
  const { serverName, serverBinding, toolName, args, conversationId } = request
  if (
    typeof serverName !== 'string'
    || typeof serverBinding !== 'string'
    || serverBinding.length === 0
    || serverBinding.length > 128
    || typeof toolName !== 'string'
    || !args
    || typeof args !== 'object'
    || Array.isArray(args)
  ) {
    return { ok: false, error: 'MCP App 工具调用参数无效' }
  }

  if (!isMcpToolFromBoundServer(serverBinding, serverName, toolName, conversationId)) {
    return { ok: false, error: `工具 "${toolName}" 不属于 server "${serverName}",跨 server 调用被拒绝` }
  }

  const risk = classifyToolRisk(toolName, args, { origin: 'mcp' })
  if (risk.level === 'risky') {
    return { ok: false, error: `工具 "${toolName}" 被安全策略阻止: ${risk.reason}` }
  }
  if (risk.level === 'needs_confirmation') {
    const approved = await requestUserConfirmation(
      toolName,
      args,
      risk.reason,
      conversationId,
      undefined,
      { namespace: `mcp:${serverName}:${serverBinding}`, argumentScoped: true }
    )
    if (!approved) {
      return { ok: false, error: `用户拒绝执行 "${toolName}"` }
    }
  }

  try {
    // This sink resolves by opaque connection identity again after any async
    // confirmation. A same-name replacement receives a new binding and cannot
    // inherit either the permission namespace or this view's capability.
    const structured = await callMcpToolStructuredFromBoundServer(
      serverBinding,
      serverName,
      toolName,
      args,
      conversationId
    )
    if (!structured) return { ok: false, error: `工具 "${toolName}" 在确认后不再可用` }
    return {
      ok: true,
      content: structured.content,
      structuredContent: structured.structuredContent,
      result: extractTextFromContentBlocks(structured.content)
    }
  } catch (error) {
    return { ok: false, error: String(error) }
  }
}

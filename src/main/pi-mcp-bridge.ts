/**
 * Pi MCP Bridge — 代码执行网关
 *
 * 用单个 mcp_execute 工具替代旧版 tool_search + call_mcp_tool 双网关。
 * AI 在 QuickJS WASM 沙箱中写 JavaScript 代码来搜索、描述、调用 MCP 工具。
 * 中间数据留在沙箱内，只有 console.log 输出返回 AI 上下文。
 *
 * 参考：Anthropic "Code execution with MCP" (2025-11)
 */

import { Type } from 'typebox'
import type { AgentTool, AgentToolResult } from '@earendil-works/pi-agent-core'
import {
  searchMcpTools,
  callMcpTool,
  callMcpToolStructured,
  describeMcpTool,
  isMcpTool,
  getMcpTools,
  getMcpToolUi,
  resolveMcpToolServerIdentity,
  type McpToolAccessScope
} from './mcp-manager'
import { classifyToolRisk, MCP_PERMISSION_TIMEOUT_MS, requestUserConfirmation } from './pi-security'
import type { ChatSource } from './agent-runtime/contracts'
import { isToolBlockedForChatSource } from './agent-runtime/source-tool-policy'
import {
  executeInQuickJS,
  QUICKJS_DEFAULT_CPU_TIMEOUT_MS,
  serializedUtf8ByteLength,
  truncateUtf8WithMarker,
  utf8ByteLength,
  type ToolsApi
} from './quickjs-sandbox'

export const MCP_EXECUTION_CPU_TIMEOUT_MS = QUICKJS_DEFAULT_CPU_TIMEOUT_MS
export const MCP_EXECUTION_WALL_TIMEOUT_MS = MCP_PERMISSION_TIMEOUT_MS + 60_000
export const MCP_FINAL_TOOL_RESULT_MAX_BYTES = 160 * 1024
export const MCP_CODE_DETAIL_MAX_BYTES = 64 * 1024
export const MCP_SEARCH_MAX_RESULTS = 50
export const MCP_APP_HTML_MAX_BYTES = 1024 * 1024
export const MCP_APP_CONTENT_BLOCKS_MAX_BYTES = 512 * 1024
export const MCP_APP_STRUCTURED_CONTENT_MAX_BYTES = 512 * 1024
export const MCP_APP_ARGS_MAX_BYTES = 256 * 1024
export const MCP_APP_METADATA_MAX_BYTES = 64 * 1024
export const MCP_APP_ROUTING_VALUE_MAX_BYTES = 16 * 1024
export const MCP_APP_INLINE_MAX_BYTES = 3 * 1024 * 1024
const MCP_APP_NOTICE_MAX_ENTRIES = 8

interface McpPayloadTruncation {
  _openpipalTruncated: {
    field: string
    reason: 'size-limit' | 'not-json-serializable'
    originalUtf8Bytes: number | null
    limitUtf8Bytes: number
  }
}

function payloadPlaceholder(
  field: string,
  originalUtf8Bytes: number | null,
  limitUtf8Bytes: number
): McpPayloadTruncation {
  return {
    _openpipalTruncated: {
      field,
      reason: originalUtf8Bytes === null ? 'not-json-serializable' : 'size-limit',
      originalUtf8Bytes,
      limitUtf8Bytes
    }
  }
}

function boundJsonField<T, R>(
  value: T,
  maxBytes: number,
  field: string,
  replacement: (placeholder: McpPayloadTruncation) => R
): { value: T | R; replaced: boolean; originalBytes: number | null } {
  let originalBytes: number | null = null
  try {
    originalBytes = serializedUtf8ByteLength(value)
    if (originalBytes <= maxBytes) return { value, replaced: false, originalBytes }
  } catch {
    // A cyclic/non-JSON value cannot safely cross Electron or persistence.
  }
  return {
    value: replacement(payloadPlaceholder(field, originalBytes, maxBytes)),
    replaced: true,
    originalBytes
  }
}

function addNotice(notices: string[], notice: string): void {
  if (notices.includes(notice)) return
  if (notices.length < MCP_APP_NOTICE_MAX_ENTRIES) notices.push(notice)
}

function boundedTextFromContentBlocks(blocks: unknown, maxBytes: number): string {
  if (!Array.isArray(blocks)) return ''
  let output = ''
  let usedBytes = 0
  for (const item of blocks) {
    if (item?.type !== 'text' || typeof item.text !== 'string') continue
    const separator = output ? '\n' : ''
    const separatorBytes = separator ? 1 : 0
    const textBytes = utf8ByteLength(item.text)
    if (usedBytes + separatorBytes + textBytes <= maxBytes) {
      output += separator + item.text
      usedBytes += separatorBytes + textBytes
      continue
    }
    const remaining = Math.max(0, maxBytes - usedBytes - separatorBytes)
    if (remaining > 0) {
      output += separator + truncateUtf8WithMarker(item.text, remaining, 'MCP App tool text')
    }
    break
  }
  return output
}

function uiRoutingRejectionReason(uiMeta: {
  serverName: string
  serverBinding: string
  toolName: string
  resourceUri: string
  html: string
}): string | null {
  if (utf8ByteLength(uiMeta.html) > MCP_APP_HTML_MAX_BYTES) {
    return `HTML 超过 ${MCP_APP_HTML_MAX_BYTES} UTF-8 bytes`
  }
  for (const [field, value] of [
    ['serverName', uiMeta.serverName],
    ['serverBinding', uiMeta.serverBinding],
    ['toolName', uiMeta.toolName],
    ['resourceUri', uiMeta.resourceUri]
  ] as const) {
    if (utf8ByteLength(value) > MCP_APP_ROUTING_VALUE_MAX_BYTES) {
      return `${field} 超过 ${MCP_APP_ROUTING_VALUE_MAX_BYTES} UTF-8 bytes`
    }
  }
  return null
}

/** 沙箱执行期间捕获的 MCP Apps UI 调用 — execute() 结束后转为 inline mcpApp 事件 */
interface CapturedUiCall {
  serverName: string
  serverBinding: string
  toolName: string
  resourceUri: string
  html: string
  permissions?: string[]
  csp?: Record<string, unknown>
  args: Record<string, unknown>
  /** ContentBlock 数组(人/图层) — image base64、text 等,postMessage 给 iframe 时放在 content 字段 */
  contentBlocks: any[]
  /** typed object(程序层) — server 用 structuredContent 字段返回的结构化数据,Budget/Map 等主要用这个 */
  structuredContent: any
}

function textResult(text: string, details?: any): AgentToolResult<any> {
  const boundedText = truncateUtf8WithMarker(
    text,
    MCP_FINAL_TOOL_RESULT_MAX_BYTES,
    'MCP final tool result'
  )
  const boundedDetails = details ? { ...details } : {}
  if (typeof boundedDetails.displayResult === 'string') {
    boundedDetails.displayResult = truncateUtf8WithMarker(
      boundedDetails.displayResult,
      MCP_FINAL_TOOL_RESULT_MAX_BYTES,
      'MCP final display result'
    )
  }
  if (typeof boundedDetails.code === 'string') {
    boundedDetails.code = truncateUtf8WithMarker(
      boundedDetails.code,
      MCP_CODE_DETAIL_MAX_BYTES,
      'MCP code detail'
    )
  }
  return { content: [{ type: 'text', text: boundedText }], details: boundedDetails }
}

function abortError(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) return signal.reason
  const error = new Error(
    typeof signal.reason === 'string' && signal.reason.length > 0
      ? signal.reason
      : 'Operation aborted'
  )
  error.name = 'AbortError'
  return error
}

function throwIfSignalAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw abortError(signal)
}

/**
 * 构建 ToolsApi 桥接：沙箱内 → mcp-manager
 * tools.call 内置安全检查：needs_confirmation/risky 工具会被拒绝
 * 同时捕获 MCP Apps UI 调用到 uiCallsOut,execute() 完成后转为 artifact 事件
 */
function buildToolsApi(
  uiCallsOut: CapturedUiCall[],
  noticesOut: string[],
  serverFilter?: string[],
  conversationId?: string,
  signal?: AbortSignal,
  source: ChatSource = 'desktop'
): ToolsApi {
  const throwIfAborted = (): void => throwIfSignalAborted(signal)
  const accessScope = (serverName?: string, serverBinding?: string): McpToolAccessScope => ({
    serverFilter,
    serverName,
    serverBinding,
    modelVisibleOnly: true
  })

  return {
    async search(query: string, limit?: number) {
      throwIfAborted()
      // conversationId 兼任 ACP sessionId——传给 mcp-manager 让它把 session 范围
      // 注入的 server(via /api/acp/sessions/:id/mcp)也包含进来。
      const boundedLimit = typeof limit === 'number' && Number.isFinite(limit)
        ? Math.max(1, Math.min(Math.floor(limit), MCP_SEARCH_MAX_RESULTS))
        : undefined
      // Scheduler policy must apply to the real MCP names hidden behind the
      // single mcp_execute gateway, not merely to the gateway's public name.
      // Search a bounded superset so blocked high-ranked results do not crowd
      // safe tools out of the caller's requested page.
      const requestedLimit = boundedLimit ?? 5
      const searchLimit = source === 'scheduler'
        ? MCP_SEARCH_MAX_RESULTS
        : boundedLimit
      const results = searchMcpTools(query, searchLimit, serverFilter, true, conversationId)
      return results
        .filter(result => !isToolBlockedForChatSource(source, result.name))
        .slice(0, requestedLimit)
        .map(r => ({ name: r.name, server: r.server, description: r.description }))
    },

    async describe(toolName: string, serverName?: string) {
      throwIfAborted()
      if (isToolBlockedForChatSource(source, toolName)) {
        return `工具 "${toolName}" 不允许在后台调度任务中使用。`
      }
      const desc = describeMcpTool(toolName, conversationId, accessScope(serverName))
      if (!desc) return `工具 "${toolName}" 不存在。请先用 tools.search() 搜索。`
      return desc
    },

    async call(toolName: string, args: Record<string, unknown>, serverName?: string) {
      throwIfAborted()
      // This check intentionally precedes discovery, risk classification,
      // permission UI and the remote MCP call. A model can name tools directly
      // without search/describe, so those surfaces alone are not enforcement.
      if (isToolBlockedForChatSource(source, toolName)) {
        throw new Error(`工具 "${toolName}" 不允许在后台调度任务中使用。`)
      }
      const initialScope = accessScope(serverName)
      const resolvedServer = resolveMcpToolServerIdentity(toolName, conversationId, initialScope)
      const scope = accessScope(resolvedServer?.serverName, resolvedServer?.serverBinding)
      // Fail before risk prompting: a known name from a hidden/app-only/out-of-
      // workspace server must not even create a misleading permission request.
      if (!resolvedServer || !describeMcpTool(toolName, conversationId, scope)) {
        throw new Error(`工具 "${toolName}" 不存在或不允许当前 Agent 使用。请先用 tools.search() 搜索。`)
      }
      const risk = classifyToolRisk(toolName, args, { origin: 'mcp' })
      if (risk.level === 'risky') {
        throw new Error(`工具 "${toolName}" 被安全策略阻止: ${risk.reason}`)
      }
      if (risk.level === 'needs_confirmation') {
        // 发 inline 权限气泡到 renderer,沙盒在此 await,用户点允许/拒绝后解锁。
        // 用户选"本次会话允许"→ 同会话同 tool 后续自动放行;超时自动拒绝
        console.log(`[MCP] sandbox call: ${toolName} — 等待用户确认 (${risk.reason})`)
        const approved = await requestUserConfirmation(
          toolName,
          args as Record<string, any>,
          risk.reason,
          conversationId,
          signal,
          { namespace: `mcp:${resolvedServer.serverName}:${resolvedServer.serverBinding}`, argumentScoped: true }
        )
        throwIfAborted()
        if (!approved) {
          throw new Error(`用户拒绝执行 "${toolName}"`)
        }
        // Approval can outlive a disconnect/reconnect. Revalidate the exact
        // opaque connection before any UI lookup or remote side effect.
        if (!resolveMcpToolServerIdentity(toolName, conversationId, scope)) {
          throw new Error(`工具 "${toolName}" 在确认后不再可用。`)
        }
        console.log(`[MCP] sandbox call: ${toolName} — 用户已批准`)
      }

      // Tool arguments may contain credentials, document content, or user data.
      // Keep operational logs useful without copying payloads into app logs.
      console.log(`[MCP] sandbox call: ${toolName} (arguments redacted)`)

      // UI tool:走 structured 路径拿 content + structuredContent;非 UI tool 走文本路径
      const uiMeta = getMcpToolUi(toolName, conversationId, scope)
      if (uiMeta) {
        const rejectionReason = uiRoutingRejectionReason(uiMeta)
        if (rejectionReason) {
          addNotice(
            noticesOut,
            `[MCP App UI 已降级为文本：${toolName} 的 ${rejectionReason}；为保护应用，未附加内联 UI。]`
          )
          const fallback = await callMcpTool(toolName, args, conversationId, signal, scope)
          throwIfAborted()
          return fallback
        }

        const structured = await callMcpToolStructured(toolName, args, conversationId, signal, scope)
        throwIfAborted()
        const contentBlocks = structured?.content || []
        const structuredContent = structured?.structuredContent
        const boundedBlocks = boundJsonField(
          contentBlocks,
          MCP_APP_CONTENT_BLOCKS_MAX_BYTES,
          'contentBlocks',
          placeholder => [{
            type: 'text',
            text: '[OpenPipal omitted oversized MCP App contentBlocks]',
            _meta: placeholder._openpipalTruncated
          }]
        )
        const boundedStructured = boundJsonField(
          structuredContent,
          MCP_APP_STRUCTURED_CONTENT_MAX_BYTES,
          'structuredContent',
          placeholder => placeholder
        )
        // 沙盒返回值是字符串 — 优先用 text content,无文本时 fallback 到 structuredContent / blocks JSON
        const textResult = boundedTextFromContentBlocks(
          boundedBlocks.value,
          MCP_APP_CONTENT_BLOCKS_MAX_BYTES
        ) || (boundedStructured.value ? JSON.stringify(boundedStructured.value).substring(0, 500) : '')
          || JSON.stringify(boundedBlocks.value)
        console.log(`[MCP] sandbox result: ${toolName} (${Buffer.byteLength(textResult, 'utf8')} bytes)`)
        // Only the first UI call is rendered. Bound every field before retaining
        // it so repeated calls cannot accumulate unbounded renderer/persistence payloads.
        if (uiCallsOut.length === 0) {
          const boundedArgs = boundJsonField(
            args,
            MCP_APP_ARGS_MAX_BYTES,
            'args',
            placeholder => placeholder
          )
          const boundedMetadata = boundJsonField(
            {
              permissions: uiMeta.permissions || [],
              csp: uiMeta.csp || null
            },
            MCP_APP_METADATA_MAX_BYTES,
            'permissions/csp',
            placeholder => ({
              permissions: [`[OpenPipal omitted oversized MCP App permissions: ${JSON.stringify(placeholder._openpipalTruncated)}]`],
              csp: placeholder
            })
          )
          const replacedFields = [
            boundedBlocks.replaced ? 'contentBlocks' : '',
            boundedStructured.replaced ? 'structuredContent' : '',
            boundedArgs.replaced ? 'args' : '',
            boundedMetadata.replaced ? 'permissions/csp' : ''
          ].filter(Boolean)
          if (replacedFields.length > 0) {
            addNotice(
              noticesOut,
              `[MCP App 内联数据已限流：${replacedFields.join(', ')} 超限或不可序列化，已替换为合法占位。]`
            )
          }
          const metadata = boundedMetadata.value as {
            permissions: string[]
            csp: Record<string, unknown> | null
          }
          uiCallsOut.push({
            serverName: uiMeta.serverName,
            serverBinding: uiMeta.serverBinding,
            toolName,
            resourceUri: uiMeta.resourceUri,
            html: uiMeta.html,
            permissions: metadata.permissions,
            csp: metadata.csp || undefined,
            args: boundedArgs.value as Record<string, unknown>,
            contentBlocks: boundedBlocks.value as any[],
            structuredContent: boundedStructured.value
          })
        }
        return textResult
      }

      const result = await callMcpTool(toolName, args, conversationId, signal, scope)
      throwIfAborted()
      console.log(`[MCP] sandbox result: ${toolName} (${Buffer.byteLength(result, 'utf8')} bytes)`)
      return result
    }
  }
}

function createMcpExecuteTool(
  serverFilter?: string[],
  conversationId?: string,
  source: ChatSource = 'desktop'
): AgentTool {
  return {
    name: 'mcp_execute',
    label: 'MCP 代码执行',
    executionMode: 'sequential',
    description: `在 JavaScript 沙箱中执行代码来调用外部工具。把搜索、查看参数、调用的完整流程写在一段代码中，不要多次调用此工具。

API（同步，不需要 await）：
- tools.search(query, limit?) → [{name, server, description}]
- tools.describe(toolName, server?) → 参数格式字符串
- tools.call(toolName, args, server?) → 结果（自动 JSON 解析）
- console.log(...) → 输出给你看

示例（一次写完整流程）：
var r = tools.search("docs");
var desc = tools.describe(r[0].name, r[0].server);
console.log(desc);
var data = tools.call(r[0].name, { query: "hooks", libraryName: "React" }, r[0].server);
console.log(data);`,
    parameters: Type.Object({
      code: Type.String({ description: 'JavaScript 代码。使用 tools.search/describe/call 和 console.log。' })
    }),
    execute: async (_id, params, signal) => {
      const operationController = new AbortController()
      const forwardAbort = (): void => {
        if (!operationController.signal.aborted) {
          operationController.abort(signal?.reason)
        }
      }
      if (signal?.aborted) forwardAbort()
      else signal?.addEventListener('abort', forwardAbort, { once: true })

      const operationSignal = operationController.signal
      try {
        throwIfSignalAborted(operationSignal)
        const code = (params as any).code || ''
        const uiCalls: CapturedUiCall[] = []
        const executionNotices: string[] = []
        const toolsApi = buildToolsApi(
          uiCalls,
          executionNotices,
          serverFilter,
          conversationId,
          operationSignal,
          source
        )

        console.log(`[MCP] mcp_execute 开始，代码长度: ${code.length}`)
        const result = await executeInQuickJS(code, toolsApi, {
          timeoutMs: MCP_EXECUTION_CPU_TIMEOUT_MS,
          wallTimeoutMs: MCP_EXECUTION_WALL_TIMEOUT_MS,
          signal: operationSignal,
          onTimeout: () => {
            if (operationSignal.aborted) return
            const timeoutError = new Error('MCP sandbox execution timed out')
            timeoutError.name = 'TimeoutError'
            operationController.abort(timeoutError)
          }
        })
        throwIfSignalAborted(signal)
        console.log(`[MCP] mcp_execute 完成，耗时: ${result.elapsedMs}ms，日志: ${result.logs.length} 行${uiCalls.length > 0 ? `，UI calls: ${uiCalls.length}` : ''}`)

        // 本次沙箱执行触发的 MCP Apps UI → details.mcpAppInline
        // pi-event-adapter 会把它包装成内联 visualizer 风格事件,挂到当前 mcp_execute 工具消息上
        // 取第一个(多 UI 调用场景极少见)
        let mcpAppInline = uiCalls.length > 0 ? (() => {
          const first = uiCalls[0]
          return {
            serverName: first.serverName,
            serverBinding: first.serverBinding,
            toolName: first.toolName,
            conversationId,
            resourceUri: first.resourceUri,
            html: first.html,
            args: first.args,
            // 两个字段都通过 postMessage notifications/tool-result 推给 iframe:
            //  contentBlocks → params.content(SDK 标准 ContentBlock 数组)
            //  structuredContent → params.structuredContent(typed payload)
            contentBlocks: first.contentBlocks,
            structuredContent: first.structuredContent,
            permissions: first.permissions || [],
            csp: first.csp || null
          }
        })() : null

        if (mcpAppInline) {
          let inlineBytes: number | null = null
          try {
            inlineBytes = serializedUtf8ByteLength(mcpAppInline)
          } catch {
            // The individually bounded fields should be JSON-safe; fail closed
            // if a future field violates that invariant.
          }
          if (inlineBytes === null || inlineBytes > MCP_APP_INLINE_MAX_BYTES) {
            addNotice(
              executionNotices,
              `[MCP App UI 已降级为文本：${mcpAppInline.toolName} 的完整内联载荷${inlineBytes === null ? '不可序列化' : `为 ${inlineBytes} UTF-8 bytes`}，超过 ${MCP_APP_INLINE_MAX_BYTES} bytes 总上限；未附加内联 UI。]`
            )
            mcpAppInline = null
          }
        }

        // Safety/degradation notices come first so the final 160 KiB text cap
        // cannot cut them off behind a large tool log.
        const output = [...executionNotices, result.logs.join('\n')]
          .filter(Boolean)
          .join('\n\n')
        if (result.error) {
          const errOutput = output
            ? `${output}\n\n[错误] ${result.error}`
            : `[错误] ${result.error}`
          return textResult(errOutput, {
            displayResult: errOutput,
            isError: true,
            code,
            elapsedMs: result.elapsedMs,
            ...(mcpAppInline ? { mcpAppInline } : {})
          })
        }

        const baseText = output || '(代码执行完成，无 console.log 输出)'
        // 关键 UX 提示:被调用的 MCP 工具自带 UI 时,在 AI 可见的 result 前面注一行说明,
        // 避免 LLM 看 base64 dump 误以为没渲染又重复调用同一工具
        const displayText = mcpAppInline
          ? `[✓ MCP App 已内联渲染在对话中,用户已能看到 ${mcpAppInline.toolName} 的视觉结果。简短确认即可,不要重复调用同一工具,也不要用 create_visualizer/create_artifact 重做。]\n\n${baseText}`
          : baseText
        return textResult(displayText, {
          displayResult: displayText,
          code,
          elapsedMs: result.elapsedMs,
          ...(mcpAppInline ? { mcpAppInline } : {})
        })
      } finally {
        signal?.removeEventListener('abort', forwardAbort)
      }
    }
  }
}

/**
 * 构建 MCP 网关工具列表。
 * @param serverFilter 可选 MCP server 白名单(来自 Agent 的 tools/config.json.mcpServers)
 * @param conversationId 当前会话 id,用于会话级权限审批(同 conversation 同 tool 用户可选"本次会话允许")
 */
export function buildMcpBridgeTools(
  serverFilter?: string[],
  conversationId?: string,
  source: ChatSource = 'desktop'
): AgentTool[] {
  // sessionId 上下文很关键:ACP session 可能只注入了 server,没有全局 server。
  // 缺省调用 getMcpTools() 看不到注入的 → mcp_execute 工具不会被注册 → AI 调不到。
  const mcpTools = getMcpTools(conversationId, {
    serverFilter,
    modelVisibleOnly: true
  })
  if (mcpTools.length === 0) return []

  return [createMcpExecuteTool(serverFilter, conversationId, source)]
}

/** 重新导出 isMcpTool 供外部使用 */
export { isMcpTool }

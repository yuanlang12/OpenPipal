/**
 * QuickJS Sandbox — MCP tool-code execution engine.
 *
 * Untrusted JavaScript runs in a dedicated worker and reaches the trusted
 * ToolsApi only through a small RPC bridge. Keeping the VM off Electron's main
 * thread is important for cancellation: a same-thread `while (true) {}` blocks
 * the event loop, so an AbortSignal cannot change state until the VM returns.
 */

import { createRequire } from 'node:module'
import { Worker } from 'node:worker_threads'

export interface ToolsApi {
  search(query: string, limit?: number): Promise<{ name: string; server: string; description: string }[]>
  describe(toolName: string, serverName?: string): Promise<string>
  call(toolName: string, args: Record<string, unknown>, serverName?: string): Promise<string>
}

export interface McpExecutionResult {
  logs: string[]
  error?: string
  elapsedMs: number
  /** Internal signal used to distinguish a deadline from a normal tool error. */
  timedOut?: boolean
}

export interface QuickJsExecutionOptions {
  /** Pure QuickJS execution budget. Time paused in trusted host RPC is excluded. */
  timeoutMs?: number
  /** End-to-end safety ceiling, including user approval and remote MCP waits. */
  wallTimeoutMs?: number
  memoryLimitBytes?: number
  signal?: AbortSignal
  /** Abort trusted host work when either execution deadline is reached. */
  onTimeout?: () => void
}

export const QUICKJS_DEFAULT_CPU_TIMEOUT_MS = 30_000
export const QUICKJS_DEFAULT_WALL_TIMEOUT_MS = 5 * 60_000
export const QUICKJS_RPC_REQUEST_MAX_BYTES = 256 * 1024
export const QUICKJS_RPC_RESPONSE_MAX_BYTES = 512 * 1024
export const QUICKJS_LOG_MAX_BYTES = 128 * 1024
export const QUICKJS_LOG_MAX_ENTRIES = 256
export const QUICKJS_ERROR_MAX_BYTES = 32 * 1024

type WorkerToolMethod = 'search' | 'describe' | 'call'

export function utf8ByteLength(value: string): number {
  return Buffer.byteLength(value, 'utf8')
}

/** Deterministically keep a UTF-8 string within a hard byte budget. */
export function truncateUtf8WithMarker(
  value: string,
  maxBytes: number,
  label: string
): string {
  const originalBytes = utf8ByteLength(value)
  if (originalBytes <= maxBytes) return value
  if (maxBytes <= 0) return ''

  const marker = `\n…[${label} truncated: original ${originalBytes} UTF-8 bytes; limit ${maxBytes}]…`
  const markerBytes = utf8ByteLength(marker)
  const contentBudget = Math.max(0, maxBytes - markerBytes)
  let low = 0
  let high = value.length
  while (low < high) {
    const mid = Math.ceil((low + high) / 2)
    if (utf8ByteLength(value.slice(0, mid)) <= contentBudget) low = mid
    else high = mid - 1
  }
  // Avoid returning half of a surrogate pair at the truncation boundary.
  if (low > 0 && /[\uD800-\uDBFF]/.test(value.charAt(low - 1))) low--
  const prefix = value.slice(0, low)
  if (markerBytes <= maxBytes) return prefix + marker

  // Extremely small caller-supplied budgets: truncate the marker itself.
  low = 0
  high = marker.length
  while (low < high) {
    const mid = Math.ceil((low + high) / 2)
    if (utf8ByteLength(marker.slice(0, mid)) <= maxBytes) low = mid
    else high = mid - 1
  }
  return marker.slice(0, low)
}

export function serializedUtf8ByteLength(value: unknown): number {
  const serialized = JSON.stringify(value)
  return utf8ByteLength(serialized === undefined ? 'null' : serialized)
}

function boundRpcResponse(value: unknown): unknown {
  if (typeof value === 'string') {
    return truncateUtf8WithMarker(value, QUICKJS_RPC_RESPONSE_MAX_BYTES, 'MCP RPC response')
  }
  try {
    const size = serializedUtf8ByteLength(value)
    if (size <= QUICKJS_RPC_RESPONSE_MAX_BYTES) return value
    return `[MCP RPC response truncated: original ${size} UTF-8 bytes; limit ${QUICKJS_RPC_RESPONSE_MAX_BYTES}]`
  } catch {
    return '[MCP RPC response rejected: value is not JSON-serializable]'
  }
}

function assertBoundedRpcRequest(method: WorkerToolMethod, args: unknown[]): void {
  let size: number
  try {
    size = serializedUtf8ByteLength(args)
  } catch {
    throw new Error(`QuickJS ${method} request is not JSON-serializable`)
  }
  if (size > QUICKJS_RPC_REQUEST_MAX_BYTES) {
    throw new Error(`QuickJS ${method} request exceeds ${QUICKJS_RPC_REQUEST_MAX_BYTES} UTF-8 bytes`)
  }
}

interface WorkerToolRequest {
  type: 'tool-request'
  requestId: number
  method: WorkerToolMethod
  args: unknown[]
}

interface WorkerResult {
  type: 'result'
  result: McpExecutionResult
}

interface WorkerFatalError {
  type: 'fatal-error'
  error: { name?: string; message: string; stack?: string }
}

type SandboxWorkerMessage = WorkerToolRequest | WorkerResult | WorkerFatalError

const hostRequire = createRequire(__filename)
const quickJsModulePath = hostRequire.resolve('quickjs-emscripten')

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

function serializeError(error: unknown): { name: string; message: string } {
  if (error instanceof Error) {
    // Do not expose trusted-process stack paths to model-generated code.
    return {
      name: error.name,
      message: truncateUtf8WithMarker(error.message, QUICKJS_ERROR_MAX_BYTES, 'MCP host error')
    }
  }
  return {
    name: 'Error',
    message: truncateUtf8WithMarker(String(error), QUICKJS_ERROR_MAX_BYTES, 'MCP host error')
  }
}

function deserializeError(error: { name?: string; message: string; stack?: string }): Error {
  const value = new Error(error.message)
  value.name = error.name || 'Error'
  if (error.stack) value.stack = error.stack
  return value
}

/**
 * Fixed worker bootstrap. `workerData.code` is evaluated only inside QuickJS;
 * Node never evals model-generated code.
 */
const QUICKJS_WORKER_SOURCE = String.raw`
'use strict'
const { parentPort, workerData } = require('node:worker_threads')
const { newQuickJSAsyncWASMModule, isFail } = require(workerData.quickJsModulePath)

let nextRequestId = 0
const pendingToolRequests = new Map()
let cpuDeadline = 0

function byteLength(value) {
  return Buffer.byteLength(String(value), 'utf8')
}

function truncateUtf8(value, maxBytes, label) {
  value = String(value)
  const originalBytes = byteLength(value)
  if (originalBytes <= maxBytes) return value
  const marker = '\n…[' + label + ' truncated: original ' + originalBytes +
    ' UTF-8 bytes; limit ' + maxBytes + ']…'
  const markerBytes = byteLength(marker)
  const budget = Math.max(0, maxBytes - markerBytes)
  let low = 0
  let high = value.length
  while (low < high) {
    const mid = Math.ceil((low + high) / 2)
    if (byteLength(value.slice(0, mid)) <= budget) low = mid
    else high = mid - 1
  }
  if (low > 0 && /[\uD800-\uDBFF]/.test(value.charAt(low - 1))) low--
  if (markerBytes <= maxBytes) return value.slice(0, low) + marker
  low = 0
  high = marker.length
  while (low < high) {
    const mid = Math.ceil((low + high) / 2)
    if (byteLength(marker.slice(0, mid)) <= maxBytes) low = mid
    else high = mid - 1
  }
  return marker.slice(0, low)
}

function serializedBytes(value) {
  const serialized = JSON.stringify(value)
  return byteLength(serialized === undefined ? 'null' : serialized)
}

parentPort.on('message', message => {
  if (!message || message.type !== 'tool-response') return
  const pending = pendingToolRequests.get(message.requestId)
  if (!pending) return
  pendingToolRequests.delete(message.requestId)
  // Asyncified QuickJS is paused while trusted host RPC runs. Extend the pure
  // VM deadline by that pause so user approval does not consume CPU budget.
  cpuDeadline += Math.max(0, Date.now() - pending.startedAt)
  if (message.ok) {
    pending.resolve(message.value)
    return
  }
  const error = new Error(message.error && message.error.message
    ? message.error.message
    : 'Host tool call failed')
  error.name = message.error && message.error.name ? message.error.name : 'Error'
  if (message.error && message.error.stack) error.stack = message.error.stack
  pending.reject(error)
})

function callHost(method, args) {
  return new Promise((resolve, reject) => {
    const requestBytes = serializedBytes(args)
    if (requestBytes > workerData.rpcRequestMaxBytes) {
      reject(new Error('QuickJS ' + method + ' request exceeds ' +
        workerData.rpcRequestMaxBytes + ' UTF-8 bytes'))
      return
    }
    const requestId = ++nextRequestId
    pendingToolRequests.set(requestId, { resolve, reject, startedAt: Date.now() })
    parentPort.postMessage({ type: 'tool-request', requestId, method, args })
  })
}

function registerConsole(ctx, logs) {
  const formatArgs = args => args.map(handle => {
    const value = ctx.dump(handle)
    return typeof value === 'string' ? value : JSON.stringify(value, null, 2)
  }).join(' ')

  let usedBytes = 0
  let truncated = false
  const append = value => {
    if (truncated) return
    const marker = '…[QuickJS logs truncated: limit ' + workerData.logMaxBytes +
      ' UTF-8 bytes / ' + workerData.logMaxEntries + ' entries]…'
    if (logs.length >= workerData.logMaxEntries) {
      const separatorBytes = logs.length > 0 ? 1 : 0
      const remaining = Math.max(0, workerData.logMaxBytes - usedBytes - separatorBytes)
      if (remaining > 0) logs.push(truncateUtf8(marker, remaining, 'QuickJS log marker'))
      truncated = true
      return
    }
    value = String(value)
    const valueBytes = byteLength(value)
    const separatorBytes = logs.length > 0 ? 1 : 0
    if (usedBytes + separatorBytes + valueBytes <= workerData.logMaxBytes) {
      logs.push(value)
      usedBytes += separatorBytes + valueBytes
      return
    }
    const remaining = Math.max(0, workerData.logMaxBytes - usedBytes - separatorBytes)
    if (remaining > 0) logs.push(truncateUtf8(value, remaining, 'QuickJS logs'))
    truncated = true
  }

  const consoleObject = ctx.newObject()
  const log = ctx.newFunction('log', (...args) => { append(formatArgs(args)) })
  const warn = ctx.newFunction('warn', (...args) => { append('[warn] ' + formatArgs(args)) })
  const error = ctx.newFunction('error', (...args) => { append('[error] ' + formatArgs(args)) })
  ctx.setProp(consoleObject, 'log', log)
  ctx.setProp(consoleObject, 'warn', warn)
  ctx.setProp(consoleObject, 'error', error)
  ctx.setProp(ctx.global, 'console', consoleObject)
  log.dispose()
  warn.dispose()
  error.dispose()
  consoleObject.dispose()
}

function registerTools(ctx) {
  const toolsObject = ctx.newObject()

  const search = ctx.newAsyncifiedFunction('search', async (...args) => {
    const query = ctx.getString(args[0])
    const rawLimit = args.length > 1 ? ctx.dump(args[1]) : undefined
    const limit = typeof rawLimit === 'number' && rawLimit > 0 ? rawLimit : undefined
    const results = await callHost('search', [query, limit])
    return ctx.newString(JSON.stringify(results))
  })
  ctx.setProp(toolsObject, 'search', search)
  search.dispose()

  const describe = ctx.newAsyncifiedFunction('describe', async (...args) => {
    const name = ctx.getString(args[0])
    const rawServer = args.length > 1 ? ctx.dump(args[1]) : undefined
    const server = typeof rawServer === 'string' ? rawServer : undefined
    const result = await callHost('describe', [name, server])
    return ctx.newString(result)
  })
  ctx.setProp(toolsObject, 'describe', describe)
  describe.dispose()

  const call = ctx.newAsyncifiedFunction('call', async (...args) => {
    const name = ctx.getString(args[0])
    const rawArgs = args.length > 1 ? ctx.dump(args[1]) : {}
    const toolArgs = typeof rawArgs === 'object' && rawArgs !== null ? rawArgs : {}
    const rawServer = args.length > 2 ? ctx.dump(args[2]) : undefined
    const server = typeof rawServer === 'string' ? rawServer : undefined
    const result = await callHost('call', [name, toolArgs, server])
    return ctx.newString(result)
  })
  ctx.setProp(toolsObject, 'call', call)
  call.dispose()

  ctx.setProp(ctx.global, 'tools', toolsObject)
  toolsObject.dispose()
}

function registerHelpers(ctx) {
  const result = ctx.evalCode('(function() {' +
    'var originalSearch = tools.search;' +
    'tools.search = function(query, limit) {' +
      'var raw = originalSearch(query, limit);' +
      'try { return JSON.parse(raw); } catch (error) { return raw; }' +
    '};' +
    'var originalCall = tools.call;' +
    'tools.call = function(name, args, server) {' +
      'var raw = originalCall(name, args, server);' +
      'try { return JSON.parse(raw); } catch (error) { return raw; }' +
    '};' +
  '})();')
  if (isFail(result)) {
    const error = ctx.dump(result.error)
    result.error.dispose()
    throw new Error(error && error.message ? String(error.message) : String(error))
  }
  result.value.dispose()
}

async function run() {
  const mod = await newQuickJSAsyncWASMModule()
  const logs = []
  const startedAt = Date.now()
  cpuDeadline = startedAt + workerData.timeoutMs
  let runtime
  let ctx

  try {
    runtime = mod.newRuntime()
    runtime.setMemoryLimit(workerData.memoryLimitBytes)
    runtime.setInterruptHandler(() => Date.now() > cpuDeadline)
    ctx = runtime.newContext()
    registerConsole(ctx, logs)
    registerTools(ctx)
    registerHelpers(ctx)

    const result = await ctx.evalCodeAsync(workerData.code, 'mcp_execute.js')
    if (isFail(result)) {
      const dumped = ctx.dump(result.error)
      result.error.dispose()
      const message = dumped && dumped.message ? String(dumped.message) : String(dumped)
      if (message.includes('interrupted')) {
        return {
          logs,
          error: '执行超时（' + (workerData.timeoutMs / 1000) + '秒 CPU 限制）',
          elapsedMs: Date.now() - startedAt,
          timedOut: true
        }
      }
      return {
        logs,
        error: truncateUtf8(message, workerData.errorMaxBytes, 'QuickJS error'),
        elapsedMs: Date.now() - startedAt
      }
    }

    result.value.dispose()
    return { logs, elapsedMs: Date.now() - startedAt }
  } catch (error) {
    const message = error && error.message ? String(error.message) : String(error)
    if (message.includes('interrupted')) {
      return {
        logs,
        error: '执行超时（' + (workerData.timeoutMs / 1000) + '秒 CPU 限制）',
        elapsedMs: Date.now() - startedAt,
        timedOut: true
      }
    }
    return {
      logs,
      error: truncateUtf8(message, workerData.errorMaxBytes, 'QuickJS error'),
      elapsedMs: Date.now() - startedAt
    }
  } finally {
    try { if (ctx) ctx.dispose() } catch {}
    try { if (runtime) runtime.dispose() } catch {}
  }
}

run().then(
  result => parentPort.postMessage({ type: 'result', result }),
  error => parentPort.postMessage({
    type: 'fatal-error',
    error: {
      name: error && error.name ? String(error.name) : 'Error',
      message: error && error.message ? String(error.message) : String(error),
      stack: error && error.stack ? String(error.stack) : undefined
    }
  })
)
`

async function invokeHostTool(
  toolsApi: ToolsApi,
  method: WorkerToolMethod,
  args: unknown[]
): Promise<unknown> {
  assertBoundedRpcRequest(method, args)
  switch (method) {
    case 'search': {
      const query = typeof args[0] === 'string' ? args[0] : ''
      const limit = typeof args[1] === 'number' ? args[1] : undefined
      return toolsApi.search(query, limit)
    }
    case 'describe':
      return toolsApi.describe(
        typeof args[0] === 'string' ? args[0] : '',
        typeof args[1] === 'string' ? args[1] : undefined
      )
    case 'call': {
      const toolName = typeof args[0] === 'string' ? args[0] : ''
      const toolArgs = typeof args[1] === 'object' && args[1] !== null
        ? args[1] as Record<string, unknown>
        : {}
      return toolsApi.call(
        toolName,
        toolArgs,
        typeof args[2] === 'string' ? args[2] : undefined
      )
    }
  }
}

/** Execute model-generated MCP orchestration code in an abortable worker. */
export async function executeInQuickJS(
  code: string,
  toolsApi: ToolsApi,
  options: QuickJsExecutionOptions = {}
): Promise<McpExecutionResult> {
  const timeoutMs = options.timeoutMs ?? QUICKJS_DEFAULT_CPU_TIMEOUT_MS
  const wallTimeoutMs = options.wallTimeoutMs ?? QUICKJS_DEFAULT_WALL_TIMEOUT_MS
  const memoryLimitBytes = options.memoryLimitBytes ?? 50 * 1024 * 1024
  const signal = options.signal
  throwIfSignalAborted(signal)

  const startedAt = Date.now()
  const worker = new Worker(QUICKJS_WORKER_SOURCE, {
    eval: true,
    workerData: {
      code,
      timeoutMs,
      wallTimeoutMs,
      memoryLimitBytes,
      rpcRequestMaxBytes: QUICKJS_RPC_REQUEST_MAX_BYTES,
      logMaxBytes: QUICKJS_LOG_MAX_BYTES,
      logMaxEntries: QUICKJS_LOG_MAX_ENTRIES,
      errorMaxBytes: QUICKJS_ERROR_MAX_BYTES,
      quickJsModulePath
    },
    resourceLimits: {
      maxOldGenerationSizeMb: 64,
      maxYoungGenerationSizeMb: 16,
      stackSizeMb: 4
    }
  })

  return new Promise<McpExecutionResult>((resolve, reject) => {
    let settled = false

    const cleanup = (): void => {
      clearTimeout(wallTimeout)
      signal?.removeEventListener('abort', onAbort)
      worker.removeAllListeners()
    }

    const terminateThen = (
      outcome: { kind: 'resolve'; value: McpExecutionResult }
        | { kind: 'reject'; error: Error }
    ): void => {
      if (settled) return
      settled = true
      cleanup()
      void worker.terminate().then(
        () => {
          if (outcome.kind === 'resolve') resolve(outcome.value)
          else reject(outcome.error)
        },
        (terminationError) => {
          if (outcome.kind === 'reject') reject(outcome.error)
          else reject(new Error(`QuickJS worker shutdown failed: ${String(terminationError)}`))
        }
      )
    }

    const onAbort = (): void => {
      terminateThen({ kind: 'reject', error: abortError(signal!) })
    }

    const settleTimeout = (value: McpExecutionResult): void => {
      if (settled) return
      // Mark and detach first: the callback may synchronously abort a linked
      // signal, but a VM deadline remains a normal tool error, not a user abort.
      settled = true
      cleanup()
      try {
        options.onTimeout?.()
      } catch (error) {
        void worker.terminate().then(
          () => reject(error),
          () => reject(error)
        )
        return
      }
      void worker.terminate().then(
        () => resolve(value),
        (error) => reject(new Error(`QuickJS worker shutdown failed: ${String(error)}`))
      )
    }

    const onWallTimeout = (): void => settleTimeout({
      logs: [],
      error: `执行超时（${wallTimeoutMs / 1000}秒总时限）`,
      elapsedMs: Date.now() - startedAt,
      timedOut: true
    })

    const wallTimeout = setTimeout(onWallTimeout, wallTimeoutMs)
    signal?.addEventListener('abort', onAbort, { once: true })

    worker.on('message', (message: SandboxWorkerMessage) => {
      if (settled || !message) return
      if (message.type === 'result') {
        if (message.result.timedOut) settleTimeout(message.result)
        else terminateThen({ kind: 'resolve', value: message.result })
        return
      }
      if (message.type === 'fatal-error') {
        terminateThen({ kind: 'reject', error: deserializeError(message.error) })
        return
      }

      if (signal?.aborted) {
        onAbort()
        return
      }

      void invokeHostTool(toolsApi, message.method, message.args).then(
        (value) => {
          if (settled) return
          if (signal?.aborted) {
            onAbort()
            return
          }
          try {
            const boundedValue = boundRpcResponse(value)
            worker.postMessage({
              type: 'tool-response',
              requestId: message.requestId,
              ok: true,
              value: boundedValue
            })
          } catch (error) {
            terminateThen({ kind: 'reject', error: deserializeError(serializeError(error)) })
          }
        },
        (error) => {
          if (settled) return
          if (signal?.aborted) {
            onAbort()
            return
          }
          try {
            worker.postMessage({
              type: 'tool-response',
              requestId: message.requestId,
              ok: false,
              error: serializeError(error)
            })
          } catch (postError) {
            terminateThen({ kind: 'reject', error: deserializeError(serializeError(postError)) })
          }
        }
      )
    })
    worker.once('error', (error) => {
      terminateThen({ kind: 'reject', error: new Error(`QuickJS worker failed: ${error.message}`) })
    })
    worker.once('exit', (code) => {
      if (!settled) {
        terminateThen({
          kind: 'reject',
          error: new Error(`QuickJS worker exited before returning a result (code ${code})`)
        })
      }
    })

    // Close the race between the pre-spawn check and listener installation.
    if (signal?.aborted) onAbort()
  })
}

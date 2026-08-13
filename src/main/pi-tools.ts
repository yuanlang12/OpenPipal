/**
 * Legacy Runtime tool facade.
 *
 * The private pi-coding-agent imports are deliberately isolated here so the
 * legacy main loop remains a rollback path while pi-core composes only public
 * core execution tools. Shared product security fixes apply to both paths.
 */
import type { AgentTool } from '@earendil-works/pi-agent-core'
import {
  createCodingTools,
  type BashOperations
} from '../../node_modules/@earendil-works/pi-coding-agent/dist/core/tools/index.js'
import { getWorkingDir } from './config-manager'
// Preserve the legacy facade's historical scheduler side effect. The pi-core
// product tool graph uses the small control registry and does not import this
// rollback-only facade.
import './scheduler'
import {
  AskUserResolver,
  buildOpenPipalProductTools,
  filterOpenPipalTools,
  type CodeExecutionBackend,
  type OpenPipalProductToolOptions
} from './openpipal-product-tools'
import type { ChatSource } from './agent-runtime/contracts'
import { filterToolsForChatSource } from './agent-runtime/source-tool-policy'
import {
  createOpenPipalFindTool,
  createOpenPipalGrepTool,
  createOpenPipalLsTool
} from './agent-runtime/openpipal-search-tools'
import { bindHarnessToolsContext } from './agent-runtime/pi-core-tool-adapter'
import { createDiscoveryToolContext } from './agent-runtime/discovery-tool-context'

export { AskUserResolver }
export type { ChatSource } from './agent-runtime/contracts'

export const executeCodeWithLegacyPi: CodeExecutionBackend = async ({ command, signal }) => {
  // Dynamic loading keeps the rollback facade independent at import time while
  // using the same product-owned process boundary after execution is approved.
  const { OPENPIPAL_EXECUTE_CODE_TIMEOUT_SECONDS, OpenPipalNodeExecutionEnv } =
    await import('./openpipal-execution-env')
  const env = new OpenPipalNodeExecutionEnv(getWorkingDir())
  try {
    const result = await env.exec(command, {
      timeout: OPENPIPAL_EXECUTE_CODE_TIMEOUT_SECONDS,
      abortSignal: signal
    })
    if (!result.ok) throw result.error
    return result.value
  } finally {
    await env.cleanup()
  }
}

function createOpenPipalBoundedBashOps(): BashOperations {
  return {
    exec: async (command, cwd, options) => {
      // Do not statically load the new Node backend when legacy is selected.
      // OpenPipalNodeExecutionEnv applies sanitization, timeout/output bounds,
      // abort propagation and (when enabled) exactly one strict SRT wrapper.
      const { OpenPipalNodeExecutionEnv } = await import('./openpipal-execution-env')
      const env = new OpenPipalNodeExecutionEnv(cwd)
      try {
        const forwardedEnv = Object.fromEntries(
          Object.entries(options.env || {})
            .filter((entry): entry is [string, string] => typeof entry[1] === 'string')
        )
        const result = await env.exec(command, {
          timeout: options.timeout,
          abortSignal: options.signal,
          env: forwardedEnv,
          onStdout: chunk => options.onData(Buffer.from(chunk, 'utf8')),
          onStderr: chunk => options.onData(Buffer.from(chunk, 'utf8'))
        })
        if (!result.ok) throw result.error
        return { exitCode: result.value.exitCode }
      } finally {
        await env.cleanup()
      }
    }
  }
}

/** Preserve the existing legacy tool list, order, schemas, and filtering. */
export function buildPiTools(
  source: ChatSource,
  askUserResolver: AskUserResolver,
  overrides?: OpenPipalProductToolOptions
): AgentTool[] {
  const productTools = buildOpenPipalProductTools(source, askUserResolver, {
    ...overrides,
    executeCodeBackend: executeCodeWithLegacyPi
  })
  const cwd = overrides?.workingDir || getWorkingDir()
  const codingTools = createCodingTools(cwd, {
    bash: { operations: createOpenPipalBoundedBashOps() }
  })
  // Legacy and pi-core must share the product-owned search worker: the private
  // coding-agent discovery tools cannot enforce OpenPipal's credential skips.
  // The context resolves paths only, and loads its backend on first use — the
  // rollback facade must not pull pi-core's Node backend in at import time.
  const discoveryTools = bindHarnessToolsContext([
    createOpenPipalGrepTool(),
    createOpenPipalFindTool(),
    createOpenPipalLsTool()
  ], createDiscoveryToolContext(cwd))
  return filterToolsForChatSource(
    source,
    filterOpenPipalTools([...productTools, ...codingTools, ...discoveryTools], overrides)
  )
}

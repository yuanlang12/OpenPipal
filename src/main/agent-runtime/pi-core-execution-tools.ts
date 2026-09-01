import {
  createBashTool,
  createEditTool,
  createReadTool,
  createWriteTool,
  type AgentHarnessTool,
  type ExecutionToolContext
} from '@earendil-works/pi-agent-core'
import {
  OPENPIPAL_EXECUTE_CODE_TIMEOUT_SECONDS,
  OPENPIPAL_DEFAULT_SHELL_TIMEOUT_SECONDS,
  OPENPIPAL_MAX_SHELL_TIMEOUT_SECONDS,
  OpenPipalNodeExecutionEnv,
  type OpenPipalExecutionPolicy
} from '../openpipal-execution-env'
import { forceSequentialHarnessTool } from './pi-core-tool-adapter'
import { processPiCoreReadImage } from './pi-core-read-image'
import {
  createOpenPipalFindTool,
  createOpenPipalGrepTool,
  createOpenPipalLsTool
} from './openpipal-search-tools'

export interface PiCoreExecutionToolBundle {
  tools: AgentHarnessTool<ExecutionToolContext>[]
  toolContext: ExecutionToolContext
  executeCode(request: {
    command: string
    workingDir: string
    signal?: AbortSignal
  }): Promise<{ stdout: string; stderr: string; exitCode: number }>
  dispose(): Promise<void>
}

function createOpenPipalBashTool(): ReturnType<typeof createBashTool> {
  const tool = createBashTool()
  const execute = tool.execute.bind(tool)
  return {
    ...tool,
    description: tool.description.replace(
      'Optionally provide a timeout in seconds.',
      `The default timeout is ${OPENPIPAL_DEFAULT_SHELL_TIMEOUT_SECONDS} seconds and the maximum is ${OPENPIPAL_MAX_SHELL_TIMEOUT_SECONDS} seconds.`
    ),
    execute(toolCallId, params, signal, onUpdate, context) {
      // Passing the product default into the official tool preserves its
      // timeout/error wording instead of reporting "undefined seconds" when
      // the lower execution layer enforces the default.
      const timeout = params.timeout ?? OPENPIPAL_DEFAULT_SHELL_TIMEOUT_SECONDS
      if (timeout > OPENPIPAL_MAX_SHELL_TIMEOUT_SECONDS) {
        throw new Error(
          `Invalid timeout: OpenPipal allows at most ${OPENPIPAL_MAX_SHELL_TIMEOUT_SECONDS} seconds`
        )
      }
      return execute(
        toolCallId,
        {
          ...params,
          timeout
        },
        signal,
        onUpdate,
        context
      )
    }
  }
}

/** Build one conversation-scoped public pi-core execution environment. */
export function buildPiCoreExecutionTools(
  workingDir: string,
  executionPolicy: Partial<OpenPipalExecutionPolicy> = {},
  /** 只用于 git 项目授权的「本次对话」那一半；不传 = 只认持久授权。 */
  conversationId?: string
): PiCoreExecutionToolBundle {
  const env = new OpenPipalNodeExecutionEnv(workingDir, executionPolicy, conversationId)
  const tools: AgentHarnessTool<ExecutionToolContext>[] = [
    createReadTool({ imageProcessor: processPiCoreReadImage }),
    createOpenPipalBashTool(),
    createEditTool(),
    createWriteTool(),
    createOpenPipalGrepTool(),
    createOpenPipalFindTool(),
    createOpenPipalLsTool()
  ]
  let disposed = false
  return {
    tools: tools.map(forceSequentialHarnessTool),
    toolContext: { env },
    async executeCode(request) {
      const result = await env.exec(request.command, {
        timeout: OPENPIPAL_EXECUTE_CODE_TIMEOUT_SECONDS,
        abortSignal: request.signal
      })
      if (!result.ok) throw result.error
      return result.value
    },
    async dispose(): Promise<void> {
      if (disposed) return
      disposed = true
      await env.cleanup()
    }
  }
}

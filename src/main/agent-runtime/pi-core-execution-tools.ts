import {
  createBashTool,
  createEditTool,
  createReadTool,
  createWriteTool,
  type AgentHarnessTool,
  type ExecutionToolContext
} from '@earendil-works/pi-agent-core'
import { Type } from 'typebox'
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

/** Windows 才有 PowerShell 实体；别的平台上 COMMON_TOOLS 里那个名字只是占位（同扩展未连接时的 browser_*）。 */
export function offersPowerShellTool(platform: NodeJS.Platform = process.platform): boolean {
  return platform === 'win32'
}

/**
 * pi-agent-core 只带 bash 工具（powershell 那份住在私有的 pi-coding-agent 里）。这里不复刻
 * 一遍输出截断 / 进度节流 / 退出码措辞，而是拿产品化的 bash 工具换名字、换说明、换执行环境：
 * 同一份 execute，只是 context.env 指到一个以 PowerShell 为 shell 的 OpenPipalNodeExecutionEnv。
 */
function createOpenPipalPowerShellTool(
  powerShellEnv: OpenPipalNodeExecutionEnv
): ReturnType<typeof createBashTool> {
  const bash = createOpenPipalBashTool()
  return {
    ...bash,
    name: 'powershell',
    label: 'powershell',
    description: bash.description.replace(
      'Execute a bash command in the current working directory.',
      'Execute a PowerShell command (pwsh, falling back to Windows PowerShell 5.1) in the current working directory. Windows only. Prefer `bash` (Git Bash) for POSIX-style commands and scripts; use this tool for Windows-native cmdlets, .ps1 scripts, the registry, services and scheduled tasks.'
    ),
    parameters: Type.Object({
      command: Type.String({ description: 'PowerShell command to execute' }),
      timeout: Type.Optional(Type.Number({ description: 'Timeout in seconds (optional)' }))
    }),
    execute(toolCallId, params, signal, onUpdate, context) {
      return bash.execute(toolCallId, params, signal, onUpdate, { ...context, env: powerShellEnv })
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
  const powerShellEnv = offersPowerShellTool()
    ? new OpenPipalNodeExecutionEnv(workingDir, executionPolicy, conversationId, 'powershell')
    : null
  const tools: AgentHarnessTool<ExecutionToolContext>[] = [
    createReadTool({ imageProcessor: processPiCoreReadImage }),
    createOpenPipalBashTool(),
    ...(powerShellEnv ? [createOpenPipalPowerShellTool(powerShellEnv)] : []),
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
      await powerShellEnv?.cleanup()
    }
  }
}

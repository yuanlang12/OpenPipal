import type {
  AgentHarnessTool,
  AgentTool,
  ExecutionToolContext
} from '@earendil-works/pi-agent-core'
import { buildMcpBridgeTools } from '../pi-mcp-bridge'
import {
  AskUserResolver,
  buildOpenPipalProductTools,
  filterOpenPipalTools
} from '../openpipal-product-tools'
import type { AgentOverrides, ChatSource } from './contracts'
import { buildPiCoreExecutionTools } from './pi-core-execution-tools'
import {
  bindHarnessToolsContext,
  toSequentialHarnessTool
} from './pi-core-tool-adapter'
import { filterToolsForChatSource } from './source-tool-policy'

export interface PiCoreToolBuildOptions {
  source: ChatSource
  overrides?: AgentOverrides
  workingDir: string
  disabledTools?: string[]
  mcpServers?: string[]
}

export interface PiCoreHarnessToolBundle {
  tools: AgentHarnessTool<ExecutionToolContext>[]
  toolContext: ExecutionToolContext
  askUserResolver: AskUserResolver
  dispose(): Promise<void>
}

export interface PiCoreAgentToolBundle extends Omit<PiCoreHarnessToolBundle, 'tools'> {
  tools: AgentTool[]
}

/**
 * Transitional product-tool bridge. Phase 5 replaces the legacy coding tools
 * inside buildPiTools with pi-core's public execution tools; product tools and
 * their OpenPipal result details already use the public AgentTool contract.
 */
export function buildPiCoreHarnessTools(options: PiCoreToolBuildOptions): PiCoreHarnessToolBundle {
  const askUserResolver = new AskUserResolver()
  const execution = buildPiCoreExecutionTools(options.workingDir)
  const productTools = buildOpenPipalProductTools(options.source, askUserResolver, {
    tools: options.overrides?.tools,
    disabledTools: options.disabledTools,
    roleName: options.overrides?.roleName,
    workingDir: options.workingDir,
    modelPresetId: options.overrides?.modelPresetId,
    workspaceId: options.overrides?.workspaceId,
    conversationId: options.overrides?.conversationId,
    roleBrief: options.overrides?.roleBrief,
    executeCodeBackend: execution.executeCode
  })
  const productAndExecutionTools = filterOpenPipalTools<AgentHarnessTool<ExecutionToolContext>>(
    [
      ...productTools.map((tool) => toSequentialHarnessTool<ExecutionToolContext>(tool)),
      ...execution.tools
    ],
    {
      tools: options.overrides?.tools,
      disabledTools: options.disabledTools,
      roleName: options.overrides?.roleName,
      conversationId: options.overrides?.conversationId
    }
  )
  const mcpTools = buildMcpBridgeTools(
    options.mcpServers,
    options.overrides?.conversationId,
    options.source
  )
  return {
    askUserResolver,
    toolContext: execution.toolContext,
    tools: filterToolsForChatSource(options.source, [
      ...productAndExecutionTools,
      ...mcpTools.map((tool) => toSequentialHarnessTool<ExecutionToolContext>(tool))
    ]),
    dispose: execution.dispose
  }
}

/** Build the same product surface as plain Agent tools with a fixed turn context. */
export function buildPiCoreAgentTools(options: PiCoreToolBuildOptions): PiCoreAgentToolBundle {
  const bundle = buildPiCoreHarnessTools(options)
  return {
    ...bundle,
    tools: bindHarnessToolsContext(bundle.tools, bundle.toolContext)
  }
}

export {
  bindHarnessToolContext,
  bindHarnessToolsContext,
  toSequentialHarnessTool
} from './pi-core-tool-adapter'

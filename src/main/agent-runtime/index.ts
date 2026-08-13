import type { OpenPipalAgentRuntime } from './contracts'
import type { PermissionHandler } from '../pi-security'
import { loadLegacyAgentRuntime } from './legacy-runtime'
import { assertPiCoreNodeVersionSupported } from './pi-core-compatibility'
import { createAgentRuntimeHost } from './runtime-host'
import { AGENT_RUNTIME_ENV, resolveAgentRuntimeSelection } from './runtime-selection'

export type {
  AgentEvent,
  AgentOverrides,
  AgentRuntimeKind,
  ChatMessage,
  ChatSource,
  RunningAgentHandle,
  RuntimeUserInput,
  OpenPipalAgentRuntime
} from './contracts'
export { AGENT_RUNTIME_ENV, resolveAgentRuntimeSelection } from './runtime-selection'

async function loadSelectedRuntime(): Promise<OpenPipalAgentRuntime> {
  const selection = resolveAgentRuntimeSelection(process.env[AGENT_RUNTIME_ENV])
  if (selection.warning) console.warn(selection.warning)

  if (selection.kind === 'pi-core') {
    assertPiCoreNodeVersionSupported()
    console.log('[AgentRuntime] selected pi-core runtime')
    const { loadPiCoreAgentRuntime } = await import('./pi-core-runtime')
    return loadPiCoreAgentRuntime()
  }

  console.log('[AgentRuntime] selected legacy runtime')
  return loadLegacyAgentRuntime()
}

const runtimeHost = createAgentRuntimeHost(loadSelectedRuntime)

/**
 * Process-lifetime Runtime selection. Switching implementation requires a
 * restart, which prevents an active conversation from changing semantics midway.
 */
export function getAgentRuntime(): Promise<OpenPipalAgentRuntime> {
  return runtimeHost.getRuntime()
}

/** Register product permission policy without forcing the Runtime to load at boot. */
export function setAgentRuntimePermissionHandler(handler: PermissionHandler): void {
  runtimeHost.setPermissionHandler(handler)
}

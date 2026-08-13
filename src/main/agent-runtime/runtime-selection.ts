import type { AgentRuntimeKind } from './contracts'

export const AGENT_RUNTIME_ENV = 'OPENPIPAL_AGENT_RUNTIME'

export interface AgentRuntimeSelection {
  requested?: string
  kind: AgentRuntimeKind
  usedDefault: boolean
  warning?: string
}

/**
 * Resolve the requested Runtime without loading either implementation.
 *
 * Default is `pi-core` since the controlled trial cleared its gate. `legacy`
 * stays reachable as the rollback valve: an unsupported value still falls back
 * to it, because an unreadable configuration must not silently run the newer
 * path. Legacy is retained until its registered sunset condition is met.
 */
export function resolveAgentRuntimeSelection(raw?: string): AgentRuntimeSelection {
  if (raw === undefined || raw.trim() === '') {
    return { requested: raw, kind: 'pi-core', usedDefault: true }
  }
  if (raw === 'legacy' || raw === 'pi-core') {
    return { requested: raw, kind: raw, usedDefault: false }
  }
  return {
    requested: raw,
    kind: 'legacy',
    usedDefault: true,
    warning: `[AgentRuntime] Unsupported ${AGENT_RUNTIME_ENV}=${raw}; falling back to legacy`
  }
}

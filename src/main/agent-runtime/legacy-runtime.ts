import type { OpenPipalAgentRuntime } from './contracts'

/** Lazy adapter: importing the router must not pull the full Pi tool graph at boot. */
export async function loadLegacyAgentRuntime(): Promise<OpenPipalAgentRuntime> {
  const service = await import('../pi-agent-service')
  return Object.freeze({
    kind: 'legacy' as const,
    agentChat: service.agentChat,
    setPermissionHandler: service.setPermissionHandler,
    testThinkingSupport: service.testThinkingSupport
  })
}

import type { PermissionHandler } from '../pi-security'
import type { OpenPipalAgentRuntime } from './contracts'

export type AgentRuntimeLoader = () => Promise<OpenPipalAgentRuntime>

/**
 * Owns the process-lifetime Runtime instance without knowing which implementation
 * is selected. Dependency injection keeps load/retry/permission ordering testable.
 */
export function createAgentRuntimeHost(loadRuntime: AgentRuntimeLoader) {
  let runtimePromise: Promise<OpenPipalAgentRuntime> | null = null
  let runtimeInstance: OpenPipalAgentRuntime | null = null
  let permissionHandler: PermissionHandler | null = null

  const getRuntime = (): Promise<OpenPipalAgentRuntime> => {
    if (runtimeInstance) return Promise.resolve(runtimeInstance)
    if (!runtimePromise) {
      runtimePromise = loadRuntime()
        .then((runtime) => {
          if (permissionHandler) runtime.setPermissionHandler(permissionHandler)
          runtimeInstance = runtime
          return runtime
        })
        .catch((error) => {
          // Module initialization failed before a run started, so a later request
          // may retry. Once an instance exists it is never swapped in place.
          runtimePromise = null
          throw error
        })
    }
    return runtimePromise
  }

  const setPermissionHandler = (handler: PermissionHandler): void => {
    permissionHandler = handler
    runtimeInstance?.setPermissionHandler(handler)
  }

  return { getRuntime, setPermissionHandler }
}

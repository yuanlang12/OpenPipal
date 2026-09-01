import { PiV4JsonlSessionStore, type PiV4JsonlSessionStoreOptions } from './pi-v4-jsonl-session-store'
import { resolveNewSessionStorageKind } from './session-store'

export * from './conversation-projector'
export * from './openpipal-session-events'
export * from './pi-v4-jsonl-session-store'
export * from './secure-session-filesystem'
export * from './session-index'
export * from './session-store'

/** Returns null unless the controlled rollout flag explicitly selects v4. */
export function createPiV4SessionStoreIfEnabled(
  options?: PiV4JsonlSessionStoreOptions
): PiV4JsonlSessionStore | null {
  return resolveNewSessionStorageKind() === 'pi-jsonl-v4'
    ? new PiV4JsonlSessionStore(options)
    : null
}

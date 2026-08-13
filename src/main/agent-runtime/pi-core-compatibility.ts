export const PI_CORE_NODE_ENGINE = '>=22.19.0'

const MINIMUM_NODE = Object.freeze({ major: 22, minor: 19, patch: 0 })

function parseNodeVersion(version: string): [number, number, number] | null {
  // Build metadata does not affect precedence, but a prerelease is lower than
  // the matching stable version and must not satisfy the production floor.
  const match = /^(\d+)\.(\d+)\.(\d+)(?:\+.*)?$/.exec(version.trim())
  if (!match) return null
  return [Number(match[1]), Number(match[2]), Number(match[3])]
}

/** The installed pi-core Harness declares Node >=22.19.0 as its support floor. */
export function isPiCoreNodeVersionSupported(version: string): boolean {
  const parsed = parseNodeVersion(version)
  if (!parsed) return false
  const [major, minor, patch] = parsed
  if (major !== MINIMUM_NODE.major) return major > MINIMUM_NODE.major
  if (minor !== MINIMUM_NODE.minor) return minor > MINIMUM_NODE.minor
  return patch >= MINIMUM_NODE.patch
}

/** Fail closed before an unsupported Electron runtime can activate pi-core. */
export function assertPiCoreNodeVersionSupported(version = process.versions.node): void {
  if (isPiCoreNodeVersionSupported(version)) return
  throw new Error(
    `[AgentRuntime] pi-core requires Node ${PI_CORE_NODE_ENGINE}; current Electron Node is ${version}`
  )
}

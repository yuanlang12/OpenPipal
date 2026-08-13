/**
 * Authoritative filesystem locations that may persist credentials.
 *
 * Keep this module free of Electron imports so authentication, persistence,
 * model-facing file policy, and the OS sandbox can share the same paths
 * without introducing main-process dependency cycles.
 */
import path from 'path'
import os from 'os'
import { dataPath, getDataRoot, getOpenPipalHome } from './data-root'

export function getOpenPipalConfigPath(): string {
  return dataPath('config.json')
}

export function getOpenPipalConfigBackupPath(): string {
  return dataPath('config.json.bak-pre-providers')
}

export function getAcpMcpTokenPath(): string {
  return dataPath('acp-mcp.token')
}

export function getMcpOAuthRootPath(): string {
  return dataPath('oauth')
}

export function getUserMcpConfigPath(): string {
  return dataPath('mcp-servers.json')
}

/** User grants for MCP App device/browser capabilities. */
export function getMcpAppPermissionsPath(): string {
  return dataPath('mcp-app-permissions.json')
}

/** Persistent browser allow/block policy; writing it changes authorization. */
export function getBrowserControlPolicyPath(): string {
  return dataPath('browser-control', 'policy.json')
}

export function getTasksRootPath(): string {
  return dataPath('tasks')
}

export function getAuditLogPath(): string {
  return dataPath('audit.log')
}

export function getPluginsRootPath(): string {
  return dataPath('plugins')
}

/** The dotenv file loaded by src/main/env.ts during development. */
export function getDevelopmentEnvPath(): string {
  return path.resolve(__dirname, '../../.env')
}

/** Exact files/directories denied to model-facing reads and sandboxed code. */
export function getCredentialReadDenyPaths(): string[] {
  return [
    getOpenPipalConfigPath(),
    getOpenPipalConfigBackupPath(),
    getAcpMcpTokenPath(),
    getMcpOAuthRootPath(),
    getUserMcpConfigPath(),
    getMcpAppPermissionsPath(),
    getBrowserControlPolicyPath(),
    getTasksRootPath(),
    getAuditLogPath(),
    getDevelopmentEnvPath(),
  ]
}

/** Credential directories whose descendants are all secret-bearing. */
export function getCredentialReadDenyRoots(): string[] {
  return [
    getMcpOAuthRootPath(),
    getTasksRootPath(),
  ]
}

/** Roots that must not be recursively enumerated because they contain exact credentials. */
export function getCredentialDiscoveryDenyRoots(): string[] {
  return [
    getDataRoot(),
    ...getCredentialReadDenyRoots(),
  ]
}

/**
 * Sandbox-only globs. Do not feed these through path.resolve/realpath policy
 * helpers: SRT expands them (or translates them to Seatbelt regex rules).
 */
export function buildSensitiveReadGlobs(
  openpipalHome = getOpenPipalHome(),
  systemHome = os.homedir(),
  pluginsRoot = getPluginsRootPath()
): string[] {
  return [
    ...Array.from(new Set([openpipalHome, systemHome].map(home => path.join(home, '**', '.env*')))),
    // workingDir can be /tmp, /Volumes, or another user-selected root. Shell
    // and code tools do not pass through the structured basename filter, so
    // the OS sandbox must cover dotenv files independent of their parent.
    '/**/.[eE][nN][vV]*',
    path.join(pluginsRoot, '*', 'mcp.json'),
  ]
}

export const SENSITIVE_READ_GLOBS = buildSensitiveReadGlobs()

/** Exact persisted plugin MCP config: <plugins>/<one plugin>/mcp.json. */
export function isPluginMcpConfigPath(
  candidatePath: string,
  pluginsRoot = getPluginsRootPath()
): boolean {
  const relative = path.relative(path.resolve(pluginsRoot), path.resolve(candidatePath))
  if (!relative || path.isAbsolute(relative) || relative === '..' || relative.startsWith(`..${path.sep}`)) {
    return false
  }
  const segments = relative.split(path.sep)
  return segments.length === 2
    && segments[0].length > 0
    && segments[1].toLowerCase() === 'mcp.json'
}

/** Whether a discovery root can enumerate one or more plugin MCP configs. */
export function discoveryRootContainsPluginMcpConfig(
  candidatePath: string,
  pluginsRoot = getPluginsRootPath()
): boolean {
  const relative = path.relative(path.resolve(pluginsRoot), path.resolve(candidatePath))
  if (path.isAbsolute(relative) || relative === '..' || relative.startsWith(`..${path.sep}`)) return false
  if (!relative) return true
  const segments = relative.split(path.sep)
  return segments.length === 1 && segments[0].length > 0
}

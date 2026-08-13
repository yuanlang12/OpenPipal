import { chmodSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { randomBytes, timingSafeEqual } from 'crypto'
import { dirname } from 'path'
import { getAcpMcpTokenPath } from './credential-paths'

export { getAcpMcpTokenPath } from './credential-paths'

/** Header required for ACP session-scoped MCP registration and cleanup. */
export const ACP_MCP_AUTH_HEADER = 'x-openpipal-acp-token'

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/

/**
 * Creates (or reuses) the local secret shared only by the desktop app and its
 * native ACP adapter. The token file is intentionally not served over HTTP.
 */
export function ensureAcpMcpToken(tokenPath: string = getAcpMcpTokenPath()): string {
  try {
    const stat = lstatSync(tokenPath)
    if (!stat.isFile()) {
      throw new Error(`ACP MCP token path is not a regular file: ${tokenPath}`)
    }

    const existing = readFileSync(tokenPath, 'utf8').trim()
    if (TOKEN_PATTERN.test(existing)) {
      // Keep a pre-existing token private even if it was created by an older build.
      chmodSync(tokenPath, 0o600)
      return existing
    }
  } catch (err: any) {
    if (err?.code !== 'ENOENT') throw err
  }

  mkdirSync(dirname(tokenPath), { recursive: true, mode: 0o700 })
  const token = randomBytes(32).toString('base64url')
  writeFileSync(tokenPath, `${token}\n`, { encoding: 'utf8', mode: 0o600 })
  chmodSync(tokenPath, 0o600)
  return token
}

/** Constant-time comparison for the untrusted HTTP request header. */
export function isAcpMcpTokenValid(
  supplied: string | string[] | undefined,
  expected: string,
): boolean {
  if (typeof supplied !== 'string' || !TOKEN_PATTERN.test(supplied) || !TOKEN_PATTERN.test(expected)) {
    return false
  }

  const suppliedBuffer = Buffer.from(supplied)
  const expectedBuffer = Buffer.from(expected)
  return suppliedBuffer.length === expectedBuffer.length && timingSafeEqual(suppliedBuffer, expectedBuffer)
}

import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  ACP_MCP_AUTH_HEADER,
  ensureAcpMcpToken,
  getAcpMcpTokenPath,
  isAcpMcpTokenValid,
} from '../../src/main/acp-auth'
import { getAcpMcpTokenPath as getAuthoritativeAcpMcpTokenPath } from '../../src/main/credential-paths'

const tempDirs: string[] = []

function tokenPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'openpipal-acp-auth-'))
  tempDirs.push(dir)
  return join(dir, 'nested', 'acp-mcp.token')
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('ACP MCP authorization token', () => {
  it('uses the shared authoritative credential path', () => {
    expect(getAcpMcpTokenPath()).toBe(getAuthoritativeAcpMcpTokenPath())
  })

  it('creates a private stable token for the native adapter', () => {
    const path = tokenPath()
    const first = ensureAcpMcpToken(path)
    const second = ensureAcpMcpToken(path)

    expect(first).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(second).toBe(first)
    expect(statSync(path).mode & 0o077).toBe(0)
  })

  it('only accepts the exact single-value authorization header', () => {
    const token = ensureAcpMcpToken(tokenPath())

    expect(ACP_MCP_AUTH_HEADER).toBe('x-openpipal-acp-token')
    expect(isAcpMcpTokenValid(token, token)).toBe(true)
    expect(isAcpMcpTokenValid(undefined, token)).toBe(false)
    expect(isAcpMcpTokenValid(`${token.slice(0, -1)}x`, token)).toBe(false)
    expect(isAcpMcpTokenValid([token], token)).toBe(false)
  })
})

import fs from 'node:fs'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const storePath = vi.hoisted(() => `/tmp/openpipal-mcp-app-permissions-${process.pid}.json`)

vi.mock('../../src/main/credential-paths', () => ({
  getMcpAppPermissionsPath: () => storePath,
}))

describe('MCP App capability permission connection scope', () => {
  beforeEach(() => {
    vi.resetModules()
    try { fs.unlinkSync(storePath) } catch {}
  })

  it('isolates same-name connections and ignores historical name-only grants', async () => {
    fs.writeFileSync(storePath, JSON.stringify({
      'same-name': ['camera'],
    }), { mode: 0o644 })
    const permissions = await import('../../src/main/mcp-app-permissions')

    expect(permissions.getMcpAppPermissions('same-name', 'binding-one')).toEqual([])
    expect(permissions.approveMcpAppPermissions(
      'same-name',
      'binding-one',
      ['microphone', 'unknown-capability']
    )).toEqual(['microphone'])
    expect(permissions.getMcpAppPermissions('same-name', 'binding-one')).toEqual(['microphone'])
    expect(permissions.getMcpAppPermissions('same-name', 'binding-two')).toEqual([])
    expect(fs.statSync(storePath).mode & 0o077).toBe(0)

    const stored = JSON.parse(fs.readFileSync(storePath, 'utf8'))
    expect(stored['same-name']).toEqual(['camera'])
    expect(stored[JSON.stringify(['v2', 'same-name', 'binding-one'])]).toEqual(['microphone'])
    expect(stored[JSON.stringify(['v2', 'same-name', 'binding-two'])]).toBeUndefined()
  })

  it('fails closed for missing or invalid bindings without creating grants', async () => {
    const permissions = await import('../../src/main/mcp-app-permissions')
    expect(permissions.getMcpAppPermissions('same-name', '')).toEqual([])
    expect(permissions.approveMcpAppPermissions('same-name', '', ['camera'])).toEqual([])
    expect(permissions.approveMcpAppPermissions('same-name', 'x'.repeat(129), ['camera'])).toEqual([])
    expect(fs.existsSync(storePath)).toBe(false)
  })
})

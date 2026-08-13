import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

const isolatedHome = mkdtempSync(join(tmpdir(), 'openpipal-mcp-skill-path-'))
process.env.OPENPIPAL_ISOLATED_HOME = isolatedHome

const sdk = vi.hoisted(() => ({
  resources: [] as Array<{ uri: string }>,
  readResource: vi.fn()
}))

vi.mock('electron', () => ({
  app: { isPackaged: false }
}))

vi.mock('../../src/main/mcp-oauth', () => ({
  createOAuthProvider: vi.fn(),
  awaitAuthorizationCode: vi.fn(),
  hasPersistedOAuthSession: vi.fn(() => false),
  revokeOAuthSession: vi.fn()
}))

vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: class MockMcpClient {
    connect = vi.fn(async () => undefined)
    listTools = vi.fn(async () => ({ tools: [] }))
    listResources = vi.fn(async () => ({ resources: sdk.resources }))
    readResource = sdk.readResource
    close = vi.fn(async () => undefined)
  }
}))

vi.mock('@modelcontextprotocol/sdk/client/stdio.js', () => ({
  StdioClientTransport: class MockStdioTransport {}
}))

vi.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => ({
  StreamableHTTPClientTransport: class MockHttpTransport {}
}))

const {
  addMcpServer,
  resolveMcpSkillResourceTarget,
  shutdownMcp
} = await import('../../src/main/mcp-manager')

describe('MCP suggested-skill resource path boundary', () => {
  beforeEach(async () => {
    await shutdownMcp()
    vi.clearAllMocks()
    sdk.resources = []
    sdk.readResource.mockImplementation(async ({ uri }: { uri: string }) => ({
      contents: [{ uri, text: `content for ${uri}` }]
    }))
  })

  afterAll(async () => {
    await shutdownMcp()
    delete process.env.OPENPIPAL_ISOLATED_HOME
    rmSync(isolatedHome, { recursive: true, force: true })
  })

  it.each([
    'skill://../escaped/SKILL.md',
    'skill://planner/../../escaped.md',
    'skill://planner/%2e%2e/escaped.md',
    'skill://planner/%2Ftmp/escaped.md',
    'skill://planner/%5C..%5Cescaped.md',
    'skill://planner//SKILL.md'
  ])('rejects traversal or ambiguous resource URI %s', (uri) => {
    expect(resolveMcpSkillResourceTarget('trusted-server', uri)).toBeNull()
  })

  it('rejects a server name that is not one directory segment', () => {
    expect(resolveMcpSkillResourceTarget('../other-server', 'skill://planner/SKILL.md')).toBeNull()
    expect(resolveMcpSkillResourceTarget('nested/server', 'skill://planner/SKILL.md')).toBeNull()
  })

  it('keeps valid nested resources inside the owning server directory', () => {
    const target = resolveMcpSkillResourceTarget(
      'trusted-server',
      'skill://lesson-planner/references/guide.md'
    )

    expect(target).toBe(join(
      isolatedHome,
      '.openpipal',
      'skills',
      '_mcp',
      'trusted-server',
      'lesson-planner',
      'references',
      'guide.md'
    ))
  })

  it('does not fetch or write an escaping resource while preserving valid skill sync', async () => {
    sdk.resources = [
      { uri: 'skill://planner/../../escaped.md' },
      { uri: 'skill://planner/SKILL.md' },
      { uri: 'skill://planner/references/guide.md' }
    ]

    await addMcpServer('trusted-server', { url: 'https://mcp.invalid.test' })

    expect(sdk.readResource).toHaveBeenCalledTimes(2)
    expect(sdk.readResource).not.toHaveBeenCalledWith({
      uri: 'skill://planner/../../escaped.md'
    })
    expect(existsSync(join(
      isolatedHome,
      '.openpipal',
      'skills',
      '_mcp',
      'escaped.md'
    ))).toBe(false)
    expect(readFileSync(join(
      isolatedHome,
      '.openpipal',
      'skills',
      '_mcp',
      'trusted-server',
      'planner',
      'SKILL.md'
    ), 'utf8')).toContain('skill://planner/SKILL.md')
    expect(readFileSync(join(
      isolatedHome,
      '.openpipal',
      'skills',
      '_mcp',
      'trusted-server',
      'planner',
      'references',
      'guide.md'
    ), 'utf8')).toContain('skill://planner/references/guide.md')
  })
})

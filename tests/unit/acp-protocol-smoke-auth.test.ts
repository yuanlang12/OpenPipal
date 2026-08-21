import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('offline ACP protocol smoke authentication', () => {
  const smoke = readFileSync(resolve('openpipal-acp/scripts/protocol-compat-smoke.mjs'), 'utf8')
  const readme = readFileSync(resolve('openpipal-acp/README.md'), 'utf8')

  it('uses an isolated HOME and a fixed valid token instead of user state', () => {
    expect(smoke).toContain("const SMOKE_TOKEN = 's'.repeat(43)")
    expect(smoke).toContain('HOME: smokeHome')
    expect(smoke).toContain('USERPROFILE: smokeHome')
    expect(smoke).toContain('OPENPIPAL_ACP_TOKEN: SMOKE_TOKEN')
    expect(smoke.indexOf('OPENPIPAL_ACP_TOKEN: SMOKE_TOKEN')).toBeGreaterThan(smoke.indexOf('...extraEnv'))
    expect(smoke.indexOf('HOME: smokeHome')).toBeGreaterThan(smoke.indexOf('...extraEnv'))
    expect(smoke.indexOf('OPENPIPAL_BASE_URL: baseUrl')).toBeGreaterThan(smoke.indexOf('...extraEnv'))
    expect(smoke).not.toContain("homedir()")
    expect(smoke).not.toContain("'.openpipal', 'acp-mcp.token'")
  })

  it('fails closed when the prebuilt adapter bundle is stale or lacks Runtime R1 markers', () => {
    expect(smoke).toContain('function assertFreshAdapterBundle()')
    expect(smoke).toContain('bundleMtime >= statSync(sourceUrl).mtimeMs')
    expect(smoke).toContain('is updating its role')
    expect(smoke).toContain('OpenPipal stream ended before the terminal done event')
    expect(smoke).toContain('assertFreshAdapterBundle()')
  })

  it('checks the auth header on every dynamic request exercised by the mock', () => {
    expect(smoke).toContain("token: req.headers['x-openpipal-acp-token']")
    expect(smoke).toContain("req.headers['x-openpipal-acp-token'] !== SMOKE_TOKEN")
    expect(smoke).toContain('for (const request of dynamicRequests)')
    expect(smoke).toContain('request.token,')
    expect(smoke).toContain("'/api/agents/list', '/api/conversations', '/chat/stream', '/api/permission', '/api/skills'")
    expect(smoke).toContain("!exercisedPaths.has('/role/switch')")
    expect(smoke).toContain("request.body?.role === 'design'")
  })

  it('documents authentication for every dynamic ACP request', () => {
    expect(readme).toContain('所有动态请求（会话、角色、聊天流和 session MCP 注册/清理）')
    expect(readme).toContain('除公开的健康检查外')
  })
})

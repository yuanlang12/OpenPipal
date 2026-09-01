/**
 * 出站域名白名单（Phase 1-2）
 *
 * 实测（cwd=/ 真沙箱、异步 exec）：只放 registry.npmjs.org 时
 *   curl https://github.com        → CONNECT tunnel failed, response 403
 *   git ls-remote https://github…  → 同上
 * 补齐取包/取代码域之后同样的命令回 200、拿到真实 commit sha，
 * 而未授权域（example.com）仍然 403——白名单该拦的照拦。
 *
 * 另一个必须写下来的实测结论：**SSH 走不通，而且补不了**。SRT 只代理 HTTP/HTTPS，
 * 沙箱里 DNS 也不放行，`ssh git@github.com` 卡在 "Could not resolve hostname"。
 * 所以 git 只能走 HTTPS，别再花时间试 SSH 方案。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const ENV_KEYS = ['OPENPIPAL_ALLOWED_DOMAINS', 'OPENPIPAL_EXTRA_ALLOWED_DOMAINS'] as const

async function freshAllowedDomains(): Promise<string[]> {
  // 域名表在模块内按环境变量现算，但仍要重置模块缓存以免受其它用例影响
  vi.resetModules()
  const { buildSandboxConfig } = await import('../../src/main/sandbox-manager')
  return buildSandboxConfig().network.allowedDomains as string[]
}

describe('出站域名白名单', () => {
  const saved: Record<string, string | undefined> = {}
  beforeEach(() => {
    for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k] }
  })
  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k]
      else process.env[k] = saved[k]
    }
  })

  it('默认表同时覆盖模型服务与取包/取代码', async () => {
    const domains = await freshAllowedDomains()
    // 模型服务：不通就没法对话
    expect(domains).toContain('api.anthropic.com')
    // 取包与取代码：编码场景的最低要求
    for (const d of [
      'registry.npmjs.org',
      'github.com',
      'codeload.github.com',           // 装 git 依赖时真正下 tarball 的主机
      'objects.githubusercontent.com', // release 附件 / LFS
      'pypi.org',
      'files.pythonhosted.org',
    ]) {
      expect(domains, `${d} 应在默认白名单里`).toContain(d)
    }
  })

  it('OPENPIPAL_ALLOWED_DOMAINS 是整表替换——留给"想收窄"的人', async () => {
    process.env.OPENPIPAL_ALLOWED_DOMAINS = 'api.anthropic.com, internal.example.com'
    const domains = await freshAllowedDomains()
    expect(domains).toEqual(['api.anthropic.com', 'internal.example.com'])
    expect(domains).not.toContain('github.com')
  })

  it('OPENPIPAL_EXTRA_ALLOWED_DOMAINS 是在默认表上追加——留给"想加一个私有源"的人', async () => {
    process.env.OPENPIPAL_EXTRA_ALLOWED_DOMAINS = 'npm.corp.internal'
    const domains = await freshAllowedDomains()
    expect(domains).toContain('npm.corp.internal')
    // 关键：追加不能把默认表挤掉，否则加一个域 = 应用连不上模型
    expect(domains).toContain('api.anthropic.com')
    expect(domains).toContain('github.com')
  })

  it('两个都设时：先按替换算基线，再追加；且不重复', async () => {
    process.env.OPENPIPAL_ALLOWED_DOMAINS = 'api.anthropic.com'
    process.env.OPENPIPAL_EXTRA_ALLOWED_DOMAINS = 'npm.corp.internal, api.anthropic.com'
    const domains = await freshAllowedDomains()
    expect(domains).toEqual(['api.anthropic.com', 'npm.corp.internal'])
  })

  it('空值与空白项被忽略，不会产生空域名把配置弄脏', async () => {
    process.env.OPENPIPAL_EXTRA_ALLOWED_DOMAINS = ' , ,npm.corp.internal, '
    const domains = await freshAllowedDomains()
    expect(domains).not.toContain('')
    expect(domains).toContain('npm.corp.internal')
  })
})

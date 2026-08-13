import { afterEach, describe, expect, it, vi } from 'vitest'
import { checkForUpdate, isNewerVersion } from '../../src/main/update-check'

describe('version comparison', () => {
  it.each([
    ['1.1.0', '1.0.0', true],
    ['v1.1.0', '1.0.0', true],
    ['1.0.1', '1.0.0', true],
    ['2.0.0', '1.9.9', true],
    ['1.0.0', '1.0.0', false],
    ['1.0.0', '1.1.0', false],
    ['1.0', '1.0.0', false],      // 段数不同时短的补 0
    ['1.0.1', '1.0', true],
    ['1.10.0', '1.9.0', true],    // 数值比较，不是字典序
    ['1.0.0-beta.1', '1.0.0', false], // 预发布号只取主干，等于不算新
  ])('%s newer than %s → %s', (a, b, expected) => {
    expect(isNewerVersion(a, b)).toBe(expected)
  })

  it('refuses to judge on garbage input rather than guessing', () => {
    expect(isNewerVersion('not-a-version', '1.0.0')).toBe(false)
    expect(isNewerVersion('1.0.0', '')).toBe(false)
  })
})

describe('update check', () => {
  afterEach(() => vi.unstubAllGlobals())

  const respondWith = (init: { ok: boolean; body?: unknown }) =>
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: init.ok,
      json: async () => init.body
    })))

  it('reports an update when the release tag is newer', async () => {
    respondWith({ ok: true, body: { tag_name: 'v1.2.0' } })
    await expect(checkForUpdate('1.0.0')).resolves.toEqual({
      status: 'update-available',
      current: '1.0.0',
      latest: '1.2.0'
    })
  })

  it('reports up-to-date when the release tag matches', async () => {
    respondWith({ ok: true, body: { tag_name: 'v1.0.0' } })
    await expect(checkForUpdate('1.0.0')).resolves.toEqual({ status: 'up-to-date', current: '1.0.0' })
  })

  /** 仓库还私有时未认证访问就是 404 —— 这不是错误，不该在界面上报红 */
  it('stays silent when the repository is not publicly readable', async () => {
    respondWith({ ok: false })
    await expect(checkForUpdate('1.0.0')).resolves.toEqual({ status: 'unavailable' })
  })

  it('stays silent when the network fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline') }))
    await expect(checkForUpdate('1.0.0')).resolves.toEqual({ status: 'unavailable' })
  })

  it('stays silent on a malformed or hostile payload', async () => {
    respondWith({ ok: true, body: { tag_name: { evil: true } } })
    await expect(checkForUpdate('1.0.0')).resolves.toEqual({ status: 'unavailable' })
    respondWith({ ok: true, body: { tag_name: 'javascript:alert(1)' } })
    await expect(checkForUpdate('1.0.0')).resolves.toEqual({ status: 'unavailable' })
  })

  /** 契约里没有 URL：远端字段永远变不成一个能点的链接 */
  it('never returns a URL from the remote payload', async () => {
    respondWith({ ok: true, body: { tag_name: 'v9.9.9', html_url: 'https://evil.example/pwn' } })
    const result = await checkForUpdate('1.0.0')
    expect(JSON.stringify(result)).not.toContain('evil.example')
    expect(Object.keys(result)).toEqual(['status', 'current', 'latest'])
  })
})

import { describe, expect, it, vi, afterAll } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>()
  const homedir = (): string => path.join(actual.tmpdir(), `openpipal-mcp-oauth-${process.pid}`)
  return { ...actual, default: { ...actual, homedir }, homedir }
})

// safeStorage.decryptString 是同步钥匙串调用（弹授权框会锁死主线程）——
// 本组测试锁定"启动期零解密"契约：文件级判断不触碰它、损坏密文只撞一次并被隔离。
const decryptString = vi.fn((): string => { throw new Error('Error while decrypting the ciphertext') })
vi.mock('electron', () => ({
  shell: { openExternal: vi.fn() },
  safeStorage: {
    isEncryptionAvailable: () => true,
    decryptString,
    encryptString: vi.fn((s: string) => Buffer.from(s))
  }
}))

const { hasPersistedOAuthSession, hasOAuthTokens } = await import('../../src/main/mcp-oauth')

const NAME = 'test-lazy-oauth'
const FILE = path.join(os.homedir(), '.openpipal', 'oauth', `${NAME}.bin`)

afterAll(() => {
  fs.rmSync(os.homedir(), { recursive: true, force: true })
})

describe('MCP OAuth 启动期零钥匙串', () => {
  it('无 session 文件：文件级判断为 false，且完全不触碰 safeStorage', () => {
    expect(hasPersistedOAuthSession(NAME)).toBe(false)
    expect(hasOAuthTokens(NAME)).toBe(false)
    expect(decryptString).not.toHaveBeenCalled()
  })

  it('损坏密文只撞一次钥匙串：自动隔离为 .corrupt，后续调用走缓存不再解密', () => {
    fs.mkdirSync(path.dirname(FILE), { recursive: true })
    fs.writeFileSync(FILE, Buffer.from('broken-ciphertext'))
    expect(hasPersistedOAuthSession(NAME)).toBe(true) // 纯文件判断，不解密

    expect(hasOAuthTokens(NAME)).toBe(false)          // 真解密：失败 → 空会话
    expect(decryptString).toHaveBeenCalledTimes(1)
    expect(fs.existsSync(FILE)).toBe(false)           // 原文件已隔离
    expect(fs.existsSync(`${FILE}.corrupt`)).toBe(true)

    expect(hasOAuthTokens(NAME)).toBe(false)          // 进程内缓存命中
    expect(decryptString).toHaveBeenCalledTimes(1)    // 不再重复解密
    expect(hasPersistedOAuthSession(NAME)).toBe(false) // 隔离后回到"需要重新授权"态
  })
})

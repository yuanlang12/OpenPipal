/**
 * 凭据桥 —— 把 token 送进沙箱，但不放开凭据文件。
 *
 * 背景实测（2026-08-23，沙箱内）：github.com 的 helper 常是 `!gh auth git-credential`，
 * 而 `~/.config/gh` 在拒读表里，于是任何鉴权 git 操作都死在
 * `open ~/.config/gh/config.yml: operation not permitted`；且 `gh` 在读配置文件之前
 * 不看 `GH_TOKEN`，光给环境变量救不回来。这一层就是那条洞的补法。
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

const ISOLATED_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'openpipal-cred-bridge-'))
process.env.OPENPIPAL_ISOLATED_HOME = ISOLATED_HOME

const bridge = await import('../../src/main/git-credential-bridge')
const { sanitizeEnvironment } = await import('../../src/main/sandbox-manager')

const run = promisify(execFile)

describe('buildGitCredentialEnv —— 拼出来的东西 git 得认', () => {
  it('先清空该 URL 的 helper 列表，再挂自己的 —— 少了清空那条，gh 仍会被调到并死掉', () => {
    const env = bridge.buildGitCredentialEnv('tok')
    expect(env.GIT_CONFIG_COUNT).toBe('2')
    expect(env.GIT_CONFIG_KEY_0).toBe('credential.https://github.com.helper')
    expect(env.GIT_CONFIG_VALUE_0).toBe('')
    expect(env.GIT_CONFIG_KEY_1).toBe('credential.https://github.com.helper')
    expect(env.GIT_CONFIG_VALUE_1).toMatch(/^!f\(\) \{/)
  })

  it('helper 只回显、不判断 —— 它跑在子进程里，逻辑越多攻击面越大', () => {
    // 值挑一个不会碰巧出现在 helper 里的串（`tok` 会撞上 x-access-token，白测一场）
    const helper = String(bridge.buildGitCredentialEnv('ZZ-SECRET-ZZ').GIT_CONFIG_VALUE_1)
    expect(helper).toContain('echo username=x-access-token')
    expect(helper).toContain('$OPENPIPAL_GIT_TOKEN')
    // token 本身绝不能烧进 helper 字符串：它会出现在 `ps` 和子进程的配置里
    expect(helper).not.toContain('ZZ-SECRET-ZZ')
  })

  it('token 走自己的变量，不进 helper 值', () => {
    expect(bridge.buildGitCredentialEnv('secret-value').OPENPIPAL_GIT_TOKEN).toBe('secret-value')
  })

  it('用户已有 GIT_CONFIG_COUNT 时接着往后数，不覆盖人家的配置', () => {
    const env = bridge.buildGitCredentialEnv('tok', { GIT_CONFIG_COUNT: '3' })
    expect(env.GIT_CONFIG_COUNT).toBe('5')
    expect(env.GIT_CONFIG_KEY_3).toBe('credential.https://github.com.helper')
    expect(env.GIT_CONFIG_KEY_5).toBeUndefined()
    expect(env.GIT_CONFIG_KEY_0).toBeUndefined()
  })

  it('GH_HOST 决定 token 挂在哪个域上 —— gh 的 token 不该拿去对别的域用', () => {
    const env = bridge.buildGitCredentialEnv('tok', { GH_HOST: 'github.acme-corp.com' })
    expect(env.GIT_CONFIG_KEY_0).toBe('credential.https://github.acme-corp.com.helper')
  })

  it('OPENPIPAL_GIT_TOKEN 必须扛得住环境清洗 —— 它结尾也是 _TOKEN（陷阱回归）', () => {
    const injected = bridge.buildGitCredentialEnv('tok')
    expect(sanitizeEnvironment(injected).OPENPIPAL_GIT_TOKEN, '缺省仍应抹掉').toBeUndefined()
    expect(sanitizeEnvironment(injected, { allowGitCredentials: true }).OPENPIPAL_GIT_TOKEN).toBe('tok')
    // GIT_CONFIG_* 不该被误伤，否则 helper 挂不上去
    const kept = sanitizeEnvironment(injected, { allowGitCredentials: true })
    expect(kept.GIT_CONFIG_COUNT).toBe('2')
    expect(kept.GIT_CONFIG_VALUE_1).toMatch(/^!f\(\)/)
  })
})

describe('resolveGitToken —— 拿不到就老实返回 null', () => {
  beforeEach(() => bridge.resetGitTokenCache())

  it('用户自己设的环境变量优先，且不去 spawn gh', async () => {
    await expect(bridge.resolveGitToken({ GITHUB_TOKEN: 'from-env' })).resolves.toBe('from-env')
    await expect(bridge.resolveGitToken({ GH_TOKEN: 'gh-env' })).resolves.toBe('gh-env')
  })

  it('空字符串不算数 —— 空 token 注进去会让 git 报一个看不懂的鉴权错', async () => {
    const resolved = await bridge.resolveGitToken({ GITHUB_TOKEN: '   ' })
    // 落到 gh 通道：这台机器上有没有 gh 都行，要的是「不会把空串当成 token」
    expect(resolved === null || resolved.length > 0).toBe(true)
  })
})

describe('真跑：git 认不认这套注入', () => {
  it('git credential fill 能拿到注入的 token，且完全不碰用户原来的 helper', async () => {
    // 全程假 token。验的是机制：helper 挂上没有、有没有压过用户那条 gh helper。
    const injected = bridge.buildGitCredentialEnv('FAKE_TOKEN_FOR_TEST')
    const { stdout } = await run(
      'sh',
      ['-c', 'printf "protocol=https\\nhost=github.com\\n\\n" | git credential fill'],
      { env: { ...process.env, ...injected }, timeout: 20000 }
    )
    expect(stdout).toContain('username=x-access-token')
    expect(stdout).toContain('password=FAKE_TOKEN_FOR_TEST')
    // gh helper 一旦被调到就会打印它自己的错；出现就说明「清空列表」那条没生效
    expect(stdout).not.toContain('gh')
  })

  it('helper 值不能经过 shell 字符串 —— `!` 被转义后 git 会去找一个不存在的外部程序', async () => {
    const helper = String(bridge.buildGitCredentialEnv('tok').GIT_CONFIG_VALUE_1)
    expect(helper.startsWith('!'), '实测踩过：变成 \\! 后 git 找 credential-\\!f() {...}').toBe(true)
    expect(helper).not.toContain('\\!')
  })
})

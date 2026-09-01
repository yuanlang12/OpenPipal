/**
 * Phase 5 真跑验收 —— 用本地裸仓当远端，真 spawn git，走真实执行环境与真实授权门。
 *
 * 为什么不用 mock：这一档的三个断言（门会不会响、授权记没记住、token 到没到子进程）
 * 全都发生在「参数拼好之后」，mock 掉 spawn 就等于把要验的那一段挖掉了。
 * 本地裸仓不需要联网也不需要凭据，正好把「门的逻辑」和「凭据通道」分开验。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const ISOLATED_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'openpipal-git-real-home-'))
process.env.OPENPIPAL_ISOLATED_HOME = ISOLATED_HOME
// 假 token，只为了看它有没有被发给子进程；不是任何真实凭据。
const FAKE_TOKEN = 'gho_fake_for_test_only'
process.env.GH_TOKEN = FAKE_TOKEN

const store = await import('../../src/main/git-policy-store')
const security = await import('../../src/main/pi-security')
const { OpenPipalNodeExecutionEnv } = await import('../../src/main/openpipal-execution-env')

const GIT_IDENTITY = [
  '-c', 'user.email=test@openpipal.local',
  '-c', 'user.name=OpenPipal Test',
  '-c', 'commit.gpgsign=false'
]

let sandboxRoot: string
let bare: string
let work: string

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', [...GIT_IDENTITY, ...args], { cwd, encoding: 'utf8' })
}

beforeAll(() => {
  sandboxRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'openpipal-git-real-'))
  bare = path.join(sandboxRoot, 'origin.git')
  work = path.join(sandboxRoot, 'checkout-service')
  fs.mkdirSync(work, { recursive: true })
  execFileSync('git', ['init', '--bare', '-b', 'main', bare])
  git(work, 'init', '-b', 'main')
  fs.writeFileSync(path.join(work, 'README.md'), '# checkout-service\n')
  git(work, 'add', '-A')
  git(work, 'commit', '-m', 'init')
  git(work, 'remote', 'add', 'origin', bare)
})

afterAll(() => {
  try { fs.rmSync(sandboxRoot, { recursive: true, force: true }) } catch { /* 清理失败不影响结论 */ }
  try { fs.rmSync(ISOLATED_HOME, { recursive: true, force: true }) } catch { /* 同上 */ }
})

describe('真跑：授权门', () => {
  it('第一次 push 问一次、批准后记住这个仓库；第二次不再问', async () => {
    store.__resetGitPolicyForTests()
    const asked: string[] = []
    security.setInlinePermissionSender((_getWindow, request: any) => {
      asked.push(String(request.reason || ''))
      security.resolvePermissionRequest(request.requestId, true)
    }, () => null)

    const call = (): Promise<any> => security.authorizeToolCall(
      'bash',
      { command: 'git push origin main' },
      { conversationId: 'conv-real', tier: 'auto', scope: { workingDir: work } }
    )

    expect((await call())?.reason || '').not.toMatch(/git 凭据/)
    expect(asked).toHaveLength(1)
    expect(asked[0]).toContain('git push')
    expect(asked[0]).toContain('checkout-service')

    await call()
    expect(asked, '授权过还问第二遍，等于这个"记住"没生效').toHaveLength(1)
    expect(store.hasGitGrant(work, 'conv-real')).toBe(true)
  })

  it('用户拒绝就真的拦下来，并且不留下授权', async () => {
    store.__resetGitPolicyForTests()
    security.setInlinePermissionSender((_getWindow, request: any) => {
      security.resolvePermissionRequest(request.requestId, false)
    }, () => null)

    const verdict = await security.authorizeToolCall(
      'bash',
      { command: 'git push origin main' },
      { conversationId: 'conv-deny', tier: 'auto', scope: { workingDir: work } }
    )
    expect(verdict?.block).toBe(true)
    expect(store.hasGitGrant(work, 'conv-deny')).toBe(false)
  })

  it('授权只落在这个仓库，隔壁仓库照样问', async () => {
    store.__resetGitPolicyForTests()
    const sibling = path.join(sandboxRoot, 'billing-api')
    fs.mkdirSync(sibling, { recursive: true })
    execFileSync('git', ['init', '-b', 'main', sibling])

    let asked = 0
    security.setInlinePermissionSender((_getWindow, request: any) => {
      asked++
      security.resolvePermissionRequest(request.requestId, true)
    }, () => null)

    await security.authorizeToolCall('bash', { command: 'git fetch origin' },
      { conversationId: 'conv-two', tier: 'auto', scope: { workingDir: work } })
    await security.authorizeToolCall('bash', { command: 'git fetch origin' },
      { conversationId: 'conv-two', tier: 'auto', scope: { workingDir: sibling } })
    expect(asked, '两个仓库各问一次才对；只问一次说明授权外溢了').toBe(2)
  })
})

describe('真跑：执行环境（真 spawn，不 mock）', () => {
  it('git push 真的推得上去 —— 门放行之后整条路是通的', async () => {
    store.__resetGitPolicyForTests()
    store.grantSessionProject('conv-exec', work)
    const env = new OpenPipalNodeExecutionEnv(work, {}, 'conv-exec')
    try {
      // push 不需要身份（提交时已经带了），别把带空格的 -c 拼进 shell 串
      const result = await env.exec('git push origin main')
      expect(result.ok).toBe(true)
      if (result.ok) expect(result.value.exitCode, result.value.stderr).toBe(0)
      // 裸仓那边真的收到了 main
      expect(execFileSync('git', ['--git-dir', bare, 'rev-parse', 'main'], { encoding: 'utf8' }).trim())
        .toHaveLength(40)
    } finally {
      await env.cleanup()
    }
  })

  it('没授权时 token 不下发给子进程', async () => {
    store.__resetGitPolicyForTests()
    const env = new OpenPipalNodeExecutionEnv(work, {}, 'conv-nogrant')
    try {
      const result = await env.exec('false && git fetch origin; echo "GH_TOKEN=[${GH_TOKEN:-unset}]"')
      expect(result.ok).toBe(true)
      if (result.ok) expect(result.value.stdout).toContain('GH_TOKEN=[unset]')
    } finally {
      await env.cleanup()
    }
  })

  it('授权后，只有要连远端的命令拿得到 token', async () => {
    store.__resetGitPolicyForTests()
    store.grantSessionProject('conv-grant', work)
    const env = new OpenPipalNodeExecutionEnv(work, {}, 'conv-grant')
    try {
      const remote = await env.exec('false && git fetch origin; echo "GH_TOKEN=[${GH_TOKEN:-unset}]"')
      expect(remote.ok).toBe(true)
      if (remote.ok) expect(remote.value.stdout).toContain(`GH_TOKEN=[${FAKE_TOKEN}]`)

      // 同一个已授权仓库里，不碰远端的命令仍然看不到 token ——
      // npm 的 postinstall 脚本是现实里最像样的外泄路径，这条就是钉它的。
      const local = await env.exec('ls >/dev/null; echo "GH_TOKEN=[${GH_TOKEN:-unset}]"')
      expect(local.ok).toBe(true)
      if (local.ok) expect(local.value.stdout).toContain('GH_TOKEN=[unset]')
    } finally {
      await env.cleanup()
    }
  })

  it('别的凭据永远不下发，授权与否都一样', async () => {
    store.__resetGitPolicyForTests()
    store.grantSessionProject('conv-other', work)
    process.env.ANTHROPIC_API_KEY = 'sk-fake-for-test'
    const env = new OpenPipalNodeExecutionEnv(work, {}, 'conv-other')
    try {
      const result = await env.exec('false && git fetch origin; echo "KEY=[${ANTHROPIC_API_KEY:-unset}]"')
      expect(result.ok).toBe(true)
      if (result.ok) expect(result.value.stdout).toContain('KEY=[unset]')
    } finally {
      await env.cleanup()
      delete process.env.ANTHROPIC_API_KEY
    }
  })
})

describe('真跑：凭据桥接到执行环境上了吗', () => {
  // 把整组 GIT_CONFIG_* 打出来，不钉具体下标 —— 身份护栏也占位，写死 VALUE_1 的断言
  // 在护栏落地那天就红了一次（2026-08-24）。要验的是"helper 在不在这份环境里"。
  const DUMP = 'false && git fetch origin; env | grep ^GIT_CONFIG_ | sort; echo "TOK=[${OPENPIPAL_GIT_TOKEN:-unset}]"'

  it('已授权 + 要连远端 → 子进程真的拿到内联 helper 配置', async () => {
    store.__resetGitPolicyForTests()
    store.grantSessionProject('conv-bridge', work)
    const env = new OpenPipalNodeExecutionEnv(work, {}, 'conv-bridge')
    try {
      const result = await env.exec(DUMP)
      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.value.stdout).toContain('!f() {')
        expect(result.value.stdout).toContain('credential.https://')
        expect(result.value.stdout).toContain(`TOK=[${FAKE_TOKEN}]`)
      }
    } finally {
      await env.cleanup()
    }
  })

  it('没授权 → 凭据桥一个字都不注入', async () => {
    store.__resetGitPolicyForTests()
    const env = new OpenPipalNodeExecutionEnv(work, {}, 'conv-bridge-off')
    try {
      const result = await env.exec(DUMP)
      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.value.stdout).not.toContain('!f() {')
        expect(result.value.stdout).not.toContain('credential.https://')
        expect(result.value.stdout).toContain('TOK=[unset]')
      }
    } finally {
      await env.cleanup()
    }
  })

  it('身份护栏跟着每条命令走，授权与否都在', async () => {
    store.__resetGitPolicyForTests()
    const env = new OpenPipalNodeExecutionEnv(work, {}, 'conv-guard')
    try {
      const result = await env.exec(DUMP)
      expect(result.ok).toBe(true)
      if (result.ok) expect(result.value.stdout).toContain('user.useConfigOnly')
    } finally {
      await env.cleanup()
    }
  })

  it('已授权但不碰远端的命令 → 同样一个字都不注入', async () => {
    store.__resetGitPolicyForTests()
    store.grantSessionProject('conv-bridge-local', work)
    const env = new OpenPipalNodeExecutionEnv(work, {}, 'conv-bridge-local')
    try {
      const result = await env.exec('ls >/dev/null; echo "TOK=[${OPENPIPAL_GIT_TOKEN:-unset}]"')
      expect(result.ok).toBe(true)
      if (result.ok) expect(result.value.stdout).toContain('TOK=[unset]')
    } finally {
      await env.cleanup()
    }
  })
})

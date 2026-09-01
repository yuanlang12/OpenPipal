/**
 * 装机版的 PATH 补齐。
 *
 * 事故形状（2026-08-25 实测 macOS 15.5）：Finder 双击启动的进程只有
 * `PATH=/usr/bin:/bin:/usr/sbin:/sbin`，编码助手一跑 `npm test` 就是 command not found。
 * 开发模式和所有 E2E 都从终端起进程、继承完整 PATH，**一条现有测试都碰不到这个洞**。
 *
 * 所以这一组的重点不是纯函数，而是最后那两条**行为**用例：直接把 launchd 那份最小 PATH
 * 摆上去，看补齐前后 `npm` 到底找不找得到。
 */
import { afterEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  applyLoginShellPath,
  mergePathEntries,
  parseProbeOutput,
  resolveLoginShellPath,
  resetLoginShellPathCache
} from '../../src/main/login-shell-path'

// 授权存储走隔离 home，绝不写用户真实 home（exec 里的 git 授权查询会碰它）
process.env.OPENPIPAL_ISOLATED_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'openpipal-login-path-'))

/** launchd 交给 GUI 应用的那份，一字不差 */
const LAUNCHD_PATH = '/usr/bin:/bin:/usr/sbin:/sbin'

/** 用给定 PATH 查一个命令在不在 —— 这就是子进程实际会走的那条查找逻辑 */
function lookup(command: string, pathValue: string): string | null {
  try {
    return execFileSync('/bin/sh', ['-c', `command -v ${command}`], {
      encoding: 'utf8',
      env: { PATH: pathValue }
    }).trim()
  } catch {
    return null
  }
}

const savedPath = process.env.PATH

/**
 * 探针要起登录 shell，读的是 `$HOME` 下的 rc 文件。而本仓库有十几个单测在模块顶层
 * 把 `process.env.HOME` 指到临时目录且从不还原（artifact-compile、dc-export-zip 等），
 * vitest 又会在同一个 worker 里连着跑多个文件 —— 轮到这里时 `$HOME` 可能已经是个空目录，
 * 登录 shell 读不到任何 rc，探针就"成功地"返回一份没补任何东西的 PATH。
 * 所以这里按密码库里的真实 home 顶回去（`os.userInfo()` 不看 `$HOME`）。
 */
const realHome = os.userInfo().homedir
const savedHome = process.env.HOME

function pinRealHome(): void {
  process.env.HOME = realHome
}

// 探针缓存**不在这里清**：起一个交互登录 shell 实测 0.78s，机器一忙能到几秒，
// 每条用例都重来会明显拖慢整个并行套件（已经把同一 worker 里另一条计时敏感的用例挤挂过一次）。
// 全文件只真探一次，其余用例吃缓存。
afterEach(() => {
  process.env.PATH = savedPath
  if (savedHome === undefined) delete process.env.HOME
  else process.env.HOME = savedHome
})

describe('mergePathEntries', () => {
  it('登录那份排在前面 —— PATH 的先后决定同名命令谁赢', () => {
    expect(mergePathEntries('/usr/bin', '/opt/homebrew/bin')).toBe('/opt/homebrew/bin:/usr/bin')
  })

  it('去重且保序，不会把同一个目录塞两遍', () => {
    expect(mergePathEntries('/usr/bin:/bin', '/opt/x:/usr/bin')).toBe('/opt/x:/usr/bin:/bin')
  })

  it('当前进程独有的目录不许被丢掉', () => {
    expect(mergePathEntries('/only/here:/usr/bin', '/usr/bin')).toContain('/only/here')
  })

  it('空串不会变成一个空目录项', () => {
    expect(mergePathEntries('', '/usr/bin')).toBe('/usr/bin')
    expect(mergePathEntries('/usr/bin::/bin', '')).toBe('/usr/bin:/bin')
  })
})

describe('parseProbeOutput', () => {
  it('把 rc 文件的噪声挡在标记之外', () => {
    const noisy = [
      'Last login: Mon Aug 25',
      '你好，欢迎使用 oh-my-zsh',
      '__OPENPIPAL_PATH_BEGIN__',
      '/opt/homebrew/bin:/usr/bin',
      '__OPENPIPAL_PATH_END__',
      'nvm: 提示信息'
    ].join('\n')
    expect(parseProbeOutput(noisy)).toBe('/opt/homebrew/bin:/usr/bin')
  })

  it('标记缺一半就当没拿到 —— 宁可保持现状也不要半截 PATH', () => {
    expect(parseProbeOutput('__OPENPIPAL_PATH_BEGIN__\n/usr/bin')).toBeNull()
    expect(parseProbeOutput('完全无关的输出')).toBeNull()
  })

  it('标记之间是空的也当没拿到', () => {
    expect(parseProbeOutput('__OPENPIPAL_PATH_BEGIN__\n\n__OPENPIPAL_PATH_END__')).toBeNull()
  })
})

describe('真机行为：GUI 启动的最小 PATH', () => {
  it.skipIf(process.platform === 'win32')('前提成立：launchd 那份 PATH 里确实没有 npm', () => {
    expect(lookup('npm', LAUNCHD_PATH), 'npm 竟然在 /usr/bin 里，这台机器的前提和线上不同').toBeNull()
    expect(lookup('git', LAUNCHD_PATH), 'git 在 /usr/bin，应该找得到').not.toBeNull()
  })

  it.skipIf(process.platform === 'win32')('补齐之后 npm 找得到了', async () => {
    pinRealHome()
    process.env.PATH = LAUNCHD_PATH
    resetLoginShellPathCache()

    const t0 = Date.now()
    const report = await applyLoginShellPath()
    // 失败时把现场留下：这条挂过一次，光看断言分不清是超时、$HOME 被别的用例改了、还是 shell 不对
    if (!report.applied) {
      console.log('[诊断] SHELL=', process.env.SHELL, 'HOME=', process.env.HOME,
        'elapsed=', Date.now() - t0, 'raw=', JSON.stringify(await resolveLoginShellPath())?.slice(0, 200))
    }

    expect(report.applied, '探针没拿到登录 shell 的 PATH —— 这台机器上补齐是失效的').toBe(true)
    expect(lookup('npm', process.env.PATH || ''), '补完还是找不到 npm，编码助手照样跑不了 npm test').not.toBeNull()
    expect(lookup('node', process.env.PATH || '')).not.toBeNull()
    expect(process.env.PATH, '系统目录被挤掉了').toContain('/usr/bin')
  }, 40_000)

  it.skipIf(process.platform === 'win32')('已经是完整 PATH 时是空操作，不重复追加', async () => {
    pinRealHome()
    await applyLoginShellPath()
    const once = process.env.PATH
    const second = await applyLoginShellPath()
    expect(second.applied, '第二次还在改 PATH = 每次调用都会越滚越长').toBe(false)
    expect(process.env.PATH).toBe(once)
  }, 40_000)
})

/**
 * 走真实的那条执行通道 —— `OpenPipalNodeExecutionEnv.exec()` 就是编码助手 bash 工具落地的地方。
 * 上面那组验的是 `process.env.PATH` 被改对了，这一组验**子进程真的因此找得到 npm**。
 */
describe.skipIf(process.platform === 'win32')('真机行为：编码助手的 bash 通道', () => {
  const execEnv = async () => {
    const { OpenPipalNodeExecutionEnv } = await import('../../src/main/openpipal-execution-env')
    return new OpenPipalNodeExecutionEnv(os.tmpdir())
  }

  it('前提成立：PATH 只剩 launchd 那四项时，bash 工具跑不了 npm', async () => {
    process.env.PATH = LAUNCHD_PATH
    const result = await (await execEnv()).exec('npm -v')
    expect(result.ok && result.value.exitCode, 'npm 竟然跑通了 —— 这台机器的前提和线上不同').not.toBe(0)
  }, 40_000)

  it('补齐之后，bash 工具跑得通 npm', async () => {
    pinRealHome()
    process.env.PATH = LAUNCHD_PATH
    await applyLoginShellPath()

    const result = await (await execEnv()).exec('npm -v')
    expect(result.ok, 'exec 直接失败了').toBe(true)
    expect(result.ok && result.value.exitCode, '补完还是跑不了 npm').toBe(0)
    expect(result.ok && result.value.stdout.trim()).toMatch(/^\d+\./)
  }, 40_000)
})

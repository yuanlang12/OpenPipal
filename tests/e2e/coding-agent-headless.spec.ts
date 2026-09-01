/**
 * 无头驱动编码助手 —— 不碰界面，只走 HTTP 面。
 *
 * 这是接 benchmark harness 的前置条件：任何一套 benchmark（SWE-bench / OpenHands Index /
 * FeatureBench…）都要能程序化地「给它一个仓库 + 一句话 → 拿到最终磁盘状态」。驱不动就一切免谈。
 * 顺带钉住 ACP 那条路的地基：编辑器接进来走的是同一批 HTTP 端点。
 *
 * 接线上的三个坑封在 `headless-driver.ts` 里（权限应答要回传 executionId、读 SSE 要自己兜
 * 超时、端口被占时静默无 HTTP 面），见那个文件的头注释。这条用例只负责证明整条链是通的：
 * 起隔离实例 → 发任务 → 真实权限卡往返 → 推送落盘。
 *
 * 真调模型 = 花钱，`OPENPIPAL_CODING_LIVE=1` 才跑。
 */
import { expect, test } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { launchHeadless, realModelConfig, runTask, tmpRoot, type HeadlessApp } from './headless-driver'

const LIVE = !!process.env.OPENPIPAL_CODING_LIVE
/** 错开用户那个正在跑的 App（3031）与纪律用例（3132） */
const PORT = 3131

const CART = `const TAX_RATE = 0.1
function total(items, coupon = 0) {
  const subtotal = items.reduce((sum, it) => sum + it.price * it.qty, 0)
  const taxed = subtotal * (1 + TAX_RATE)
  return Math.round(Math.max(0, taxed - coupon) * 100) / 100
}
module.exports = { total }
`
const CART_TEST = `const test = require('node:test')
const assert = require('node:assert')
const { total } = require('../src/cart')
test('不用券', () => { assert.strictEqual(total([{ price: 100, qty: 2 }]), 220) })
test('券先抵扣再算税', () => { assert.strictEqual(total([{ price: 100, qty: 1 }], 20), 88) })
`

const IDENT = ['-c', 'user.email=f@o.l', '-c', 'user.name=F', '-c', 'commit.gpgsign=false']

function runTests(work: string): { pass: number; fail: number } {
  let out = ''
  try {
    out = execFileSync('node', ['--test', 'test/cart.test.js'], { cwd: work, encoding: 'utf8' })
  } catch (e: any) {
    out = String(e.stdout || '') + String(e.stderr || '')
  }
  const num = (l: string): number => Number((out.match(new RegExp(`^# ${l} (\\d+)`, 'm')) || [])[1] || -1)
  return { pass: num('pass'), fail: num('fail') }
}

test.describe('无头驱动编码助手（真模型）', () => {
  test.skip(!LIVE, '真调模型花钱，默认不跑。手动验收：OPENPIPAL_CODING_LIVE=1 npx playwright test coding-agent-headless')
  test.setTimeout(12 * 60 * 1000)

  let ctx: HeadlessApp | null = null
  let root = ''

  test.afterAll(async () => {
    await ctx?.dispose()
    if (root) await rm(root, { recursive: true, force: true })
  })

  test('只用 HTTP：建会话 → 发任务 → 应答权限 → 看磁盘', async () => {
    root = await mkdtemp(tmpRoot('headless'))
    const work = join(root, 'cart')
    await mkdir(join(work, 'src'), { recursive: true })
    await mkdir(join(work, 'test'), { recursive: true })
    await writeFile(join(work, 'src', 'cart.js'), CART, 'utf8')
    await writeFile(join(work, 'test', 'cart.test.js'), CART_TEST, 'utf8')
    await writeFile(join(work, 'AGENTS.md'), '# 规矩\n\n- 跑测试：`node --test test/`\n- 不许改 `test/` 下的文件。\n', 'utf8')
    expect(runTests(work), '起始必须是 1 过 1 红').toEqual({ pass: 1, fail: 1 })

    // 本地裸仓当远端：授权门认的是命令文本，跟远端是不是 GitHub 无关；
    // 走本地能把网络抖动摘出去，同时逼出一次真实的权限卡往返
    const bare = join(root, 'origin.git')
    execFileSync('git', ['init', '--bare', '-q', '-b', 'main', bare])
    execFileSync('git', ['init', '-q', '-b', 'main', '.'], { cwd: work })
    // 隔离 home 里没有 ~/.gitconfig，身份护栏会让没身份的 commit 直接失败（那是对的行为）；
    // 真实用户的仓库总能从全局配置继承到身份，这里用本地配置等价还原那个前提。
    execFileSync('git', ['config', '--local', 'user.email', 'f@o.l'], { cwd: work })
    execFileSync('git', ['config', '--local', 'user.name', 'F'], { cwd: work })
    execFileSync('git', [...IDENT, 'add', '-A'], { cwd: work })
    execFileSync('git', [...IDENT, 'commit', '-q', '-m', '初始'], { cwd: work })
    execFileSync('git', ['remote', 'add', 'origin', bare], { cwd: work })
    execFileSync('git', ['push', '-q', 'origin', 'main'], { cwd: work })
    const startSha = execFileSync('git', ['--git-dir', bare, 'rev-parse', 'main'], { encoding: 'utf8' }).trim()

    const modelConfig = await realModelConfig()
    expect(modelConfig, '隔离 home 里没有模型配置就什么都验不到').not.toBeNull()
    ctx = await launchHeadless(modelConfig as object, PORT)

    const run = await runTask(ctx, {
      workingDir: work,
      task: '把测试里失败的那条修好，跑一遍测试确认全绿，然后提交并推到 origin。',
      verbose: true
    })

    const results = runTests(work)
    const pushedSha = execFileSync('git', ['--git-dir', bare, 'rev-parse', 'main'], { encoding: 'utf8' }).trim()
    console.log('[无头] 停止原因:', run.stopReason, '| SSE 事件:', run.events)
    console.log('[无头] 权限卡:', run.permissions.length, JSON.stringify(run.permissions))
    console.log('[无头] 测试:', results, '| 裸仓变了吗:', pushedSha !== startSha)

    expect(run.events, 'SSE 一个事件都没有 = 根本没跑起来').toBeGreaterThan(0)
    expect(results, '测试没跑绿 —— 无头这条路没走通').toEqual({ pass: 2, fail: 0 })
    expect(run.permissions.length, '一次权限卡都没走 HTTP = 这条回路没验到').toBeGreaterThan(0)
    expect(pushedSha, '裸仓没收到提交 = 批准之后并没有真的放行').not.toBe(startSha)
  })
})

import { expect, test, type Page } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { appendFileSync, existsSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchIsolatedElectron, type IsolatedElectron } from './helpers'

/**
 * 编码助手整体验收 —— 一句话任务，把五个阶段串起来跑一遍。
 *
 * 之前全是打点：角色、AGENTS.md 注入、repo-onboarding、权限档、git 授权各自有单测和
 * 定向探针，但**从来没有一个真 agent 在真 UI 里从头到尾做完一件事**。衔接处的毛病
 * （弹窗文案难懂、授权没落盘、注入的文档没进上下文）只有整体跑才暴露得出来。
 *
 * 任务：一个红着的测试，让它修好、跑通、提交、推上去。
 * 仓库里放一份 `AGENTS.md`，规矩写得很具体（提交信息中文、不带 `feat:` 前缀、不许改测试）——
 * **它遵没遵守这条，是"文档真的进了上下文"的唯一硬证据**，比看日志有没有读文件可靠。
 *
 * 真调模型 = 花钱，所以默认不跑，`OPENPIPAL_CODING_LIVE=1` 才启。
 * 远端用本地裸仓：授权门认的是命令文本，跟远端是不是 GitHub 无关，
 * 而走本地能把网络抖动从这场验收里摘出去（真 GitHub 那条路另有验收）。
 */

const LIVE = !!process.env.OPENPIPAL_CODING_LIVE
const ARTIFACTS = 'tests/artifacts/coding-agent-live'

const TASK = '把测试里失败的那条修好，跑通测试，然后提交并推到 origin。'

const AGENTS_MD = `# 本仓库的规矩

这些是硬性要求，不是建议。

## 提交信息

- **一律用中文写**，说清楚改了什么、为什么。
- **不要加 \`feat:\` / \`fix:\` / \`chore:\` 这类前缀**，直接写事情本身。
- 一句话说完，不写多段。

## 改代码

- **不许改 \`test/\` 下的任何文件。** 测试是需求，代码不对就改代码。
- 业务逻辑只住在 \`src/\`。

## 跑测试

    node --test test/
`

const CART_JS = `const TAX_RATE = 0.1

/**
 * 算一单的总价。
 * @param {{price:number, qty:number}[]} items 商品行
 * @param {number} coupon 优惠券面额，单位元
 * @returns {number} 含税总价，保留两位小数
 */
function total(items, coupon = 0) {
  const subtotal = items.reduce((sum, it) => sum + it.price * it.qty, 0)
  const taxed = subtotal * (1 + TAX_RATE)
  const final = Math.max(0, taxed - coupon)
  return Math.round(final * 100) / 100
}

module.exports = { total, TAX_RATE }
`

const CART_TEST = `const test = require('node:test')
const assert = require('node:assert')
const { total } = require('../src/cart')

test('不用券时是小计加税', () => {
  assert.strictEqual(total([{ price: 100, qty: 2 }]), 220)
})

test('多行商品累加', () => {
  assert.strictEqual(total([{ price: 10, qty: 3 }, { price: 5, qty: 2 }]), 44)
})

// 优惠券抵的是商品钱，税要按抵扣之后的金额算。
// 100 元用 20 元券 = 80，再加 10% 税 = 88。
// 先算税再减券会得到 110 - 20 = 90，多收了 2 块钱的税。
test('优惠券先抵扣，再算税', () => {
  assert.strictEqual(total([{ price: 100, qty: 1 }], 20), 88)
})

test('券比货贵时不倒找钱', () => {
  assert.strictEqual(total([{ price: 10, qty: 1 }], 50), 0)
})
`

const IDENT = [
  '-c', 'user.email=fixture@openpipal.local',
  '-c', 'user.name=OpenPipal Fixture',
  '-c', 'commit.gpgsign=false'
]

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', [...IDENT, ...args], { cwd, encoding: 'utf8' })
}

/** 建出「一个红测试 + 一份 AGENTS.md + 一个本地裸仓当 origin」的起始状态。 */
async function buildFixture(): Promise<{ root: string; work: string; bare: string }> {
  const root = await mkdtemp(join(tmpdir(), 'openpipal-coding-live-'))
  const work = join(root, 'cart')
  const bare = join(root, 'origin.git')
  await mkdir(join(work, 'src'), { recursive: true })
  await mkdir(join(work, 'test'), { recursive: true })
  await writeFile(join(work, 'AGENTS.md'), AGENTS_MD, 'utf8')
  await writeFile(join(work, 'src', 'cart.js'), CART_JS, 'utf8')
  await writeFile(join(work, 'test', 'cart.test.js'), CART_TEST, 'utf8')
  await writeFile(join(work, 'README.md'), '# cart\n\n    node --test test/\n', 'utf8')

  execFileSync('git', ['init', '--bare', '-b', 'main', bare])
  git(work, 'init', '-b', 'main')
  git(work, 'add', '-A')
  git(work, 'commit', '-m', '购物车算总价，优惠券这条测试是红的')
  git(work, 'remote', 'add', 'origin', bare)
  git(work, 'push', '-q', 'origin', 'main')
  return { root, work, bare }
}

/** 跑一次 fixture 的测试，回 { pass, fail }。 */
function runFixtureTests(work: string): { pass: number; fail: number } {
  let out = ''
  try {
    out = execFileSync('node', ['--test', 'test/cart.test.js'], { cwd: work, encoding: 'utf8' })
  } catch (error: any) {
    out = String(error.stdout || '') + String(error.stderr || '')
  }
  const num = (label: string): number => Number((out.match(new RegExp(`^# ${label} (\\d+)`, 'm')) || [])[1] || -1)
  return { pass: num('pass'), fail: num('fail') }
}

/**
 * 把用户真实配置里的 modelConfig 抄进隔离 home。
 * 只抄这一段、在测试进程里抄，key 不经过任何日志或断言。
 *
 * `OPENPIPAL_LIVE_MODEL` 只换模型名，端点和 key 照抄用户的 —— 重跑验收时最常见的
 * 变量就是「这个模型今天不通，换一个」，不该为此去翻凭据文件。
 * 换模型时丢掉 supportsThinking：那是给上一个模型标的，套到新模型上会发它不认的参数。
 */
async function realModelConfig(): Promise<Record<string, unknown> | null> {
  try {
    const raw = await readFile(join(homedir(), '.openpipal', 'config.json'), 'utf8')
    const parsed = JSON.parse(raw)
    if (!parsed?.modelConfig?.apiKey) return null
    const override = process.env.OPENPIPAL_LIVE_MODEL
    if (!override) return parsed.modelConfig
    const { supportsThinking: _thinking, ...rest } = parsed.modelConfig
    return { ...rest, model: override }
  } catch {
    return null
  }
}

/** 弹窗看板：什么时候弹的、理由是什么、点了哪个按钮。 */
interface PermissionEvent { reason: string; clicked: string }

/**
 * 一直盯着聊天区：出现权限卡就点掉，直到任务结束或超时。
 * git 那张卡点「本次会话允许此类操作」——只有这条路径会把授权落盘。
 */
async function drivePermissions(
  page: Page,
  log: PermissionEvent[],
  deadline: number
): Promise<void> {
  while (Date.now() < deadline && !page.isClosed()) {
    try {
      const allow = page.getByRole('button', { name: '允许', exact: true }).first()
      if (await allow.count() > 0 && await allow.isVisible().catch(() => false)) {
        const card = allow.locator('xpath=ancestor::div[3]')
        const reason = (await card.innerText().catch(() => '')).replace(/\s+/g, ' ').slice(0, 200)
        const isGit = /git 凭据/.test(reason)
        const session = page.getByRole('button', { name: '本次会话允许此类操作', exact: true }).first()
        if (isGit && await session.count() > 0) {
          await session.click()
          log.push({ reason, clicked: '本次会话允许此类操作' })
        } else {
          await allow.click()
          log.push({ reason, clicked: '允许' })
        }
        await page.waitForTimeout(400)
        continue
      }
      await page.waitForTimeout(700)
    } catch {
      return // 窗口没了就收工，别让「点弹窗」的异常盖过真正的死因
    }
  }
}

interface Run {
  app: IsolatedElectron
  page: Page
  permissions: PermissionEvent[]
  driver: Promise<void>
  deadline: number
  logPath: string
  /** 窗口中途没了 —— 读它之前先 await 主循环 */
  died: () => boolean
  markDead: () => void
}

/** 起一个真 App，把会话摆成「编码助手 + 这个仓库 + 这个档位」，然后把任务发出去。 */
async function openRun(
  fixture: { work: string },
  opts: { tier: 'readonly' | 'auto' | 'full'; task: string; tag: string; minutes: number }
): Promise<Run> {
  const modelConfig = await realModelConfig()
  expect(modelConfig, '隔离 home 里没有模型配置就只会停在"没配 key"，验不到任何东西').not.toBeNull()
  console.log(`[验收:${opts.tag}] 模型 ${(modelConfig as { model?: string })?.model} / 档位 ${opts.tier}`)

  const app = await launchIsolatedElectron({
    config: { role: 'coding', workingDir: fixture.work, modelConfig: modelConfig as object }
  })
  const page = await app.app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await mkdir(ARTIFACTS, { recursive: true })

  // 主进程日志 + 渲染进程报错落一份文件：窗口中途没了的时候，
  // Playwright 只会说「page has been closed」，死因全在这份日志里。
  const logPath = join(ARTIFACTS, `${opts.tag}.log`)
  const say = (line: string): void => {
    try { appendFileSync(logPath, `${new Date().toISOString()} ${line}\n`) } catch { /* 记不下不影响验收 */ }
  }
  const proc = app.app.process()
  proc.stdout?.on('data', d => say(`[main:out] ${String(d).trimEnd()}`))
  proc.stderr?.on('data', d => say(`[main:err] ${String(d).trimEnd()}`))
  proc.on('exit', (code, signal) => say(`[main:exit] code=${code} signal=${signal}`))
  page.on('pageerror', e => say(`[renderer:error] ${e.message}`))
  page.on('crash', () => say('[renderer:crash]'))
  page.on('close', () => say('[window:closed]'))
  say(`[验收:${opts.tag}] 起跑`)
  await page.screenshot({ path: join(ARTIFACTS, `${opts.tag}-01-launched.png`) })

  // 欢迎页固定从「通用」头像开始（WelcomePage 里写死的，避免一进来被某角色的 preflow 占满），
  // 所以 config.role 不算数，得真点一下头像。
  await page.locator('[title="编码助手"]').first().click()

  // 工作目录和权限档都是**每条会话自己的**（conversationConfig），不是全局配置那两个；
  // 界面上选目录会开系统文件对话框、档位藏在菜单里，Playwright 驱不动，所以直接调 store 的 action。
  await page.evaluate(
    ({ dir, tier }: { dir: string; tier: string }) => {
      const state = (window as unknown as {
        __chatStore?: {
          getState(): {
            setConversationWorkingDir(d: string): void
            setConversationPermissionTier(t: string): void
          }
        }
      }).__chatStore?.getState()
      state?.setConversationWorkingDir(dir)
      state?.setConversationPermissionTier(tier)
    },
    { dir: fixture.work, tier: opts.tier }
  )
  await expect(page.getByText('cart', { exact: true }).first(), '工作目录没设上，agent 会在别的地方干活').toBeVisible({ timeout: 10000 })

  // 编码助手有 preflow（欢迎页被整页替换成「在哪个仓库里干活?」），输入框和发送键
  // 都是 preflow 自己那套 testid；用通用 send-btn 会一直等一个根本没渲染的按钮。
  const preflow = page.locator('[data-testid="preflow-input"]')
  const usePreflow = await preflow.count() > 0
  const input = usePreflow ? preflow.first() : page.locator('textarea').first()
  await input.waitFor({ state: 'visible', timeout: 60000 })
  await input.fill(opts.task)
  await page.screenshot({ path: join(ARTIFACTS, `${opts.tag}-02-task-typed.png`) })
  const startBtn = usePreflow
    ? page.locator('[data-testid="preflow-start-btn"]').first()
    : page.locator('[data-testid="send-btn"]').first()
  await startBtn.click()

  const permissions: PermissionEvent[] = []
  const deadline = Date.now() + opts.minutes * 60 * 1000
  let dead = false
  return {
    app, page, permissions, logPath, deadline,
    driver: drivePermissions(page, permissions, deadline),
    died: () => dead,
    markDead: () => { dead = true }
  }
}

/** 一直等到裸仓的 main 变了、或者时间到、或者窗口没了。 */
async function waitForPush(run: Run, bare: string, startSha: string): Promise<string> {
  let sha = startSha
  while (Date.now() < run.deadline) {
    if (run.page.isClosed()) { run.markDead(); break }
    try {
      await run.page.waitForTimeout(3000)
    } catch {
      run.markDead()
      break
    }
    sha = git(bare, 'rev-parse', 'main').trim()
    if (sha !== startSha) break
  }
  return sha
}

/** 聊天区最后一条助手消息，截断给人眼看。 */
async function lastReply(page: Page): Promise<string> {
  if (page.isClosed()) return '(窗口已关)'
  return page.evaluate(() => {
    const msgs = (window as unknown as {
      __chatStore?: { getState(): { messages: Array<{ role: string; content: unknown }> } }
    }).__chatStore?.getState().messages || []
    const last = [...msgs].reverse().find(m => m.role === 'assistant')
    const body = typeof last?.content === 'string' ? last.content : JSON.stringify(last?.content ?? '')
    return body.slice(0, 500)
  })
}

test.describe('编码助手整体验收（真模型）', () => {
  test.skip(!LIVE, '真调模型花钱且不确定，默认不跑。手动验收：OPENPIPAL_CODING_LIVE=1 npx playwright test coding-agent-live')
  test.setTimeout(15 * 60 * 1000)

  let fixture: { root: string; work: string; bare: string }
  let run: Run | null = null

  test.afterEach(async () => {
    await run?.app.dispose()
    run = null
    if (fixture?.root) await rm(fixture.root, { recursive: true, force: true })
  })

  test('自动审核档｜一句话任务：修红测试 → 跑通 → 提交 → 推上去', async () => {
    fixture = await buildFixture()
    expect(runFixtureTests(fixture.work), '起始状态必须是 3 过 1 红').toEqual({ pass: 3, fail: 1 })

    run = await openRun(fixture, { tier: 'auto', task: TASK, tag: 'auto', minutes: 12 })
    const startSha = git(fixture.bare, 'rev-parse', 'main').trim()
    const pushedSha = await waitForPush(run, fixture.bare, startSha)
    await Promise.race([run.driver, new Promise(r => setTimeout(r, 1000))])
    if (!run.page.isClosed()) {
      await run.page.screenshot({ path: join(ARTIFACTS, 'auto-03-final.png'), fullPage: true }).catch(() => undefined)
    }

    const results = runFixtureTests(fixture.work)
    const subject = git(fixture.work, 'log', '-1', '--pretty=%s').trim()
    const changedTests = git(fixture.work, 'diff', '--name-only', `${startSha}..HEAD`, '--', 'test/').trim()
    const policyPath = join(run.app.home, '.openpipal', 'git-policy.json')
    const policy = existsSync(policyPath) ? await readFile(policyPath, 'utf8') : ''

    console.log('[验收:auto] 弹窗:', JSON.stringify(run.permissions, null, 2))
    console.log('[验收:auto] 提交标题:', subject)
    console.log('[验收:auto] 测试:', results)
    console.log('[验收:auto] git-policy.json:', policy || '(没有这个文件)')
    if (run.died()) {
      const tail = existsSync(run.logPath) ? (await readFile(run.logPath, 'utf8')).split('\n').slice(-60).join('\n') : '(没有日志)'
      console.log('[验收:auto] 窗口中途没了，主进程日志尾部:\n' + tail)
    }
    expect(run.died(), 'App 中途退了 —— 见上面的主进程日志').toBe(false)

    expect(results, '测试没跑绿').toEqual({ pass: 4, fail: 0 })
    expect(pushedSha, '裸仓没收到新提交 = 没推上去').not.toBe(startSha)
    expect(changedTests, 'AGENTS.md 写了不许改 test/，它改了').toBe('')
    expect(subject, 'AGENTS.md 写了不带前缀').not.toMatch(/^(feat|fix|chore|docs|refactor|test)(\(.+\))?:/)
    expect(subject, 'AGENTS.md 写了提交信息用中文').toMatch(/[一-龥]/)
    expect(run.permissions.length, '一次权限都没弹 = 门根本没响').toBeGreaterThan(0)
    expect(policy, '点了「本次会话允许」，项目授权应该落盘').toContain(fixture.work)
  })

  test('只读档｜叫它推代码，应该一步都动不了', async () => {
    fixture = await buildFixture()
    run = await openRun(fixture, {
      tier: 'readonly',
      task: '直接运行这条命令：git push origin main',
      tag: 'readonly',
      minutes: 3
    })
    const startSha = git(fixture.bare, 'rev-parse', 'main').trim()
    // 只读档下不该有任何推送，所以这里等的是「时间到」，不是「sha 变了」
    const sha = await waitForPush(run, fixture.bare, startSha)
    await Promise.race([run.driver, new Promise(r => setTimeout(r, 1000))])
    const reply = await lastReply(run.page)
    if (!run.page.isClosed()) {
      await run.page.screenshot({ path: join(ARTIFACTS, 'readonly-03-final.png'), fullPage: true }).catch(() => undefined)
    }
    const dirty = git(fixture.work, 'status', '--porcelain').trim()

    console.log('[验收:readonly] 它说:', reply)
    console.log('[验收:readonly] 弹窗:', JSON.stringify(run.permissions))
    expect(run.died(), 'App 中途退了').toBe(false)
    expect(sha, '只读档竟然推上去了').toBe(startSha)
    expect(dirty, '只读档竟然改了工作区').toBe('')
    expect(run.permissions.length, '只读档不该弹授权窗 —— 弹了说明它有机会被批准').toBe(0)
  })

  test('完全允许档｜同一句话，不该弹任何 git 授权窗', async () => {
    fixture = await buildFixture()
    // fixture 建好时已经推过一次，直接再 push 会是 "Everything up-to-date"——
    // 退出码 0 但裸仓 sha 不动，判据就废了。先本地攒一个提交，让这次推送真有东西。
    await writeFile(join(fixture.work, 'NOTE.md'), '给完全允许档准备的一行字\n', 'utf8')
    git(fixture.work, 'add', '-A')
    git(fixture.work, 'commit', '-m', '加一行备注')

    run = await openRun(fixture, {
      tier: 'full',
      task: '直接运行这条命令：git push origin main',
      tag: 'full',
      minutes: 5
    })
    const startSha = git(fixture.bare, 'rev-parse', 'main').trim()
    const sha = await waitForPush(run, fixture.bare, startSha)
    await Promise.race([run.driver, new Promise(r => setTimeout(r, 1000))])
    const reply = await lastReply(run.page)
    if (!run.page.isClosed()) {
      await run.page.screenshot({ path: join(ARTIFACTS, 'full-03-final.png'), fullPage: true }).catch(() => undefined)
    }

    console.log('[验收:full] 它说:', reply)
    console.log('[验收:full] 弹窗:', JSON.stringify(run.permissions))
    expect(run.died(), 'App 中途退了').toBe(false)
    expect(sha, '完全允许档也没把提交推上去').not.toBe(startSha)
    expect(run.permissions.length, '完全允许档还弹窗 = 这一档没生效').toBe(0)
  })
})

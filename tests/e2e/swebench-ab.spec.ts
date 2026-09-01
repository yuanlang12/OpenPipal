/**
 * SWE-bench Verified 的**配对对照**：同一道题，裸 `pi` CLI（A 臂）对上走我们这层壳的
 * 编码助手（B 臂）。要量的不是绝对分，是两条臂的差值——那才是「壳」的价值。
 *
 * ## 为什么是配对，不是两组独立的题
 *
 * 独立两组要看出 12 个点的差，每组得上百道题（单题 = 1/N 个点）。配对之后只需要看
 * **不一致的那些对**（A 过 B 没过 / B 过 A 没过），几十道题就能出信号。所以每道题两条臂
 * 都跑，就地跑在同一个题目目录里，各自跑完还原（为什么不复制副本见 `restore` 的注释）。
 *
 * ## 题库必须先过「标准答案闸门」
 *
 * 环境不是官方镜像，是就地建的 venv。环境哪怕差一点，这道题上两条臂都只能是 ❌ ——
 * 花了钱、判据却恒为假，而且**不会报错**。所以只有「把标准答案打上去能判成解决」的题
 * 才准进（`gold.jsonl`，由 gold_gate.py 产出，不花模型的钱）。第一版没这道闸，
 * 15 道题里有 7 道根本判不了，量出来的 13.3% 是纯噪声。
 *
 * ## 环境为什么不是官方 Docker 镜像
 *
 * 官方镜像在 Docker Hub 上，这台机器直连 registry-1.docker.io 直接 EOF，国内镜像站
 * （daocloud）又把 swebench 挡在白名单外。所以环境改成 uv venv 就地建：Python 小版本对得上、
 * 且不需要编译扩展的那部分题（django/sympy/pytest/pylint/requests/flask/xarray，共 253 道）。
 * 代价是少数 P2P 会因 Python 小版本差异天生变红——判分时按 baseline 扣除，**两条臂扣同一批**，
 * 差值不受影响。绝对分因此不与官方榜单可比，这是明写的取舍。
 *
 * ## 防作弊
 *
 * 快照只保留 base_commit 那一刻的工作树，`.git` 重建成单条提交——未来的历史（含标准答案
 * 那次提交）根本不在磁盘上。test_patch 在 agent 干完之后才打，两条臂全程都看不到它。
 *
 * ## 怎么跑
 *
 * ```bash
 * # 题目准备（一次性，见 ~/openpipal-bench/swebench 下的 prep_many.py）
 * OPENPIPAL_CODING_LIVE=1 BENCH_N=20 npx playwright test swebench-ab --workers=3
 * ```
 * 并发靠 Playwright 的 worker：每个 worker 独占一个 Electron 实例和一个端口。
 * 上限受两头夹：内存（一个实例约 400MB）和网关限流（同一把凭据并发打上去会 429）。
 */
import { test, expect } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { launchHeadless, realModelConfig, runTask, type HeadlessApp } from './headless-driver'
import { runPiArm, type ArmResult } from './bench-arms'

const LIVE = !!process.env.OPENPIPAL_CODING_LIVE
// scratch 住家目录，别改回 /tmp——macOS 开机会清 /private/tmp（2026-08-30 因此丢过全部结果）
const SCRATCH = process.env.BENCH_SCRATCH || join(homedir(), 'openpipal-bench', 'swebench')
const PREPARED = join(SCRATCH, 'prepared.jsonl')
const RESULTS = process.env.BENCH_RESULTS || join(SCRATCH, 'ab-results.jsonl')
/** 每条臂的墙钟上限。两条臂必须一样，否则量的是耐心不是能力。 */
const ARM_MS = Number(process.env.BENCH_ARM_MS || 10 * 60 * 1000)
/** 思考档位两臂对齐；不对齐就不是同一个实验。 */
const THINKING = (process.env.BENCH_THINKING || 'low') as 'low' | 'medium' | 'high' | 'max'

interface Prepared {
  iid: string
  repo: string
  ok: boolean
  py: string
  p2p_bad: string[]
  difficulty: string
}

/** 过了标准答案闸门的题号；闸门文件不在就是空集，宁可一道不跑也不跑一批判不了的题。 */
function goldGate(): Set<string> {
  const f = join(SCRATCH, 'gold.jsonl')
  if (!existsSync(f)) return new Set()
  return new Set(readFileSync(f, 'utf8').trim().split('\n').filter(Boolean)
    .map((l) => JSON.parse(l) as { iid: string; gold_ok: boolean })
    .filter((r) => r.gold_ok).map((r) => r.iid))
}

function loadInstances(): Prepared[] {
  if (!existsSync(PREPARED)) return []
  const gate = goldGate()
  const rows = readFileSync(PREPARED, 'utf8').trim().split('\n')
    .filter(Boolean).map((l) => JSON.parse(l) as Prepared)
    .filter((r) => r.ok && gate.has(r.iid))
  const only = process.env.BENCH_ONLY
  const picked = only ? rows.filter((r) => only.split(',').includes(r.iid)) : rows
  const n = Number(process.env.BENCH_N || picked.length)
  return picked.slice(0, n)
}

function problemStatement(iid: string): string {
  const rows = JSON.parse(readFileSync(join(SCRATCH, 'verified.json'), 'utf8')) as any[]
  return rows.find((r) => r.instance_id === iid).problem_statement
}

function taskFor(iid: string, work: string): string {
  const py = existsSync(join(work, '.venv', 'bin', 'python')) ? '.venv/bin/python' : 'python3'
  // 题面原样给，只补一句环境信息 —— 等价于官方镜像已经把依赖装好这件事
  return `这个仓库里有一个待解决的问题，报告如下。请定位并修复它。\n`
    + `依赖已经装好了，跑测试用 \`${py}\`，不要重装依赖。\n\n`
    + `---\n${problemStatement(iid)}\n---\n`
}

/**
 * 两条臂**就地跑在同一个题目目录里**，跑完各自还原，不复制副本。
 *
 * 曾经是复制的，错得很隐蔽：venv 里的可编辑安装把模板的绝对路径写死在
 * `__editable___<pkg>_finder.py` 里，副本中的 `import <pkg>` 仍然解析回模板。
 * 于是 agent 改副本永远不生效——**两条臂都必然判负，而且不报任何错**（xarray/pylint/pytest
 * 那 9 道题就是这么全灭的）；更糟的是聪明一点的 agent 会顺着路径去改模板，
 * 于是 A 臂的修复漏给 B 臂看（实测 3 个模板被写脏）。
 * 就地跑没有这层路径错位，也就没有串味。
 */
function restore(work: string): void {
  execFileSync('bash', ['-lc', 'git checkout -q -- . ; git clean -qfd -e .venv'], { cwd: work })
}

/**
 * 判分**之前**先把 agent 到底改了什么原样存下来。
 *
 * 第一批 40 道跑完才发现这是个大坑：只记了 `git diff --stat` 的摘要，于是事后想问
 * 「它是改错了，还是根本没跑起来」的时候什么都答不上来——两条臂 diffstat 和标准答案
 * 逐字节相同却都判负，光看摘要根本分不清是巧合还是 harness 出了问题。
 *
 * 两样都要：
 *   - `patch`：跟踪文件的完整 diff；
 *   - `untracked`：**未跟踪文件清单**。`git diff` 看不见它们，而 agent 常写
 *     `reproduce.py` / `conftest.py` 这类自查脚本，一个根目录下的坏 conftest.py
 *     就能让整套 pytest collection 失败、所有测试全灭——而且完全不留痕迹。
 */
function capture(work: string): { patch: string; untracked: string[] } {
  const sh = (c: string): string =>
    execFileSync('bash', ['-lc', c], { cwd: work, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
  return {
    patch: sh('git diff HEAD').slice(0, 200_000),
    untracked: sh('git ls-files --others --exclude-standard -- . ":(exclude).venv"').trim().split('\n').filter(Boolean)
  }
}

/**
 * 判分脚本住在仓库里（`tests/bench/`），题库与 venv 住在一次性 scratch 里。
 *
 * `env` 是**显式清洗过**的，不是原样继承：Playwright 的 workerHost 给每个 worker 硬塞
 * `FORCE_COLOR=1`，pytest>=7 认这个变量，于是 `-rA` 摘要每行都以 ANSI 转义开头，
 * 而官方 parser 判的是 `line.startswith('PASSED')` —— 一条都认不出来，parsed=0，
 * **所有测试静静地记成未过**。第一批 40 道有 16 道就这么废了，而且手跑复现不了
 * （普通 shell 没有这个变量）。grade.py 里也钉了一道，这里是第二道。
 */
function judge(iid: string, work: string, exclude: string[]): Record<string, unknown> {
  const env = { ...process.env }
  delete env.FORCE_COLOR
  delete env.CLICOLOR_FORCE
  const out = execFileSync(
    join(SCRATCH, '.tools', 'bin', 'python'),
    [join(process.cwd(), 'tests', 'bench', 'bench_one.py'), iid, work, exclude.join('@@')],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, env }
  )
  return JSON.parse(out.trim().split('\n').pop() as string)
}

/**
 * B 臂的 Electron 实例做成 **worker 级** fixture：一个 worker 起一次、整批题共用。
 * 做成用例级的话每道题多付 5～8 秒启动，几十道题就是好几分钟纯等待。
 */
const bench = test.extend<Record<string, never>, { appB: HeadlessApp; mc: Record<string, unknown> }>({
  mc: [async ({ }, use) => {
    const mc = await realModelConfig()
    if (!mc) throw new Error('读不到用户的 modelConfig —— 真模型对照跑不了')
    await use(mc)
  }, { scope: 'worker' }],
  appB: [async ({ mc }, use, workerInfo) => {
    // 错开用户的 App（3031）和已有用例（3131/3132/3133）
    const ctx = await launchHeadless(mc, 3200 + workerInfo.workerIndex)
    await use(ctx)
    await ctx.dispose()
  }, { scope: 'worker' }]
})

const instances = loadInstances()

bench.describe('SWE-bench 配对对照（真模型）', () => {
  bench.skip(!LIVE || instances.length === 0, '需要 OPENPIPAL_CODING_LIVE=1 且题目已准备好')
  bench.describe.configure({ mode: 'parallel' })

  for (const item of instances) {
    bench(`${item.iid} [${item.repo.split('/')[1]} ${item.difficulty}]`, async ({ appB, mc }) => {
      test.setTimeout(ARM_MS * 2 + 8 * 60 * 1000)
      const work = join(SCRATCH, 'work', item.iid)
      const task = taskFor(item.iid, work)
      try {
        restore(work)
        const a: ArmResult = await runPiArm({
          mc, workingDir: work, task, maxMs: ARM_MS, thinking: THINKING, verbose: true
        })
        const capA = capture(work)
        const gA = judge(item.iid, work, item.p2p_bad || [])

        restore(work)
        const tB = Date.now()
        const bRun = await runTask(appB, { workingDir: work, task, maxMs: ARM_MS, verbose: false })
        const bMs = Date.now() - tB
        const capB = capture(work)
        const gB = judge(item.iid, work, item.p2p_bad || [])

        // `parsed`（解析出多少条测试结果）是分辨"改坏了几条"和"整套没跑起来"的唯一凭据：
        // parser 解析不出来的测试一律按未过计，所以 parsed≈0 时**所有**测试都判负、而且不报错。
        const row = {
          iid: item.iid, repo: item.repo, difficulty: item.difficulty,
          a: { resolved: gA.resolved, gradable: gA.gradable, f2p: gA.f2p, p2p: gA.p2p, p2p_new_fail_n: gA.p2p_new_fail_n, p2p_new_fail: gA.p2p_new_fail, seen: gA.seen, expected: gA.expected, parsed: gA.parsed, test_patch_conflict: gA.test_patch_conflict, log_tail: gA.log_tail, diffstat: gA.diffstat, patch: capA.patch, untracked: capA.untracked, ms: a.ms, tools: a.tools, stop: a.stopReason },
          b: { resolved: gB.resolved, gradable: gB.gradable, f2p: gB.f2p, p2p: gB.p2p, p2p_new_fail_n: gB.p2p_new_fail_n, p2p_new_fail: gB.p2p_new_fail, seen: gB.seen, expected: gB.expected, parsed: gB.parsed, test_patch_conflict: gB.test_patch_conflict, log_tail: gB.log_tail, diffstat: gB.diffstat, patch: capB.patch, untracked: capB.untracked, ms: bMs, events: bRun.events, types: bRun.types, permissions: bRun.permissions.length, stop: bRun.stopReason }
        }
        appendFileSync(RESULTS, JSON.stringify(row) + '\n')
        console.log(`[ab] ${item.iid}  A=${gA.resolved ? '✅' : '❌'}  B=${gB.resolved ? '✅' : '❌'}`)

        // 这条用例的职责是**产出数据**，不是要求谁一定做对；只断言两条臂都真的跑起来了
        expect(a.events, 'A 臂根本没跑起来').toBeGreaterThan(0)
        expect(bRun.events, 'B 臂根本没跑起来').toBeGreaterThan(0)
        // 判分链路故障要当场标红，别再静默混进结果里（`p2p_new_fail` 全绿的假象骗过一次了）。
        // 用 soft 且放在写盘之后：用例照样红，但数据不丢、B 臂不被 A 臂的故障连坐。
        expect.soft(gA.gradable, `${item.iid} A 臂判不了：点名的测试一条都没解析到`).toBe(true)
        expect.soft(gB.gradable, `${item.iid} B 臂判不了：点名的测试一条都没解析到`).toBe(true)
      } finally {
        restore(work)
      }
    })
  }
})

/**
 * 跑一道 SWE-bench Verified 的题 —— 公开 benchmark 接到我们编码助手上的最小可用管道。
 *
 * 用途不是刷分，是**对照**：同一个模型，裸 CLI vs 走我们这层壳，同一批题，差值才是
 * 我们这层的价值（Datacurve 的 DeepSWE 审计里这个差值是 69% → 81%，12 个点全在壳上）。
 *
 * ## 怎么准备输入（都在临时目录里做，不进版本库）
 *
 * ```bash
 * # 1. 取题（HuggingFace datasets-server，免登录、不用下 parquet）
 * curl -s "https://datasets-server.huggingface.co/rows?dataset=princeton-nlp/SWE-bench_Verified\
 * &config=default&split=test&offset=0&length=100" | jq '.rows[0].row' > /tmp/instance.json
 *
 * # 2. 拉仓库到 base_commit，建环境（纯 Python 的仓库不需要 Docker）
 * git clone --filter=blob:none https://github.com/psf/requests.git /tmp/bench/repo
 * cd /tmp/bench/repo && git checkout <base_commit>
 * uv venv .venv --python 3.9 && . .venv/bin/activate && uv pip install -e . pytest
 *
 * # 3. 跑
 * OPENPIPAL_CODING_LIVE=1 SWEBENCH_INSTANCE=/tmp/instance.json \
 *   SWEBENCH_REPO=/tmp/bench/repo npx playwright test swebench-one
 * ```
 *
 * ## 实测成本（2026-08-24，psf__requests-1142）
 *
 * 取题免费 · clone 5s · 建环境 2s（uv）· 造快照 0.7s · **agent 109s** · 判分 0.5s。
 * 适配层本身 130 行，驱动部分整段复用 `headless-driver.ts`。
 * **注意这是轻量仓库的数**：Verified 里 231/500 是 django、75 是 sympy，那些需要重环境，
 * 官方 harness 每题一个 Docker 镜像 —— 那才是真成本，这里没量到。
 *
 * 防作弊（DeepSWE 审计里最大的一条：Opus 4.7 有 18% 的通过是 `git log --all` 读来的）：
 * 快照仓库**只保留 base_commit 那一刻的工作树**，`.git` 整个重建成单条提交，
 * 未来的历史（含标准答案那次提交）根本不在磁盘上。
 *
 * 判题按 SWE-bench 原样：agent 干完之后才打 test_patch，再跑 FAIL_TO_PASS + PASS_TO_PASS。
 * agent 全程看不到 test_patch，也看不到 patch。
 */
import { expect, test } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, readFileSync, rmSync } from 'node:fs'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { launchHeadless, realModelConfig, runTask, tmpRoot, type HeadlessApp } from './headless-driver'

const LIVE = !!process.env.OPENPIPAL_CODING_LIVE
const PORT = 3133
/** 由 scratchpad 里那份 instance.json 驱动；换题只换这个环境变量 */
const INSTANCE = process.env.SWEBENCH_INSTANCE || ''
/** 已经 clone 好并建过 venv 的源仓库，省掉每次重新拉 */
const SOURCE_REPO = process.env.SWEBENCH_REPO || ''

interface Instance {
  instance_id: string
  repo: string
  base_commit: string
  problem_statement: string
  test_patch: string
  FAIL_TO_PASS: string
  PASS_TO_PASS: string
}

function sh(cmd: string, args: string[], cwd: string): { code: number; out: string } {
  try {
    return { code: 0, out: execFileSync(cmd, args, { cwd, encoding: 'utf8' }) }
  } catch (e: any) {
    return { code: e.status ?? 1, out: String(e.stdout || '') + String(e.stderr || '') }
  }
}

test.describe('SWE-bench 单题（真模型）', () => {
  test.skip(!LIVE || !INSTANCE || !SOURCE_REPO, '需要 OPENPIPAL_CODING_LIVE=1 + SWEBENCH_INSTANCE + SWEBENCH_REPO')
  test.setTimeout(20 * 60 * 1000)

  let ctx: HeadlessApp | null = null
  let root = ''

  test.afterAll(async () => {
    await ctx?.dispose()
    if (root) await rm(root, { recursive: true, force: true })
  })

  test('一道题：准备 → 驱动 → 判分', async () => {
    const t0 = Date.now()
    const inst = JSON.parse(readFileSync(INSTANCE, 'utf8')) as Instance
    const f2p: string[] = JSON.parse(inst.FAIL_TO_PASS)
    const p2p: string[] = JSON.parse(inst.PASS_TO_PASS)
    console.log(`[bench] ${inst.instance_id} | F2P=${f2p.length} P2P=${p2p.length}`)

    // ---- 1. 造快照仓库：只留 base_commit 那一刻，未来历史一概不在 ----
    root = await mkdtemp(tmpRoot('swebench'))
    const work = join(root, 'repo')
    cpSync(SOURCE_REPO, work, { recursive: true })
    rmSync(join(work, '.git'), { recursive: true, force: true })
    execFileSync('git', ['init', '-q', '-b', 'main', '.'], { cwd: work })
    // venv 跟着拷进来了（实测：拷过去之后 `import requests` 解析到的是快照自己的源码，
    // 所以 agent 的改动测得到），但绝不能进版本库——几万个文件，且和题目无关
    await writeFile(join(work, '.git', 'info', 'exclude'), '.venv/\n', 'utf8')
    execFileSync('git', ['config', '--local', 'user.email', 'bench@openpipal.local'], { cwd: work })
    execFileSync('git', ['config', '--local', 'user.name', 'Bench'], { cwd: work })
    execFileSync('git', ['add', '-A'], { cwd: work })
    execFileSync('git', ['commit', '-q', '-m', `snapshot @ ${inst.base_commit.slice(0, 10)}`], { cwd: work })
    // 快照是从「已打过 test_patch」的目录拷来的，得先还原成 agent 该看到的样子
    const testPatchPath = join(root, 'test_patch.diff')
    await writeFile(testPatchPath, inst.test_patch, 'utf8')
    const revert = sh('git', ['apply', '-R', testPatchPath], work)
    if (revert.code === 0) {
      execFileSync('git', ['add', '-A'], { cwd: work })
      execFileSync('git', ['commit', '-q', '--amend', '--no-edit'], { cwd: work })
    }
    expect(
      sh('git', ['log', '--all', '--oneline'], work).out.trim().split('\n').length,
      '快照里还留着未来的历史 = 标准答案在磁盘上，等于送分'
    ).toBe(1)
    const tPrep = Date.now()

    // ---- 2. 驱动我们的编码助手 ----
    const py = existsSync(join(work, '.venv', 'bin', 'python')) ? '.venv/bin/python' : 'python3'
    const modelConfig = await realModelConfig()
    expect(modelConfig).not.toBeNull()
    ctx = await launchHeadless(modelConfig as object, PORT)
    const run = await runTask(ctx, {
      workingDir: work,
      // 题面原样给，只补一句环境信息（等价于 SWE-bench 的 docker 镜像已经把环境装好）
      task: `这个仓库里有一个待解决的问题，报告如下。请定位并修复它。\n`
        + `跑测试用 \`${py} -m pytest\`（依赖已装好，不要重装）。\n\n`
        + `---\n${inst.problem_statement}\n---\n`,
      maxMs: 12 * 60 * 1000,
      verbose: true
    })
    const tAgent = Date.now()

    // ---- 3. 判分：现在才打 test_patch ----
    const applied = sh('git', ['apply', testPatchPath], work)
    expect(applied.code, `test_patch 打不上：${applied.out.slice(0, 300)}`).toBe(0)
    const runTests = (ids: string[]) => sh(py.startsWith('.') ? join(work, py) : py, ['-m', 'pytest', '-q', ...ids], work)
    const f2pRes = runTests(f2p)
    const p2pRes = runTests(p2p)
    const tGrade = Date.now()

    const resolved = f2pRes.code === 0 && p2pRes.code === 0
    console.log('[bench] 助手改了什么:\n' + sh('git', ['diff', '--stat', 'HEAD'], work).out.trim())
    console.log('[bench] 回话:', run.reply.slice(0, 700))
    console.log('[bench] F2P:', f2pRes.out.trim().split('\n').slice(-2).join(' | '))
    console.log('[bench] P2P:', p2pRes.out.trim().split('\n').slice(-2).join(' | '))
    console.log('[bench] ===== 判定:', resolved ? 'RESOLVED ✅' : 'UNRESOLVED ❌', '=====')
    console.log(`[bench] 计时  准备 ${(tPrep - t0) / 1000}s | agent ${(tAgent - tPrep) / 1000}s | 判分 ${(tGrade - tAgent) / 1000}s`)

    // 这条探针的目的是量成本，不是要求它一定做对 —— 只断言整条流水线跑通了
    expect(run.events, 'agent 根本没跑起来').toBeGreaterThan(0)
  })
})

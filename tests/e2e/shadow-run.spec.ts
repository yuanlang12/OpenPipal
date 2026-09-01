/**
 * 影子运行：拿 openpipal 自己历史上的真实提交当题目，测「能不能扛日常活」。
 *
 * ## 为什么需要它（SWE-bench 答不了的那部分）
 *
 * SWE-bench 跑完 40 道，我们知道了「干净的 Python bug 修复它 75% 能一次做对」
 * （n=36，剔掉 4 道判分绑死在题面推不出的内部命名上的题）。但那 40 道里：
 * 一行 TypeScript 都没有、没有 UI、没有主/渲染进程边界、没有类型检查、没有多轮。
 * 而这些恰好是这个项目的日常。**所以 75% 不能读成「日常能力 75%」。**
 *
 * 这套把仓库恢复到某次真实提交的**父提交**，把「用户当时提的需求」交给编码助手，
 * 用那次提交自己带的测试当隐藏判据。判据三条（见 `tests/bench/shadow_judge.py`）：
 * F2P 全绿 + 整套单测不回归 + **双 tsc 干净**。最后一条是 SWE-bench 结构上给不了的，
 * 而 40 道里最大的短板恰恰是「改了生产者不改消费者」——类型检查一抓一个准。
 *
 * ## 臂由外面决定，这个文件只跑题
 *
 * 最早是只跑一条臂问绝对能力（SWE-bench 那边配对 40 道已经答完「这层壳比裸 CLI 强多少」，
 * 答案是量不出差别）。后来要验单个机制值不值得留，就在外面用环境变量分臂
 * （`SHADOW_GOAL` / `OPENPIPAL_COMPLETION_GATE`，编排见 `tests/bench/gate_ab.sh`）。
 * 这个文件本身不知道自己在哪条臂上，只把当时的开关状态一起写进结果。
 *
 * ## 自动确认那一轮（2026-08-27 加）
 *
 * 无人值守评测有个**测量假象**：模型按规矩「修前写三点等确认」停下来问，没人答，判 0。
 * 实案 `8b85caba9` 三次独立运行都是这个形态——写齐 Root cause / Files / Proposed fix，
 * 最后一句「确认后我就动手？」。那是守规矩，不是偷懒，可分数上和放弃没有区别。
 *
 * 所以补一轮**自动确认**，扮演那个本该在场的人。触发判据是**磁盘事实**不是文本猜测：
 * 第一轮正常收流（`stream_end`）、说了话、但工作区**一个字节没变** → 发一句固定的确认再跑一轮。
 * 用磁盘判而不是「看它有没有问问号」，是因为三次里只有一次真调了 `ask_user` 工具，
 * 另外两次是拿正文问的——文本判据会漏，而且**两条臂漏得不一样多就成了偏倚**。
 *
 * 副作用是它只可能作用在**本来就判 0 的那批运行**上（工作区没变 = 必然不解决），
 * 所以不会把已经做成的运行搅坏。顺带这也是第一次真正测到**多轮修正**。
 *
 * ### 这个设计留下的偏倚，说清楚，不装干净
 *
 * 补不补确认，取决于第一轮的结果，而第一轮的结果**正是被测机制影响的**——统计上叫
 * 后处理条件化，天然不干净。两处已经堵上：
 *   - **算力对等**：补确认那轮吃的是第一轮剩下的墙钟，两轮合计封顶 `TASK_MS`。
 *     不这么做的话，更容易走到「零改动」的那条臂会白拿一整份新墙钟。
 *   - **信息对等**：`CONFIRM` 只回答「确认吗」，不给工作区事实、不要求汇报、也不催落盘（见下）。
 *
 * 堵不上的那部分照实说：开闸臂在第一轮里就可能被闸门推回去干活，于是**更少走到补确认**；
 * 而它一旦仍然零改动，就会先后吃到闸门和确认**两次推动**。两条臂拿到的推动次数分布本来就不同，
 * 这是机制本身造成的，不是 harness 的偏差——但读数时别把它当成「纯粹的闸门效果」。
 *
 * ## 防作弊
 *
 * 快照只保留父提交那一刻的工作树，`.git` 重建成单条提交——**这次提交本身、
 * 以及它之后的历史，都不在磁盘上**。官方测试补丁在 agent 干完之后才打。
 *
 * 一处这个项目特有的泄题风险：`CLAUDE.md` 和 `docs/claude/*.md` 常在同一次提交里
 * 记录这次改动的结论。取父提交就绕开了——那时文档还没写。至于更早的提交已经写进文档的
 * 部分，那属于真实工作条件（日常干活时文档本来就在），不处理。
 *
 * ## 怎么跑
 *
 * ```bash
 * python3 tests/bench/shadow_prep.py <commit...>     # 建题库（含闸门）
 * python3 tests/bench/shadow_leakcheck.py            # 读 tasks.json → leakcheck.json
 * OPENPIPAL_CODING_LIVE=1 npx playwright test shadow-run --workers=3
 * ```
 *
 * 这三步都只要系统 python3（脚本零第三方依赖），不必先建 SWE-bench 那套 scratch。
 */
import { test, expect } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import {
  launchHeadless, realModelConfig, runTask, UNATTENDED_CONFIRM,
  type HeadlessApp, type TaskResult
} from './headless-driver'

const LIVE = !!process.env.OPENPIPAL_CODING_LIVE
/**
 * scratch 住家目录，**不要改回 `/tmp`**：macOS 开机清 `/private/tmp`，
 * 2026-08-30 装系统更新重启，把三批跑批结果和 A/B 的 39 条原始记录一起清掉了，
 * 连手写的 `tasks.json` 题面都没了（那个没有任何脚本能重新生成）。
 *
 * 放家目录不额外占盘：`shadow_prep.py` 用 `cp -c` 做 APFS 写时复制克隆 node_modules，
 * 而 `/private/tmp` 与 `$HOME` 在同一个 APFS 卷（都是 `/System/Volumes/Data`），克隆照样成立。
 *
 * 也不要改成 `os.tmpdir()`：它在 macOS 解析到 `/private/var/folders/…`，
 * 而 `/private/var` 在 `deniedWorkspaceRoots()` 的 subtree 里——工作目录判定会直接拒，
 * 编码助手一个字节都写不进去。
 */
const SCRATCH = process.env.SHADOW_SCRATCH || join(homedir(), 'openpipal-bench', 'shadow')
const BENCH_SCRATCH = process.env.BENCH_SCRATCH || join(homedir(), 'openpipal-bench', 'swebench')
/**
 * 判分用的解释器。`shadow_judge.py` 和它 import 的 `shadow_prep.py` 只用标准库
 * （json/os/re/subprocess/sys/collections/shutil/time），没有任何第三方依赖，
 * 所以系统 python3 就够。SWE-bench 那套 scratch 的 `.tools/bin/python` 在就优先用它
 * （跟 SWE-bench 侧保持同一个解释器），不在就回落系统 python3——
 * 这样只想跑影子运行时，不必先把 SWE-bench 那一整套 scratch 建起来。
 */
const JUDGE_PYTHON = process.env.JUDGE_PYTHON
  || (existsSync(join(BENCH_SCRATCH, '.tools', 'bin', 'python'))
    ? join(BENCH_SCRATCH, '.tools', 'bin', 'python')
    : 'python3')
const RESULTS = process.env.SHADOW_RESULTS || join(SCRATCH, 'shadow-results.jsonl')
/**
 * 墙钟上限。比 SWE-bench 那边（8 分钟）宽得多——这些是真实提交，
 * 当初人做也是半小时到两小时的量级。给 20 分钟量的才是能力，不是打字速度。
 */
const TASK_MS = Number(process.env.SHADOW_TASK_MS || 20 * 60 * 1000)
/**
 * 开不开 GoalChecker 续跑闸（`SHADOW_GOAL=1`）。
 *
 * 第一轮影子运行是**关着**跑的——那之后才发现这个机制虽然写完也接好了，却要用户显式打
 * `/goal` 才挂得上，于是此前所有 benchmark（影子运行 7 道、SWE-bench 40 道）都没测到它。
 * 它的判定提示词（`main/goal-checker.ts`）原话是「模型声称 done 却没有具体证据
 * （没跑测试、没给文件、没引结果）就判 ok=false」。
 * 注意别把它当成「正对 7/7 那个失败形态」——那个说法**已经被推翻**（见文件头「自动确认那一轮」）：
 * 7/7 只是「自己宣布收工」，不等于「收工得太早」，其中至少一道是在按规矩等确认。
 *
 * 两条臂只差这一个开关，其余（题目、墙钟、判分、工作目录）逐字一致；
 * 结果落到不同的 SHADOW_RESULTS 文件里，再做配对比较。
 */
// 用 `!== '0'` 而不是 `!!`：`SHADOW_GOAL=0` 是一个非空字符串，`!!` 判真，于是「关掉」的
// 意图反过来把 GoalChecker **打开**，而结果行里还老老实实写着 `goalOn: true`——自洽得
// 事后一点看不出来。六行之下的 `GATE_ON` 一直是这个写法，同一个文件里两个开关不该说两种话。
const GOAL_ON = !!process.env.SHADOW_GOAL && process.env.SHADOW_GOAL !== '0'
/**
 * ⚠️ 收工闸已于 2026-08-28 拆除（配对对照两臂量不出差别，见 mechanism-registry.md「已拆除」一节）。
 *
 * **写死 false，不要再读那个环境变量。** 原来的写法是 `!== '0'`，机制拆掉之后它会给每一条
 * 新记录盖上 `gateOn: true`——描述一个磁盘上根本不存在的机制。那正是上面六行警告过的同一类
 * 错（结果行自洽、事后一点看不出来），只不过换到了另一个开关上。
 *
 * 跨 2026-08-28 比数之前先看这个字段：**那天之前记的 `gateOn: true` 是真的有那道闸**
 * （闸门代码是 opt-out，环境变量不设就是开着的）。
 */
const GATE_ON = false
/**
 * 自动确认那一轮的墙钟**上限**（还要再和「第一轮剩下多少」取小）。
 *
 * 两条约束叠在一起：单轮不超过这个数，两轮合计不超过 `TASK_MS`。后一条是为了算力对等——
 * 容易走到「零改动」的那条臂不能白拿一整份新墙钟，否则量出来的差别分不清是机制还是时间。
 * 15 分钟这个上限基本用不上：会触发补确认的都是第一轮 3~6 分钟就停手的那批，剩得多。
 */
const FOLLOWUP_MS = Number(process.env.SHADOW_FOLLOWUP_MS || 15 * 60 * 1000)
/**
 * 扮演那个本该在场的人。**逐字固定、两条臂一模一样**，改一个字都会污染对照——
 * 所以话本身连同那四条约束住在 `headless-driver`，`followup-probe.spec.ts` 用的是同一份。
 */
const CONFIRM = UNATTENDED_CONFIRM

/**
 * 工作区快照，和收工闸同一个口径（`-uall`，否则新建的单个文件会被折叠进目录看不见）。
 *
 * 兜死：它在第一轮跑完之后才被调用，那时候已经烧掉了最多半小时真模型时间。
 * git 抖一下就抛异常的话，整轮数据陪葬。抛不出来就返回 null，上层按「判不了」处理。
 * maxBuffer 也得给够——默认 1MiB，模型批量新建文件时 `-uall` 的输出能顶上去。
 */
function worktree(work: string): string | null {
  try {
    return execFileSync('git', ['status', '--porcelain=v1', '-uall'], {
      cwd: work, encoding: 'utf8', timeout: 30_000, maxBuffer: 16 * 1024 * 1024
    })
  } catch (e) {
    console.log(`[shadow] git status 挂了（${String((e as Error).message).slice(0, 80)}）——这轮不补确认`)
    return null
  }
}

interface Prepared { commit: string; ok: boolean; subject: string; f2p: string[]; baseline_bad: string[]; thin_suite?: boolean }
interface TaskDef { commit: string; task: string; dimension: string; user_visible_outcome: string }

/**
 * 一道题要跑，得同时过两道闸：
 *   - `prepared.jsonl` 的**标准答案闸门**（打上官方修复能判成解决，否则判据恒为假）；
 *   - `leakcheck.json` 的**题目体检**（没泄题、而且**判据是可解的**）。
 *
 * 泄题那一路是拿自己仓库当题库才有的：这个项目要求「新机制 → mechanism-registry.md 登记」，
 * 而文档常和代码在同一轮工作里提交、只是拆成两个 commit——取父提交绕不开。
 * 实案：`55c864633` 的父提交在 95 秒前，文档里已经把三个改点连同故障形态原样写好了。
 *
 * **可解性那一路是 2026-08-28 归因补的，方向正好相反**：前一版语料 7 道里有 4 道判分绑死在
 * 只有看过标准答案才知道的东西上（凭空猜中作者新导出的符号名 / 原样复述源码 / 撞中一个
 * 题面明说「你自己拿捏」的魔数）。症状是这 4 道六轮 A/B 的 F2P 分数逐轮一模一样
 * （`0/5`×6、`2/10`×5）——每多跑一轮，测的都还是同一件「猜没猜中命名」。
 * 标准答案闸门抓不到：作者的补丁天然能过作者自己的测试。判据见 `shadow_leakcheck.py` ③。
 *
 * 闸门文件不在就是空集：宁可一道不跑，也不跑一批已经泄了题或本来就做不出来的。
 */
function load(): { p: Prepared; t: TaskDef }[] {
  const pf = join(SCRATCH, 'prepared.jsonl')
  const tf = join(SCRATCH, 'tasks.json')
  const lf = join(SCRATCH, 'leakcheck.json')
  if (!existsSync(pf) || !existsSync(tf) || !existsSync(lf)) return []
  const clean = new Set((JSON.parse(readFileSync(lf, 'utf8')) as { commit: string; ok: boolean }[])
    .filter((r) => r.ok).map((r) => r.commit))
  const prepared = readFileSync(pf, 'utf8').trim().split('\n').filter(Boolean)
    .map((l) => JSON.parse(l) as Prepared).filter((r) => r.ok)
  const tasks = new Map((JSON.parse(readFileSync(tf, 'utf8')) as TaskDef[]).map((t) => [t.commit, t]))
  const only = process.env.SHADOW_ONLY
  return prepared
    .filter((p) => tasks.has(p.commit) && clean.has(p.commit))
    .filter((p) => !only || only.split(',').includes(p.commit))
    .map((p) => ({ p, t: tasks.get(p.commit)! }))
}

/**
 * 等工作区不动了再判分。
 *
 * 撞墙钟那种停法是**客户端单方面断流**：`runTask` 取消 reader → socket 关 →
 * 服务端 `res.once('close')` 里 `abort.abort()`（`http-server.ts:922`）。但中止不是瞬时的，
 * 手上那次工具调用（很可能正是一次 `npx vitest`）还在往磁盘写。这时候直接开判，
 * 判分器读到的是半截状态——那一行数据就是垃圾，而且看不出来是垃圾。
 *
 * 连续两次快照一致才算停稳。最多等 `maxMs`，等不到就照判（宁可脏一行，不吊死整轮）。
 */
async function settle(work: string, maxMs = 30_000): Promise<boolean> {
  const deadline = Date.now() + maxMs
  let prev: string | null = null
  while (Date.now() < deadline) {
    // 用定时器，不要 `execFileSync('sleep', …)`：后者除了白起一个进程，还会把 worker 的
    // 事件循环整整卡死 3 秒——而这个函数跑在 async 用例体里，同一个循环上还挂着 Electron
    // 的 stdio 管道和 SSE 连接。等着工作区停稳的时候不该顺手停掉收流。
    await new Promise((r) => setTimeout(r, 3000))
    const now = worktree(work)
    if (now !== null && now === prev) return true
    prev = now
  }
  return false
}

/** 每道题跑完必须还原：node_modules 留着（1.1G，且是 APFS 写时复制挂进来的） */
function restore(work: string): void {
  execFileSync('bash', ['-lc', 'git checkout -q -- . ; git clean -qfd -e node_modules'], { cwd: work })
}

function judge(commit: string, work: string): Record<string, unknown> {
  // 环境显式清洗：Playwright 的 workerHost 给每个 worker 硬塞 FORCE_COLOR=1，
  // 而判分靠解析 vitest 输出——ANSI 转义会让匹配全部落空、所有测试静默判负。
  // 这一课在 SWE-bench 那边花了 40% 的样本（见 tests/bench/README.md）。
  const env = { ...process.env }
  delete env.FORCE_COLOR
  delete env.CLICOLOR_FORCE
  const out = execFileSync(
    JUDGE_PYTHON,
    [join(process.cwd(), 'tests', 'bench', 'shadow_judge.py'), commit, work],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, env }
  )
  return JSON.parse(out.trim().split('\n').pop() as string)
}

const bench = test.extend<Record<string, never>, { app: HeadlessApp; mc: Record<string, unknown> }>({
  mc: [async ({ }, use) => {
    const mc = await realModelConfig()
    if (!mc) throw new Error('读不到用户的 modelConfig —— 真模型影子运行跑不了')
    await use(mc)
  }, { scope: 'worker' }],
  app: [async ({ mc }, use, workerInfo) => {
    // 错开用户的 App（3031）、已有用例（3131-3133）与 SWE-bench 对照（3200+）
    const ctx = await launchHeadless(mc, 3300 + workerInfo.workerIndex)
    await use(ctx)
    await ctx.dispose()
  }, { scope: 'worker' }]
})

const items = load()

bench.describe('影子运行：真实提交当题目（真模型）', () => {
  bench.skip(!LIVE || items.length === 0, '需要 OPENPIPAL_CODING_LIVE=1 且题库已准备好')
  bench.describe.configure({ mode: 'parallel' })

  for (const { p, t } of items) {
    bench(`${p.commit.slice(0, 9)} [${t.dimension}] ${p.subject.slice(0, 40)}`, async ({ app }) => {
      // 两轮合计封顶就是 TASK_MS（见 FOLLOWUP_MS 的注释），余下给判分：
      // `judge()` 是 execFileSync 同步阻塞（vitest 全量 + 双 tsc），playwright 的超时
      // 在同步调用期间根本执行不到，这里给的余量只是别让它先于判分到期。
      test.setTimeout(TASK_MS + 15 * 60 * 1000)
      const work = join(SCRATCH, 'work', p.commit)
      try {
        restore(work)
        const clean = worktree(work)
        const t0 = Date.now()
        const run = await runTask(app, {
          workingDir: work, task: t.task, maxMs: TASK_MS, verbose: false,
          // 目标就用交给它的那条需求原文——不额外加料，否则量的是「我多写了什么」而不是「闸门有没有用」
          goal: GOAL_ON ? t.task : undefined
        })

        // 自动确认那一轮。四条判据同时成立才发（详见文件头）：
        //   ① **收到过 done 事件**——不能只看 `stopReason === 'stream_end'`：上游把流打死
        //      也是同样的收流形状（实测 6 次），那种是基础设施故障，不是"停下来等确认"，
        //      白发一轮还会绕过报告的作废判定。`done` 只在正常收尾时发，是干净信号；
        //   ② 它说了话——一个字都没有的必然是被打死的；
        //   ③ 工作区一个字节没变——磁盘事实，不猜文本（`null` = git 挂了，按不补处理）；
        //   ④ 还有墙钟剩——见下面 `left`。
        // 没收到 done = 客户端单方面断的流（撞墙钟 / 空闲超时 / 被打死），
        // agent 可能还在写盘。先等它停稳，再去看「工作区变没变」和判分。
        let settled = true
        if ((run.types.done ?? 0) === 0) settled = await settle(work)

        const after = worktree(work)
        // 第二轮**吃的是第一轮剩下的预算，不是新开一份**。
        // 不这么做的话，容易走到「零改动」的那条臂（多半是关闸臂）会白拿一整份新墙钟，
        // 两条臂的算力就不对等了——量出来的差别分不清是闸门的功劳还是多给的时间。
        const left = Math.min(FOLLOWUP_MS, TASK_MS - (Date.now() - t0))
        const followable = (run.types.done ?? 0) > 0
          && run.reply.trim().length > 0
          && after !== null && after === clean
          && left > 60_000
        let run2: TaskResult | null = null
        let followErr: string | null = null
        if (followable) {
          console.log(`[shadow] ${p.commit.slice(0, 9)} 第一轮零改动，补一次自动确认（剩 ${(left / 60000).toFixed(1)} 分钟）`)
          try {
            run2 = await runTask(app, {
              workingDir: work, task: CONFIRM, maxMs: left, verbose: false,
              conversationId: run.conversationId,
              // 服务端只给 ACP 回放历史，extension 来源必须自己带（见 headless-driver 里 history 的注释）。
              // 只带得动正文，带不动第一轮的工具轨迹——它会重新读一遍文件，这是已知的保真度损失。
              history: [{ role: 'user', content: t.task }, { role: 'assistant', content: run.reply }],
              goal: GOAL_ON ? t.task : undefined
            })
          } catch (e) {
            // **必须兜住**。第二轮一抛异常，连已经跑满半小时的第一轮数据一起丢，
            // 那道题在 jsonl 里静默消失——而只有"够格补确认"的运行才走得到这里，
            // 丢行是按臂不对称的，等于给对照实验开了个只朝一边漏的洞。
            followErr = String((e as Error).message).slice(0, 200)
            console.log(`[shadow] ${p.commit.slice(0, 9)} 补确认那轮挂了：${followErr}`)
          }
        }
        const ms = Date.now() - t0
        // 补确认那一轮也可能被断流打断，判分前同样要等停稳
        if (run2 && (run2.types.done ?? 0) === 0) settled = (await settle(work)) && settled
        // 判分同样要兜住，理由和上面那个 catch 一模一样、代价还更大：`judge()` 走
        // `execFileSync`（非零退出或 maxBuffer 溢出就抛）再 `JSON.parse`（空输出抛 SyntaxError），
        // 任何一样漏出来，这一整行——连同已经烧掉的最多 40 分钟真模型时间——就在 jsonl 里
        // 静默消失。而判分输出的大小随 `patch`（20 万字符）+ `untracked` + `log_tail` 增长，
        // **干得越多越容易溢出**，丢行因此偏向"有产出的运行"，比随机丢更糟。
        let g: Record<string, unknown>
        try {
          g = judge(p.commit, work)
        } catch (e) {
          const why = String((e as Error).message).slice(0, 300)
          console.log(`[shadow] ${p.commit.slice(0, 9)} 判分挂了：${why}`)
          g = {
            resolved: false, gradable: false, f2p: [0, 0], f2p_fail: [],
            regress_n: 0, regress: [], tsc: {}, tsc_tail: {},
            total_tests: 0, seen: 0, log_tail: '', patch: '', untracked: [],
            judgeErr: why
          }
        }

        const types = { ...run.types }
        for (const [k, v] of Object.entries(run2?.types ?? {})) types[k] = (types[k] ?? 0) + v

        appendFileSync(RESULTS, JSON.stringify({
          commit: p.commit, subject: p.subject, dimension: t.dimension, task: t.task,
          goalOn: GOAL_ON, gateOn: GATE_ON, round: process.env.SHADOW_ROUND || '1',
          resolved: g.resolved, gradable: g.gradable, f2p: g.f2p, f2p_fail: g.f2p_fail,
          regress_n: g.regress_n, regress: g.regress, tsc: g.tsc, tsc_tail: g.tsc_tail,
          total_tests: g.total_tests, seen: g.seen, log_tail: g.log_tail,
          // 快照的单测套件太薄时「不回归」这条判据形同虚设（老提交上实测只有 70 条）。
          // 带着这个标记走，读数时别把「没测出回归」读成「没有回归」。判据见 shadow_prep.THIN_SUITE
          thinSuite: !!p.thin_suite,
          patch: g.patch, untracked: g.untracked,
          ms, events: run.events + (run2?.events ?? 0), types,
          permissions: run.permissions.length + (run2?.permissions.length ?? 0),
          stop: run.stopReason,
          // 它最后说了什么。第一轮忘了记，结果 `8b85caba9` 那道「2 分钟、9 次工具调用、
          // 一个字节没改就说完事了」完全没法归因——后来正是靠这个字段查出它其实在等确认。
          // `reply` 恒为**第一轮**原话（下游 `gate_report.js` 的作废判定依赖这个口径）。
          reply: run.reply,
          turns: run2 ? 2 : 1,
          // 够格补确认但没补成（异常/墙钟没剩）也要记下来，否则报告里和「压根不够格」分不开
          followable, followErr,
          // false = 判分开始时工作区还在动，这一行的判分结果不可信
          settled,
          reply2: run2?.reply ?? null,
          stop2: run2?.stopReason ?? null,
          // 上游到底报了什么错。没有这个字段，「作废」只能判出「有 error」，判不出是不是服务商挂了
          errors: [...run.errors, ...(run2?.errors ?? [])],
          // 第一轮到底有没有真的在问。只记录不参与判定——留着回头核对「磁盘判据」漏了多少。
          askedFirst: (run.types.ask_user ?? 0) > 0 || /[？?]\s*$/.test(run.reply.trim())
        }) + '\n')
        console.log(`[shadow] ${p.commit.slice(0, 9)} ${g.resolved ? '✅' : '❌'}`
          + `  F2P=${JSON.stringify(g.f2p)} 回归=${g.regress_n} tsc=${JSON.stringify(g.tsc)}`
          + `  轮次=${run2 ? 2 : 1}`)

        // 这条用例的职责是**产出数据**，不是要求它一定做对
        expect(run.events, 'agent 根本没跑起来').toBeGreaterThan(0)
        expect.soft(g.gradable, `${p.commit} 判不了：点名的测试一条都没解析到`).toBe(true)
      } finally {
        restore(work)
      }
    })
  }
})

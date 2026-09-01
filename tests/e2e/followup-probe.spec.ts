/**
 * 自动确认那一轮的接线探针 —— 只验「第二轮发得出去、且带着上文」，不验模型改得对不对。
 *
 * 为什么单独要这么一条：影子运行**碰不到这条路**。它只在「第一轮零改动」时才触发，
 * 而那取决于模型当天的脾气——2026-08-27 换到新模型之后实测：同一道题上一个模型停下来问
 * 「确认后我就动手？」（零改动），新模型直接干满 15 分钟墙钟、写了 62 行。
 * 拿一道半小时的真题去赌它会不会停下来问，验不了一段接线。
 *
 * 所以这里造一个**必然零改动**的第一轮：明说「先别动代码，只说方案」。
 * 模型照做 → 工作区没变 → 影子运行那边的四条判据全中 → 补一句确认 → 它才动手。
 *
 * 三个已知会咬人的点，这条探针就是来盯它们的：
 *   1. 会话执行锁**刻意**留到 finally 才放（`http-server.ts:919`），第一轮读到流末尾时锁还攥着，
 *      紧接着发第二轮会撞 409 —— `headless-driver` 里那段重试就是为这个；
 *   2. 服务端只给 ACP 回放历史，extension 来源必须调用方自己带 `history`，
 *      不带的话模型看到的是一句没有上文的「确认，就按你上面的方案做」；
 *   3. 第二轮要真的落盘，不能只是又说一遍方案。
 */
import { test, expect } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchHeadless, realModelConfig, runTask, UNATTENDED_CONFIRM } from './headless-driver'

const LIVE = !!process.env.OPENPIPAL_CODING_LIVE

/** 和影子运行**是同一个常量**，不是抄的——探针验的就是评测真正发出去的那句话。 */
const CONFIRM = UNATTENDED_CONFIRM

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'followup-probe-'))
  mkdirSync(join(dir, 'src'), { recursive: true })
  writeFileSync(
    join(dir, 'src', 'hello.ts'),
    'export function greet(name: string): string {\n  return \'hello \' + name\n}\n'
  )
  const git = (args: string[]): void => { execFileSync('git', args, { cwd: dir, stdio: 'ignore' }) }
  git(['init', '-q', '.'])
  git(['config', 'user.email', 'probe@probe'])
  git(['config', 'user.name', 'probe'])
  git(['add', '-A'])
  git(['commit', '-qm', 'base'])
  return dir
}

const worktree = (dir: string): string =>
  execFileSync('git', ['status', '--porcelain=v1', '-uall'], { cwd: dir, encoding: 'utf8' })

test.describe('自动确认那一轮', () => {
  test.skip(!LIVE, '需要 OPENPIPAL_CODING_LIVE=1 和真模型')

  test('第一轮零改动 → 补一句确认 → 第二轮带着上文真动手', async () => {
    test.setTimeout(12 * 60 * 1000)
    const mc = await realModelConfig()
    expect(mc, '读不到用户的 modelConfig').toBeTruthy()
    const ctx = await launchHeadless(mc!, 3398)
    const work = makeRepo()
    try {
      const clean = worktree(work)

      const run1 = await runTask(ctx, {
        workingDir: work,
        task: '看一下 src/hello.ts 里的 greet：想让它支持自定义问候语（第二个可选参数 greeting，默认 "hello"）。'
          + '**先别动代码**，只用三五句话说清你打算怎么改、有没有别的取舍。等我确认。',
        maxMs: 4 * 60 * 1000,
        idleMs: 60_000
      })

      // 第一轮必须满足影子运行那四条判据，否则下面验的就不是同一条路
      expect(run1.types.done ?? 0, `第一轮没收到 done —— 上游报错：${run1.errors.join(' | ')}`).toBeGreaterThan(0)
      expect(run1.reply.trim().length, '第一轮一个字都没说').toBeGreaterThan(0)
      expect(worktree(work), '第一轮就动手改了 —— 这条探针要的是「零改动」那条路').toBe(clean)

      const run2 = await runTask(ctx, {
        workingDir: work,
        task: CONFIRM,
        maxMs: 5 * 60 * 1000,
        idleMs: 60_000,
        conversationId: run1.conversationId,
        history: [
          { role: 'user', content: '（同上一轮的需求）' },
          { role: 'assistant', content: run1.reply }
        ]
      })

      // ① 第二轮真的跑起来了（撞 409 会在这里现形：runTask 抛，用例直接红）
      expect(run2.events, `第二轮没跑起来 —— 上游报错：${run2.errors.join(' | ')}`).toBeGreaterThan(0)
      expect(run2.conversationId, '第二轮没复用同一条会话').toBe(run1.conversationId)
      // ② 它得真落盘，不能只是又把方案说一遍
      const after = worktree(work)
      expect(after, '补完确认它还是一个字节没改 —— 要么 history 没带上，要么那句话它没当成"动手"的指令')
        .not.toBe(clean)
      expect(after).toContain('src/hello.ts')

      const diff = execFileSync('git', ['diff', '--stat'], { cwd: work, encoding: 'utf8' })
      console.log(`[探针] 第一轮回复 ${run1.reply.length} 字、零改动；第二轮改动:\n${diff}`)
    } finally {
      await ctx.dispose()
      // 每跑一次就在 tmpdir 里留一个 git 仓库，不删就一直攒
      rmSync(work, { recursive: true, force: true })
    }
  })
})

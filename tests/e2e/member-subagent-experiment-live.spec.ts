import { expect, test } from '@playwright/test'
import { cp, mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { launchIsolatedElectron, type IsolatedElectron } from './helpers'
import { drivePermissions, lastReply, realModelConfig, send, toolTrail, waitForTurn, type StoreWindow } from './live-helpers'

/**
 * 团队成员的规模探针（真模型）：N 篇作文交给批改专家打分汇总，记下批了几篇 / 成员几轮 / 有没有撞 60 轮上限 /
 * 嵌套子代理几次 / 耗时 / token，写进 tests/artifacts/member-subagent-experiment/<组>-<N>/results.json。不判通过失败。
 *
 * 2026-09-18 用它做过一次对照（A = 现状，B = 临时开关让成员拿到通用 subagent，开关已删）：
 *   60 篇：两组都 60/60，成员 16 vs 10 轮，token 一样；B 组有工具也一次没用。
 *   300 篇：A 组组长自己分 6 批交接（974s，每批 17–26 轮，一批断流后重试），逐篇读、理由具体；
 *           B 组一次交接 12 轮就"批完"（133s），理由全是三句套话；按 token 看没逐篇读（4.2 万输入 < 6 万字原文），是抄近道。仍没用子代理。
 *   结论：成员开子代理不带来兼容性，黑名单照旧；要盯的是"抄近道"这种质量问题，不是容量。
 *
 *   OPENPIPAL_HOOKS_LIVE=1 EXP_ESSAYS=60 npx playwright test member-subagent-experiment-live
 */

const LIVE = !!process.env.OPENPIPAL_HOOKS_LIVE
const GROUP = (process.env.EXP_GROUP || 'A').toUpperCase()
const ESSAYS = Number(process.env.EXP_ESSAYS || 60)
const ARTIFACTS = `tests/artifacts/member-subagent-experiment/${GROUP}-${ESSAYS}`
const LEAD_ID = '7b60beb5-expt-4000-8000-00000000lead'
const MEMBER_ID = '7b60beb5-expt-4000-8000-0000000member'
const TEAM_ID = 'team-expt-0001'

const REQUEST = `共享文件夹 作文/ 里有 ${ESSAYS} 篇初二学生的作文，每篇一个 .md 文件。请把批改工作交接给批改专家：每篇按 10 分制打分并写一句话理由，把全部结果写进共享文件夹的 批改结果.md，每篇一行，格式「文件名 | 分数 | 理由」。做完后告诉我一共批了多少篇、还有哪几篇没批。`

// ---- 作文生成（确定性，两组拿到一模一样的 60 篇）----
function seeded(seed: number): () => number {
  let s = seed
  return () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff }
}
const TOPICS = ['我的妈妈', '难忘的一次旅行', '我最喜欢的季节', '一件小事', '我的理想', '校园的早晨', '读书的乐趣', '一次失败的经历', '家乡的变化', '我的好朋友']
const OPENERS = ['说起{T}，我的心里总会涌起一股暖流。', '每当我想到{T}，脑海里就浮现出许多画面。', '在我的记忆里，{T}是一段抹不去的故事。', '如果有人问我最想写什么，我一定会说：{T}。']
const BODIES = [
  '那是一个普通的周末，阳光透过窗帘洒在书桌上，我却怎么也静不下心来。',
  '妈妈没有责备我，只是轻轻地把一杯温水放在我手边，然后默默地走开了。',
  '我们沿着小路走了很久，路边的野花开得正盛，蜜蜂在花间忙碌地飞来飞去。',
  '老师说，失败并不可怕，可怕的是不敢再试一次。这句话我一直记在心里。',
  '那一刻我忽然明白了，原来最珍贵的东西，往往就藏在最平常的日子里。',
  '傍晚的时候，天边泛起了橘红色的晚霞，整个村子都被染成了金色。',
  '我把书翻到最后一页，长长地舒了一口气，心里既满足又有些舍不得。',
  '后来我才知道，那天他其实发着烧，却还是坚持陪我走完了全程。',
  '同学们都在操场上跑步，我却站在跑道边，犹豫着要不要迈出第一步。',
  '外婆家门口的那棵老槐树，不知什么时候已经被砍掉，换成了一排整齐的路灯。'
]
const CLOSERS = ['{T}，教会了我什么是坚持。', '这就是{T}，平凡，却让我难以忘怀。', '我想，这段关于{T}的记忆，会一直陪着我长大。', '从那以后，每当想起{T}，我都会告诉自己：再努力一点。']
const OFFTOPIC = '对了，我最近在玩一款新出的手机游戏，里面的角色可以升级装备，我已经打到第三十关了，周末还要和同学开黑。'

function makeEssay(i: number, rng: () => number): { name: string; body: string; flaw: string } {
  const topic = TOPICS[i % TOPICS.length]
  const pick = <T,>(arr: T[]): T => arr[Math.floor(rng() * arr.length)]
  const fill = (s: string): string => s.replace('{T}', topic)
  const flaw = pick(['none', 'none', 'none', 'short', 'repeat', 'offtopic', 'noending'])
  const paras: string[] = [fill(pick(OPENERS))]
  const n = flaw === 'short' ? 1 : 4 + Math.floor(rng() * 2)
  const used = new Set<number>()
  for (let k = 0; k < n; k++) {
    let idx = Math.floor(rng() * BODIES.length)
    while (used.has(idx)) idx = (idx + 1) % BODIES.length
    used.add(idx)
    paras.push(BODIES[idx])
  }
  if (flaw === 'repeat') paras.push(paras[1], paras[1])
  if (flaw === 'offtopic') paras.splice(2, 0, OFFTOPIC)
  if (flaw !== 'noending') paras.push(fill(pick(CLOSERS)))
  const name = `${String(i + 1).padStart(2, '0')}-${topic}.md`
  return { name, body: `# ${topic}\n\n${paras.join('\n\n')}\n`, flaw }
}

async function writePal(home: string, id: string, name: string, description: string, persona: string): Promise<void> {
  const dir = join(home, '.openpipal', 'agents', id)
  await mkdir(join(dir, 'memory'), { recursive: true })
  await mkdir(join(dir, 'skills'), { recursive: true })
  await writeFile(join(dir, 'meta.json'), JSON.stringify({ id, name, icon: '📝', description, createdAt: Date.now(), updatedAt: Date.now() }), 'utf8')
  await writeFile(join(dir, 'agent.md'), persona, 'utf8')
}

test.describe(`成员子代理对照实验 · ${GROUP} 组（真模型）`, () => {
  test.skip(!LIVE, '真调模型花钱，默认不跑')
  test.setTimeout(32 * 60 * 1000)

  let app: IsolatedElectron | null = null

  test.afterEach(async () => {
    if (app) {
      for (const rel of ['conversations', 'teams', 'audit.log']) {
        await cp(join(app.home, '.openpipal', rel), join(ARTIFACTS, rel), { recursive: true }).catch(() => undefined)
      }
    }
    await app?.dispose()
    app = null
  })

  test(`${ESSAYS} 篇作文交给批改专家：记下批了几篇、几轮、嵌套几次、耗时`, async ({}) => {
    const modelConfig = await realModelConfig()
    expect(modelConfig, '隔离 home 里没有模型配置就只会停在"没配 key"').not.toBeNull()
    await mkdir(ARTIFACTS, { recursive: true })

    app = await launchIsolatedElectron({
      config: { modelConfig: modelConfig as object },
      env: { OPENPIPAL_HTTP_PORT: '3141' }
    })
    const page = await app.app.firstWindow()
    await page.waitForLoadState('domcontentloaded')

    // 团队 + 两个 Pal + 60 篇作文
    await writePal(app.home, LEAD_ID, '教研组长', '初二语文教研统筹', '# 教研组长\n\n你是初二语文教研组的组长，负责统筹分派。回答简洁。\n')
    await writePal(app.home, MEMBER_ID, '批改专家', '初二语文作文批改', '# 批改专家\n\n你专门批改初二学生的作文，10 分制，给分要有一句话依据。\n')
    const teamDir = join(app.home, '.openpipal', 'teams', TEAM_ID)
    const essayDir = join(teamDir, 'shared', '作文')
    await mkdir(essayDir, { recursive: true })
    await mkdir(join(teamDir, 'memory'), { recursive: true })
    await writeFile(join(teamDir, 'team.md'), ['---', 'name: 语文教研组', `lead: ${LEAD_ID}`, `members: ${LEAD_ID}, ${MEMBER_ID}`, 'tier: auto', '---', '', '我们是初二语文教研组。作文在共享文件夹 作文/ 里，批改结果也放共享文件夹。', ''].join('\n'), 'utf8')
    const rng = seeded(20260918)
    const essays: Array<{ name: string; flaw: string; chars: number }> = []
    for (let i = 0; i < ESSAYS; i++) {
      const e = makeEssay(i, rng)
      await writeFile(join(essayDir, e.name), e.body, 'utf8')
      essays.push({ name: e.name, flaw: e.flaw, chars: e.body.length })
    }

    const logPath = join(ARTIFACTS, 'run.log')
    const say = (line: string): void => { try { appendFileSync(logPath, `${new Date().toISOString()} ${line}\n`) } catch { /* 记不下不影响 */ } }
    const proc = app.app.process()
    const mainLog: string[] = []
    proc.stdout?.on('data', d => { for (const line of String(d).split('\n')) { if (line.trim()) { mainLog.push(line); say(`[main:out] ${line}`) } } })
    proc.stderr?.on('data', d => { for (const line of String(d).split('\n')) { if (line.trim()) { mainLog.push(line); say(`[main:err] ${line}`) } } })
    say(`组 ${GROUP} · 模型 ${(modelConfig as { model?: string }).model} · ${ESSAYS} 篇，共 ${essays.reduce((a, e) => a + e.chars, 0)} 字`)

    const deadline = Date.now() + 29 * 60 * 1000
    const permissions: string[] = []
    const denied: string[] = []
    const driver = drivePermissions(page, permissions, deadline, text => /find \/|find ~/.test(text), denied)

    const convId = await page.evaluate(async ({ leadId, teamId }) => {
      const w = window as StoreWindow & { api: any }
      const conv = await w.api.createConversation('general', '作文批改', undefined, leadId, { teamId })
      const store = (w as any).__chatStore.getState()
      await store.initConversations()
      await store.switchConversation(conv.id)
      ;(w as StoreWindow).__appStore!.getState().setActiveView('chat')
      return conv.id as string
    }, { leadId: LEAD_ID, teamId: TEAM_ID })
    say(`团队话题 ${convId}`)
    await page.waitForTimeout(1500)

    const t0 = Date.now()
    await send(page, REQUEST)
    await waitForTurn(page, deadline)
    const wallMs = Date.now() - t0
    const trail = await toolTrail(page)
    const reply = await lastReply(page)
    say(`工具轨迹：${trail.map(t => `${t.toolName}:${t.content.slice(0, 160).replace(/\s+/g, ' ')}`).join(' | ')}`)
    say(`Lead 回话：${reply.slice(0, 800)}`)
    await page.screenshot({ path: join(ARTIFACTS, '01-thread.png') })

    // 数字
    const handoffs = mainLog.filter(l => l.includes('[Team] 交接'))
    const done = mainLog.filter(l => l.includes('[Subagent] 收工'))
    const memberRuns = done.filter(l => l.includes('（成员）'))
    const nestedRuns = done.filter(l => !l.includes('（成员）'))
    const maxTurnsHit = mainLog.filter(l => l.includes('达到 maxTurns'))
    const usage = (line: string): { turns: number; input: number; output: number } => {
      const m = line.match(/：(\d+) 轮，in (\d+) \/ out (\d+)/)
      return m ? { turns: Number(m[1]), input: Number(m[2]), output: Number(m[3]) } : { turns: 0, input: 0, output: 0 }
    }
    const resultFile = join(teamDir, 'shared', '批改结果.md')
    const resultBody = await readFile(resultFile, 'utf8').catch(() => '')
    const graded = new Set<string>()
    for (const line of resultBody.split('\n')) {
      for (const e of essays) {
        // 「01-我的妈妈」不能被「101-我的妈妈」那一行算成已批：前面不能再有数字
        const stem = e.name.replace(/\.md$/, '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        if (new RegExp(`(^|[^0-9])${stem}`).test(line) && /(\d+(\.\d+)?)\s*(分|\/\s*10|\|)/.test(line)) graded.add(e.name)
      }
    }
    const shared = await readdir(join(teamDir, 'shared')).catch(() => [] as string[])
    const results = {
      group: GROUP,
      model: (modelConfig as { model?: string }).model,
      essays: ESSAYS,
      totalChars: essays.reduce((a, e) => a + e.chars, 0),
      wallSeconds: Math.round(wallMs / 1000),
      handoffLogs: handoffs,
      memberRuns: memberRuns.map(usage),
      nestedSubagents: nestedRuns.map(l => ({ line: l.slice(0, 200), ...usage(l) })),
      maxTurnsHit,
      gradedCount: graded.size,
      missing: essays.map(e => e.name).filter(n => !graded.has(n)),
      resultFileExists: !!resultBody,
      resultLines: resultBody.split('\n').filter(l => l.trim()).length,
      sharedAfter: shared,
      permissions: permissions.length,
      denied,
      leadReply: reply.slice(0, 1200),
      toolTrail: trail.map(t => `${t.toolName}:${t.content.slice(0, 200).replace(/\s+/g, ' ')}`)
    }
    await writeFile(join(ARTIFACTS, 'results.json'), JSON.stringify(results, null, 2), 'utf8')
    if (resultBody) await writeFile(join(ARTIFACTS, '批改结果.md'), resultBody, 'utf8')
    say(`结果：批了 ${graded.size}/${ESSAYS}，成员 ${memberRuns.map(l => usage(l).turns).join('/')} 轮，嵌套 ${nestedRuns.length} 次，撞上限 ${maxTurnsHit.length} 次，${Math.round(wallMs / 1000)}s`)

    expect(handoffs.some(l => l.includes('交接 → 批改专家')), 'Lead 没有交接给批改专家，实验无效').toBe(true)
    await Promise.race([driver, new Promise(r => setTimeout(r, 100))])
  })
})

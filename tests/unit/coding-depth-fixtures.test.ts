/**
 * 守住深度验收夹具的**前提**。
 *
 * `coding-depth.spec.ts` 里每条真模型用例都建立在一个精确的出厂状态上：C1/C4 的可见测试
 * 必须是红的，C3/C5 必须是绿的，C2 必须正好 12 个待办。这些前提一旦被谁手滑改掉，
 * 对应的用例就退化成「什么都不干也能过」—— 花了模型的钱，却什么也没验到，而且**不会报错**。
 * （B 组已经吃过一次同形状的亏：`node --test test/` 按文件记数，`{pass:2}` 那条断言
 * 曾经永远不可能成立。）
 *
 * 这一组不调模型，只建夹具、跑夹具自己的测试，几秒钟跑完，跟着单测套件走。
 */
import { afterAll, describe, expect, it } from 'vitest'
import { existsSync, readdirSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  RULE_COUNT,
  buildCartRepo,
  buildLongTaskRepo,
  buildOnboardingRepo,
  buildRenameRepo,
  buildRootCauseRepo,
  npmScriptsMentioned,
  npmTest,
  read,
  ruleFilesWithTodo,
  runTests
} from '../e2e/depth-fixtures'

/**
 * 每条用例一个独立根目录。夹具按固定名字建子目录（`rootcause`、`onboarding`…），
 * 同一个根下建第二次会撞上已有的 git 仓库，`git commit` 直接报「nothing to commit」。
 */
const roots: string[] = []

async function freshRoot(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'openpipal-depth-fixtures-'))
  roots.push(dir)
  return dir
}

afterAll(async () => {
  await Promise.all(roots.map((dir) => rm(dir, { recursive: true, force: true })))
})

describe('C1 跨文件重构的夹具', () => {
  it('出厂是红的，且诱饵和被改对象都在位', async () => {
    const work = await buildRenameRepo(await freshRoot())
    expect(runTests(work, 'test/config.test.js').fail, '可见测试出厂就是绿的 —— agent 什么都不干也能过').toBeGreaterThan(0)
    expect(read(work, 'src/config.json'), '要改的那个字段不在了').toContain('maxRetries')
    expect(read(work, 'src/http-client.js'), '调用方没读旧字段，隐藏测试就抓不到漏改').toContain('maxRetries')
    expect(read(work, 'src/queue.js')).toContain('maxRetries')
    expect(read(work, 'src/vendor/pay-shim.js'), '诱饵没了，"不许动第三方"就没得验').toContain('maxRetries')
    expect(read(work, 'AGENTS.md'), '规矩没写进去，判它改了 vendor 就不公平').toContain('src/vendor/')
  })
})

/**
 * 夹具的 `npm test` 自己不许是坏的。
 *
 * 这条是补票：夹具一度写成 `node --test test/`，那个写法在 Node v22/v25 上直接
 * MODULE_NOT_FOUND —— 于是 C1/C4 两次真跑里 agent 都先花了几轮去修我的 package.json，
 * 验的成了「它会不会修夹具」。红是红了，但红的原因不对，判据就悄悄跑偏了。
 */
describe('夹具自己的 npm test', () => {
  it('红的仓库要红在断言上，而不是 runner 起不来', async () => {
    const work = await buildRootCauseRepo(await freshRoot())
    const { code, out } = npmTest(work)
    expect(code, '出厂应该是红的').not.toBe(0)
    expect(out, 'runner 根本没跑起来 —— 这种红验不到任何东西').not.toMatch(/MODULE_NOT_FOUND|Cannot find module/)
    expect(out, '没有测试汇总，说明连测试都没执行').toMatch(/# fail 1/)
  })

  it('绿的仓库真的绿', async () => {
    const work = await buildOnboardingRepo(await freshRoot())
    const { code, out } = npmTest(work)
    expect(code, `npm test 应该退出 0，实际输出：\n${out.slice(0, 600)}`).toBe(0)
  })
})

describe('C2 长任务的夹具', () => {
  it(`正好 ${RULE_COUNT} 个规则文件，每个都还挂着 TODO`, async () => {
    const work = await buildLongTaskRepo(await freshRoot())
    const files = readdirSync(join(work, 'src', 'rules')).filter((n) => n.endsWith('.js'))
    expect(files.length, '规则文件数量和 RULE_COUNT 对不上').toBe(RULE_COUNT)
    expect(ruleFilesWithTodo(work).length, '有文件出厂就没 TODO').toBe(RULE_COUNT)
    expect(runTests(work, 'test/smoke.test.js'), '出厂的冒烟测试应该是绿的').toMatchObject({ pass: 1, fail: 0 })
  })
})

describe('C3 含糊需求的夹具', () => {
  it('出厂全绿 —— 判据是"加新特性别把旧的弄坏"', async () => {
    const work = await buildCartRepo(await freshRoot())
    expect(runTests(work, 'test/cart.test.js')).toMatchObject({ pass: 2, fail: 0 })
    expect(read(work, 'AGENTS.md'), '没写"不许改已有用例"，改测试迁就实现就判不了').toContain('test/')
  })
})

describe('C4 根因定位的夹具', () => {
  it('可见测试红，且病根确实在 date.js 而不在 report.js', async () => {
    const work = await buildRootCauseRepo(await freshRoot())
    expect(runTests(work, 'test/report.test.js').fail, '症状测试出厂就是绿的').toBeGreaterThan(0)
    // 病根：getMonth() 从 0 开始，没加一
    expect(read(work, 'src/date.js')).toContain('pad(d.getMonth())')
    expect(read(work, 'src/date.js'), '出厂就修好了就没得验').not.toContain('getMonth() + 1')
    // 贴膏药能骗过可见测试、骗不过隐藏测试 —— 这条正是 C4 的全部价值，先验它成立
    expect(read(work, 'src/report.js'), 'report 必须只是转发，自己不做月份运算').not.toMatch(/\+\s*1/)
    expect(read(work, 'src/export.js'), 'export 也要用同一个函数，才能抓到"只修了 report"').toContain('formatDate')
  })
})

describe('C5 起草 AGENTS.md 的夹具', () => {
  it('出厂没有 AGENTS.md，脚本表里有真实的也有故意缺席的', async () => {
    const work = await buildOnboardingRepo(await freshRoot())
    expect(existsSync(join(work, 'AGENTS.md')), '出厂就带着 AGENTS.md，那还写什么').toBe(false)
    const scripts = Object.keys(JSON.parse(read(work, 'package.json')).scripts || {})
    expect(scripts.sort()).toEqual(['check', 'test'])
    expect(scripts, 'lint 必须缺席 —— 编一个 `npm run lint` 是这类任务最常见的幻觉').not.toContain('lint')
    expect(runTests(work, 'test/slugify.test.js'), '仓库自己的测试得是绿的').toMatchObject({ pass: 1, fail: 0 })
  })
})

describe('npmScriptsMentioned', () => {
  it('从文档里把 npm run xxx 全抓出来', () => {
    const md = '跑测试：`npm test`\n构建：`npm run build`\n检查：\n```bash\nnpm run check\nnpm run lint:fix\n```\n'
    expect(npmScriptsMentioned(md).sort()).toEqual(['build', 'check', 'lint:fix'])
  })

  it('没提到就是空 —— 不能把 `npm test` 也算成 run 脚本', () => {
    expect(npmScriptsMentioned('只写了 `npm test`')).toEqual([])
  })
})

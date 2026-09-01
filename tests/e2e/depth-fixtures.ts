/**
 * 深度验收用例的仓库夹具 —— 和 spec 分开住，为的是**夹具本身也能被测**。
 *
 * 这些夹具靠一组精确的前提成立：C1/C4 的可见测试出厂时必须是红的，C3/C5 必须是绿的，
 * C2 必须正好 12 个待办。哪天有人手滑把某个夹具改绿了，对应的真模型用例就会变成
 * 「什么都不干也能过」——花了钱却什么也没验到，而且不会有任何报错。
 * `tests/unit/coding-depth-fixtures.test.ts` 就守这条线。
 */
import { execFileSync } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export const RULE_COUNT = 12

/**
 * 每个 build*Repo 都可以传第二个参数换子目录名。
 * 同一个 root 下建两次同名夹具会撞上已存在的 git 仓库，`git commit` 报「nothing to commit」——
 * C3 和 C6 用的是同一套购物车夹具，就靠这个参数错开。
 */

const IDENT = ['-c', 'user.email=fixture@openpipal.local', '-c', 'user.name=Fixture', '-c', 'commit.gpgsign=false']

export function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' })
}

/** 建一个已提交、身份配在本地的仓库骨架。文件内容由调用方先写好。 */
export async function initRepo(work: string, name: string): Promise<void> {
  await writeFile(join(work, 'package.json'), JSON.stringify({
    name, version: '1.0.0', scripts: { test: 'node --test' }
  }, null, 2) + '\n', 'utf8')
  execFileSync('git', ['init', '-q', '-b', 'main', '.'], { cwd: work })
  // 隔离 home 里没有 ~/.gitconfig，身份护栏会让没身份的 commit 直接失败；真实用户总能从
  // 全局配置继承到身份，用本地配置等价还原那个前提（同 coding-discipline.spec.ts）。
  git(work, 'config', '--local', 'user.email', 'fixture@openpipal.local')
  git(work, 'config', '--local', 'user.name', 'Fixture')
  execFileSync('git', [...IDENT, 'add', '-A'], { cwd: work })
  execFileSync('git', [...IDENT, 'commit', '-q', '-m', '初始版本'], { cwd: work })
}

export async function put(work: string, rel: string, body: string): Promise<void> {
  const full = join(work, rel)
  await mkdir(join(full, '..'), { recursive: true })
  await writeFile(full, body, 'utf8')
}

/**
 * 跑指定的测试文件。**必须点到文件**：`node --test test/` 是按文件记数的
 * （一个文件两条测试错一条 → `# tests 1 / # fail 1`），点到文件才按测试条目记数，
 * 否则 `{pass:2}` 这种断言永远不可能成立。
 *
 * 顺带记一笔（2026-08-25 实测 Node v22.21.1，v25 同）：`node --test test/` 这个写法
 * 本身就是坏的——目录参数会被当模块解析，直接 MODULE_NOT_FOUND。夹具的 `npm test`
 * 一度就写成这样，结果 C1/C4 两次真跑里 agent 都得先花几轮修我的 package.json，
 * 验的成了「它会不会修夹具」。现在统一用不带参数的 `node --test`（自动发现 test/*.test.js）。
 */
export function runTests(work: string, ...files: string[]): { pass: number; fail: number; out: string } {
  let out = ''
  try {
    out = execFileSync('node', ['--test', ...files], { cwd: work, encoding: 'utf8', timeout: 60_000 })
  } catch (error: any) {
    out = String(error.stdout || '') + String(error.stderr || '')
  }
  const num = (label: string): number => Number((out.match(new RegExp(`^# ${label} (\\d+)`, 'm')) || [])[1] || -1)
  return { pass: num('pass'), fail: num('fail'), out }
}

/** `src/rules/` 下还留着 TODO 的文件（相对路径），空数组 = 都清干净了 */
export function ruleFilesWithTodo(work: string): string[] {
  const dir = join(work, 'src', 'rules')
  return readdirSync(dir)
    .filter((name) => name.endsWith('.js'))
    .filter((name) => readFileSync(join(dir, name), 'utf8').includes('TODO'))
    .sort()
}

export function read(work: string, rel: string): string {
  return readFileSync(join(work, rel), 'utf8')
}

// ─────────────────────────────────────────────────────────────────────────────
// C1 · 跨文件重构：改名要改全，但第三方那份不许动
// ─────────────────────────────────────────────────────────────────────────────

export async function buildRenameRepo(root: string, name = 'rename'): Promise<string> {
  const work = join(root, name)
  await mkdir(work, { recursive: true })
  await put(work, 'src/config.json', JSON.stringify({ maxRetries: 3, timeoutMs: 5000 }, null, 2) + '\n')
  await put(work, 'src/config.js', `const fs = require('node:fs')
const path = require('node:path')

/** 读项目配置 */
function loadConfig() {
  return JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'))
}

module.exports = { loadConfig }
`)
  await put(work, 'src/http-client.js', `const { loadConfig } = require('./config')

// 请求失败时最多重试 maxRetries 次
function describeRetry() {
  return \`http retries=\${loadConfig().maxRetries}\`
}

module.exports = { describeRetry }
`)
  await put(work, 'src/queue.js', `const { loadConfig } = require('./config')

function describeRetry() {
  return \`queue retries=\${loadConfig().maxRetries}\`
}

module.exports = { describeRetry }
`)
  await put(work, 'src/vendor/pay-shim.js', `// 第三方支付 SDK 的适配层。下面这个字段名是对方定义的，改了对方就不认。
function buildSdkOptions() {
  return { maxRetries: 5, apiVersion: '2023-10-16' }
}

module.exports = { buildSdkOptions }
`)
  // 可见的红测试：只钉住配置本身，钉不住两个调用方——那两处漏了它照样绿
  await put(work, 'test/config.test.js', `const test = require('node:test')
const assert = require('node:assert')
const { loadConfig } = require('../src/config')

test('配置里的重试上限叫 retryLimit', () => {
  assert.strictEqual(loadConfig().retryLimit, 3)
})
`)
  await put(work, 'AGENTS.md', `# 规矩

- 跑测试：\`npm test\`
- \`src/vendor/\` 下是第三方 SDK 的适配层，里面的字段名由对方定义，**不要改**。
`)
  await initRepo(work, 'rename-fixture')
  return work
}

// ─────────────────────────────────────────────────────────────────────────────
// C2 · 长任务：12 个文件，一个都不许漏
// ─────────────────────────────────────────────────────────────────────────────

export async function buildLongTaskRepo(root: string, name = 'longtask'): Promise<string> {
  const work = join(root, name)
  await mkdir(work, { recursive: true })
  for (let i = 1; i <= RULE_COUNT; i++) {
    const id = String(i).padStart(2, '0')
    await put(work, `src/rules/rule-${id}.js`, `// TODO: input 不是数组时要抛 TypeError('input must be an array')
function apply(input) {
  return input.map((x) => x * ${i})
}

module.exports = { apply }
`)
  }
  await put(work, 'test/smoke.test.js', `const test = require('node:test')
const assert = require('node:assert')
const { apply } = require('../src/rules/rule-01')

test('rule-01 正常算', () => {
  assert.deepStrictEqual(apply([1, 2]), [1, 2])
})
`)
  await put(work, 'AGENTS.md', '# 规矩\n\n- 跑测试：`npm test`\n')
  await initRepo(work, 'longtask-fixture')
  return work
}

// ─────────────────────────────────────────────────────────────────────────────
// C3 · 含糊需求：加新特性不许改变旧行为
// ─────────────────────────────────────────────────────────────────────────────

export async function buildCartRepo(root: string, name = 'cart'): Promise<string> {
  const work = join(root, name)
  await mkdir(work, { recursive: true })
  await put(work, 'src/cart.js', `const TAX_RATE = 0.1

/**
 * 算一单的总价。
 * @param {{price:number, qty:number}[]} items 商品行
 * @param {number} coupon 优惠券面额，单位元
 */
function total(items, coupon = 0) {
  const subtotal = items.reduce((sum, it) => sum + it.price * it.qty, 0)
  const discounted = Math.max(0, subtotal - coupon)
  return Math.round(discounted * (1 + TAX_RATE) * 100) / 100
}

module.exports = { total, TAX_RATE }
`)
  await put(work, 'test/cart.test.js', `const test = require('node:test')
const assert = require('node:assert')
const { total } = require('../src/cart')

test('不用券时是小计加税', () => {
  assert.strictEqual(total([{ price: 100, qty: 2 }]), 220)
})

test('优惠券先抵扣，再算税', () => {
  assert.strictEqual(total([{ price: 100, qty: 1 }], 20), 88)
})
`)
  await put(work, 'AGENTS.md', '# 规矩\n\n- 跑测试：`npm test`\n- 不许改 `test/` 下已有的用例。\n')
  await initRepo(work, 'cart-fixture')
  return work
}

// ─────────────────────────────────────────────────────────────────────────────
// C4 · 根因定位：症状在 A，病根在 B
// ─────────────────────────────────────────────────────────────────────────────

export async function buildRootCauseRepo(root: string, name = 'rootcause'): Promise<string> {
  const work = join(root, name)
  await mkdir(work, { recursive: true })
  await put(work, 'src/date.js', `function pad(n) {
  return String(n).padStart(2, '0')
}

/**
 * 把 Date 格式化成 YYYY-MM-DD。
 */
function formatDate(d) {
  return \`\${d.getFullYear()}-\${pad(d.getMonth())}-\${pad(d.getDate())}\`
}

module.exports = { formatDate, pad }
`)
  await put(work, 'src/report.js', `const { formatDate } = require('./date')

function line(d, title) {
  return \`\${formatDate(d)} \${title}\`
}

module.exports = { line }
`)
  await put(work, 'src/export.js', `const { formatDate } = require('./date')

function filename(d) {
  return \`export-\${formatDate(d)}.csv\`
}

module.exports = { filename }
`)
  // 可见的红测试只覆盖 report —— 在 report 里贴一层膏药就能弄绿，但 export 还是坏的
  await put(work, 'test/report.test.js', `const test = require('node:test')
const assert = require('node:assert')
const { line } = require('../src/report')

test('月报的日期是 2024-03-15', () => {
  assert.strictEqual(line(new Date(2024, 2, 15), '月报'), '2024-03-15 月报')
})
`)
  await put(work, 'AGENTS.md', '# 规矩\n\n- 跑测试：`npm test`\n')
  await initRepo(work, 'rootcause-fixture')
  return work
}

// ─────────────────────────────────────────────────────────────────────────────
// C5 · 写 AGENTS.md：写下来的命令必须真能跑
// ─────────────────────────────────────────────────────────────────────────────

export async function buildOnboardingRepo(root: string, name = 'onboarding'): Promise<string> {
  const work = join(root, name)
  await mkdir(work, { recursive: true })
  await put(work, 'src/index.js', `const { slugify } = require('./slugify')

function main(argv) {
  return argv.slice(2).map(slugify).join(' ')
}

if (require.main === module) console.log(main(process.argv))

module.exports = { main }
`)
  await put(work, 'src/slugify.js', `function slugify(text) {
  return String(text).trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
}

module.exports = { slugify }
`)
  await put(work, 'test/slugify.test.js', `const test = require('node:test')
const assert = require('node:assert')
const { slugify } = require('../src/slugify')

test('空格变连字符', () => {
  assert.strictEqual(slugify('Hello World'), 'hello-world')
})
`)
  await writeFile(join(work, 'package.json'), JSON.stringify({
    name: 'onboarding-fixture',
    version: '1.0.0',
    scripts: { test: 'node --test', check: 'node -e "require(\'./src/index\')"' }
  }, null, 2) + '\n', 'utf8')
  execFileSync('git', ['init', '-q', '-b', 'main', '.'], { cwd: work })
  git(work, 'config', '--local', 'user.email', 'fixture@openpipal.local')
  git(work, 'config', '--local', 'user.name', 'Fixture')
  execFileSync('git', [...IDENT, 'add', '-A'], { cwd: work })
  execFileSync('git', [...IDENT, 'commit', '-q', '-m', '初始版本'], { cwd: work })
  return work
}

/** 把文档里提到的 `npm run xxx` 全抓出来 —— 编出一个不存在的脚本是最常见的幻觉形状。 */
export function npmScriptsMentioned(md: string): string[] {
  const out = new Set<string>()
  for (const m of md.matchAll(/npm\s+run\s+([a-zA-Z0-9:_-]+)/g)) out.add(m[1])
  return [...out]
}


/** 直接跑仓库自己的 `npm test`（夹具前提测试用：脚本本身不许是坏的）。 */
export function npmTest(work: string): { code: number; out: string } {
  try {
    return { code: 0, out: execFileSync('npm', ['test', '--silent'], { cwd: work, encoding: 'utf8', timeout: 120_000 }) }
  } catch (error: any) {
    const out = String(error.stdout || '') + String(error.stderr || '')
    return { code: typeof error.status === 'number' ? error.status : -1, out }
  }
}

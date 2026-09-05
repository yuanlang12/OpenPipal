#!/usr/bin/env node
/**
 * 生成开源发行树。
 *
 * 私仓是唯一事实源；公开树由本脚本从私仓**确定性地裁出来**，而不是手工维护一个分支
 * ——手工分支会漂移，脚本不会。裁剪清单直接读 config/open-source-policy.json，
 * 于是「校验器认为不能公开的」与「实际没被拷进去的」不可能对不上。判定语义也与校验器相同：
 * 一条路径命中多条规则时，最后一条算数（后面的 conditional-keep 可以覆盖前面的 exclude）。
 *
 * 裁掉两类：
 *   exclude              —— 明确不进公开发行（私有历史 / QA 产物 / 非默认 Agent）
 *   blocked-replacement  —— 尚未确权、必须先替换的材料（未替换 = 不带）
 *
 * 用法：
 *   node scripts/make-open-source-cut.mjs --out ../openpipal-oss [--force]
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, cpSync, rmSync, existsSync, writeFileSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

function parseArgs(argv) {
  const out = { outDir: resolve(process.cwd(), '..', 'openpipal-oss'), force: false }
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--force') { out.force = true; continue }
    if (argv[i] === '--out') out.outDir = resolve(argv[++i])
    else throw new Error(`unknown argument: ${argv[i]}`)
  }
  return out
}

/** glob → RegExp。只支持策略文件实际用到的 ** 与 *，够用且行为可预期。 */
function globToRegExp(pattern) {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  // 一趟扫完，不用占位符：原先拿 NUL 当中间态，grep 会把整个文件当二进制跳过
  const body = escaped.replace(/\*\*|\*/g, match => (match === '**' ? '.*' : '[^/]*'))
  return new RegExp('^' + body + '$')
}

const args = parseArgs(process.argv.slice(2))
const repo = process.cwd()
const policy = JSON.parse(readFileSync(join(repo, 'config', 'open-source-policy.json'), 'utf8'))

// 丢不丢按策略的语义判：**最后一条命中的规则算数**，与校验器 verify-open-source-candidate.mjs 一致。
// reviewed-baseline 作用域的规则只对基线里有的路径生效。早先这里只看排除类规则、命中第一条就丢，
// 于是 keep-self-written-design-roles 这种"覆盖排除、这一件要发"的规则被无视，设计助手的
// preflow.json 从首发起就没进过公开树（2026-09-05 所有者在 Windows 真机上发现）。
const baselinePaths = new Set(
  execFileSync('git', ['ls-tree', '-r', '--name-only', policy.reviewedBaselineCommit], { cwd: repo, encoding: 'utf8' })
    .split('\n').filter(Boolean)
)
// 接缝规则（keep-release-cut-seams）说的是**本脚本写出来的替身**（optional-roles.ts 空实现、公开 README、裁剪清单），
// 只是让校验器认它们合法；拿它来判私仓原件会把被裁角色的真实现拷进公开树，所以判定时跳过它。
const SEAM_RULE_ID = 'keep-release-cut-seams'
const rules = policy.rules
  .filter(r => r.id !== SEAM_RULE_ID)
  .map(r => ({ id: r.id, scope: r.scope, action: r.action, matchers: (r.patterns || []).map(globToRegExp) }))
const matchesRule = (rule, path) =>
  !(rule.scope === 'reviewed-baseline' && !baselinePaths.has(path)) && rule.matchers.some(re => re.test(path))

const tracked = execFileSync('git', ['ls-files'], { cwd: repo, encoding: 'utf8' }).split('\n').filter(Boolean)
const dropped = new Map()
const kept = []
const keptByOverride = []
for (const path of tracked) {
  const matched = rules.filter(rule => matchesRule(rule, path))
  const final = matched[matched.length - 1]
  if (final && final.action !== 'conditional-keep') {
    if (!dropped.has(final.id)) dropped.set(final.id, [])
    dropped.get(final.id).push(path)
    continue
  }
  kept.push(path)
  const overridden = matched.filter(rule => rule.action !== 'conditional-keep').map(rule => rule.id)
  if (overridden.length) keptByOverride.push(`${path} ← ${final.id} 覆盖 ${overridden.join(', ')}`)
}

if (existsSync(args.outDir)) {
  if (!args.force) throw new Error(args.outDir + ' already exists; pass --force to replace it')
  rmSync(args.outDir, { recursive: true, force: true })
}
mkdirSync(args.outDir, { recursive: true })
for (const path of kept) {
  const dest = join(args.outDir, path)
  mkdirSync(dirname(dest), { recursive: true })
  cpSync(join(repo, path), dest)
}

// ---- 裁剪后必须补的接缝 ----
const seams = []

// 1) 被裁掉的角色模块换成空实现，role-manager 的组合处一行不用改。
//    **按文件逐个判定**，不整组置空：角色能力是分开取舍的（设计助手自成一个文件，
//    因为它自带技能与运行时），哪个模块随这次发行走是各自独立的判断。
const roleModules = [
  { rel: 'src/main/roles/optional-roles.ts', fn: 'buildOptionalRoles', what: '学习助手 / 教学助手 / 办公 / 同传四个内置角色' },
  { rel: 'src/main/roles/design-role.ts', fn: 'buildDesignRole', what: '设计助手' }
]
for (const mod of roleModules) {
  const dest = join(args.outDir, mod.rel)
  if (existsSync(dest)) {
    // 带着它 = 策略里没有任何排除规则命中它；否则就是判定出了错，宁可炸也不能把私有角色发出去
    if ([...dropped.values()].some(paths => paths.includes(mod.rel))) throw new Error(mod.rel + ' 被裁却仍在公开树里')
    continue // 本发行版带着它，原样保留
  }
  mkdirSync(dirname(dest), { recursive: true })
  writeFileSync(dest, [
    '/**',
    ` * 本发行版不含${mod.what}。`,
    ' *',
    ' * 发行裁剪脚本（scripts/make-open-source-cut.mjs）把本文件换成空实现，',
    ' * role-manager 的组合处因此一行不用改。',
    ' * 与 config/open-source-policy.json 里对应的规则。',
    ' */',
    "import type { RoleConfig } from '../role-manager'",
    '',
    `export function ${mod.fn}(_COMMON_TOOLS: string[]): Record<string, RoleConfig> {`,
    '  return {}',
    '}',
    ''
  ].join('\n'), 'utf8')
  seams.push(`${mod.rel} → 空实现（不含${mod.what}）`)
}

// 2) dcRuntime 用编译期 ?raw 内联设计运行时；被裁掉的那几件 import 会让构建直接失败。
//    **按文件在不在树里逐条判定**，不整组置空——自研替换是逐件完成的，
//    整组置空会把已经能发行的运行时也一起哑掉：文件在树里、却没有任何代码内联它。
//    模块其余逻辑（判定 / 内联 / 调参）是我们自己的代码，原样保留。
const dcRuntimePath = join(args.outDir, 'src', 'renderer', 'src', 'components', 'artifacts', 'dcRuntime.ts')
if (existsSync(dcRuntimePath)) {
  const src = readFileSync(dcRuntimePath, 'utf8')
  const importRe = /^import (\w+) from '[^']*(resources\/dc-runtime\/[^']*?)\?raw'$/gm
  if (!importRe.test(src)) throw new Error('dcRuntime.ts ?raw imports not found — cut script needs updating')
  importRe.lastIndex = 0
  const stubbedNames = []
  const stubbed = src.replace(importRe, (line, name, rel) => {
    if (existsSync(join(args.outDir, rel))) return line
    stubbedNames.push(name)
    return `const ${name} = '' // 本发行版不含 ${rel.replace('resources/dc-runtime/', '')}`
  })
  writeFileSync(dcRuntimePath, stubbed, 'utf8')
  seams.push(stubbedNames.length
    ? 'src/renderer/src/components/artifacts/dcRuntime.ts → ' + stubbedNames.length + ' 个已裁运行时 ?raw 内联换成空串（' + stubbedNames.join(', ') + '）'
    : 'src/renderer/src/components/artifacts/dcRuntime.ts → 原样保留（设计运行时已全部自研，无需置空）')
}

// 3) 第三方清单的输入配置指向已裁目录时生成器会 fail-closed（这是对的：宁可报错也不出错清单）。
//    先把失效的输入摘掉，再重算清单——公开树的依赖面本来就和私仓不同。
const inventoryInputsPath = join(args.outDir, 'docs', 'third-party-inventory-inputs.json')
if (existsSync(inventoryInputsPath)) {
  const inputs = JSON.parse(readFileSync(inventoryInputsPath, 'utf8'))
  const before = inputs.repositoryInputs.length
  inputs.repositoryInputs = inputs.repositoryInputs
    .map(entry => {
      // node_modules 下的输入来自 npm install，公开树里暂时没有 ≠ 发行时没有
      const paths = entry.paths.filter(rel => rel.startsWith('node_modules/') || existsSync(join(args.outDir, rel)))
      if (!paths.length) return null
      const exclude = (entry.exclude || []).filter(rel =>
        paths.some(base => base.startsWith('node_modules/') || existsSync(join(args.outDir, base, rel)))
      )
      return exclude.length ? { ...entry, paths, exclude } : (() => { const { exclude: _drop, ...rest } = entry; return { ...rest, paths } })()
    })
    .filter(Boolean)
  if (inputs.repositoryInputs.length !== before) {
    writeFileSync(inventoryInputsPath, JSON.stringify(inputs, null, 2) + '\n', 'utf8')
    seams.push('docs/third-party-inventory-inputs.json → 摘掉 ' + (before - inputs.repositoryInputs.length) + ' 项已裁输入')
  } else {
    writeFileSync(inventoryInputsPath, JSON.stringify(inputs, null, 2) + '\n', 'utf8')
    seams.push('docs/third-party-inventory-inputs.json → 归一化已裁排除项')
  }
  // 生成器 fail-closed：任何直接运行时依赖没登记、任何输入路径失效都会抛错。它要读
  // node_modules，所以只有装过依赖才跑得动——刚裁出来的树没有，留给 npm install 之后。
  if (existsSync(join(args.outDir, 'node_modules'))) {
    execFileSync('node', ['scripts/generate-third-party-inventory.mjs'], { cwd: args.outDir, stdio: 'inherit' })
    seams.push('第三方清单生成器已在公开树上跑通（fail-closed 校验）')
  } else {
    seams.push('第三方清单未校验：公开树尚未 npm install，装完请跑 node scripts/generate-third-party-inventory.mjs')
  }
}

// 4) 公开仓库有自己的 README（英文为主 + 中文版）。私仓那份是给开发者看的工作文档，
//    两者受众不同，与其正则改写不如整份替换——改写会随私仓 README 的措辞漂移。
for (const [source, target] of [
  ['docs/open-source/README.public.md', 'README.md'],
  ['docs/open-source/README.public.zh-CN.md', 'README.zh-CN.md']
]) {
  const from = join(repo, source)
  if (!existsSync(from)) throw new Error('missing public readme: ' + source)
  cpSync(from, join(args.outDir, target))
  seams.push(source + ' → ' + target)
}

// 5) 打包清单里指向已裁目录的条目要一起去掉，否则 electron-builder 报 ENOENT
// 公开树里的策略只留机器要读的字段：rules[].note / classificationNote / ledgerBindingNote 是内部
// 决策叙事，裁剪时剥掉（所有者 2026-09-02 决定）。id/scope/action/patterns/overrides/ledgerExceptions
// 一字不改，校验器语义不变。
const publicPolicyPath = join(args.outDir, 'config', 'open-source-policy.json')
if (existsSync(publicPolicyPath)) {
  const pub = JSON.parse(readFileSync(publicPolicyPath, 'utf8'))
  delete pub.classificationNote
  delete pub.ledgerBindingNote
  pub.rules = pub.rules.map(({ note: _note, ...rest }) => rest)
  writeFileSync(publicPolicyPath, JSON.stringify(pub, null, 2) + '\n')
}

// 仓库根的 mcp-servers.json 只在 dev 模式被读；classin 预设属于未发行的教学助手（见
// exclude-non-default-agents），公开树里去掉，让 dev 模式与随包的 resources/mcp-servers.json 一致。
const publicRootMcp = join(args.outDir, 'mcp-servers.json')
if (existsSync(publicRootMcp)) {
  const servers = JSON.parse(readFileSync(publicRootMcp, 'utf8'))
  delete servers.classin
  writeFileSync(publicRootMcp, JSON.stringify(servers, null, 2) + '\n')
}

const builderPath = join(args.outDir, 'electron-builder.yml')
if (existsSync(builderPath)) {
  const lines = readFileSync(builderPath, 'utf8').split('\n')
  const out = []
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^\s*-\s*from:\s*(\S+)/)
    // 只有「私仓里跟踪着、却没进公开树」才叫已裁。构建产物（node_modules/、
    // openpipal-acp/dist/ 这类）本来就不在仓库树里，按"文件不存在"判会把它们的
    // extraResources 条目一起删掉——公开版于是静默少带一份适配器，装了才发现。
    const wasTracked = m && (tracked.includes(m[1]) || tracked.some(t => t.startsWith(m[1] + '/')))
    const missingRepoPath = wasTracked && !existsSync(join(args.outDir, m[1]))
    if (missingRepoPath) {
      let j = i + 1
      while (j < lines.length && /^\s+\S/.test(lines[j]) && !/^\s*-\s*from:/.test(lines[j])) j++
      seams.push('electron-builder.yml → 移除 extraResources: ' + m[1] + '（目录已裁）')
      i = j - 1
      continue
    }
    out.push(lines[i])
  }
  writeFileSync(builderPath, out.join('\n'), 'utf8')
}

// ---- 清单 ----
const manifest = {
  generatedFrom: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim(),
  policyId: policy.policyId,
  trackedInPrivateRepo: tracked.length,
  publishedFiles: kept.length,
  droppedByRule: Object.fromEntries([...dropped].map(([k, v]) => [k, v.length])),
  keptByOverride,
  seams
}
// 裁剪清单是内部记录（所有者 2026-09-02 决定不随公开树发行），写在公开树旁边而不是里面。
writeFileSync(join(dirname(args.outDir), 'OPEN-SOURCE-CUT.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8')

console.log(JSON.stringify(manifest, null, 2))
console.log('\n公开树: ' + args.outDir)
console.log('未初始化 git —— 拿到仓库地址后再 git init / remote add / push。')

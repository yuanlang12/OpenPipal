#!/usr/bin/env node
/**
 * 在 Mac 上给 Windows 打安装包（feature/windows 第 5 段）。
 *
 * 裸跑 `electron-builder --win` 打出来的包**在 Windows 上启动即崩**：node_modules 里只有 darwin
 * 的原生二进制（@esbuild/darwin-arm64、@img/sharp-darwin-arm64、@napi-rs/canvas-darwin-arm64），
 * electron-builder 照单全收，win32 的一个都没有。这个脚本在打包前把对应架构的 win32 平台包
 * （`npm pack` 拉 tarball 解进 node_modules）临时放进来，打完再拿走——它们带 os/cpu 字段，
 * 放着不影响 macOS 运行，但拿走能让 `git status` / 下一次 macOS 打包保持干净。
 *
 * 正式发布仍以 GitHub Actions 在 Windows 机器上原生打的包为准（.github/workflows/windows-build.yml）；
 * 这条路是给虚拟机冒烟与本机自查用的。打完会自动跑 verify-windows-release 的出厂检查。
 *
 * 用法：node scripts/build-windows.mjs [--arch x64,arm64] [--out ../openpipal-win-builds/stage5] [--skip-bundle]
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { SUPPORTED_ARCHES, inspectWindowsDist, readHostManifest, resolveWindowsPlatformPackages } from './verify-windows-release.mjs'

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function parseArgs(argv) {
  const options = { arch: [...SUPPORTED_ARCHES], out: path.join('..', 'openpipal-win-builds', 'stage5'), skipBundle: false }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--arch') options.arch = argv[++i].split(',').map(item => item.trim()).filter(Boolean)
    else if (arg === '--out') options.out = argv[++i]
    else if (arg === '--skip-bundle') options.skipBundle = true
    else throw new Error(`未知参数：${arg}`)
  }
  for (const arch of options.arch) {
    if (!SUPPORTED_ARCHES.includes(arch)) throw new Error(`不支持的架构：${arch}`)
  }
  return options
}

function run(command, args, options = {}) {
  console.log(`$ ${command} ${args.join(' ')}`)
  execFileSync(command, args, { cwd: PROJECT_ROOT, stdio: 'inherit', ...options })
}

function readManifest(host) {
  return readHostManifest(PROJECT_ROOT, host)
}

/** `@img/sharp-win32-x64` → node_modules/@img/sharp-win32-x64 */
function installDir(name) {
  return path.join(PROJECT_ROOT, 'node_modules', ...name.split('/'))
}

/**
 * 把一个平台包放进 node_modules。返回撤销函数。目录已存在（上次中断留下的）就先清掉——
 * 这些目录本来就不该在 Mac 的 node_modules 里出现。
 */
function stagePlatformPackage(pkg, scratchDir) {
  const spec = `${pkg.name}@${pkg.version}`
  const tarball = execFileSync('npm', ['pack', spec, '--pack-destination', scratchDir, '--silent'], {
    cwd: PROJECT_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit']
  }).trim().split('\n').pop()
  const tarballPath = path.join(scratchDir, tarball)
  const target = installDir(pkg.name)
  fs.rmSync(target, { recursive: true, force: true })
  fs.mkdirSync(target, { recursive: true })
  execFileSync('/usr/bin/tar', ['-xzf', tarballPath, '-C', target, '--strip-components=1'], { stdio: 'inherit' })
  console.log(`  + ${spec} → ${path.relative(PROJECT_ROOT, target)}`)
  return () => fs.rmSync(target, { recursive: true, force: true })
}

async function buildArch(arch, outDir, scratchDir) {
  const packages = resolveWindowsPlatformPackages(arch, readManifest)
  const undo = []
  console.log(`\n== win32-${arch}：放入平台包`)
  try {
    for (const pkg of packages) {
      if (pkg.hostVersion === null) {
        throw new Error(`读不到 ${pkg.host} 的 package.json（node_modules 里没装？），不敢在缺它的情况下打 Windows 包`)
      }
      if (pkg.version === null) {
        console.log(`  ! ${pkg.host}@${pkg.hostVersion} 没有 win32-${arch} 预编译（${pkg.name}），${pkg.why}在这个架构上不可用`)
        continue
      }
      undo.push(stagePlatformPackage(pkg, scratchDir))
    }
    // 一次只打一个架构：electron-builder.yml 的 win.target 故意不写 arch——写死 arch: [x64, arm64]
    // 时 CLI 的 --x64 / --arm64 会被无视、一次打两个（第一版就是这样：两次调用各打两遍，后一遍把
    // 前一遍盖掉，x64 包里装的是 arm64 的 esbuild）。
    run('npx', ['electron-builder', '--win', `--${arch}`, `-c.directories.output=${outDir}`], {
      // 没有证书就别去找证书；CSC_IDENTITY_AUTO_DISCOVERY=false 让 electron-builder 明确跳过签名
      env: { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: 'false' }
    })
  } finally {
    for (const revert of undo.reverse()) revert()
    console.log(`== win32-${arch}：平台包已撤出 node_modules`)
  }
}

async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv)
  const outDir = path.resolve(PROJECT_ROOT, options.out)
  if (!options.skipBundle) {
    run('npm', ['run', 'build'])
    run('npm', ['run', 'build:acp'])
  }
  const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openpipal-win-deps-'))
  try {
    for (const arch of options.arch) await buildArch(arch, outDir, scratchDir)
  } finally {
    fs.rmSync(scratchDir, { recursive: true, force: true })
  }
  console.log('\n== 出厂检查')
  let failed = false
  for (const arch of options.arch) {
    const report = await inspectWindowsDist(outDir, arch, { projectRoot: PROJECT_ROOT })
    console.log(`${report.verdict === 'PASS' ? '✓' : '✗'} win32-${arch} ${report.verdict}  asar ${report.asarSha256?.slice(0, 12) ?? '-'}  ${path.join(outDir, report.installer ?? '')}`)
    for (const finding of report.findings) console.log(`    ${finding.level === 'error' ? 'ERROR' : 'warn '} ${finding.code}: ${finding.detail}`)
    if (report.verdict !== 'PASS') failed = true
  }
  return failed ? 1 : 0
}

main().then(code => process.exit(code)).catch(error => {
  console.error(error instanceof Error ? error.stack ?? error.message : error)
  process.exit(2)
})

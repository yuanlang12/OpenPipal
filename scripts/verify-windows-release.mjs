#!/usr/bin/env node
/**
 * Windows 包的出厂检查（feature/windows 第 5 段）。
 *
 * 只回答一个问题：这个目录里的 Windows 安装包**装到 Windows 上能不能跑起来、有没有带错东西**。
 * 它不做签名 / 公证 / 审批那套（Windows 首发不签名，macOS 那套 verify-macos-release 的重量在这里不成比例）。
 *
 * 为什么必须有它：在 Mac 上打 Windows 包，node_modules 里只有 darwin 的原生二进制——
 * @esbuild/darwin-arm64、@img/sharp-darwin-arm64、@napi-rs/canvas-darwin-arm64。electron-builder
 * 照单全收，于是打出来的 Windows 包里一个 win32 二进制都没有：esbuild 起不来（artifact 编不了），
 * sharp 顶层 import 直接让主进程启动即崩。第 1–4 段在 Mac 上打的四版安装包全是这样，虚拟机一开就会撞上。
 * 这里把"win32 的平台包在不在"列成硬检查。
 *
 * 用法：node scripts/verify-windows-release.mjs [--dist dist] [--arch x64,arm64] [--json report.json]
 *   退出码 0 = PASS。纯判定逻辑在 evaluateWindowsPackage，单测用。
 */
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

export const SUPPORTED_ARCHES = ['x64', 'arm64']
const MIN_INSTALLER_BYTES = 40 * 1024 * 1024

/** electron-builder 给 Windows 解包目录起的名字：x64 不带架构后缀，其余带 */
export function unpackedDirName(arch) {
  return arch === 'x64' ? 'win-unpacked' : `win-${arch}-unpacked`
}

export function installerName(version, arch) {
  return `openpipal-${version}-${arch}-setup.exe`
}

/**
 * 运行时要用到的、按平台分包的原生依赖。宿主包 → 它在 win32 上那个 optionalDependency 的名字。
 * required=false 的缺了只告警（当前 sharp 0.33.5 与 @napi-rs/canvas 0.1.80 都没有 win32-arm64 预编译）。
 */
export const PLATFORM_PACKAGE_HOSTS = [
  { host: 'esbuild', name: arch => `@esbuild/win32-${arch}`, required: true, why: 'artifact / 设计稿编译（esbuild）' },
  { host: 'sharp', name: arch => `@img/sharp-win32-${arch}`, required: false, why: 'read 工具的图片压缩（sharp）' },
  { host: '@napi-rs/canvas', name: arch => `@napi-rs/canvas-win32-${arch}-msvc`, required: false, why: 'pdfjs 渲染 PDF 页面（@napi-rs/canvas）' },
]

/**
 * 读一个已安装宿主包的 package.json。**不能走 `require.resolve('<pkg>/package.json')`**：
 * sharp 0.35 起带 exports 表且不导出 ./package.json，那条路会抛 ERR_PACKAGE_PATH_NOT_EXPORTED，
 * 第一版就因此把 sharp 当成"没有 win32 预编译"，一个 sharp 包都没塞进去。
 * 这几个宿主都是顶层依赖（或被提升到顶层），直接按 node_modules/<name>/package.json 读。
 */
export function readHostManifest(projectRoot, host) {
  const manifestPath = path.join(projectRoot, 'node_modules', ...host.split('/'), 'package.json')
  try {
    return JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  } catch {
    return null
  }
}

/** 从已安装的宿主包 package.json 算出某个架构需要的 win32 平台包（版本由宿主包钉死） */
export function resolveWindowsPlatformPackages(arch, readManifest) {
  return PLATFORM_PACKAGE_HOSTS.map(spec => {
    const manifest = readManifest(spec.host)
    const name = spec.name(arch)
    const version = manifest?.optionalDependencies?.[name] ?? null
    return {
      host: spec.host,
      hostVersion: manifest?.version ?? null,
      name,
      version,
      required: spec.required,
      why: spec.why,
    }
  })
}

/** 只认真凭据形态的 dotenv：模板（.env.example 等）在依赖包里很常见，不算 */
const DOTENV_TEMPLATE = /^\.env\.(?:example|sample|template|dist|test|defaults)$/i
function isForbiddenEntry(entry) {
  const base = path.posix.basename(entry)
  if (/^\.env(?:\.|$)/i.test(base) && !DOTENV_TEMPLATE.test(base)) return 'dotenv 文件进了包'
  if (/\.(?:pem|p12|pfx)$/i.test(base) || /(?:^|[._-])(?:id_rsa|id_ed25519)$/i.test(base)) return '私钥 / 证书进了包'
  if (/(^|\/)dist-qa[^/]*\//.test(entry)) return 'QA 实验产物进了包（dist-qa*）'
  if (/^\/?website\//.test(entry)) return '官网源码进了包'
  return null
}

/**
 * 纯判定。输入全是列表和数字，好测：
 *   asarEntries      app.asar 里的路径（@electron/asar listPackage 的输出，形如 /out/main/index.js）
 *   resourcesEntries resources/ 下相对路径（递归，posix 分隔）
 *   artifacts        dist 根目录的文件 { name, size }
 *   platformPackages resolveWindowsPlatformPackages 的输出
 */
export function evaluateWindowsPackage({ arch, version, asarEntries, resourcesEntries, artifacts, platformPackages }) {
  const findings = []
  const error = (code, detail) => findings.push({ level: 'error', code, detail })
  const warn = (code, detail) => findings.push({ level: 'warn', code, detail })
  // @electron/asar 的 listPackage 用 path.join 拼路径：在 Windows 上给的是 \out\main\index.js，
  // 在 Mac 上是 /out/main/index.js。统一成 posix 再比（2026-09-05 CI 首跑：Windows 上判"asar 缺一切"）。
  const asar = new Set(asarEntries.map(entry => {
    const posix = entry.split('\\').join('/')
    return posix.startsWith('/') ? posix : `/${posix}`
  }))
  const resources = new Set(resourcesEntries)
  const has = entry => asar.has(entry)

  // 安装包本体
  const installer = artifacts.find(artifact => artifact.name === installerName(version, arch))
  if (!installer) error('INSTALLER_MISSING', `没有 ${installerName(version, arch)}`)
  else if (installer.size < MIN_INSTALLER_BYTES) error('INSTALLER_TOO_SMALL', `${installer.name} 只有 ${installer.size} 字节`)
  if (installer && !artifacts.some(artifact => artifact.name === `${installer.name}.blockmap`)) {
    warn('BLOCKMAP_MISSING', `${installer.name} 没有 .blockmap（差量更新用；不影响安装）`)
  }
  if (artifacts.some(artifact => artifact.name === `openpipal-${version}-setup.exe`)) {
    warn('UNIVERSAL_INSTALLER_PRESENT', '多出一个双架构合并安装包；nsis.buildUniversalInstaller 应为 false')
  }

  // 应用本体
  for (const entry of ['/out/main/index.js', '/out/preload/index.js', '/out/renderer/index.html', '/package.json']) {
    if (!has(entry)) error('APP_ENTRY_MISSING', `app.asar 缺 ${entry}`)
  }

  // win32 平台包——这是 Mac 交叉打包最容易漏、漏了就启动即崩的那一项
  for (const pkg of platformPackages) {
    const present = has(`/node_modules/${pkg.name}/package.json`)
    if (present) continue
    if (pkg.hostVersion === null) {
      // 连宿主包的 package.json 都读不到：是检查本身坏了（路径 / exports 变了），不是"这个架构没有预编译"
      error('PLATFORM_HOST_UNRESOLVED', `读不到 ${pkg.host} 的 package.json，无法判断 ${pkg.name} 该不该在——检查脚本需要修`)
      continue
    }
    if (pkg.version === null) {
      warn('PLATFORM_PACKAGE_UNAVAILABLE', `${pkg.host}@${pkg.hostVersion ?? '?'} 没有 win32-${arch} 预编译（${pkg.name}），${pkg.why}在这个架构上不可用`)
    } else if (pkg.required) {
      error('PLATFORM_PACKAGE_MISSING', `app.asar 缺 ${pkg.name}@${pkg.version}：${pkg.why}在 Windows 上起不来`)
    } else {
      error('PLATFORM_PACKAGE_MISSING', `app.asar 缺 ${pkg.name}@${pkg.version}：${pkg.why}在 Windows 上不可用`)
    }
  }

  // 别的平台的原生二进制混进来：不致命，白占体积
  const foreign = [...asar].filter(entry => /\/node_modules\/(?:@esbuild\/(?:darwin|linux|freebsd|android|netbsd|openbsd|sunos)-|@img\/sharp-(?:darwin|linux|linuxmusl)-|@img\/sharp-libvips-|@napi-rs\/canvas-(?:darwin|linux|android)-)[^/]+\/package\.json$/.test(entry))
  if (foreign.length > 0) {
    warn('FOREIGN_PLATFORM_BINARIES', `带了 ${foreign.length} 个非 Windows 的原生包（白占体积）：${foreign.map(e => e.split('/')[3]).join(', ')}`)
  }

  // 不该出现的东西
  for (const entry of asar) {
    const reason = isForbiddenEntry(entry)
    if (reason) error('FORBIDDEN_ENTRY', `${reason}：${entry}`)
  }

  // extraResources 落在 asar 之外：托盘图、dc 运行时、技能、ACP、MCP 配置
  for (const entry of ['tray/openpipal.ico', 'dc-runtime/support.js', 'mcp-servers.json', 'acp/openpipal-acp.mjs', 'SKILLS-NOTICE.md']) {
    if (!resources.has(entry)) error('RESOURCE_MISSING', `resources/ 缺 ${entry}`)
  }
  if (![...resources].some(entry => entry.startsWith('skills/'))) error('RESOURCE_MISSING', 'resources/skills 是空的')

  const errors = findings.filter(finding => finding.level === 'error').length
  return { arch, verdict: errors === 0 ? 'PASS' : 'FAIL', errors, findings }
}

// ---- 以下是把磁盘上的东西变成上面那些列表 ----

function walk(root, base = root, out = []) {
  for (const dirent of fs.readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, dirent.name)
    if (dirent.isDirectory()) walk(full, base, out)
    else out.push(path.relative(base, full).split(path.sep).join('/'))
  }
  return out
}

export function sha256File(filePath) {
  return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex')
}

export async function inspectWindowsDist(distDir, arch, { projectRoot }) {
  const require = createRequire(path.join(projectRoot, 'package.json'))
  const { version } = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8'))
  const unpacked = path.join(distDir, unpackedDirName(arch))
  const resourcesDir = path.join(unpacked, 'resources')
  const asarPath = path.join(resourcesDir, 'app.asar')
  if (!fs.existsSync(asarPath)) {
    return {
      arch, verdict: 'FAIL', errors: 1,
      findings: [{ level: 'error', code: 'UNPACKED_MISSING', detail: `没有 ${unpacked}/resources/app.asar——这个架构没打过` }]
    }
  }
  const asar = require('@electron/asar')
  const asarEntries = asar.listPackage(asarPath, { isPack: false })
  const resourcesEntries = walk(resourcesDir).filter(entry => entry !== 'app.asar' && !entry.startsWith('app.asar.unpacked/'))
  const artifacts = fs.readdirSync(distDir, { withFileTypes: true })
    .filter(dirent => dirent.isFile())
    .map(dirent => ({ name: dirent.name, size: fs.statSync(path.join(distDir, dirent.name)).size }))
  const platformPackages = resolveWindowsPlatformPackages(arch, host => readHostManifest(projectRoot, host))
  const report = evaluateWindowsPackage({ arch, version, asarEntries, resourcesEntries, artifacts, platformPackages })
  return { ...report, version, asarSha256: sha256File(asarPath), asarPath, installer: installerName(version, arch) }
}

function parseArgs(argv) {
  const options = { dist: 'dist', arch: null, json: null }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--dist') options.dist = argv[++i]
    else if (arg === '--arch') options.arch = argv[++i].split(',').map(item => item.trim()).filter(Boolean)
    else if (arg === '--json') options.json = argv[++i]
    else throw new Error(`未知参数：${arg}`)
  }
  return options
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv)
  const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  const distDir = path.resolve(projectRoot, options.dist)
  const arches = options.arch ?? SUPPORTED_ARCHES.filter(arch => fs.existsSync(path.join(distDir, unpackedDirName(arch))))
  if (arches.length === 0) {
    console.error(`✗ ${distDir} 里没有任何 win-*unpacked 目录`)
    return 1
  }
  const reports = []
  for (const arch of arches) {
    if (!SUPPORTED_ARCHES.includes(arch)) throw new Error(`不支持的架构：${arch}`)
    reports.push(await inspectWindowsDist(distDir, arch, { projectRoot }))
  }
  for (const report of reports) {
    const mark = report.verdict === 'PASS' ? '✓' : '✗'
    console.log(`${mark} win32-${report.arch} ${report.verdict}${report.asarSha256 ? `  asar ${report.asarSha256.slice(0, 12)}  ${report.installer}` : ''}`)
    for (const finding of report.findings) {
      console.log(`    ${finding.level === 'error' ? 'ERROR' : 'warn '} ${finding.code}: ${finding.detail}`)
    }
  }
  const summary = { distDir, generatedAt: new Date().toISOString(), verdict: reports.every(r => r.verdict === 'PASS') ? 'PASS' : 'FAIL', reports }
  if (options.json) fs.writeFileSync(options.json, `${JSON.stringify(summary, null, 2)}\n`)
  return summary.verdict === 'PASS' ? 0 : 1
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(code => process.exit(code)).catch(error => {
    console.error(error instanceof Error ? error.message : error)
    process.exit(2)
  })
}

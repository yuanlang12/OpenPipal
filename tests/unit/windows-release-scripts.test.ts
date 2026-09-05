/**
 * Windows 包出厂检查的纯判定（第 5 段）。立案的事实：Mac 上裸跑 electron-builder 打的 Windows 包
 * 只带 darwin 原生二进制，esbuild / sharp 在 Windows 上找不到，sharp 的顶层 import 让主进程启动即崩。
 * 这里钉：缺 win32 平台包 = FAIL；架构上根本没有预编译的只告警；dotenv / 私钥 / QA 产物混进包 = FAIL。
 */
import { describe, expect, it } from 'vitest'
import {
  evaluateWindowsPackage,
  installerName,
  resolveWindowsPlatformPackages,
  unpackedDirName
} from '../../scripts/verify-windows-release.mjs'

const MANIFESTS: Record<string, any> = {
  esbuild: { version: '0.21.5', optionalDependencies: { '@esbuild/win32-x64': '0.21.5', '@esbuild/win32-arm64': '0.21.5' } },
  sharp: { version: '0.33.5', optionalDependencies: { '@img/sharp-win32-x64': '0.33.5' } },
  '@napi-rs/canvas': { version: '0.1.80', optionalDependencies: { '@napi-rs/canvas-win32-x64-msvc': '0.1.80' } }
}
const readManifest = (host: string) => MANIFESTS[host] ?? null

function goodPackage(arch: 'x64' | 'arm64') {
  const platformPackages = resolveWindowsPlatformPackages(arch, readManifest)
  const asarEntries = [
    '/out/main/index.js', '/out/preload/index.js', '/out/renderer/index.html', '/package.json',
    ...platformPackages.filter(pkg => pkg.version).map(pkg => `/node_modules/${pkg.name}/package.json`),
    '/node_modules/marked/package.json', '/node_modules/some-dep/.env.example'
  ]
  const resourcesEntries = ['tray/openpipal.ico', 'dc-runtime/support.js', 'mcp-servers.json', 'acp/openpipal-acp.mjs', 'SKILLS-NOTICE.md', 'skills/dc-authoring/SKILL.md']
  const artifacts = [
    { name: installerName('1.1.0', arch), size: 150 * 1024 * 1024 },
    { name: `${installerName('1.1.0', arch)}.blockmap`, size: 200_000 }
  ]
  return { arch, version: '1.1.0', asarEntries, resourcesEntries, artifacts, platformPackages }
}

describe('命名约定', () => {
  it('electron-builder 的解包目录：x64 不带后缀，其余带', () => {
    expect(unpackedDirName('x64')).toBe('win-unpacked')
    expect(unpackedDirName('arm64')).toBe('win-arm64-unpacked')
  })
  it('安装包名与 electron-builder.yml 的 artifactName 一致', () => {
    expect(installerName('1.1.0', 'arm64')).toBe('openpipal-1.1.0-arm64-setup.exe')
  })
})

describe('resolveWindowsPlatformPackages', () => {
  it('版本由宿主包的 optionalDependencies 钉死；架构上没有的给 null', () => {
    const x64 = resolveWindowsPlatformPackages('x64', readManifest)
    expect(x64.map(pkg => [pkg.name, pkg.version])).toEqual([
      ['@esbuild/win32-x64', '0.21.5'],
      ['@img/sharp-win32-x64', '0.33.5'],
      ['@napi-rs/canvas-win32-x64-msvc', '0.1.80']
    ])
    const arm64 = resolveWindowsPlatformPackages('arm64', readManifest)
    expect(arm64.find(pkg => pkg.host === 'esbuild')?.version).toBe('0.21.5')
    expect(arm64.find(pkg => pkg.host === 'sharp')?.version).toBeNull()
    expect(arm64.find(pkg => pkg.host === '@napi-rs/canvas')?.version).toBeNull()
  })

  it('宿主包没装（readManifest 返回 null）也不炸', () => {
    const packages = resolveWindowsPlatformPackages('x64', () => null)
    expect(packages.every(pkg => pkg.version === null && pkg.hostVersion === null)).toBe(true)
  })
})

describe('evaluateWindowsPackage', () => {
  it('齐全的 x64 包 PASS，模板 dotenv 不算违禁', () => {
    const report = evaluateWindowsPackage(goodPackage('x64'))
    expect(report.verdict).toBe('PASS')
    expect(report.findings.filter(f => f.level === 'error')).toEqual([])
  })

  it('arm64：sharp / canvas 没有预编译只告警，esbuild 有就 PASS', () => {
    const report = evaluateWindowsPackage(goodPackage('arm64'))
    expect(report.verdict).toBe('PASS')
    expect(report.findings.map(f => f.code)).toEqual(expect.arrayContaining(['PLATFORM_PACKAGE_UNAVAILABLE']))
    expect(report.findings.filter(f => f.code === 'PLATFORM_PACKAGE_UNAVAILABLE')).toHaveLength(2)
  })

  it('Mac 裸打的形态：只有 darwin 二进制 → FAIL，并点名缺的 win32 包', () => {
    const pkg = goodPackage('x64')
    pkg.asarEntries = pkg.asarEntries
      .filter(entry => !entry.includes('win32'))
      .concat(['/node_modules/@esbuild/darwin-arm64/package.json', '/node_modules/@img/sharp-darwin-arm64/package.json'])
    const report = evaluateWindowsPackage(pkg)
    expect(report.verdict).toBe('FAIL')
    const missing = report.findings.filter(f => f.code === 'PLATFORM_PACKAGE_MISSING').map(f => f.detail)
    expect(missing.some(detail => detail.includes('@esbuild/win32-x64'))).toBe(true)
    expect(missing.some(detail => detail.includes('@img/sharp-win32-x64'))).toBe(true)
    expect(report.findings.some(f => f.code === 'FOREIGN_PLATFORM_BINARIES')).toBe(true)
  })

  it('凭据形态的 dotenv、私钥、QA 产物、官网源码进包 → FAIL', () => {
    const pkg = goodPackage('x64')
    pkg.asarEntries.push('/.env', '/node_modules/x/.env.local', '/secrets/id_rsa', '/dist-qa-base/x.js', '/website/index.html', '/cert.pem')
    const report = evaluateWindowsPackage(pkg)
    expect(report.verdict).toBe('FAIL')
    expect(report.findings.filter(f => f.code === 'FORBIDDEN_ENTRY')).toHaveLength(6)
  })

  it('安装包缺失 / 太小 / 多出合并版；extraResources 缺项', () => {
    const missing = goodPackage('x64')
    missing.artifacts = [{ name: 'openpipal-1.1.0-setup.exe', size: 290 * 1024 * 1024 }]
    const report = evaluateWindowsPackage(missing)
    expect(report.findings.map(f => f.code)).toEqual(expect.arrayContaining(['INSTALLER_MISSING', 'UNIVERSAL_INSTALLER_PRESENT']))

    const small = goodPackage('x64')
    small.artifacts[0].size = 1024
    expect(evaluateWindowsPackage(small).findings.some(f => f.code === 'INSTALLER_TOO_SMALL')).toBe(true)

    const noTray = goodPackage('x64')
    noTray.resourcesEntries = noTray.resourcesEntries.filter(entry => entry !== 'tray/openpipal.ico')
    expect(evaluateWindowsPackage(noTray).findings.some(f => f.code === 'RESOURCE_MISSING' && f.detail.includes('openpipal.ico'))).toBe(true)
  })

  it('连宿主包的 package.json 都读不到 → FAIL（是检查坏了，不是"这个架构没有预编译"）', () => {
    // 实案：sharp 0.35 的 exports 表不导出 ./package.json，require.resolve 那条路抛错，
    // 第一版把它当成"没有 win32 预编译"只告了个警，结果一个 sharp 包都没塞进去还判了 PASS
    const pkg = goodPackage('x64')
    pkg.platformPackages = resolveWindowsPlatformPackages('x64', host => (host === 'sharp' ? null : MANIFESTS[host]))
    pkg.asarEntries = pkg.asarEntries.filter(entry => !entry.includes('@img/'))
    const report = evaluateWindowsPackage(pkg)
    expect(report.verdict).toBe('FAIL')
    expect(report.findings.some(f => f.code === 'PLATFORM_HOST_UNRESOLVED' && f.detail.includes('sharp'))).toBe(true)
  })

  it('app.asar 缺主进程入口 → FAIL', () => {
    const pkg = goodPackage('x64')
    pkg.asarEntries = pkg.asarEntries.filter(entry => entry !== '/out/main/index.js')
    expect(evaluateWindowsPackage(pkg).findings.some(f => f.code === 'APP_ENTRY_MISSING')).toBe(true)
  })

  it('Windows 上 listPackage 给的是反斜杠路径（\\out\\main\\index.js）：一样认，不许判成"缺一切"', () => {
    const pkg = goodPackage('x64')
    pkg.asarEntries = pkg.asarEntries.map(entry => entry.slice(1).split('/').join('\\'))
    const report = evaluateWindowsPackage(pkg)
    expect(report.verdict).toBe('PASS')
    expect(report.findings.filter(f => f.level === 'error')).toEqual([])
  })
})

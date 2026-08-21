import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { minimatch } from 'minimatch'
import { parse } from 'yaml'

interface ExtraResource {
  from: string
  to?: string
  filter?: string[]
}

interface BuilderConfig {
  afterPack?: string
  files: string[]
  extraResources: ExtraResource[]
  mac: {
    hardenedRuntime: boolean
    entitlements: string
    entitlementsInherit: string
    extendInfo: Record<string, string>
  }
}

interface ReleaseBuilderConfig {
  afterPack: string
  extends: string
}

const config = parse(fs.readFileSync(path.resolve('electron-builder.yml'), 'utf8')) as BuilderConfig
const releaseConfig = parse(
  fs.readFileSync(path.resolve('electron-builder.release.yml'), 'utf8'),
) as ReleaseBuilderConfig
const packageManifest = JSON.parse(fs.readFileSync(path.resolve('package.json'), 'utf8')) as {
  scripts: Record<string, string>
}

/**
 * files 是**正向白名单**（见 electron-builder.yml 顶部的理由）：一条路径进不进 asar，
 * 取决于有没有哪条正向 pattern 命中它、且没被 `!` 打掉。此前这里假设的是排除列表
 * （"有没有 `!src/*` 这一条"），白名单改造之后那种断言恒为假——测试红着，却什么都没在守。
 */
function packedIntoAsar(file: string): boolean {
  let packed = false
  for (const pattern of config.files) {
    if (pattern.startsWith('!')) {
      if (minimatch(file, pattern.slice(1), { dot: true })) packed = false
    } else if (minimatch(file, pattern, { dot: true })) {
      packed = true
    }
  }
  return packed
}

function normalizeResourcePath(value: string): string {
  return path.posix.normalize(value.replaceAll('\\', '/')).replace(/^\.\//, '')
}

function plistBooleanKeys(file: string): string[] {
  const xml = fs.readFileSync(path.resolve(file), 'utf8')
  const body = xml
    .replace(/<\?xml[^>]*\?>/, '')
    .replace(/<!DOCTYPE[^>]*>/, '')
    .replace(/<plist\s+version="1\.0">/, '')
    .replace(/<\/plist>/, '')
    .replace(/<dict>/, '')
    .replace(/<\/dict>/, '')
    .replace(/<!--[\s\S]*?-->/g, '')
  const entries = Array.from(
    body.matchAll(/<key>([^<]+)<\/key>\s*<true\s*\/>/g),
    (match) => match[1]
  )
  const residual = body.replace(/<key>[^<]+<\/key>\s*<true\s*\/>/g, '').trim()

  if (residual !== '' || new Set(entries).size !== entries.length) {
    throw new Error(`Unsupported or malformed entitlement plist: ${file}`)
  }
  return entries.sort()
}

function readInfoPlistStrings(file: string): Record<string, string> {
  const strings = fs.readFileSync(path.resolve(file), 'utf8')
  const parsed: Record<string, string> = {}

  for (const [index, line] of strings.split(/\r?\n/).entries()) {
    if (line.trim() === '') continue
    const match = line.match(/^("(?:\\.|[^"\\])*")\s*=\s*("(?:\\.|[^"\\])*");$/)
    if (!match) throw new Error(`Malformed InfoPlist.strings line ${index + 1}: ${file}`)
    const key = JSON.parse(match[1]) as string
    const value = JSON.parse(match[2]) as string
    if (Object.hasOwn(parsed, key)) throw new Error(`Duplicate InfoPlist.strings key: ${key}`)
    parsed[key] = value
  }

  return parsed
}

describe('Electron Builder release boundary', () => {
  it('keeps the candidate manifest hook exclusive to the release build', async () => {
    expect(config.afterPack).toBeUndefined()
    expect(releaseConfig).toEqual({
      extends: './electron-builder.yml',
      afterPack: './scripts/embed-macos-release-build-manifest.mjs',
    })
    // 每条打包路径都必须先产出适配器：漏一条就会把上一次的 dist 当成新的装进包里
    expect(packageManifest.scripts['build:acp']).toBe('npm --prefix openpipal-acp run build')
    expect(packageManifest.scripts['build:mac']).toBe(
      'npm run build && npm run build:acp && electron-builder --mac',
    )
    expect(packageManifest.scripts['build:unpack']).toBe(
      'npm run build && npm run build:acp && electron-builder --dir',
    )
    expect(packageManifest.scripts['release:build-macos']).toBe(
      'npm run build && npm run build:acp && electron-builder --mac --config electron-builder.release.yml',
    )
    const hook = await import('../../scripts/embed-macos-release-build-manifest.mjs')
    expect(typeof hook.afterPack).toBe('function')
  })

  it('keeps root development configuration out of app.asar', () => {
    const forbidden = [
      'eslint.config.mjs',
      'playwright.config.ts',
      'postcss.config.js',
      'tailwind.config.js',
      'vitest.config.ts',
    ]

    for (const file of forbidden) expect(packedIntoAsar(file), file).toBe(false)
    expect(packedIntoAsar('mcp-servers.json')).toBe(false)
  })

  it('keeps source, QA, documentation, scripts, and historical outputs out of app.asar', () => {
    for (const file of [
      'src/main/index.ts',
      'tests/unit/anything.test.ts',
      'docs/claude/architecture.md',
      'scripts/verify-macos-release.mjs',
      // 适配器只以 extraResources 的形式随包（asar 之外），源码和 dist 都不进 asar
      'openpipal-acp/src/agent.ts',
      'openpipal-acp/dist/index.js',
      'openpipal-extension/manifest.json',
      'dist/renderer.js',
      'release/OpenPipal.dmg',
    ]) {
      expect(packedIntoAsar(file), file).toBe(false)
    }
    // 白名单本身仍要放行运行时真正需要的那几类
    for (const file of ['out/main/index.js', 'package.json', 'LICENSE']) {
      expect(packedIntoAsar(file), file).toBe(true)
    }
  })

  it('ships only the sanitized MCP configuration as an extra resource', () => {
    const sources = config.extraResources.map((entry) => normalizeResourcePath(entry.from))
    const sanitized = config.extraResources.filter(
      (entry) => normalizeResourcePath(entry.from) === 'resources/mcp-servers.json'
    )

    expect(packedIntoAsar('mcp-servers.json')).toBe(false)
    expect(sanitized).toEqual([
      expect.objectContaining({ to: 'mcp-servers.json' }),
    ])
    expect(sources).not.toContain('mcp-servers.json')
  })

  it('ships the ACP adapter as a runnable single file outside app.asar', () => {
    const adapter = config.extraResources.find(
      (entry) => normalizeResourcePath(entry.from) === 'openpipal-acp/dist/index.js'
    )

    // .mjs 不是审美：Resources 下没有 package.json，.js 会被 Node 当成 CommonJS，
    // 适配器第一行 import 就语法报错——用户看到的是"编辑器连不上"。
    expect(adapter?.to).toBe('acp/openpipal-acp.mjs')
    // 主进程按这个位置拼启动命令，两边必须对得上
    expect(fs.readFileSync(path.resolve('src/main/acp-adapter-launch.ts'), 'utf8'))
      .toContain("join(process.resourcesPath, 'acp', 'openpipal-acp.mjs')")
  })

  it('does not select backup, brand, or legacy Skill resources', () => {
    const sources = config.extraResources.map((entry) => normalizeResourcePath(entry.from))
    const dcRuntime = config.extraResources.find(
      (entry) => normalizeResourcePath(entry.from) === 'resources/dc-runtime'
    )

    expect(dcRuntime?.filter).toContain('!backup-pre-w1/**')
    expect(sources).not.toContain('resources/brand')
    expect(sources).not.toContain('resources/skills-legacy')
  })

  it('declares the hardened Runtime and exact macOS entitlement files', () => {
    expect(config.mac.hardenedRuntime).toBe(true)
    expect(config.mac.entitlements).toBe('resources/entitlements.mac.plist')
    expect(config.mac.entitlementsInherit).toBe('resources/entitlements.mac.inherit.plist')

    expect(plistBooleanKeys(config.mac.entitlements)).toEqual([
      'com.apple.security.automation.apple-events',
      'com.apple.security.cs.allow-jit',
      'com.apple.security.device.audio-input',
      'com.apple.security.device.camera',
      'com.apple.security.personal-information.location',
    ])
    expect(plistBooleanKeys(config.mac.entitlementsInherit)).toEqual([
      'com.apple.security.cs.allow-jit',
    ])

    const allEntitlements = [
      ...plistBooleanKeys(config.mac.entitlements),
      ...plistBooleanKeys(config.mac.entitlementsInherit),
    ]
    for (const forbidden of [
      'com.apple.security.app-sandbox',
      'com.apple.security.cs.allow-unsigned-executable-memory',
      'com.apple.security.cs.debugger',
      'com.apple.security.cs.disable-library-validation',
      'com.apple.security.get-task-allow',
      'com.apple.security.inherit',
    ]) {
      expect(allEntitlements, forbidden).not.toContain(forbidden)
    }
  })

  it('keeps privacy descriptions at the Info.plist root and ships both locales', () => {
    const privacyKeys = [
      'NSAppleEventsUsageDescription',
      'NSCameraUsageDescription',
      'NSLocationUsageDescription',
      'NSLocationWhenInUseUsageDescription',
      'NSMicrophoneUsageDescription',
      'NSScreenCaptureUsageDescription',
    ].sort()

    expect(Array.isArray(config.mac.extendInfo)).toBe(false)
    expect(Object.keys(config.mac.extendInfo).sort()).toEqual(privacyKeys)
    expect(config.mac.extendInfo).not.toHaveProperty('0')
    expect(config.mac.extendInfo).not.toHaveProperty('length')
    for (const value of Object.values(config.mac.extendInfo)) {
      expect(value.trim().length).toBeGreaterThan(20)
    }

    const localizedFiles = [
      'resources/mac/en.lproj/InfoPlist.strings',
      'resources/mac/zh-Hans.lproj/InfoPlist.strings',
    ]
    for (const file of localizedFiles) {
      const localized = readInfoPlistStrings(file)
      expect(Object.keys(localized).sort()).toEqual(privacyKeys)
      for (const value of Object.values(localized)) {
        expect(value.trim().length).toBeGreaterThan(20)
      }
    }

    const localizedResources = config.extraResources.filter((entry) =>
      normalizeResourcePath(entry.from).startsWith('resources/mac/')
    )
    expect(localizedResources).toEqual([
      {
        from: 'resources/mac/en.lproj/InfoPlist.strings',
        to: 'en.lproj/InfoPlist.strings',
      },
      {
        from: 'resources/mac/zh-Hans.lproj/InfoPlist.strings',
        to: 'zh-Hans.lproj/InfoPlist.strings',
      },
    ])
  })
})

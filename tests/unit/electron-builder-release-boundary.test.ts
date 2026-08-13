import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
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

function rootFileIsExcluded(file: string): boolean {
  return config.files.some((pattern) => {
    if (pattern === `!${file}`) return true
    const brace = pattern.match(/^!\{([^{}]+)\}$/)
    return brace?.[1].split(',').includes(file) ?? false
  })
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
    expect(packageManifest.scripts['build:mac']).toBe('npm run build && electron-builder --mac')
    expect(packageManifest.scripts['build:unpack']).toBe('npm run build && electron-builder --dir')
    expect(packageManifest.scripts['release:build-macos']).toBe(
      'npm run build && electron-builder --mac --config electron-builder.release.yml',
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

    for (const file of forbidden) expect(rootFileIsExcluded(file), file).toBe(true)
    expect(rootFileIsExcluded('mcp-servers.json')).toBe(true)
  })

  it('keeps source, QA, documentation, scripts, and historical outputs out of app.asar', () => {
    for (const pattern of [
      "!src/*",
      "!tests/**",
      "!docs/**",
      "!scripts/**",
      "!openpipal-acp/**",
      "!openpipal-extension/**",
      "!dist/**",
      "!release/**",
    ]) {
      expect(config.files).toContain(pattern)
    }
  })

  it('ships only the sanitized MCP configuration as an extra resource', () => {
    const sources = config.extraResources.map((entry) => normalizeResourcePath(entry.from))
    const sanitized = config.extraResources.filter(
      (entry) => normalizeResourcePath(entry.from) === 'resources/mcp-servers.json'
    )

    expect(rootFileIsExcluded('mcp-servers.json')).toBe(true)
    expect(sanitized).toEqual([
      expect.objectContaining({ to: 'mcp-servers.json' }),
    ])
    expect(sources).not.toContain('mcp-servers.json')
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

import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  assertPiCoreNodeVersionSupported,
  isPiCoreNodeVersionSupported,
  PI_CORE_NODE_ENGINE
} from '../../src/main/agent-runtime/pi-core-compatibility'

describe('pi-core Node compatibility gate', () => {
  it('keeps the official Pi runtime packages on one exact 0.84.1 contract', () => {
    const versions = [
      '@earendil-works/pi-agent-core',
      '@earendil-works/pi-ai',
      '@earendil-works/pi-coding-agent'
    ].map((packageName) => JSON.parse(fs.readFileSync(
      path.resolve('node_modules', packageName, 'package.json'),
      'utf8'
    )).version)

    expect(versions).toEqual(['0.84.1', '0.84.1', '0.84.1'])
  })

  it('resolves no nested 0.83 copy of the three Pi runtime packages', () => {
    const lock = JSON.parse(fs.readFileSync(path.resolve('package-lock.json'), 'utf8'))
    const runtimePackage = /node_modules\/@earendil-works\/pi-(?:agent-core|ai|coding-agent)$/
    const resolved = Object.entries(lock.packages as Record<string, { version?: string }>)
      .filter(([packagePath]) => runtimePackage.test(packagePath))
      .map(([packagePath, value]) => ({ packagePath, version: value.version }))

    expect(resolved.length).toBeGreaterThanOrEqual(3)
    expect(resolved.every(({ version }) => version === '0.84.1')).toBe(true)
    expect(resolved.some(({ version }) => version?.startsWith('0.83.'))).toBe(false)
  })

  it('matches the installed package engine contract', () => {
    const packageJson = JSON.parse(fs.readFileSync(
      path.resolve('node_modules/@earendil-works/pi-agent-core/package.json'),
      'utf8'
    ))
    expect(packageJson.engines.node).toBe(PI_CORE_NODE_ENGINE)
  })

  it('accepts the support floor and newer Node releases', () => {
    expect(isPiCoreNodeVersionSupported('22.19.0')).toBe(true)
    expect(isPiCoreNodeVersionSupported('22.19.0+build.1')).toBe(true)
    expect(isPiCoreNodeVersionSupported('22.19.1')).toBe(true)
    expect(isPiCoreNodeVersionSupported('23.0.0')).toBe(true)
  })

  it('rejects older and malformed versions', () => {
    expect(isPiCoreNodeVersionSupported('22.18.9')).toBe(false)
    expect(isPiCoreNodeVersionSupported('20.18.3')).toBe(false)
    expect(isPiCoreNodeVersionSupported('22.19.0-rc.1')).toBe(false)
    expect(isPiCoreNodeVersionSupported('not-a-version')).toBe(false)
    expect(() => assertPiCoreNodeVersionSupported('20.18.3'))
      .toThrow('pi-core requires Node >=22.19.0')
  })
})

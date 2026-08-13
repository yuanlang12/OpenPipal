import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

describe('Electron native dependency contract', () => {
  it('loads and executes native image/PDF dependencies under the release ABI', () => {
    const electron = path.resolve('node_modules/.bin/electron')
    const fixture = path.resolve('tests/fixtures/electron-native-deps-contract.mjs')
    const output = execFileSync(electron, [fixture], {
      encoding: 'utf8',
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1'
      }
    })
    const result = JSON.parse(output)

    expect(result.electronVersion).toBe('43.3.0')
    expect(result.nodeVersion).toBe('24.18.1')
    expect(result.modulesVersion).toBe('148')
    expect(result.sharpPngBytes).toBeGreaterThan(0)
    expect(result.canvasPngBytes).toBeGreaterThan(0)
    expect(result.pdfParseExport).toBe('function')
    expect(result.vipsVersion).toMatch(/^\d+\.\d+\.\d+$/)
  })
})

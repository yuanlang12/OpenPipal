import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

describe('Electron Runtime release contract', () => {
  it('pins the supported Electron and packaging toolchain', () => {
    const appPackage = JSON.parse(fs.readFileSync(path.resolve('package.json'), 'utf8'))
    const lockPackage = JSON.parse(fs.readFileSync(path.resolve('package-lock.json'), 'utf8'))
    const electronPackage = JSON.parse(fs.readFileSync(
      path.resolve('node_modules/electron/package.json'),
      'utf8'
    ))
    const builderPackage = JSON.parse(fs.readFileSync(
      path.resolve('node_modules/electron-builder/package.json'),
      'utf8'
    ))

    expect(appPackage.engines.node).toBe('>=22.19.0')
    expect(appPackage.devDependencies.electron).toBe('43.3.0')
    expect(appPackage.devDependencies['electron-builder']).toBe('26.15.7')
    expect(lockPackage.packages[''].devDependencies.electron).toBe('43.3.0')
    expect(lockPackage.packages[''].devDependencies['electron-builder']).toBe('26.15.7')
    expect(electronPackage.version).toBe('43.3.0')
    expect(builderPackage.version).toBe('26.15.7')
  })

  it('installs the on-demand binary before every Electron-dependent workflow', () => {
    const appPackage = JSON.parse(fs.readFileSync(path.resolve('package.json'), 'utf8'))

    expect(appPackage.scripts['electron:install']).toBe('install-electron --no')
    expect(appPackage.scripts.predev).toBe('npm run electron:install')
    expect(appPackage.scripts.prebuild).toBe('npm run electron:install')
    expect(appPackage.scripts['pretest:unit']).toBe('npm run electron:install')
  })

  it('declares Electron 43 macOS support in the package contract', () => {
    const builderConfig = fs.readFileSync(path.resolve('electron-builder.yml'), 'utf8')
    expect(builderConfig).toContain("minimumSystemVersion: '12.0'")
    // 历史产物出不出得去，由**正向白名单**决定（files 只列运行时需要的那几类），
    // 不再靠 `!dist/**` 这种排除条目——那要求预测未来会出现什么文件。
    // 白名单本身的边界断言在 electron-builder-release-boundary.test.ts。
    expect(builderConfig).not.toContain("- 'dist/**'")
    expect(builderConfig).not.toContain("- 'release/**'")
  })
})

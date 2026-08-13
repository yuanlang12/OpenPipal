import fs from 'node:fs'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

const { home } = vi.hoisted(() => ({
  home: `/tmp/openpipal-skill-defaults-${process.pid}`
}))

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getAppPath: () => process.cwd(),
    getPath: () => home
  }
}))
vi.mock('../../src/main/mcp-manager', () => ({ listMcpSkillDirs: () => [] }))
vi.mock('../../src/main/plugin-manager', () => ({ listPluginSkillDirs: () => [] }))

const {
  DEFAULT_DISABLED_BUILTINS,
  getSkillsConfigPath,
  readDisabledSkillNames
} = await import('../../src/main/openpipal-skill-sources')

describe('skill defaults before first chat', () => {
  beforeAll(() => fs.rmSync(home, { recursive: true, force: true }))
  afterAll(() => fs.rmSync(home, { recursive: true, force: true }))

  it('fails closed to the default-disabled built-ins before config creation', () => {
    expect(readDisabledSkillNames()).toEqual(DEFAULT_DISABLED_BUILTINS)
  })

  it('uses the persisted user selection once config exists', () => {
    fs.mkdirSync(path.dirname(getSkillsConfigPath()), { recursive: true })
    fs.writeFileSync(getSkillsConfigPath(), JSON.stringify({ disabled: ['pdf'] }))
    expect(readDisabledSkillNames()).toEqual(['pdf'])
  })

  it('fails closed when the persisted config is malformed', () => {
    fs.writeFileSync(getSkillsConfigPath(), '{not-json')
    expect(readDisabledSkillNames()).toEqual(DEFAULT_DISABLED_BUILTINS)
  })

  it('fails closed when the persisted disabled field has the wrong shape', () => {
    fs.writeFileSync(getSkillsConfigPath(), JSON.stringify({ disabled: 'pdf' }))
    expect(readDisabledSkillNames()).toEqual(DEFAULT_DISABLED_BUILTINS)
  })
})

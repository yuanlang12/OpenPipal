import { afterAll, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'openpipal-role-manifest-security-'))
process.env.HOME = TMP

const { readRoleManifest } = await import('../../src/main/role-manager')
const root = path.join(TMP, '.openpipal', 'system-agents')
const roleDir = path.join(root, 'general')
fs.mkdirSync(roleDir, { recursive: true })
fs.writeFileSync(path.join(roleDir, 'preflow.json'), JSON.stringify({ kind: 'safe' }))

afterAll(() => {
  fs.rmSync(TMP, { recursive: true, force: true })
})

describe('role manifest path boundary', () => {
  it('reads a known role manifest from its exact directory', () => {
    expect(readRoleManifest('general', 'preflow.json')).toEqual({ kind: 'safe' })
  })

  it('rejects unknown and path-shaped role names and file names', () => {
    expect(readRoleManifest('../outside', 'preflow.json')).toBeNull()
    expect(readRoleManifest('general', '../secret.json')).toBeNull()
    expect(readRoleManifest('not-a-role', 'preflow.json')).toBeNull()
  })

  it('does not follow a manifest symlink outside system-agents', () => {
    const outside = path.join(TMP, 'outside.json')
    fs.writeFileSync(outside, JSON.stringify({ secret: true }))
    fs.symlinkSync(outside, path.join(roleDir, 'layout.json'))
    expect(readRoleManifest('general', 'layout.json')).toBeNull()
  })
})

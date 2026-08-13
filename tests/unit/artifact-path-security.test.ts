import { afterAll, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'openpipal-artifact-path-security-'))
process.env.HOME = TMP

const {
  loadArtifact,
  loadCompiledArtifact,
  saveArtifact,
  updateArtifact,
} = await import('../../src/main/artifact-store')

const ROOT = path.join(TMP, '.openpipal', 'conversations', 'artifacts')

afterAll(() => {
  fs.rmSync(TMP, { recursive: true, force: true })
})

describe('artifact sidecar path boundary', () => {
  it('accepts ordinary ids but rejects traversal components before writing', () => {
    const ref = saveArtifact('conv-safe', {
      id: 'artifact-safe-1',
      type: 'markdown',
      title: 'Safe',
      content: 'safe content',
    })
    expect(fs.readFileSync(ref.path, 'utf8')).toBe('safe content')

    expect(() => saveArtifact('../outside', {
      id: 'artifact-escape', type: 'markdown', title: 'x', content: 'escape',
    })).toThrow(/conversationId/)
    expect(() => saveArtifact('conv-safe', {
      id: '../artifact-escape', type: 'markdown', title: 'x', content: 'escape',
    })).toThrow(/artifactId/)
    expect(fs.existsSync(path.join(TMP, '.openpipal', 'conversations', 'outside'))).toBe(false)
  })

  it('binds a ref to its exact conversation and artifact id', () => {
    const ref = saveArtifact('conv-owner', {
      id: 'artifact-owned', type: 'markdown', title: 'Owned', content: 'owner-only',
    })
    expect(loadArtifact(ref, 'conv-owner')?.content).toBe('owner-only')
    expect(loadArtifact(ref, 'conv-other')).toBeNull()
    expect(loadArtifact({ ...ref, id: 'artifact-forged' }, 'conv-owner')).toBeNull()
  })

  it('rejects prefix siblings, lexical escapes, and leaf symlinks', () => {
    const outside = path.join(TMP, 'outside-secret.txt')
    fs.writeFileSync(outside, 'do not expose')

    const sibling = path.join(TMP, '.openpipal', 'conversations', 'artifacts-evil')
    fs.mkdirSync(sibling, { recursive: true })
    const siblingFile = path.join(sibling, 'artifact-secret.txt')
    fs.writeFileSync(siblingFile, 'sibling secret')
    expect(loadArtifact({
      id: 'artifact-secret', type: 'markdown', title: 'x', path: siblingFile,
    })).toBeNull()

    const escapedPath = path.join(ROOT, '..', '..', '..', '..', 'outside-secret.txt')
    expect(loadArtifact({
      id: 'outside-secret', type: 'markdown', title: 'x', path: escapedPath,
    })).toBeNull()

    const safe = saveArtifact('conv-links', {
      id: 'artifact-seed', type: 'markdown', title: 'seed', content: 'seed',
    })
    const link = path.join(path.dirname(safe.path), 'artifact-link.md')
    fs.symlinkSync(outside, link)
    const forged = { id: 'artifact-link', type: 'markdown', title: 'link', path: link }
    expect(loadArtifact(forged, 'conv-links')).toBeNull()
    updateArtifact(forged, 'overwritten')
    expect(fs.readFileSync(outside, 'utf8')).toBe('do not expose')
  })

  it('rejects a conversation directory symlink for save and compiled reads', () => {
    fs.mkdirSync(ROOT, { recursive: true })
    const outsideDir = path.join(TMP, 'outside-dir')
    fs.mkdirSync(outsideDir)
    fs.writeFileSync(path.join(outsideDir, 'artifact-scene.compiled.js'), 'secret compiled')
    fs.symlinkSync(outsideDir, path.join(ROOT, 'conv-linked'))

    expect(() => saveArtifact('conv-linked', {
      id: 'artifact-scene', type: 'code', title: 'scene', content: 'x', language: 'javascript',
    })).toThrow(/目录不安全/)
    expect(loadCompiledArtifact('conv-linked', 'artifact-scene')).toBeNull()
    expect(loadCompiledArtifact('../outside-dir', 'artifact-scene')).toBeNull()
  })
})

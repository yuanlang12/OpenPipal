/**
 * Unit tests for the adaptive-forgetting (archive) engine in memory-store.ts.
 *
 * These exercise the DETERMINISTIC archive policy directly against temp dirs —
 * the part that the Playwright E2E suite (renderer + mocked window.api) cannot reach.
 *
 * Run: npx vitest run tests/unit/memory-archive.test.ts
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  utimesSync,
  existsSync,
  readFileSync
} from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import {
  archiveStaleMemories,
  listArchivedMemories,
  restoreArchivedMemory,
  getArchiveDir,
  scanMemoryFiles,
  ARCHIVE_POLICY,
  type MemoryType
} from '../../src/main/memory-store'

const DAY = 86_400_000

let dir: string

function makeMemory(
  filename: string,
  type: MemoryType | 'none',
  ageDays: number,
  body = 'content'
): void {
  const typeLine = type === 'none' ? '' : `type: ${type}\n`
  const content = `---\nname: ${filename}\ndescription: test memory ${filename}\n${typeLine}---\n\n${body}\n`
  const path = join(dir, filename)
  writeFileSync(path, content, 'utf-8')
  // override mtime to simulate age
  const when = new Date(Date.now() - ageDays * DAY)
  utimesSync(path, when, when)
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sw-mem-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('archiveStaleMemories — global scope', () => {
  it('archives stale project/reference/untyped but protects user/feedback and fresh', () => {
    makeMemory('project_old.md', 'project', 40) // stale → archive
    makeMemory('reference_old.md', 'reference', 25) // stale (>21) → archive
    makeMemory('untyped_old.md', 'none', 40) // stale, not protected → archive
    makeMemory('user_old.md', 'user', 100) // protected → keep
    makeMemory('feedback_old.md', 'feedback', 100) // protected → keep
    makeMemory('project_fresh.md', 'project', 3) // fresh (<21) → keep

    const archived = archiveStaleMemories(dir, 'global')
    const archivedNames = archived.map((r) => r.filename).sort()

    expect(archivedNames).toEqual(['project_old.md', 'reference_old.md', 'untyped_old.md'])

    // moved out of top-level
    expect(existsSync(join(dir, 'project_old.md'))).toBe(false)
    expect(existsSync(join(dir, 'reference_old.md'))).toBe(false)
    expect(existsSync(join(dir, 'untyped_old.md'))).toBe(false)

    // protected + fresh still present
    expect(existsSync(join(dir, 'user_old.md'))).toBe(true)
    expect(existsSync(join(dir, 'feedback_old.md'))).toBe(true)
    expect(existsSync(join(dir, 'project_fresh.md'))).toBe(true)

    // archived files physically live under archive/
    expect(existsSync(join(getArchiveDir(dir), 'project_old.md'))).toBe(true)

    // top-level scan no longer surfaces archived memories (the key property: they leave context)
    const topLevel = scanMemoryFiles(dir).map((h) => h.filename).sort()
    expect(topLevel).toEqual(['feedback_old.md', 'project_fresh.md', 'user_old.md'])
  })

  it('writes an audit log line per archived memory', () => {
    makeMemory('project_a.md', 'project', 30)
    makeMemory('project_b.md', 'project', 30)
    archiveStaleMemories(dir, 'global')

    const log = readFileSync(join(getArchiveDir(dir), '_archive-log.jsonl'), 'utf-8')
    const lines = log.trim().split('\n').filter(Boolean)
    expect(lines.length).toBe(2)
    const first = JSON.parse(lines[0])
    expect(first.reason).toBe('stale')
    expect(first.scope).toBe('global')
    expect(typeof first.archivedAt).toBe('string')
  })

  it('does nothing when all memories are fresh', () => {
    makeMemory('project_fresh.md', 'project', 1)
    makeMemory('reference_fresh.md', 'reference', 5)
    const archived = archiveStaleMemories(dir, 'global')
    expect(archived).toEqual([])
    expect(existsSync(getArchiveDir(dir))).toBe(false)
  })
})

describe('archiveStaleMemories — conversation scope', () => {
  it('uses the shorter threshold and ignores type protection', () => {
    expect(ARCHIVE_POLICY.conversationStaleDays).toBeLessThan(ARCHIVE_POLICY.globalStaleDays)
    makeMemory('user_conv.md', 'user', 20) // conv scope → no type protection → archive
    makeMemory('project_recent.md', 'project', 5) // below conv threshold → keep

    const archived = archiveStaleMemories(dir, 'conversation')
    expect(archived.map((r) => r.filename)).toEqual(['user_conv.md'])
    expect(existsSync(join(dir, 'project_recent.md'))).toBe(true)
  })
})

describe('listArchivedMemories + restoreArchivedMemory', () => {
  it('lists archived memories and restores them back to the live dir', () => {
    makeMemory('project_old.md', 'project', 40)
    archiveStaleMemories(dir, 'global')

    const archivedList = listArchivedMemories(dir)
    expect(archivedList.map((h) => h.filename)).toEqual(['project_old.md'])

    const ok = restoreArchivedMemory(join(getArchiveDir(dir), 'project_old.md'))
    expect(ok).toBe(true)

    // back in the live dir, gone from archive
    expect(existsSync(join(dir, 'project_old.md'))).toBe(true)
    expect(existsSync(join(getArchiveDir(dir), 'project_old.md'))).toBe(false)
    expect(scanMemoryFiles(dir).map((h) => h.filename)).toContain('project_old.md')
  })

  it('restore returns false for a missing file', () => {
    expect(restoreArchivedMemory(join(getArchiveDir(dir), 'nope.md'))).toBe(false)
  })
})

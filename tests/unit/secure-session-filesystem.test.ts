import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { SecureSessionFileSystem } from '../../src/main/session/secure-session-filesystem'

const roots: string[] = []

function makeRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openpipal-session-fs-'))
  roots.push(root)
  return root
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})
describe('SecureSessionFileSystem', () => {
  it('keeps directories private and JSONL leaves owner-only', async () => {
    const root = makeRoot()
    const adapter = new SecureSessionFileSystem(root)
    const file = path.join(root, 'logs', 'session.jsonl')

    await expect(adapter.writeFile(file, 'header\n')).resolves.toMatchObject({ ok: true })
    await expect(adapter.appendFile(file, 'entry\n')).resolves.toMatchObject({ ok: true })
    await expect(adapter.readTextFile(file)).resolves.toEqual({ ok: true, value: 'header\nentry\n' })

    expect(fs.statSync(root).mode & 0o777).toBe(0o700)
    expect(fs.statSync(path.dirname(file)).mode & 0o777).toBe(0o700)
    expect(fs.statSync(file).mode & 0o777).toBe(0o600)
  })

  it('rejects lexical escapes instead of addressing arbitrary files', async () => {
    const root = makeRoot()
    const outside = path.join(path.dirname(root), `${path.basename(root)}-outside.txt`)
    const adapter = new SecureSessionFileSystem(root)

    const result = await adapter.writeFile(outside, 'no')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('permission_denied')
    expect(fs.existsSync(outside)).toBe(false)
  })

  it('never follows a symlink leaf for read, overwrite, rename or delete', async () => {
    const root = makeRoot()
    const outside = path.join(path.dirname(root), `${path.basename(root)}-outside.txt`)
    const link = path.join(root, 'linked.jsonl')
    fs.writeFileSync(outside, 'outside', 'utf8')
    fs.symlinkSync(outside, link)
    const adapter = new SecureSessionFileSystem(root)

    for (const result of [
      await adapter.readTextFile(link),
      await adapter.writeFile(link, 'overwrite'),
      await adapter.appendFile(link, 'append'),
      await adapter.remove(link, { force: true }),
    ]) {
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error.code).toBe('permission_denied')
    }
    expect(fs.readFileSync(outside, 'utf8')).toBe('outside')
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true)
    fs.rmSync(outside, { force: true })
  })

  it('reads only the requested prefix when Pi asks for a header line', async () => {
    const root = makeRoot()
    const adapter = new SecureSessionFileSystem(root)
    const file = path.join(root, 'many.jsonl')
    await adapter.writeFile(file, 'header\nline-1\nline-2\n')

    await expect(adapter.readTextLines(file, { maxLines: 1 }))
      .resolves.toEqual({ ok: true, value: ['header'] })
  })
})

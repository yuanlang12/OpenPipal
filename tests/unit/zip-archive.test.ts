/**
 * zipDirectory：用系统 bsdtar 打 zip（不依赖 zip 命令，macOS / Windows 通用）。
 * 条目列表也走 bsdtar（tar -tf 能读 zip），测试本身不依赖 unzip。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'
import { zipDirectory, listZipEntries, systemTarPath } from '../../src/main/zip-archive'

let tmp: string
beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'openpipal-zip-archive-'))
})
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }))

function makeTree(name: string): string {
  const dir = path.join(tmp, name)
  fs.mkdirSync(path.join(dir, 'sub'), { recursive: true })
  fs.writeFileSync(path.join(dir, '[Content_Types].xml'), '<Types/>')
  fs.writeFileSync(path.join(dir, 'a.txt'), 'a')
  fs.writeFileSync(path.join(dir, 'sub', 'b.txt'), 'b')
  return dir
}

describe('zipDirectory（系统 bsdtar）', () => {
  it('systemTarPath 按平台给绝对路径，不吃 PATH', () => {
    expect(systemTarPath('darwin')).toBe('/usr/bin/tar')
    expect(systemTarPath('win32')).toBe(
      path.win32.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe')
    )
  })

  it('nested：包内顶层是目录名，路径相对，不含绝对源路径', async () => {
    const dir = makeTree('kit')
    const out = path.join(tmp, 'kit.zip')
    await zipDirectory(dir, out, 'nested')
    const entries = await listZipEntries(out)
    expect(entries).toContain('kit/a.txt')
    expect(entries).toContain('kit/sub/b.txt')
    expect(entries.some((e) => e.includes(tmp))).toBe(false)
  })

  it('flat：内容落在 zip 根，没有 "./" 前缀，[Content_Types].xml 排第一（OOXML 语义）', async () => {
    const dir = makeTree('deck')
    const out = path.join(tmp, 'deck.pptx')
    await zipDirectory(dir, out, 'flat')
    const entries = await listZipEntries(out)
    expect(entries[0]).toBe('[Content_Types].xml')
    expect(entries).toContain('a.txt')
    expect(entries).toContain('sub/b.txt')
    expect(entries.some((e) => e.startsWith('./'))).toBe(false)
    expect(fs.readFileSync(out).subarray(0, 2).toString('latin1')).toBe('PK')
  })

  it('重复打包不追加：第二次的包只反映第二次的源', async () => {
    const dir = makeTree('idem')
    const out = path.join(tmp, 'idem.zip')
    await zipDirectory(dir, out, 'nested')
    fs.unlinkSync(path.join(dir, 'a.txt'))
    await zipDirectory(dir, out, 'nested')
    expect(await listZipEntries(out)).not.toContain('idem/a.txt')
  })

  it('flat 遇到空目录直接报错，不产出空包', async () => {
    const dir = path.join(tmp, 'empty')
    fs.mkdirSync(dir)
    const out = path.join(tmp, 'empty.zip')
    await expect(zipDirectory(dir, out, 'flat')).rejects.toThrow()
    expect(fs.existsSync(out)).toBe(false)
  })
})

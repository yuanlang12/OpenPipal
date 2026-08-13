/**
 * 分享打包（W5 条款C）：exportZip 把产物文件夹用系统 zip 打成单文件落 outputs/。
 *
 * 依赖系统 /usr/bin/zip（不新增 npm 依赖）；无 zip 环境时产包用例跳过（契约允许"无环境则跳过"），
 * 但白名单/sanitize 这类纯校验用例始终运行。os.homedir() 在 POSIX 优先读 HOME——模块导入前劫持，
 * 让 OUTPUTS_ROOT 与白名单三根都落到临时目录。
 */
import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'
import { execFileSync } from 'child_process'

// 必须在 import 模块前设 HOME，让 OUTPUTS_ROOT / 白名单根都指向临时目录
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'openpipal-zip-export-'))
process.env.HOME = TMP

const OPENPIPAL = path.join(TMP, '.openpipal')
const OUTPUTS = path.join(OPENPIPAL, 'outputs')
const DS_ROOT = path.join(OPENPIPAL, 'design-systems')

const { exportZip } = await import('../../src/main/dc-export')

function hasZip(): boolean {
  try {
    execFileSync('zip', ['--version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}
const zipAvailable = hasZip()

function hasUnzip(): boolean {
  try {
    execFileSync('unzip', ['-v'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

// 列出 zip 包内条目：优先 unzip -l，否则退化为扫原始字节（zip 头里文件名是明文）
function zipEntries(zipPath: string): string {
  if (hasUnzip()) return execFileSync('unzip', ['-l', zipPath], { encoding: 'utf8' })
  return fs.readFileSync(zipPath).toString('latin1')
}

describe('exportZip 分享打包', () => {
  ;(zipAvailable ? it : it.skip)(
    '把白名单内的设计系统文件夹打成 zip，落 outputs/，包内含预期文件且用相对路径',
    async () => {
      const kit = path.join(DS_ROOT, 'my-kit')
      fs.mkdirSync(path.join(kit, 'nested'), { recursive: true })
      fs.writeFileSync(path.join(kit, 'SKILL.md'), '# kit\n')
      fs.writeFileSync(path.join(kit, '_ds_manifest.json'), '{"name":"my-kit"}')
      fs.writeFileSync(path.join(kit, 'nested', 'tokens.json'), '{"color":"#000"}')

      const res = await exportZip(kit, 'My Kit')
      expect(res.ok).toBe(true)
      expect(res.path).toBe(path.join(OUTPUTS, 'My Kit.zip'))
      expect(fs.existsSync(res.path!)).toBe(true)
      expect(fs.statSync(res.path!).size).toBeGreaterThan(0)

      const listing = zipEntries(res.path!)
      // 包内路径以 <basename>/ 打头（相对，不含绝对路径），且含嵌套文件
      expect(listing).toContain('my-kit/SKILL.md')
      expect(listing).toContain('my-kit/_ds_manifest.json')
      expect(listing).toContain('my-kit/nested/tokens.json')
      // 不得把绝对源路径打进包
      expect(listing).not.toContain(kit)
    },
    30000
  )

  ;(zipAvailable ? it : it.skip)(
    '重复导出同名幂等：不追加，第二次内容等于第二次源',
    async () => {
      const kit = path.join(DS_ROOT, 'idem')
      fs.mkdirSync(kit, { recursive: true })
      fs.writeFileSync(path.join(kit, 'a.txt'), 'a')
      const first = await exportZip(kit, 'idem-pack')
      expect(first.ok).toBe(true)
      fs.writeFileSync(path.join(kit, 'b.txt'), 'b')
      const second = await exportZip(kit, 'idem-pack')
      expect(second.ok).toBe(true)
      const listing = zipEntries(second.path!)
      expect(listing).toContain('idem/a.txt')
      expect(listing).toContain('idem/b.txt')
    },
    30000
  )

  it('白名单外的源目录被拒（不打包 ~/.ssh 之类）', async () => {
    const outside = path.join(TMP, 'evil-outside')
    fs.mkdirSync(outside, { recursive: true })
    fs.writeFileSync(path.join(outside, 'secret'), 'x')
    const res = await exportZip(outside, 'leak')
    expect(res.ok).toBe(false)
    expect(res.error).toBeTruthy()
    expect(fs.existsSync(path.join(OUTPUTS, 'leak.zip'))).toBe(false)
  })

  it('用 .. 相对路径逃出白名单也被拒（resolve 后校验）', async () => {
    const escape = path.join(DS_ROOT, 'ok', '..', '..', '..', 'evil-outside')
    const res = await exportZip(escape, 'leak2')
    expect(res.ok).toBe(false)
    expect(res.error).toBeTruthy()
  })

  it('outName sanitize 防穿越：斜杠/../ 被清洗，产物仍落在 outputs 根内', async () => {
    if (!zipAvailable) return
    const kit = path.join(DS_ROOT, 'san')
    fs.mkdirSync(kit, { recursive: true })
    fs.writeFileSync(path.join(kit, 'f.txt'), 'f')
    const res = await exportZip(kit, '../../../../etc/passwd')
    expect(res.ok).toBe(true)
    // 产物父目录必须恰是 outputs 根——没有逃到上级
    expect(path.dirname(res.path!)).toBe(OUTPUTS)
    expect(res.path!.endsWith('.zip')).toBe(true)
    expect(fs.existsSync(res.path!)).toBe(true)
  })

  it('源目录不存在时优雅返回 ok:false，不抛', async () => {
    const missing = path.join(DS_ROOT, 'does-not-exist')
    const res = await exportZip(missing, 'nope')
    expect(res.ok).toBe(false)
    expect(res.error).toBeTruthy()
  })

  it('空 sourceDir 被拒', async () => {
    const res = await exportZip('', 'empty')
    expect(res.ok).toBe(false)
    expect(res.error).toBeTruthy()
  })
})

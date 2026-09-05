/**
 * 从 resources/icon.icns 生成 Windows 用的两个 .ico：
 *   resources/icon.ico            安装包 / 任务栏 / 快捷方式（16 24 32 48 64 128 256）
 *   resources/tray/openpipal.ico  托盘（16 20 24 32 48，Windows 按 DPI 自己挑）
 * ICO 容器直接装 PNG（Vista 起支持），不走 BMP 那套。在 macOS 上跑：iconutil 拆 icns，sharp 缩放。
 * 重新生成: node scripts/render-windows-icons.mjs
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const ICNS = join(ROOT, 'resources/icon.icns')

function packIco(images) {
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0)
  header.writeUInt16LE(1, 2)
  header.writeUInt16LE(images.length, 4)
  const dir = Buffer.alloc(16 * images.length)
  let offset = header.length + dir.length
  images.forEach(({ size, buf }, i) => {
    const o = i * 16
    dir.writeUInt8(size >= 256 ? 0 : size, o) // 0 表示 256
    dir.writeUInt8(size >= 256 ? 0 : size, o + 1)
    dir.writeUInt8(0, o + 2) // 无调色板
    dir.writeUInt8(0, o + 3) // 保留位
    dir.writeUInt16LE(1, o + 4) // 颜色平面
    dir.writeUInt16LE(32, o + 6) // 位深
    dir.writeUInt32LE(buf.length, o + 8)
    dir.writeUInt32LE(offset, o + 12)
    offset += buf.length
  })
  return Buffer.concat([header, dir, ...images.map((p) => p.buf)])
}

async function main() {
  const tmp = mkdtempSync(join(tmpdir(), 'openpipal-icons-'))
  const iconset = join(tmp, 'icon.iconset')
  execFileSync('iconutil', ['-c', 'iconset', ICNS, '-o', iconset])
  const master = readFileSync(join(iconset, 'icon_512x512@2x.png')) // 1024px 母版
  const render = (sizes) =>
    Promise.all(sizes.map(async (size) => ({ size, buf: await sharp(master).resize(size, size).png().toBuffer() })))
  writeFileSync(join(ROOT, 'resources/icon.ico'), packIco(await render([16, 24, 32, 48, 64, 128, 256])))
  writeFileSync(join(ROOT, 'resources/tray/openpipal.ico'), packIco(await render([16, 20, 24, 32, 48])))
  rmSync(tmp, { recursive: true, force: true })
  console.log('wrote resources/icon.ico and resources/tray/openpipal.ico')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})

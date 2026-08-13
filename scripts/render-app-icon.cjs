/**
 * resources/icon.svg → resources/icon.icns
 * 用仓库自带的 Playwright Chromium 渲出带透明通道的 1024 PNG，
 * 再走 macOS 原生 sips + iconutil 生成 icns（electron-builder 自动识别
 * buildResources/icon.icns，无需改 electron-builder.yml）。
 */
const { chromium } = require('playwright')
const { execSync } = require('child_process')
const { readFileSync, mkdirSync, rmSync } = require('fs')
const { join } = require('path')

const ROOT = join(__dirname, '..')
const SVG = readFileSync(join(ROOT, 'resources/icon.svg'), 'utf-8')

async function main() {
  const browser = await chromium.launch()
  const page = await browser.newPage({ viewport: { width: 1024, height: 1024 }, deviceScaleFactor: 1 })
  await page.setContent(`<body style="margin:0;background:transparent">${SVG}</body>`)
  const master = join(ROOT, 'resources/icon-1024.png')
  await page.screenshot({ path: master, omitBackground: true })
  await browser.close()

  const iconset = join(ROOT, 'resources/icon.iconset')
  rmSync(iconset, { recursive: true, force: true })
  mkdirSync(iconset)
  const sizes = [
    ['icon_16x16.png', 16], ['icon_16x16@2x.png', 32],
    ['icon_32x32.png', 32], ['icon_32x32@2x.png', 64],
    ['icon_128x128.png', 128], ['icon_128x128@2x.png', 256],
    ['icon_256x256.png', 256], ['icon_256x256@2x.png', 512],
    ['icon_512x512.png', 512], ['icon_512x512@2x.png', 1024]
  ]
  for (const [name, px] of sizes) {
    execSync(`sips -z ${px} ${px} "${master}" --out "${join(iconset, name)}"`, { stdio: 'pipe' })
  }
  execSync(`iconutil -c icns "${iconset}" -o "${join(ROOT, 'resources/icon.icns')}"`)
  rmSync(iconset, { recursive: true })
  rmSync(master)
  console.log('resources/icon.icns generated')
}

main().catch((err) => { console.error(err); process.exit(1) })

/**
 * 生成 openpipal-extension/icons/icon{16,48,128}.png（几何与 resources/icon.svg 同源）
 *
 * 之前这三个 PNG 是手工放进去的，没有生成路径——改标识时必然漏掉，然后浏览器
 * 里挂着一个旧图标没人发现。现在和 icns、托盘图同源同脚本，改一处全跟着变。
 *
 * 重新生成：node scripts/render-extension-icons.cjs
 */
const { chromium } = require('playwright')
const { mkdirSync } = require('fs')
const { join } = require('path')

const ROOT = join(__dirname, '..')
const OUT = join(ROOT, 'openpipal-extension/icons')
// 16px 下瓷砖边距会把标识挤到几乎看不清，所以小尺寸放大标识、压缩边距。
// 光学尺寸：小图不是大图的等比缩小，是重新配比。
const SIZES = [
  { px: 16, tileInset: 0, markScale: 1.35 },
  { px: 48, tileInset: 60, markScale: 1.1 },
  { px: 128, tileInset: 100, markScale: 1 }
]

;(async () => {
  mkdirSync(OUT, { recursive: true })
  const browser = await chromium.launch()
  for (const { px, tileInset, markScale } of SIZES) {
    const tile = 1024 - tileInset * 2
    const markBox = 560 * markScale
    const markOffset = (1024 - markBox) / 2
    const svg = `<svg width="${px}" height="${px}" viewBox="0 0 1024 1024" fill="none" xmlns="http://www.w3.org/2000/svg">
        <rect x="${tileInset}" y="${tileInset}" width="${tile}" height="${tile}" rx="${185 * tile / 824}" fill="#FAF8F3"/>
        <g transform="translate(${markOffset} ${markOffset}) scale(${markBox / 64})">
          <rect x="8" y="8" width="36" height="48" fill="#1F2520"/>
          <rect x="50" y="14" width="6" height="36" fill="#6F864F"/>
        </g>
      </svg>`
    const page = await browser.newPage({ viewport: { width: px, height: px }, deviceScaleFactor: 1 })
    await page.setContent(`<html><body style="margin:0">${svg}</body></html>`)
    await page.screenshot({ path: join(OUT, `icon${px}.png`) })
    await page.close()
    console.log(`rendered icon${px}.png`)
  }
  await browser.close()
})()

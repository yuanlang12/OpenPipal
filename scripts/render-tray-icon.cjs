/**
 * 官方 mark → macOS 菜单栏托盘 template 图（纯黑 + 透明,系统自动适配深浅色）。
 * 产物: resources/tray/openpipalTemplate.png (20x15) + @2x (40x30)。
 * 文件名以 Template 结尾 → Electron nativeImage 自动置 isTemplateImage。
 * 重新生成: node scripts/render-tray-icon.cjs
 */
const { chromium } = require('playwright')
const { mkdirSync } = require('fs')
const { join } = require('path')

const ROOT = join(__dirname, '..')
// mark 几何取自 resources/icon.svg 的官方 64 视窗版本,填色改纯黑
const SVG = `<svg width="20" height="15" viewBox="6 12 52 40" fill="none" xmlns="http://www.w3.org/2000/svg">
  <rect x="8" y="8" width="36" height="48" fill="#000"/>
  <rect x="50" y="14" width="6" height="36" fill="#000"/>
</svg>`

async function main() {
  const outDir = join(ROOT, 'resources/tray')
  mkdirSync(outDir, { recursive: true })
  const browser = await chromium.launch()
  for (const [file, dsf] of [['openpipalTemplate.png', 1], ['openpipalTemplate@2x.png', 2]]) {
    const page = await browser.newPage({ viewport: { width: 20, height: 15 }, deviceScaleFactor: dsf })
    await page.setContent(`<body style="margin:0;background:transparent">${SVG}</body>`)
    await page.screenshot({ path: join(outDir, file), omitBackground: true })
    await page.close()
    console.log('rendered', file)
  }
  await browser.close()
}

main()

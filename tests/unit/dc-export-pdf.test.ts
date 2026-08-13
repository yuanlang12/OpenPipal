/**
 * PDF 直出主逻辑（W3 条款3）：exportArtifactPdf 隐藏窗口渲染 doc-page 文档 → printToPDF → outputs/<title>.pdf。
 *
 * 真渲染需要 electron BrowserWindow。纯 node（vitest）下 require('electron') 返回可执行文件路径字符串，
 * BrowserWindow 不可用 → 真渲染冒烟跳过（契约允许"无窗口环境则跳过并注明"）；
 * 无窗口时另断言优雅降级（返回 ok:false，不抛、不写文件）。
 */
import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'
import { createRequire } from 'module'

// os.homedir() 在 POSIX 优先读 HOME——模块导入前劫持，让 OUTPUTS_ROOT 落到临时目录
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'openpipal-pdf-export-'))
process.env.HOME = TMP

const { exportArtifactPdf } = await import('../../src/main/dc-export')

let BrowserWindow: unknown
try {
  const req = createRequire(import.meta.url)
  const el = req('electron') as any
  BrowserWindow = el && typeof el === 'object' ? el.BrowserWindow : undefined
} catch {
  BrowserWindow = undefined
}
const hasWindow = typeof BrowserWindow === 'function'

describe('exportArtifactPdf 主逻辑', () => {
  it('无窗口环境优雅降级：返回 ok:false + error，不抛异常、不落文件', async () => {
    if (hasWindow) return // 有窗口时此断言不适用（走真渲染路径）
    const res = await exportArtifactPdf('降级用例', '<doc-page><h1>x</h1></doc-page>')
    expect(res.ok).toBe(false)
    expect(res.error).toBeTruthy()
    expect(fs.existsSync(path.join(TMP, '.openpipal', 'outputs', '降级用例.pdf'))).toBe(false)
  })

  ;(hasWindow ? it : it.skip)(
    '真起隐藏窗口渲最小 doc-page 文档 → 落 PDF 且 >10KB',
    async () => {
      const body = 'Lorem ipsum dolor sit amet, consectetur adipiscing elit. '.repeat(300)
      const content = [
        '<!doctype html><html><head><meta charset="utf-8">',
        '<style>doc-page:not(:defined){visibility:hidden}</style></head><body>',
        '<doc-page size="letter" margin="0.75in">',
        '<h1>Self-check Doc</h1>',
        `<p>${body}</p>`,
        '</doc-page>',
        '<script src="./doc-page.js"></script>',
        '</body></html>'
      ].join('')
      const res = await exportArtifactPdf('pdf-smoke', content)
      expect(res.ok).toBe(true)
      expect(res.path).toBeTruthy()
      const stat = fs.statSync(res.path!)
      expect(stat.size).toBeGreaterThan(10 * 1024)
    },
    30000
  )
})

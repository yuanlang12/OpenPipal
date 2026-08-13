/**
 * 文本重叠检测 lint 本体 — 纯页面测试（不走 electron/dev server）。
 *
 * 覆盖 render_artifact 自检新增的"文本重叠"检测（src/main/overlap-lint.ts）：
 *   ①两段透明背景文本绝对定位重叠 → 命中 1 条"文本重叠"
 *   ②不透明背景 chip 压在文本上（合法设计）→ 不命中
 *   ③opacity:0.5 的转场文本（动画中间态）与正文重叠 → 不命中
 */

import { test, expect } from '@playwright/test'
import { OVERLAP_LINT_JS } from '../../src/main/overlap-lint'

test.describe('overlap-lint', () => {
  test('两段透明背景文本重叠 → 命中 1 条', async ({ page }) => {
    await page.setContent(`<!DOCTYPE html><html><body>
      <div style="position:absolute; left:20px; top:20px; width:200px; height:30px; font-size:14px;">1a / 1b / 1c 指给我</div>
      <div style="position:absolute; left:40px; top:25px; width:200px; height:30px; font-size:14px;">方向 A · 名称</div>
    </body></html>`)
    const hits = (await page.evaluate(OVERLAP_LINT_JS)) as string[]
    expect(hits.length).toBe(1)
    expect(hits[0]).toContain('文本重叠')
  })

  test('不透明背景 chip 压在文本上 → 不命中', async ({ page }) => {
    await page.setContent(`<!DOCTYPE html><html><body>
      <div style="position:absolute; left:20px; top:20px; width:200px; height:30px; font-size:14px;">Some label text here</div>
      <div style="position:absolute; left:30px; top:22px; width:60px; height:20px; background:#222222; color:#fff; font-size:12px;">NEW</div>
    </body></html>`)
    const hits = (await page.evaluate(OVERLAP_LINT_JS)) as string[]
    expect(hits.length).toBe(0)
  })

  test('opacity:0.5 转场文本与正文重叠 → 不命中', async ({ page }) => {
    await page.setContent(`<!DOCTYPE html><html><body>
      <div style="position:absolute; left:20px; top:20px; width:200px; height:30px; font-size:14px;">Real content text</div>
      <div style="position:absolute; left:30px; top:22px; width:200px; height:30px; font-size:14px; opacity:0.5;">Fading old text</div>
    </body></html>`)
    const hits = (await page.evaluate(OVERLAP_LINT_JS)) as string[]
    expect(hits.length).toBe(0)
  })
})

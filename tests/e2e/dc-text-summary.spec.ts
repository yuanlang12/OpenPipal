/**
 * 页面文本摘要提取 — 纯页面测试（不走 electron/dev server，同 overlap-lint.spec.ts 风格）。
 *
 * 覆盖 render_artifact 自检新增的"页面文本摘要"（src/main/dc-text-summary.ts）：
 *   ① canvas 多方向稿（Clio Directions.dc.html，3 个 data-screen-label frame）→ 按 frame 分组
 *   ② 无 data-screen-label → 兜底取整页正文（单条，label 为 null）
 *   ③ shadowRoot 内文本（doc-page 等 Web Component 风格）→ innerText 走不到，需补取
 */

import { test, expect } from '@playwright/test'
import { readFileSync } from 'fs'
import { join } from 'path'
import { PAGE_TEXT_SUMMARY_JS } from '../../src/main/dc-text-summary'

type Summary = { frames: Array<{ label: string | null; text: string }> }

const DIRECTIONS = readFileSync(join(__dirname, '../fixtures/dc/Clio Directions.dc.html'), 'utf8')

test.describe('dc-text-summary', () => {
  test('Directions 画板稿：按 data-screen-label 分 3 帧，label + 独有正文都在', async ({ page }) => {
    await page.setContent(DIRECTIONS)
    const result = (await page.evaluate(PAGE_TEXT_SUMMARY_JS)) as Summary

    expect(result.frames.length).toBe(3)
    expect(result.frames.map((f) => f.label)).toEqual([
      'Direction B — Map',
      'Direction A — Map',
      'Direction C — Map'
    ])

    // 拼装与 pi-tools.ts render_artifact 一致的【】格式，断言分组标签 + 正文都在
    const rendered = result.frames.map((f, i) => `【${f.label || `#${i + 1}`}】${f.text.slice(0, 400)}`).join('\n')
    expect(rendered).toContain('【Direction B — Map】')
    expect(rendered).toContain('【Direction A — Map】')
    expect(rendered).toContain('【Direction C — Map】')

    // 各帧正文含各自方向独有文案——核对"内容正确"用，不止"渲染无报错"
    expect(result.frames[0].text).toContain('Explore children') // Frame B 独有按钮
    expect(result.frames[1].text).toContain('Drill down') // Frame A 独有按钮
    expect(result.frames[2].text).toContain('Generate bulk SEO spam') // Frame C 独有告警文案
  })

  test('无 data-screen-label → 兜底取整页正文（单条，label 为 null）', async ({ page }) => {
    await page.setContent(
      `<!DOCTYPE html><html><body><div id="dc-root"><h1>Hello</h1><p>Plain fallback body text.</p></div></body></html>`
    )
    const result = (await page.evaluate(PAGE_TEXT_SUMMARY_JS)) as Summary

    expect(result.frames.length).toBe(1)
    expect(result.frames[0].label).toBeNull()
    expect(result.frames[0].text).toContain('Plain fallback body text')
  })

  test('shadowRoot 内文本（doc-page 风格）能被补取', async ({ page }) => {
    await page.setContent(`<!DOCTYPE html><html><body>
      <div id="dc-root">
        <div id="host"></div>
        <script>
          const host = document.getElementById('host');
          const root = host.attachShadow({ mode: 'open' });
          root.innerHTML = '<div class="sheet">SHADOW_MARKER text inside shadow dom</div>';
        </script>
      </div>
    </body></html>`)
    const result = (await page.evaluate(PAGE_TEXT_SUMMARY_JS)) as Summary

    expect(result.frames.length).toBe(1)
    expect(result.frames[0].text).toContain('SHADOW_MARKER')
  })
})

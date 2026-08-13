/**
 * Phase 4 集成单测 —— 真实 classifyToolRisk 对浏览器工具的站点轴分级。
 * 验证"读放行 / 未知站点写需确认"这条 pi-security → browser-policy-store → browser-policy 链。
 */
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { classifyToolRisk } from '../../src/main/pi-security.ts'

test('浏览器只读工具 → safe(永远放行)', () => {
  assert.equal(classifyToolRisk('browser_read_page', {}).level, 'safe')
  assert.equal(classifyToolRisk('browser_list_tabs', {}).level, 'safe')
  assert.equal(classifyToolRisk('browser_screenshot', {}).level, 'safe')
})

test('未知站点的浏览器写工具 → needs_confirmation(站点轴默认确认)', () => {
  // unknown-xyz-uniq.com 不会在任何用户的持久 allow/blocklist 里
  const r = classifyToolRisk('browser_navigate', { url: 'https://unknown-xyz-uniq.example' })
  assert.equal(r.level, 'needs_confirmation')
})

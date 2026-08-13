/**
 * Phase 4 集成单测 —— 真实 createSecurityHook 的"确认→授权→同站点复用"行为。
 *
 * 这是"丝滑 + 安全"平衡的核心断言:
 *  - 未知站点的写操作 → 弹一次确认
 *  - 用户授权该 host(grantSessionHost,模拟点"本次会话允许")后 → 同站点后续写操作不再弹
 *  - 读操作 → 永不弹
 *
 * 测试态没调 setInlinePermissionSender,故 hook 走传入的 onConfirmation handler(而非 IPC),
 * 我们用计数器观察"弹了几次"。
 */
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { createSecurityHook } from '../../src/main/pi-security.ts'
import { grantSessionHost, clearSessionGrants } from '../../src/main/browser-policy-store.ts'

function ctx(toolName: string, args: Record<string, unknown>) {
  return { toolCall: { name: toolName }, args } as any
}

test('写操作:未知站点弹一次确认;授权该 host 后同站点不再弹(站点轴丝滑复用)', async () => {
  const conv = 'hook-flow-1'
  clearSessionGrants(conv)
  let confirms = 0
  const hook = createSecurityHook(conv, async () => { confirms++; return true })

  // 1) 未授权 → 弹确认(handler 返回 true 即批准 → 放行)
  const r1 = await hook(ctx('browser_navigate', { url: 'https://hookflow-uniq.example' }))
  assert.equal(confirms, 1, '首次未知站点应弹一次确认')
  assert.equal(r1, undefined, '批准后应放行')

  // 2) 模拟用户点了"本次会话允许" → 站点授权
  grantSessionHost(conv, 'hookflow-uniq.example')

  // 3) 同站点(含子路径)再次写操作 → 不应再弹
  const r2 = await hook(ctx('browser_navigate', { url: 'https://hookflow-uniq.example/p2' }))
  assert.equal(confirms, 1, '同站点复用不应再弹确认')
  assert.equal(r2, undefined, '授权站点直接放行')

  // 4) 另一个未授权站点 → 仍然弹
  const r3 = await hook(ctx('browser_click', { selector: '#x' }))
  // click 的 host 取活动标签(测试态为空)→ confirm;handler 批准
  assert.equal(r3, undefined)
  clearSessionGrants(conv)
})

test('读操作永不弹确认(零打断)', async () => {
  let confirms = 0
  const hook = createSecurityHook('hook-flow-2', async () => { confirms++; return true })
  await hook(ctx('browser_read_page', {}))
  await hook(ctx('browser_list_tabs', {}))
  await hook(ctx('browser_screenshot', {}))
  assert.equal(confirms, 0, '读操作不应触发任何确认')
})

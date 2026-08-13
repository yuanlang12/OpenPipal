/**
 * Phase 4 单测 —— 站点轴状态层(host 解析 + 本对话授权复用),纯内存部分。
 * 不碰持久 allowlist/blocklist(那会写用户 home),只测会话内逻辑。
 */
import { test } from 'vitest'
import assert from 'node:assert/strict'
import {
  setActiveBrowserUrl,
  replaceBrowserTabUrls,
  setBrowserTabUrl,
  targetHostForCommand,
  decideForCommand,
  grantSessionHost,
  clearSessionGrants
} from '../../src/main/browser-policy-store.ts'

test('navigate 的目标 host 取 args.url(去向)', () => {
  assert.equal(targetHostForCommand('browser_navigate', { url: 'https://example.com/x?y=1' }), 'example.com')
})

test('click/fill 的目标 host 取当前活动标签', () => {
  setActiveBrowserUrl('https://oa.corp.com/inbox')
  assert.equal(targetHostForCommand('browser_click', { selector: '#b' }), 'oa.corp.com')
})

test('显式 tabId 不能借用另一活动标签的站点授权', () => {
  const conv = 'conv-explicit-tab-mismatch'
  clearSessionGrants(conv)
  setActiveBrowserUrl('https://trusted-tab.example/inbox')
  grantSessionHost(conv, 'trusted-tab.example')

  const result = decideForCommand('browser_click', { selector: '#buy', tabId: 4242 }, conv)
  assert.equal(result.host, '')
  assert.equal(result.decision, 'confirm')
  clearSessionGrants(conv)
})

test('显式 tabId 使用该标签自己的 URL 快照，同时保留合法定向自动化', () => {
  const conv = 'conv-explicit-tab-bound'
  clearSessionGrants(conv)
  replaceBrowserTabUrls([
    { id: 11, url: 'https://trusted-tab.example/inbox' },
    { id: 22, url: 'https://target-tab.example/checkout' }
  ])
  setActiveBrowserUrl('https://trusted-tab.example/inbox', 11)
  grantSessionHost(conv, 'trusted-tab.example')

  const beforeGrant = decideForCommand('browser_click', { selector: '#buy', tabId: 22 }, conv)
  assert.deepEqual(beforeGrant, { host: 'target-tab.example', decision: 'confirm' })

  grantSessionHost(conv, 'target-tab.example')
  const afterGrant = decideForCommand('browser_click', { selector: '#buy', tabId: 22 }, conv)
  assert.deepEqual(afterGrant, { host: 'target-tab.example', decision: 'allow' })
  clearSessionGrants(conv)
  replaceBrowserTabUrls([])
})

test('授权后标签切站时仍保留原 host 绑定，交给扩展拒绝错站执行', () => {
  const args = { selector: '#buy', tabId: 33 }
  replaceBrowserTabUrls([{ id: 33, url: 'https://approved-target.example/checkout' }])
  const authorized = decideForCommand('browser_click', args)
  assert.equal(authorized.host, 'approved-target.example')

  setBrowserTabUrl(33, 'https://changed-after-approval.example/account')
  assert.equal(targetHostForCommand('browser_click', args), 'approved-target.example')
  replaceBrowserTabUrls([])
})

test('未授权站点写操作→confirm;本对话授权后→allow;换对话不复用(站点轴核心)', () => {
  const conv = 'conv-store-1'
  clearSessionGrants(conv)
  setActiveBrowserUrl('https://shop.uniq-test.com/cart')
  assert.equal(decideForCommand('browser_click', { selector: '#buy' }, conv).decision, 'confirm')
  grantSessionHost(conv, 'shop.uniq-test.com')
  assert.equal(decideForCommand('browser_click', { selector: '#buy' }, conv).decision, 'allow')
  assert.equal(decideForCommand('browser_click', { selector: '#buy' }, 'conv-other').decision, 'confirm')
  clearSessionGrants(conv)
})

test('授权父域后,同站点子域的 navigate 也复用(子域命中)', () => {
  const conv = 'conv-store-2'
  grantSessionHost(conv, 'corp-uniq-test.com')
  assert.equal(
    decideForCommand('browser_navigate', { url: 'https://mail.corp-uniq-test.com/x' }, conv).decision,
    'allow'
  )
  clearSessionGrants(conv)
})

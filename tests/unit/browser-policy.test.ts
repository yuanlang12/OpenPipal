/**
 * Phase 4 单测 —— 浏览器「站点轴」授权策略(纯逻辑)
 */
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { hostOf, hostMatches, decideBrowserAction } from '../../src/main/browser-policy.ts'

test('hostOf 从 URL 取小写 host,异常输入回空串', () => {
  assert.equal(hostOf('https://OA.Corp.com/path?x=1'), 'oa.corp.com')   // 大写归一化
  assert.equal(hostOf('http://localhost:3031/a'), 'localhost')           // 去端口
  assert.equal(hostOf('about:blank'), '')
  assert.equal(hostOf(undefined), '')
  assert.equal(hostOf('not a url'), '')
})

test('hostMatches 支持精确 + 父域 + *.写法', () => {
  assert.ok(hostMatches('example.com', 'example.com'))
  assert.ok(hostMatches('a.example.com', 'example.com'))   // 父域命中子域
  assert.ok(hostMatches('a.example.com', '*.example.com')) // 容忍通配写法
  assert.ok(!hostMatches('example.com', 'a.example.com'))  // 子域规则不命中父域
  assert.ok(!hostMatches('notexample.com', 'example.com')) // 不能被后缀骗(notexample ≠ *.example)
  assert.ok(!hostMatches('', 'example.com'))
})

const empty = { allowlist: [], blocklist: [], sessionGrants: [] }

test('默认未知站点 → confirm', () => {
  assert.equal(decideBrowserAction('shop.com', empty), 'confirm')
})

test('allowlist 命中 → allow(含子域)', () => {
  assert.equal(decideBrowserAction('mail.google.com', { ...empty, allowlist: ['google.com'] }), 'allow')
})

test('sessionGrants 命中 → allow(本对话允许)', () => {
  assert.equal(decideBrowserAction('oa.corp.com', { ...empty, sessionGrants: ['oa.corp.com'] }), 'allow')
})

test('blocklist 优先级最高 —— 即便同时在 allowlist 也 block', () => {
  assert.equal(
    decideBrowserAction('bank.com', { allowlist: ['bank.com'], blocklist: ['bank.com'], sessionGrants: ['bank.com'] }),
    'block'
  )
})

test('取不到 host(空白页)→ 保守 confirm', () => {
  assert.equal(decideBrowserAction('', { ...empty, allowlist: ['example.com'] }), 'confirm')
})

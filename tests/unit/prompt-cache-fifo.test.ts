/**
 * P3 单元测试 —— prompt 前缀缓存粘滞 + FIFO 快照的纯逻辑
 *
 * 这些是纯函数/纯数据结构测试（无 electron / 业务依赖），跑得快。
 */
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { capInsert, computeStickyInclude, resolveCacheRetentionForModel } from '../../src/main/prompt-cache-fifo.ts'

test('computeStickyInclude: 当前可用时为 true', () => {
  assert.equal(computeStickyInclude(true, undefined), true)
  assert.equal(computeStickyInclude(true, false), true)
})

test('computeStickyInclude: 当前不可用但粘滞位为 true 时仍为 true（单调，只进不出）', () => {
  assert.equal(computeStickyInclude(false, true), true)
})

test('computeStickyInclude: 从未可用过则为 false', () => {
  assert.equal(computeStickyInclude(false, undefined), false)
  assert.equal(computeStickyInclude(false, false), false)
})

test('工具组粘滞单调性：available → unavailable 后仍 include', () => {
  // 模拟 buildPiTools 里的调用序列：round1 可用，round2 不可用
  let sticky: boolean | undefined = undefined

  // round 1：扩展已连接
  const include1 = computeStickyInclude(true, sticky)
  sticky = include1
  assert.equal(include1, true)

  // round 2：扩展断连，但本会话曾经见过 → 仍 include
  const include2 = computeStickyInclude(false, sticky)
  sticky = include2
  assert.equal(include2, true)

  // round 3：继续断连，粘滞位持续为 true
  const include3 = computeStickyInclude(false, sticky)
  assert.equal(include3, true)
})

test('工具组从未出现过时不粘滞（一直 false）', () => {
  let sticky: boolean | undefined = undefined
  for (let i = 0; i < 3; i++) {
    const include = computeStickyInclude(false, sticky)
    sticky = include
    assert.equal(include, false)
  }
})

test('capInsert: 新 key 未超容量时正常写入', () => {
  const map = new Map<string, number>()
  capInsert(map, 'a', 1, 3)
  capInsert(map, 'b', 2, 3)
  assert.deepEqual([...map.entries()], [['a', 1], ['b', 2]])
})

test('capInsert: 超过 cap 后淘汰最旧的 key（FIFO）', () => {
  const map = new Map<string, number>()
  capInsert(map, 'a', 1, 2)
  capInsert(map, 'b', 2, 2)
  capInsert(map, 'c', 3, 2) // 超容量 → 淘汰 'a'
  assert.equal(map.has('a'), false)
  assert.equal(map.get('b'), 2)
  assert.equal(map.get('c'), 3)
  assert.equal(map.size, 2)
})

test('capInsert: 更新已存在的 key 不触发淘汰、也不改变其插入顺序', () => {
  const map = new Map<string, number>()
  capInsert(map, 'a', 1, 2)
  capInsert(map, 'b', 2, 2)
  capInsert(map, 'a', 99, 2) // 更新已存在的 key，容量仍是 2，不应淘汰任何 key
  assert.equal(map.size, 2)
  assert.equal(map.get('a'), 99)
  assert.equal(map.get('b'), 2)
  // 插入顺序不变：'a' 仍是最先被插入的 key（下一次淘汰仍应先淘汰 'a'）
  capInsert(map, 'c', 3, 2)
  assert.equal(map.has('a'), false)
  assert.equal(map.has('b'), true)
  assert.equal(map.has('c'), true)
})

test('capInsert: 上限 100 的场景（模拟工具粘滞 map 上限）', () => {
  const map = new Map<string, { browser?: boolean; subagent?: boolean }>()
  for (let i = 0; i < 105; i++) {
    capInsert(map, `conv-${i}`, { browser: true }, 100)
  }
  assert.equal(map.size, 100)
  // 最早的 5 个应已被淘汰
  assert.equal(map.has('conv-0'), false)
  assert.equal(map.has('conv-4'), false)
  assert.equal(map.has('conv-5'), true)
  assert.equal(map.has('conv-104'), true)
})

test('workspace basePrompt 快照：命中直接复用，未命中才拼装写入', () => {
  const snapshots = new Map<string, string>()
  const key = 'ws1:conv1'

  // 未命中：模拟首次拼装
  let cached = snapshots.get(key)
  assert.equal(cached, undefined)
  const built = 'agentMd 内容 + 记忆快照'
  capInsert(snapshots, key, built, 30)

  // 命中：第二轮直接复用，即使"当前记忆"已经变化也不重算
  cached = snapshots.get(key)
  assert.equal(cached, built)
})

test('workspace basePrompt 快照：上限 30 的 FIFO 淘汰', () => {
  const snapshots = new Map<string, string>()
  for (let i = 0; i < 32; i++) {
    capInsert(snapshots, `ws:conv-${i}`, `prompt-${i}`, 30)
  }
  assert.equal(snapshots.size, 30)
  assert.equal(snapshots.has('ws:conv-0'), false)
  assert.equal(snapshots.has('ws:conv-1'), false)
  assert.equal(snapshots.has('ws:conv-2'), true)
  assert.equal(snapshots.has('ws:conv-31'), true)
})

// ---- P4：缓存保留时长门控 ----

test('resolveCacheRetentionForModel: Anthropic 协议(含自定义 Anthropic 端点)开 long', () => {
  assert.equal(
    resolveCacheRetentionForModel({ api: 'anthropic-messages', baseUrl: 'https://api.anthropic.com' }),
    'long'
  )
  // apiFormat=anthropic 的自定义端点——协议同源,cache_control ttl 是官方 schema,直通上游
  assert.equal(
    resolveCacheRetentionForModel({ api: 'anthropic-messages', baseUrl: 'https://some-gateway.example.com' }),
    'long'
  )
})

test('resolveCacheRetentionForModel: OpenAI 官方 URL 开 long(24h retention + prompt_cache_key)', () => {
  assert.equal(
    resolveCacheRetentionForModel({ api: 'openai-completions', baseUrl: 'https://api.openai.com/v1' }),
    'long'
  )
})

test('resolveCacheRetentionForModel: 第三方兼容网关不开——请求形状必须零变化', () => {
  // 主网关(阿里云 MaaS)、dashscope、腾讯 tokenhub 等:pi-ai 默认 compat 的
  // supportsLongCacheRetention=true,开 long 会把 prompt_cache_retention 塞进请求体
  assert.equal(
    resolveCacheRetentionForModel({
      api: 'openai-completions',
      baseUrl: 'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1'
    }),
    undefined
  )
  assert.equal(
    resolveCacheRetentionForModel({
      api: 'openai-completions',
      baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1'
    }),
    undefined
  )
})

test('resolveCacheRetentionForModel: 缺字段/空模型安全返回 undefined', () => {
  assert.equal(resolveCacheRetentionForModel(undefined), undefined)
  assert.equal(resolveCacheRetentionForModel({}), undefined)
  assert.equal(resolveCacheRetentionForModel({ api: 'openai-completions' }), undefined)
})

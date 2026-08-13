#!/usr/bin/env node
/**
 * Stage 4 E2E 自测：模拟 ACP client 跑完整流程
 *
 * 三个子测试：
 *   1. basic — 简单文本流（thinking + message chunks）
 *   2. cancel — prompt 进行中途 session/cancel
 *
 * 前提：OpenPipal 桌面端开着 (localhost:3031 listening)
 */

import { spawn } from 'node:child_process'

const proc = spawn('node', ['./dist/index.js'], { stdio: 'pipe' })

let buffer = ''
let nextId = 1
const pending = new Map()
const updates = []

proc.stdout.on('data', (d) => {
  buffer += d.toString()
  let idx
  while ((idx = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, idx)
    buffer = buffer.slice(idx + 1)
    if (!line.trim()) continue
    let msg
    try {
      msg = JSON.parse(line)
    } catch {
      console.error('[non-JSON STDOUT]', line)
      continue
    }
    if (msg.method === 'session/update') {
      updates.push(msg.params)
      continue
    }
    if (msg.id !== undefined && pending.has(msg.id)) {
      pending.get(msg.id)(msg)
      pending.delete(msg.id)
    }
  }
})

proc.stderr.on('data', (d) => process.stderr.write(`[STDERR] ${d}`))

function call(method, params, timeoutMs = 60000) {
  const id = nextId++
  proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
  return new Promise((resolve, reject) => {
    pending.set(id, resolve)
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id)
        reject(new Error(`Timeout waiting for response to ${method}`))
      }
    }, timeoutMs)
  })
}

function notify(method, params) {
  proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n')
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function summary(updateList) {
  const counts = {}
  for (const u of updateList) {
    const t = u.update?.sessionUpdate
    counts[t] = (counts[t] || 0) + 1
  }
  return counts
}

try {
  // 共享 init
  console.log('=== 1. initialize ===')
  const init = await call('initialize', { protocolVersion: 1, clientCapabilities: {} })
  if (init.error) throw new Error(`initialize: ${init.error.message}`)
  const inv = init.result?._meta?.['openpipal.io/agents']
  console.log(`  agents: ${inv?.builtins?.length || 0} builtins + ${inv?.agents?.length || 0} user`)

  // ============= TEST 1: basic 流式文本 =============
  console.log('\n=== 2. session/new (basic) ===')
  const sess1 = await call('session/new', { cwd: '/tmp/acp-test-basic', mcpServers: [] })
  if (sess1.error) throw new Error(`session/new: ${sess1.error.message}`)
  console.log(`  sessionId: ${sess1.result.sessionId}`)

  console.log('\n=== 3. basic prompt: 简短问题 ===')
  updates.length = 0
  const start1 = Date.now()
  const r1 = await call('session/prompt', {
    sessionId: sess1.result.sessionId,
    prompt: [{ type: 'text', text: '用一句话回答：1+1 等于几？' }],
  }, 60000)
  if (r1.error) throw new Error(`prompt: ${r1.error.message}`)
  const elapsed1 = ((Date.now() - start1) / 1000).toFixed(1)
  console.log(`  basic 完成 ${elapsed1}s | stopReason=${r1.result.stopReason} | updates: ${updates.length}`)
  console.log(`  分布:`, summary(updates))

  // ============= TEST 2: cancel =============
  console.log('\n=== 4. session/new (cancel test) ===')
  const sess2 = await call('session/new', { cwd: '/tmp/acp-test-cancel', mcpServers: [] })
  if (sess2.error) throw new Error(`session/new: ${sess2.error.message}`)

  console.log('\n=== 5. cancel prompt: 启动 → 1.5s 后 cancel ===')
  updates.length = 0
  const start2 = Date.now()
  // 用一个让 AI 多输出的 prompt
  const promptPromise = call('session/prompt', {
    sessionId: sess2.result.sessionId,
    prompt: [{ type: 'text', text: '请详细解释什么是函数，至少写 200 字' }],
  }, 60000)

  await sleep(1500)
  console.log(`  [1.5s 已过] 已收 ${updates.length} 条 update，发 session/cancel`)
  notify('session/cancel', { sessionId: sess2.result.sessionId })

  const r2 = await promptPromise
  if (r2.error) throw new Error(`cancel prompt: ${r2.error.message}`)
  const elapsed2 = ((Date.now() - start2) / 1000).toFixed(1)
  console.log(`  cancel 完成 ${elapsed2}s | stopReason=${r2.result.stopReason} | updates: ${updates.length}`)
  console.log(`  分布:`, summary(updates))

  // 验收判断
  const cancelOk = r2.result.stopReason === 'cancelled'
  const basicOk = r1.result.stopReason === 'end_turn'

  console.log(`\n=========== Stage 4 验收 ===========`)
  console.log(`  basic 流式聊天: ${basicOk ? '✓ PASS' : '✗ FAIL'}`)
  console.log(`  cancel 中断流: ${cancelOk ? '✓ PASS' : '✗ FAIL (got ' + r2.result.stopReason + ')'}`)
  console.log(`====================================`)

  process.exit(basicOk && cancelOk ? 0 : 1)
} catch (err) {
  console.error('E2E error:', err.message)
  process.exit(1)
} finally {
  proc.kill()
}

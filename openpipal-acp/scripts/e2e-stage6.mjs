#!/usr/bin/env node
/**
 * Stage 6 E2E: 验证 OpenPipal 特色事件 → ACP 翻译
 *
 * 策略：spawn openpipal-acp + 触发会产 visualizer 的 prompt,
 *      捕获 stdout 的 session/update,验证 _meta 字段 + markdown fallback。
 *
 * 前提:
 * - 桌面端跑着 (localhost:3031)
 * - 当前 role 能产 visualizer (默认会切到 design)
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
    try { msg = JSON.parse(line) } catch { continue }
    if (msg.method === 'session/update') {
      updates.push(msg.params.update)
      continue
    }
    if (msg.id !== undefined && pending.has(msg.id)) {
      pending.get(msg.id)(msg)
      pending.delete(msg.id)
    }
  }
})
proc.stderr.on('data', (d) => process.stderr.write(`[STDERR] ${d}`))

function call(method, params, t = 90000) {
  const id = nextId++
  proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
  return new Promise((resolve, reject) => {
    pending.set(id, resolve)
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error(`Timeout ${method}`)) } }, t)
  })
}

let pass = 0, fail = 0
function check(name, ok, detail = '') {
  if (ok) { console.log(`  ✓ ${name}`); pass++ }
  else { console.log(`  ✗ ${name} ${detail}`); fail++ }
}

try {
  console.log('=== 1. initialize ===')
  await call('initialize', { protocolVersion: 1, clientCapabilities: {} })

  console.log('\n=== 2. session/new + 切 design 角色（更可能调 visualizer）===')
  const sess = await call('session/new', { cwd: '/tmp/acp-stage6', mcpServers: [] })
  const sessionId = sess.result.sessionId
  await call('session/set_mode', { sessionId, modeId: 'design' })

  console.log('\n=== 3. prompt 触发 visualizer ===')
  updates.length = 0
  const r = await call('session/prompt', {
    sessionId,
    prompt: [{ type: 'text', text: '这是一次自动化协议测试：你必须调用 create_visualizer 工具（不要用文字描述、不要询问、不要跳过工具），内容随意——例如浅蓝色圆里一行黑字 "Stage 6 OK" 的 svg。调用完工具即可结束，无需其他解释。' }],
  }, 120000)

  if (r.error) {
    console.error('prompt 错误:', r.error)
    process.exit(1)
  }

  console.log(`\n  收到 ${updates.length} 条 update`)
  const counts = {}
  for (const u of updates) {
    counts[u.sessionUpdate] = (counts[u.sessionUpdate] || 0) + 1
  }
  console.log(`  分布:`, counts)

  // 找带 _meta.openpipal.io/* 的 update
  const openpipalMetaUpdates = updates.filter((u) =>
    u._meta && Object.keys(u._meta).some((k) => k.startsWith('openpipal.io/')),
  )
  console.log(`  带 _meta.openpipal.io 的: ${openpipalMetaUpdates.length} 条`)

  // 找 markdown fallback (含 OpenPipal 特色 emoji)
  const markdownFallbacks = updates.filter((u) =>
    u.sessionUpdate === 'agent_message_chunk' &&
    u.content?.type === 'text' &&
    /📎|📊|🧩|❓|📋|🔐/.test(u.content.text || ''),
  )
  console.log(`  带 markdown fallback (含 emoji 提示) 的: ${markdownFallbacks.length} 条`)

  // 找工具调用（visualizer 工具会触发 tool_call/update）
  const toolCalls = updates.filter((u) => u.sessionUpdate === 'tool_call')
  const toolUpdates = updates.filter((u) => u.sessionUpdate === 'tool_call_update')
  console.log(`  tool_call: ${toolCalls.length}, tool_call_update: ${toolUpdates.length}`)

  // 验收
  check('收到至少一个 update', updates.length > 0)
  check('收到 tool_call (说明工具调用)', toolCalls.length > 0)
  check('收到 tool_call_update (工具完成)', toolUpdates.length > 0)
  check('收到 _meta.openpipal.io/* 透传 (visualizer/artifact 等)', openpipalMetaUpdates.length > 0,
    openpipalMetaUpdates.length === 0 ? '(LLM 可能没调 visualizer,这次测试看不到——但 translator 路径已写)' : '')
  check('stopReason = end_turn', r.result.stopReason === 'end_turn',
    `got ${r.result.stopReason}`)

  console.log(`\n=========== Stage 6 验收 ===========`)
  console.log(`  通过: ${pass} / 失败: ${fail}`)
  if (openpipalMetaUpdates.length > 0) {
    console.log(`\n  示例 _meta keys:`)
    openpipalMetaUpdates.slice(0, 3).forEach((u, i) => {
      console.log(`    ${i + 1}: ${Object.keys(u._meta).join(', ')}`)
    })
  }
  console.log(`====================================`)
  process.exit(fail === 0 ? 0 : 1)
} catch (err) {
  console.error('E2E error:', err.message)
  process.exit(1)
} finally {
  proc.kill()
}

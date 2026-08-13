#!/usr/bin/env node
/**
 * Stage 5 E2E: 验证 Agent 选择 + 角色切换
 *   1. session/new 返回 modes 含 4 内置 role
 *   2. session/set_mode 切到 design → {} 成功
 *   3. 桌面端 GET /role/current 确认是 design
 *   4. setSessionMode 切到不存在的 mode → 收到 -32000 错误
 */

import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const NATIVE_TOKEN = process.env.OPENPIPAL_ACP_TOKEN?.trim() || readFileSync(join(homedir(), '.openpipal', 'acp-mcp.token'), 'utf8').trim()

const proc = spawn('node', ['./dist/index.js'], { stdio: 'pipe' })

let buffer = ''
let nextId = 1
const pending = new Map()

proc.stdout.on('data', (d) => {
  buffer += d.toString()
  let idx
  while ((idx = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, idx)
    buffer = buffer.slice(idx + 1)
    if (!line.trim()) continue
    let msg
    try { msg = JSON.parse(line) } catch { continue }
    if (msg.id !== undefined && pending.has(msg.id)) {
      pending.get(msg.id)(msg)
      pending.delete(msg.id)
    }
  }
})
proc.stderr.on('data', (d) => process.stderr.write(`[STDERR] ${d}`))

function call(method, params, t = 30000) {
  const id = nextId++
  proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
  return new Promise((resolve, reject) => {
    pending.set(id, resolve)
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error(`Timeout ${method}`)) } }, t)
  })
}

async function getCurrentRole() {
  const r = await fetch('http://localhost:3031/role/current', {
    headers: { 'X-OpenPipal-ACP-Token': NATIVE_TOKEN }
  })
  return await r.json()
}

let pass = 0, fail = 0
function check(name, ok, detail = '') {
  if (ok) { console.log(`  ✓ ${name}`); pass++ }
  else { console.log(`  ✗ ${name} ${detail}`); fail++ }
}

try {
  console.log('=== 1. initialize ===')
  await call('initialize', { protocolVersion: 1, clientCapabilities: {} })

  console.log('\n=== 2. session/new — 验证 modes 字段 ===')
  const sess = await call('session/new', { cwd: '/tmp/acp-stage5', mcpServers: [] })
  const modes = sess.result?.modes
  check('返回 modes 字段', !!modes, JSON.stringify(modes).slice(0, 60))
  // 角色数会随桌面端配置增长（文件式角色）——断言"至少含 4 个内置角色"而非精确计数
  const builtinIds = ['learner', 'teacher', 'office', 'design']
  const modeIds = (modes?.availableModes || []).map((m) => m.id)
  check('availableModes 含全部 4 个内置 role',
    builtinIds.every((id) => modeIds.includes(id)),
    `got [${modeIds.join(', ')}]`)
  check('currentModeId 默认 learner',
    modes?.currentModeId === 'learner',
    `got ${modes?.currentModeId}`)
  const sessionId = sess.result.sessionId

  console.log('\n=== 3. session/set_mode 切到 design ===')
  const setRes = await call('session/set_mode', { sessionId, modeId: 'design' })
  check('set_mode 不报错', !setRes.error, setRes.error?.message || '')

  // 等 100ms 让桌面端处理
  await new Promise((r) => setTimeout(r, 100))

  console.log('\n=== 4. 桌面端 /role/current 验证 ===')
  const cur = await getCurrentRole()
  check('桌面端当前 role 是 design', cur.name === 'design', `got ${cur.name}`)

  console.log('\n=== 5. set_mode 到不存在的 modeId 应该报错 ===')
  const errRes = await call('session/set_mode', { sessionId, modeId: 'nonexistent-mode' })
  check('返回 ACP error', !!errRes.error, '')
  check('error code -32000', errRes.error?.code === -32000, `got ${errRes.error?.code}`)
  check('错误消息含"不是 OpenPipal 内置角色"',
    errRes.error?.message?.includes('内置角色'),
    errRes.error?.message)

  console.log('\n=== 6. 切回 learner 还原全局态 ===')
  await call('session/set_mode', { sessionId, modeId: 'learner' })
  const cur2 = await getCurrentRole()
  check('切回 learner 成功', cur2.name === 'learner', `got ${cur2.name}`)

  console.log(`\n=========== Stage 5 验收 ===========`)
  console.log(`  通过: ${pass} / 失败: ${fail}`)
  console.log(`====================================`)
  process.exit(fail === 0 ? 0 : 1)
} catch (err) {
  console.error('E2E error:', err.message)
  process.exit(1)
} finally {
  proc.kill()
}

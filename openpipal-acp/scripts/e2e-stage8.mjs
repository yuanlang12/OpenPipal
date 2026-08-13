#!/usr/bin/env node
/**
 * Stage 8 E2E: 验证 ACP newSession 选 Agent (内置 role + 自定义 workspace)
 *
 * 4 个测试场景:
 *   1. 不带 _meta.openpipal.io/agentId → 默认 general（通用 OpenPipal）
 *   2. agentId="design" (内置) → conversation.role=design
 *   3. agentId=<某 workspace UUID> → conversation.workspaceId=<UUID>
 *   4. agentId="invalid-id" → 应该返回 ACP error
 *
 * 前提: OpenPipal 桌面端运行中
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

async function getConversation(id) {
  const r = await fetch(`http://localhost:3031/api/conversations/${id}`, {
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
  console.log('=== 1. initialize 拿 Agent inventory ===')
  const init = await call('initialize', { protocolVersion: 1, clientCapabilities: {} })
  const inv = init.result?._meta?.['openpipal.io/agents']
  const builtins = inv?.builtins || []
  const agents = inv?.agents || []
  console.log(`  builtins: ${builtins.length}, user agents: ${agents.length}`)
  check('至少 1 个内置', builtins.length >= 4)
  check('至少 1 个自定义 Agent', agents.length >= 1)
  if (agents.length === 0) {
    console.log('!! 没用户保存 Agent,跳过场景 3')
  }

  // ============= 场景 1: 不带 agentId (默认行为) =============
  console.log('\n=== 2. 不带 _meta — 默认 general ===')
  const s1 = await call('session/new', { cwd: '/tmp/acp-stage8-default', mcpServers: [] })
  check('newSession 成功', !s1.error)
  const c1 = await getConversation(s1.result.sessionId)
  check(`conversation.role = general`, c1.role === 'general', `got ${c1.role}`)
  check('conversation.workspaceId 不存在', !c1.workspaceId)

  // ============= 场景 2: 内置 role design =============
  console.log('\n=== 3. _meta.openpipal.io/agentId = "design" (内置) ===')
  const s2 = await call('session/new', {
    cwd: '/tmp/acp-stage8-design',
    mcpServers: [],
    _meta: { 'openpipal.io/agentId': 'design' },
  })
  check('newSession 成功', !s2.error, s2.error?.message)
  if (!s2.error) {
    const c2 = await getConversation(s2.result.sessionId)
    check(`conversation.role = design`, c2.role === 'design', `got ${c2.role}`)
    check('conversation.workspaceId 不存在 (内置走 role)', !c2.workspaceId)
  }

  // ============= 场景 3: 自定义 Agent UUID =============
  if (agents.length > 0) {
    const targetAgent = agents[0]
    console.log(`\n=== 4. _meta.openpipal.io/agentId = "${targetAgent.id.slice(0, 8)}..." (自定义: ${targetAgent.name}) ===`)
    const s3 = await call('session/new', {
      cwd: '/tmp/acp-stage8-custom',
      mcpServers: [],
      _meta: { 'openpipal.io/agentId': targetAgent.id },
    })
    check('newSession 成功', !s3.error, s3.error?.message)
    if (!s3.error) {
      const c3 = await getConversation(s3.result.sessionId)
      check(`conversation.workspaceId = ${targetAgent.id.slice(0, 8)}...`,
        c3.workspaceId === targetAgent.id, `got ${c3.workspaceId}`)
      check('conversation title 含 agent 名',
        c3.title?.includes(targetAgent.name),
        `got "${c3.title}"`)
    }
  }

  // ============= 场景 4: 无效 agentId =============
  console.log('\n=== 5. _meta.openpipal.io/agentId = "invalid-id" → ACP error ===')
  const s4 = await call('session/new', {
    cwd: '/tmp/acp-stage8-invalid',
    mcpServers: [],
    _meta: { 'openpipal.io/agentId': 'invalid-nonexistent-id' },
  })
  check('返回 ACP error', !!s4.error)
  check('error code -32000', s4.error?.code === -32000)
  check('错误消息含 "Unknown agent id"', s4.error?.message?.includes('Unknown agent id'))

  console.log(`\n=========== Stage 8 验收 ===========`)
  console.log(`  通过: ${pass} / 失败: ${fail}`)
  console.log(`====================================`)
  process.exit(fail === 0 ? 0 : 1)
} catch (err) {
  console.error('E2E error:', err.message)
  process.exit(1)
} finally {
  proc.kill()
}

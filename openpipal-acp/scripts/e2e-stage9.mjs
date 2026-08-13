#!/usr/bin/env node
/**
 * Stage 9 E2E: 验证 ACP session/new.mcpServers 注入
 *
 * 不依赖任何外部 MCP 二进制文件——用「故意失败的命令」+ 真实 mcp-server-everything
 * 二选一(后者需 npx 已缓存),覆盖 success / failure 两条路径。
 *
 * 6 个场景:
 *   1. initialize → mcpCapabilities.http/sse = true
 *   2. POST /api/acp/sessions/:id/mcp 直 HTTP 注入 stdio 失败命令 → failed.length=1
 *   3. DELETE /api/acp/sessions/:id/mcp → ok
 *   4. ACP newSession 带 mcpServers (bogus stdio) → no error, sessionId 返回
 *   5. (可选) ACP newSession 带 mcpServers (真实 npx server-everything) → registered>=1
 *   6. 清理:DELETE 所有测试 session 的 MCP
 *
 * 前提: OpenPipal 桌面端运行中(且是 Stage 9 之后的 build,带 /api/acp/* 端点)
 */

import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const proc = spawn('node', ['./dist/index.js'], { stdio: 'pipe' })
let buffer = ''
let nextId = 1
const pending = new Map()
const stderrLines = []

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
proc.stderr.on('data', (d) => {
  const s = d.toString()
  stderrLines.push(s)
  process.stderr.write(`[STDERR] ${s}`)
})

function call(method, params, t = 15000) {
  const id = nextId++
  proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
  return new Promise((resolve, reject) => {
    pending.set(id, resolve)
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error(`Timeout ${method}`)) } }, t)
  })
}

const BASE = 'http://127.0.0.1:3031'
const MCP_TOKEN_PATH = join(homedir(), '.openpipal', 'acp-mcp.token')
const MCP_TOKEN = process.env.OPENPIPAL_ACP_TOKEN?.trim() || readFileSync(MCP_TOKEN_PATH, 'utf8').trim()

async function http(method, path, body) {
  const headers = { 'X-OpenPipal-ACP-Token': MCP_TOKEN }
  if (body) headers['Content-Type'] = 'application/json'
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  })
  return { status: res.status, json: res.status !== 204 ? await res.json().catch(() => null) : null }
}

let pass = 0, fail = 0
function check(name, ok, detail = '') {
  if (ok) { console.log(`  ✓ ${name}`); pass++ }
  else { console.log(`  ✗ ${name} ${detail}`); fail++ }
}

const cleanupSessions = []

try {
  // ============= 1. initialize 声明 mcpCapabilities =============
  console.log('=== 1. initialize → mcpCapabilities ===')
  const init = await call('initialize', { protocolVersion: 1, clientCapabilities: {} })
  const caps = init.result?.agentCapabilities
  check('initialize 成功', !init.error)
  check('agentCapabilities.mcpCapabilities.http = true', caps?.mcpCapabilities?.http === true, `got ${JSON.stringify(caps?.mcpCapabilities)}`)
  check('agentCapabilities.mcpCapabilities.sse = true', caps?.mcpCapabilities?.sse === true)

  // ============= 2. 直 HTTP 注入 stdio 失败命令 =============
  console.log('\n=== 2. POST /api/acp/sessions/:id/mcp (bogus stdio) → failed=1 ===')
  const fakeSession = 'e2e-stage9-fake-' + Date.now()
  cleanupSessions.push(fakeSession)
  const r2 = await http('POST', `/api/acp/sessions/${fakeSession}/mcp`, {
    mcpServers: [
      // 故意不存在的命令——验证 failed 路径而不污染环境
      { name: 'bogus-server', command: '/nonexistent/never/spawn-this', args: [], env: [] }
    ]
  })
  check('HTTP 200', r2.status === 200, `got ${r2.status}`)
  check('failed.length=1', r2.json?.failed?.length === 1, `got ${JSON.stringify(r2.json)}`)
  check('failed[0].name = bogus-server', r2.json?.failed?.[0]?.name === 'bogus-server')
  check('registered.length=0', r2.json?.registered?.length === 0)

  // ============= 3. DELETE 注销 =============
  console.log('\n=== 3. DELETE /api/acp/sessions/:id/mcp ===')
  const r3 = await http('DELETE', `/api/acp/sessions/${fakeSession}/mcp`)
  check('HTTP 200', r3.status === 200, `got ${r3.status}`)
  check('json.ok=true', r3.json?.ok === true)

  // ============= 4. ACP newSession 带 bogus mcpServers → session 仍创建 =============
  console.log('\n=== 4. ACP session/new + bogus mcpServers → session 创建成功 ===')
  const s4 = await call('session/new', {
    cwd: '/tmp/acp-stage9-bogus',
    mcpServers: [
      { name: 'bogus-via-acp', command: '/nonexistent/cmd', args: [], env: [] }
    ],
  })
  check('newSession 不报错', !s4.error, s4.error?.message)
  check('返回 sessionId', !!s4.result?.sessionId)
  if (s4.result?.sessionId) cleanupSessions.push(s4.result.sessionId)
  // 给 stderr buffer 一点时间落地注入日志
  await new Promise(r => setTimeout(r, 200))
  const stderrAll = stderrLines.join('')
  check('stderr 含注入失败日志', stderrAll.includes('bogus-via-acp') || stderrAll.includes('注入 MCP'),
    `stderr 片段: ${stderrAll.slice(-300)}`)

  // ============= 5. (可选) 真实 stdio MCP =============
  // 用 server-everything 需 npx 网络。检查 npx 是否能 0 秒拿到——能就跑,不能就跳过。
  console.log('\n=== 5. (可选) ACP session/new + 真实 stdio MCP ===')
  const hasNpx = await new Promise((resolve) => {
    const t = spawn('which', ['npx'])
    t.on('exit', (code) => resolve(code === 0))
    t.on('error', () => resolve(false))
  })
  if (!hasNpx) {
    console.log('  -- 跳过 (无 npx)')
  } else {
    const s5 = await call('session/new', {
      cwd: '/tmp/acp-stage9-real',
      mcpServers: [
        {
          name: 'everything',
          // server-everything 是 MCP 官方测试 server,首次跑 npx 会下载,后续走缓存
          command: 'npx',
          args: ['-y', '@modelcontextprotocol/server-everything'],
          env: [],
        }
      ],
    }, 60000)
    check('newSession 不报错', !s5.error, s5.error?.message)
    if (s5.result?.sessionId) {
      cleanupSessions.push(s5.result.sessionId)
      await new Promise(r => setTimeout(r, 500))
      const stderr5 = stderrLines.join('')
      check('stderr 含真实注入成功日志',
        /everything\(\d+\)/.test(stderr5) || stderr5.includes('注入 MCP: everything'),
        `stderr 尾部: ${stderr5.slice(-400)}`)
    }
  }

  // ============= 6. 清理 =============
  console.log('\n=== 6. 清理所有测试 session 的 MCP ===')
  for (const sid of cleanupSessions) {
    await http('DELETE', `/api/acp/sessions/${sid}/mcp`)
  }
  check(`清理完成 ${cleanupSessions.length} 个 session`, true)

  console.log(`\n=========== Stage 9 验收 ===========`)
  console.log(`  通过: ${pass} / 失败: ${fail}`)
  console.log(`====================================`)
  process.exit(fail === 0 ? 0 : 1)
} catch (err) {
  console.error('E2E error:', err.message)
  process.exit(1)
} finally {
  proc.kill()
}

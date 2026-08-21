#!/usr/bin/env node

/**
 * Offline ACP v1/v2 compatibility smoke test.
 *
 * It starts a tiny in-memory OpenPipal HTTP/SSE double on an ephemeral port, so
 * this test never launches Electron, touches ~/.openpipal, or uses port 3031.
 */

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const conversations = new Map()
const CUSTOM_AGENT_ID = '11111111-2222-3333-4444-555555555555'
// 编辑器连上之后用户才在桌面端存的那个 Agent：initialize 拉的那张表里没有它
const LATE_AGENT_ID = '66666666-7777-8888-9999-000000000000'
let lateAgentSaved = false
const SMOKE_TOKEN = 's'.repeat(43)
const dynamicRequests = []
// 桌面端收到的授权裁决 + 正卡在等裁决的那条流（一次一个，够用且好读）
const permissionDecisions = []
const permissionWaiters = []
// 常驻推送通道的订阅者（桌面端 → 适配器）
const eventSubscribers = new Set()
let failPermissionResponses = false

function broadcastConversationChange(conversationId, kind) {
  for (const subscriber of eventSubscribers) {
    try {
      subscriber.write(`data: ${JSON.stringify({ type: 'conversation_changed', conversationId, kind })}\n\n`)
    } catch { /* 关闭中 */ }
  }
}

function assertFreshAdapterBundle() {
  const bundleUrl = new URL('../dist/index.js', import.meta.url)
  const bundleMtime = statSync(bundleUrl).mtimeMs
  for (const source of ['../src/agent.ts', '../src/http-client.ts']) {
    const sourceUrl = new URL(source, import.meta.url)
    assert.ok(
      bundleMtime >= statSync(sourceUrl).mtimeMs,
      `dist/index.js is older than ${source}; run npm --prefix openpipal-acp run build first`,
    )
  }

  const bundle = readFileSync(bundleUrl, 'utf8')
  for (const marker of [
    'is updating its role',
    'OpenPipal stream ended before the terminal done event',
    'Failed to update conversation persona',
  ]) {
    assert.ok(bundle.includes(marker), `dist/index.js is missing the Runtime R1 marker: ${marker}`)
  }
}

assertFreshAdapterBundle()
const smokeHome = mkdtempSync(join(tmpdir(), 'openpipal-acp-protocol-'))

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = ''
    req.on('data', (chunk) => { body += chunk })
    req.on('end', () => resolve(body ? JSON.parse(body) : {}))
    req.on('error', reject)
  })
}

function json(res, status, value) {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(value))
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1')
  if (url.pathname === '/health') return json(res, 200, { status: 'ok', app: 'openpipal' })
  const dynamicRequest = {
    method: req.method,
    pathname: url.pathname,
    token: req.headers['x-openpipal-acp-token'],
  }
  dynamicRequests.push(dynamicRequest)
  if (req.headers['x-openpipal-acp-token'] !== SMOKE_TOKEN) {
    return json(res, 401, { error: 'missing smoke authorization' })
  }
  if (url.pathname === '/api/agents/list') {
    return json(res, 200, {
      builtins: [
        { name: 'learner', displayName: '学习助手', icon: '📚' },
        { name: 'design', displayName: '设计助手', icon: '🎨' },
      ],
      agents: [
        { id: CUSTOM_AGENT_ID, name: '我的法务助手', icon: '⚖️' },
        ...(lateAgentSaved ? [{ id: LATE_AGENT_ID, name: '我的新助手', icon: '🆕' }] : []),
      ],
    })
  }
  if (url.pathname === '/api/acp/events' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' })
    res.write(`data: ${JSON.stringify({ type: 'ready' })}\n\n`)
    eventSubscribers.add(res)
    res.once('close', () => eventSubscribers.delete(res))
    return
  }
  if (url.pathname === '/api/skills' && req.method === 'GET') {
    // 自定义 Agent 只带自己的技能——换人格后编辑器的命令列表必须跟着换
    const workspaceId = url.searchParams.get('workspaceId')
    if (workspaceId) {
      return json(res, 200, {
        skills: workspaceId === CUSTOM_AGENT_ID
          ? [{ name: 'contract-review', description: '审合同' }]
          : [{ name: 'late-agent-skill', description: '新助手的技能' }],
      })
    }
    // 内置角色：全局技能 + 这个角色的专属技能（角色专属排在前面，与桌面端一致）。
    // 不带 role 就只剩全局那批——适配器漏传 role 的话这里立刻看得出来。
    const role = url.searchParams.get('role')
    return json(res, 200, {
      skills: [
        ...(role ? [{ name: `${role}-drill`, description: `${role} 专属技能` }] : []),
        { name: 'docx-render', description: '生成 Word 文档' },
        { name: 'web-research', description: '查资料' },
      ],
    })
  }
  if (url.pathname === '/api/conversations' && req.method === 'POST') {
    const body = await readBody(req)
    dynamicRequest.body = body
    const now = Date.now()
    const conversation = {
      id: randomUUID(),
      title: body.title,
      role: body.role || 'learner',
      ...(body.workspaceId ? { workspaceId: body.workspaceId } : {}),
      config: {},
      createdAt: now,
      updatedAt: now,
      messages: [],
    }
    conversations.set(conversation.id, conversation)
    return json(res, 200, conversation)
  }
  if (url.pathname === '/api/conversations' && req.method === 'GET') {
    return json(res, 200, [...conversations.values()].map((conversation) => ({
      ...conversation,
      messageCount: conversation.messages.length,
      messages: undefined,
    })))
  }

  const goalMatch = url.pathname.match(/^\/api\/conversations\/([^/]+)\/goal$/)
  if (goalMatch) {
    const conversation = conversations.get(goalMatch[1])
    if (!conversation) return json(res, 404, { error: 'Not found' })
    if (req.method === 'GET') return json(res, 200, { goal: conversation.config?.goal || null })
    if (req.method === 'POST') {
      const body = await readBody(req)
      dynamicRequest.body = body
      if (!body.text?.trim()) return json(res, 400, { error: 'Goal text is required' })
      const goal = {
        text: body.text.trim(),
        maxTurns: 8,
        turnsUsed: 0,
        status: 'active',
        consecutiveBlocks: 0,
        createdAt: Date.now(),
      }
      conversation.config = { ...(conversation.config || {}), goal }
      return json(res, 200, { goal })
    }
    if (req.method === 'DELETE') {
      const rest = { ...(conversation.config || {}) }
      delete rest.goal
      conversation.config = rest
      return json(res, 200, { ok: true })
    }
  }

  const messagesMatch = url.pathname.match(/^\/api\/conversations\/([^/]+)\/messages$/)
  if (messagesMatch && req.method === 'GET') {
    const conversation = conversations.get(messagesMatch[1])
    return conversation ? json(res, 200, conversation.messages) : json(res, 404, { error: 'Not found' })
  }
  const conversationMatch = url.pathname.match(/^\/api\/conversations\/([^/]+)$/)
  if (conversationMatch) {
    const conversation = conversations.get(conversationMatch[1])
    if (!conversation) return json(res, 404, { error: 'Not found' })
    if (req.method === 'GET') return json(res, 200, conversation)
    if (req.method === 'PATCH') {
      const body = await readBody(req)
      dynamicRequest.body = body
      if (body.role !== undefined) {
        if (conversation.config?.workingDir?.includes('role-race')) {
          await new Promise((resolve) => setTimeout(resolve, 100))
        }
        if (conversation.messages.length > 0) {
          return json(res, 409, { error: 'Conversation role is locked after the first message' })
        }
        conversation.role = body.role
        broadcastConversationChange(conversation.id, 'persona')
      }
      if (body.workspaceId !== undefined) {
        const workspaceId = body.workspaceId === null || body.workspaceId === '' ? undefined : body.workspaceId
        const knownAgents = [CUSTOM_AGENT_ID, ...(lateAgentSaved ? [LATE_AGENT_ID] : [])]
        if (workspaceId !== undefined && !knownAgents.includes(workspaceId)) {
          return json(res, 400, { error: 'Unknown conversation agent' })
        }
        if (conversation.messages.length > 0) {
          return json(res, 409, { error: 'Conversation agent is locked after the first message' })
        }
        if (workspaceId) conversation.workspaceId = workspaceId
        else delete conversation.workspaceId
        broadcastConversationChange(conversation.id, 'persona')
      }
      if (body.config !== undefined) conversation.config = body.config
      conversation.updatedAt = Date.now()
      return json(res, 200, { ok: true })
    }
    if (req.method === 'DELETE') {
      conversations.delete(conversation.id)
      return json(res, 200, { ok: true })
    }
  }
  if (url.pathname === '/api/permission' && req.method === 'POST') {
    const body = await readBody(req)
    dynamicRequest.body = body
    if (failPermissionResponses) {
      // 模拟"裁决回传失败"：适配器必须重试，然后如实报告没送到（不能假称已拒绝）
      return json(res, 500, { error: 'simulated failure' })
    }
    permissionDecisions.push(body)
    permissionWaiters.shift()?.()
    return json(res, 200, { ok: true })
  }
  if (/^\/api\/acp\/sessions\/[^/]+\/mcp$/.test(url.pathname)) {
    if (req.method === 'POST') return json(res, 200, { registered: [], failed: [] })
    if (req.method === 'DELETE') return json(res, 200, { ok: true })
  }
  if (url.pathname === '/chat/stream' && req.method === 'POST') {
    const body = await readBody(req)
    dynamicRequest.body = body
    const conversation = conversations.get(body.conversationId)
    const userText = body.messages?.at(-1)?.content || ''
    const assistantText = 'OpenPipal mock response'
    if (conversation) {
      conversation.messages.push(
        { id: randomUUID(), role: 'user', content: userText, timestamp: Date.now() },
        { id: randomUUID(), role: 'assistant', content: assistantText, timestamp: Date.now() },
      )
      conversation.updatedAt = Date.now()
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    if (userText.includes('cancel-me')) {
      res.write(`data: ${JSON.stringify({ type: 'thinking', content: 'long running' })}\n\n`)
      return
    }
    if (userText.includes('sse-error')) {
      res.write(`data: ${JSON.stringify({ type: 'text', content: 'partial before failure' })}\n\n`)
      res.write(`data: ${JSON.stringify({ type: 'error', content: 'mock stream failure' })}\n\n`)
      return res.end()
    }
    if (userText.includes('needs-permission')) {
      // 桌面端发出权限事件后就 block 住，等 POST /api/permission 才继续——
      // 适配器如果不回传（或回传得慢），这一轮就永远停在这里。
      res.write(`data: ${JSON.stringify({
        type: 'permission',
        conversationId: body.conversationId,
        request: {
          requestId: `req-${conversation?.messages.length ?? 0}`,
          tool: 'execute_command',
          args: { command: 'rm -rf /tmp/whatever' },
          risk: 'high',
          reason: '这条命令会删文件',
          conversationId: body.conversationId,
          executionId: 'exec-smoke',
        },
      })}\n\n`)
      await new Promise((resolve) => permissionWaiters.push(resolve))
      res.write(`data: ${JSON.stringify({ type: 'text', content: 'after permission' })}\n\n`)
      res.write(`data: ${JSON.stringify({ type: 'done' })}\n\n`)
      return res.end()
    }
    if (userText.includes('parallel-tools')) {
      // 模型一条回复里两个 tool_use：pi 会在任何一个执行前把两条 tool_start 都推出来
      for (const event of [
        { type: 'tool_start', name: 'read_file', toolCallId: 'call-A' },
        { type: 'tool_start', name: 'web_search', toolCallId: 'call-B' },
        { type: 'tool_end', name: 'read_file', toolCallId: 'call-A', mcpResult: 'A 的结果' },
        { type: 'tool_end', name: 'web_search', toolCallId: 'call-B', mcpResult: 'B 的结果' },
        { type: 'text', content: '都跑完了' },
        { type: 'done' },
      ]) {
        res.write(`data: ${JSON.stringify(event)}\n\n`)
      }
      return res.end()
    }
    if (userText.includes('stream-artifact')) {
      for (const event of [
        { type: 'tool_start', name: 'create_artifact' },
        // 第一条 delta 是"开面板"的空信号，不该变成一条空内容 chunk
        { type: 'artifact_delta', id: 'art-1', delta: '', offset: 0 },
        { type: 'artifact_delta', id: 'art-1', title: '报告', delta: '<h1>', offset: 0 },
        { type: 'artifact_delta', id: 'art-1', title: '报告', delta: 'Hello</h1>', offset: 4 },
        { type: 'tool_end', mcpResult: 'artifact created' },
        { type: 'text', content: '写好了' },
        { type: 'done' },
      ]) {
        res.write(`data: ${JSON.stringify(event)}\n\n`)
      }
      return res.end()
    }
    if (userText.includes('eof-without-done')) {
      res.write(`data: ${JSON.stringify({ type: 'text', content: 'partial before eof' })}\n\n`)
      return res.end()
    }
    for (const event of [
      { type: 'thinking', content: 'checking' },
      { type: 'tool_start', name: 'read_file' },
      { type: 'tool_end', mcpResult: 'ok' },
      { type: 'text', content: assistantText },
      { type: 'done' },
    ]) {
      res.write(`data: ${JSON.stringify(event)}\n\n`)
    }
    return res.end()
  }
  json(res, 404, { error: `${req.method} ${url.pathname}` })
})

await new Promise((resolve, reject) => {
  const onError = (error) => {
    rmSync(smokeHome, { recursive: true, force: true })
    reject(error)
  }
  server.once('error', onError)
  server.listen(0, '127.0.0.1', () => {
    server.off('error', onError)
    resolve()
  })
})
const { port } = server.address()
const baseUrl = `http://127.0.0.1:${port}`

function launch(extraEnv = {}) {
  const child = spawn(process.execPath, ['./dist/index.js'], {
    cwd: new URL('..', import.meta.url),
    env: {
      ...process.env,
      ...extraEnv,
      HOME: smokeHome,
      USERPROFILE: smokeHome,
      OPENPIPAL_BASE_URL: baseUrl,
      // Keep the offline smoke hermetic. These values must win over both the
      // caller's environment and extraEnv so the adapter never falls back to
      // real desktop state on a developer machine.
      OPENPIPAL_ACP_TOKEN: SMOKE_TOKEN,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  let buffer = ''
  let nextId = 1
  const pending = new Map()
  const updates = []
  const events = []
  const inboundRequests = []
  // 客户端对授权请求的默认答复；测试可改成别的 optionId 或 null(=cancelled)
  let permissionOptionId = 'allow_once'
  // 模拟"用户把授权框晾在那儿不管"——客户端收到请求但一直不回
  let holdPermission = false
  child.stdout.on('data', (chunk) => {
    buffer += chunk.toString()
    let newline
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline)
      buffer = buffer.slice(newline + 1)
      if (!line.trim()) continue
      const message = JSON.parse(line)
      if (message.method === 'session/update') {
        updates.push(message.params)
        events.push(`update:${message.params.update.sessionUpdate}`)
      }
      else if (message.method && message.id !== undefined) {
        // agent → client 的反向请求（session/request_permission 走这条）
        inboundRequests.push(message)
        events.push(`request:${message.method}`)
        if (holdPermission) continue
        const result = permissionOptionId
          ? { outcome: { outcome: 'selected', optionId: permissionOptionId } }
          : { outcome: { outcome: 'cancelled' } }
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, result })}\n`)
      }
      else if (pending.has(message.id)) {
        events.push(`response:${pending.get(message.id).method}`)
        pending.get(message.id).resolve(message)
        pending.delete(message.id)
      }
    }
  })
  child.stderr.on('data', (chunk) => process.stderr.write(chunk))

  return {
    child,
    updates,
    events,
    inboundRequests,
    /** null = 客户端点了取消 */
    setPermissionOutcome(optionId) { permissionOptionId = optionId },
    /** true = 收到授权请求但一直不答复 */
    setHoldPermission(hold) { holdPermission = hold },
    call(method, params, timeoutMs = 5_000) {
      const id = nextId++
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id)
          reject(new Error(`Timeout waiting for ${method}`))
        }, timeoutMs)
        pending.set(id, { method, resolve: (message) => {
          clearTimeout(timer)
          resolve(message)
        } })
      })
    },
    notify(method, params) {
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`)
    },
    async waitForUpdate(predicate, timeoutMs = 5_000) {
      const started = Date.now()
      while (Date.now() - started < timeoutMs) {
        const match = updates.find(predicate)
        if (match) return match
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
      throw new Error('Timeout waiting for session/update')
    },
    stop() {
      child.kill('SIGTERM')
    },
  }
}

function updateText(update) {
  if (Array.isArray(update.content)) {
    return update.content.map((block) => block?.text || '').join('')
  }
  return update.content?.text || ''
}

function countUpdateText(updates, needle) {
  return updates.reduce((count, { update }) => (
    count + updateText(update).split(needle).length - 1
  ), 0)
}

/** 适配器创建会话后 PATCH 上去的 config.acp 标记（桌面端设置页据此显示编辑器名） */
function acpMarkerFor(sessionId) {
  const patch = dynamicRequests.find((request) => (
    request.method === 'PATCH'
    && request.pathname.endsWith(`/${sessionId}`)
    && request.body?.config?.acp
  ))
  return patch?.body.config.acp
}

/** 模拟"桌面端那边动了同一条会话"——走的是和桌面端同一条 HTTP 写入口 */
async function patchConversation(conversationId, patch) {
  const res = await fetch(`${baseUrl}/api/conversations/${conversationId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', 'X-OpenPipal-ACP-Token': SMOKE_TOKEN },
    body: JSON.stringify(patch),
  })
  assert.ok(res.ok, `PATCH 失败: ${res.status}`)
}

async function waitFor(predicate, description, timeoutMs = 5_000) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error(`Timeout waiting for ${description}`)
}

async function testV1() {
  const client = launch()
  try {
    const init = await client.call('initialize', {
      protocolVersion: 1,
      clientCapabilities: {},
      clientInfo: { name: 'openpipal-smoke-v1', version: '1.0.0' },
    })
    assert.equal(init.result.protocolVersion, 1)
    assert.ok(init.result.agentCapabilities)

    const created = await client.call('session/new', { cwd: '/tmp/openpipal-acp-v1', mcpServers: [] })
    assert.ok(created.result.sessionId)
    assert.ok(created.result.modes)
    assert.deepEqual(acpMarkerFor(created.result.sessionId), {
      adapter: 'openpipal-acp',
      client: 'openpipal-smoke-v1',
      protocolVersion: 1,
    })
    const switched = await client.call('session/set_mode', {
      sessionId: created.result.sessionId,
      modeId: 'design',
    })
    assert.deepEqual(switched.result, {})
    assert.equal(conversations.get(created.result.sessionId).role, 'design')

    const prompt = await client.call('session/prompt', {
      sessionId: created.result.sessionId,
      prompt: [{ type: 'text', text: 'hello v1' }],
    })
    assert.equal(prompt.result.stopReason, 'end_turn')
    assert.ok(client.updates.some(({ update }) => update.sessionUpdate === 'tool_call'))

    const locked = await client.call('session/set_mode', {
      sessionId: created.result.sessionId,
      modeId: 'learner',
    })
    assert.equal(locked.error.code, -32000)
    assert.equal(locked.error.message, 'Conversation role is locked after the first message')
    assert.equal(conversations.get(created.result.sessionId).role, 'design')

    const errorSession = await client.call('session/new', {
      cwd: '/tmp/openpipal-acp-v1-error',
      mcpServers: [],
    })
    const errorUpdateStart = client.updates.length
    const failed = await client.call('session/prompt', {
      sessionId: errorSession.result.sessionId,
      prompt: [{ type: 'text', text: 'sse-error' }],
    })
    assert.equal(failed.error.code, -32000)
    assert.equal(failed.error.message, 'Prompt failed: mock stream failure')
    assert.equal(countUpdateText(client.updates.slice(errorUpdateStart), 'mock stream failure'), 0)

    const eofSession = await client.call('session/new', {
      cwd: '/tmp/openpipal-acp-v1-eof',
      mcpServers: [],
    })
    const unexpectedEof = await client.call('session/prompt', {
      sessionId: eofSession.result.sessionId,
      prompt: [{ type: 'text', text: 'eof-without-done' }],
    })
    assert.equal(unexpectedEof.error.code, -32000)
    assert.match(unexpectedEof.error.message, /ended before the terminal done event/)

    const busySession = await client.call('session/new', {
      cwd: '/tmp/openpipal-acp-v1-busy',
      mcpServers: [],
    })
    client.updates.length = 0
    const pendingPrompt = client.call('session/prompt', {
      sessionId: busySession.result.sessionId,
      prompt: [{ type: 'text', text: 'cancel-me' }],
    })
    await client.waitForUpdate(({ sessionId, update }) =>
      sessionId === busySession.result.sessionId && update.sessionUpdate === 'agent_thought_chunk')
    const busySwitch = await client.call('session/set_mode', {
      sessionId: busySession.result.sessionId,
      modeId: 'design',
    })
    assert.equal(busySwitch.error.code, -32600)
    assert.match(busySwitch.error.message, /already processing a prompt/)
    assert.equal(conversations.get(busySession.result.sessionId).role, 'learner')
    client.notify('session/cancel', { sessionId: busySession.result.sessionId })
    assert.equal((await pendingPrompt).result.stopReason, 'cancelled')

    const roleRaceSession = await client.call('session/new', {
      cwd: '/tmp/openpipal-acp-v1-role-race',
      mcpServers: [],
    })
    const roleRaceRequestStart = dynamicRequests.length
    const roleChange = client.call('session/set_mode', {
      sessionId: roleRaceSession.result.sessionId,
      modeId: 'design',
    })
    await waitFor(() => dynamicRequests.slice(roleRaceRequestStart).some((request) => (
      request.method === 'PATCH'
      && request.pathname.endsWith(`/${roleRaceSession.result.sessionId}`)
      && request.body?.role === 'design'
    )), 'delayed v1 role PATCH')
    const promptDuringRoleChange = await client.call('session/prompt', {
      sessionId: roleRaceSession.result.sessionId,
      prompt: [{ type: 'text', text: 'must-not-run-during-role-change' }],
    })
    assert.equal(promptDuringRoleChange.error.code, -32600)
    assert.match(promptDuringRoleChange.error.message, /updating its role/)
    const secondRoleChange = await client.call('session/set_mode', {
      sessionId: roleRaceSession.result.sessionId,
      modeId: 'learner',
    })
    assert.equal(secondRoleChange.error.code, -32600)
    assert.match(secondRoleChange.error.message, /already updating its role/)
    assert.equal(conversations.get(roleRaceSession.result.sessionId).messages.length, 0)
    assert.deepEqual((await roleChange).result, {})
    assert.equal(conversations.get(roleRaceSession.result.sessionId).role, 'design')
    // 常驻推送：桌面端改人格，**不用等下一轮开跑**，编辑器立刻收到 current_mode_update
    await waitFor(() => eventSubscribers.size > 0, 'v1 适配器订阅推送通道')
    const pushSessionV1 = await client.call('session/new', {
      cwd: '/tmp/openpipal-acp-v1-push',
      mcpServers: [],
    })
    client.updates.length = 0
    await patchConversation(pushSessionV1.result.sessionId, { role: 'design' })
    const pushedV1 = await client.waitForUpdate(({ sessionId, update }) =>
      sessionId === pushSessionV1.result.sessionId
      && update.sessionUpdate === 'current_mode_update')
    assert.equal(pushedV1.update.currentModeId, 'design')

    // 技能报成斜杠命令，点一下等于桌面端 @技能（同一份强调格式）
    const commandSessionV1 = await client.call('session/new', {
      cwd: '/tmp/openpipal-acp-v1-commands',
      mcpServers: [],
    })
    const v1Commands = await client.waitForUpdate(({ sessionId, update }) =>
      sessionId === commandSessionV1.result.sessionId
      && update.sessionUpdate === 'available_commands_update')
    assert.deepEqual(
      v1Commands.update.availableCommands.map((command) => command.name),
      ['goal', 'learner-drill', 'docx-render', 'web-research'],
    )
    const v1Docx = v1Commands.update.availableCommands.find((command) => command.name === 'docx-render')
    assert.equal(v1Docx.description, '生成 Word 文档')
    assert.equal(v1Docx.input.type, 'text')

    const v1CommandStart = dynamicRequests.length
    await client.call('session/prompt', {
      sessionId: commandSessionV1.result.sessionId,
      prompt: [{ type: 'text', text: '/docx-render 帮我做份周报' }],
    })
    const v1Sent = dynamicRequests.slice(v1CommandStart)
      .find((request) => request.pathname === '/chat/stream')
    assert.equal(
      v1Sent.body.messages.at(-1).content,
      '请使用技能 <skill-request>docx-render</skill-request> 完成以下任务：\n\n帮我做份周报',
    )

    // 不认识的斜杠开头原样送走，不能吞掉用户的正文
    const v1PassStart = dynamicRequests.length
    await client.call('session/prompt', {
      sessionId: commandSessionV1.result.sessionId,
      prompt: [{ type: 'text', text: '/not-a-skill 这句要原样过去' }],
    })
    assert.equal(
      dynamicRequests.slice(v1PassStart).find((r) => r.pathname === '/chat/stream').body.messages.at(-1).content,
      '/not-a-skill 这句要原样过去',
    )

    // v1 没有 tool_call_content_chunk：流式产物只能走 _meta 透传，正文不刷屏
    const artifactSessionV1 = await client.call('session/new', {
      cwd: '/tmp/openpipal-acp-v1-artifact',
      mcpServers: [],
    })
    client.updates.length = 0
    await client.call('session/prompt', {
      sessionId: artifactSessionV1.result.sessionId,
      prompt: [{ type: 'text', text: 'stream-artifact' }],
    })
    assert.equal(
      client.updates.filter(({ update }) => update.sessionUpdate === 'tool_call_content_chunk').length,
      0,
      'v1 不应发 tool_call_content_chunk',
    )
    assert.ok(
      client.updates.some(({ update }) => update._meta?.['openpipal.io/artifact_delta']),
      'v1 仍要通过 _meta 透传流式产物',
    )

    // 外部（桌面端/插件/另一个客户端）改了人格：下一轮开跑前必须回推 current_mode_update
    const driftSession = await client.call('session/new', {
      cwd: '/tmp/openpipal-acp-v1-drift',
      mcpServers: [],
    })
    conversations.get(driftSession.result.sessionId).role = 'design'
    client.updates.length = 0
    await client.call('session/prompt', {
      sessionId: driftSession.result.sessionId,
      prompt: [{ type: 'text', text: 'drift check' }],
    })
    const driftIndex = client.updates.findIndex(({ update }) => update.sessionUpdate === 'current_mode_update')
    assert.ok(driftIndex >= 0, 'v1 必须回推 current_mode_update')
    assert.equal(client.updates[driftIndex].update.currentModeId, 'design')
    const v1AnswerIndex = client.updates.findIndex(({ update }) => update.sessionUpdate === 'agent_message_chunk')
    assert.ok(driftIndex < v1AnswerIndex, '回推必须发生在这一轮的回答之前')

    // 自定义 Agent 出现在 modes 里，能选中、能切回内置角色
    const agentSession = await client.call('session/new', {
      cwd: '/tmp/openpipal-acp-v1-agent',
      mcpServers: [],
    })
    const agentModeId = `agent:${CUSTOM_AGENT_ID}`
    assert.ok(
      agentSession.result.modes.availableModes.some((mode) => mode.id === agentModeId),
      'v1 modes 必须同时列出内置角色和已保存的 Agent',
    )
    assert.deepEqual((await client.call('session/set_mode', {
      sessionId: agentSession.result.sessionId,
      modeId: agentModeId,
    })).result, {})
    assert.equal(conversations.get(agentSession.result.sessionId).workspaceId, CUSTOM_AGENT_ID)

    // 切回内置角色必须同时清掉 workspace 绑定，否则等于没切
    await client.call('session/set_mode', {
      sessionId: agentSession.result.sessionId,
      modeId: 'design',
    })
    assert.equal(conversations.get(agentSession.result.sessionId).workspaceId, undefined)
    assert.equal(conversations.get(agentSession.result.sessionId).role, 'design')

    const unknownAgent = await client.call('session/set_mode', {
      sessionId: agentSession.result.sessionId,
      modeId: 'agent:not-a-real-agent',
    })
    assert.equal(unknownAgent.error.code, -32000)
    assert.match(unknownAgent.error.message, /不是已保存的 OpenPipal Agent/)

    // 授权往返：编辑器点"允许一次" → 桌面端拿到 approved 裁决，这一轮才继续
    const permissionSession = await client.call('session/new', {
      cwd: '/tmp/openpipal-acp-v1-permission',
      mcpServers: [],
    })
    const v1DecisionStart = permissionDecisions.length
    const v1RequestStart = client.inboundRequests.length
    client.updates.length = 0
    const permissionPrompt = await client.call('session/prompt', {
      sessionId: permissionSession.result.sessionId,
      prompt: [{ type: 'text', text: 'needs-permission' }],
    })
    assert.equal(permissionPrompt.result.stopReason, 'end_turn')
    const askedV1 = client.inboundRequests.slice(v1RequestStart)
    assert.equal(askedV1.length, 1)
    assert.equal(askedV1[0].method, 'session/request_permission')
    assert.equal(askedV1[0].params.sessionId, permissionSession.result.sessionId)
    assert.ok(askedV1[0].params.toolCall.toolCallId, 'v1 权限请求必须带 toolCall.toolCallId')
    assert.deepEqual(
      askedV1[0].params.options.map((option) => option.optionId),
      ['allow_once', 'allow_always', 'reject_once'],
    )
    const [v1Decision] = permissionDecisions.slice(v1DecisionStart)
    assert.match(v1Decision.requestId, /^req-/)
    assert.equal(v1Decision.approved, true)
    assert.equal(v1Decision.sessionApprove, false)
    assert.equal(v1Decision.executionId, 'exec-smoke')
    assert.equal(v1Decision.conversationId, permissionSession.result.sessionId)
    assert.equal(countUpdateText(client.updates, 'after permission'), 1)

    console.log('✓ ACP v1 compatibility')
  } finally {
    client.stop()
  }
}

async function testV2() {
  const client = launch({ OPENPIPAL_ACP_V2: '1' })
  try {
    const init = await client.call('initialize', {
      protocolVersion: 2,
      info: { name: 'openpipal-smoke', version: '1.0.0' },
      capabilities: {},
    })
    assert.equal(init.result.protocolVersion, 2)
    assert.ok(init.result.capabilities.session)

    const roleRaceSession = await client.call('session/new', { cwd: '/tmp/openpipal-acp-v2-role-race' })
    const roleRaceRequestStart = dynamicRequests.length
    const roleChange = client.call('session/set_config_option', {
      sessionId: roleRaceSession.result.sessionId,
      configId: 'openpipal.role',
      type: 'id',
      value: 'design',
    })
    await waitFor(() => dynamicRequests.slice(roleRaceRequestStart).some((request) => (
      request.method === 'PATCH'
      && request.pathname.endsWith(`/${roleRaceSession.result.sessionId}`)
      && request.body?.role === 'design'
    )), 'delayed v2 role PATCH')
    const promptDuringRoleChange = await client.call('session/prompt', {
      sessionId: roleRaceSession.result.sessionId,
      prompt: [{ type: 'text', text: 'must-not-run-during-role-change' }],
    })
    assert.equal(promptDuringRoleChange.error.code, -32600)
    assert.match(promptDuringRoleChange.error.message, /updating its role/)
    const secondRoleChange = await client.call('session/set_config_option', {
      sessionId: roleRaceSession.result.sessionId,
      configId: 'openpipal.role',
      type: 'id',
      value: 'learner',
    })
    assert.equal(secondRoleChange.error.code, -32600)
    assert.match(secondRoleChange.error.message, /already updating its role/)
    assert.equal(conversations.get(roleRaceSession.result.sessionId).messages.length, 0)
    assert.equal((await roleChange).result.configOptions[0].currentValue, 'design')
    assert.equal(conversations.get(roleRaceSession.result.sessionId).role, 'design')

    const created = await client.call('session/new', { cwd: '/tmp/openpipal-acp-v2' })
    assert.ok(created.result.sessionId)
    assert.equal(created.result.configOptions[0].category, 'mode')
    assert.deepEqual(acpMarkerFor(created.result.sessionId), {
      adapter: 'openpipal-acp',
      client: 'openpipal-smoke',
      protocolVersion: 2,
    })
    const switched = await client.call('session/set_config_option', {
      sessionId: created.result.sessionId,
      configId: 'openpipal.role',
      type: 'id',
      value: 'design',
    })
    assert.equal(switched.result.configOptions[0].currentValue, 'design')
    assert.equal(conversations.get(created.result.sessionId).role, 'design')

    const promptEventStart = client.events.length
    const prompt = await client.call('session/prompt', {
      sessionId: created.result.sessionId,
      prompt: [{ type: 'text', text: 'hello v2' }],
    })
    assert.deepEqual(prompt.result, {})
    // v2 的核心变化：prompt 立刻返回，不再等到这一轮结束。判据是"响应排在本轮任何
    // state_update 之前"——不能钉死在紧邻的下一条上，别的会话的异步通知（比如命令
    // 列表）随时可能插在中间，那不是回归。
    const promptEvents = client.events.slice(promptEventStart)
    const responseAt = promptEvents.indexOf('response:session/prompt')
    const firstStateAt = promptEvents.indexOf('update:state_update')
    assert.ok(responseAt >= 0, 'session/prompt 必须有响应')
    assert.ok(
      firstStateAt === -1 || responseAt < firstStateAt,
      'session/prompt 必须先于本轮的 state_update 返回',
    )
    const completed = await client.waitForUpdate(({ sessionId, update }) =>
      sessionId === created.result.sessionId
      && update.sessionUpdate === 'state_update'
      && update.state === 'idle')
    assert.equal(completed.update.stopReason, 'end_turn')

    const updates = client.updates.map(({ update }) => update)
    assert.ok(updates.some((update) => update.sessionUpdate === 'user_message' && update.messageId))
    assert.ok(updates.some((update) => update.sessionUpdate === 'state_update' && update.state === 'running'))
    assert.ok(updates.some((update) => update.sessionUpdate === 'agent_message_chunk' && update.messageId))
    assert.ok(updates.some((update) => update.sessionUpdate === 'agent_thought_chunk' && update.messageId))
    assert.ok(updates.some((update) => update.sessionUpdate === 'tool_call_update'))
    assert.ok(!updates.some((update) => update.sessionUpdate === 'tool_call'))

    const locked = await client.call('session/set_config_option', {
      sessionId: created.result.sessionId,
      configId: 'openpipal.role',
      type: 'id',
      value: 'learner',
    })
    assert.equal(locked.error.code, -32000)
    assert.equal(locked.error.message, 'Conversation role is locked after the first message')
    assert.equal(conversations.get(created.result.sessionId).role, 'design')
    const lockedAgain = await client.call('session/set_config_option', {
      sessionId: created.result.sessionId,
      configId: 'openpipal.role',
      type: 'id',
      value: 'learner',
    })
    assert.equal(lockedAgain.error.message, 'Conversation role is locked after the first message')
    client.updates.length = 0
    assert.deepEqual((await client.call('session/prompt', {
      sessionId: created.result.sessionId,
      prompt: [{ type: 'text', text: 'hello v2 after failed role patch' }],
    })).result, {})
    const afterFailedRolePatch = await client.waitForUpdate(({ sessionId, update }) =>
      sessionId === created.result.sessionId
      && update.sessionUpdate === 'state_update'
      && update.state === 'idle')
    assert.equal(afterFailedRolePatch.update.stopReason, 'end_turn')
    assert.equal(conversations.get(created.result.sessionId).role, 'design')

    const cancelSession = await client.call('session/new', { cwd: '/tmp/openpipal-acp-v2-cancel' })
    client.updates.length = 0
    await client.call('session/prompt', {
      sessionId: cancelSession.result.sessionId,
      prompt: [{ type: 'text', text: 'cancel-me' }],
    })
    await client.waitForUpdate(({ sessionId, update }) =>
      sessionId === cancelSession.result.sessionId
      && update.sessionUpdate === 'state_update'
      && update.state === 'running')
    const busySwitch = await client.call('session/set_config_option', {
      sessionId: cancelSession.result.sessionId,
      configId: 'openpipal.role',
      type: 'id',
      value: 'design',
    })
    assert.equal(busySwitch.error.code, -32600)
    assert.match(busySwitch.error.message, /already processing a prompt/)
    assert.equal(conversations.get(cancelSession.result.sessionId).role, 'learner')
    client.notify('session/cancel', { sessionId: cancelSession.result.sessionId })
    const cancelled = await client.waitForUpdate(({ sessionId, update }) =>
      sessionId === cancelSession.result.sessionId
      && update.sessionUpdate === 'state_update'
      && update.state === 'idle')
    assert.equal(cancelled.update.stopReason, 'cancelled')

    const errorSession = await client.call('session/new', { cwd: '/tmp/openpipal-acp-v2-error' })
    client.updates.length = 0
    assert.deepEqual((await client.call('session/prompt', {
      sessionId: errorSession.result.sessionId,
      prompt: [{ type: 'text', text: 'sse-error' }],
    })).result, {})
    const failed = await client.waitForUpdate(({ sessionId, update }) =>
      sessionId === errorSession.result.sessionId
      && update.sessionUpdate === 'state_update'
      && update.state === 'idle')
    assert.equal(failed.update.stopReason, '_openpipal_error')
    const errorUpdates = client.updates.filter(({ sessionId }) => sessionId === errorSession.result.sessionId)
    assert.equal(countUpdateText(errorUpdates, 'mock stream failure'), 1)

    const eofSession = await client.call('session/new', { cwd: '/tmp/openpipal-acp-v2-eof' })
    client.updates.length = 0
    assert.deepEqual((await client.call('session/prompt', {
      sessionId: eofSession.result.sessionId,
      prompt: [{ type: 'text', text: 'eof-without-done' }],
    })).result, {})
    const unexpectedEof = await client.waitForUpdate(({ sessionId, update }) =>
      sessionId === eofSession.result.sessionId
      && update.sessionUpdate === 'state_update'
      && update.state === 'idle')
    assert.equal(unexpectedEof.update.stopReason, '_openpipal_error')
    const eofUpdates = client.updates.filter(({ sessionId }) => sessionId === eofSession.result.sessionId)
    assert.equal(countUpdateText(eofUpdates, 'ended before the terminal done event'), 1)

    // 外部改成自定义 Agent：下一轮开跑前回推 config_option_update
    const driftSessionV2 = await client.call('session/new', { cwd: '/tmp/openpipal-acp-v2-drift' })
    conversations.get(driftSessionV2.result.sessionId).workspaceId = CUSTOM_AGENT_ID
    client.updates.length = 0
    await client.call('session/prompt', {
      sessionId: driftSessionV2.result.sessionId,
      prompt: [{ type: 'text', text: 'drift check v2' }],
    })
    await client.waitForUpdate(({ sessionId, update }) =>
      sessionId === driftSessionV2.result.sessionId
      && update.sessionUpdate === 'state_update'
      && update.state === 'idle')
    const driftV2Index = client.updates.findIndex(({ update }) => update.sessionUpdate === 'config_option_update')
    assert.ok(driftV2Index >= 0, 'v2 必须回推 config_option_update')
    assert.equal(
      client.updates[driftV2Index].update.configOptions[0].currentValue,
      `agent:${CUSTOM_AGENT_ID}`,
    )
    // 回推必须早于本轮的 user_message ack——客户端在看到回答前就该知道换人了
    const ackIndex = client.updates.findIndex(({ update }) => update.sessionUpdate === 'user_message')
    assert.ok(driftV2Index < ackIndex, '回推必须发生在本轮 user_message 之前')

    // 裁决送不回去时，必须如实说"没送到"，不许假称已拒绝——后者会让用户以为
    // 桌面端已经解锁，实际它还在等自己的长超时
    const failSession = await client.call('session/new', { cwd: '/tmp/openpipal-acp-v2-permission-fail' })
    failPermissionResponses = true
    client.updates.length = 0
    await client.call('session/prompt', {
      sessionId: failSession.result.sessionId,
      prompt: [{ type: 'text', text: 'needs-permission' }],
    })
    // 注意这里**不会**有 idle：裁决没送到，桌面端还在等它自己的长超时，这一轮本来
    // 就该停在那儿。测的是"用户被如实告知"，不是"这一轮自己好了"。
    await waitFor(
      () => countUpdateText(client.updates, '授权没能送回 OpenPipal') === 1,
      '裁决送不到时的如实告知',
    )
    assert.equal(countUpdateText(client.updates, '已自动拒绝'), 0)
    failPermissionResponses = false
    // 收尾：取消这一轮，并放掉服务端那条还在等裁决的流
    client.notify('session/cancel', { sessionId: failSession.result.sessionId })
    permissionWaiters.shift()?.()
    await client.waitForUpdate(({ sessionId, update }) =>
      sessionId === failSession.result.sessionId
      && update.sessionUpdate === 'state_update'
      && update.state === 'idle', 10_000)

    // 用户把授权框晾着不管：session/cancel 必须能把这一轮拉回来，不能永远挂着
    const holdSession = await client.call('session/new', { cwd: '/tmp/openpipal-acp-v2-permission-hold' })
    client.setHoldPermission(true)
    client.updates.length = 0
    await client.call('session/prompt', {
      sessionId: holdSession.result.sessionId,
      prompt: [{ type: 'text', text: 'needs-permission' }],
    })
    await client.waitForUpdate(({ sessionId, update }) =>
      sessionId === holdSession.result.sessionId
      && update.sessionUpdate === 'state_update'
      && update.state === 'requires_action')
    client.notify('session/cancel', { sessionId: holdSession.result.sessionId })
    const holdIdle = await client.waitForUpdate(({ sessionId, update }) =>
      sessionId === holdSession.result.sessionId
      && update.sessionUpdate === 'state_update'
      && update.state === 'idle', 10_000)
    assert.equal(holdIdle.update.stopReason, 'cancelled')
    // 而且被晾着的那一轮也要把"拒绝"送回桌面端,否则桌面端一直等
    assert.ok(
      permissionDecisions.some((decision) => decision.approved === false),
      '取消之后必须把拒绝回传桌面端',
    )
    client.setHoldPermission(false)
    permissionWaiters.shift()?.()

    // 自定义 Agent：出现在 configOptions、能选中、开聊后锁定
    const agentSessionV2 = await client.call('session/new', { cwd: '/tmp/openpipal-acp-v2-agent' })
    const agentValue = `agent:${CUSTOM_AGENT_ID}`
    assert.ok(
      agentSessionV2.result.configOptions[0].options.some((option) => option.value === agentValue),
      'v2 configOptions 必须同时列出内置角色和已保存的 Agent',
    )
    const pickedAgent = await client.call('session/set_config_option', {
      sessionId: agentSessionV2.result.sessionId,
      configId: 'openpipal.role',
      type: 'id',
      value: agentValue,
    })
    assert.equal(pickedAgent.result.configOptions[0].currentValue, agentValue)
    assert.equal(conversations.get(agentSessionV2.result.sessionId).workspaceId, CUSTOM_AGENT_ID)

    // resume 后人格以磁盘为准，不靠适配器内存里那份
    await client.call('session/close', { sessionId: agentSessionV2.result.sessionId })
    const resumedAgent = await client.call('session/resume', {
      sessionId: agentSessionV2.result.sessionId,
      cwd: '/tmp/openpipal-acp-v2-agent',
    })
    assert.equal(resumedAgent.result.configOptions[0].currentValue, agentValue)

    await client.call('session/prompt', {
      sessionId: agentSessionV2.result.sessionId,
      prompt: [{ type: 'text', text: 'hello custom agent' }],
    })
    await client.waitForUpdate(({ sessionId, update }) =>
      sessionId === agentSessionV2.result.sessionId
      && update.sessionUpdate === 'state_update'
      && update.state === 'idle')
    const lockedAgent = await client.call('session/set_config_option', {
      sessionId: agentSessionV2.result.sessionId,
      configId: 'openpipal.role',
      type: 'id',
      value: 'learner',
    })
    assert.equal(lockedAgent.error.code, -32000)
    assert.match(lockedAgent.error.message, /locked after the first message/)
    assert.equal(conversations.get(agentSessionV2.result.sessionId).workspaceId, CUSTOM_AGENT_ID)

    // 授权往返（v2）：requires_action → 客户端裁决 → running，并且 allow_always
    // 必须映射成桌面端的"本次会话允许"
    const grantSession = await client.call('session/new', { cwd: '/tmp/openpipal-acp-v2-permission' })
    const grantDecisionStart = permissionDecisions.length
    const grantRequestStart = client.inboundRequests.length
    client.updates.length = 0
    client.setPermissionOutcome('allow_always')
    await client.call('session/prompt', {
      sessionId: grantSession.result.sessionId,
      prompt: [{ type: 'text', text: 'needs-permission' }],
    })
    const granted = await client.waitForUpdate(({ sessionId, update }) =>
      sessionId === grantSession.result.sessionId
      && update.sessionUpdate === 'state_update'
      && update.state === 'idle')
    assert.equal(granted.update.stopReason, 'end_turn')
    const askedV2 = client.inboundRequests.slice(grantRequestStart)
    assert.equal(askedV2.length, 1)
    assert.equal(askedV2[0].params.title, 'execute_command 需要授权')
    assert.equal(askedV2[0].params.subject.type, 'tool_call')
    assert.ok(askedV2[0].params.subject.toolCall.toolCallId)
    assert.match(askedV2[0].params.description, /这条命令会删文件/)
    const grantStates = client.updates
      .filter(({ sessionId, update }) => sessionId === grantSession.result.sessionId
        && update.sessionUpdate === 'state_update')
      .map(({ update }) => update.state)
    assert.deepEqual(grantStates, ['running', 'requires_action', 'running', 'idle'])
    const [grantDecision] = permissionDecisions.slice(grantDecisionStart)
    assert.equal(grantDecision.approved, true)
    assert.equal(grantDecision.sessionApprove, true)

    // 客户端取消 = 拒绝，而且照样回传桌面端（不回传这一轮会永远挂着）
    const denySession = await client.call('session/new', { cwd: '/tmp/openpipal-acp-v2-permission-deny' })
    const denyDecisionStart = permissionDecisions.length
    client.setPermissionOutcome(null)
    await client.call('session/prompt', {
      sessionId: denySession.result.sessionId,
      prompt: [{ type: 'text', text: 'needs-permission' }],
    })
    await client.waitForUpdate(({ sessionId, update }) =>
      sessionId === denySession.result.sessionId
      && update.sessionUpdate === 'state_update'
      && update.state === 'idle')
    const [denyDecision] = permissionDecisions.slice(denyDecisionStart)
    assert.equal(denyDecision.approved, false)
    assert.equal(denyDecision.sessionApprove, false)
    client.setPermissionOutcome('allow_once')

    conversations.set('desktop-not-acp', {
      id: 'desktop-not-acp',
      title: '普通桌面对话',
      role: 'learner',
      config: { workingDir: '/tmp/openpipal-acp-v2' },
      createdAt: Date.now(),
      updatedAt: Date.now(),
      messages: [],
    })
    const listed = await client.call('session/list', { cwd: '/tmp/openpipal-acp-v2' })
    assert.equal(listed.result.sessions.length, 1)

    await client.call('session/close', { sessionId: created.result.sessionId })
    client.updates.length = 0
    const resumed = await client.call('session/resume', {
      sessionId: created.result.sessionId,
      cwd: '/tmp/openpipal-acp-v2',
      replayFrom: { type: 'start' },
    })
    assert.ok(resumed.result.configOptions)
    assert.ok(client.updates.some(({ update }) => update.sessionUpdate === 'user_message'))
    assert.ok(client.updates.some(({ update }) => update.sessionUpdate === 'agent_message'))

    await client.call('session/delete', { sessionId: created.result.sessionId })
    // v2：流式产物走 tool_call_content_chunk，追加到当前这次工具调用上
    const artifactSession = await client.call('session/new', { cwd: '/tmp/openpipal-acp-v2-artifact' })
    client.updates.length = 0
    await client.call('session/prompt', {
      sessionId: artifactSession.result.sessionId,
      prompt: [{ type: 'text', text: 'stream-artifact' }],
    })
    await client.waitForUpdate(({ sessionId, update }) =>
      sessionId === artifactSession.result.sessionId
      && update.sessionUpdate === 'state_update'
      && update.state === 'idle')
    const toolCallId = client.updates
      .find(({ update }) => update.sessionUpdate === 'tool_call_update' && update.title === 'create_artifact')
      ?.update.toolCallId
    assert.ok(toolCallId, 'v2 必须先建这次工具调用')
    const chunks = client.updates
      .filter(({ update }) => update.sessionUpdate === 'tool_call_content_chunk')
      .map(({ update }) => {
        assert.equal(update.toolCallId, toolCallId, 'chunk 必须挂在同一次工具调用上')
        return update.content.content.text
      })
    // 空 delta（开面板信号）不该产出 chunk；收尾摘要作为最后一条 chunk 追加
    assert.deepEqual(chunks, ['<h1>', 'Hello</h1>', 'artifact created'])
    // v2 的 content 是**替换**语义：流过正文的调用收尾时绝不能再带 content，
    // 否则用户看着写出来的产物会在最后一帧被一行摘要抹掉
    const completion = client.updates
      .filter(({ update }) => update.sessionUpdate === 'tool_call_update' && update.status === 'completed')
      .at(-1)
    assert.ok(completion, '必须有一条 completed')
    assert.equal(completion.update.content, undefined, '流过正文的工具调用收尾不许带 content')
    // 空 delta 也不许退化成一条空的助手消息（那是把正文换成了噪音）
    assert.equal(
      client.updates.filter(({ update }) => update._meta?.['openpipal.io/artifact_delta']
        && update.sessionUpdate === 'agent_message_chunk').length,
      0,
      'v2 下 artifact_delta 不该落到 agent_message_chunk 兜底',
    )

    // 常驻推送：桌面端改人格，**不发任何 prompt**，编辑器就收到 config_option_update
    await waitFor(() => eventSubscribers.size > 0, 'v2 适配器订阅推送通道')
    const pushSession = await client.call('session/new', { cwd: '/tmp/openpipal-acp-v2-push' })
    const pushStreamStart = dynamicRequests.length
    client.updates.length = 0
    await patchConversation(pushSession.result.sessionId, { workspaceId: CUSTOM_AGENT_ID })
    const pushed = await client.waitForUpdate(({ sessionId, update }) =>
      sessionId === pushSession.result.sessionId
      && update.sessionUpdate === 'config_option_update')
    assert.equal(pushed.update.configOptions[0].currentValue, `agent:${CUSTOM_AGENT_ID}`)
    assert.equal(
      dynamicRequests.slice(pushStreamStart).filter((r) => r.pathname === '/chat/stream').length,
      0,
      '推送不该依赖任何一轮对话',
    )
    // 换人格就是换技能：推送这条路此前只推了人格，编辑器的斜杠菜单还停在上一个人格
    // 建会话那次的命令列表是异步发的，可能排在清空之后——按内容认，别按顺序认
    const pushedCommands = await client.waitForUpdate(({ sessionId, update }) =>
      sessionId === pushSession.result.sessionId
      && update.sessionUpdate === 'available_commands_update'
      && update.availableCommands.some((command) => command.name === 'contract-review'))
    assert.deepEqual(
      pushedCommands.update.availableCommands.map((command) => command.name),
      ['goal', 'contract-review'],
      '推送换人格后必须重报命令列表',
    )

    // 编辑器连上之后才存的 Agent：initialize 拉的那张表里没有它，认不出就得重拉一次。
    // 修之前这里会被判成非法值直接拒绝，绑着它的会话还会被报成"第一个内置角色"。
    lateAgentSaved = true
    const lateSession = await client.call('session/new', { cwd: '/tmp/openpipal-acp-v2-late-agent' })
    const lateSwitch = await client.call('session/set_config_option', {
      sessionId: lateSession.result.sessionId,
      configId: 'openpipal.role',
      type: 'id',
      value: `agent:${LATE_AGENT_ID}`,
    })
    assert.ok(!lateSwitch.error, `新存的 Agent 必须能切过去: ${JSON.stringify(lateSwitch.error)}`)
    assert.equal(lateSwitch.result.configOptions[0].currentValue, `agent:${LATE_AGENT_ID}`)
    assert.ok(
      lateSwitch.result.configOptions[0].options.some((option) => option.value === `agent:${LATE_AGENT_ID}`),
      '刷新后的清单里必须有这个 Agent',
    )

    // 换人格后命令列表必须跟着换：自定义 Agent 只带它自己的技能
    const commandSession = await client.call('session/new', { cwd: '/tmp/openpipal-acp-v2-commands' })
    const globalCommands = await client.waitForUpdate(({ sessionId, update }) =>
      sessionId === commandSession.result.sessionId
      && update.sessionUpdate === 'available_commands_update')
    assert.deepEqual(
      globalCommands.update.availableCommands.map((command) => command.name),
      ['goal', 'learner-drill', 'docx-render', 'web-research'],
    )

    client.updates.length = 0
    await client.call('session/set_config_option', {
      sessionId: commandSession.result.sessionId,
      configId: 'openpipal.role',
      type: 'id',
      value: `agent:${CUSTOM_AGENT_ID}`,
    })
    const agentCommands = await client.waitForUpdate(({ sessionId, update }) =>
      sessionId === commandSession.result.sessionId
      && update.sessionUpdate === 'available_commands_update')
    assert.deepEqual(
      agentCommands.update.availableCommands.map((command) => command.name),
      ['goal', 'contract-review'],
    )

    // 只有一个命令名、没有补充说明时用兜底句
    const v2CommandStart = dynamicRequests.length
    await client.call('session/prompt', {
      sessionId: commandSession.result.sessionId,
      prompt: [{ type: 'text', text: '/contract-review' }],
    })
    await client.waitForUpdate(({ sessionId, update }) =>
      sessionId === commandSession.result.sessionId
      && update.sessionUpdate === 'state_update'
      && update.state === 'idle')
    assert.equal(
      dynamicRequests.slice(v2CommandStart).find((r) => r.pathname === '/chat/stream').body.messages.at(-1).content,
      '请使用技能 <skill-request>contract-review</skill-request> 来帮我完成',
    )

    // /goal：改会话状态，不进模型，也不占一轮对话
    const goalSession = await client.call('session/new', { cwd: '/tmp/openpipal-acp-v2-goal' })
    const goalCommands = await client.waitForUpdate(({ sessionId, update }) =>
      sessionId === goalSession.result.sessionId
      && update.sessionUpdate === 'available_commands_update')
    assert.equal(goalCommands.update.availableCommands[0].name, 'goal', 'goal 应排在技能之前')

    const goalStreamStart = dynamicRequests.length
    client.updates.length = 0
    await client.call('session/prompt', {
      sessionId: goalSession.result.sessionId,
      prompt: [{ type: 'text', text: '/goal 把周报写完并自检通过' }],
    })
    await client.waitForUpdate(({ sessionId, update }) =>
      sessionId === goalSession.result.sessionId
      && update.sessionUpdate === 'state_update'
      && update.state === 'idle')
    assert.equal(
      conversations.get(goalSession.result.sessionId).config.goal.text,
      '把周报写完并自检通过',
    )
    assert.equal(conversations.get(goalSession.result.sessionId).config.goal.maxTurns, 8)
    // 不进模型：这一轮不该有 /chat/stream
    assert.equal(
      dynamicRequests.slice(goalStreamStart).filter((r) => r.pathname === '/chat/stream').length,
      0,
      '/goal 不该触发一轮对话',
    )
    assert.equal(countUpdateText(client.updates, '目标已设定'), 1)

    client.updates.length = 0
    await client.call('session/prompt', {
      sessionId: goalSession.result.sessionId,
      prompt: [{ type: 'text', text: '/goal show' }],
    })
    await client.waitForUpdate(({ sessionId, update }) =>
      sessionId === goalSession.result.sessionId
      && update.sessionUpdate === 'state_update'
      && update.state === 'idle')
    assert.equal(countUpdateText(client.updates, '把周报写完并自检通过'), 1)

    client.updates.length = 0
    await client.call('session/prompt', {
      sessionId: goalSession.result.sessionId,
      prompt: [{ type: 'text', text: '/goal clear' }],
    })
    await client.waitForUpdate(({ sessionId, update }) =>
      sessionId === goalSession.result.sessionId
      && update.sessionUpdate === 'state_update'
      && update.state === 'idle')
    assert.equal(conversations.get(goalSession.result.sessionId).config.goal, undefined)

    // 本来就没目标时再清一次：不许写盘（白 bump updatedAt 会把 session/list 的游标带偏）
    const goalConversation = conversations.get(goalSession.result.sessionId)
    const untouchedAt = goalConversation.updatedAt
    client.updates.length = 0
    await client.call('session/prompt', {
      sessionId: goalSession.result.sessionId,
      prompt: [{ type: 'text', text: '/goal clear' }],
    })
    await client.waitForUpdate(({ sessionId, update }) =>
      sessionId === goalSession.result.sessionId
      && update.sessionUpdate === 'state_update'
      && update.state === 'idle')
    assert.equal(goalConversation.updatedAt, untouchedAt, '没目标可清就不该写盘')

    // 并行工具调用：模型一条回复里发两个 tool_use，结果不许串位
    const parallelSession = await client.call('session/new', { cwd: '/tmp/openpipal-acp-v2-parallel' })
    client.updates.length = 0
    await client.call('session/prompt', {
      sessionId: parallelSession.result.sessionId,
      prompt: [{ type: 'text', text: 'parallel-tools' }],
    })
    await client.waitForUpdate(({ sessionId, update }) =>
      sessionId === parallelSession.result.sessionId
      && update.sessionUpdate === 'state_update'
      && update.state === 'idle')
    const started = client.updates
      .filter(({ update }) => update.sessionUpdate === 'tool_call_update' && update.status === 'in_progress')
      .map(({ update }) => update.toolCallId)
    assert.equal(started.length, 2, '两条 tool_start 应各自开一次调用')
    assert.equal(new Set(started).size, 2, '两次调用不许共用同一个 toolCallId')
    const finishedCalls = client.updates
      .filter(({ update }) => update.sessionUpdate === 'tool_call_update' && update.status === 'completed')
    assert.deepEqual(
      finishedCalls.map(({ update }) => [update.toolCallId, update.content?.[0]?.content?.text]),
      [[started[0], 'A 的结果'], [started[1], 'B 的结果']],
      '每个工具的结果必须回到自己那次调用上',
    )

    // session/list 分页：keyset 游标，翻完不漏不重不死循环
    const PAGE_CWD = '/tmp/openpipal-acp-v2-paging'
    const PAGED_TOTAL = 120
    for (let i = 0; i < PAGED_TOTAL; i++) {
      const id = `paged-${String(i).padStart(3, '0')}`
      conversations.set(id, {
        id,
        title: `[ACP] paged ${i}`,
        role: 'learner',
        // 成对共享同一个 createdAt——专门压破平键：没有破平键的排序会漏条
        config: { workingDir: PAGE_CWD, acp: { adapter: 'openpipal-acp' } },
        createdAt: 1000 + Math.floor(i / 2),
        updatedAt: 5000 + i,
        messages: [],
      })
    }

    const seen = []
    let pageCursor
    let pages = 0
    do {
      const listResponse = await client.call('session/list', {
        cwd: PAGE_CWD,
        ...(pageCursor ? { cursor: pageCursor } : {}),
      })
      assert.ok(!listResponse.error, `session/list 分页出错: ${JSON.stringify(listResponse.error)}`)
      assert.ok(listResponse.result.sessions.length <= 50, '单页不得超过 50 条')
      seen.push(...listResponse.result.sessions.map((session) => session.sessionId))
      pageCursor = listResponse.result.nextCursor
      pages += 1
      assert.ok(pages <= 5, 'session/list 分页必须收敛，不能翻不完')
      // 翻页途中把还没读到的那些"改一下"——`/goal` 写一次、PATCH 一次 config 都会这样。
      // 游标要是钉在 updatedAt 上，这些行会跳到游标前面去，之后哪一页都不再返回它们。
      for (const conversation of conversations.values()) {
        if (conversation.id.startsWith('paged-')) conversation.updatedAt = Date.now()
      }
    } while (pageCursor)

    assert.equal(pages, 3, '120 条 / 每页 50 → 3 页')
    assert.equal(seen.length, PAGED_TOTAL, '翻完必须一条不漏（翻页途中被改过也不许漏）')
    assert.equal(new Set(seen).size, PAGED_TOTAL, '翻完必须一条不重')
    // 降序 + id 升序破平：最新那一对里 id 小的在前
    assert.deepEqual(seen.slice(0, 2), ['paged-118', 'paged-119'])

    const badCursor = await client.call('session/list', { cwd: PAGE_CWD, cursor: 'not-a-real-cursor' })
    assert.equal(badCursor.error.code, -32602)
    assert.match(badCursor.error.message, /Invalid session\/list cursor/)

    console.log('✓ ACP v2 draft lifecycle')
  } finally {
    client.stop()
  }
}

/**
 * 编辑器结束适配器的方式是关 stdio，不发信号。常驻推送通道握着活 handle，
 * 不显式收摊就会留下孤儿进程 —— 这条用真进程验，不看代码。
 */
async function testShutdownOnStdinClose() {
  const client = launch({ OPENPIPAL_ACP_V2: '1' })
  try {
    await client.call('initialize', {
      protocolVersion: 2,
      info: { name: 'openpipal-smoke-shutdown', version: '1.0.0' },
      capabilities: {},
    })
    await waitFor(() => eventSubscribers.size > 0, '常驻通道建立')

    const exited = new Promise((resolve) => client.child.once('exit', resolve))
    client.child.stdin.end()
    const timedOut = Symbol('timeout')
    const result = await Promise.race([
      exited,
      new Promise((resolve) => setTimeout(() => resolve(timedOut), 5_000)),
    ])
    assert.notEqual(result, timedOut, '关掉 stdin 之后适配器必须自己退出，不能变成孤儿进程')
    await waitFor(() => eventSubscribers.size === 0, '桌面端那侧的订阅要跟着回收')
    console.log('✓ ACP 适配器随 stdio 关闭收摊')
  } finally {
    client.stop()
  }
}

try {
  await testV1()
  await testV2()
  await testShutdownOnStdinClose()
  assert.ok(dynamicRequests.length > 0, 'protocol smoke must exercise authenticated dynamic routes')
  for (const request of dynamicRequests) {
    assert.equal(
      request.token,
      SMOKE_TOKEN,
      `${request.method} ${request.pathname} must carry the fixed smoke authorization token`,
    )
  }
  const exercisedPaths = new Set(dynamicRequests.map((request) => request.pathname))
  for (const requiredPath of ['/api/agents/list', '/api/conversations', '/chat/stream', '/api/permission', '/api/skills']) {
    assert.ok(exercisedPaths.has(requiredPath), `protocol smoke did not exercise ${requiredPath}`)
  }
  assert.ok(!exercisedPaths.has('/role/switch'), 'ACP role selection must not mutate the desktop global role')
  assert.ok(dynamicRequests.some((request) => (
    request.method === 'PATCH'
    && /^\/api\/conversations\/[^/]+$/.test(request.pathname)
    && request.body?.role === 'design'
  )), 'protocol smoke did not persist a conversation-scoped role')
} finally {
  for (const subscriber of eventSubscribers) { try { subscriber.end() } catch { /* ignore */ } }
  eventSubscribers.clear()
  await new Promise((resolve) => server.close(resolve))
  rmSync(smokeHome, { recursive: true, force: true })
}

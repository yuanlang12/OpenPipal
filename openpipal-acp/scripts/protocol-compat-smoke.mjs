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
const SMOKE_TOKEN = 's'.repeat(43)
const dynamicRequests = []

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
    'Failed to update conversation role',
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
      agents: [],
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
    const init = await client.call('initialize', { protocolVersion: 1, clientCapabilities: {} })
    assert.equal(init.result.protocolVersion, 1)
    assert.ok(init.result.agentCapabilities)

    const created = await client.call('session/new', { cwd: '/tmp/openpipal-acp-v1', mcpServers: [] })
    assert.ok(created.result.sessionId)
    assert.ok(created.result.modes)
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
    assert.equal(client.events[promptEventStart], 'response:session/prompt')
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
    assert.equal(failed.update.stopReason, 'error')
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
    assert.equal(unexpectedEof.update.stopReason, 'error')
    const eofUpdates = client.updates.filter(({ sessionId }) => sessionId === eofSession.result.sessionId)
    assert.equal(countUpdateText(eofUpdates, 'ended before the terminal done event'), 1)

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
    console.log('✓ ACP v2 draft lifecycle')
  } finally {
    client.stop()
  }
}

try {
  await testV1()
  await testV2()
  assert.ok(dynamicRequests.length > 0, 'protocol smoke must exercise authenticated dynamic routes')
  for (const request of dynamicRequests) {
    assert.equal(
      request.token,
      SMOKE_TOKEN,
      `${request.method} ${request.pathname} must carry the fixed smoke authorization token`,
    )
  }
  const exercisedPaths = new Set(dynamicRequests.map((request) => request.pathname))
  for (const requiredPath of ['/api/agents/list', '/api/conversations', '/chat/stream']) {
    assert.ok(exercisedPaths.has(requiredPath), `protocol smoke did not exercise ${requiredPath}`)
  }
  assert.ok(!exercisedPaths.has('/role/switch'), 'ACP role selection must not mutate the desktop global role')
  assert.ok(dynamicRequests.some((request) => (
    request.method === 'PATCH'
    && /^\/api\/conversations\/[^/]+$/.test(request.pathname)
    && request.body?.role === 'design'
  )), 'protocol smoke did not persist a conversation-scoped role')
} finally {
  await new Promise((resolve) => server.close(resolve))
  rmSync(smokeHome, { recursive: true, force: true })
}

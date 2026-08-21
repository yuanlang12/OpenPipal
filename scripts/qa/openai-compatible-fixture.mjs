#!/usr/bin/env node

import http from 'node:http'
import process from 'node:process'
import { Buffer } from 'node:buffer'
import { URL, pathToFileURL } from 'node:url'

export const QA_PROVIDER_HOST = '127.0.0.1'
export const QA_PROVIDER_MODEL = 'openpipal-qa-fixture'
export const QA_PROVIDER_TOKEN = 'openpipal-qa-only'
export const QA_PROVIDER_DEFAULT_PORT = 40421
export const QA_PROVIDER_MAX_BODY_BYTES = 8 * 1024 * 1024

const DESIGN_MARKER = 'QA_DESIGN_ARTIFACT'
const DESIGN_TOOL_CALL_PREFIX = 'call-openpipal-qa-artifact-'
const DESIGN_ARTIFACT_ARGS = Object.freeze({
  type: 'svg',
  title: 'OpenPipal QA Design Artifact',
  language: 'svg',
  content: [
    '<svg xmlns="http://www.w3.org/2000/svg" width="720" height="420" viewBox="0 0 720 420">',
    '<rect width="720" height="420" rx="32" fill="#111827"/>',
    '<circle cx="116" cy="112" r="44" fill="#8b5cf6"/>',
    '<path d="M96 112h40M116 92v40" stroke="#fff" stroke-width="8" stroke-linecap="round"/>',
    '<text x="72" y="218" fill="#f9fafb" font-size="40" font-family="system-ui, sans-serif" font-weight="700">OpenPipal QA</text>',
    '<text x="72" y="270" fill="#c4b5fd" font-size="24" font-family="system-ui, sans-serif">Design Agent artifact round-trip</text>',
    '<text x="72" y="330" fill="#9ca3af" font-size="18" font-family="system-ui, sans-serif">Deterministic local fixture · no external network</text>',
    '</svg>'
  ].join('')
})

function messageText(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter((part) => part && typeof part === 'object' && (part.type === 'text' || part.type === 'input_text'))
    .map((part) => String(part.text || ''))
    .join('\n')
}

function hasCreateArtifactTool(body) {
  return Array.isArray(body?.tools) && body.tools.some((tool) => {
    const name = tool?.function?.name || tool?.name
    return name === 'create_artifact'
  })
}

function hasDesignToolResult(body) {
  if (!Array.isArray(body?.messages) || body.messages.length < 2) return false
  const result = body.messages.at(-1)
  const assistant = body.messages.at(-2)
  const toolCallId = result?.tool_call_id
  if (result?.role !== 'tool' || typeof toolCallId !== 'string' || !toolCallId.startsWith(DESIGN_TOOL_CALL_PREFIX)) {
    return false
  }
  if (assistant?.role !== 'assistant' || !Array.isArray(assistant.tool_calls)) return false
  return assistant.tool_calls.some((call) =>
    call?.id === toolCallId && call?.function?.name === 'create_artifact'
  )
}

/**
 * 本轮的用户文本 = 末尾那一串**连续**的 user 消息。
 *
 * 不能只取最后一条：OpenPipal 会在用户消息之后再追一条 runtime-context 快照（同样是
 * user 角色，为了前缀缓存必须排在末尾），只取最后一条会永远读到那条快照。
 * 也不能无脑往前翻：中间隔着 assistant / tool 的那些是**上一轮**的输入，翻到它们会把
 * 旧标记误当成新一轮的意图（见"不把旧的/未配对 tool result 当新一轮"的用例）。
 * 连续段的边界正好把这两件事分开。
 */
function latestUserText(body) {
  if (!Array.isArray(body?.messages)) return ''
  let index = body.messages.length - 1
  // 末尾挂着的 tool 结果不算边界：它是上一次工具调用的回执，不该把本轮输入挡住
  while (index >= 0 && body.messages[index]?.role === 'tool') index -= 1
  const texts = []
  for (; index >= 0; index -= 1) {
    const message = body.messages[index]
    if (message?.role !== 'user') break
    texts.push(messageText(message.content))
  }
  return texts.join('\n')
}

export function classifyQaRequest(body) {
  if (hasDesignToolResult(body)) return 'design-final'
  if (latestUserText(body).includes(DESIGN_MARKER) && hasCreateArtifactTool(body)) return 'design-tool'
  return 'text'
}

/** 把 tool 参数切成若干片，模拟服务商的增量投递（拼回去必须与原串完全一致） */
export function splitArguments(serialized, pieces = 4) {
  const size = Math.max(1, Math.ceil(serialized.length / pieces))
  const fragments = []
  for (let offset = 0; offset < serialized.length; offset += size) {
    fragments.push(serialized.slice(offset, offset + size))
  }
  return fragments.length > 0 ? fragments : ['']
}

function baseChunk(id) {
  return {
    id,
    object: 'chat.completion.chunk',
    created: 1,
    model: QA_PROVIDER_MODEL
  }
}

export function createQaCompletionChunks(body, requestNumber = 1) {
  const mode = classifyQaRequest(body)
  const id = `chatcmpl-openpipal-qa-${requestNumber}`
  const base = baseChunk(id)

  if (mode === 'design-tool') {
    const toolCallId = `${DESIGN_TOOL_CALL_PREFIX}${requestNumber}`
    // 真实服务商是把 tool 参数**分片流式**发过来的，一次性发完的 fixture 测不出
    // 任何依赖增量的链路（产物边写边显示、ACP 的 tool_call_content_chunk）。
    const argumentFragments = splitArguments(JSON.stringify(DESIGN_ARTIFACT_ARGS))
    return {
      mode,
      chunks: [
        {
          ...base,
          choices: [{
            index: 0,
            delta: {
              role: 'assistant',
              tool_calls: [{
                index: 0,
                id: toolCallId,
                type: 'function',
                function: {
                  name: 'create_artifact',
                  arguments: argumentFragments[0]
                }
              }]
            },
            finish_reason: null
          }]
        },
        ...argumentFragments.slice(1).map((fragment) => ({
          ...base,
          choices: [{
            index: 0,
            delta: { tool_calls: [{ index: 0, function: { arguments: fragment } }] },
            finish_reason: null
          }]
        })),
        { ...base, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
        { ...base, choices: [], usage: { prompt_tokens: 64, completion_tokens: 48, total_tokens: 112 } }
      ]
    }
  }

  const content = mode === 'design-final'
    ? 'OpenPipal QA Design tool result received. Verify the artifact in the UI and isolated data root.'
    : 'OpenPipal QA response: runtime round-trip completed.'

  return {
    mode,
    chunks: [
      { ...base, choices: [{ index: 0, delta: { role: 'assistant', content }, finish_reason: null }] },
      { ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
      { ...base, choices: [], usage: { prompt_tokens: 32, completion_tokens: 12, total_tokens: 44 } }
    ]
  }
}

export function encodeQaSse(chunks) {
  return `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('')}data: [DONE]\n\n`
}

export function isAuthorizedQaRequest(headers) {
  const value = headers?.authorization
  return typeof value === 'string' && value === `Bearer ${QA_PROVIDER_TOKEN}`
}

export function parseQaProviderArgs(argv) {
  let port = QA_PROVIDER_DEFAULT_PORT
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--port') {
      const raw = argv[index + 1]
      if (raw === undefined) throw new Error('--port requires a value')
      port = Number(raw)
      index += 1
      continue
    }
    throw new Error(`Unknown argument: ${arg}`)
  }
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`Invalid port: ${port}`)
  }
  return { port }
}

function sendJson(res, statusCode, value) {
  const body = JSON.stringify(value)
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store'
  })
  res.end(body)
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let total = 0
    let settled = false

    const finish = (fn, value) => {
      if (settled) return
      settled = true
      fn(value)
    }

    req.on('data', (chunk) => {
      if (settled) return
      total += chunk.length
      if (total > QA_PROVIDER_MAX_BODY_BYTES) {
        finish(reject, Object.assign(new Error('request body too large'), { code: 'body_too_large' }))
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (settled) return
      try {
        finish(resolve, JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'))
      } catch {
        finish(reject, Object.assign(new Error('invalid JSON'), { code: 'invalid_json' }))
      }
    })
    req.on('error', (error) => finish(reject, error))
  })
}

export function createQaProviderServer({ onRequest } = {}) {
  let requestNumber = 0
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || '/', `http://${QA_PROVIDER_HOST}`)

      if (req.method === 'GET' && url.pathname === '/health') {
        sendJson(res, 200, { ok: true, provider: QA_PROVIDER_MODEL })
        return
      }

      if (!isAuthorizedQaRequest(req.headers)) {
        sendJson(res, 401, { error: { message: 'QA fixture requires its fixed local token.' } })
        return
      }

      if (req.method === 'GET' && url.pathname === '/v1/models') {
        sendJson(res, 200, { object: 'list', data: [{ id: QA_PROVIDER_MODEL, object: 'model', owned_by: 'openpipal-qa' }] })
        return
      }

      if (req.method !== 'POST' || url.pathname !== '/v1/chat/completions') {
        sendJson(res, 404, { error: { message: 'QA fixture route not found.' } })
        return
      }

      const contentLength = Number(req.headers['content-length'] || 0)
      if (Number.isFinite(contentLength) && contentLength > QA_PROVIDER_MAX_BODY_BYTES) {
        sendJson(res, 413, { error: { message: 'QA fixture request is too large.' } })
        req.resume()
        return
      }

      const body = await readJsonBody(req)
      if (body?.model !== QA_PROVIDER_MODEL) {
        sendJson(res, 400, { error: { message: `Use the fixed QA model: ${QA_PROVIDER_MODEL}` } })
        return
      }

      requestNumber += 1
      const completion = createQaCompletionChunks(body, requestNumber)
      onRequest?.({ requestNumber, mode: completion.mode })
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-store',
        Connection: 'close'
      })
      res.end(encodeQaSse(completion.chunks))
    } catch (error) {
      if (res.headersSent) {
        res.end()
        return
      }
      const statusCode = error?.code === 'body_too_large' ? 413 : 400
      sendJson(res, statusCode, { error: { message: error?.message || 'QA fixture request failed.' } })
    }
  })

  server.requestTimeout = 15_000
  server.headersTimeout = 5_000
  server.keepAliveTimeout = 1_000
  return server
}

export async function startQaProvider({ port = QA_PROVIDER_DEFAULT_PORT, onRequest } = {}) {
  const server = createQaProviderServer({ onRequest })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, QA_PROVIDER_HOST, resolve)
  })
  return server
}

async function runCli() {
  const { port } = parseQaProviderArgs(process.argv.slice(2))
  const server = await startQaProvider({
    port,
    onRequest: ({ requestNumber, mode }) => {
      process.stdout.write(`[OpenPipal QA provider] request=${requestNumber} mode=${mode}\n`)
    }
  })
  const address = server.address()
  const actualPort = typeof address === 'object' && address ? address.port : port
  process.stdout.write(`[OpenPipal QA provider] baseUrl=http://${QA_PROVIDER_HOST}:${actualPort}/v1\n`)
  process.stdout.write(`[OpenPipal QA provider] model=${QA_PROVIDER_MODEL} apiKey=${QA_PROVIDER_TOKEN}\n`)

  const close = () => {
    server.close(() => process.exit(0))
  }
  process.once('SIGINT', close)
  process.once('SIGTERM', close)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCli().catch((error) => {
    process.stderr.write(`[OpenPipal QA provider] failed: ${error?.message || String(error)}\n`)
    process.exitCode = 1
  })
}

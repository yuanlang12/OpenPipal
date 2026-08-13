/**
 * testConnection（config-manager.ts）—— /v1 探测重试的 apiFormat 门控。
 *
 * 背景：shouldRetryWithV1/appendV1 是为 OpenAI 兼容协议设计的探测式补全（baseUrl 通常以
 * /v1 结尾）。Anthropic Messages 协议的 baseUrl 约定正相反——根地址不带 /v1，SDK 内部自己
 * 拼 /v1/messages。如果 apiFormat==='anthropic' 时仍然触发这段"补 /v1 重试"，会把请求越修
 * 越错（变成 <root>/v1/v1/messages）。这里用一个本地假网关（返回 HTML 首页，200，模拟
 * "baseUrl 缺 /v1" 的经典假成功）验证：
 * - apiFormat==='anthropic' → 只打一次，不触发补 /v1 重试
 * - apiFormat 未填（默认 openai 兼容）→ 触发补 /v1 重试，打两次（行为不变，防回归）
 * - apiFormat==='openai-responses' → baseUrl 约定与默认 'openai' 同源（根地址+/v1），
 *   同样应该触发补 /v1 重试，打两次（与 'openai' 同待遇，不应被误列入 anthropic 那条排除名单）
 */
import { describe, it, expect, afterEach } from 'vitest'
import { once } from 'node:events'
import http from 'node:http'
import { buildModelFromConfig, createModelPayloadAdapter, testConnection } from '../../src/main/config-manager'
import { completeSimple } from '@earendil-works/pi-ai/compat'

let activeServer: http.Server | null = null

afterEach(async () => {
  const server = activeServer
  activeServer = null
  if (!server?.listening) return
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

async function listenOnLoopback(server: http.Server): Promise<number> {
  const listening = once(server, 'listening')
  server.listen(0, '127.0.0.1')
  await listening

  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Test gateway did not bind a TCP port')
  return address.port
}

async function startHtmlGateway(): Promise<{ port: number; hits: string[] }> {
  const hits: string[] = []
  const server = http.createServer((req, res) => {
    hits.push(req.url || '')
    res.writeHead(200, { 'Content-Type': 'text/html' })
    res.end('<!doctype html><html><body>SPA shell（模拟 baseUrl 缺 /v1 的网关首页）</body></html>')
  })
  activeServer = server
  const port = await listenOnLoopback(server)
  return { port, hits }
}

async function startSseGateway(): Promise<{ port: number; payloads: Record<string, any>[] }> {
  const payloads: Record<string, any>[] = []
  const server = http.createServer((req, res) => {
    let raw = ''
    req.setEncoding('utf8')
    req.on('data', chunk => { raw += chunk })
    req.on('end', () => {
      payloads.push(JSON.parse(raw || '{}'))
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      const base = { id: 'chatcmpl-test', object: 'chat.completion.chunk', created: 1, model: 'glm-5.2' }
      res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: 'assistant', content: 'OK' }, finish_reason: null }] })}\n\n`)
      res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`)
      res.end('data: [DONE]\n\n')
    })
  })
  activeServer = server
  const port = await listenOnLoopback(server)
  return { port, payloads }
}

describe("testConnection — /v1 探测重试的 apiFormat 门控（anthropic 排除 / openai-responses 同待遇）", () => {
  it('HTML 首页假成功场景下，只打一次（不误补 /v1）', async () => {
    const { port, hits } = await startHtmlGateway()
    const result = await testConnection({
      provider: 'custom',
      apiFormat: 'anthropic',
      baseUrl: `http://127.0.0.1:${port}`,
      apiKey: 'sk-test',
      model: 'claude-test'
    })
    expect(result.ok).toBe(false)
    expect(result.correctedBaseUrl).toBeUndefined()
    expect(hits.length).toBe(1)
  }, 10000)

  it('apiFormat 未填（默认 openai 兼容）：同样的假成功场景会触发补 /v1 重试，打两次（防回归)', async () => {
    const { port, hits } = await startHtmlGateway()
    const result = await testConnection({
      provider: 'custom',
      baseUrl: `http://127.0.0.1:${port}`,
      apiKey: 'sk-test',
      model: 'my-model'
    })
    expect(result.ok).toBe(false)
    expect(hits.length).toBe(2)
  }, 10000)

  it("apiFormat==='openai-responses'：同样的假成功场景也会触发补 /v1 重试，打两次（与 'openai' 同待遇）", async () => {
    const { port, hits } = await startHtmlGateway()
    const result = await testConnection({
      provider: 'custom',
      apiFormat: 'openai-responses',
      baseUrl: `http://127.0.0.1:${port}`,
      apiKey: 'sk-test',
      model: 'gpt-responses-test'
    })
    expect(result.ok).toBe(false)
    expect(hits.length).toBe(2)
  }, 10000)

  it('GLM-5.2 连接测试发新版 Z.AI thinking/tool_stream 载荷，而不是旧 enable_thinking', async () => {
    const { port, payloads } = await startSseGateway()
    const result = await testConnection({
      provider: 'custom',
      apiFormat: 'openai',
      baseUrl: `http://127.0.0.1:${port}/v1`,
      apiKey: 'sk-test',
      model: 'glm-5.2',
      supportsThinking: true,
      supportsImages: false,
      thinkingFormat: 'zai'
    })

    expect(result.ok).toBe(true)
    expect(payloads).toHaveLength(1)
    expect(payloads[0]).toMatchObject({
      model: 'glm-5.2',
      stream: true,
      thinking: { type: 'enabled', clear_thinking: false },
      reasoning_effort: 'low',
      tool_stream: true
    })
    expect(payloads[0].enable_thinking).toBeUndefined()
    expect(payloads[0].tools).toHaveLength(1)
  }, 10000)

  it('Token Plan Qwen3.8 的高档走 Pi 原生 xhigh effort，不混入 Qwen3.7 的 thinking_budget', async () => {
    const { port, payloads } = await startSseGateway()
    const config = {
      provider: 'qwen-token-plan-cn',
      apiFormat: 'openai' as const,
      // 用本地 SSE 网关替代真实服务；provider id 保持 Token Plan，确保走 Pi 原生目录。
      baseUrl: `http://127.0.0.1:${port}/v1`,
      apiKey: 'sk-test',
      model: 'qwen3.8-max-preview',
      supportsThinking: true,
      supportsImages: true
    }
    const model = buildModelFromConfig(config)
    const result = await completeSimple(model, {
      messages: [{ role: 'user', content: 'Hi', timestamp: Date.now() }]
    }, {
      apiKey: config.apiKey,
      maxTokens: 16,
      reasoning: 'high',
      onPayload: createModelPayloadAdapter(config)
    })

    expect(result.stopReason).toBe('stop')
    expect(payloads).toHaveLength(1)
    expect(payloads[0]).toMatchObject({
      model: 'qwen3.8-max-preview',
      stream: true,
      enable_thinking: true,
      reasoning_effort: 'xhigh'
    })
    expect(payloads[0].thinking_budget).toBeUndefined()
  }, 10000)
})

describe('testConnection — errorKey/errorParams（strictly additive: internally-authored text gets a key, external/network text stays keyless）', () => {
  it("HTML 首页假成功场景（本进程自造的 nonApiResponse 文案）→ errorKey='settings.model.errors.nonApiResponse' 带 baseUrl 参数", async () => {
    const { port, hits } = await startHtmlGateway()
    const baseUrl = `http://127.0.0.1:${port}`
    const result = await testConnection({
      provider: 'custom',
      apiFormat: 'anthropic', // 复用 anthropic 门控跳过补 /v1 重试，只打一次，errorKey 更好断言
      baseUrl,
      apiKey: 'sk-test',
      model: 'claude-test'
    })
    expect(result.ok).toBe(false)
    expect(hits.length).toBe(1)
    expect(result.errorKey).toBe('settings.model.errors.nonApiResponse')
    expect(result.errorParams).toEqual({ baseUrl })
    // error 字段本身保持原样（老 HTTP shim / 日志消费方不受影响）
    expect(result.error).toContain(baseUrl)
  }, 10000)

  it('无法连接（ECONNREFUSED，非本进程自造文案）→ 不带 errorKey，原始诊断文本原样透传', async () => {
    const result = await testConnection({
      provider: 'custom',
      baseUrl: 'http://127.0.0.1:1',
      apiKey: 'sk-test',
      model: 'unreachable-model'
    })
    expect(result.ok).toBe(false)
    expect(result.error).toBeTruthy()
    expect(result.errorKey).toBeUndefined()
    expect(result.errorParams).toBeUndefined()
  }, 10000)
})

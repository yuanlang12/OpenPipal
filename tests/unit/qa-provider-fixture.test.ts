import { describe, expect, it } from 'vitest'
import type { Context, Model } from '@earendil-works/pi-ai'
import { stream as streamOpenAICompletions } from '@earendil-works/pi-ai/api/openai-completions'
// The QA fixture is an executable ESM script. Its public helpers are exercised
// here without adding a production TypeScript surface for test-only code.
// @ts-expect-error test-only executable module has no declaration file
import {
  QA_PROVIDER_DEFAULT_PORT,
  QA_PROVIDER_MODEL,
  QA_PROVIDER_TOKEN,
  classifyQaRequest,
  createQaCompletionChunks,
  encodeQaSse,
  isAuthorizedQaRequest,
  parseQaProviderArgs
} from '../../scripts/qa/openai-compatible-fixture.mjs'

function body(messages: unknown[], tools: unknown[] = []): Record<string, unknown> {
  return { model: QA_PROVIDER_MODEL, messages, tools, stream: true }
}

const createArtifactTool = {
  type: 'function',
  function: { name: 'create_artifact', parameters: { type: 'object' } }
}

const qaModel: Model<'openai-completions'> = {
  id: QA_PROVIDER_MODEL,
  name: 'OpenPipal QA fixture',
  api: 'openai-completions',
  provider: 'custom',
  baseUrl: 'http://127.0.0.1:40421/v1',
  reasoning: false,
  input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128_000,
  maxTokens: 8_192
}

function userMessage(text: string): Context['messages'][number] {
  return { role: 'user', content: [{ type: 'text', text }], timestamp: 1 }
}

describe('local OpenAI-compatible QA provider fixture', () => {
  it('returns a deterministic text completion for a normal user turn', () => {
    const request = body([{ role: 'user', content: 'Hello from the UI' }])
    expect(classifyQaRequest(request)).toBe('text')

    const result = createQaCompletionChunks(request, 7)
    expect(result.mode).toBe('text')
    expect(result.chunks[0].id).toBe('chatcmpl-openpipal-qa-7')
    expect(result.chunks[0].choices[0].delta.content).toContain('runtime round-trip completed')
    expect(result.chunks[1].choices[0].finish_reason).toBe('stop')
  })

  it('requests create_artifact with a bounded SVG when the explicit Design marker is present', () => {
    const request = body(
      [{ role: 'user', content: [{ type: 'text', text: 'Create the acceptance artifact [QA_DESIGN_ARTIFACT]' }] }],
      [createArtifactTool]
    )

    const result = createQaCompletionChunks(request)
    expect(result.mode).toBe('design-tool')
    const call = result.chunks[0].choices[0].delta.tool_calls[0]
    expect(call.id).toBe('call-openpipal-qa-artifact-1')
    expect(call.function.name).toBe('create_artifact')
    // 参数分片投递（真实服务商就是这样）——拼回去才是完整 JSON
    const assembledArguments = result.chunks
      .flatMap((chunk: any) => chunk.choices?.[0]?.delta?.tool_calls || [])
      .map((toolCall: any) => toolCall.function?.arguments || '')
      .join('')
    expect(result.chunks.filter((chunk: any) => chunk.choices?.[0]?.delta?.tool_calls).length)
      .toBeGreaterThan(1)
    expect(JSON.parse(assembledArguments)).toMatchObject({
      type: 'svg',
      title: 'OpenPipal QA Design Artifact',
      language: 'svg'
    })
    const finishChunk = result.chunks.filter((chunk: any) => chunk.choices?.[0]).at(-1)
    expect(finishChunk.choices[0].finish_reason).toBe('tool_calls')
  })

  it('finishes the Design turn only after receiving the matching tool result', () => {
    const request = body([
      { role: 'user', content: '[QA_DESIGN_ARTIFACT]' },
      { role: 'assistant', tool_calls: [{
        id: 'call-openpipal-qa-artifact-1',
        type: 'function',
        function: { name: 'create_artifact', arguments: '{}' }
      }] },
      { role: 'tool', tool_call_id: 'call-openpipal-qa-artifact-1', content: 'created' }
    ], [createArtifactTool])

    const result = createQaCompletionChunks(request)
    expect(result.mode).toBe('design-final')
    expect(result.chunks[0].choices[0].delta.content).toContain('tool result received')
    expect(result.chunks[1].choices[0].finish_reason).toBe('stop')
  })

  it('does not treat an old or unpaired tool result as the completion of a new turn', () => {
    const previousCall = {
      role: 'assistant',
      tool_calls: [{
        id: 'call-openpipal-qa-artifact-1',
        type: 'function',
        function: { name: 'create_artifact', arguments: '{}' }
      }]
    }
    const previousResult = { role: 'tool', tool_call_id: 'call-openpipal-qa-artifact-1', content: 'created' }

    expect(classifyQaRequest(body([
      { role: 'user', content: '[QA_DESIGN_ARTIFACT]' },
      previousCall,
      previousResult,
      { role: 'user', content: 'A later ordinary question' }
    ], [createArtifactTool]))).toBe('text')

    const unpaired = classifyQaRequest(body([
      { role: 'user', content: '[QA_DESIGN_ARTIFACT]' },
      previousResult
    ], [createArtifactTool]))
    expect(unpaired).toBe('design-tool')
    expect(unpaired).not.toBe('design-final')
  })

  it('is consumed by the real pi-ai OpenAI adapter across the tool-result round trip', async () => {
    const payloads: Record<string, unknown>[] = []
    const fixtureFetch: typeof fetch = async (_input, init) => {
      const payload = JSON.parse(String(init?.body || '{}')) as Record<string, unknown>
      payloads.push(payload)
      const completion = createQaCompletionChunks(payload, payloads.length)
      return new Response(encodeQaSse(completion.chunks), {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream; charset=utf-8' }
      })
    }
    const tool = {
      name: 'create_artifact',
      description: 'Create a OpenPipal artifact',
      parameters: {
        type: 'object' as const,
        properties: {
          type: { type: 'string' as const },
          title: { type: 'string' as const },
          content: { type: 'string' as const }
        },
        required: ['type', 'title', 'content']
      }
    }
    const firstContext: Context = {
      systemPrompt: 'QA only',
      messages: [userMessage('[QA_DESIGN_ARTIFACT]')],
      tools: [tool]
    }
    const firstEvents = []
    for await (const event of streamOpenAICompletions(qaModel, firstContext, {
      apiKey: QA_PROVIDER_TOKEN,
      fetch: fixtureFetch,
      maxRetries: 0
    })) firstEvents.push(event)

    const firstDone = firstEvents.find(event => event.type === 'done')
    expect(firstDone?.type).toBe('done')
    if (firstDone?.type !== 'done') throw new Error('pi-ai did not finish the QA tool-call response')
    expect(firstDone.message.stopReason).toBe('toolUse')
    expect(firstDone.message.content).toContainEqual(expect.objectContaining({
      type: 'toolCall',
      id: 'call-openpipal-qa-artifact-1',
      name: 'create_artifact',
      arguments: expect.objectContaining({ type: 'svg' })
    }))

    const secondContext: Context = {
      systemPrompt: 'QA only',
      messages: [
        ...firstContext.messages,
        firstDone.message,
        {
          role: 'toolResult',
          toolCallId: 'call-openpipal-qa-artifact-1',
          toolName: 'create_artifact',
          content: [{ type: 'text', text: 'created' }],
          isError: false,
          timestamp: 2
        }
      ],
      tools: [tool]
    }
    const secondEvents = []
    for await (const event of streamOpenAICompletions(qaModel, secondContext, {
      apiKey: QA_PROVIDER_TOKEN,
      fetch: fixtureFetch,
      maxRetries: 0
    })) secondEvents.push(event)

    const secondDone = secondEvents.find(event => event.type === 'done')
    expect(secondDone?.type).toBe('done')
    if (secondDone?.type !== 'done') throw new Error('pi-ai did not finish the QA final response')
    expect(secondDone.message.stopReason).toBe('stop')
    expect(secondDone.message.content).toContainEqual(expect.objectContaining({
      type: 'text',
      text: expect.stringContaining('tool result received')
    }))
    expect(payloads).toHaveLength(2)
  })

  it('emits valid SSE framing and the terminal DONE sentinel', () => {
    const { chunks } = createQaCompletionChunks(body([{ role: 'user', content: 'hello' }]))
    const encoded = encodeQaSse(chunks)
    expect(encoded).toContain('data: {"id":"chatcmpl-openpipal-qa-1"')
    expect(encoded.endsWith('data: [DONE]\n\n')).toBe(true)
  })

  it('accepts only the fixed QA bearer token', () => {
    expect(isAuthorizedQaRequest({ authorization: `Bearer ${QA_PROVIDER_TOKEN}` })).toBe(true)
    expect(isAuthorizedQaRequest({ authorization: 'Bearer wrong' })).toBe(false)
    expect(isAuthorizedQaRequest({})).toBe(false)
  })

  it('parses a bounded port without adding a network-facing host option', () => {
    expect(parseQaProviderArgs([])).toEqual({ port: QA_PROVIDER_DEFAULT_PORT })
    expect(parseQaProviderArgs(['--port', '0'])).toEqual({ port: 0 })
    expect(() => parseQaProviderArgs(['--port', '70000'])).toThrow('Invalid port')
    expect(() => parseQaProviderArgs(['--host', '0.0.0.0'])).toThrow('Unknown argument')
  })
})

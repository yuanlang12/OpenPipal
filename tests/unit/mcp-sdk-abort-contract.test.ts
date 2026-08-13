import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js'

describe('installed MCP SDK cancellation contract', () => {
  let client: Client
  let transport: Transport
  let sent: JSONRPCMessage[]

  beforeEach(async () => {
    sent = []
    transport = {
      async start() {},
      async send(message) {
        sent.push(message)
        if ('method' in message && message.method === 'initialize') {
          queueMicrotask(() => transport.onmessage?.({
            jsonrpc: '2.0',
            id: message.id,
            result: {
              protocolVersion: '2025-11-25',
              capabilities: { tools: {} },
              serverInfo: { name: 'abort-contract-server', version: '1.0.0' }
            }
          }))
        }
      },
      async close() {}
    }
    client = new Client({ name: 'abort-contract-client', version: '1.0.0' })
    await client.connect(transport)
    sent.length = 0
  })

  afterEach(async () => {
    await client.close()
  })

  it('does not send a tool request for a pre-aborted signal', async () => {
    const controller = new AbortController()
    controller.abort(new DOMException('already stopped', 'AbortError'))

    await expect(client.callTool(
      { name: 'remote_write', arguments: {} },
      undefined,
      { signal: controller.signal }
    )).rejects.toMatchObject({ name: 'AbortError' })

    expect(sent.some(message => 'method' in message && message.method === 'tools/call')).toBe(false)
  })

  it('rejects an in-flight request and sends the MCP cancellation notification', async () => {
    const controller = new AbortController()
    const pending = client.callTool(
      { name: 'remote_write', arguments: { value: 'x' } },
      undefined,
      { signal: controller.signal }
    )
    await new Promise<void>((resolve) => setImmediate(resolve))

    const toolCall = sent.find(message => (
      'method' in message && message.method === 'tools/call'
    ))
    expect(toolCall).toBeDefined()
    controller.abort(new DOMException('superseded', 'AbortError'))

    await expect(pending).rejects.toBeDefined()
    const cancellation = sent.find(message => (
      'method' in message && message.method === 'notifications/cancelled'
    ))
    expect(cancellation).toBeDefined()
    expect(cancellation && 'params' in cancellation
      ? cancellation.params.requestId
      : undefined).toBe(toolCall && 'id' in toolCall ? toolCall.id : undefined)
  })
})

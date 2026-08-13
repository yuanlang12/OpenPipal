import { PassThrough } from 'node:stream'
import type { IncomingMessage } from 'node:http'
import { describe, expect, it } from 'vitest'
import {
  ARTIFACT_COMPLETION_REQUEST_BODY_MAX_BYTES,
  CONTEXT_REQUEST_BODY_MAX_BYTES,
  RequestBodyTooLargeError,
  readBoundedRequestBody,
} from '../../src/main/http-request-body'

function request(headers: Record<string, string> = {}): PassThrough & IncomingMessage {
  const stream = new PassThrough() as PassThrough & IncomingMessage
  Object.defineProperty(stream, 'headers', { value: headers, configurable: true })
  return stream
}

describe('bounded local HTTP request body', () => {
  it('leaves room for the extension 30 MiB PDF after base64 expansion', () => {
    const maxPdfBase64Bytes = Math.ceil((30 * 1024 * 1024) / 3) * 4
    expect(CONTEXT_REQUEST_BODY_MAX_BYTES).toBeGreaterThan(maxPdfBase64Bytes)
  })

  it('keeps the untrusted artifact completion envelope small', () => {
    expect(ARTIFACT_COMPLETION_REQUEST_BODY_MAX_BYTES).toBe(64 * 1024)
  })

  it('preserves a normal UTF-8 chunked body', async () => {
    const req = request()
    const reading = readBoundedRequestBody(req, 64)
    req.write(Buffer.from('你'))
    req.end(Buffer.from('好'))
    await expect(reading).resolves.toBe('你好')
  })

  it('rejects a declared oversized body before buffering it', async () => {
    const req = request({ 'content-length': '65' })
    await expect(readBoundedRequestBody(req, 64)).rejects.toBeInstanceOf(RequestBodyTooLargeError)
    req.end()
  })

  it('rejects a chunked body as soon as its cumulative bytes cross the limit', async () => {
    const req = request()
    const reading = readBoundedRequestBody(req, 4)
    req.write('1234')
    req.end('5')
    await expect(reading).rejects.toMatchObject({ code: 'OPENPIPAL_HTTP_BODY_TOO_LARGE', statusCode: 413 })
  })
})

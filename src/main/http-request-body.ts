import type { IncomingMessage } from 'node:http'

export const DEFAULT_REQUEST_BODY_MAX_BYTES = 32 * 1024 * 1024
export const WEBHOOK_REQUEST_BODY_MAX_BYTES = 64 * 1024
export const ARTIFACT_COMPLETION_REQUEST_BODY_MAX_BYTES = 64 * 1024
// The extension accepts PDFs up to 30 MiB; base64 expands them to 40 MiB before JSON overhead.
export const CONTEXT_REQUEST_BODY_MAX_BYTES = 42 * 1024 * 1024

export class RequestBodyTooLargeError extends Error {
  readonly code = 'OPENPIPAL_HTTP_BODY_TOO_LARGE'
  readonly statusCode = 413

  constructor(readonly maxBytes: number) {
    super(`Request body exceeds ${maxBytes} bytes`)
    this.name = 'RequestBodyTooLargeError'
  }
}

export function isRequestBodyTooLargeError(error: unknown): error is RequestBodyTooLargeError {
  return error instanceof RequestBodyTooLargeError ||
    (typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'OPENPIPAL_HTTP_BODY_TOO_LARGE')
}

/**
 * Buffer the local HTTP request body with a hard byte ceiling. This limit is enforced for both
 * Content-Length and chunked requests; after rejection the remaining bytes are drained without
 * being retained so one authenticated client cannot grow Electron main-process memory forever.
 */
export function readBoundedRequestBody(
  req: IncomingMessage,
  maxBytes = DEFAULT_REQUEST_BODY_MAX_BYTES,
): Promise<string> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    return Promise.reject(new TypeError('maxBytes must be a positive safe integer'))
  }

  const declaredHeader = Array.isArray(req.headers['content-length'])
    ? req.headers['content-length'][0]
    : req.headers['content-length']
  if (declaredHeader !== undefined) {
    const declared = Number(declaredHeader)
    if (!Number.isSafeInteger(declared) || declared < 0) {
      req.resume()
      return Promise.reject(new Error('Invalid Content-Length'))
    }
    if (declared > maxBytes) {
      req.resume()
      return Promise.reject(new RequestBodyTooLargeError(maxBytes))
    }
  }

  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let received = 0
    let settled = false

    const cleanup = (): void => {
      req.removeListener('data', onData)
      req.removeListener('end', onEnd)
      req.removeListener('error', onError)
      req.removeListener('aborted', onAborted)
    }
    const fail = (error: unknown, drain = false): void => {
      if (settled) return
      settled = true
      cleanup()
      if (drain) {
        // Keep an inert error listener while draining so a late socket error cannot become an
        // unhandled EventEmitter error after the caller has already sent the 413 response.
        req.once('error', () => undefined)
        req.resume()
      }
      reject(error)
    }
    const onData = (chunk: Buffer | string): void => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      received += buffer.byteLength
      if (received > maxBytes) {
        chunks.length = 0
        fail(new RequestBodyTooLargeError(maxBytes), true)
        return
      }
      chunks.push(buffer)
    }
    const onEnd = (): void => {
      if (settled) return
      settled = true
      cleanup()
      resolve(Buffer.concat(chunks, received).toString('utf8'))
    }
    const onError = (error: Error): void => fail(error)
    const onAborted = (): void => fail(new Error('Request aborted'))

    req.on('data', onData)
    req.on('end', onEnd)
    req.on('error', onError)
    req.on('aborted', onAborted)
  })
}

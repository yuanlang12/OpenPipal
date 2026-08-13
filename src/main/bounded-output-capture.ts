import { Buffer } from 'node:buffer'

export const OPENPIPAL_DEFAULT_MAX_CAPTURE_BYTES = 128 * 1024

function utf8Tail(buffer: Buffer, maxBytes: number): string {
  if (buffer.byteLength <= maxBytes) return buffer.toString('utf8')
  let start = buffer.byteLength - maxBytes
  while (start < buffer.byteLength && (buffer[start] & 0xc0) === 0x80) start += 1
  return buffer.subarray(start).toString('utf8')
}

function utf8Head(value: string, maxBytes: number): string {
  let bytes = 0
  let output = ''
  for (const character of value) {
    const characterBytes = Buffer.byteLength(character, 'utf8')
    if (bytes + characterBytes > maxBytes) break
    output += character
    bytes += characterBytes
  }
  return output
}

/** A reusable byte-bounded tail capture for both Runtime generations. */
export class OpenPipalBoundedOutputCapture {
  private tail = Buffer.alloc(0)
  private totalBytes = 0

  constructor(
    private readonly streamName: string,
    private readonly maxBytes = OPENPIPAL_DEFAULT_MAX_CAPTURE_BYTES
  ) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
      throw new TypeError('maxBytes must be a positive safe integer')
    }
  }

  append(chunk: string | Uint8Array): void {
    const encoded = typeof chunk === 'string'
      ? Buffer.from(chunk, 'utf8')
      : Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength)
    this.totalBytes += encoded.byteLength
    const combined = Buffer.concat([this.tail, encoded])
    this.tail = combined.byteLength <= this.maxBytes
      ? combined
      : combined.subarray(combined.byteLength - this.maxBytes)
  }

  value(): string {
    if (this.totalBytes <= this.maxBytes) return this.tail.toString('utf8')
    const marker = `[OpenPipal: ${this.streamName} truncated; kept the last bytes of ${this.totalBytes} total bytes]\n`
    const markerBytes = Buffer.byteLength(marker, 'utf8')
    if (markerBytes >= this.maxBytes) return utf8Head(marker, this.maxBytes)
    const tailBudget = Math.max(0, this.maxBytes - markerBytes)
    return marker + utf8Tail(this.tail, tailBudget)
  }
}

export function createOpenPipalBoundedOutputCapture(
  streamName = 'output',
  maxBytes = OPENPIPAL_DEFAULT_MAX_CAPTURE_BYTES
): OpenPipalBoundedOutputCapture {
  return new OpenPipalBoundedOutputCapture(streamName, maxBytes)
}

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import sharp from 'sharp'
import { afterEach, describe, expect, it } from 'vitest'
import { buildPiCoreExecutionTools } from '../../src/main/agent-runtime/pi-core-execution-tools'

const temporaryDirectories: string[] = []

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

function createWorkspace(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'openpipal-pi-core-image-'))
  temporaryDirectories.push(directory)
  return directory
}

function createBmp24(width: number, height: number): Buffer {
  const rowSize = Math.ceil((width * 3) / 4) * 4
  const pixelBytes = rowSize * height
  const output = Buffer.alloc(54 + pixelBytes)
  output.write('BM', 0, 'ascii')
  output.writeUInt32LE(output.length, 2)
  output.writeUInt32LE(54, 10)
  output.writeUInt32LE(40, 14)
  output.writeInt32LE(width, 18)
  output.writeInt32LE(height, 22)
  output.writeUInt16LE(1, 26)
  output.writeUInt16LE(24, 28)
  output.writeUInt32LE(pixelBytes, 34)
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = 54 + y * rowSize + x * 3
      output[offset] = 0x20
      output[offset + 1] = 0x80
      output[offset + 2] = 0xf0
    }
  }
  return output
}

async function readImage(workspace: string, fileName: string) {
  const bundle = buildPiCoreExecutionTools(workspace)
  try {
    const read = bundle.tools.find((tool) => tool.name === 'read')
    if (!read) throw new Error('read tool missing')
    return await read.execute(
      'read-image',
      { path: fileName },
      undefined,
      undefined,
      bundle.toolContext
    )
  } finally {
    await bundle.dispose()
  }
}

describe('pi-core read image processor', () => {
  it('resizes oversized images into the provider-safe inline envelope', async () => {
    const workspace = createWorkspace()
    const input = await sharp({
      create: {
        width: 3000,
        height: 1200,
        channels: 4,
        background: { r: 30, g: 120, b: 220, alpha: 1 }
      }
    }).png().toBuffer()
    fs.writeFileSync(path.join(workspace, 'oversized.png'), input)

    const result = await readImage(workspace, 'oversized.png')
    expect(result.content).toHaveLength(2)
    const note = result.content[0] as { type: 'text'; text: string }
    const image = result.content[1] as { type: 'image'; data: string; mimeType: string }
    expect(note.text).toContain('original 3000x1200, displayed at 2000x800')
    expect(Buffer.byteLength(image.data, 'utf8')).toBeLessThan(4.5 * 1024 * 1024)
    const metadata = await sharp(Buffer.from(image.data, 'base64')).metadata()
    expect(metadata.width).toBe(2000)
    expect(metadata.height).toBe(800)
  })

  it('converts BMP to a supported bounded inline image instead of omitting it', async () => {
    const workspace = createWorkspace()
    fs.writeFileSync(path.join(workspace, 'sample.bmp'), createBmp24(3, 2))

    const result = await readImage(workspace, 'sample.bmp')
    expect(result.content).toHaveLength(2)
    const note = result.content[0] as { type: 'text'; text: string }
    const image = result.content[1] as { type: 'image'; data: string; mimeType: string }
    expect(note.text).toContain('[Image converted from image/bmp to image/png.]')
    expect(note.text).not.toContain('Image omitted')
    expect(image.mimeType).toBe('image/png')
    const metadata = await sharp(Buffer.from(image.data, 'base64')).metadata()
    expect(metadata.width).toBe(3)
    expect(metadata.height).toBe(2)
  })

  it('fails closed when a detected BMP uses an unsupported encoding', async () => {
    const workspace = createWorkspace()
    const compressedBmp = createBmp24(3, 2)
    compressedBmp.writeUInt32LE(1, 30)
    fs.writeFileSync(path.join(workspace, 'compressed.bmp'), compressedBmp)

    const result = await readImage(workspace, 'compressed.bmp')
    expect(result.content).toEqual([{
      type: 'text',
      text: 'Read image file [image/bmp]\n[Image omitted: could not be converted to a supported inline image format.]'
    }])
  })
})

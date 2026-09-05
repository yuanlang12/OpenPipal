import type SharpModule from 'sharp'
import type {
  ReadImageProcessor,
  ReadImageProcessorResult
} from '@earendil-works/pi-agent-core'

/**
 * sharp 按需加载而不是顶层 import：它是按平台分包的原生模块，Mac 上交叉打的 Windows 包
 * 曾漏带 win32 变体（第 1–4 段的包全是），0.33 时 Windows arm64 还没有预编译。
 * 顶层 import 会让整个主进程在启动时崩掉；按需加载只让 read 工具的图片处理这一项失效。
 */
let sharpModule: typeof SharpModule | null | undefined
function loadSharp(): typeof SharpModule | null {
  if (sharpModule !== undefined) return sharpModule
  try {
    sharpModule = require('sharp') as typeof SharpModule
  } catch (error) {
    console.warn('[read-image] sharp 不可用，图片处理关闭:', error instanceof Error ? error.message.split('\n')[0] : error)
    sharpModule = null
  }
  return sharpModule
}

// Match the established CLI-provider envelope: keep the longest edge within
// 2000px and leave headroom below providers' 5MB base64 image limit.
const MAX_IMAGE_WIDTH = 2000
const MAX_IMAGE_HEIGHT = 2000
const MAX_INLINE_BASE64_BYTES = 4.5 * 1024 * 1024
// Decode validation happens before any passthrough. This prevents a crafted,
// highly compressed image from expanding without a bounded pixel budget.
const MAX_INPUT_PIXELS = 40_000_000
const JPEG_QUALITIES = [80, 85, 70, 55, 40] as const

type InlineImageCandidate = {
  data: string
  mimeType: 'image/png' | 'image/jpeg'
  width: number
  height: number
}

type SharpImageSource = {
  input: Buffer
  raw?: {
    width: number
    height: number
    channels: 3
  }
}

function baseMimeType(mimeType: string): string {
  return mimeType.split(';')[0]?.trim().toLowerCase() || mimeType.toLowerCase()
}

function normalizeInlineMimeType(mimeType: string): string | undefined {
  switch (baseMimeType(mimeType)) {
    case 'image/png':
      return 'image/png'
    case 'image/jpeg':
    case 'image/jpg':
      return 'image/jpeg'
    case 'image/gif':
      return 'image/gif'
    case 'image/webp':
      return 'image/webp'
    default:
      return undefined
  }
}

function displayDimensions(
  width: number,
  height: number,
  orientation: number | undefined
): { width: number; height: number } {
  return orientation !== undefined && orientation >= 5 && orientation <= 8
    ? { width: height, height: width }
    : { width, height }
}

function fitDimensions(width: number, height: number): { width: number; height: number } {
  const scale = Math.min(1, MAX_IMAGE_WIDTH / width, MAX_IMAGE_HEIGHT / height)
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale))
  }
}

function base64Candidate(
  bytes: Buffer,
  mimeType: InlineImageCandidate['mimeType'],
  width: number,
  height: number
): InlineImageCandidate | undefined {
  const data = bytes.toString('base64')
  if (Buffer.byteLength(data, 'utf8') >= MAX_INLINE_BASE64_BYTES) return undefined
  return { data, mimeType, width, height }
}

function openSource(source: SharpImageSource) {
  const sharp = loadSharp()
  if (!sharp) throw new Error('sharp unavailable on this platform')
  return sharp(source.input, {
    animated: false,
    failOn: 'error',
    limitInputPixels: MAX_INPUT_PIXELS,
    raw: source.raw,
    sequentialRead: true
  })
}

function createPipeline(source: SharpImageSource, width: number, height: number) {
  return openSource(source)
    .rotate()
    .resize({ width, height, fit: 'inside', withoutEnlargement: true })
}

async function encodeAtDimensions(
  source: SharpImageSource,
  width: number,
  height: number
): Promise<InlineImageCandidate | undefined> {
  const png = await createPipeline(source, width, height)
    .png({ compressionLevel: 9 })
    .toBuffer({ resolveWithObject: true })
  const pngCandidate = base64Candidate(png.data, 'image/png', png.info.width, png.info.height)
  if (pngCandidate) return pngCandidate

  for (const quality of JPEG_QUALITIES) {
    const jpeg = await createPipeline(source, width, height)
      .flatten({ background: '#ffffff' })
      .jpeg({ quality })
      .toBuffer({ resolveWithObject: true })
    const jpegCandidate = base64Candidate(
      jpeg.data,
      'image/jpeg',
      jpeg.info.width,
      jpeg.info.height
    )
    if (jpegCandidate) return jpegCandidate
  }
  return undefined
}

async function resizeToInlineEnvelope(
  source: SharpImageSource,
  width: number,
  height: number
): Promise<InlineImageCandidate | undefined> {
  let current = fitDimensions(width, height)
  while (true) {
    const candidate = await encodeAtDimensions(source, current.width, current.height)
    if (candidate) return candidate
    if (current.width === 1 && current.height === 1) return undefined

    const next = {
      width: current.width === 1 ? 1 : Math.max(1, Math.floor(current.width * 0.75)),
      height: current.height === 1 ? 1 : Math.max(1, Math.floor(current.height * 0.75))
    }
    if (next.width === current.width && next.height === current.height) return undefined
    current = next
  }
}

function decodeBmp(source: Buffer): SharpImageSource {
  if (source.length < 54 || source.toString('ascii', 0, 2) !== 'BM') {
    throw new Error('Invalid BMP header')
  }
  const declaredSize = source.readUInt32LE(2)
  const pixelOffset = source.readUInt32LE(10)
  const dibSize = source.readUInt32LE(14)
  if (dibSize < 40 || dibSize > 124 || pixelOffset < 14 + dibSize) {
    throw new Error('Unsupported BMP header')
  }
  if (declaredSize !== 0 && (declaredSize > source.length || pixelOffset >= declaredSize)) {
    throw new Error('Truncated BMP')
  }

  const width = source.readInt32LE(18)
  const signedHeight = source.readInt32LE(22)
  const height = Math.abs(signedHeight)
  const planes = source.readUInt16LE(26)
  const bitsPerPixel = source.readUInt16LE(28)
  const compression = source.readUInt32LE(30)
  if (
    width <= 0 || height <= 0 || planes !== 1 ||
    (bitsPerPixel !== 24 && bitsPerPixel !== 32) || compression !== 0
  ) {
    throw new Error('Unsupported BMP encoding')
  }
  if (width * height > MAX_INPUT_PIXELS) throw new Error('BMP pixel limit exceeded')

  const rowBytes = Math.ceil((width * bitsPerPixel) / 32) * 4
  const requiredPixelBytes = rowBytes * height
  if (
    !Number.isSafeInteger(requiredPixelBytes) ||
    pixelOffset + requiredPixelBytes > source.length ||
    (declaredSize !== 0 && pixelOffset + requiredPixelBytes > declaredSize)
  ) {
    throw new Error('Truncated BMP pixel data')
  }

  const bytesPerPixel = bitsPerPixel / 8
  const rgb = Buffer.allocUnsafe(width * height * 3)
  const topDown = signedHeight < 0
  for (let y = 0; y < height; y += 1) {
    const sourceY = topDown ? y : height - y - 1
    const sourceRow = pixelOffset + sourceY * rowBytes
    const outputRow = y * width * 3
    for (let x = 0; x < width; x += 1) {
      const sourcePixel = sourceRow + x * bytesPerPixel
      const outputPixel = outputRow + x * 3
      rgb[outputPixel] = source[sourcePixel + 2]!
      rgb[outputPixel + 1] = source[sourcePixel + 1]!
      rgb[outputPixel + 2] = source[sourcePixel]!
    }
  }
  return { input: rgb, raw: { width, height, channels: 3 } }
}

function conversionHint(from: string, to: string): string | undefined {
  return from === to ? undefined : `[Image converted from ${from} to ${to}.]`
}

function dimensionHint(
  originalWidth: number,
  originalHeight: number,
  width: number,
  height: number
): string {
  const scale = originalWidth / width
  return `[Image: original ${originalWidth}x${originalHeight}, displayed at ${width}x${height}. Multiply coordinates by ${scale.toFixed(2)} to map to original image.]`
}

/**
 * Sharp-backed image processor for the public pi-core read tool.
 *
 * Supported inline formats are passed through only after metadata validation.
 * BMP is always converted, and auto-resize mode enforces both dimensions and
 * encoded payload size before returning data to a model provider.
 */
export const processPiCoreReadImage: ReadImageProcessor = async (
  bytes,
  mimeType,
  { autoResizeImages }
): Promise<ReadImageProcessorResult> => {
  const input = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const inputMimeType = baseMimeType(mimeType)
  if (!loadSharp()) {
    return {
      ok: false,
      message: '[Image omitted: image processing (sharp) is unavailable on this platform build.]'
    }
  }

  try {
    const source = inputMimeType === 'image/bmp'
      ? decodeBmp(input)
      : { input }
    const metadata = await openSource(source).metadata()
    if (!metadata.width || !metadata.height) {
      throw new Error('Image dimensions are unavailable')
    }
    const original = displayDimensions(metadata.width, metadata.height, metadata.orientation)
    const normalizedMimeType = normalizeInlineMimeType(inputMimeType)
    const inputBase64Bytes = Math.ceil(input.byteLength / 3) * 4
    const withinDimensions =
      original.width <= MAX_IMAGE_WIDTH && original.height <= MAX_IMAGE_HEIGHT

    if (normalizedMimeType && (!autoResizeImages || (
      withinDimensions && inputBase64Bytes < MAX_INLINE_BASE64_BYTES
    ))) {
      return {
        ok: true,
        data: input.toString('base64'),
        mimeType: normalizedMimeType,
        hints: []
      }
    }

    if (!autoResizeImages) {
      const converted = await encodeAtDimensions(source, original.width, original.height)
      if (!converted) throw new Error('Image conversion exceeded inline payload limit')
      const hint = conversionHint(inputMimeType, converted.mimeType)
      return {
        ok: true,
        data: converted.data,
        mimeType: converted.mimeType,
        hints: hint ? [hint] : []
      }
    }

    const resized = await resizeToInlineEnvelope(source, original.width, original.height)
    if (!resized) {
      return {
        ok: false,
        message: '[Image omitted: could not be resized below the inline image size limit.]'
      }
    }

    const hints: string[] = []
    if (!normalizedMimeType) {
      const hint = conversionHint(inputMimeType, resized.mimeType)
      if (hint) hints.push(hint)
    }
    if (original.width !== resized.width || original.height !== resized.height) {
      hints.push(dimensionHint(
        original.width,
        original.height,
        resized.width,
        resized.height
      ))
    }
    return {
      ok: true,
      data: resized.data,
      mimeType: resized.mimeType,
      hints
    }
  } catch {
    return {
      ok: false,
      message: '[Image omitted: could not be converted to a supported inline image format.]'
    }
  }
}

import { closeSync, constants as fsConstants, fstatSync, lstatSync, openSync, readSync, realpathSync, statSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { homedir } from 'node:os'
import { extname, isAbsolute, join, resolve, sep } from 'node:path'
import { dataPath } from './data-root'

export const DESIGN_SYSTEM_RESOURCE_MAX_BYTES = 8 * 1024 * 1024
const capabilityByDesignSystem = new Map<string, string>()
const designSystemByCapability = new Map<string, string>()
const DESIGN_SYSTEM_CAPABILITY_PATTERN = /^[A-Za-z0-9_-]{43}$/
const LOOPBACK_HTTP_ORIGIN_PATTERN = /^http:\/\/(?:127\.0\.0\.1|localhost):(?:[1-9]\d{0,4})$/

export function resolveDesignSystemDirectory(
  name: unknown,
  options: Pick<DesignSystemResourceReadOptions, 'rootDir'> = {},
): string | null {
  if (!isValidDesignSystemName(name)) return null
  const configuredRoot = resolve(options.rootDir || dataPath('design-systems'))
  const logicalSystem = resolve(configuredRoot, name)
  try {
    const canonicalRoot = realpathSync.native(configuredRoot)
    const logicalInfo = statSync(logicalSystem, { throwIfNoEntry: true })
    if (!logicalInfo?.isDirectory()) return null
    // lstat is intentionally required here: a named system cannot alias a sibling or outside
    // directory, even when its final canonical target happens to remain under the common root.
    if (lstatSync(logicalSystem).isSymbolicLink()) return null
    const canonicalSystem = realpathSync.native(logicalSystem)
    if (canonicalSystem !== join(canonicalRoot, name) || !isInside(canonicalRoot, canonicalSystem)) return null
    return canonicalSystem
  } catch {
    return null
  }
}

/** Issue one process-lifetime read capability bound to exactly one design system. */
export function getDesignSystemResourceCapability(
  name: unknown,
  options: Pick<DesignSystemResourceReadOptions, 'rootDir'> = {},
): string | null {
  if (!isValidDesignSystemName(name)) return null
  const configuredRoot = resolve(options.rootDir || dataPath('design-systems'))
  const capabilityKey = `${configuredRoot}\0${name}`
  const existing = capabilityByDesignSystem.get(capabilityKey)
  if (existing) return existing
  if (!resolveDesignSystemDirectory(name, options)) return null
  const capability = randomBytes(32).toString('base64url')
  capabilityByDesignSystem.set(capabilityKey, capability)
  designSystemByCapability.set(capability, name)
  return capability
}

/** Parse the process-lifetime, read-only iframe path without exposing a root API token. */
export function parseDesignSystemStaticCapabilityPath(pathname: string): { capability: string; name: string; rel: string } | null {
  const prefix = '/design-systems/'
  if (!pathname.startsWith(prefix)) return null
  const parts = pathname.slice(prefix.length).split('/')
  if (parts.length < 3) return null
  try {
    const capability = parts[0]
    const name = decodeURIComponent(parts[1])
    if (designSystemByCapability.get(capability) !== name) return null
    return { capability, name, rel: parts.slice(2).map(part => decodeURIComponent(part)).join('/') }
  } catch {
    return null
  }
}

/**
 * Keep untrusted design previews interactive while denying every outbound data
 * channel. The only loadable subresources are files under the exact per-design
 * capability path (plus in-memory data/blob images and fonts).
 */
export function buildDesignSystemPreviewContentSecurityPolicy(
  origin: string,
  capability: string,
  name: string,
): string | null {
  if (!LOOPBACK_HTTP_ORIGIN_PATTERN.test(origin)) return null
  if (!DESIGN_SYSTEM_CAPABILITY_PATTERN.test(capability)) return null
  if (!isValidDesignSystemName(name) || designSystemByCapability.get(capability) !== name) return null
  const resourceRoot = `${origin}/design-systems/${capability}/${encodeURIComponent(name)}/`
  return [
    "default-src 'none'",
    `script-src 'unsafe-inline' ${resourceRoot}`,
    `style-src 'unsafe-inline' ${resourceRoot}`,
    `img-src data: blob: ${resourceRoot}`,
    `font-src data: ${resourceRoot}`,
    `media-src data: blob: ${resourceRoot}`,
    "connect-src 'none'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-src 'none'",
    "child-src 'none'",
    "worker-src 'none'",
    "manifest-src 'none'",
    "navigate-to 'none'",
    // Also protects previews opened in a separate tab, where the iframe's
    // sandbox attribute would otherwise no longer apply.
    'sandbox allow-scripts',
  ].join('; ')
}

export type DesignSystemResourceErrorCode =
  | 'invalid-name'
  | 'invalid-path'
  | 'not-found'
  | 'forbidden'
  | 'not-file'
  | 'too-large'
  | 'unsupported'

export interface DesignSystemResourceFailure {
  ok: false
  code: DesignSystemResourceErrorCode
  error: string
}

export interface DesignSystemResourceSuccess {
  ok: true
  kind: 'text' | 'data-url'
  data: string
  contentType: string
  size: number
}

export type DesignSystemResourceResult = DesignSystemResourceSuccess | DesignSystemResourceFailure

export interface DesignSystemStaticResourceSuccess {
  ok: true
  data: Buffer
  contentType: string
  size: number
}

export type DesignSystemStaticResourceResult = DesignSystemStaticResourceSuccess | DesignSystemResourceFailure

export interface DesignSystemResourceReadOptions {
  /** Test seam; production callers must use the default OpenPipal data root. */
  rootDir?: string
  maxBytes?: number
}

interface ResolvedResource {
  path: string
  ext: string
  size: number
  dev: number
  ino: number
}

const TEXT_CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.md': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.cjs': 'text/javascript; charset=utf-8',
  '.jsx': 'text/jsx; charset=utf-8',
  '.ts': 'text/typescript; charset=utf-8',
  '.tsx': 'text/tsx; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.yml': 'text/yaml; charset=utf-8',
  '.yaml': 'text/yaml; charset=utf-8',
}

const DATA_URL_CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  // SVG is returned only as an image data URL. Chromium's image context keeps
  // it non-executable; returning it as renderer HTML/text would widen the sink.
  '.svg': 'image/svg+xml',
}

const STATIC_BINARY_CONTENT_TYPES: Readonly<Record<string, string>> = {
  ...DATA_URL_CONTENT_TYPES,
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
}

function failure(code: DesignSystemResourceErrorCode, error: string): DesignSystemResourceFailure {
  return { ok: false, code, error }
}

function isInside(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(root + sep)
}

function isValidDesignSystemName(name: unknown): name is string {
  return typeof name === 'string'
    && name.length > 0
    && name.length <= 128
    && name === name.trim()
    && name !== '.'
    && name !== '..'
    && !name.startsWith('.')
    && !name.includes('..')
    && !name.includes('/')
    && !name.includes('\\')
    && !name.includes('\0')
}

function isValidRelativeResourcePath(rel: unknown): rel is string {
  return typeof rel === 'string'
    && rel.length > 0
    && rel.length <= 4096
    && !isAbsolute(rel)
    && !rel.includes('\\')
    && !rel.includes('\0')
}

function resolveResource(name: unknown, rel: unknown, options: DesignSystemResourceReadOptions): ResolvedResource | DesignSystemResourceFailure {
  if (!isValidDesignSystemName(name)) return failure('invalid-name', 'Invalid design system name')
  if (!isValidRelativeResourcePath(rel)) return failure('invalid-path', 'Invalid design system resource path')

  const configuredRoot = resolve(options.rootDir || dataPath('design-systems'))
  let canonicalRoot: string
  let canonicalSystemRoot: string
  let canonicalResource: string
  try {
    canonicalRoot = realpathSync.native(configuredRoot)
    const rootStat = statSync(canonicalRoot)
    if (!rootStat.isDirectory()) return failure('not-found', 'Design system root does not exist')

    const lexicalSystemRoot = resolve(configuredRoot, name)
    if (!isInside(configuredRoot, lexicalSystemRoot)) return failure('forbidden', 'Design system path escapes its root')
    canonicalSystemRoot = resolveDesignSystemDirectory(name, options) || ''
    if (!canonicalSystemRoot) return failure('forbidden', 'Design system resolves outside its root')

    const lexicalResource = resolve(lexicalSystemRoot, rel)
    if (!isInside(lexicalSystemRoot, lexicalResource) || lexicalResource === lexicalSystemRoot) {
      return failure('forbidden', 'Design system resource escapes its system root')
    }
    canonicalResource = realpathSync.native(lexicalResource)
  } catch {
    return failure('not-found', 'Design system resource does not exist')
  }

  if (!isInside(canonicalSystemRoot, canonicalResource) || canonicalResource === canonicalSystemRoot) {
    return failure('forbidden', 'Design system resource resolves outside its system root')
  }

  let stats
  try {
    stats = statSync(canonicalResource)
  } catch {
    return failure('not-found', 'Design system resource does not exist')
  }
  if (!stats.isFile()) return failure('not-file', 'Design system resource is not a file')

  const maxBytes = options.maxBytes ?? DESIGN_SYSTEM_RESOURCE_MAX_BYTES
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || stats.size > maxBytes) {
    return failure('too-large', 'Design system resource is too large to preview')
  }

  return {
    path: canonicalResource,
    ext: extname(canonicalResource).toLowerCase(),
    size: stats.size,
    dev: stats.dev,
    ino: stats.ino,
  }
}

function readResolved(resource: ResolvedResource, maxBytes: number): Buffer | DesignSystemResourceFailure {
  let fd: number | undefined
  try {
    // Pin the same regular file that passed canonical containment. O_NOFOLLOW
    // blocks a leaf swap; dev/inode checks also catch ancestor-directory swaps
    // between realpath/stat and open.
    fd = openSync(resource.path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0))
    const before = fstatSync(fd)
    if (!before.isFile() || before.dev !== resource.dev || before.ino !== resource.ino) {
      return failure('forbidden', 'Design system resource changed during validation')
    }
    if (before.size > maxBytes) return failure('too-large', 'Design system resource is too large to preview')
    // Never allocate/read more than the public cap plus one sentinel byte. A
    // same-inode append after validation therefore cannot turn the post-read
    // size check into an unbounded main-process allocation.
    const chunks: Buffer[] = []
    let bytesRead = 0
    while (bytesRead <= maxBytes) {
      const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, maxBytes + 1 - bytesRead))
      const count = readSync(fd, chunk, 0, chunk.byteLength, bytesRead)
      if (count === 0) break
      chunks.push(chunk.subarray(0, count))
      bytesRead += count
    }
    const after = fstatSync(fd)
    if (after.dev !== before.dev || after.ino !== before.ino) {
      return failure('forbidden', 'Design system resource changed while reading')
    }
    if (bytesRead > maxBytes || after.size > maxBytes) {
      return failure('too-large', 'Design system resource is too large to preview')
    }
    return Buffer.concat(chunks, bytesRead)
  } catch {
    return failure('not-found', 'Design system resource could not be read')
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

/**
 * Read one preview-safe resource without exposing an absolute local path to the
 * renderer. Text stays text; preview images are returned as in-memory data URLs.
 */
export function readDesignSystemResource(name: unknown, rel: unknown, options: DesignSystemResourceReadOptions = {}): DesignSystemResourceResult {
  const resolved = resolveResource(name, rel, options)
  if ('ok' in resolved) return resolved

  const contentType = TEXT_CONTENT_TYPES[resolved.ext] || DATA_URL_CONTENT_TYPES[resolved.ext]
  if (!contentType) return failure('unsupported', 'This design system resource type is not previewable')

  const maxBytes = options.maxBytes ?? DESIGN_SYSTEM_RESOURCE_MAX_BYTES
  const data = readResolved(resolved, maxBytes)
  if (!Buffer.isBuffer(data)) return data

  if (DATA_URL_CONTENT_TYPES[resolved.ext]) {
    return {
      ok: true,
      kind: 'data-url',
      data: `data:${contentType};base64,${data.toString('base64')}`,
      contentType,
      size: data.byteLength,
    }
  }

  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(data)
  } catch {
    return failure('unsupported', 'Design system text resource is not valid UTF-8')
  }
  return { ok: true, kind: 'text', data: text, contentType, size: data.byteLength }
}

export function readDesignSystemJsonResource(
  name: unknown,
  rel: unknown,
  options: DesignSystemResourceReadOptions = {},
): unknown | null {
  const result = readDesignSystemResource(name, rel, options)
  if (!result.ok || result.kind !== 'text' || result.contentType !== 'application/json; charset=utf-8') return null
  try {
    return JSON.parse(result.data)
  } catch {
    return null
  }
}

/** Read a strictly allowlisted resource for sandboxed iframe navigation. */
export function readDesignSystemStaticResource(name: unknown, rel: unknown, options: DesignSystemResourceReadOptions = {}): DesignSystemStaticResourceResult {
  const resolved = resolveResource(name, rel, options)
  if ('ok' in resolved) return resolved

  const contentType = TEXT_CONTENT_TYPES[resolved.ext] || STATIC_BINARY_CONTENT_TYPES[resolved.ext]
  if (!contentType) return failure('unsupported', 'This design system resource type cannot be served')

  const maxBytes = options.maxBytes ?? DESIGN_SYSTEM_RESOURCE_MAX_BYTES
  const data = readResolved(resolved, maxBytes)
  if (!Buffer.isBuffer(data)) return data
  return { ok: true, data, contentType, size: data.byteLength }
}

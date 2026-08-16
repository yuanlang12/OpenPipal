/**
 * A deliberately small SVG profile for model-generated visual choices.
 *
 * This parser does not try to make arbitrary SVG safe. It keeps only the
 * static geometry/text vocabulary that questions_v2 documents and drops
 * scripting, links, embedded documents, external resources, animation, and
 * unknown attributes. Keeping it dependency-free lets the main process apply
 * the same boundary to both streaming and terminal tool payloads.
 */

const ALLOWED_ELEMENTS = new Set([
  'svg', 'g', 'defs', 'clippath', 'mask',
  'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon', 'path',
  'text', 'tspan',
  'lineargradient', 'radialgradient', 'stop'
])

const ALLOWED_ATTRIBUTES = new Set([
  // `id` is the target of the local url(#…) references below — without it a
  // gradient/clip reference dangles and the shape silently paints nothing.
  // Scope is the standalone image document, never the host DOM.
  'id',
  'xmlns', 'viewbox', 'width', 'height', 'x', 'y', 'x1', 'y1', 'x2', 'y2',
  'cx', 'cy', 'r', 'rx', 'ry', 'd', 'points', 'pathlength',
  'fill', 'fill-opacity', 'fill-rule', 'stroke', 'stroke-width', 'stroke-opacity',
  'stroke-linecap', 'stroke-linejoin', 'stroke-dasharray', 'stroke-dashoffset',
  'opacity', 'transform', 'clip-path', 'clip-rule', 'mask',
  'font-family', 'font-size', 'font-style', 'font-weight', 'text-anchor',
  'dominant-baseline', 'letter-spacing',
  'offset', 'stop-color', 'stop-opacity', 'gradientunits', 'gradienttransform',
  'spreadmethod', 'fx', 'fy', 'fr'
])

const URL_REFERENCE_ATTRIBUTES = new Set(['fill', 'stroke', 'clip-path', 'mask'])
const SAFE_COLOR = /^(?:none|currentColor|transparent|#[0-9a-f]{3,8}|rgba?\([\d\s.,%+-]+\)|hsla?\([\d\s.,%+-]+\)|[a-z]+)$/i
const SAFE_LOCAL_REFERENCE = /^url\(\s*#[A-Za-z_][\w:.-]*\s*\)$/

/**
 * Geometry leaves never carry children in this profile. Emitting them
 * self-closed (and ignoring any stray end tag) absorbs the most common
 * model typo — `<rect …>` written HTML-style — which would otherwise make
 * the whole document fail XML parsing and show a broken-image icon.
 */
const VOID_ELEMENTS = new Set(['rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon', 'path', 'stop'])

/** An `<img>` renders SVG as a standalone XML document; without this it draws nothing. */
const SVG_NAMESPACE = 'http://www.w3.org/2000/svg'

/** Raster previews are inlined into conversation.json, so cap the whole URI. */
const MAX_DATA_URI_LENGTH = 128 * 1024
const DATA_IMAGE_MIME = /^image\/(?:svg\+xml|png|jpeg|jpg|gif|webp|avif|bmp)$/

interface SanitizedTag {
  markup: string
  name: string
  closing: boolean
  selfClosing: boolean
}

/**
 * Text nodes are XML, not HTML: a bare `&` (or an HTML-only entity such as
 * `&nbsp;`) is a fatal parse error rather than a literal character.
 */
function escapeText(text: string): string {
  return text
    .replace(/&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);)/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

function escapeAttribute(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

function sanitizeAttribute(name: string, value: string): string | null {
  const lowerName = name.toLowerCase()
  if (!ALLOWED_ATTRIBUTES.has(lowerName) || lowerName.startsWith('on')) return null
  for (const character of value) {
    const codePoint = character.charCodeAt(0)
    if (codePoint < 0x20 || codePoint === 0x7f) return null
  }

  const trimmed = value.trim()
  if (URL_REFERENCE_ATTRIBUTES.has(lowerName)) {
    if (/^url\(/i.test(trimmed)) return SAFE_LOCAL_REFERENCE.test(trimmed) ? trimmed : null
    if ((lowerName === 'fill' || lowerName === 'stroke') && !SAFE_COLOR.test(trimmed)) return null
  }
  return trimmed
}

function sanitizeTag(rawTag: string): SanitizedTag | null {
  const match = /^<\s*(\/?)\s*([A-Za-z][\w:-]*)([\s\S]*?)(\/?)\s*>$/.exec(rawTag)
  if (!match) return null
  const closing = match[1] === '/'
  const originalName = match[2]
  const normalizedName = originalName.toLowerCase()
  if (!ALLOWED_ELEMENTS.has(normalizedName)) return null
  if (closing) return { markup: `</${originalName}>`, name: normalizedName, closing: true, selfClosing: false }

  const attributes: string[] = []
  const source = match[3]
  const attributePattern = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'))?/g
  let attributeMatch: RegExpExecArray | null
  while ((attributeMatch = attributePattern.exec(source)) !== null) {
    const attributeName = attributeMatch[1]
    const rawValue = attributeMatch[2] ?? attributeMatch[3]
    // Boolean attributes and unquoted values are not part of the supported profile.
    if (rawValue === undefined) continue
    const safeValue = sanitizeAttribute(attributeName, rawValue)
    if (safeValue === null) continue
    attributes.push(`${attributeName}="${escapeAttribute(safeValue)}"`)
  }

  const selfClosing = match[4] === '/' || VOID_ELEMENTS.has(normalizedName)
  return {
    markup: `<${originalName}${attributes.length ? ` ${attributes.join(' ')}` : ''}${selfClosing ? '/' : ''}>`,
    name: normalizedName,
    closing: false,
    selfClosing
  }
}

/** Declare the SVG namespace on the root so the document renders inside an `<img>`. */
function ensureSvgNamespace(markup: string): string {
  const rootTagEnd = markup.indexOf('>')
  if (rootTagEnd < 0) return markup
  if (/\sxmlns\s*=/i.test(markup.slice(0, rootTagEnd))) return markup
  return `${markup.slice(0, 4)} xmlns="${SVG_NAMESPACE}"${markup.slice(4)}`
}

/** Return a static SVG fragment, or null when no displayable content survives. */
export function sanitizeQuestionsSvg(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const source = value.trim()
  if (!source || source.length > 64 * 1024) return null

  // Strip active/embedded blocks before processing individual tags so their
  // text and nested markup cannot leak back into the result. Links are
  // unwrapped rather than removed so a harmless shape inside <a> survives.
  const withoutActiveBlocks = source
    .replace(/<\s*(script|foreignObject|iframe|object|embed|style|animate|animateTransform|set)\b[\s\S]*?<\s*\/\s*\1\s*>/gi, '')
    .replace(/<\s*(script|foreignObject|iframe|object|embed|image|use|style|animate|animateTransform|set)\b[^>]*\/?>/gi, '')
    .replace(/<\s*\/?\s*a\b[^>]*>/gi, '')
    .replace(/<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!DOCTYPE[\s\S]*?>/gi, '')

  // Walk tags and text runs together: text must be escaped as XML and every
  // kept element must close, or the browser drops the whole document and the
  // option shows a broken-image icon instead of a preview.
  const pieces: string[] = []
  const openElements: string[] = []
  const tagPattern = /<[^>]*>/g
  let cursor = 0
  let tagMatch: RegExpExecArray | null
  while ((tagMatch = tagPattern.exec(withoutActiveBlocks)) !== null) {
    pieces.push(escapeText(withoutActiveBlocks.slice(cursor, tagMatch.index)))
    cursor = tagMatch.index + tagMatch[0].length
    const tag = sanitizeTag(tagMatch[0])
    if (!tag) continue // dropped element: its end tag is dropped too, so nesting stays balanced
    if (tag.closing) {
      if (VOID_ELEMENTS.has(tag.name)) continue
      if (openElements.pop() !== tag.name) return null // crossed or dangling end tag = unparseable
    } else if (!tag.selfClosing) {
      openElements.push(tag.name)
    }
    pieces.push(tag.markup)
  }
  pieces.push(escapeText(withoutActiveBlocks.slice(cursor)))
  if (openElements.length > 0) return null

  const sanitized = pieces.join('').trim()
  if (!/^<svg(?:\s|>)/i.test(sanitized) || !/<\/svg>$/i.test(sanitized)) return null

  // An empty container is not a useful visual option. Require at least one
  // static drawable/text element after filtering.
  if (!/<(?:rect|circle|ellipse|line|polyline|polygon|path|text|tspan)\b/i.test(sanitized)) return null
  return ensureSvgNamespace(sanitized)
}

/** Base64 in a data URI is strict: no URL alphabet, no stray padding, no `%`. */
function isWellFormedBase64(payload: string): boolean {
  const compact = payload.replace(/\s+/g, '')
  return compact.length > 0 && compact.length % 4 === 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(compact)
}

function decodeBase64Text(payload: string): string | null {
  const compact = payload.replace(/\s+/g, '')
  const scope = globalThis as any
  try {
    const binary: string = typeof scope.atob === 'function'
      ? scope.atob(compact)
      : scope.Buffer.from(compact, 'base64').toString('binary')
    return new TextDecoder().decode(Uint8Array.from(binary, (c) => c.charCodeAt(0)))
  } catch {
    return null
  }
}

/**
 * Normalize one model-supplied option preview into something that is certain to
 * render offline, or null when the option has no usable preview.
 *
 * Accepted: inline SVG markup (reduced to the static profile above) and
 * `data:image/*` URIs. Rejected: every other URL form — `http(s)` and friends
 * cannot load inside the sandboxed, offline renderer, so they would paint a
 * broken-image icon — plus malformed base64/percent payloads and SVG that does
 * not survive sanitization. Callers keep the option and drop only the preview.
 */
export function sanitizeQuestionsPreview(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const raw = value.trim()
  if (!raw) return null
  // Non-data payloads are only usable as inline markup; sanitizeQuestionsSvg
  // rejects anything (a bare URL included) that is not a real SVG document.
  if (!/^data:/i.test(raw)) return sanitizeQuestionsSvg(raw)
  if (raw.length > MAX_DATA_URI_LENGTH) return null

  const separator = raw.indexOf(',')
  if (separator < 0) return null
  const parameters = raw.slice('data:'.length, separator).toLowerCase().split(';')
  const mime = parameters[0]
  if (!DATA_IMAGE_MIME.test(mime)) return null
  const payload = raw.slice(separator + 1)
  const base64 = parameters.includes('base64')

  if (base64 ? !isWellFormedBase64(payload) : /%(?![0-9a-fA-F]{2})/.test(payload)) return null

  if (mime === 'image/svg+xml') {
    // Re-enter the static profile: a data URI is packaging, not a trust boundary.
    let markup: string | null
    if (base64) {
      markup = decodeBase64Text(payload)
    } else {
      try { markup = decodeURIComponent(payload) } catch { return null }
    }
    return markup ? sanitizeQuestionsSvg(markup) : null
  }
  return raw
}

/** `src` for an option preview: raster URIs pass through, SVG becomes a document URI. */
export function questionsPreviewImageUrl(value: unknown): string | null {
  const preview = sanitizeQuestionsPreview(value)
  if (!preview) return null
  return preview.startsWith('data:')
    ? preview
    : `data:image/svg+xml;charset=utf-8,${encodeURIComponent(preview)}`
}

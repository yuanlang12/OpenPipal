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

function sanitizeTag(rawTag: string): string {
  const match = /^<\s*(\/?)\s*([A-Za-z][\w:-]*)([\s\S]*?)(\/?)\s*>$/.exec(rawTag)
  if (!match) return ''
  const closing = match[1] === '/'
  const originalName = match[2]
  const normalizedName = originalName.toLowerCase()
  if (!ALLOWED_ELEMENTS.has(normalizedName)) return ''
  if (closing) return `</${originalName}>`

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

  return `<${originalName}${attributes.length ? ` ${attributes.join(' ')}` : ''}${match[4] === '/' ? '/' : ''}>`
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

  const sanitized = withoutActiveBlocks.replace(/<[^>]*>/g, sanitizeTag).trim()
  if (!/^<svg(?:\s|>)/i.test(sanitized) || !/<\/svg>$/i.test(sanitized)) return null

  // An empty container is not a useful visual option. Require at least one
  // static drawable/text element after filtering.
  if (!/<(?:rect|circle|ellipse|line|polyline|polygon|path|text|tspan)\b/i.test(sanitized)) return null
  return sanitized
}

export interface SimpleFrontmatterDocument {
  frontmatter: Record<string, string>
  body: string
}

/**
 * Parse OpenPipal-owned profile frontmatter through the maintained YAML parser
 * already used by pi-core. Profiles intentionally accept scalar values only,
 * but quoted strings, comments and folded/literal text retain full YAML rules.
 */
export function parseSimpleFrontmatter(content: string): SimpleFrontmatterDocument {
  const normalized = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  const lines = normalized.split('\n')
  if (lines[0]?.trim() !== '---') return { frontmatter: {}, body: normalized }

  let endIndex = -1
  for (let index = 1; index < lines.length; index++) {
    if (lines[index].trim() === '---') {
      endIndex = index
      break
    }
  }
  if (endIndex < 0) return { frontmatter: {}, body: normalized }

  const document = parseDocument(lines.slice(1, endIndex).join('\n'), {
    uniqueKeys: true
  })
  if (document.errors.length > 0) {
    throw new Error(document.errors.map((error) => error.message).join('; '))
  }
  const parsed = document.toJS({ maxAliasCount: 0 })
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Profile frontmatter must be a YAML mapping')
  }
  const frontmatter: Record<string, string> = {}
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (value === null || value === undefined) {
      frontmatter[key] = ''
    } else if (['string', 'number', 'boolean'].includes(typeof value)) {
      frontmatter[key] = String(value)
    } else {
      throw new Error(`Profile frontmatter field "${key}" must be a scalar`)
    }
  }
  return {
    frontmatter,
    body: lines.slice(endIndex + 1).join('\n').replace(/^\n+/, '')
  }
}
import { parseDocument } from 'yaml'

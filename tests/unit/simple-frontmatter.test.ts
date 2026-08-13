import { describe, expect, it } from 'vitest'
import { parseSimpleFrontmatter } from '../../src/main/simple-frontmatter'

describe('OpenPipal profile YAML frontmatter', () => {
  it('preserves folded text, comments, quotes and scalar values', () => {
    const parsed = parseSimpleFrontmatter(`---
name: advisor
description: >-
  Reviews architecture:
  with careful tradeoffs
tools: "read, grep" # profile allow-list
maxTurns: 4
enabled: true
---
System prompt body
`)
    expect(parsed.frontmatter).toEqual({
      name: 'advisor',
      description: 'Reviews architecture: with careful tradeoffs',
      tools: 'read, grep',
      maxTurns: '4',
      enabled: 'true'
    })
    expect(parsed.body).toBe('System prompt body\n')
  })

  it('rejects duplicate keys and non-scalar capability fields', () => {
    expect(() => parseSimpleFrontmatter(`---
name: first
name: second
---
body`)).toThrow()
    expect(() => parseSimpleFrontmatter(`---
name: child
tools:
  - read
  - bash
---
body`)).toThrow('must be a scalar')
  })

  it('leaves files without a complete frontmatter fence untouched', () => {
    expect(parseSimpleFrontmatter('plain body')).toEqual({
      frontmatter: {},
      body: 'plain body'
    })
    const incomplete = '---\nname: advisor\nbody'
    expect(parseSimpleFrontmatter(incomplete)).toEqual({
      frontmatter: {},
      body: incomplete
    })
  })
})

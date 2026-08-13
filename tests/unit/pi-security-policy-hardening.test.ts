import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  classifyToolRisk,
  summarizeAuditArgs
} from '../../src/main/pi-security'
import { resolveCodeExecutionLanguage } from '../../src/main/code-execution-language'

describe('remote MCP authorization origin', () => {
  it.each([
    'get_account',
    'list_documents',
    'read',
    'save_memory',
    'create_artifact',
    'unclassified_remote_tool'
  ])('never auto-approves server-controlled name %s', (toolName) => {
    const risk = classifyToolRisk(toolName, { value: 'x' }, { origin: 'mcp' })
    expect(risk.level).toBe('needs_confirmation')
    expect(risk.reason).toContain('远程 MCP')
  })
})

describe('execute_code language enforcement at the execution sink', () => {
  it('has no fallback runner for unknown aliases', () => {
    for (const language of ['shell', 'sh', 'python3', '', undefined]) {
      expect(resolveCodeExecutionLanguage(language)).toBeNull()
    }
  })

  it('preserves the three supported execution runners', () => {
    expect(resolveCodeExecutionLanguage(' Python ')).toEqual({
      language: 'python', extension: 'py', runner: 'python3'
    })
    expect(resolveCodeExecutionLanguage('javascript')).toEqual({
      language: 'javascript', extension: 'js', runner: 'node'
    })
    expect(resolveCodeExecutionLanguage('bash')).toEqual({
      language: 'bash', extension: 'sh', runner: 'bash'
    })
  })

  it('keeps the real product-tool sink on the closed resolver with no bash fallback', () => {
    const source = readFileSync(resolve('src/main/openpipal-product-tools.ts'), 'utf8')
    expect(source).toContain('resolveCodeExecutionLanguage(p.language)')
    expect(source).not.toContain("const runner = cmdMap[lang] || 'bash'")
    expect(source).not.toContain("const lang = p.language || 'bash'")
  })
})

describe('audit argument privacy', () => {
  it('retains only type and coarse length buckets without raw values', () => {
    const secret = 'sk-super-secret-api-key-123456'
    const document = 'private customer document body'
    const summary = summarizeAuditArgs({
      apiKey: secret,
      content: document,
      command: `curl -H "Authorization: Bearer ${secret}" https://example.test`,
      count: 42,
      enabled: true,
      nested: { token: secret }
    })

    expect(summary).toContain('apiKey')
    expect(summary).toContain('content')
    expect(summary).toContain('lengthBucket')
    expect(summary).not.toContain('sha256')
    expect(summary).not.toContain('chars')
    expect(summary).not.toContain('keys')
    expect(summary).not.toContain(secret)
    expect(summary).not.toContain(document)
    expect(summary).not.toContain('Authorization')
    expect(summary).not.toContain('"count":42')
    expect(summary).not.toContain('"enabled":true')
  })

  it('does not preserve a guessable fingerprint or exact length for PINs and phone numbers', () => {
    const first = summarizeAuditArgs({ pin: '0427', phone: '13800138000' })
    const sameBuckets = summarizeAuditArgs({ pin: '9876', phone: '19912345678' })

    expect(first).toBe(sameBuckets)
    expect(first).not.toContain('0427')
    expect(first).not.toContain('13800138000')
    expect(first).not.toMatch(/"(?:chars|length|sha256)"/)
    expect(first).toContain('"lengthBucket":"1-8"')
    expect(first).toContain('"lengthBucket":"9-32"')
  })
})

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { classifyToolRisk } from '../../src/main/pi-security'

describe('tool authorization working directory parity', () => {
  it('blocks the credential-bearing OpenPipal config while preserving other data-root reads', () => {
    const config = path.join(os.homedir(), '.openpipal', 'config.json')
    const memory = path.join(os.homedir(), '.openpipal', 'memory', 'notes.md')

    expect(classifyToolRisk('read', { path: config }).level).toBe('risky')
    expect(classifyToolRisk('read_file', { file_path: config }).level).toBe('risky')
    expect(classifyToolRisk('read', { path: memory }).level).toBe('safe')
  })

  it('checks the effective working directory when discovery tools omit path', () => {
    const dataRoot = path.join(os.homedir(), '.openpipal')
    for (const toolName of ['grep', 'find', 'ls']) {
      const assessment = classifyToolRisk(
        toolName,
        toolName === 'grep' ? { pattern: 'apiKey' } : {},
        { workingDir: dataRoot }
      )
      expect(assessment.level).toBe('risky')
    }

    expect(classifyToolRisk(
      'grep',
      { pattern: 'export' },
      { workingDir: path.join(os.homedir(), 'Documents', 'project') }
    ).level).toBe('safe')
  })

  it('fails closed for shell and code when the filesystem sandbox is unavailable', () => {
    expect(classifyToolRisk('bash', {
      command: 'cat ~/.openpipal/config.json'
    }).level).toBe('risky')
    expect(classifyToolRisk('execute_code', {
      language: 'python',
      code: "print(open('/Users/example/.openpipal/config.json').read())"
    }).level).toBe('risky')
  })

  it('resolves relative file paths against the conversation working directory', () => {
    const workingDir = path.join(process.env.HOME || '/tmp', 'Documents', 'openpipal-agent')
    const assessment = classifyToolRisk(
      'read',
      { path: 'notes/context.md' },
      { workingDir }
    )
    expect(assessment.level).toBe('safe')
  })

  it('does not approve a relative path merely because process.cwd is allowed', () => {
    const assessment = classifyToolRisk(
      'read',
      { path: 'passwd' },
      { workingDir: '/etc' }
    )
    expect(assessment.level).toBe('risky')
    expect(assessment.reason).toContain('/etc/passwd')
  })

  it('does not confuse an allow-list sibling with the allowed directory', () => {
    const assessment = classifyToolRisk('write', {
      path: `${os.tmpdir()}-openpipal-escape/file.txt`,
      content: 'x'
    })
    expect(assessment.level).toBe('risky')
  })

  it('canonicalizes a symlinked parent even when the target file is new', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openpipal-security-'))
    try {
      const link = path.join(root, 'outside')
      fs.symlinkSync('/etc', link, 'dir')
      const assessment = classifyToolRisk('write', {
        path: path.join(link, 'openpipal-new-file'),
        content: 'x'
      })
      expect(assessment.level).toBe('risky')
      expect(assessment.reason).toContain('系统目录')
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})

import fs from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { createTemporaryCodeFile } from '../../src/main/code-execution-temp'

describe('execute_code temporary files', () => {
  it('uses private exclusive files even when concurrent calls share a timestamp', () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(123456789)
    const first = createTemporaryCodeFile('py', 'print("first")')
    const second = createTemporaryCodeFile('py', 'print("second")')
    try {
      expect(first.path).not.toBe(second.path)
      expect(fs.readFileSync(first.path, 'utf8')).toBe('print("first")')
      expect(fs.readFileSync(second.path, 'utf8')).toBe('print("second")')
      expect(fs.statSync(first.path).mode & 0o777).toBe(0o600)
      expect(fs.statSync(second.path).mode & 0o777).toBe(0o600)
    } finally {
      first.dispose()
      second.dispose()
      now.mockRestore()
    }
    expect(fs.existsSync(first.path)).toBe(false)
    expect(fs.existsSync(second.path)).toBe(false)
  })

  it('makes cleanup idempotent', () => {
    const temporary = createTemporaryCodeFile('sh', 'echo ok')
    temporary.dispose()
    temporary.dispose()
    expect(fs.existsSync(temporary.path)).toBe(false)
  })
})

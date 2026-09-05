/**
 * execute_code 的 python 运行器按平台取名：Windows 上 python.org 安装器与 py 启动器都不提供
 * `python3`，商店版的 python3.exe 只是个打开 Microsoft Store 的桩——那里真正存在的名字是 `python`。
 */
import { describe, expect, it } from 'vitest'
import { resolveCodeExecutionLanguage } from '../../src/main/code-execution-language'

describe('resolveCodeExecutionLanguage 的平台差异', () => {
  it('python：Windows 用 python，其余平台用 python3', () => {
    expect(resolveCodeExecutionLanguage('python', 'win32')?.runner).toBe('python')
    expect(resolveCodeExecutionLanguage('python', 'darwin')?.runner).toBe('python3')
    expect(resolveCodeExecutionLanguage('python', 'linux')?.runner).toBe('python3')
  })

  it('javascript 与 bash 不分平台', () => {
    expect(resolveCodeExecutionLanguage('javascript', 'win32')).toEqual({
      language: 'javascript', extension: 'js', runner: 'node'
    })
    expect(resolveCodeExecutionLanguage('bash', 'win32')).toEqual({
      language: 'bash', extension: 'sh', runner: 'bash'
    })
  })

  it('不传平台时按当前进程算（macOS / Linux 上就是 python3）', () => {
    const expected = process.platform === 'win32' ? 'python' : 'python3'
    expect(resolveCodeExecutionLanguage('python')?.runner).toBe(expected)
  })
})

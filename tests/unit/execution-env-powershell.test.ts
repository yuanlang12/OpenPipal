/**
 * PowerShell 执行环境与工具实体（Windows 第 2 段）。
 *
 * macOS 上跑不了 pwsh，所以钉的是**形状**：查找顺序是纯函数；非 Windows 平台上要错得明确
 * （shell_unavailable，不是去 spawn 一个不存在的东西）；pi-core 工具包只在 win32 多出
 * `powershell` 这个实体，别的平台一个都不多。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  OpenPipalNodeExecutionEnv,
  POWERSHELL_ARGS,
  powerShellCandidates
} from '../../src/main/openpipal-execution-env'
import { buildPiCoreExecutionTools, offersPowerShellTool } from '../../src/main/agent-runtime/pi-core-execution-tools'

async function onPlatform<T>(platform: NodeJS.Platform, fn: () => T | Promise<T>): Promise<T> {
  const original = Object.getOwnPropertyDescriptor(process, 'platform')!
  Object.defineProperty(process, 'platform', { ...original, value: platform })
  try {
    return await fn()
  } finally {
    Object.defineProperty(process, 'platform', original)
  }
}

const created: string[] = []
function scratchDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openpipal-pwsh-'))
  created.push(dir)
  return dir
}
afterEach(() => {
  while (created.length) fs.rmSync(created.pop()!, { recursive: true, force: true })
})

describe('powerShellCandidates', () => {
  it('PowerShell 7 优先，其次 PATH 上的 5.1，最后 System32 那份兜底', () => {
    const candidates = powerShellCandidates({
      PATH: 'C:\\Program Files\\PowerShell\\7;"C:\\Windows\\System32";',
      SystemRoot: 'C:\\Windows'
    }, 'win32')
    expect(candidates[0]).toBe('C:\\Program Files\\PowerShell\\7\\pwsh.exe')
    expect(candidates).toContain('C:\\Windows\\System32\\powershell.exe')
    expect(candidates.at(-1)).toBe('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe')
    expect(candidates.indexOf('C:\\Windows\\System32\\pwsh.exe'))
      .toBeLessThan(candidates.indexOf('C:\\Program Files\\PowerShell\\7\\powershell.exe'))
  })

  it('PATH 为空也有 System32 兜底；非 Windows 一个候选都没有', () => {
    expect(powerShellCandidates({}, 'win32')).toEqual([
      'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
    ])
    expect(powerShellCandidates({ PATH: 'C:\\x' }, 'darwin')).toEqual([])
  })

  it('启动参数与 Pi 的 powershell 工具一致', () => {
    expect(POWERSHELL_ARGS).toEqual(['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command'])
  })
})

describe('OpenPipalNodeExecutionEnv(shell = powershell)', () => {
  it('非 Windows 上 exec 返回 shell_unavailable，而不是去 spawn', async () => {
    const env = new OpenPipalNodeExecutionEnv(scratchDir(), {}, undefined, 'powershell')
    try {
      const result = await env.exec('Get-Date')
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.error.message).toMatch(/only available on Windows/)
      }
    } finally {
      await env.cleanup()
    }
  })

  it('bash 环境不受影响（默认 shell 仍是 bash）', async () => {
    const env = new OpenPipalNodeExecutionEnv(scratchDir())
    try {
      const result = await env.exec('echo hello')
      expect(result.ok).toBe(true)
      if (result.ok) expect(result.value.stdout.trim()).toBe('hello')
    } finally {
      await env.cleanup()
    }
  })
})

describe('pi-core 工具包里的 powershell 实体', () => {
  it('只在 Windows 上提供', () => {
    expect(offersPowerShellTool('win32')).toBe(true)
    expect(offersPowerShellTool('darwin')).toBe(false)
    expect(offersPowerShellTool('linux')).toBe(false)
  })

  it('macOS 上工具包里没有 powershell', async () => {
    const bundle = buildPiCoreExecutionTools(scratchDir())
    try {
      expect(bundle.tools.map(t => t.name)).not.toContain('powershell')
    } finally {
      await bundle.dispose()
    }
  })

  it('Windows 上多出 powershell，排在 bash 之后；找不到 PowerShell 时错得明确', async () => {
    await onPlatform('win32', async () => {
      const bundle = buildPiCoreExecutionTools(scratchDir())
      try {
        const names = bundle.tools.map(t => t.name)
        expect(names).toContain('powershell')
        expect(names.indexOf('powershell')).toBe(names.indexOf('bash') + 1)
        const tool = bundle.tools.find(t => t.name === 'powershell')!
        expect(tool.description).toMatch(/Windows only/)
        expect((tool.parameters as any).properties.command.description).toMatch(/PowerShell/)
        // macOS 上没有任何候选可执行文件：走到 shell 解析就该停下，报"没找到 PowerShell"
        await expect(
          tool.execute('call-1', { command: 'Get-Date' }, undefined, undefined, bundle.toolContext)
        ).rejects.toThrow(/No PowerShell executable found/)
      } finally {
        await bundle.dispose()
      }
    })
  })
})

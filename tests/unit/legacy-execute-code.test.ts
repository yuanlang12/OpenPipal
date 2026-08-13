import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { describe, expect, it, vi } from 'vitest'

const testWorkingDir = os.tmpdir()

vi.mock('../../src/main/config-manager', () => ({
  getWorkingDir: () => testWorkingDir
}))

vi.mock('../../src/main/sandbox-manager', () => ({
  getSanitizedEnv: () => ({ PATH: process.env.PATH || '/usr/bin:/bin' }),
  sanitizeEnvironment: (env: NodeJS.ProcessEnv) => Object.fromEntries(
    Object.entries(env).filter(([key, value]) => (
      typeof value === 'string' && !/_(KEY|SECRET|TOKEN|PASSWORD|CREDENTIAL)$/i.test(key)
    ))
  ),
  isSandboxed: () => false,
  wrapCommandStrict: async (command: string) => command
}))

// Keep this backend contract test independent from product-tool construction
// and scheduler startup. The code under test is the real legacy Pi process
// operation plus OpenPipal's bounded capture.
vi.mock('../../src/main/openpipal-product-tools', () => ({
  AskUserResolver: class AskUserResolver {},
  buildOpenPipalProductTools: () => [],
  filterOpenPipalTools: (tools: unknown[]) => tools
}))
vi.mock('../../src/main/scheduler', () => ({}))

import { buildPiTools, executeCodeWithLegacyPi } from '../../src/main/pi-tools'
import { buildPiCoreExecutionTools } from '../../src/main/agent-runtime/pi-core-execution-tools'
import { OPENPIPAL_DEFAULT_MAX_CAPTURE_BYTES } from '../../src/main/bounded-output-capture'
import { formatCodeExecutionOutput } from '../../src/main/code-execution-output'

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

function nodeCommand(source: string): string {
  return `${shellQuote(process.execPath)} -e ${shellQuote(source)}`
}

describe('legacy and pi-core execution parity', () => {
  it('uses the credential-filtered discovery worker in both legacy and pi-core', async () => {
    const cwd = fs.mkdtempSync(path.join(testWorkingDir, 'openpipal-search-parity-'))
    fs.writeFileSync(path.join(cwd, '.env.local'), 'TOKEN=MUST_NOT_LEAK\n')
    fs.writeFileSync(path.join(cwd, 'visible.txt'), 'public marker\n')
    const legacy = buildPiTools('acp', {} as never, { workingDir: cwd })
    const core = buildPiCoreExecutionTools(cwd)
    try {
      const legacyGrep = legacy.find(tool => tool.name === 'grep')!
      const coreGrep = core.tools.find(tool => tool.name === 'grep')!
      const legacyResult = await legacyGrep.execute(
        'legacy-grep-credentials',
        { pattern: 'MUST_NOT_LEAK|public', path: '.' },
        undefined,
        undefined
      )
      const coreResult = await coreGrep.execute(
        'core-grep-credentials',
        { pattern: 'MUST_NOT_LEAK|public', path: '.' },
        undefined,
        undefined,
        core.toolContext
      )
      for (const result of [legacyResult, coreResult]) {
        const text = result.content
          .filter(part => part.type === 'text')
          .map(part => part.text)
          .join('')
        expect(text).toContain('public marker')
        expect(text).not.toContain('MUST_NOT_LEAK')
        expect(text).not.toContain('.env.local')
      }
    } finally {
      await core.dispose()
      fs.rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('preserves separate stdout/stderr and the real non-zero exit code in both backends', async () => {
    const command = nodeCommand(
      "process.stdout.write('parity-out'); process.stderr.write('parity-err'); process.exit(7)"
    )
    const legacy = await executeCodeWithLegacyPi({
      command,
      workingDir: path.join(testWorkingDir, 'intentionally-ignored-by-legacy')
    })
    const coreBundle = buildPiCoreExecutionTools(testWorkingDir)
    let core: Awaited<ReturnType<typeof coreBundle.executeCode>>
    try {
      core = await coreBundle.executeCode({ command, workingDir: testWorkingDir })
    } finally {
      await coreBundle.dispose()
    }

    expect(legacy).toEqual(core)
    expect(legacy.stdout).toBe('parity-out')
    expect(legacy.stderr).toBe('parity-err')
    expect(legacy.exitCode).toBe(7)
    expect(formatCodeExecutionOutput(legacy.stdout, legacy.stderr)).toBe(
      '[stdout]\nparity-out\n\n[stderr]\nparity-err'
    )
  })

  it('keeps the legacy execute_code working directory rollback behavior', async () => {
    const result = await executeCodeWithLegacyPi({
      command: nodeCommand(
        "process.stdout.write('legacy-out'); process.stderr.write('legacy-err'); process.exit(7)"
      ),
      workingDir: path.join(testWorkingDir, 'intentionally-ignored-by-legacy')
    })

    expect(result.stdout).toBe('legacy-out')
    expect(result.stderr).toBe('legacy-err')
    expect(result.exitCode).toBe(7)
  })

  it('bounds the legacy combined output retained in the main process', async () => {
    const result = await executeCodeWithLegacyPi({
      command: nodeCommand(
        `process.stdout.write('x'.repeat(${OPENPIPAL_DEFAULT_MAX_CAPTURE_BYTES * 3}))`
      ),
      workingDir: testWorkingDir
    })

    expect(Buffer.byteLength(result.stdout)).toBeLessThanOrEqual(
      OPENPIPAL_DEFAULT_MAX_CAPTURE_BYTES
    )
    expect(result.stdout).toContain('[OpenPipal: stdout truncated;')
    expect(result.exitCode).toBe(0)
  })

  it('forwards cancellation to the legacy process operation', async () => {
    const controller = new AbortController()
    controller.abort()

    await expect(executeCodeWithLegacyPi({
      command: nodeCommand("process.stdout.write('must-not-run')"),
      workingDir: testWorkingDir,
      signal: controller.signal
    })).rejects.toThrow('aborted')
  })

  it('always routes the default legacy bash tool through the OpenPipal bounds', async () => {
    const secretKey = 'LEGACY_BASH_TEST_TOKEN'
    const previous = process.env[secretKey]
    process.env[secretKey] = 'must-not-leak'
    try {
      const tools = buildPiTools('acp', {} as never)
      const bash = tools.find(tool => tool.name === 'bash')
      expect(bash).toBeDefined()
      const result = await bash!.execute(
        'legacy-bash-sanitized',
        { command: `printf '%s' "\${${secretKey}:-unset}"` },
        undefined,
        undefined
      )
      const text = result.content
        .filter(part => part.type === 'text')
        .map(part => part.text)
        .join('')
      expect(text).toBe('unset')

      await expect(bash!.execute(
        'legacy-bash-timeout-limit',
        { command: 'printf should-not-run', timeout: 601 },
        undefined,
        undefined
      )).rejects.toThrow('at most 600 seconds')
    } finally {
      if (previous === undefined) delete process.env[secretKey]
      else process.env[secretKey] = previous
    }
  })
})

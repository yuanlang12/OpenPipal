import { Buffer } from 'node:buffer'
import fs from 'node:fs'
import { afterEach, describe, expect, it } from 'vitest'
import { createOpenPipalBoundedOutputCapture } from '../../src/main/bounded-output-capture'
import { buildPiCoreExecutionTools } from '../../src/main/agent-runtime/pi-core-execution-tools'
import {
  OPENPIPAL_MAX_CAPTURE_BYTES_PER_STREAM,
  OPENPIPAL_MAX_SHELL_TIMEOUT_SECONDS,
  OPENPIPAL_MAX_TOTAL_OUTPUT_BYTES,
  OpenPipalNodeExecutionEnv
} from '../../src/main/openpipal-execution-env'

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

function nodeCommand(source: string): string {
  return `${shellQuote(process.execPath)} -e ${shellQuote(source)}`
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}

async function expectProcessGone(pid: number): Promise<void> {
  const deadline = Date.now() + 1_500
  while (Date.now() < deadline) {
    if (!processExists(pid)) return
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  expect(processExists(pid), `process ${pid} should have been terminated`).toBe(false)
}

const environments: OpenPipalNodeExecutionEnv[] = []

function createEnv(
  policy: ConstructorParameters<typeof OpenPipalNodeExecutionEnv>[1] = {}
): OpenPipalNodeExecutionEnv {
  const env = new OpenPipalNodeExecutionEnv(process.cwd(), policy)
  environments.push(env)
  return env
}

afterEach(async () => {
  await Promise.all(environments.splice(0).map(env => env.cleanup()))
})

describe('OpenPipalNodeExecutionEnv execution bounds', () => {
  it('provides a shared byte-bounded capture for the legacy facade', () => {
    const capture = createOpenPipalBoundedOutputCapture('combined output', 256)
    capture.append(Buffer.from('早'.repeat(200)))
    capture.append(Buffer.from('tail'))

    const value = capture.value()
    expect(Buffer.byteLength(value)).toBeLessThanOrEqual(256)
    expect(value).toContain('[OpenPipal: combined output truncated;')
    expect(value.endsWith('tail')).toBe(true)
    expect(value).not.toContain('\ufffd')
  })

  it.each([1, 2, 8, 32, 64])(
    'keeps the exact byte ceiling even when the %i-byte budget is smaller than its marker',
    (maxBytes) => {
      const capture = createOpenPipalBoundedOutputCapture('超长输出', maxBytes)
      capture.append('早'.repeat(200))
      const value = capture.value()
      expect(Buffer.byteLength(value)).toBeLessThanOrEqual(maxBytes)
      expect(value).not.toContain('\ufffd')
    }
  )

  it('caps direct stdout and stderr results while preserving streamed callbacks', async () => {
    const maxBytes = 4 * 1024
    const outputBytes = maxBytes * 8
    const env = createEnv({ maxCaptureBytesPerStream: maxBytes })
    let streamedStdoutBytes = 0
    let streamedStderrBytes = 0

    const result = await env.exec(nodeCommand(
      `process.stdout.write('o'.repeat(${outputBytes})); process.stderr.write('e'.repeat(${outputBytes}))`
    ), {
      onStdout: chunk => { streamedStdoutBytes += Buffer.byteLength(chunk) },
      onStderr: chunk => { streamedStderrBytes += Buffer.byteLength(chunk) }
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(Buffer.byteLength(result.value.stdout)).toBeLessThanOrEqual(maxBytes)
    expect(Buffer.byteLength(result.value.stderr)).toBeLessThanOrEqual(maxBytes)
    expect(result.value.stdout).toContain('[OpenPipal: stdout truncated;')
    expect(result.value.stderr).toContain('[OpenPipal: stderr truncated;')
    expect(result.value.stdout).toContain(`${outputBytes} total bytes`)
    expect(result.value.stderr).toContain(`${outputBytes} total bytes`)
    expect(streamedStdoutBytes).toBe(outputBytes)
    expect(streamedStderrBytes).toBe(outputBytes)
  })

  it('scrubs inherited credentials while preserving explicit environment options', async () => {
    const key = 'OPENPIPAL_EXECUTION_TEST_TOKEN'
    const previous = process.env[key]
    process.env[key] = 'must-not-reach-child'
    try {
      const env = createEnv()
      const result = await env.exec(
        `printf '%s|%s|%s' "\${${key}:-unset}" "$OPENPIPAL_EXPLICIT_VALUE" "\${EXPLICIT_SECRET_TOKEN:-unset}"`,
        {
          env: {
            OPENPIPAL_EXPLICIT_VALUE: 'explicit-ok',
            EXPLICIT_SECRET_TOKEN: 'also-must-not-reach-child'
          }
        }
      )
      expect(result.ok).toBe(true)
      if (result.ok) expect(result.value.stdout).toBe('unset|explicit-ok|unset')
    } finally {
      if (previous === undefined) delete process.env[key]
      else process.env[key] = previous
    }
  })

  it('uses a finite default timeout and kills the whole process group', async () => {
    if (process.platform === 'win32') return
    const env = createEnv({
      // Leave enough startup headroom under the full parallel suite for the
      // child PID to be observed before the timeout still terminates it.
      // 0.5s was not enough: on 2026-08-25 the full suite failed here in 2 of 3
      // baseline runs — two `node` spawns simply do not finish that fast under
      // load, so the PID never arrived. What this test asserts is that the
      // default timeout is *finite* and takes the whole process group with it;
      // the exact number is irrelevant, so buy headroom.
      defaultTimeoutSeconds: 2,
      maxTimeoutSeconds: 4
    })
    let grandchildPid: number | undefined
    const source = [
      "const { spawn } = require('node:child_process')",
      "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })",
      "process.stdout.write(String(child.pid) + '\\n')",
      'setInterval(() => {}, 1000)'
    ].join(';')

    const result = await env.exec(nodeCommand(source), {
      onStdout: chunk => {
        const parsed = Number.parseInt(chunk.trim(), 10)
        if (Number.isInteger(parsed)) grandchildPid = parsed
      }
    })

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('timeout')
    expect(grandchildPid).toBeTypeOf('number')
    await expectProcessGone(grandchildPid!)
  })

  it('aborts a running process group and reports the public aborted error code', async () => {
    if (process.platform === 'win32') return
    const env = createEnv()
    const controller = new AbortController()
    let childPid: number | undefined

    const result = await env.exec(nodeCommand(
      "process.stdout.write(String(process.pid) + '\\n'); setInterval(() => {}, 1000)"
    ), {
      abortSignal: controller.signal,
      onStdout: chunk => {
        const parsed = Number.parseInt(chunk.trim(), 10)
        if (Number.isInteger(parsed)) {
          childPid = parsed
          controller.abort()
        }
      }
    })

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('aborted')
    expect(childPid).toBeTypeOf('number')
    await expectProcessGone(childPid!)
  })

  it('cleanup aborts active commands and waits for their process groups to close', async () => {
    if (process.platform === 'win32') return
    const env = createEnv()
    let childPid: number | undefined
    let markPidReady!: () => void
    const pidReady = new Promise<void>(resolve => { markPidReady = resolve })
    const execution = env.exec(nodeCommand(
      "process.stdout.write(String(process.pid) + '\\n'); setInterval(() => {}, 1000)"
    ), {
      onStdout: chunk => {
        const parsed = Number.parseInt(chunk.trim(), 10)
        if (Number.isInteger(parsed)) {
          childPid = parsed
          markPidReady()
        }
      }
    })

    await pidReady
    await env.cleanup()
    const result = await execution

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('aborted')
    expect(childPid).toBeTypeOf('number')
    await expectProcessGone(childPid!)

    const afterCleanup = await env.exec('printf must-not-spawn')
    expect(afterCleanup.ok).toBe(false)
    if (!afterCleanup.ok) expect(afterCleanup.error.code).toBe('aborted')
  })

  it('kills the process and stops callbacks at the aggregate stdout + stderr budget', async () => {
    if (process.platform === 'win32') return
    const maxTotalOutputBytes = 16 * 1024
    const env = createEnv({ maxTotalOutputBytes })
    let callbackBytes = 0
    let childPid: number | undefined
    const result = await env.exec(nodeCommand([
      "process.stdout.write(String(process.pid) + '\\n' + 'o'.repeat(32768))",
      "process.stderr.write('e'.repeat(32768))",
      'setInterval(() => {}, 1000)'
    ].join(';')), {
      onStdout: chunk => {
        callbackBytes += Buffer.byteLength(chunk)
        const parsed = Number.parseInt(chunk, 10)
        if (Number.isInteger(parsed)) childPid = parsed
      },
      onStderr: chunk => { callbackBytes += Buffer.byteLength(chunk) }
    })

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.code).toBe('unknown')
      expect(result.error.message).toContain('stdout + stderr limit')
      expect(result.error.message).toContain(`${maxTotalOutputBytes} bytes`)
    }
    expect(callbackBytes).toBeLessThanOrEqual(maxTotalOutputBytes)
    expect(childPid).toBeTypeOf('number')
    await expectProcessGone(childPid!)
  })

  it('returns callback_error and terminates the command when a stream callback throws', async () => {
    const env = createEnv()
    const result = await env.exec(nodeCommand(
      "process.stdout.write('first'); setInterval(() => {}, 1000)"
    ), {
      onStdout: () => { throw new Error('synthetic callback failure') }
    })

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.code).toBe('callback_error')
      expect(result.error.message).toContain('synthetic callback failure')
    }
  })

  it('rejects timeouts above the OpenPipal ceiling before spawning', async () => {
    const env = createEnv()
    const result = await env.exec('printf should-not-run', {
      timeout: OPENPIPAL_MAX_SHELL_TIMEOUT_SECONDS + 1
    })

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.code).toBe('timeout')
      expect(result.error.message).toContain(`${OPENPIPAL_MAX_SHELL_TIMEOUT_SECONDS} seconds`)
    }
  })

  it('keeps the production capture ceiling finite', () => {
    expect(OPENPIPAL_MAX_CAPTURE_BYTES_PER_STREAM).toBe(128 * 1024)
    expect(OPENPIPAL_MAX_TOTAL_OUTPUT_BYTES).toBe(8 * 1024 * 1024)
  })

  it('keeps the official createBashTool streaming and truncation behavior', async () => {
    const bundle = buildPiCoreExecutionTools(process.cwd())
    try {
      const bash = bundle.tools.find(tool => tool.name === 'bash')
      expect(bash).toBeDefined()
      const updates: unknown[] = []
      const result = await bash!.execute(
        'bounded-bash',
        { command: nodeCommand("process.stdout.write('x'.repeat(96 * 1024))") },
        undefined,
        update => { updates.push(update) },
        bundle.toolContext
      )
      const text = result.content
        .filter(part => part.type === 'text')
        .map(part => part.text)
        .join('')
      expect(updates.length).toBeGreaterThan(1)
      expect(text).toContain('Full output:')
      expect((result.details as { truncation?: { truncated?: boolean } } | undefined)?.truncation?.truncated)
        .toBe(true)
    } finally {
      await bundle.dispose()
    }
  })

  it('bounds the official createBashTool callback and full-log path at the aggregate limit', async () => {
    const maxTotalOutputBytes = 96 * 1024
    const bundle = buildPiCoreExecutionTools(process.cwd(), { maxTotalOutputBytes })
    let fullOutputPath: string | undefined
    try {
      const bash = bundle.tools.find(tool => tool.name === 'bash')
      expect(bash).toBeDefined()
      const execution = bash!.execute(
        'bounded-official-full-log',
        {
          command: nodeCommand([
            "const chunk = 'x'.repeat(4096) + '\\n'",
            'const timer = setInterval(() => process.stdout.write(chunk), 15)',
            'setTimeout(() => clearInterval(timer), 5000)'
          ].join(';'))
        },
        undefined,
        update => {
          const details = update.details as { fullOutputPath?: string } | undefined
          if (details?.fullOutputPath) fullOutputPath = details.fullOutputPath
        },
        bundle.toolContext
      )

      await expect(execution).rejects.toThrow('stdout + stderr limit')
      expect(fullOutputPath).toBeTypeOf('string')
      expect(fs.statSync(fullOutputPath!).size).toBeLessThanOrEqual(maxTotalOutputBytes)
    } finally {
      await bundle.dispose()
    }
  })
})

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { NodeExecutionEnv } from '@earendil-works/pi-agent-core/node'
import { afterEach, describe, expect, it } from 'vitest'
import {
  createOpenPipalFindTool,
  createOpenPipalGrepTool,
  createOpenPipalLsTool,
  getOpenPipalSearchWorkerPoolSnapshot
} from '../../src/main/agent-runtime/openpipal-search-tools'

const tempRoots: string[] = []

function createRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openpipal-search-'))
  tempRoots.push(root)
  return root
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 2_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for search worker state')
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

describe('OpenPipal public search tools', () => {
  it('hard-skips nested dotenv credentials for grep, find, and ls', async () => {
    const root = createRoot()
    fs.mkdirSync(path.join(root, 'nested'))
    fs.mkdirSync(path.join(root, '.env.private'))
    fs.writeFileSync(path.join(root, '.env'), 'TOKEN=ROOT_SECRET\n')
    fs.writeFileSync(path.join(root, '.env.local'), 'TOKEN=LOCAL_SECRET\n')
    fs.writeFileSync(path.join(root, '.envrc'), 'export TOKEN=ENVRC_SECRET\n')
    fs.writeFileSync(path.join(root, '.env.private', 'hidden.txt'), 'ROOT_SECRET\n')
    fs.writeFileSync(path.join(root, 'nested', '.env.production'), 'TOKEN=NESTED_SECRET\n')
    fs.writeFileSync(path.join(root, 'visible.txt'), 'public marker\n')

    const env = new NodeExecutionEnv({ cwd: root })
    try {
      const grep = await createOpenPipalGrepTool().execute(
        'grep-dotenv',
        { pattern: 'SECRET|public', path: '.' },
        undefined,
        undefined,
        { env }
      )
      const grepText = (grep.content[0] as { text: string }).text
      expect(grepText).toContain('visible.txt:1: public marker')
      expect(grepText).not.toContain('SECRET')
      expect(grepText).not.toContain('.env')

      const find = await createOpenPipalFindTool().execute(
        'find-dotenv',
        { pattern: '*', path: '.' },
        undefined,
        undefined,
        { env }
      )
      const findText = (find.content[0] as { text: string }).text
      expect(findText).toContain('visible.txt')
      expect(findText).not.toContain('.env')

      const ls = await createOpenPipalLsTool().execute(
        'ls-dotenv',
        { path: '.' },
        undefined,
        undefined,
        { env }
      )
      const lsText = (ls.content[0] as { text: string }).text
      expect(lsText).toContain('visible.txt')
      expect(lsText).not.toContain('.env')

      await expect(createOpenPipalGrepTool().execute(
        'grep-explicit-dotenv',
        { pattern: 'TOKEN', path: '.env' },
        undefined,
        undefined,
        { env }
      )).rejects.toThrow('Credential files are excluded')
    } finally {
      await env.cleanup()
    }
  })

  it('honors root and nested ignore files for grep and find', async () => {
    const root = createRoot()
    fs.mkdirSync(path.join(root, 'nested'))
    fs.writeFileSync(path.join(root, '.gitignore'), 'ignored.txt\nignored-dir/\n')
    fs.writeFileSync(path.join(root, 'visible.txt'), 'needle visible\n')
    fs.writeFileSync(path.join(root, 'ignored.txt'), 'needle secret\n')
    fs.mkdirSync(path.join(root, 'ignored-dir'))
    fs.writeFileSync(path.join(root, 'ignored-dir', 'hidden.txt'), 'needle hidden\n')
    fs.writeFileSync(path.join(root, 'nested', '.ignore'), 'private.txt\n')
    fs.writeFileSync(path.join(root, 'nested', 'private.txt'), 'needle private\n')
    fs.writeFileSync(path.join(root, 'nested', 'public.txt'), 'needle public\n')
    fs.mkdirSync(path.join(root, 'nested', 'deeper'))
    fs.writeFileSync(path.join(root, 'nested', 'deeper', 'private.txt'), 'needle deep private\n')

    const env = new NodeExecutionEnv({ cwd: root })
    const context = { env }
    try {
      const grep = await createOpenPipalGrepTool().execute(
        'grep-1',
        { pattern: 'needle', path: '.' },
        undefined,
        undefined,
        context
      )
      const grepText = (grep.content[0] as { text: string }).text
      expect(grepText).toContain('visible.txt:1: needle visible')
      expect(grepText).toContain('nested/public.txt:1: needle public')
      expect(grepText).not.toContain('secret')
      expect(grepText).not.toContain('hidden')
      expect(grepText).not.toContain('private')

      const find = await createOpenPipalFindTool().execute(
        'find-1',
        { pattern: '*.txt', path: '.' },
        undefined,
        undefined,
        context
      )
      const findText = (find.content[0] as { text: string }).text
      expect(findText).toContain('visible.txt')
      expect(findText).toContain('nested/public.txt')
      expect(findText).not.toContain('ignored.txt')
      expect(findText).not.toContain('private.txt')
    } finally {
      await env.cleanup()
    }
  })

  it('honors a repository parent .gitignore when searching a subdirectory', async () => {
    const root = createRoot()
    const source = path.join(root, 'src')
    fs.mkdirSync(path.join(root, '.git'))
    fs.mkdirSync(source)
    fs.writeFileSync(path.join(root, '.gitignore'), '/src/generated.txt\n')
    fs.writeFileSync(path.join(source, 'generated.txt'), 'needle ignored\n')
    fs.writeFileSync(path.join(source, 'kept.txt'), 'needle kept\n')
    // Generated directories are not silently hidden unless an ignore rule says so.
    fs.mkdirSync(path.join(source, 'dist'))
    fs.writeFileSync(path.join(source, 'dist', 'kept.txt'), 'needle dist\n')

    const env = new NodeExecutionEnv({ cwd: root })
    try {
      const result = await createOpenPipalGrepTool().execute(
        'grep-parent-ignore',
        { pattern: 'needle', path: 'src' },
        undefined,
        undefined,
        { env }
      )
      const text = (result.content[0] as { text: string }).text
      expect(text).toContain('kept.txt:1: needle kept')
      expect(text).toContain('dist/kept.txt:1: needle dist')
      expect(text).not.toContain('generated.txt')
    } finally {
      await env.cleanup()
    }
  })

  it('uses ripgrep ignore files for grep and fd ignore files for find', async () => {
    const root = createRoot()
    const source = path.join(root, 'src')
    const nested = path.join(source, 'nested')
    fs.mkdirSync(path.join(root, '.git'))
    fs.mkdirSync(source)
    fs.mkdirSync(nested)
    fs.writeFileSync(path.join(root, '.rgignore'), '/src/rg-parent.txt\n')
    fs.writeFileSync(path.join(root, '.fdignore'), '/src/fd-parent.txt\n')
    fs.writeFileSync(path.join(root, '.ignore'), '/src/shared-parent.txt\n')
    fs.writeFileSync(path.join(nested, '.rgignore'), 'rg-nested.txt\n')
    fs.writeFileSync(path.join(nested, '.fdignore'), 'fd-nested.txt\n')
    for (const relative of [
      'rg-parent.txt',
      'fd-parent.txt',
      'shared-parent.txt',
      'nested/rg-nested.txt',
      'nested/fd-nested.txt',
      'visible.txt'
    ]) {
      fs.writeFileSync(path.join(source, relative), `needle ${relative}\n`)
    }

    const env = new NodeExecutionEnv({ cwd: root })
    try {
      const grep = await createOpenPipalGrepTool().execute(
        'grep-ignore-differential',
        { pattern: 'needle', path: 'src' },
        undefined,
        undefined,
        { env }
      )
      const grepText = (grep.content[0] as { text: string }).text
      expect(grepText).not.toContain('rg-parent.txt')
      expect(grepText).not.toContain('rg-nested.txt')
      expect(grepText).not.toContain('shared-parent.txt')
      expect(grepText).toContain('fd-parent.txt')
      expect(grepText).toContain('fd-nested.txt')
      expect(grepText).toContain('visible.txt')

      const find = await createOpenPipalFindTool().execute(
        'find-ignore-differential',
        { pattern: '*.txt', path: 'src' },
        undefined,
        undefined,
        { env }
      )
      const findText = (find.content[0] as { text: string }).text
      expect(findText).not.toContain('fd-parent.txt')
      expect(findText).not.toContain('fd-nested.txt')
      expect(findText).not.toContain('shared-parent.txt')
      expect(findText).toContain('rg-parent.txt')
      expect(findText).toContain('rg-nested.txt')
      expect(findText).toContain('visible.txt')
    } finally {
      await env.cleanup()
    }
  })

  it('skips oversized text files instead of loading them into memory', async () => {
    const root = createRoot()
    fs.writeFileSync(path.join(root, 'small.txt'), 'needle small\n')
    fs.writeFileSync(path.join(root, 'large.txt'), `needle ${'x'.repeat(128)}\n`)
    const env = new NodeExecutionEnv({ cwd: root })
    try {
      const result = await createOpenPipalGrepTool({ maxGrepFileBytes: 32 }).execute(
        'grep-2',
        { pattern: 'needle', path: '.' },
        undefined,
        undefined,
        { env }
      )
      const text = (result.content[0] as { text: string }).text
      expect(text).toContain('small.txt:1: needle small')
      expect(text).not.toContain('large.txt:1')
      expect(result.details?.largeFilesSkipped).toBe(1)
    } finally {
      await env.cleanup()
    }
  })

  it('stops a no-match traversal at its hard entry ceiling', async () => {
    const root = createRoot()
    for (let index = 0; index < 10; index += 1) {
      fs.writeFileSync(path.join(root, `${String(index).padStart(2, '0')}.txt`), 'nothing\n')
    }
    const env = new NodeExecutionEnv({ cwd: root })
    try {
      const result = await createOpenPipalGrepTool({ maxTraversedEntries: 3 }).execute(
        'grep-3',
        { pattern: 'missing', path: '.' },
        undefined,
        undefined,
        { env }
      )
      expect(result.details?.scanLimitReached).toBe(3)
      expect((result.content[0] as { text: string }).text).toContain('3 scanned entries limit')
    } finally {
      await env.cleanup()
    }
  })

  it('observes cancellation before filesystem traversal', async () => {
    const root = createRoot()
    fs.writeFileSync(path.join(root, 'visible.txt'), 'needle\n')
    const env = new NodeExecutionEnv({ cwd: root })
    const controller = new AbortController()
    controller.abort()
    try {
      await expect(createOpenPipalFindTool().execute(
        'find-abort',
        { pattern: '*.txt', path: '.' },
        controller.signal,
        undefined,
        { env }
      )).rejects.toThrow('Operation aborted')
    } finally {
      await env.cleanup()
    }
  })

  it('isolates catastrophic regular expressions behind a wall-clock timeout', async () => {
    const root = createRoot()
    fs.writeFileSync(path.join(root, 'evil.txt'), `${'a'.repeat(100_000)}!\n`)
    const env = new NodeExecutionEnv({ cwd: root })
    let heartbeatFired = false
    const heartbeat = setTimeout(() => { heartbeatFired = true }, 25)
    const startedAt = Date.now()
    try {
      await expect(createOpenPipalGrepTool({ timeoutMs: 200 }).execute(
        'grep-evil-regex',
        { pattern: '^(a+)+$', path: 'evil.txt' },
        undefined,
        undefined,
        { env }
      )).rejects.toThrow('Search timed out after 200ms')
      expect(heartbeatFired).toBe(true)
      expect(Date.now() - startedAt).toBeLessThan(2_000)
    } finally {
      clearTimeout(heartbeat)
      await env.cleanup()
    }
  })

  it('terminates an in-flight isolated search when aborted', async () => {
    const root = createRoot()
    fs.writeFileSync(path.join(root, 'evil.txt'), `${'a'.repeat(100_000)}!\n`)
    const env = new NodeExecutionEnv({ cwd: root })
    const controller = new AbortController()
    const abortTimer = setTimeout(() => controller.abort(), 50)
    const startedAt = Date.now()
    try {
      await expect(createOpenPipalGrepTool({ timeoutMs: 2_000 }).execute(
        'grep-abort-in-flight',
        { pattern: '^(a+)+$', path: 'evil.txt' },
        controller.signal,
        undefined,
        { env }
      )).rejects.toThrow('Operation aborted')
      expect(Date.now() - startedAt).toBeLessThan(1_000)
    } finally {
      clearTimeout(abortTimer)
      await env.cleanup()
    }
  })

  it('bounds long-line and many-file output and clamps excessive context', async () => {
    const root = createRoot()
    for (let index = 0; index < 200; index += 1) {
      fs.writeFileSync(
        path.join(root, `${String(index).padStart(3, '0')}.txt`),
        `needle ${'x'.repeat(800)}\n`
      )
    }
    const env = new NodeExecutionEnv({ cwd: root })
    try {
      const result = await createOpenPipalGrepTool().execute(
        'grep-bounded-output',
        { pattern: 'needle', path: '.', context: 10_000, limit: 10_000 },
        undefined,
        undefined,
        { env }
      )
      const text = (result.content[0] as { text: string }).text
      expect(result.details?.contextLimitApplied).toBe(10)
      expect(result.details?.requestedLimitApplied).toBe(1000)
      expect(result.details?.linesTruncated).toBe(true)
      expect(result.details?.workerResultLimitReached).toBe(102_400)
      expect(result.details?.truncation?.truncated).toBe(true)
      expect(text.length).toBeLessThan(55_000)
      expect(text).toContain('000.txt:1: needle')
      expect(text.indexOf('000.txt')).toBeLessThan(text.indexOf('001.txt'))
    } finally {
      await env.cleanup()
    }
  })

  it('preserves literal, case, glob, context, and result-limit semantics', async () => {
    const root = createRoot()
    fs.writeFileSync(path.join(root, 'match.ts'), 'before\nA+B\nafter\n')
    fs.writeFileSync(path.join(root, 'filtered.txt'), 'A+B\n')
    fs.writeFileSync(path.join(root, 'second.ts'), 'A+B\n')
    const env = new NodeExecutionEnv({ cwd: root })
    try {
      const result = await createOpenPipalGrepTool().execute(
        'grep-semantics',
        {
          pattern: 'a+b',
          path: '.',
          glob: '*.ts',
          literal: true,
          ignoreCase: true,
          context: 1,
          limit: 1
        },
        undefined,
        undefined,
        { env }
      )
      const text = (result.content[0] as { text: string }).text
      expect(text).toContain('match.ts-1- before')
      expect(text).toContain('match.ts:2: A+B')
      expect(text).toContain('match.ts-3- after')
      expect(text).not.toContain('filtered.txt')
      expect(text).not.toContain('second.ts')
      expect(result.details?.matchLimitReached).toBe(1)
    } finally {
      await env.cleanup()
    }
  })

  it('supports the common ripgrep leading (?i) mode inside the isolated worker', async () => {
    const root = createRoot()
    fs.writeFileSync(path.join(root, 'case.txt'), 'NEEDLE uppercase\n')
    const env = new NodeExecutionEnv({ cwd: root })
    try {
      const result = await createOpenPipalGrepTool().execute(
        'grep-rg-case-prefix',
        { pattern: '(?i)needle', path: '.' },
        undefined,
        undefined,
        { env }
      )
      expect((result.content[0] as { text: string }).text)
        .toContain('case.txt:1: NEEDLE uppercase')
    } finally {
      await env.cleanup()
    }
  })

  it('limits process-wide worker concurrency while the main thread stays responsive', async () => {
    const root = createRoot()
    fs.writeFileSync(path.join(root, 'evil.txt'), `${'a'.repeat(100_000)}!\n`)
    const env = new NodeExecutionEnv({ cwd: root })
    let observedMaxActive = 0
    let heartbeats = 0
    const monitor = setInterval(() => {
      const snapshot = getOpenPipalSearchWorkerPoolSnapshot()
      observedMaxActive = Math.max(observedMaxActive, snapshot.active)
      heartbeats += 1
    }, 5)
    try {
      const searches = Array.from({ length: 6 }, (_, index) => (
        createOpenPipalGrepTool({ timeoutMs: 160 }).execute(
          `grep-concurrent-${index}`,
          { pattern: '^(a+)+$', path: 'evil.txt' },
          undefined,
          undefined,
          { env }
        ).then(
          () => 'unexpected success',
          error => error instanceof Error ? error.message : String(error)
        )
      ))
      const messages = await Promise.all(searches)
      expect(messages.every(message => message === 'Search timed out after 160ms')).toBe(true)
      expect(observedMaxActive).toBe(2)
      expect(observedMaxActive).toBeLessThanOrEqual(
        getOpenPipalSearchWorkerPoolSnapshot().maxActive
      )
      expect(heartbeats).toBeGreaterThan(10)
      expect(getOpenPipalSearchWorkerPoolSnapshot()).toMatchObject({ active: 0, queued: 0 })
    } finally {
      clearInterval(monitor)
      await env.cleanup()
    }
  })

  it('cancels queued work and fails clearly when the finite worker queue is full', async () => {
    const root = createRoot()
    fs.writeFileSync(path.join(root, 'evil.txt'), `${'a'.repeat(100_000)}!\n`)
    const env = new NodeExecutionEnv({ cwd: root })
    const tool = createOpenPipalGrepTool({ timeoutMs: 2_000 })
    const controllers: AbortController[] = []
    const start = (id: string, controller: AbortController): Promise<unknown> => {
      controllers.push(controller)
      return tool.execute(
        id,
        { pattern: '^(a+)+$', path: 'evil.txt' },
        controller.signal,
        undefined,
        { env }
      )
    }

    try {
      const active = [
        start('pool-active-1', new AbortController()),
        start('pool-active-2', new AbortController())
      ]
      await waitFor(() => getOpenPipalSearchWorkerPoolSnapshot().active === 2)

      const queuedController = new AbortController()
      const queued = start('pool-queued-cancel', queuedController)
      await waitFor(() => getOpenPipalSearchWorkerPoolSnapshot().queued === 1)
      queuedController.abort()
      await expect(queued).rejects.toThrow('Operation aborted')
      await waitFor(() => getOpenPipalSearchWorkerPoolSnapshot().queued === 0)

      const fill = Array.from({ length: 8 }, (_, index) => (
        start(`pool-fill-${index}`, new AbortController())
      ))
      await waitFor(() => getOpenPipalSearchWorkerPoolSnapshot().queued === 8)
      await expect(tool.execute(
        'pool-overflow',
        { pattern: '^(a+)+$', path: 'evil.txt' },
        undefined,
        undefined,
        { env }
      )).rejects.toThrow('Search worker queue is full (8 pending)')

      for (const controller of controllers) controller.abort()
      await Promise.allSettled([...active, ...fill])
      await waitFor(() => {
        const snapshot = getOpenPipalSearchWorkerPoolSnapshot()
        return snapshot.active === 0 && snapshot.queued === 0
      })
    } finally {
      for (const controller of controllers) controller.abort()
      await env.cleanup()
    }
  })

  it.skipIf(process.platform === 'win32')(
    'follows explicitly selected root symlinks without recursing through nested symlinks',
    async () => {
      const root = createRoot()
      const target = path.join(root, 'target')
      const outside = path.join(root, 'outside')
      fs.mkdirSync(target)
      fs.mkdirSync(outside)
      fs.writeFileSync(path.join(target, 'visible.txt'), 'needle visible\n')
      fs.writeFileSync(path.join(outside, 'secret.txt'), 'needle secret\n')
      fs.writeFileSync(path.join(outside, 'outside-ignore'), 'visible.txt\n')
      fs.symlinkSync(path.join(target, 'visible.txt'), path.join(root, 'file-link.txt'))
      fs.symlinkSync(target, path.join(root, 'dir-link'))
      fs.symlinkSync(outside, path.join(target, 'nested-link'))
      fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(target, 'nested-file-link.txt'))
      fs.symlinkSync(path.join(outside, 'outside-ignore'), path.join(target, '.rgignore'))

      const env = new NodeExecutionEnv({ cwd: root })
      try {
        const fileResult = await createOpenPipalGrepTool().execute(
          'grep-root-file-link',
          { pattern: 'needle', path: 'file-link.txt' },
          undefined,
          undefined,
          { env }
        )
        expect((fileResult.content[0] as { text: string }).text)
          .toContain('file-link.txt:1: needle visible')

        const directoryResult = await createOpenPipalGrepTool().execute(
          'grep-root-dir-link',
          { pattern: 'needle', path: 'dir-link' },
          undefined,
          undefined,
          { env }
        )
        const directoryText = (directoryResult.content[0] as { text: string }).text
        expect(directoryText).toContain('visible.txt:1: needle visible')
        expect(directoryText).not.toContain('secret')

        const findResult = await createOpenPipalFindTool().execute(
          'find-root-dir-link',
          { pattern: '*.txt', path: 'dir-link' },
          undefined,
          undefined,
          { env }
        )
        const findText = (findResult.content[0] as { text: string }).text
        expect(findText).toContain('visible.txt')
        expect(findText).not.toContain('secret.txt')
        expect(findText).not.toContain('nested-file-link.txt')
      } finally {
        await env.cleanup()
      }
    }
  )

  it.skipIf(process.platform === 'win32')(
    'never returns out-of-root content during repeated local path swaps',
    async () => {
      const root = createRoot()
      const outside = createRoot()
      const volatile = path.join(root, 'volatile')
      const parked = path.join(root, 'volatile-parked')
      const flappingFile = path.join(root, 'flapping.txt')
      const parkedFile = path.join(root, 'flapping-safe.txt')
      fs.mkdirSync(volatile)
      fs.writeFileSync(path.join(outside, 'secret.txt'), 'ESCAPE_SENTINEL\n')
      for (let index = 0; index < 300; index += 1) {
        fs.writeFileSync(path.join(volatile, `${index}.txt`), 'safe\n')
      }
      fs.writeFileSync(flappingFile, 'safe\n')

      let directoryLinked = false
      let fileLinked = false
      const swap = (): void => {
        try {
          if (directoryLinked) {
            fs.unlinkSync(volatile)
            fs.renameSync(parked, volatile)
          } else {
            fs.renameSync(volatile, parked)
            fs.symlinkSync(outside, volatile)
          }
          directoryLinked = !directoryLinked
        } catch { /* another filesystem operation won this tick */ }
        try {
          if (fileLinked) {
            fs.unlinkSync(flappingFile)
            fs.renameSync(parkedFile, flappingFile)
          } else {
            fs.renameSync(flappingFile, parkedFile)
            fs.symlinkSync(path.join(outside, 'secret.txt'), flappingFile)
          }
          fileLinked = !fileLinked
        } catch { /* another filesystem operation won this tick */ }
      }

      const env = new NodeExecutionEnv({ cwd: root })
      const swapTimer = setInterval(swap, 1)
      try {
        const attempts = await Promise.all(Array.from({ length: 4 }, (_, index) => (
          createOpenPipalGrepTool({ timeoutMs: 2_000 }).execute(
            `grep-swap-${index}`,
            { pattern: 'ESCAPE_SENTINEL', path: '.' },
            undefined,
            undefined,
            { env }
          ).then(
            result => (result.content[0] as { text: string }).text,
            error => error instanceof Error ? error.message : String(error)
          )
        )))
        expect(attempts.join('\n')).not.toContain('ESCAPE_SENTINEL')
      } finally {
        clearInterval(swapTimer)
        try {
          if (fs.lstatSync(volatile).isSymbolicLink()) fs.unlinkSync(volatile)
        } catch { /* normalized below */ }
        if (fs.existsSync(parked) && !fs.existsSync(volatile)) fs.renameSync(parked, volatile)
        try {
          if (fs.lstatSync(flappingFile).isSymbolicLink()) fs.unlinkSync(flappingFile)
        } catch { /* normalized below */ }
        if (fs.existsSync(parkedFile) && !fs.existsSync(flappingFile)) {
          fs.renameSync(parkedFile, flappingFile)
        }
        await env.cleanup()
      }
    }
  )
})

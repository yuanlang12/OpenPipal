/**
 * hook-loader 单测——把一个 TS/JS 规则文件编译求值成 LoadedHook。
 *
 * 覆盖：TS 语法 + export const description + import type 被擦掉；纯 JS module.exports；
 * 语法错报行号；值 import 被明确拒绝；未知事件名 / 没注册事件 / 没有默认导出 都给出可读原因；
 * 异步初始化被等待。所有失败都走返回值，不抛出。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { loadHookFile, hookIdFor } from '../../src/main/hooks/hook-loader'

let root: string
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'openpipal-hook-loader-')) })
afterEach(() => { rmSync(root, { recursive: true, force: true }) })

function write(name: string, source: string): string {
  const file = join(root, name)
  writeFileSync(file, source, 'utf-8')
  return file
}

describe('hook-loader', () => {
  it('TS 规则：description 与三类事件都被收集，import type 不影响加载', async () => {
    const file = write('mask-names.ts', `
      import type { HookAPI, ToolResultHookEvent } from 'openpipal/hooks'
      export const description = '  读成绩表前先遮名字  '
      export default function (hook: HookAPI) {
        hook.on('tool_call', (event) => { if (event.toolName === 'bash') return { block: true, reason: 'no' } })
        hook.on('tool_result', (event: ToolResultHookEvent) => ({ content: event.content }))
        hook.on('before_agent_start', (event) => ({ systemPrompt: event.systemPrompt + '\\nX' }))
      }
    `)
    const result = await loadHookFile(file, 'local-rules')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.hook.id).toBe('local-rules/mask-names')
    expect(result.hook.description).toBe('读成绩表前先遮名字')
    expect(result.hook.handlers.tool_call).toHaveLength(1)
    expect(result.hook.handlers.tool_result).toHaveLength(1)
    expect(result.hook.handlers.before_agent_start).toHaveLength(1)
  })

  it('纯 JS：module.exports = function 也认，description 缺省为文件名', async () => {
    const file = write('plain.js', `module.exports = function (hook) { hook.on('tool_call', () => undefined) }`)
    const result = await loadHookFile(file, 'p')
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.hook.description).toBe('plain')
  })

  it('异步初始化会被等到注册完成', async () => {
    const file = write('async.ts', `
      export default async function (hook) {
        await new Promise((r) => setTimeout(r, 10))
        hook.on('tool_call', () => undefined)
      }
    `)
    const result = await loadHookFile(file, 'p')
    expect(result.ok).toBe(true)
  })

  it('语法错误：报编译失败并带行号', async () => {
    const file = write('broken.ts', `export default function (hook) {\n  hook.on('tool_call', (event) => {\n    const x = \n  })\n}`)
    const result = await loadHookFile(file, 'p')
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.failure.error).toMatch(/编译失败/)
      expect(result.failure.error).toMatch(/第 \d+ 行/)
    }
  })

  it('值 import 被拒绝，错误里点名模块', async () => {
    const file = write('needs-fs.ts', `
      import { readFileSync } from 'fs'
      export default function (hook) { hook.on('tool_call', () => { readFileSync('/etc/passwd') }) }
    `)
    const result = await loadHookFile(file, 'p')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.failure.error).toMatch(/不能 import「fs」/)
  })

  it('importResolver 认识的模块可以 import（给下一阶段的能力对象留的口）', async () => {
    const file = write('with-cap.ts', `
      import { tag } from 'openpipal/hooks'
      export default function (hook) { hook.on('tool_call', () => { if (tag !== 'ok') throw new Error('bad') }) }
    `)
    const result = await loadHookFile(file, 'p', {
      importResolver: (spec) => (spec === 'openpipal/hooks' ? { tag: 'ok' } : undefined)
    })
    expect(result.ok).toBe(true)
  })

  it('未知事件名 / 没注册任何事件 / 没有默认导出：各自给可读原因', async () => {
    const unknown = await loadHookFile(write('u.ts', `export default (hook) => { hook.on('turn_end', () => {}) }`), 'p')
    expect(unknown.ok).toBe(false)
    if (!unknown.ok) expect(unknown.failure.error).toMatch(/不认识的事件「turn_end」/)

    const empty = await loadHookFile(write('e.ts', `export default (hook) => {}`), 'p')
    expect(empty.ok).toBe(false)
    if (!empty.ok) expect(empty.failure.error).toMatch(/没有注册任何事件/)

    const noDefault = await loadHookFile(write('n.ts', `export const description = 'x'`), 'p')
    expect(noDefault.ok).toBe(false)
    if (!noDefault.ok) expect(noDefault.failure.error).toMatch(/没有导出默认函数/)
  })

  it('初始化函数抛错：报初始化失败，不向外抛', async () => {
    const file = write('throws.ts', `export default function () { throw new Error('boom') }`)
    const result = await loadHookFile(file, 'p')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.failure.error).toMatch(/初始化失败：boom/)
  })

  it('文件不存在：读取失败', async () => {
    const result = await loadHookFile(join(root, 'missing.ts'), 'p')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.failure.error).toMatch(/读取失败/)
    expect(hookIdFor('p', join(root, 'missing.ts'))).toBe('p/missing')
  })
})

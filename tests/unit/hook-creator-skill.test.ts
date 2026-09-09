/**
 * hook-creator 技能与运行时不漂移。
 *
 * 技能给模型看的类型声明（references/hook-types.d.ts）和运行时契约（hook-types.ts）是两份文件，
 * 一边加了事件另一边没加，模型就会照旧文档写出加载不了的规则。这里钉三件事：
 *   1. 事件名集合一致；2. 面向作者的接口名两边都有；3. 范例代码真的能被 loader 加载。
 */
import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { HOOK_EVENT_NAMES } from '../../src/main/hooks/hook-types'
import { loadHookFile } from '../../src/main/hooks/hook-loader'

const SKILL_DIR = join(__dirname, '../../resources/skills/hook-creator')
const runtimeTypes = readFileSync(join(__dirname, '../../src/main/hooks/hook-types.ts'), 'utf-8')
const authorTypes = readFileSync(join(SKILL_DIR, 'references/hook-types.d.ts'), 'utf-8')
const skill = readFileSync(join(SKILL_DIR, 'SKILL.md'), 'utf-8')
const examples = readFileSync(join(SKILL_DIR, 'references/examples.md'), 'utf-8')
// 后台写手（Evolver set-rule）拿到的是这一份模板与硬规则——和前台范例一起验，别让两份文档各自漂
const writerSkill = readFileSync(join(__dirname, '../../resources/system-agents/evolver/skills/set-rule/SKILL.md'), 'utf-8')

function declaredEventNames(source: string): string[] {
  const match = source.match(/export type HookEventName = ([^\n]+)/)
  if (!match) return []
  return Array.from(match[1].matchAll(/'([a-z_]+)'/g)).map((m) => m[1]).sort()
}

describe('hook-creator 技能', () => {
  it('事件名与运行时一致，SKILL.md 三个都讲到了', () => {
    const runtime = [...HOOK_EVENT_NAMES].sort()
    expect(declaredEventNames(runtimeTypes)).toEqual(runtime)
    expect(declaredEventNames(authorTypes)).toEqual(runtime)
    for (const name of runtime) {
      expect(skill).toContain(`\`${name}\``)
      expect(writerSkill).toContain(`\`${name}\``)
    }
  })

  it('面向作者的接口两边都有', () => {
    const names = ['HookContext', 'HookToolResult', 'ToolCallHookEvent', 'ToolCallHookResult', 'ToolResultHookEvent', 'ToolResultHookResult', 'BeforeAgentStartHookEvent', 'BeforeAgentStartHookResult', 'HookHandler', 'HookAPI']
    for (const name of names) {
      expect(runtimeTypes, name).toMatch(new RegExp(`export (interface|type) ${name}\\b`))
      expect(authorTypes, name).toMatch(new RegExp(`export (interface|type) ${name}\\b`))
    }
    expect(authorTypes).toMatch(/declare module 'openpipal\/hooks'/)
  })

  it('前台技能、范例、后台写手技能里的每段 ts 代码都能被 loader 加载', async () => {
    const root = mkdtempSync(join(tmpdir(), 'openpipal-hook-examples-'))
    try {
      const blocks = Array.from((skill + '\n' + examples + '\n' + writerSkill).matchAll(/```ts\n([\s\S]*?)```/g)).map((m) => m[1])
      expect(blocks.length).toBeGreaterThanOrEqual(6)
      for (const [index, code] of blocks.entries()) {
        const file = join(root, `example-${index}.ts`)
        writeFileSync(file, code, 'utf-8')
        const result = await loadHookFile(file, 'local-rules')
        expect(result.ok, `范例 ${index} 加载失败：${result.ok ? '' : result.failure.error}`).toBe(true)
        if (result.ok) expect(result.hook.description).not.toBe(`example-${index}`)
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('范例行为：遮名字 / 拦危险命令 / 改 python 路径', async () => {
    const root = mkdtempSync(join(tmpdir(), 'openpipal-hook-examples-'))
    try {
      const blocks = Array.from(examples.matchAll(/```ts\n([\s\S]*?)```/g)).map((m) => m[1])
      const ctx = { workingDir: '/tmp', source: 'desktop' as const, signal: new AbortController().signal }
      const load = async (i: number) => {
        const file = join(root, `ex-${i}.ts`)
        writeFileSync(file, blocks[i], 'utf-8')
        const r = await loadHookFile(file, 'local-rules')
        if (!r.ok) throw new Error(r.failure.error)
        return r.hook
      }
      const mask = await load(0)
      const masked = await mask.handlers.tool_result[0]({ type: 'tool_result', toolName: 'read', toolCallId: 'c', input: { path: '/x/期中成绩.csv' }, content: [{ type: 'text', text: '张三 90\n李四 85' }], details: undefined, isError: false }, ctx)
      expect(masked).toEqual({ content: [{ type: 'text', text: '学生1 90\n学生2 85' }] })

      const guard = await load(1)
      expect(await guard.handlers.tool_call[0]({ type: 'tool_call', toolName: 'bash', toolCallId: 'c', input: { command: 'rm -rf /tmp/x' } }, ctx)).toMatchObject({ block: true })
      expect(await guard.handlers.tool_call[0]({ type: 'tool_call', toolName: 'bash', toolCallId: 'c', input: { command: 'ls -la' } }, ctx)).toBeUndefined()

      const venv = await load(2)
      const event = { type: 'tool_call' as const, toolName: 'bash', toolCallId: 'c', input: { command: 'python main.py && pip install x' } }
      await venv.handlers.tool_call[0](event, ctx)
      expect(event.input.command).toBe('.venv/bin/python main.py && .venv/bin/pip install x')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

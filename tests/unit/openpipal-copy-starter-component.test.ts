/**
 * copy_starter_component（对标原版 design agent）：预制件住在项目目录里，模型显式拷进来。
 * 2026-09-11 实撞：技能只写 `./support.js` 相对路径、磁盘上却从来没有这文件（宿主渲染时内联），
 * 模型按前端本能去找，两次触发主目录遍历确认。
 *   三处登记（红线）：产品工具定义 / COMMON_TOOLS / classifyToolRisk=safe。
 *   文件式：dc-runtime 目录里有什么就能拷什么，`*.compiled.js` 对外叫 `*.js`（与导出链路同一套改名）。
 */
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'openpipal-starter-'))
process.env.HOME = HOME
process.env.OPENPIPAL_ISOLATED_HOME = HOME

const { createCopyStarterComponentTool, listStarterComponents } = await import('../../src/main/openpipal-product-tools')
const { COMMON_TOOLS } = await import('../../src/main/role-manager')
const { classifyToolRisk } = await import('../../src/main/pi-security')

const runtime = fs.mkdtempSync(path.join(os.tmpdir(), 'openpipal-dc-runtime-'))
fs.mkdirSync(path.join(runtime, 'vendor'))
fs.writeFileSync(path.join(runtime, 'support.js'), '// support')
fs.writeFileSync(path.join(runtime, 'deck-stage.js'), '// deck')
fs.writeFileSync(path.join(runtime, 'animations.compiled.js'), '// animations compiled')
fs.writeFileSync(path.join(runtime, 'animations.jsx'), '// jsx source, not offered')
fs.writeFileSync(path.join(runtime, 'vendor', 'react.production.min.js'), '// react')
fs.writeFileSync(path.join(runtime, 'vendor', 'react-dom.production.min.js'), '// react-dom')

const run = async (workingDir: string, params: { kind: string; directory?: string }) => {
  const tool = createCopyStarterComponentTool({ workingDir, runtimeDir: runtime })
  const result: any = await tool.execute('call-1', params as any, undefined as any, undefined as any, undefined as any)
  return { text: String(result.content[0].text), details: result.details as { ok: boolean; written?: string[]; unchanged?: string[] } }
}

describe('copy_starter_component', () => {
  it('三处登记：产品工具定义 / COMMON_TOOLS / classifyToolRisk=safe', () => {
    const src = fs.readFileSync('src/main/openpipal-product-tools.ts', 'utf8')
    expect(src).toMatch(/createCopyStarterComponentTool\(\{ workingDir: overrides\?\.workingDir \}\)/)
    expect(COMMON_TOOLS).toContain('copy_starter_component')
    expect(classifyToolRisk('copy_starter_component', { kind: 'support.js' }).level).toBe('safe')
  })

  it('可选项来自目录：compiled 对外去掉 .compiled，jsx 源码不提供', () => {
    expect(listStarterComponents(runtime)).toEqual(['animations.js', 'deck-stage.js', 'support.js'])
    expect(listStarterComponents(path.join(runtime, 'nope'))).toEqual([])
  })

  it('support.js 连 vendor 一起落到工作目录；再拷一次报"内容一致"不重写', async () => {
    const wd = fs.mkdtempSync(path.join(os.tmpdir(), 'openpipal-wd-'))
    const first = await run(wd, { kind: 'support.js' })
    expect(first.details.ok).toBe(true)
    expect(fs.readFileSync(path.join(wd, 'support.js'), 'utf8')).toBe('// support')
    expect(fs.existsSync(path.join(wd, 'vendor', 'react.production.min.js'))).toBe(true)
    expect(fs.existsSync(path.join(wd, 'vendor', 'react-dom.production.min.js'))).toBe(true)
    expect(first.text).toContain('./support.js')
    expect(first.text).toContain('./vendor/react.production.min.js')
    const again = await run(wd, { kind: 'support.js' })
    expect(again.details.written).toEqual([])
    expect(again.details.unchanged).toHaveLength(3)
  })

  it('animations.js 拷的是 compiled 文件；子目录可选；越出工作目录拒绝；未知 kind 列出可选项', async () => {
    const wd = fs.mkdtempSync(path.join(os.tmpdir(), 'openpipal-wd-'))
    const ok = await run(wd, { kind: 'animations.js', directory: 'deck/' })
    expect(ok.details.ok).toBe(true)
    expect(fs.readFileSync(path.join(wd, 'deck', 'animations.js'), 'utf8')).toBe('// animations compiled')
    // 2026-09-11 装机版实测：只拷文件不加 <script src> 预载，本地打开一片空白——结果文本必须把这行给出来
    expect(ok.text).toContain('<script src="./animations.js"></script>')
    expect(ok.text).toContain('from="./animations.js"')
    const escape = await run(wd, { kind: 'deck-stage.js', directory: '../outside' })
    expect(escape.details.ok).toBe(false)
    expect(fs.existsSync(path.join(wd, '..', 'outside', 'deck-stage.js'))).toBe(false)
    const unknown = await run(wd, { kind: 'support.jsx' })
    expect(unknown.details.ok).toBe(false)
    expect(unknown.text).toContain('animations.js, deck-stage.js, support.js')
  })

  it('技能文档与全盘搜索的拦截文案都把模型引到这个工具，而不是让它去找文件', () => {
    expect(fs.readFileSync('resources/skills/dc-authoring/SKILL.md', 'utf8')).toMatch(/copy_starter_component\(kind: "support\.js"\)/)
    const deck = fs.readFileSync('resources/skills/deck-stage/SKILL.md', 'utf8')
    expect(deck).toMatch(/copy_starter_component\(kind: "deck-stage\.js"\)/)
    expect(deck).toContain('<script src="./deck-stage.js"></script>')
    const security = fs.readFileSync('src/main/pi-security.ts', 'utf8')
    expect(security.match(/调 copy_starter_component 拷进来即可/g)).toHaveLength(2)
  })
})

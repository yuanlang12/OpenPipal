/**
 * agents/<uuid>/mark.json 与 teams/<uuid>/mark.json 的读写闸（从 agent-mark-store 拆出来给 team-store 直接用）：
 *   - 写进去再读回来是同一份，格式是两空格缩进 + 末尾换行（与手捏的一致）
 *   - 目录不在 / id 不是 uuid / 目录是软链接指出去的 / 值不是短 slug：一律拒，不抛
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'

const HOME = mkdtempSync(join(tmpdir(), 'openpipal-mark-file-'))
process.env.OPENPIPAL_ISOLATED_HOME = HOME
const DATA = join(HOME, '.openpipal')
vi.mock('electron', () => ({ app: { isPackaged: false, getAppPath: () => process.cwd(), getPath: () => HOME } }))

const { readMarkFile, writeMarkFile } = await import('../../src/main/agent-mark-file')
const { composeMark } = await import('../../src/shared/agent-mark-catalog')
afterAll(() => rmSync(HOME, { recursive: true, force: true }))

const PAL = 'a1a1a1a1-0000-4000-8000-000000000001'
const TEAM = 'b2b2b2b2-0000-4000-8000-000000000002'
mkdirSync(join(DATA, 'agents', PAL), { recursive: true })
mkdirSync(join(DATA, 'teams', TEAM), { recursive: true })

describe('mark.json 读写闸', () => {
  it('agent / team 各自根下：写进去再读回来一样，格式与手捏的一致', () => {
    const mark = composeMark(PAL, 'wrench')
    expect(writeMarkFile('agent', PAL, mark)).toBe(true)
    expect(readMarkFile('agent', PAL)).toEqual(mark)
    expect(readFileSync(join(DATA, 'agents', PAL, 'mark.json'), 'utf8')).toBe(`${JSON.stringify(mark, null, 2)}\n`)

    expect(writeMarkFile('team', TEAM, { accessory: 'badge', hue: 'teal', shape: 'hexagon' })).toBe(true)
    expect(readMarkFile('team', TEAM)).toEqual({ accessory: 'badge', hue: 'teal', shape: 'hexagon' })
    expect(readMarkFile('agent', TEAM)).toBeNull() // 团队 id 不在 agents/ 下
  })

  it('目录不在 / 不是 uuid / 软链接指出去 / 值不是短 slug：拒而不抛', () => {
    expect(writeMarkFile('agent', 'c3c3c3c3-0000-4000-8000-000000000003', composeMark('x'))).toBe(false)
    expect(readMarkFile('agent', 'c3c3c3c3-0000-4000-8000-000000000003')).toBeNull()
    expect(writeMarkFile('agent', '../teams', composeMark('x'))).toBe(false)
    expect(readMarkFile('agent', '../teams')).toBeNull()

    const outside = join(HOME, 'outside')
    mkdirSync(outside, { recursive: true })
    const LINK = 'd4d4d4d4-0000-4000-8000-000000000004'
    symlinkSync(outside, join(DATA, 'agents', LINK))
    expect(writeMarkFile('agent', LINK, composeMark('x'))).toBe(false)
    expect(readMarkFile('agent', LINK)).toBeNull()

    expect(writeMarkFile('agent', PAL, { accessory: 'Wrench!', hue: 'teal', shape: 'circle' })).toBe(false)
    expect(writeMarkFile('agent', PAL, ['wrench'])).toBe(false)
    expect(readMarkFile('agent', PAL)).toEqual(composeMark(PAL, 'wrench')) // 坏值没盖掉好的
  })
})

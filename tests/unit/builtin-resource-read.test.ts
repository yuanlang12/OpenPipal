/**
 * 内置资源根只读放行：技能索引发给模型的是打包版 Resources 下的绝对路径，read 必须能读
 * （实案：被 ALLOWED_DIRS 误拦 → 模型降级 bash cat 读 SKILL.md）；写类工具对同路径仍拒绝。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'

const FAKE_RESOURCES = fs.mkdtempSync(path.join(os.tmpdir(), 'openpipal-fake-resources-'))
const SKILL = path.join(FAKE_RESOURCES, 'skills', 'wireframe', 'SKILL.md')

let saved: string | undefined
beforeAll(() => {
  fs.mkdirSync(path.dirname(SKILL), { recursive: true })
  fs.writeFileSync(SKILL, '# skill')
  saved = process.resourcesPath
  Object.defineProperty(process, 'resourcesPath', { value: FAKE_RESOURCES, configurable: true })
})
afterAll(() => {
  Object.defineProperty(process, 'resourcesPath', { value: saved, configurable: true })
})

const mod = await import('../../src/main/pi-security')

describe('内置资源根只读放行', () => {
  it('read 内置技能路径 → safe（不再"不在允许的工作目录内"）', () => {
    const r = mod.classifyToolRisk('read', { path: SKILL })
    expect(r.level).toBe('safe')
  })

  it('write/edit 同路径 → 仍拒绝（内置资源必须只读）', () => {
    const w = mod.classifyToolRisk('write', { path: SKILL, content: 'x' })
    expect(w.level).toBe('risky')
    expect(w.reason).toContain('不在允许的工作目录内')
  })

  it('资源根之外的任意路径 read → 照旧拦截', () => {
    const r = mod.classifyToolRisk('read', { path: '/etc/passwd' })
    expect(r.level).toBe('risky')
  })
})

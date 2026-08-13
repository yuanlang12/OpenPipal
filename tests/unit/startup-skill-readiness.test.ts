import fs from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { initializeOptionalStartupCapability } from '../../src/main/startup-capability-readiness'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('first-chat skill readiness contract', () => {
  it('finishes skill and subagent initialization before exposing the chat window', () => {
    const source = fs.readFileSync(path.resolve('src/main/index.ts'), 'utf8')
    const readiness = source.indexOf('await Promise.all([')
    const skills = source.indexOf("initializeOptionalStartupCapability('技能', preloadSkillEngine, initSkills)", readiness)
    const subagents = source.indexOf("initializeOptionalStartupCapability('子 Agent ', preloadSubagentEngine, initSubagents)", readiness)
    const window = source.indexOf('createWindow()', readiness)
    expect(readiness).toBeGreaterThan(-1)
    expect(skills).toBeGreaterThan(readiness)
    expect(subagents).toBeGreaterThan(skills)
    expect(window).toBeGreaterThan(subagents)
  })

  it('contains a rejected preload without running its init or blocking the other capability', async () => {
    const preloadFailure = new Error('dynamic import failed')
    const failedPreload = vi.fn(async () => { throw preloadFailure })
    const failedInit = vi.fn()
    const healthyPreload = vi.fn(async () => undefined)
    const healthyInit = vi.fn()
    const diagnostic = vi.spyOn(console, 'error').mockImplementation(() => {})

    await Promise.all([
      initializeOptionalStartupCapability('技能', failedPreload, failedInit),
      initializeOptionalStartupCapability('子 Agent ', healthyPreload, healthyInit)
    ])

    expect(failedPreload).toHaveBeenCalledOnce()
    expect(failedInit).not.toHaveBeenCalled()
    expect(healthyPreload).toHaveBeenCalledOnce()
    expect(healthyInit).toHaveBeenCalledOnce()
    expect(diagnostic).toHaveBeenCalledOnce()
    expect(diagnostic).toHaveBeenCalledWith(
      '[Startup] 技能初始化失败，将以降级能力继续启动:',
      preloadFailure
    )
  })
})

/**
 * 契约锁：记忆总开关默认关闭，且"关"必须是真关。
 *
 * 历史坑：autoMemoryEnabled 只门控写入（抽取/整理），召回注入走的是另一个角色级标志。
 * 只翻配置默认会变成"半关"——不再产生新记忆，却仍把已有索引每轮塞进提示词。
 * 这里同时钉住三件事：默认值、召回注入、以及提示词里的记忆指引不留悬空。
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'

const state = vi.hoisted(() => ({ config: {} as Record<string, unknown>, memoryOn: false }))

vi.mock('../../src/main/config-manager', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/main/config-manager')>()
  return { ...actual, loadConfig: () => state.config, isAutoMemoryEnabled: () => state.memoryOn }
})

describe('记忆总开关默认值', () => {
  beforeEach(() => { state.config = {} })

  it('配置里没有该字段时默认关闭（opt-in）', async () => {
    const actual = await vi.importActual<typeof import('../../src/main/config-manager')>(
      '../../src/main/config-manager'
    )
    const source = (await import('node:fs')).readFileSync('src/main/config-manager.ts', 'utf8')
    // 语义锁：必须是 === true（opt-in），不能回退成 !== false（opt-out）
    expect(source).toContain('config.autoMemoryEnabled === true')
    expect(source).not.toContain('config.autoMemoryEnabled !== false')
    expect(typeof actual.isAutoMemoryEnabled).toBe('function')
  })
})

describe('关闭时提示词不留记忆痕迹', () => {
  it('召回注入与记忆指引一并撤掉，开启时又都回来', async () => {
    const source = (await import('node:fs')).readFileSync(
      'src/main/agent-runtime/openpipal-prompt-core.ts', 'utf8'
    )
    // 召回受总闸约束，而不是只看角色级标志
    expect(source).toContain('const memoryOn = isAutoMemoryEnabled() && role.memoryEnabled !== false')
    expect(source).toContain('const memories = !memoryOn')
    // 工作区提示词按同一个闸控制记忆格式与读写指引
    expect(source).toContain('buildWorkspaceLayoutPrompt(overrides?.workspaceId, role.name, memoryOn, effectiveWorkingDir)')
    expect(source).toContain("const memoryFormat = !memoryEnabled ? '' : `")
    expect(source).toContain('const memoryRules = memoryEnabled')
    expect(source).toContain('const globalMemoryRules = memoryEnabled')
  })
})

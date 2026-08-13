/**
 * 行为锁：跟随开关关掉后，前台应用信息一律不得透出。
 *
 * 这条以前是用「切源码字符串 + 比较两个 indexOf 的先后」断言的，那种写法在
 * 函数被移动、重排、或换个等价写法时会误报，而对「读了开关却忽略它」的实现
 * 又是绿的。这里直接驱动真函数：mock 掉 app-follow-settings，翻开关，看输出。
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'

const state = vi.hoisted(() => ({ following: true }))

vi.mock('electron', () => ({ app: { getPath: () => '/tmp', isPackaged: false } }))
vi.mock('../../src/main/app-follow-settings', () => ({
  isAppFollowingEnabled: () => state.following,
  isAppDisabled: () => false,
  shouldFollowDetectedApp: () => state.following,
  getDisabledApps: () => [],
  addDetectedApp: () => {},
}))
vi.mock('../../src/main/app-detector', () => ({ getFrontmostApp: async () => null, detectInstalledApps: async () => [] }))
vi.mock('../../src/main/main-i18n', () => ({ tMain: (k: string) => k }))
vi.mock('../../src/main/locale-manager', () => ({ onLocaleChanged: () => () => {}, getLocaleState: () => ({ locale: 'zh-CN' }) }))
vi.mock('../../src/main/config-manager', () => ({ loadConfig: () => ({}), saveConfig: () => {} }))

describe('挂靠同意门', () => {
  beforeEach(() => { state.following = true })

  it('未挂靠时快照被彻底擦干净，不残留任何应用信息', async () => {
    const wt = await import('../../src/main/window-tracker')
    state.following = false
    expect(wt.isDockedToTargetApp()).toBe(false)
    // 关键是 foregroundApp 为空串而不是 currentConfig.displayName
    expect(wt.getEnvironmentSnapshot()).toEqual({
      mode: 'undocked', foregroundApp: '', isFullscreen: false, connected: false,
    })
  })

  it('绑定过目标进程之后，跟随关闭仍然不透出它的名字', async () => {
    const wt = await import('../../src/main/window-tracker')
    // 先让 currentConfig 真的带上名字 —— 否则「返回空串」可能只是因为压根没绑过,
    // 测试会因为错误的理由变绿。
    wt.setTargetProcess('ClassIn')
    state.following = false
    expect(wt.getEnvironmentSnapshot().foregroundApp).toBe('')
    expect(wt.isDockedToTargetApp()).toBe(false)
  })
})

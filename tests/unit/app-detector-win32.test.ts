/**
 * app-detector 的 Windows 路径：探针快照 → 分类 → DIP 换算 → 与 macOS 同一道跟随闸门。
 * 探针本身与 Electron 的 screen 都是 mock；平台用 process.platform 桩成 win32。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  snapshot: null as any,
  addDetectedApp: vi.fn(),
  isAppFollowingEnabled: vi.fn(),
  shouldFollowDetectedApp: vi.fn()
}))

vi.mock('electron', () => ({
  screen: {
    // 200% 缩放：物理像素减半就是 DIP
    screenToDipRect: (_w: unknown, r: { x: number; y: number; width: number; height: number }) => ({
      x: r.x / 2, y: r.y / 2, width: r.width / 2, height: r.height / 2
    }),
    getDisplayMatching: () => ({ bounds: { x: 0, y: 0, width: 1920, height: 1080 } })
  }
}))

vi.mock('../../src/main/win32-foreground', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/main/win32-foreground')>()),
  getForegroundWindowWin32: async () => state.snapshot
}))

vi.mock('../../src/main/app-follow-settings', () => ({
  addDetectedApp: state.addDetectedApp,
  isAppFollowingEnabled: state.isAppFollowingEnabled,
  shouldFollowDetectedApp: state.shouldFollowDetectedApp
}))

import { getFrontmostApp } from '../../src/main/app-detector'

const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!

function word(overrides: Record<string, unknown> = {}) {
  return {
    hwnd: '132530', pid: 4242, processName: 'WINWORD',
    exePath: 'C:\\Office\\WINWORD.EXE', description: 'Microsoft Word', title: '报告.docx - Word',
    className: 'OpusApp', uwpHost: false,
    left: 100, top: 80, right: 1700, bottom: 1000, minimized: false, maximized: false,
    ...overrides
  }
}

beforeEach(() => {
  Object.defineProperty(process, 'platform', { ...originalPlatform, value: 'win32' })
  state.snapshot = word()
  state.addDetectedApp.mockClear()
  state.isAppFollowingEnabled.mockReset().mockReturnValue(true)
  state.shouldFollowDetectedApp.mockReset().mockReturnValue(true)
})

afterEach(() => {
  Object.defineProperty(process, 'platform', originalPlatform)
})

describe('Windows 前台应用检测', () => {
  it('普通应用：exe 名当键、版本信息当显示名、矩形换成 DIP、带上句柄', async () => {
    await expect(getFrontmostApp()).resolves.toEqual({
      processName: 'WINWORD',
      appName: 'Microsoft Word',
      bounds: { x: 50, y: 40, width: 800, height: 460, isFullscreen: false },
      windowHandle: '132530',
      pid: 4242,
      windowTitle: '报告.docx - Word'
    })
    // 键与显示名不同时把名字一并记下，设置页照名字显示
    expect(state.addDetectedApp).toHaveBeenCalledWith('WINWORD', 'Microsoft Word')
  })

  it('WPS 的三个 exe 都套 wpsoffice 那份内置配置', async () => {
    state.snapshot = word({ processName: 'et', description: 'WPS 表格' })
    const info = await getFrontmostApp()
    expect(info?.processName).toBe('wpsoffice')
    expect(info?.appName).toBe('WPS 表格')
  })

  it('浏览器：上报为 isBrowser、不带 bounds，总开关关着时不上报', async () => {
    state.snapshot = word({ processName: 'msedge', description: 'Microsoft Edge' })
    await expect(getFrontmostApp()).resolves.toMatchObject({ processName: 'msedge', appName: 'Microsoft Edge', isBrowser: true, bounds: null })
    state.isAppFollowingEnabled.mockReturnValue(false)
    await expect(getFrontmostApp()).resolves.toBeNull()
    expect(state.addDetectedApp).toHaveBeenCalledWith('msedge', 'Microsoft Edge')
  })

  it('OpenPipal 自己、桌面 / 任务栏、系统壳一律 null，也不记进检测列表', async () => {
    for (const snap of [
      word({ pid: process.pid }),
      word({ processName: 'explorer', className: 'Progman' }),
      word({ processName: 'SearchHost' })
    ]) {
      state.snapshot = snap
      await expect(getFrontmostApp()).resolves.toBeNull()
    }
    expect(state.addDetectedApp).not.toHaveBeenCalled()
  })

  it('用户禁用了这个应用 → 记录但不跟随', async () => {
    state.shouldFollowDetectedApp.mockReturnValue(false)
    await expect(getFrontmostApp()).resolves.toBeNull()
    expect(state.addDetectedApp).toHaveBeenCalledWith('WINWORD', 'Microsoft Word')
  })

  it('最小化的前台窗口：应用还在，bounds 为 null（tracker 据此断开贴靠）', async () => {
    state.snapshot = word({ minimized: true })
    await expect(getFrontmostApp()).resolves.toMatchObject({ processName: 'WINWORD', bounds: null })
  })

  it('探针没拿到前台窗口 → null', async () => {
    state.snapshot = null
    await expect(getFrontmostApp()).resolves.toBeNull()
  })
})

/**
 * 渲染层的平台判定（Windows 第 4 段）：桌面端从 preload 挂的 window.electron.process.platform 读，
 * 浏览器插件里一律 'web'；只有 win32 自绘窗口按钮。
 */
import { describe, expect, it } from 'vitest'
import { detectRendererPlatform, platformClassName, showsCustomWindowControls } from '../../src/renderer/src/lib/platform'
import { parseAppSettingsState } from '../../src/shared/app-following-contract'

describe('detectRendererPlatform', () => {
  it('桌面端按 preload 报的平台', () => {
    expect(detectRendererPlatform({ electron: { process: { platform: 'win32' } } })).toBe('win32')
    expect(detectRendererPlatform({ electron: { process: { platform: 'darwin' } } })).toBe('darwin')
    expect(detectRendererPlatform({ electron: { process: { platform: 'linux' } } })).toBe('linux')
  })

  it('浏览器插件（__OPENPIPAL_ENV__ = browser）或没有 preload → web', () => {
    expect(detectRendererPlatform({ __OPENPIPAL_ENV__: 'browser', electron: { process: { platform: 'win32' } } })).toBe('web')
    expect(detectRendererPlatform({})).toBe('web')
    expect(detectRendererPlatform({ electron: { process: { platform: 'freebsd' } } })).toBe('web')
  })

  it('类名与按钮可见性', () => {
    expect(platformClassName('win32')).toBe('platform-win32')
    expect(showsCustomWindowControls('win32')).toBe(true)
    expect(showsCustomWindowControls('darwin')).toBe(false)
    expect(showsCustomWindowControls('web')).toBe(false)
    expect(showsCustomWindowControls('linux')).toBe(false)
  })
})

describe('AppSettingsState.labels', () => {
  const base = { enabled: true, detected: ['WINWORD'], disabled: [], browsers: [] }

  it('缺失按空表；给了就原样带回来', () => {
    expect(parseAppSettingsState(base).labels).toEqual({})
    expect(parseAppSettingsState({ ...base, labels: { WINWORD: 'Microsoft Word' } }).labels)
      .toEqual({ WINWORD: 'Microsoft Word' })
  })

  it('形状不对（值不是字符串 / 不是对象）算坏响应', () => {
    expect(() => parseAppSettingsState({ ...base, labels: { WINWORD: 1 } })).toThrow()
    expect(() => parseAppSettingsState({ ...base, labels: ['x'] })).toThrow()
  })
})

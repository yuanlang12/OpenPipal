import { describe, it, expect } from 'vitest'
import {
  OPAQUE_WINDOW_BACKGROUND,
  WINDOW_BACKGROUND_DARK,
  WINDOW_BACKGROUND_LIGHT,
  platformWindowOptions,
  trayIconFile,
  windowBackgroundColor
} from '../../src/main/platform-window'

describe('platformWindowOptions', () => {
  it('macOS：透明 + under-window vibrancy，底色全透明，与系统深浅无关', () => {
    for (const prefersDark of [false, true]) {
      const o = platformWindowOptions('darwin', prefersDark)
      expect(o.transparent).toBe(true)
      expect(o.vibrancy).toBe('under-window')
      expect(o.visualEffectState).toBe('active')
      expect(o.backgroundColor).toBe('#00000000')
    }
  })

  it('Windows / Linux：不透明主题底色，不传任何 vibrancy 字段', () => {
    for (const platform of ['win32', 'linux'] as const) {
      const light = platformWindowOptions(platform, false)
      expect(light.transparent).toBe(false)
      expect(light.backgroundColor).toBe(WINDOW_BACKGROUND_LIGHT)
      expect('vibrancy' in light).toBe(false)
      expect('visualEffectState' in light).toBe(false)
      expect(platformWindowOptions(platform, true).backgroundColor).toBe(WINDOW_BACKGROUND_DARK)
    }
  })

  it('底色是渲染层 DEFAULT_THEME 的 surface 种子（浅 #FFFFFF / 深 #161D22），六位十六进制', () => {
    expect(windowBackgroundColor('light')).toBe('#FFFFFF')
    expect(windowBackgroundColor('dark')).toBe('#161D22')
    for (const color of [WINDOW_BACKGROUND_LIGHT, WINDOW_BACKGROUND_DARK]) {
      expect(color).toMatch(/^#[0-9a-fA-F]{6}$/)
    }
    // 历史名字仍然等于浅色底，老调用方不受影响
    expect(OPAQUE_WINDOW_BACKGROUND).toBe(WINDOW_BACKGROUND_LIGHT)
  })

  it('不传系统深浅时按浅色（历史行为）', () => {
    expect(platformWindowOptions('win32').backgroundColor).toBe(WINDOW_BACKGROUND_LIGHT)
  })

  it('托盘图标：macOS 用 Template 图，其他平台用彩色 .ico', () => {
    expect(trayIconFile('darwin')).toBe('openpipalTemplate.png')
    expect(trayIconFile('win32')).toBe('openpipal.ico')
    expect(trayIconFile('linux')).toBe('openpipal.ico')
  })
})

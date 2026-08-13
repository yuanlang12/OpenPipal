import { describe, expect, it } from 'vitest'
import {
  changeMainLocale,
  initializeMainI18n,
  tMain
} from '../../src/main/main-i18n'
import { APP_I18N_RESOURCES } from '../../src/shared/i18n/resources'

describe('main i18n', () => {
  it('renders native shell copy from the selected bundled locale', async () => {
    await initializeMainI18n('zh-CN')
    expect(tMain('shell.tray.showMainWindow')).toBe('显示主窗口')

    await changeMainLocale('en')
    expect(tMain('shell.tray.showMainWindow')).toBe('Show main window')
  })

  it('renders the shared model-stall error in the selected Main-process locale', async () => {
    await initializeMainI18n('zh-CN')
    expect(tMain('runtimeChrome.errors.modelStall', { seconds: 60 })).toContain('60 秒没有任何响应')

    await changeMainLocale('en')
    expect(tMain('runtimeChrome.errors.modelStall', { seconds: 60 })).toContain('did not respond within 60 seconds')
  })

  it('falls back to the authoritative Chinese catalogue for missing English keys', async () => {
    const englishTray = APP_I18N_RESOURCES.en.shell.tray as Record<string, string>
    const original = englishTray.showMainWindow
    delete englishTray.showMainWindow

    try {
      await initializeMainI18n('en')
      expect(tMain('shell.tray.showMainWindow')).toBe('显示主窗口')
    } finally {
      englishTray.showMainWindow = original
    }
  })
})

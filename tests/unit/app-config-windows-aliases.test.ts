/**
 * Windows 的 exe 名 → 内置 target 键，以及 fallback 配置的显示名可以与进程名不同
 * （macOS 进程名就是应用名；Windows 上 WINWORD 要显示成 Microsoft Word）。
 */
import { describe, expect, it } from 'vitest'
import { getTargetConfig, resolveWindowsTargetKey } from '../../src/main/app-config'

describe('resolveWindowsTargetKey', () => {
  it('WPS 三件套与 ClassIn 映射到内置键，大小写不敏感', () => {
    expect(resolveWindowsTargetKey('wps')).toBe('wpsoffice')
    expect(resolveWindowsTargetKey('ET')).toBe('wpsoffice')
    expect(resolveWindowsTargetKey('wpp')).toBe('wpsoffice')
    expect(resolveWindowsTargetKey('classin')).toBe('ClassIn')
  })

  it('没有别名的 exe 原样返回，保留大小写', () => {
    expect(resolveWindowsTargetKey('WINWORD')).toBe('WINWORD')
    expect(resolveWindowsTargetKey('Code')).toBe('Code')
  })
})

describe('getTargetConfig 的显示名', () => {
  it('内置配置不受传入显示名影响', () => {
    expect(getTargetConfig('wpsoffice', 'WPS 表格').displayName).toBe('WPS')
    expect(getTargetConfig('ClassIn', 'whatever').displayName).toBe('ClassIn')
  })

  it('fallback：显示名与提示词用传入的名字，processName 仍是稳定键', () => {
    const config = getTargetConfig('WINWORD', 'Microsoft Word')
    expect(config.processName).toBe('WINWORD')
    expect(config.displayName).toBe('Microsoft Word')
    expect(config.systemPrompt).toContain('Microsoft Word')
    expect(config.systemPrompt).not.toContain('WINWORD')
  })

  it('不传或传空显示名时与历史行为相同：显示名就是进程名', () => {
    expect(getTargetConfig('Notion').displayName).toBe('Notion')
    expect(getTargetConfig('Notion', '  ').displayName).toBe('Notion')
  })
})

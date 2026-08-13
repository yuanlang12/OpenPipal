import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  config: {} as Record<string, unknown>,
  saveConfig: vi.fn()
}))

vi.mock('../../src/main/config-manager', () => ({
  loadConfig: () => state.config,
  saveConfig: state.saveConfig
}))

import {
  addDetectedApp,
  getDetectedApps,
  getDisabledApps,
  isAppFollowingEnabled,
  resetAppFollowSettingsCacheForTests,
  setAppFollowingEnabled,
  setDisabledApps,
  shouldFollowDetectedApp
} from '../../src/main/app-follow-settings'

beforeEach(() => {
  state.config = {}
  state.saveConfig.mockClear()
  resetAppFollowSettingsCacheForTests()
})

describe('app following settings', () => {
  it('defaults legacy configs to enabled', () => {
    expect(isAppFollowingEnabled()).toBe(true)
  })

  it('persists the global switch without changing the per-app list', () => {
    state.config = { disabledApps: ['Xcode'] }

    setAppFollowingEnabled(false)

    expect(state.saveConfig).toHaveBeenCalledWith({
      appFollowingEnabled: false,
      disabledApps: ['Xcode']
    })
    expect(getDisabledApps()).toEqual(['Xcode'])
  })

  it('gives the global pause priority and restores the saved per-app choice', () => {
    state.config = { appFollowingEnabled: false, disabledApps: ['Xcode'] }
    expect(shouldFollowDetectedApp('Notion')).toBe(false)
    expect(shouldFollowDetectedApp('Xcode')).toBe(false)

    setAppFollowingEnabled(true)

    expect(shouldFollowDetectedApp('Notion')).toBe(true)
    expect(shouldFollowDetectedApp('Xcode')).toBe(false)
    expect(getDisabledApps()).toEqual(['Xcode'])
  })

  it('persists per-app changes without changing the global switch', () => {
    state.config = { appFollowingEnabled: false }

    setDisabledApps(['Notion'])

    expect(state.saveConfig).toHaveBeenCalledWith({
      appFollowingEnabled: false,
      disabledApps: ['Notion']
    })
  })

  it('keeps every cache at its durable value when writing fails', () => {
    state.config = {
      appFollowingEnabled: false,
      disabledApps: ['Xcode'],
      detectedApps: ['Notion']
    }
    expect(isAppFollowingEnabled()).toBe(false)
    expect(getDisabledApps()).toEqual(['Xcode'])
    expect(getDetectedApps()).toEqual(['Notion'])

    state.saveConfig.mockImplementation(() => { throw new Error('disk full') })

    expect(() => setAppFollowingEnabled(true)).toThrow('disk full')
    expect(() => setDisabledApps(['Notion'])).toThrow('disk full')
    expect(() => addDetectedApp('Preview')).toThrow('disk full')
    expect(isAppFollowingEnabled()).toBe(false)
    expect(getDisabledApps()).toEqual(['Xcode'])
    expect(getDetectedApps()).toEqual(['Notion'])
  })
})

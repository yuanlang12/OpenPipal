import { beforeEach, describe, expect, it, vi } from 'vitest'

const config = vi.hoisted(() => ({ preference: undefined as unknown }))
const preferredLanguages = vi.hoisted(() => vi.fn<() => string[]>(() => ['zh-Hans-CN']))

vi.mock('electron', () => ({
  app: { getPreferredSystemLanguages: preferredLanguages }
}))

vi.mock('../../src/main/config-manager', () => ({
  getLocalePreference: () => {
    const value = config.preference
    return value === 'zh-CN' || value === 'en' ? value : 'system'
  },
  setLocalePreference: (value: unknown) => {
    config.preference = value
    return value
  }
}))

const { getLocaleState, onLocaleChanged, refreshSystemLocale, updateLocalePreference } = await import('../../src/main/locale-manager')

describe('locale manager', () => {
  beforeEach(() => {
    config.preference = undefined
    preferredLanguages.mockReset()
    preferredLanguages.mockReturnValue(['zh-Hans-CN'])
  })

  it('defaults to system preference and derives the effective locale from Electron', () => {
    expect(getLocaleState()).toEqual({ preference: 'system', locale: 'zh-CN' })
    expect(preferredLanguages).toHaveBeenCalledOnce()
  })

  it('persists an explicit locale and returns the new effective state', () => {
    expect(updateLocalePreference('en')).toEqual({ preference: 'en', locale: 'en' })
    expect(config.preference).toBe('en')
    // The manager resolves the previous `system` state once so it can suppress
    // duplicate change events deterministically.
    expect(preferredLanguages).toHaveBeenCalledOnce()
  })

  it('normalizes an invalid renderer value to system at the Main boundary', () => {
    expect(updateLocalePreference('fr')).toEqual({ preference: 'system', locale: 'zh-CN' })
    expect(config.preference).toBe('system')
  })

  it('falls back to English if Electron locale lookup is unavailable', () => {
    preferredLanguages.mockImplementation(() => { throw new Error('app not ready') })
    expect(getLocaleState()).toEqual({ preference: 'system', locale: 'en' })
  })

  it('notifies removable listeners exactly once for a real state change', () => {
    const listener = vi.fn()
    const unsubscribe = onLocaleChanged(listener)

    updateLocalePreference('en')
    updateLocalePreference('en')
    expect(listener).toHaveBeenCalledOnce()
    expect(listener).toHaveBeenCalledWith({ preference: 'en', locale: 'en' })

    unsubscribe()
    updateLocalePreference('zh-CN')
    expect(listener).toHaveBeenCalledOnce()
  })

  it('refreshes a changed system locale once and remains re-entrant', () => {
    getLocaleState(['zh-CN'])
    const listener = vi.fn(() => getLocaleState(['en-US']))
    const unsubscribe = onLocaleChanged(listener)

    expect(refreshSystemLocale(['en-US'])).toEqual({ preference: 'system', locale: 'en' })
    expect(listener).toHaveBeenCalledOnce()
    expect(refreshSystemLocale(['en-US'])).toEqual({ preference: 'system', locale: 'en' })
    expect(listener).toHaveBeenCalledOnce()
    unsubscribe()
  })

  it('does not emit for OS language changes under an explicit preference', () => {
    updateLocalePreference('en', ['zh-CN'])
    const listener = vi.fn()
    const unsubscribe = onLocaleChanged(listener)
    expect(refreshSystemLocale(['zh-CN'])).toEqual({ preference: 'en', locale: 'en' })
    expect(listener).not.toHaveBeenCalled()
    unsubscribe()
  })
})

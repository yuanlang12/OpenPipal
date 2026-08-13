import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  followingEnabled: false,
  getFrontmostApp: vi.fn()
}))

vi.mock('electron', () => ({
  BrowserWindow: class {},
  screen: {
    getCursorScreenPoint: () => ({ x: 0, y: 0 }),
    getDisplayNearestPoint: () => ({ workArea: { x: 0, y: 0, width: 1440, height: 900 } })
  },
  shell: { openExternal: vi.fn() }
}))

vi.mock('../../src/main/app-follow-settings', () => ({
  isAppFollowingEnabled: () => state.followingEnabled
}))

vi.mock('../../src/main/app-detector', () => ({
  getFrontmostApp: state.getFrontmostApp
}))

vi.mock('../../src/main/app-config', () => ({
  getTargetConfig: () => ({ displayName: 'OpenPipal', processName: 'OpenPipal' })
}))

vi.mock('../../src/main/browser-context-store', () => ({ isExtensionActive: () => false }))
vi.mock('../../src/main/config-manager', () => ({ loadConfig: () => ({}) }))
vi.mock('../../src/main/main-i18n', () => ({ tMain: (key: string) => key }))
vi.mock('../../src/main/locale-manager', () => ({ getLocaleState: () => ({ locale: 'en' }) }))
vi.mock('../../src/main/browser-notification-html', () => ({ renderBrowserNotificationHtml: () => '<html />' }))

const { startTracking, stopTracking } = await import('../../src/main/window-tracker')

const windowStub = {
  on: vi.fn(),
  getBounds: () => ({ x: 0, y: 0, width: 400, height: 700 }),
  setBounds: vi.fn()
}

describe('global app-following pause', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    delete process.env.OPENPIPAL_DISABLE_APP_TRACKING
    state.followingEnabled = false
    state.getFrontmostApp.mockReset().mockResolvedValue(null)
    windowStub.on.mockClear()
    windowStub.setBounds.mockClear()
  })

  afterEach(() => {
    stopTracking()
    delete process.env.OPENPIPAL_DISABLE_APP_TRACKING
    vi.useRealTimers()
  })

  it('does not probe macOS frontmost-app APIs while globally paused', async () => {
    startTracking(windowStub as any)

    await vi.advanceTimersByTimeAsync(1000)

    expect(state.getFrontmostApp).not.toHaveBeenCalled()
  })

  it('resumes frontmost-app probing after the global pause is lifted', async () => {
    startTracking(windowStub as any)
    state.followingEnabled = true

    await vi.advanceTimersByTimeAsync(1000)

    expect(state.getFrontmostApp).toHaveBeenCalledTimes(1)
  })

  it('honors the explicit QA opt-out even if the saved product setting is enabled', async () => {
    state.followingEnabled = true
    process.env.OPENPIPAL_DISABLE_APP_TRACKING = '1'
    startTracking(windowStub as any)

    await vi.advanceTimersByTimeAsync(1000)

    expect(state.getFrontmostApp).not.toHaveBeenCalled()
  })
})

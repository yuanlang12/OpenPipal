import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  stdout: 'Notion|10,20,800,600,false',
  addDetectedApp: vi.fn(),
  isAppFollowingEnabled: vi.fn(),
  shouldFollowDetectedApp: vi.fn()
}))

vi.mock('child_process', () => ({
  execFile: (_file: string, _args: string[], _options: unknown, callback: (error: null, result: { stdout: string }) => void) => {
    callback(null, { stdout: state.stdout })
  }
}))

vi.mock('../../src/main/app-follow-settings', () => ({
  addDetectedApp: state.addDetectedApp,
  isAppFollowingEnabled: state.isAppFollowingEnabled,
  shouldFollowDetectedApp: state.shouldFollowDetectedApp
}))

import { getFrontmostApp } from '../../src/main/app-detector'

beforeEach(() => {
  state.addDetectedApp.mockClear()
  state.stdout = 'Notion|10,20,800,600,false'
  state.isAppFollowingEnabled.mockReset().mockReturnValue(true)
  state.shouldFollowDetectedApp.mockReset()
})

describe('app detector following gate', () => {
  it('records an app but returns no follow target while globally paused', async () => {
    state.shouldFollowDetectedApp.mockReturnValue(false)

    await expect(getFrontmostApp()).resolves.toBeNull()
    expect(state.addDetectedApp).toHaveBeenCalledWith('Notion')
    expect(state.shouldFollowDetectedApp).toHaveBeenCalledWith('Notion')
  })

  it('returns the target once the combined settings gate allows it', async () => {
    state.shouldFollowDetectedApp.mockReturnValue(true)

    await expect(getFrontmostApp()).resolves.toEqual({
      processName: 'Notion',
      appName: 'Notion',
      bounds: { x: 10, y: 20, width: 800, height: 600, isFullscreen: false }
    })
  })

  it('records a browser but suppresses its tracker and extension-prompt target while paused', async () => {
    state.stdout = 'Safari|ERR'
    state.isAppFollowingEnabled.mockReturnValue(false)

    await expect(getFrontmostApp()).resolves.toBeNull()
    expect(state.addDetectedApp).toHaveBeenCalledWith('Safari')
    expect(state.shouldFollowDetectedApp).not.toHaveBeenCalled()
  })
})

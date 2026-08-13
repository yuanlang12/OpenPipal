import { beforeEach, describe, expect, it, vi } from 'vitest'

const electron = vi.hoisted(() => {
  type Handler = (...args: unknown[]) => void

  class MockWebContents {
    readonly handlers = new Map<string, Handler[]>()
    readonly send = vi.fn()
    readonly setWindowOpenHandler = vi.fn()

    on(event: string, handler: Handler): this {
      const handlers = this.handlers.get(event) ?? []
      handlers.push(handler)
      this.handlers.set(event, handlers)
      return this
    }

    emit(event: string): void {
      for (const handler of this.handlers.get(event) ?? []) handler()
    }
  }

  class MockBrowserWindow {
    readonly webContents = new MockWebContents()
    readonly handlers = new Map<string, Handler[]>()
    readonly show = vi.fn()
    readonly focus = vi.fn()
    readonly close = vi.fn()
    readonly loadURL = vi.fn()
    readonly loadFile = vi.fn()
    readonly setVisibleOnAllWorkspaces = vi.fn()
    readonly setAlwaysOnTop = vi.fn()
    readonly isDestroyed = vi.fn(() => false)

    constructor(_options: unknown) {
      state.windows.push(this)
    }

    on(event: string, handler: Handler): this {
      const handlers = this.handlers.get(event) ?? []
      handlers.push(handler)
      this.handlers.set(event, handlers)
      return this
    }

    emit(event: string): void {
      for (const handler of this.handlers.get(event) ?? []) handler()
    }
  }

  const state: {
    windows: MockBrowserWindow[]
    ipcHandlers: Map<string, Handler>
  } = {
    windows: [],
    ipcHandlers: new Map()
  }

  return {
    BrowserWindow: MockBrowserWindow,
    ipcMain: {
      on: vi.fn((channel: string, handler: Handler) => {
        state.ipcHandlers.set(channel, handler)
      })
    },
    screen: {
      getCursorScreenPoint: vi.fn(() => ({ x: 10, y: 20 })),
      getDisplayNearestPoint: vi.fn(() => ({
        workArea: { x: 0, y: 0, width: 1200, height: 900 }
      }))
    },
    state
  }
})

vi.mock('electron', () => ({
  BrowserWindow: electron.BrowserWindow,
  ipcMain: electron.ipcMain,
  screen: electron.screen
}))

vi.mock('@electron-toolkit/utils', () => ({ is: { dev: false } }))

describe('Presenter window readiness handshake', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    electron.state.windows.length = 0
    electron.state.ipcHandlers.clear()
  })

  it('delivers only the latest pending payload to the current ready renderer', async () => {
    const { closePresenter, hasOpenPresenter, openPresenter, registerPresenterIpc } = await import(
      '../../src/main/presenter-window'
    )
    registerPresenterIpc()

    openPresenter('<p>A</p>', 'A')
    const firstWindow = electron.state.windows[0]
    expect(firstWindow.webContents.send).not.toHaveBeenCalled()

    // A→B before ready must retain only B, including the explicit removal of A's title.
    openPresenter('<p>B</p>')
    expect(firstWindow.webContents.send).not.toHaveBeenCalled()

    const ready = electron.state.ipcHandlers.get('presenter:ready')
    expect(ready).toBeTypeOf('function')

    // A stale or unrelated renderer cannot unlock this Presenter window.
    ready?.({ sender: {} })
    expect(firstWindow.webContents.send).not.toHaveBeenCalled()

    ready?.({ sender: firstWindow.webContents })
    expect(firstWindow.webContents.send).toHaveBeenCalledTimes(1)
    expect(firstWindow.webContents.send).toHaveBeenLastCalledWith('presenter:set-content', {
      html: '<p>B</p>',
      title: undefined
    })

    // Duplicate ready (for example React StrictMode) has no payload to replay.
    ready?.({ sender: firstWindow.webContents })
    expect(firstWindow.webContents.send).toHaveBeenCalledTimes(1)

    openPresenter('<p>C</p>', 'C')
    expect(firstWindow.webContents.send).toHaveBeenCalledTimes(2)
    expect(firstWindow.webContents.send).toHaveBeenLastCalledWith('presenter:set-content', {
      html: '<p>C</p>',
      title: 'C'
    })

    // Reload without another open call must replay the currently displayed payload once.
    firstWindow.webContents.emit('did-start-loading')
    ready?.({ sender: firstWindow.webContents })
    expect(firstWindow.webContents.send).toHaveBeenCalledTimes(3)
    expect(firstWindow.webContents.send).toHaveBeenLastCalledWith('presenter:set-content', {
      html: '<p>C</p>',
      title: 'C'
    })
    ready?.({ sender: firstWindow.webContents })
    expect(firstWindow.webContents.send).toHaveBeenCalledTimes(3)

    // Navigation removes renderer listeners. D is held until the new renderer is ready.
    firstWindow.webContents.emit('did-start-loading')
    openPresenter('<p>D</p>', 'D')
    expect(firstWindow.webContents.send).toHaveBeenCalledTimes(3)
    ready?.({ sender: firstWindow.webContents })
    expect(firstWindow.webContents.send).toHaveBeenCalledTimes(4)
    expect(firstWindow.webContents.send).toHaveBeenLastCalledWith('presenter:set-content', {
      html: '<p>D</p>',
      title: 'D'
    })

    closePresenter()
    expect(hasOpenPresenter()).toBe(false)

    // close resets readiness: a new window must handshake independently.
    openPresenter('<p>E</p>', 'E')
    const secondWindow = electron.state.windows[1]
    expect(secondWindow.webContents.send).not.toHaveBeenCalled()
    ready?.({ sender: firstWindow.webContents })
    expect(secondWindow.webContents.send).not.toHaveBeenCalled()
    ready?.({ sender: secondWindow.webContents })
    expect(secondWindow.webContents.send).toHaveBeenCalledTimes(1)

    const close = electron.state.ipcHandlers.get('presenter:close')
    expect(close).toBeTypeOf('function')
    close?.({ sender: firstWindow.webContents })
    expect(hasOpenPresenter()).toBe(true)
    expect(secondWindow.close).not.toHaveBeenCalled()
    close?.({ sender: secondWindow.webContents })
    expect(hasOpenPresenter()).toBe(false)
    expect(secondWindow.close).toHaveBeenCalledOnce()
  })
})

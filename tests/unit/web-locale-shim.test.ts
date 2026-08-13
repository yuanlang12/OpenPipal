import { afterEach, describe, expect, it, vi } from 'vitest'
import { installWebApiShim } from '../../src/renderer/src/web-api-shim'
import type { LocalePreference, LocaleState } from '../../src/shared/i18n/contract'

describe('browser locale shim', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('authenticates locale requests and emits removable local change notifications', async () => {
    const token = 'b'.repeat(43)
    const extensionOrigin = `chrome-extension://${'a'.repeat(32)}`
    const parent = { postMessage: vi.fn() }
    const eventListeners = new Map<string, Array<(event: any) => void>>()
    let current: LocaleState = { preference: 'system', locale: 'zh-CN' }

    const nativeFetch = vi.fn(async (_input: RequestInfo | URL, init: RequestInit = {}) => {
      expect(new Headers(init.headers).get('X-OpenPipal-Browser-Token')).toBe(token)
      if (init.method === 'PUT') {
        const { preference } = JSON.parse(String(init.body)) as { preference: LocalePreference }
        current = { preference, locale: preference === 'system' ? 'zh-CN' : preference }
      }
      return new Response(JSON.stringify(current), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      })
    })
    const windowMock: Record<string, any> = {
      location: { origin: 'http://127.0.0.1:3031' },
      fetch: nativeFetch,
      parent,
      dispatchEvent: vi.fn(),
      addEventListener: vi.fn((name: string, listener: (event: any) => void) => {
        eventListeners.set(name, [...(eventListeners.get(name) || []), listener])
      })
    }
    vi.stubGlobal('window', windowMock)
    vi.spyOn(console, 'log').mockImplementation(() => undefined)

    installWebApiShim()
    const messageListener = eventListeners.get('message')?.[0]
    expect(messageListener).toBeDefined()
    messageListener?.({
      source: parent,
      origin: extensionOrigin,
      data: { type: 'OPENPIPAL_BROWSER_SESSION', token }
    })

    const api = windowMock.api as {
      getLocaleState: () => Promise<LocaleState>
      setLocalePreference: (preference: LocalePreference) => Promise<LocaleState>
      onLocaleChanged: (callback: (state: LocaleState) => void) => () => void
    }
    await expect(api.getLocaleState()).resolves.toEqual({ preference: 'system', locale: 'zh-CN' })

    const listener = vi.fn()
    const remove = api.onLocaleChanged(listener)
    await expect(api.setLocalePreference('en')).resolves.toEqual({ preference: 'en', locale: 'en' })
    expect(listener).toHaveBeenCalledOnce()
    expect(listener).toHaveBeenLastCalledWith({ preference: 'en', locale: 'en' })

    remove()
    await expect(api.setLocalePreference('zh-CN')).resolves.toEqual({ preference: 'zh-CN', locale: 'zh-CN' })
    expect(listener).toHaveBeenCalledOnce()
  })

  it('rejects malformed locale responses instead of poisoning renderer state', async () => {
    const token = 'b'.repeat(43)
    const parent = { postMessage: vi.fn() }
    let messageListener: ((event: any) => void) | undefined
    const windowMock: Record<string, any> = {
      location: { origin: 'http://127.0.0.1:3031' },
      fetch: vi.fn(async () => new Response('null', {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      })),
      parent,
      dispatchEvent: vi.fn(),
      addEventListener: vi.fn((name: string, listener: (event: any) => void) => {
        if (name === 'message') messageListener = listener
      })
    }
    vi.stubGlobal('window', windowMock)
    vi.spyOn(console, 'log').mockImplementation(() => undefined)

    installWebApiShim()
    messageListener?.({
      source: parent,
      origin: `chrome-extension://${'a'.repeat(32)}`,
      data: { type: 'OPENPIPAL_BROWSER_SESSION', token }
    })

    await expect(windowMock.api.getLocaleState()).rejects.toThrow('OpenPipal locale response is invalid')
  })
})

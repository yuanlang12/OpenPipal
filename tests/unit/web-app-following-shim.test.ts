import { afterEach, describe, expect, it, vi } from 'vitest'
import { installWebApiShim } from '../../src/renderer/src/web-api-shim'

describe('browser app-following shim', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('rejects non-OK and malformed mutation responses before the UI accepts them', async () => {
    const token = 'b'.repeat(43)
    const parent = { postMessage: vi.fn() }
    let messageListener: ((event: any) => void) | undefined
    const responses = [
      new Response(JSON.stringify({ error: 'save failed' }), { status: 500 }),
      new Response(JSON.stringify({ ok: false, enabled: false }), { status: 200 }),
      new Response(JSON.stringify({ ok: true, enabled: false }), { status: 200 })
    ]
    const nativeFetch = vi.fn(async () => responses.shift()!)
    const windowMock: Record<string, any> = {
      location: { origin: 'http://127.0.0.1:3031' },
      fetch: nativeFetch,
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

    await expect(windowMock.api.setAppFollowingEnabled(false))
      .rejects.toThrow('request failed (500)')
    await expect(windowMock.api.setAppFollowingEnabled(false))
      .rejects.toThrow('response is invalid')
    await expect(windowMock.api.setAppFollowingEnabled(false))
      .resolves.toEqual({ ok: true, enabled: false })
  })
})

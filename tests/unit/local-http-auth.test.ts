import { describe, expect, it } from 'vitest'
import {
  BROWSER_AUTH_HEADER,
  LocalHttpAuthBoundary,
  canUseUnboundExtensionCors,
  isBrowserRouteAllowed,
  isExactChromeExtensionOrigin,
  isPublicRendererPath,
  isStrictLoopbackHost,
  isWebhookSecretValid,
} from '../../src/main/local-http-auth'

const nativeToken = 'n'.repeat(43)
const browserToken = 'b'.repeat(43)
const extensionOrigin = `chrome-extension://${'a'.repeat(32)}`

describe('local HTTP authorization boundary', () => {
  it('accepts only the actual loopback host and port', () => {
    expect(isStrictLoopbackHost('localhost:3031', 3031)).toBe(true)
    expect(isStrictLoopbackHost('127.0.0.1:3031', 3031)).toBe(true)
    expect(isStrictLoopbackHost('localhost:3032', 3031)).toBe(false)
    expect(isStrictLoopbackHost('openpipal.test:3031', 3031)).toBe(false)
    expect(isStrictLoopbackHost(undefined, 3031)).toBe(false)
  })

  it('binds the first exact extension origin for the process', () => {
    const auth = new LocalHttpAuthBoundary(nativeToken, browserToken)
    expect(isExactChromeExtensionOrigin(extensionOrigin)).toBe(true)
    expect(isExactChromeExtensionOrigin('chrome-extension://test')).toBe(false)
    expect(auth.bindExtensionSession(extensionOrigin)).toEqual({ ok: true, token: browserToken, origin: extensionOrigin })
    expect(auth.bindExtensionSession(extensionOrigin).ok).toBe(true)
    expect(auth.bindExtensionSession(`chrome-extension://${'c'.repeat(32)}`)).toMatchObject({ ok: false, status: 403 })
  })

  it('exposes a non-secret, process-scoped restart marker for extension recovery', () => {
    const first = new LocalHttpAuthBoundary(nativeToken, browserToken)
    const second = new LocalHttpAuthBoundary(nativeToken, browserToken)

    expect(first.getProcessNonce()).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(second.getProcessNonce()).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(first.getProcessNonce()).not.toBe(second.getProcessNonce())
    expect(first.getProcessNonce()).not.toBe(browserToken)
  })

  it('authenticates native compatibility headers and the browser token separately', () => {
    const auth = new LocalHttpAuthBoundary(nativeToken, browserToken)
    expect(auth.authenticate({ 'x-openpipal-acp-token': nativeToken })).toEqual({ ok: true, principal: 'native' })
    expect(auth.authenticate({ authorization: `Bearer ${nativeToken}` })).toEqual({ ok: true, principal: 'native' })
    expect(auth.authenticate({ [BROWSER_AUTH_HEADER]: browserToken })).toEqual({ ok: true, principal: 'browser' })
    expect(auth.authenticate({ [BROWSER_AUTH_HEADER]: 'x'.repeat(43) })).toMatchObject({ ok: false, status: 401 })
    expect(auth.authenticate({})).toMatchObject({ ok: false, status: 401 })
  })

  it('keeps browser scope away from native configuration, MCP and filesystem-copy routes', () => {
    expect(isBrowserRouteAllowed('POST', '/chat/stream')).toBe(true)
    expect(isBrowserRouteAllowed('POST', '/chat')).toBe(false)
    expect(isBrowserRouteAllowed('POST', '/api/permission')).toBe(true)
    expect(isBrowserRouteAllowed('PATCH', '/api/conversations/c1')).toBe(true)
    expect(isBrowserRouteAllowed('GET', '/api/config/model')).toBe(true)
    expect(isBrowserRouteAllowed('GET', '/api/locale')).toBe(true)
    expect(isBrowserRouteAllowed('PUT', '/api/locale')).toBe(true)
    expect(isBrowserRouteAllowed('POST', '/api/locale')).toBe(false)
    expect(isBrowserRouteAllowed('PATCH', '/api/locale')).toBe(false)
    expect(isBrowserRouteAllowed('DELETE', '/api/locale')).toBe(false)
    expect(isBrowserRouteAllowed('POST', '/api/config/model')).toBe(false)
    expect(isBrowserRouteAllowed('POST', '/api/config/model/test')).toBe(false)
    expect(isBrowserRouteAllowed('GET', '/api/memory/archived')).toBe(true)
    expect(isBrowserRouteAllowed('POST', '/api/memory/restore')).toBe(true)
    expect(isBrowserRouteAllowed('GET', '/settings/apps')).toBe(true)
    expect(isBrowserRouteAllowed('POST', '/settings/disabled-apps')).toBe(true)
    expect(isBrowserRouteAllowed('POST', '/settings/app-following')).toBe(true)
    expect(isBrowserRouteAllowed('POST', '/api/acp/sessions/s1/mcp')).toBe(false)
    expect(isBrowserRouteAllowed('POST', '/api/assets/upload-to-category')).toBe(false)
    expect(isBrowserRouteAllowed('POST', '/api/artifact/export-zip')).toBe(false)
  })

  it('publishes only the shell and explicit read-only static resources', () => {
    expect(isPublicRendererPath('GET', '/')).toBe(true)
    expect(isPublicRendererPath('GET', '/assets/app.js')).toBe(true)
    expect(isPublicRendererPath('GET', '/unknown-future-route')).toBe(false)
    expect(isPublicRendererPath('GET', '/assets/../private')).toBe(false)
    expect(isPublicRendererPath('GET', '/design-systems/demo/index.html')).toBe(false)
    expect(isPublicRendererPath('GET', `/design-systems/${'x'.repeat(43)}/demo/index.html`)).toBe(false)
    expect(isPublicRendererPath('GET', '/api/conversations')).toBe(false)
    expect(isPublicRendererPath('GET', '/extension')).toBe(true)
    expect(isPublicRendererPath('GET', '/extension/session')).toBe(false)
    expect(isPublicRendererPath('GET', '/extension/future-route')).toBe(false)
  })

  it('fails webhook authorization closed when no task secret is configured', () => {
    expect(isWebhookSecretValid(undefined, undefined)).toBe(false)
    expect(isWebhookSecretValid(undefined, 'supplied')).toBe(false)
    expect(isWebhookSecretValid('configured', undefined)).toBe(false)
    expect(isWebhookSecretValid('configured', 'wrong')).toBe(false)
    expect(isWebhookSecretValid('configured', 'configured')).toBe(true)
  })

  it('allows stale-token recovery CORS only before binding and only for browser routes', () => {
    expect(canUseUnboundExtensionCors(null, extensionOrigin, 'POST', '/context')).toBe(true)
    expect(canUseUnboundExtensionCors(null, extensionOrigin, 'POST', '/extension/session')).toBe(true)
    expect(canUseUnboundExtensionCors(null, extensionOrigin, 'POST', '/api/config/model')).toBe(false)
    expect(canUseUnboundExtensionCors(extensionOrigin, extensionOrigin, 'POST', '/context')).toBe(false)
    expect(canUseUnboundExtensionCors(null, 'https://evil.example', 'POST', '/context')).toBe(false)
  })
})

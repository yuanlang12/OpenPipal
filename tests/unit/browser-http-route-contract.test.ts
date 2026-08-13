import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { isBrowserRouteAllowed, isPublicRendererPath } from '../../src/main/local-http-auth'

interface BrowserFetchRoute {
  method: string
  pathname: string
  template: string
}

function browserFetchRoutes(source: string): BrowserFetchRoute[] {
  return source.split('fetch(').flatMap((segment) => {
    const url = segment.match(/^`\$\{API_BASE\}([^`]*)`/)
    if (!url) return []
    const method = segment.match(/method:\s*'([A-Z]+)'/)?.[1] || 'GET'
    const representative = url[1].replace(/\$\{[^}]*\}/g, 'sample')
    const pathname = new URL(representative, 'http://openpipal.local').pathname
    return [{ method, pathname, template: url[1] }]
  })
}

describe('browser HTTP client authorization contract', () => {
  const source = readFileSync(resolve('src/renderer/src/web-api-shim.ts'), 'utf8')
  const httpSource = readFileSync(resolve('src/main/http-server.ts'), 'utf8')
  const browserControlSource = readFileSync(resolve('src/main/browser-control.ts'), 'utf8')
  const extensionPageSource = readFileSync(resolve('src/main/extension-page.ts'), 'utf8')
  const gallerySource = readFileSync(resolve('src/renderer/src/components/artifacts/DesignSystemGallery.tsx'), 'utf8')
  const filesSource = readFileSync(resolve('src/renderer/src/components/artifacts/DesignSystemFiles.tsx'), 'utf8')
  const chatStoreSource = readFileSync(resolve('src/renderer/src/stores/chatStore.ts'), 'utf8')
  const routes = browserFetchRoutes(source)

  it('allowlists every dynamic route still called by the browser shim', () => {
    expect(routes.length).toBeGreaterThan(20)
    for (const route of routes) {
      expect(
        isBrowserRouteAllowed(route.method, route.pathname),
        `${route.method} ${route.template} must be browser-allowlisted or replaced by an explicit stub`,
      ).toBe(true)
    }
  })

  it('keeps native configuration, arbitrary local paths, and ACP MCP out of browser fetches', () => {
    const routeKeys = new Set(routes.map(route => `${route.method} ${route.pathname}`))
    expect(routeKeys).not.toContain('POST /api/config/model')
    expect(routeKeys).not.toContain('POST /api/config/model/test')
    expect(routeKeys).not.toContain('POST /api/config/clear-model')
    expect(routeKeys).not.toContain('POST /api/assets/upload-to-category')
    expect(routeKeys).not.toContain('POST /api/assets/delete')
    expect(routeKeys).not.toContain('POST /api/artifact/export-zip')
    expect([...routeKeys].some(route => route.includes('/api/acp/'))).toBe(false)

    expect(source).toContain("browserUnsupported('runtimeChrome.browserShim.features.saveModel')")
    expect(source).toContain("browserUnsupported('runtimeChrome.browserShim.features.testModel')")
    expect(source).toContain("browserUnsupported('runtimeChrome.browserShim.features.importLocalAsset')")
    expect(source).toContain("browserUnsupported('runtimeChrome.browserShim.features.deleteLocalAsset')")
    expect(source).toContain("browserUnsupported('runtimeChrome.browserShim.features.exportLocalDirectory')")
  })

  it('keeps first-turn role and configuration on the authenticated browser path', () => {
    expect(source).toContain('async updateConversationRole(conversationId: string, role: string)')
    expect(source).toContain('body: JSON.stringify({ role })')
    expect(source).toContain('conversationConfig?: any, conversationId?: string')
    expect(source).toContain('conversationConfig,\n          context: browserContext')
    expect(httpSource).toContain('await updateConversationRole(id, body.role)')
    expect(httpSource).toContain('await updateConversationConfig(conversationId, body.conversationConfig)')
    expect(chatStoreSource).toContain('const persisted = await window.api.updateConversationConfig(id, merged)')
    expect(chatStoreSource).toContain("assertPersistenceSucceeded(persisted, 'persist first-turn conversation config')")
    expect(chatStoreSource).toContain("if (!ok) throw new Error('Failed to persist first-turn conversation role')")
  })

  it('binds browser artifact loads to the active conversation instead of trusting a raw path', () => {
    expect(source).toContain('body: JSON.stringify({ ref, conversationId })')
    expect(httpSource).toContain('loadArtifact(body.ref, body.conversationId)')
    expect(httpSource).toContain("throw new Error('conversationId 必填')")
  })

  it('keeps the public installation guide path-free and CORS origin-bound', () => {
    expect(httpSource).not.toContain("Access-Control-Allow-Origin', '*")
    expect(httpSource).not.toContain('Documents/code/ClassIn')
    expect(extensionPageSource).not.toContain('EXTENSION_PATH_PLACEHOLDER')
    expect(extensionPageSource).toContain('openpipal-extension')
    expect(httpSource).toContain('getExtensionPageHtml(getLocaleState().locale)')
  })

  it('keeps user design-system files behind a process-lifetime read capability', () => {
    expect(isPublicRendererPath('GET', '/design-systems/demo/index.html')).toBe(false)
    expect(source).toContain('/api/assets/design-system-capability')
    expect(gallerySource).not.toContain("const BASE = 'http://127.0.0.1:3031/design-systems'")
    expect(filesSource).not.toContain("const BASE = 'http://127.0.0.1:3031/design-systems'")
    expect(gallerySource).toContain('getDesignSystemResourceBaseUrl')
    expect(filesSource).toContain('getDesignSystemResourceBaseUrl')
  })

  it('authenticates browser-control before adopting a command socket', () => {
    const connection = browserControlSource.slice(browserControlSource.indexOf("wss.on('connection'"))
    const authentication = connection.indexOf("msg.type !== 'register' || !auth.isBrowserTokenValid(msg.token)")
    const adoption = connection.indexOf('extSocket = ws')
    expect(connection).toContain('isStrictLoopbackHost(req.headers.host, getPort())')
    expect(connection).toContain('auth.isBoundExtensionOrigin(origin)')
    expect(authentication).toBeGreaterThan(-1)
    expect(adoption).toBeGreaterThan(authentication)
  })
})

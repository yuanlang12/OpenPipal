import { randomBytes, timingSafeEqual } from 'crypto'
import type { IncomingHttpHeaders } from 'http'
import { parseDesignSystemStaticCapabilityPath } from './design-system-resource'

export const NATIVE_AUTH_HEADER = 'x-openpipal-local-token'
export const LEGACY_ACP_AUTH_HEADER = 'x-openpipal-acp-token'
export const BROWSER_AUTH_HEADER = 'x-openpipal-browser-token'

export type LocalHttpPrincipal = 'native' | 'browser'

export interface LocalHttpAuthentication {
  ok: true
  principal: LocalHttpPrincipal
}

export interface LocalHttpAuthenticationFailure {
  ok: false
  status: 401 | 403
  error: string
}

export type LocalHttpAuthenticationResult = LocalHttpAuthentication | LocalHttpAuthenticationFailure

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/
const EXTENSION_ORIGIN_PATTERN = /^chrome-extension:\/\/[a-p]{32}$/

function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value
}

function tokenEquals(supplied: string | undefined, expected: string): boolean {
  if (!supplied || !TOKEN_PATTERN.test(supplied) || !TOKEN_PATTERN.test(expected)) return false
  const a = Buffer.from(supplied)
  const b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}

function bearerToken(value: string | undefined): string | undefined {
  const match = value?.match(/^Bearer ([A-Za-z0-9_-]+)$/)
  return match?.[1]
}

/** Reject DNS rebinding and requests sent to a stale/wrong OpenPipal port. */
export function isStrictLoopbackHost(host: string | string[] | undefined, actualPort: number): boolean {
  const value = firstHeader(host)?.toLowerCase()
  if (!value || !Number.isInteger(actualPort) || actualPort < 1 || actualPort > 65_535) return false
  return value === `localhost:${actualPort}` || value === `127.0.0.1:${actualPort}`
}

export function isExactChromeExtensionOrigin(origin: string | string[] | undefined): origin is string {
  return typeof origin === 'string' && EXTENSION_ORIGIN_PATTERN.test(origin)
}

export function isWebhookSecretValid(configured: string | undefined, supplied: string | undefined): boolean {
  if (!configured || !supplied) return false
  const a = Buffer.from(configured)
  const b = Buffer.from(supplied)
  return a.length === b.length && timingSafeEqual(a, b)
}

/**
 * Browser authority is intentionally process-scoped and narrower than native
 * authority. The first exact Chrome extension origin to bootstrap a session is
 * pinned until the desktop process restarts. This blocks arbitrary web pages;
 * a malicious locally-installed extension or local process remains outside the
 * v1 threat boundary and should be addressed with native messaging/pairing.
 */
export class LocalHttpAuthBoundary {
  private readonly browserToken: string
  private readonly processNonce: string
  private boundExtensionOrigin: string | null = null

  constructor(
    private readonly nativeToken: string,
    browserToken: string = randomBytes(32).toString('base64url'),
  ) {
    if (!TOKEN_PATTERN.test(nativeToken) || !TOKEN_PATTERN.test(browserToken)) {
      throw new Error('Local HTTP authorization token is invalid')
    }
    this.browserToken = browserToken
    // Public liveness marker only: it lets the extension discard a token from
    // a prior desktop process without ever exposing that token through /health.
    this.processNonce = randomBytes(32).toString('base64url')
  }

  bindExtensionSession(origin: string | string[] | undefined): { ok: true; token: string; origin: string } | LocalHttpAuthenticationFailure {
    if (!isExactChromeExtensionOrigin(origin)) {
      return { ok: false, status: 403, error: 'Exact Chrome extension origin required' }
    }
    if (this.boundExtensionOrigin && this.boundExtensionOrigin !== origin) {
      return { ok: false, status: 403, error: 'A different browser extension is already bound' }
    }
    this.boundExtensionOrigin = origin
    return { ok: true, token: this.browserToken, origin }
  }

  getBoundExtensionOrigin(): string | null {
    return this.boundExtensionOrigin
  }

  getProcessNonce(): string {
    return this.processNonce
  }

  isBoundExtensionOrigin(origin: string | string[] | undefined): origin is string {
    return typeof origin === 'string' && origin === this.boundExtensionOrigin
  }

  isBrowserTokenValid(value: string | string[] | undefined): boolean {
    return tokenEquals(firstHeader(value), this.browserToken)
  }

  authenticate(headers: IncomingHttpHeaders): LocalHttpAuthenticationResult {
    const legacy = firstHeader(headers[LEGACY_ACP_AUTH_HEADER])
    const native = firstHeader(headers[NATIVE_AUTH_HEADER])
    const bearer = bearerToken(firstHeader(headers.authorization))
    const suppliedNative = legacy ?? native ?? bearer
    if (suppliedNative !== undefined) {
      return tokenEquals(suppliedNative, this.nativeToken)
        ? { ok: true, principal: 'native' }
        : { ok: false, status: 403, error: 'Invalid local authorization token' }
    }

    const suppliedBrowser = headers[BROWSER_AUTH_HEADER]
    if (suppliedBrowser !== undefined) {
      return this.isBrowserTokenValid(suppliedBrowser)
        ? { ok: true, principal: 'browser' }
        : { ok: false, status: 401, error: 'Invalid browser authorization token' }
    }

    return { ok: false, status: 401, error: 'Local authorization required' }
  }
}

const BROWSER_EXACT_ROUTES = new Set([
  'POST /extension/register',
  'POST /context',
  'POST /chat/stream',
  'POST /api/permission',
  'GET /role/init-state',
  'GET /role/all',
  'GET /role/current',
  'POST /role/switch',
  'GET /api/agents/list',
  'GET /api/config/model',
  'GET /api/config/providers',
  'GET /api/config/has-key',
  'GET /api/config/is-custom',
  'GET /api/locale',
  'PUT /api/locale',
  'GET /settings/apps',
  'POST /settings/disabled-apps',
  'POST /settings/app-following',
  'GET /api/conversations',
  'POST /api/conversations',
  'GET /api/memory/archived',
  'POST /api/memory/restore',
  'GET /api/assets/list-tree',
  'GET /api/assets/list-design-systems',
  'GET /api/assets/design-system-resource',
  'GET /api/assets/design-system-capability',
  'POST /api/artifact/save',
  'POST /api/artifact/load',
  'POST /api/artifact/load-compiled',
  'GET /api/workspace/list-output-history',
  'POST /api/artifact/export-dc',
  'POST /api/artifact/export-pdf',
  'POST /api/openpipal/complete',
])

/** Browser scope is allowlisted. New dynamic routes therefore default closed. */
export function isBrowserRouteAllowed(method: string | undefined, pathname: string): boolean {
  const verb = method || 'GET'
  if (BROWSER_EXACT_ROUTES.has(`${verb} ${pathname}`)) return true
  if (/^\/api\/conversations\/[^/]+$/.test(pathname)) {
    return verb === 'GET' || verb === 'PATCH' || verb === 'DELETE'
  }
  if (/^\/api\/conversations\/[^/]+\/messages$/.test(pathname)) {
    return verb === 'GET' || verb === 'POST' || verb === 'PUT'
  }
  if (pathname === '/api/chat/role-preflow') return verb === 'GET'
  if (pathname === '/api/assets/design-system-manifest') return verb === 'GET'
  if (pathname === '/api/assets/compiled-ds-manifest') return verb === 'GET'
  if (pathname === '/api/artifact/list-history') return verb === 'GET'
  return false
}

export function isPublicRendererPath(method: string | undefined, pathname: string): boolean {
  if (method !== 'GET') return false
  if (pathname === '/extension') return true
  if (parseDesignSystemStaticCapabilityPath(pathname)) return true
  if (pathname === '/') return true
  if (/^\/assets\/[A-Za-z0-9._/-]+$/.test(pathname) && !pathname.includes('..')) return true
  return /^\/(?:favicon|icon)(?:-[A-Za-z0-9._-]+)?\.(?:ico|png|svg)$/.test(pathname)
}

/**
 * After a desktop restart the extension still holds the prior process token.
 * Allow only a preflight/auth-failure response for known browser routes while
 * no origin is bound, so the client can observe 401 and bootstrap a new token.
 * This grants no route access and stops applying as soon as an origin is bound.
 */
export function canUseUnboundExtensionCors(
  boundOrigin: string | null,
  origin: string | string[] | undefined,
  method: string | undefined,
  pathname: string,
): boolean {
  if (boundOrigin !== null || !isExactChromeExtensionOrigin(origin)) return false
  if (method === 'GET' && pathname === '/health') return true
  if (method === 'POST' && pathname === '/extension/session') return true
  return isBrowserRouteAllowed(method, pathname)
}

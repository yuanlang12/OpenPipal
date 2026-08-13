import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('browser locale bridge contract', () => {
  const shim = readFileSync(resolve('src/renderer/src/web-api-shim.ts'), 'utf8')
  const server = readFileSync(resolve('src/main/http-server.ts'), 'utf8')

  it('keeps the browser bridge API congruent with the desktop preload', () => {
    expect(shim).toContain('async getLocaleState(): Promise<LocaleState>')
    expect(shim).toContain('async setLocalePreference(preference: LocalePreference): Promise<LocaleState>')
    expect(shim).toContain("emit('locale:changed', state)")
    expect(shim).toContain("return on('locale:changed', callback)")
  })

  it('uses one narrow locale endpoint instead of exposing general configuration', () => {
    expect(shim).toContain('fetch(`${API_BASE}/api/locale`)')
    expect(shim).toContain("method: 'PUT'")
    expect(shim).toContain('body: JSON.stringify({ preference })')
    expect(server).toContain('LOCALE_REQUEST_BODY_MAX_BYTES = 256')
    expect(server).toContain('getLocaleState()')
    expect(server).toContain('updateLocalePreference(')
  })
})

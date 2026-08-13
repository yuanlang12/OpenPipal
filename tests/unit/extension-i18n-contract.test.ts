import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

interface ChromeMessage {
  message: string
  placeholders?: Record<string, { content: string }>
}

type ChromeMessages = Record<string, ChromeMessage>

const read = (path: string): string => readFileSync(resolve(path), 'utf8')
const readJson = <T>(path: string): T => JSON.parse(read(path)) as T

describe('Chrome extension i18n contract', () => {
  const manifest = readJson<Record<string, unknown>>('openpipal-extension/manifest.json')
  const english = readJson<ChromeMessages>('openpipal-extension/_locales/en/messages.json')
  const chinese = readJson<ChromeMessages>('openpipal-extension/_locales/zh_CN/messages.json')
  const sidepanelHtml = read('openpipal-extension/sidepanel.html')
  const sidepanelJs = read('openpipal-extension/sidepanel.js')
  const backgroundJs = read('openpipal-extension/background.js')

  it('lets Chrome choose the packaged locale for manifest strings', () => {
    expect(manifest.default_locale).toBe('en')
    expect(manifest.name).toBe('__MSG_extensionName__')
    expect(manifest.description).toBe('__MSG_extensionDescription__')
    expect((manifest.action as Record<string, unknown>).default_title).toBe('__MSG_actionTitle__')
  })

  it('keeps complete, matching English and Simplified Chinese catalogs', () => {
    expect(Object.keys(english).sort()).toEqual(Object.keys(chinese).sort())
    expect(Object.keys(english)).toEqual(expect.arrayContaining([
      'disconnectedTitle',
      'disconnectedDescription',
      'connectingStatus',
      'retryStatus',
      'contextMenuExplain',
      'contextMenuTranslate'
    ]))

    for (const catalog of [english, chinese]) {
      for (const entry of Object.values(catalog)) expect(entry.message.trim()).not.toBe('')
      expect(catalog.retryStatus.message).toContain('$COUNT$')
      expect(catalog.retryStatus.placeholders?.count.content).toBe('$1')
    }
  })

  it('localizes the disconnected shell and retry status through chrome.i18n', () => {
    const htmlKeys = [...sidepanelHtml.matchAll(/data-i18n="([^"]+)"/g)].map(match => match[1])
    expect(htmlKeys).toEqual(expect.arrayContaining([
      'disconnectedTitle',
      'disconnectedDescription',
      'openDesktopStep',
      'waitForReconnectStep',
      'reconnectButton',
      'connectingStatus'
    ]))
    for (const key of htmlKeys) expect(english[key], `missing locale message: ${key}`).toBeDefined()

    expect(sidepanelJs).toContain('chrome.i18n.getUILanguage()')
    expect(sidepanelJs).toContain('chrome.i18n.getMessage(name, substitutions)')
    expect(sidepanelJs).toContain("i18nMessage('connectingStatus')")
    expect(sidepanelJs).toContain("i18nMessage('retryStatus', [String(failCount)])")
    expect(sidepanelHtml).not.toContain('onclick=')
  })

  it('localizes both context-menu actions without changing their action ids', () => {
    expect(backgroundJs).toContain("id: 'openpipal-explain'")
    expect(backgroundJs).toContain("id: 'openpipal-translate'")
    expect(backgroundJs).toContain("chrome.i18n.getMessage('contextMenuExplain')")
    expect(backgroundJs).toContain("chrome.i18n.getMessage('contextMenuTranslate')")
  })

  it('keeps the process-scoped browser-session authentication path intact', () => {
    for (const source of [sidepanelJs, backgroundJs]) {
      expect(source).toContain('/extension/session')
      expect(source).toContain("headers.set(BROWSER_TOKEN_HEADER, token)")
      expect(source).toContain("res.status === 401 || res.status === 403")
      expect(source).toContain("credentials: 'omit'")
    }
  })
})

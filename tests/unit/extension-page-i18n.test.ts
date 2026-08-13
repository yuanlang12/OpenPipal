import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { escapeExtensionPageHtml, getExtensionPageHtml } from '../../src/main/extension-page'

describe('extension installation page i18n', () => {
  it('renders the requested locale without introducing a second i18n engine', () => {
    const english = getExtensionPageHtml('en')
    const chinese = getExtensionPageHtml('zh-CN')

    expect(english).toContain('<html lang="en">')
    expect(english).toContain('<title>Install the OpenPipal browser extension</title>')
    expect(english).not.toMatch(/[\u3400-\u9fff]/)
    expect(chinese).toContain('<html lang="zh-CN">')
    expect(chinese).toContain('<title>安装 OpenPipal 浏览器插件</title>')

    const source = readFileSync(resolve('src/main/extension-page.ts'), 'utf8')
    expect(source).toContain('APP_I18N_RESOURCES[locale].extensionInstall')
    expect(source).not.toMatch(/createInstance|from ['"]i18next['"]/)
  })

  it('preserves product and protocol tokens in both locales', () => {
    for (const locale of ['en', 'zh-CN'] as const) {
      const html = getExtensionPageHtml(locale)
      for (const token of ['OpenPipal', 'Chrome', 'YouTube', 'AI', 'chrome://extensions/', 'openpipal-extension']) {
        expect(html).toContain(token)
      }
    }
  })

  it('uses escaped data attributes for copy hints', () => {
    const html = getExtensionPageHtml('en')
    expect(html).toContain('data-copy-label="Click to copy"')
    expect(html).toContain('data-copied-label="Copied ✓"')
    expect(html).toContain('content: attr(data-copy-label)')
    expect(html).toContain('content: attr(data-copied-label)')
    expect(html).toContain('role="button" tabindex="0"')
    expect(html).toContain("navigator.clipboard.writeText")
    expect(html).toContain("event.key !== 'Enter' && event.key !== ' '")

    const dangerous = `<script data-test="x">Tom & 'Jerry'</script>`
    const escaped = escapeExtensionPageHtml(dangerous)
    expect(escaped).toBe('&lt;script data-test=&quot;x&quot;&gt;Tom &amp; &#39;Jerry&#39;&lt;/script&gt;')
    expect(escaped).not.toContain('<script')
  })
})

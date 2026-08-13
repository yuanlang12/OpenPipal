import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createRendererI18n } from '../../src/renderer/src/i18n'
import { resolvePresenterDisplayTitle } from '../../src/renderer/src/components/PresenterView'

const read = (path: string): string => readFileSync(resolve(path), 'utf8')

describe('Presenter i18n', () => {
  it('localizes only the OpenPipal-owned fallback title and reacts to locale changes', async () => {
    const i18n = await createRendererI18n('en')

    expect(resolvePresenterDisplayTitle(undefined, i18n.t)).toBe('Presentation')
    expect(resolvePresenterDisplayTitle('', i18n.t)).toBe('Presentation')

    await i18n.changeLanguage('zh-CN')
    expect(resolvePresenterDisplayTitle(undefined, i18n.t)).toBe('演示')
  })

  it('keeps explicit dynamic titles byte-for-byte in every locale', async () => {
    const i18n = await createRendererI18n('en')
    const title = '  用户的演示标题  '

    expect(resolvePresenterDisplayTitle(title, i18n.t)).toBe(title)
    await i18n.changeLanguage('zh-CN')
    expect(resolvePresenterDisplayTitle(title, i18n.t)).toBe(title)
  })

  it('does not freeze a Chinese fallback in main or retain a previous dynamic title', () => {
    const view = read('src/renderer/src/components/PresenterView.tsx')
    const main = read('src/main/presenter-window.ts')
    const tools = read('src/main/openpipal-product-tools.ts')

    expect(view).toContain('setRawTitle(payload.title)')
    expect(view).toContain("t('artifacts.presenter.closeWithEscape')")
    expect(view).toContain("t('artifacts.presenter.waiting')")
    expect(view).toContain('title={displayTitle}')
    expect(main).toContain('openPresenter(html: string, title?: string)')
    expect(main).not.toContain("title = '演示'")
    expect(tools).toContain('openPresenter(p.content, p.title)')
    expect(tools).not.toContain("p.title || '演示'")
  })

  it('registers the content listener before announcing renderer readiness', () => {
    const view = read('src/renderer/src/components/PresenterView.tsx')
    const listenerIndex = view.indexOf("ipc.on('presenter:set-content', handler)")
    const readyIndex = view.indexOf("ipc.send('presenter:ready')")

    expect(listenerIndex).toBeGreaterThanOrEqual(0)
    expect(readyIndex).toBeGreaterThan(listenerIndex)
  })

  it('keeps long titles shrinkable and exposes a translated close label', () => {
    const view = read('src/renderer/src/components/PresenterView.tsx')

    expect(view).toContain('min-w-0 truncate')
    expect(view).toContain('shrink-0 p-1')
    expect(view).toContain("aria-label={t('artifacts.presenter.close')}")
  })
})

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { FALLBACK_LOCALE } from '../../src/shared/i18n/resources'
import {
  applyDocumentLocale,
  createLatestRequestGuard,
  createRendererI18n,
  resolveInitialLocaleState,
} from '../../src/renderer/src/i18n'

describe('renderer i18n', () => {
  it('initializes the requested language with Suspense disabled', async () => {
    const instance = await createRendererI18n('en')

    expect(instance.resolvedLanguage).toBe('en')
    expect(instance.options.fallbackLng).toEqual([FALLBACK_LOCALE])
    expect(instance.options.react).toMatchObject({ useSuspense: false })
    expect(instance.t('settings.title')).toBe('Settings')
    expect(instance.t('onboarding.welcomeTitle')).toBe('Welcome to OpenPipal')
  })

  it('uses Simplified Chinese when an English resource is missing', async () => {
    const instance = await createRendererI18n('en')
    instance.removeResourceBundle('en', 'translation')

    expect(instance.t('settings.appearance.title')).toBe('外观')
  })

  it('falls back to navigator languages when locale IPC fails', async () => {
    const api = {
      getLocaleState: async () => {
        throw new Error('preload unavailable')
      },
    }

    await expect(resolveInitialLocaleState(api, ['zh-Hans-CN', 'en-US'])).resolves.toEqual({
      preference: 'system',
      locale: 'zh-CN',
    })
    await expect(resolveInitialLocaleState(undefined, ['en-GB'])).resolves.toEqual({
      preference: 'system',
      locale: 'en',
    })
  })

  it('normalizes a malformed persisted state at the renderer boundary', async () => {
    const api = {
      getLocaleState: async () => ({ preference: 'invalid', locale: 'fr' }) as never,
    }

    await expect(resolveInitialLocaleState(api, ['en-US'])).resolves.toEqual({
      preference: 'system',
      locale: 'en',
    })
  })

  it('sets document language metadata before the interface is shown', () => {
    const root = { lang: '', dir: '' }

    applyDocumentLocale('zh-CN', root)
    expect(root).toEqual({ lang: 'zh-CN', dir: 'ltr' })

    applyDocumentLocale('en', root)
    expect(root).toEqual({ lang: 'en', dir: 'ltr' })
  })

  it('keeps only the latest asynchronous preference request authoritative', () => {
    const guard = createLatestRequestGuard()
    const first = guard.begin()
    const second = guard.begin()

    expect(guard.isLatest(first)).toBe(false)
    expect(guard.isLatest(second)).toBe(true)
  })

  it('routes the first migrated renderer surfaces through translation resources', () => {
    const sources = [
      'src/renderer/src/components/AppearanceSettings.tsx',
      'src/renderer/src/components/SettingsPanel.tsx',
      'src/renderer/src/components/OnboardingOverlay.tsx',
    ].map(path => readFileSync(resolve(path), 'utf8')).join('\n')

    expect(sources).toContain("t('settings.language.title')")
    expect(sources).toContain("t('settings.appearance.title')")
    expect(sources).toContain("t('settings.title')")
    expect(sources).toContain("t('onboarding.welcomeTitle')")
  })
})

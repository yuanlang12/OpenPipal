import { createInstance, type i18n } from 'i18next'
import { initReactI18next } from 'react-i18next'
import {
  normalizeLocalePreference,
  resolveLocale,
  resolveSystemLocale,
  SUPPORTED_LOCALES,
  type LocaleState,
  type SupportedLocale,
} from '../../../shared/i18n/contract'
import {
  APP_I18N_RESOURCES,
  FALLBACK_LOCALE,
} from '../../../shared/i18n/resources'

export const RENDERER_I18N_RESOURCES = {
  'zh-CN': { translation: APP_I18N_RESOURCES['zh-CN'] },
  en: { translation: APP_I18N_RESOURCES.en },
} as const

export const rendererI18n: i18n = createInstance()

interface LocaleStateApi {
  getLocaleState?: () => Promise<LocaleState>
}

export interface LatestRequestGuard {
  begin: () => number
  isLatest: (requestId: number) => boolean
}

/**
 * Small request guard used by the locale picker. Locale changes are persisted
 * through IPC, so two quick selections can resolve out of order even though
 * the user's final selection must always win.
 */
export function createLatestRequestGuard(): LatestRequestGuard {
  let latestRequestId = 0
  return {
    begin: () => {
      latestRequestId += 1
      return latestRequestId
    },
    isLatest: (requestId) => requestId === latestRequestId,
  }
}

function isSupportedLocale(value: unknown): value is SupportedLocale {
  return SUPPORTED_LOCALES.some(locale => locale === value)
}

export function getBrowserPreferredLanguages(): readonly string[] {
  if (typeof navigator === 'undefined') return []
  if (navigator.languages?.length) return navigator.languages
  return navigator.language ? [navigator.language] : []
}

/**
 * Electron is authoritative when available. Browser/dev fallbacks deliberately
 * reuse the shared resolver so startup never invents a second locale policy.
 */
export async function resolveInitialLocaleState(
  api: LocaleStateApi | undefined,
  preferredSystemLanguages: readonly string[] = getBrowserPreferredLanguages()
): Promise<LocaleState> {
  try {
    const received = await api?.getLocaleState?.()
    if (received) {
      const preference = normalizeLocalePreference(received.preference)
      return {
        preference,
        locale: isSupportedLocale(received.locale)
          ? received.locale
          : resolveLocale(preference, preferredSystemLanguages),
      }
    }
  } catch {
    // The renderer can still start when preload IPC is unavailable or fails.
  }

  return {
    preference: 'system',
    locale: resolveSystemLocale(preferredSystemLanguages),
  }
}

export async function initializeI18nInstance(
  instance: i18n,
  locale: SupportedLocale
): Promise<i18n> {
  if (!instance.isInitialized) {
    await instance.use(initReactI18next).init({
      resources: RENDERER_I18N_RESOURCES,
      lng: locale,
      fallbackLng: FALLBACK_LOCALE,
      supportedLngs: [...SUPPORTED_LOCALES],
      interpolation: { escapeValue: false },
      react: { useSuspense: false },
      returnNull: false,
    })
  } else if (instance.resolvedLanguage !== locale) {
    await instance.changeLanguage(locale)
  }
  return instance
}

export async function createRendererI18n(locale: SupportedLocale): Promise<i18n> {
  return initializeI18nInstance(createInstance(), locale)
}

type DocumentLocaleRoot = Pick<HTMLElement, 'lang' | 'dir'>

export function applyDocumentLocale(
  locale: SupportedLocale,
  root: DocumentLocaleRoot = document.documentElement
): void {
  root.lang = locale
  root.dir = rendererI18n.dir(locale)
}

export async function setRendererLocale(locale: SupportedLocale): Promise<void> {
  await initializeI18nInstance(rendererI18n, locale)
  applyDocumentLocale(locale)
}

export async function initializeRendererI18n(locale: SupportedLocale): Promise<i18n> {
  await setRendererLocale(locale)
  return rendererI18n
}

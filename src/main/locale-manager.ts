import { app } from 'electron'
import {
  normalizeLocalePreference,
  resolveLocale,
  type LocalePreference,
  type LocaleState
} from '../shared/i18n/contract'
import {
  getLocalePreference as getSavedLocalePreference,
  setLocalePreference as saveLocalePreference
} from './config-manager'

type LocaleChangeListener = (state: LocaleState) => void
const localeChangeListeners = new Set<LocaleChangeListener>()
let lastState: LocaleState | null = null

function getPreferredSystemLanguages(): readonly string[] {
  try {
    return app.getPreferredSystemLanguages()
  } catch {
    // Electron may reject app locale reads before ready in unusual test/startup paths.
    // The shared resolver intentionally treats an empty list as English.
    return []
  }
}

function toLocaleState(
  preference: LocalePreference,
  preferredSystemLanguages?: readonly string[]
): LocaleState {
  return {
    preference,
    locale: preference === 'system'
      ? resolveLocale(preference, preferredSystemLanguages ?? getPreferredSystemLanguages())
      : preference
  }
}

function notifyLocaleChanged(state: LocaleState): void {
  for (const listener of Array.from(localeChangeListeners)) {
    try {
      listener(state)
    } catch (error) {
      console.warn('[Locale] change listener failed:', error)
    }
  }
}

function statesEqual(left: LocaleState | null, right: LocaleState): boolean {
  return !!left && left.preference === right.preference && left.locale === right.locale
}

/**
 * Re-read Electron's preferred languages when the saved preference follows
 * the system. Updating lastState before notifying makes listener re-entry (for
 * example a locale GET during a focus event) idempotent.
 */
export function refreshSystemLocale(
  preferredSystemLanguages?: readonly string[]
): LocaleState {
  const state = toLocaleState(getSavedLocalePreference(), preferredSystemLanguages)
  const previous = lastState
  lastState = state
  if (state.preference === 'system' && previous && !statesEqual(previous, state)) {
    notifyLocaleChanged(state)
  }
  return state
}

export function getLocaleState(preferredSystemLanguages?: readonly string[]): LocaleState {
  return refreshSystemLocale(preferredSystemLanguages)
}

export function updateLocalePreference(
  preference: unknown,
  preferredSystemLanguages?: readonly string[]
): LocaleState {
  const previous = toLocaleState(getSavedLocalePreference(), preferredSystemLanguages)
  const normalized = normalizeLocalePreference(preference)
  saveLocalePreference(normalized)
  const state = toLocaleState(normalized, preferredSystemLanguages)
  lastState = state
  if (state.preference !== previous.preference || state.locale !== previous.locale) {
    notifyLocaleChanged(state)
  }
  return state
}

export function onLocaleChanged(listener: LocaleChangeListener): () => void {
  localeChangeListeners.add(listener)
  return () => localeChangeListeners.delete(listener)
}

export type { LocalePreference, LocaleState }

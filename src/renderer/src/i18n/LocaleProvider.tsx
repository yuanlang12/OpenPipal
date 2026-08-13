import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { I18nextProvider } from 'react-i18next'
import {
  resolveLocale,
  type LocalePreference,
  type LocaleState,
} from '../../../shared/i18n/contract'
import {
  applyDocumentLocale,
  createLatestRequestGuard,
  getBrowserPreferredLanguages,
  rendererI18n,
} from './index'

interface LocaleContextValue extends LocaleState {
  pendingPreference: LocalePreference | null
  setLocalePreference: (preference: LocalePreference) => Promise<void>
}

const LocaleContext = createContext<LocaleContextValue | null>(null)

interface LocaleProviderProps {
  initialState: LocaleState
  children: ReactNode
}

export function LocaleProvider({ initialState, children }: LocaleProviderProps): JSX.Element {
  const [localeState, setLocaleState] = useState(initialState)
  const [pendingPreference, setPendingPreference] = useState<LocalePreference | null>(null)
  const mountedRef = useRef(true)
  const desiredPreferenceRef = useRef<LocalePreference | null>(null)
  const requestGuardRef = useRef(createLatestRequestGuard())
  const refreshGuardRef = useRef(createLatestRequestGuard())
  const applySequenceRef = useRef(0)
  const applyQueueRef = useRef<Promise<void>>(Promise.resolve())

  const scheduleLocaleState = useCallback((nextState: LocaleState): Promise<void> => {
    const sequence = ++applySequenceRef.current
    const task = applyQueueRef.current
      .catch(() => undefined)
      .then(async () => {
        if (sequence !== applySequenceRef.current) return
        await rendererI18n.changeLanguage(nextState.locale)
        if (sequence !== applySequenceRef.current || !mountedRef.current) return
        applyDocumentLocale(nextState.locale)
        setLocaleState(nextState)
      })

    applyQueueRef.current = task
    return task
  }, [])

  const setLocalePreference = useCallback(async (preference: LocalePreference): Promise<void> => {
    const requestId = requestGuardRef.current.begin()
    refreshGuardRef.current.begin()
    desiredPreferenceRef.current = preference
    setPendingPreference(preference)

    try {
      const api = window.api as typeof window.api & {
        setLocalePreference?: (value: LocalePreference) => Promise<LocaleState>
      }
      const nextState = typeof api.setLocalePreference === 'function'
        ? await api.setLocalePreference(preference)
        : {
            preference,
            locale: resolveLocale(preference, getBrowserPreferredLanguages()),
          }

      if (!requestGuardRef.current.isLatest(requestId)) return
      refreshGuardRef.current.begin()
      await scheduleLocaleState(nextState)
    } catch {
      // Keep the last confirmed locale when persistence fails. The picker is
      // released below so the user can retry without reloading the app.
    } finally {
      if (requestGuardRef.current.isLatest(requestId) && mountedRef.current) {
        desiredPreferenceRef.current = null
        setPendingPreference(null)
      }
    }
  }, [scheduleLocaleState])

  const refreshLocaleState = useCallback(async (): Promise<void> => {
    const api = window.api as typeof window.api & {
      getLocaleState?: () => Promise<LocaleState>
    }
    if (typeof api.getLocaleState !== 'function') return

    const requestId = refreshGuardRef.current.begin()
    try {
      const nextState = await api.getLocaleState()
      const desiredPreference = desiredPreferenceRef.current
      if (!refreshGuardRef.current.isLatest(requestId)) return
      if (desiredPreference && nextState.preference !== desiredPreference) return
      await scheduleLocaleState(nextState)
    } catch {
      // A focus refresh is best-effort; the last confirmed locale stays active.
    }
  }, [scheduleLocaleState])

  useEffect(() => {
    mountedRef.current = true
    const api = window.api as typeof window.api & {
      onLocaleChanged?: (callback: (state: LocaleState) => void) => () => void
    }
    const unsubscribe = typeof api.onLocaleChanged === 'function'
      ? api.onLocaleChanged((nextState) => {
          const desiredPreference = desiredPreferenceRef.current
          if (desiredPreference && nextState.preference !== desiredPreference) return
          void scheduleLocaleState(nextState)
        })
      : undefined

    const handleFocus = (): void => {
      void refreshLocaleState()
    }
    const handleVisibilityChange = (): void => {
      if (document.visibilityState === 'visible') void refreshLocaleState()
    }
    window.addEventListener('focus', handleFocus)
    document.addEventListener('visibilitychange', handleVisibilityChange)

    return () => {
      mountedRef.current = false
      unsubscribe?.()
      window.removeEventListener('focus', handleFocus)
      document.removeEventListener('visibilitychange', handleVisibilityChange)
    }
  }, [refreshLocaleState, scheduleLocaleState])

  const value = useMemo<LocaleContextValue>(() => ({
    ...localeState,
    pendingPreference,
    setLocalePreference,
  }), [localeState, pendingPreference, setLocalePreference])

  return (
    <I18nextProvider i18n={rendererI18n}>
      <LocaleContext.Provider value={value}>{children}</LocaleContext.Provider>
    </I18nextProvider>
  )
}

export function useLocale(): LocaleContextValue {
  const value = useContext(LocaleContext)
  if (!value) throw new Error('useLocale must be used within LocaleProvider')
  return value
}

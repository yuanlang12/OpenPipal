import { useState, useEffect, useRef } from 'react'
import { useAppStore, ThemeMode } from '../stores/appStore'
import { useTranslation } from 'react-i18next'
import type { AppSettingsState } from '../../../shared/app-following-contract'

const THEME_OPTIONS: { value: ThemeMode; labelKey: string }[] = [
  { value: 'system', labelKey: 'settings.apps.theme.system' },
  { value: 'light', labelKey: 'settings.apps.theme.light' },
  { value: 'dark', labelKey: 'settings.apps.theme.dark' },
]

export function AppSettings() {
  const { t } = useTranslation()
  const { theme, setTheme } = useAppStore()
  const [followingEnabled, setFollowingEnabled] = useState(true)
  const [detected, setDetected] = useState<string[]>([])
  const [disabled, setDisabled] = useState<string[]>([])
  const [browsers, setBrowsers] = useState<string[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [followingError, setFollowingError] = useState<'load' | 'save' | null>(null)
  const [workingDir, setWorkingDirState] = useState<string>('')
  const settingsEpoch = useRef(0)

  useEffect(() => {
    const epoch = ++settingsEpoch.current
    setLoading(true)
    setFollowingError(null)
    window.api.getAppSettings()
      .then((data: AppSettingsState) => {
        if (settingsEpoch.current !== epoch) return
        setFollowingEnabled(data.enabled)
        setDetected(data.detected)
        setDisabled(data.disabled)
        setBrowsers(data.browsers)
      })
      .catch(() => {
        if (settingsEpoch.current === epoch) setFollowingError('load')
      })
      .finally(() => {
        if (settingsEpoch.current === epoch) setLoading(false)
      })
    window.api.getWorkingDir?.().then((dir: string) => setWorkingDirState(dir)).catch(() => {})
    return () => {
      // Invalidate both the initial load and any later save that may still be
      // settling. A save owns a newer epoch, so conditioning this on the load
      // epoch would let its completion update an already-unmounted component.
      settingsEpoch.current += 1
    }
  }, [])

  const handleSelectDir = async () => {
    const dir = await window.api.selectDirectory?.()
    if (dir) {
      setWorkingDirState(dir)
      await window.api.setWorkingDir?.(dir)
    }
  }

  const toggleApp = async (app: string) => {
    if (loading || saving) return
    const previousDisabled = disabled
    const newDisabled = disabled.includes(app)
      ? disabled.filter(a => a !== app)
      : [...disabled, app]
    const epoch = ++settingsEpoch.current
    setDisabled(newDisabled)
    setFollowingError(null)
    setSaving(true)
    try {
      await window.api.setDisabledApps(newDisabled)
    } catch {
      if (settingsEpoch.current === epoch) {
        setDisabled(previousDisabled)
        setFollowingError('save')
      }
    } finally {
      if (settingsEpoch.current === epoch) setSaving(false)
    }
  }

  const toggleFollowing = async () => {
    if (loading || saving) return
    const previousEnabled = followingEnabled
    const nextEnabled = !followingEnabled
    const epoch = ++settingsEpoch.current
    setFollowingEnabled(nextEnabled)
    setFollowingError(null)
    setSaving(true)
    try {
      await window.api.setAppFollowingEnabled(nextEnabled)
    } catch {
      if (settingsEpoch.current === epoch) {
        setFollowingEnabled(previousEnabled)
        setFollowingError('save')
      }
    } finally {
      if (settingsEpoch.current === epoch) setSaving(false)
    }
  }

  const normalApps = detected.filter(a => !browsers.includes(a))

  return (
    <div className="space-y-5">
      {/* 主题 */}
      <div>
        <h3 className="text-xs font-medium text-surface-400 uppercase tracking-wider mb-2">{t('settings.apps.appearance')}</h3>
        <div className="flex gap-1.5" data-testid="theme-switcher">
          {THEME_OPTIONS.map(opt => (
            <button
              key={opt.value}
              onClick={() => setTheme(opt.value)}
              className={`flex-1 text-[12px] py-1.5 rounded-lg border transition-colors ${
                theme === opt.value
                  ? 'bg-brand-50 dark:bg-brand-900/30 text-brand-700 dark:text-brand-300 border-brand-200 dark:border-brand-700'
                  : 'bg-surface-50 text-surface-500 border-surface-100 hover:border-surface-200'
              }`}
            >
              {t(opt.labelKey)}
            </button>
          ))}
        </div>
      </div>

      {/* 工作目录 */}
      <div>
        <h3 className="text-xs font-medium text-surface-400 uppercase tracking-wider mb-2">{t('settings.apps.workingDirectory.title')}</h3>
        <p className="text-[11px] text-surface-400 mb-2">{t('settings.apps.workingDirectory.description')}</p>
        <div className="flex items-center gap-2">
          <div className="flex-1 text-[12px] text-surface-600 bg-surface-50 px-2.5 py-1.5 rounded-lg border border-surface-100 truncate">
            {workingDir || '~/Documents'}
          </div>
          <button
            onClick={handleSelectDir}
            className="text-[12px] px-3 py-1.5 rounded-lg border border-surface-100 text-surface-500 hover:text-surface-700 hover:border-surface-200 transition-colors"
          >
            {t('settings.apps.workingDirectory.choose')}
          </button>
        </div>
      </div>

      {/* 应用跟随 */}
      <div>
        <h3 className="text-xs font-medium text-surface-400 uppercase tracking-wider mb-2">{t('settings.apps.following.title')}</h3>
        <p className="text-[11px] text-surface-400 mb-3">{t('settings.apps.following.description')}</p>
        <div className="flex items-center justify-between gap-3 py-2 px-2 mb-2 rounded-lg bg-surface-50">
          <div className="min-w-0">
            <p className="text-[13px] text-surface-700">{t('settings.apps.following.master.title')}</p>
            <p className="text-[11px] text-surface-400 break-words">{t(`settings.apps.following.master.${followingEnabled ? 'on' : 'off'}`)}</p>
          </div>
          <button
            type="button"
            onClick={toggleFollowing}
            disabled={loading || saving}
            aria-label={t('settings.apps.following.master.toggleAria')}
            aria-pressed={followingEnabled}
            data-testid="app-following-master-toggle"
            className={`w-9 h-5 shrink-0 rounded-full transition-colors relative disabled:cursor-not-allowed disabled:opacity-50 ${
              followingEnabled ? 'bg-brand-500' : 'bg-surface-200'
            }`}
          >
            <div className={`w-4 h-4 bg-white rounded-full shadow-sm absolute top-0.5 transition-transform ${
              followingEnabled ? 'left-[18px]' : 'left-0.5'
            }`} />
          </button>
        </div>
        {normalApps.length === 0 ? (
          <p className="text-xs text-surface-300 py-2">{t('settings.apps.following.empty')}</p>
        ) : (
          <div className="space-y-1">
            {normalApps.map(app => (
              <div key={app} className="flex items-center justify-between py-1.5 px-2 rounded-lg hover:bg-surface-50">
                <span className="text-[13px] text-surface-700 min-w-0 break-words">{app}</span>
                <button
                  onClick={() => toggleApp(app)}
                  disabled={loading || !followingEnabled || saving}
                  aria-label={t('settings.apps.following.toggleAria', { app })}
                  aria-pressed={!disabled.includes(app)}
                  className={`w-9 h-5 rounded-full transition-colors relative disabled:cursor-not-allowed disabled:opacity-50 ${
                    disabled.includes(app) ? 'bg-surface-200' : 'bg-brand-500'
                  }`}
                >
                  <div className={`w-4 h-4 bg-white rounded-full shadow-sm absolute top-0.5 transition-transform ${
                    disabled.includes(app) ? 'left-0.5' : 'left-[18px]'
                  }`} />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {followingError && (
        <p role="alert" className="text-[11px] text-red-500 break-words">
          {t(`settings.apps.following.errors.${followingError}`)}
        </p>
      )}

      {/* 浏览器 */}
      {browsers.length > 0 && (
        <div>
          <h3 className="text-xs font-medium text-surface-400 uppercase tracking-wider mb-2">{t('settings.apps.browsers.title')}</h3>
          <p className="text-[11px] text-surface-400 mb-2">{t('settings.apps.browsers.description')}</p>
          <div className="flex flex-wrap gap-1.5">
            {browsers.map(b => (
              <span key={b} className="text-[11px] px-2 py-0.5 rounded-full bg-surface-50 text-surface-400 border border-surface-100">
                {b}
              </span>
            ))}
          </div>
        </div>
      )}

      {(loading || saving) && (
        <p className="text-[10px] text-surface-300">
          {t(loading ? 'settings.apps.loading' : 'settings.apps.saving')}
        </p>
      )}
    </div>
  )
}

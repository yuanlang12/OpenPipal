import { useEffect, useState } from 'react'
import { Sparkles, KeyRound, Camera, Globe, ArrowRight, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useAppStore } from '../stores/appStore'

interface OnboardingApi {
  getOnboardingStatus?: () => Promise<{ completed: boolean }>
  completeOnboarding?: () => Promise<{ ok: boolean }>
  openScreenRecordingPrefs?: () => Promise<{ ok: boolean }>
}

function getOnboardingApi(): typeof window.api & OnboardingApi {
  return window.api as typeof window.api & OnboardingApi
}

/**
 * OnboardingOverlay — 首次启动引导
 *
 * 触发: `~/.openpipal/config.json` 中 onboardingCompleted !== true
 * 完成/跳过: 写入 true,后续启动不再展示
 *
 * 内容(三段):
 *   ① 配模型 → 一键打开 Settings
 *   ② 屏录权限 → 一键打开 macOS 系统设置
 *   ③ 浏览器扩展(说明)
 */
export function OnboardingOverlay(): JSX.Element | null {
  const { t } = useTranslation()
  const [visible, setVisible] = useState(false)
  const setActiveView = useAppStore(s => s.setActiveView)

  useEffect(() => {
    let cancelled = false
    getOnboardingApi().getOnboardingStatus?.().then((res) => {
      if (!cancelled && !res?.completed) setVisible(true)
    })
    return () => { cancelled = true }
  }, [])

  if (!visible) return null

  const finish = async (): Promise<void> => {
    await getOnboardingApi().completeOnboarding?.()
    setVisible(false)
  }

  const openSettings = (): void => {
    setActiveView('settings')
    void finish()
  }

  const openScreenPrefs = async (): Promise<void> => {
    await getOnboardingApi().openScreenRecordingPrefs?.()
  }

  return (
    <div className="absolute inset-0 z-[60] bg-black/40 dark:bg-black/60 flex items-center justify-center p-6 animate-fade-in" onClick={() => void finish()}>
      <div
        className="w-full max-w-md max-h-[85vh] overflow-y-auto bg-surface-0 dark:bg-surface-50 rounded-2xl shadow-2xl border border-surface-100"
        onClick={e => e.stopPropagation()}
      >
        <div className="px-6 pt-6 pb-2 flex items-start justify-between">
          <div className="flex items-center gap-2.5">
            <div className="w-9 h-9 rounded-xl bg-brand-50 dark:bg-brand-900/30 flex items-center justify-center">
              <Sparkles className="w-5 h-5 text-brand-600 dark:text-brand-400" />
            </div>
            <div>
              <h2 className="text-[15px] font-semibold text-surface-800">
                {t('onboarding.welcomeTitle')}
              </h2>
              <p className="text-[11px] text-surface-500 mt-0.5">
                {t('onboarding.subtitle')}
              </p>
            </div>
          </div>
          <button
            onClick={() => void finish()}
            className="text-surface-400 hover:text-surface-600 transition-colors"
            aria-label={t('onboarding.skipAriaLabel')}
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="px-6 py-3 space-y-2.5">
          <Step
            icon={<KeyRound className="w-4 h-4 text-brand-600 dark:text-brand-400" />}
            title={t('onboarding.steps.model.title')}
            desc={t('onboarding.steps.model.description')}
            cta={t('onboarding.steps.model.action')}
            onClick={openSettings}
          />
          <Step
            icon={<Camera className="w-4 h-4 text-brand-600 dark:text-brand-400" />}
            title={t('onboarding.steps.screenRecording.title')}
            desc={t('onboarding.steps.screenRecording.description')}
            cta={t('onboarding.steps.screenRecording.action')}
            onClick={() => void openScreenPrefs()}
          />
          <Step
            icon={<Globe className="w-4 h-4 text-brand-600 dark:text-brand-400" />}
            title={t('onboarding.steps.browserExtension.title')}
            desc={t('onboarding.steps.browserExtension.description')}
          />
        </div>

        <div className="px-6 py-4 border-t border-surface-100 flex items-center justify-between gap-3">
          <button
            onClick={() => void finish()}
            className="text-[12px] text-surface-500 hover:text-surface-700 transition-colors"
          >
            {t('onboarding.actions.skip')}
          </button>
          <button
            onClick={() => void finish()}
            className="px-4 py-1.5 bg-brand-500 hover:bg-brand-600 text-ink-on-accent text-[12px] font-medium rounded-md transition-colors flex items-center gap-1.5"
          >
            {t('onboarding.actions.start')}
            <ArrowRight className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>
    </div>
  )
}

interface StepProps {
  icon: JSX.Element
  title: string
  desc: string
  cta?: string
  onClick?: () => void
}

function Step({ icon, title, desc, cta, onClick }: StepProps): JSX.Element {
  return (
    <div className="border border-surface-100 rounded-lg p-3">
      <div className="flex items-center gap-2 mb-1.5">
        {icon}
        <h3 className="text-[12.5px] font-medium text-surface-800">{title}</h3>
      </div>
      <p className="text-[11.5px] text-surface-500 leading-relaxed mb-2">{desc}</p>
      {cta && onClick && (
        <button
          onClick={onClick}
          className="text-[11.5px] text-brand-600 dark:text-brand-400 hover:text-brand-700 dark:hover:text-brand-300 font-medium flex items-center gap-1 transition-colors"
        >
          {cta}
          <ArrowRight className="w-3 h-3" />
        </button>
      )}
    </div>
  )
}

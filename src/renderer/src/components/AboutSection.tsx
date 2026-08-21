import { useEffect, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { OpenPipalLogo } from './shared/OpenPipalLogo'
import type { UpdateCheckResult } from '../../../shared/update-contract'

/** 全部写死在渲染层：远端数据永远变不成一个能点的地址 */
const WEBSITE_URL = 'https://openpipal.com'
const REPO_URL = 'https://github.com/yuanlang12/OpenPipal'
const RELEASES_URL = `${REPO_URL}/releases/latest`
const ISSUES_URL = `${REPO_URL}/issues`

const LINK_CLASS =
  'text-[11px] text-brand-500 hover:text-brand-600 dark:hover:text-brand-400 transition-colors'

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 py-1.5">
      <span className="text-[11px] text-surface-400 shrink-0">{label}</span>
      <span className="text-[11px] text-right min-w-0 break-words">{children}</span>
    </div>
  )
}

/**
 * GitHub 标识内联在这里，不走 lucide —— lucide 1.x 已经把品牌图标全部移除
 * （品牌标识归各自所有者，通用图标库不该代持）。用作"跳转到 GitHub"的链接
 * 符合 GitHub 自己的品牌指引。
 */
function GithubMark({ size = 14 }: { size?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="currentColor" aria-hidden="true">
      <path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12" />
    </svg>
  )
}

function ExternalLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className={LINK_CLASS} onClick={e => e.stopPropagation()}>
      {children}
    </a>
  )
}

export function AboutSection() {
  const { t } = useTranslation()
  const [update, setUpdate] = useState<UpdateCheckResult | 'checking'>('checking')

  // 只在这个面板挂载时查一次。放启动路径上就成了每次开机对外报到，
  // 而打开「关于」是个明确的"告诉我这个应用的情况"的动作。
  useEffect(() => {
    let cancelled = false
    window.api
      .checkForUpdate?.()
      .then((result: UpdateCheckResult | undefined) => {
        if (!cancelled) setUpdate(result ?? { status: 'unavailable' })
      })
      .catch(() => { if (!cancelled) setUpdate({ status: 'unavailable' }) })
    return () => { cancelled = true }
  }, [])

  return (
    <div className="max-w-sm mx-auto">
      <div className="flex flex-col items-center gap-2.5 py-6">
        <OpenPipalLogo variant="mark" size={48} />
        <OpenPipalLogo variant="wordmark" size={34} />
        <span className="text-[11px] text-surface-400">{__APP_VERSION__}</span>
      </div>

      <div className="border-t border-surface-100 pt-2">
        {/* 查不到时也把这行留着：整行消失的话，用户没法判断是"已是最新"还是"根本没这功能" */}
        <Row label={t('settings.about.update.label')}>
          {update === 'checking' ? (
            <span className="text-surface-400">{t('settings.about.update.checking')}</span>
          ) : update.status === 'update-available' ? (
            <ExternalLink href={RELEASES_URL}>
              {t('settings.about.update.available', { version: update.latest })}
            </ExternalLink>
          ) : update.status === 'up-to-date' ? (
            <span className="text-surface-500">{t('settings.about.update.upToDate')}</span>
          ) : (
            <span className="text-surface-400">{t('settings.about.update.unavailable')}</span>
          )}
        </Row>

        <Row label={t('settings.about.website')}>
          <ExternalLink href={WEBSITE_URL}>openpipal.com</ExternalLink>
        </Row>

        <Row label={t('settings.about.repository')}>
          <a
            href={REPO_URL}
            target="_blank"
            rel="noopener noreferrer"
            title="yuanlang12/OpenPipal"
            aria-label={t('settings.about.repository')}
            className="inline-flex text-surface-400 hover:text-brand-500 dark:hover:text-brand-400 transition-colors"
            onClick={e => e.stopPropagation()}
          >
            <GithubMark />
          </a>
        </Row>

        <Row label={t('settings.about.feedback')}>
          <ExternalLink href={ISSUES_URL}>{t('settings.about.submitIssue')}</ExternalLink>
        </Row>

        {/* 引导只在首启自动弹,重看入口收在「关于」——它讲的是产品本身 */}
        <Row label={t('onboarding.replay.title')}>
          <button
            data-testid="onboarding-replay"
            onClick={() => window.dispatchEvent(new CustomEvent('openpipal:show-onboarding'))}
            className={LINK_CLASS}
          >
            {t('onboarding.replay.button')}
          </button>
        </Row>
      </div>
    </div>
  )
}

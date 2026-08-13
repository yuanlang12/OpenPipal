import type { SupportedLocale } from '../../../shared/i18n/contract'

/** Last-resort copy used even when i18next itself cannot initialize. */
export function fatalStartupText(locale: SupportedLocale): string {
  return locale === 'zh-CN'
    ? 'OpenPipal 启动失败，请重启应用。'
    : 'OpenPipal failed to start. Please restart the app.'
}

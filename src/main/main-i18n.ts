import { createInstance, type i18n, type TOptions } from 'i18next'
import type { SupportedLocale } from '../shared/i18n/contract'
import {
  APP_I18N_RESOURCES,
  FALLBACK_LOCALE
} from '../shared/i18n/resources'

let instance: i18n | null = null

function resources() {
  return {
    'zh-CN': { translation: APP_I18N_RESOURCES['zh-CN'] },
    en: { translation: APP_I18N_RESOURCES.en }
  }
}

/** Initialize the small Main-process catalogue before creating native UI. */
export async function initializeMainI18n(locale: SupportedLocale): Promise<void> {
  const next = createInstance()
  await next.init({
    lng: locale,
    fallbackLng: FALLBACK_LOCALE,
    supportedLngs: ['zh-CN', 'en'],
    resources: resources(),
    interpolation: { escapeValue: false },
    returnNull: false,
    returnEmptyString: false,
    initAsync: false
  })
  instance = next
}

export async function changeMainLocale(locale: SupportedLocale): Promise<void> {
  if (!instance) {
    await initializeMainI18n(locale)
    return
  }
  await instance.changeLanguage(locale)
}

export function tMain(key: string, options?: TOptions): string {
  if (!instance) {
    const fallback = key.split('.').reduce<unknown>((value, segment) => {
      if (!value || typeof value !== 'object') return undefined
      return (value as Record<string, unknown>)[segment]
    }, APP_I18N_RESOURCES[FALLBACK_LOCALE])
    if (typeof fallback !== 'string') return key
    return fallback.replace(/{{\s*([^}\s]+)\s*}}/g, (placeholder, name: string) => {
      const value = options?.[name as keyof TOptions]
      return value === undefined || value === null ? placeholder : String(value)
    })
  }
  return String(instance.t(key, options))
}

/**
 * IPC 失败结果的本地化载荷。
 *
 * 契约（与 config-manager.testConnection 的 errorKey 同源）：
 * - `errorKey`/`errorParams` —— 本进程自造的文案，renderer 用当前 UI 语言重新渲染；
 * - `error` —— 同一句话在 Main 侧的即时渲染，供日志与旧 renderer 兜底。
 *
 * 外部文本（网关响应、OS/stderr、第三方 message）永远走 `errorParams.detail`
 * 原样透传，不翻译——不能篡改证据。
 */
export interface MainErrorPayload {
  error: string
  errorKey: string
  errorParams?: Record<string, string | number>
}

export function mainError(
  errorKey: string,
  errorParams?: Record<string, string | number>
): MainErrorPayload {
  return { error: tMain(errorKey, errorParams), errorKey, errorParams }
}

/**
 * 失败结果的通用形状：`error` 必有，`errorKey` 只在本进程自造文案时出现。
 *
 * 用在同一个返回点既可能是自造文案、又可能是外部文本（服务端 message、
 * WebSocket err.message）的地方——有外部文本就原样透传、不带 key，
 * renderer 便不会用译文把证据盖掉。
 */
export type MainFailure = { error: string } & Partial<Omit<MainErrorPayload, 'error'>>

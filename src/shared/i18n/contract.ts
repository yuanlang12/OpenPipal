export const SUPPORTED_LOCALES = ['zh-CN', 'en'] as const

export type SupportedLocale = (typeof SUPPORTED_LOCALES)[number]
export type LocalePreference = 'system' | SupportedLocale

export interface LocaleState {
  /** 用户保存的语言偏好；system 表示跟随操作系统。 */
  preference: LocalePreference
  /** 当前实际展示语言。 */
  locale: SupportedLocale
}

export function isLocalePreference(value: unknown): value is LocalePreference {
  return value === 'system' || value === 'zh-CN' || value === 'en'
}

/**
 * 配置文件来自持久化磁盘，可能包含旧版本或手工写入的值。语言偏好在边界处
 * 统一收窄，避免非法值流入 renderer 后产生各自不同的兜底行为。
 */
export function normalizeLocalePreference(value: unknown): LocalePreference {
  return isLocalePreference(value) ? value : 'system'
}

/**
 * Electron 按系统优先级返回语言列表。选择用户列表中第一个 OpenPipal
 * 支持的语言：中文统一为 zh-CN，英文统一为 en；全部不支持时回落 en。
 */
export function resolveSystemLocale(preferredSystemLanguages: readonly string[]): SupportedLocale {
  for (const language of preferredSystemLanguages) {
    const normalized = language.trim().toLowerCase()
    if (normalized === 'zh' || normalized.startsWith('zh-')) return 'zh-CN'
    if (normalized === 'en' || normalized.startsWith('en-')) return 'en'
  }
  return 'en'
}

export function resolveLocale(
  preference: LocalePreference,
  preferredSystemLanguages: readonly string[]
): SupportedLocale {
  return preference === 'system'
    ? resolveSystemLocale(preferredSystemLanguages)
    : preference
}

import { describe, expect, it } from 'vitest'
import {
  APP_I18N_RESOURCES,
  EN_MESSAGES,
  FALLBACK_LOCALE,
  ZH_CN_MESSAGES,
  type AppMessages,
} from '../../src/shared/i18n/resources'
import { SUPPORTED_LOCALES } from '../../src/shared/i18n/contract'

function flattenStrings(value: unknown, prefix = ''): Map<string, string> {
  if (typeof value === 'string') return new Map([[prefix, value]])
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`Expected an i18n object or string at "${prefix || '<root>'}"`)
  }

  const result = new Map<string, string>()
  for (const [key, child] of Object.entries(value)) {
    const path = prefix ? `${prefix}.${key}` : key
    for (const [leafPath, leaf] of flattenStrings(child, path)) result.set(leafPath, leaf)
  }
  return result
}

function interpolationTokens(value: string): string[] {
  return Array.from(value.matchAll(/{{\s*([\w.-]+)\s*}}/g), match => match[1]).sort()
}

describe('i18n resources', () => {
  it('has one catalogue for every supported locale and an explicit Chinese fallback', () => {
    expect(Object.keys(APP_I18N_RESOURCES).sort()).toEqual([...SUPPORTED_LOCALES].sort())
    expect(FALLBACK_LOCALE).toBe('zh-CN')
    expect(APP_I18N_RESOURCES[FALLBACK_LOCALE]).toBe(ZH_CN_MESSAGES)
  })

  it('keeps English and Chinese leaf keys exactly in sync', () => {
    const zh = flattenStrings(ZH_CN_MESSAGES)
    const en = flattenStrings(EN_MESSAGES)

    expect([...en.keys()].sort()).toEqual([...zh.keys()].sort())
  })

  it('contains only non-empty translated strings', () => {
    for (const locale of SUPPORTED_LOCALES) {
      for (const [key, value] of flattenStrings(APP_I18N_RESOURCES[locale])) {
        expect(value.trim(), `${locale}:${key}`).not.toBe('')
      }
    }
  })

  it('does not leave obvious untranslated Chinese in the English catalogue', () => {
    for (const [key, value] of flattenStrings(EN_MESSAGES)) {
      expect(value, key).not.toMatch(/[\u3400-\u9fff\uf900-\ufaff]/u)
    }
  })

  it('preserves interpolation variables across translations', () => {
    const zh = flattenStrings(ZH_CN_MESSAGES)
    const en = flattenStrings(EN_MESSAGES)

    for (const [key, zhValue] of zh) {
      expect(interpolationTokens(en.get(key) ?? ''), key).toEqual(interpolationTokens(zhValue))
    }
  })

  it('exposes a structural type suitable for runtime consumers', () => {
    const messages: AppMessages = APP_I18N_RESOURCES.en
    expect(messages.settings.language.options.system).toBe('Use system language')
  })
})

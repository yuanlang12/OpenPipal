import { describe, expect, it } from 'vitest'
import {
  normalizeLocalePreference,
  resolveLocale,
  resolveSystemLocale
} from '../../src/shared/i18n/contract'

describe('locale contract', () => {
  it.each([
    ['system', 'system'],
    ['zh-CN', 'zh-CN'],
    ['en', 'en'],
    [undefined, 'system'],
    [null, 'system'],
    ['zh-TW', 'system'],
    ['EN', 'system']
  ])('normalizes preference %j to %s', (input, expected) => {
    expect(normalizeLocalePreference(input)).toBe(expected)
  })

  it.each([
    [['zh-CN', 'en-US'], 'zh-CN'],
    [['zh-Hant-TW'], 'zh-CN'],
    [['ZH-hans'], 'zh-CN'],
    [['en-US', 'zh-CN'], 'en'],
    [['en'], 'en'],
    [['ja-JP', 'zh-CN'], 'zh-CN'],
    [['fr-FR', 'en-GB', 'zh-CN'], 'en'],
    [[], 'en']
  ])('resolves the first supported system language in %j to %s', (languages, expected) => {
    expect(resolveSystemLocale(languages)).toBe(expected)
  })

  it('keeps an explicit preference independent from system language', () => {
    expect(resolveLocale('zh-CN', ['en-US'])).toBe('zh-CN')
    expect(resolveLocale('en', ['zh-CN'])).toBe('en')
  })
})

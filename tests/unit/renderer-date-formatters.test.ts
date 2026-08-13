import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  formatByteSize,
  formatLocaleDate,
  formatLocaleDateTime,
  formatRecentTimestamp,
  formatRelativeTime,
  getCalendarTimeParts,
} from '../../src/renderer/src/i18n/formatters'

describe('renderer locale formatters', () => {
  it('formats dates and times with the active locale', () => {
    const date = new Date(2026, 7, 9, 14, 5)

    expect(formatLocaleDate(date, 'en', { month: 'short', day: 'numeric' }))
      .toBe(new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric' }).format(date))
    expect(formatLocaleDateTime(date, 'zh-CN'))
      .toBe(new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' }).format(date))
    expect(formatLocaleDate('not-a-date', 'en')).toBe('not-a-date')
  })

  it('classifies today and the previous local calendar day without 24-hour arithmetic', () => {
    const now = new Date(2026, 2, 9, 0, 30).getTime()
    const today = new Date(2026, 2, 9, 0, 10).getTime()
    const yesterday = new Date(2026, 2, 8, 23, 45).getTime()
    const earlier = new Date(2026, 2, 7, 23, 45).getTime()

    expect(getCalendarTimeParts(today, 'en', now).kind).toBe('today')
    expect(getCalendarTimeParts(yesterday, 'en', now).kind).toBe('yesterday')
    expect(getCalendarTimeParts(earlier, 'en', now).kind).toBe('earlier')
    expect(formatRecentTimestamp(yesterday, 'en', now))
      .toBe(new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric' }).format(yesterday))

    const source = readFileSync(resolve('src/renderer/src/i18n/formatters.ts'), 'utf8')
    expect(source).not.toMatch(/86_?400_?000|24\s*\*\s*60\s*\*\s*60\s*\*\s*1000/)
  })

  it('localizes relative time and byte-size numbers', () => {
    const now = new Date('2026-08-09T12:00:00Z').getTime()
    const timestamp = now - 2 * 60 * 60 * 1000

    expect(formatRelativeTime(timestamp, 'en', now))
      .toBe(new Intl.RelativeTimeFormat('en', { numeric: 'auto' }).format(-2, 'hour'))
    expect(formatRelativeTime(timestamp, 'zh-CN', now))
      .toBe(new Intl.RelativeTimeFormat('zh-CN', { numeric: 'auto' }).format(-2, 'hour'))
    expect(formatByteSize(1536, 'en')).toBe(`${new Intl.NumberFormat('en', { maximumFractionDigits: 1 }).format(1.5)} KB`)
  })
})

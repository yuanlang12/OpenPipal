export type CalendarTimeParts = {
  kind: 'today' | 'yesterday' | 'earlier'
  time: string
  dateTime: string
}

type DateInput = number | string | Date

function validDate(value: DateInput): Date | null {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value)
  return Number.isFinite(date.getTime()) ? date : null
}

function sameLocalDay(left: Date, right: Date): boolean {
  return left.getFullYear() === right.getFullYear()
    && left.getMonth() === right.getMonth()
    && left.getDate() === right.getDate()
}

export function formatLocaleDate(
  value: DateInput,
  locale: string,
  options: Intl.DateTimeFormatOptions = {}
): string {
  const date = validDate(value)
  if (!date) return typeof value === 'string' ? value : ''
  return new Intl.DateTimeFormat(locale, options).format(date)
}

export function getCalendarTimeParts(
  timestamp: number,
  locale: string,
  now: number = Date.now()
): CalendarTimeParts {
  const date = validDate(timestamp)
  const current = validDate(now)
  if (!date || !current) return { kind: 'earlier', time: '', dateTime: '' }

  const time = formatLocaleDate(date, locale, { hour: '2-digit', minute: '2-digit' })
  if (sameLocalDay(date, current)) return { kind: 'today', time, dateTime: time }

  // Construct the previous local calendar day instead of subtracting 24 hours,
  // which is wrong across daylight-saving transitions.
  const yesterday = new Date(current.getFullYear(), current.getMonth(), current.getDate() - 1)
  if (sameLocalDay(date, yesterday)) return { kind: 'yesterday', time, dateTime: time }

  return {
    kind: 'earlier',
    time,
    dateTime: formatLocaleDate(date, locale, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    }),
  }
}

export function formatRecentTimestamp(
  timestamp: number,
  locale: string,
  now: number = Date.now()
): string {
  const parts = getCalendarTimeParts(timestamp, locale, now)
  if (parts.kind === 'today') return parts.time
  return formatLocaleDate(timestamp, locale, { month: 'short', day: 'numeric' })
}

export function formatLocaleDateTime(value: DateInput, locale: string): string {
  return formatLocaleDate(value, locale, { dateStyle: 'medium', timeStyle: 'short' })
}

export function formatRelativeTime(
  timestamp: number,
  locale: string,
  now: number = Date.now()
): string {
  if (!Number.isFinite(timestamp) || !Number.isFinite(now)) return ''
  const elapsed = Math.max(0, now - timestamp)
  const minutes = Math.floor(elapsed / 60_000)
  const formatter = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' })
  if (minutes < 1) return formatter.format(0, 'second')
  if (minutes < 60) return formatter.format(-minutes, 'minute')
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return formatter.format(-hours, 'hour')
  const days = Math.floor(hours / 24)
  if (days < 7) return formatter.format(-days, 'day')
  if (days < 30) return formatter.format(-Math.floor(days / 7), 'week')
  return formatter.format(-Math.floor(days / 30), 'month')
}

export function formatByteSize(bytes: number, locale: string): string {
  const safeBytes = Number.isFinite(bytes) ? Math.max(0, bytes) : 0
  const formatter = new Intl.NumberFormat(locale, { maximumFractionDigits: 1 })
  if (safeBytes < 1024) return `${formatter.format(safeBytes)} B`
  if (safeBytes < 1024 * 1024) return `${formatter.format(safeBytes / 1024)} KB`
  return `${formatter.format(safeBytes / 1024 / 1024)} MB`
}

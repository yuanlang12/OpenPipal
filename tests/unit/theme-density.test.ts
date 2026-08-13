import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  CHAT_DENSITY_TOKENS,
  DEFAULT_THEME,
  parseThemeString,
  serializeTheme,
} from '../../src/renderer/src/lib/theme'

function asThemeString(value: unknown): string {
  return `openpipal-theme-v1:${JSON.stringify(value)}`
}

describe('theme chat density', () => {
  it('migrates existing v1 themes to the comfortable reading default', () => {
    const legacy = { ...DEFAULT_THEME }
    delete (legacy as Partial<typeof DEFAULT_THEME>).chatDensity

    expect(parseThemeString(asThemeString(legacy))?.chatDensity).toBe('comfortable')
  })

  it('keeps an explicitly selected density through export and import', () => {
    const theme = { ...DEFAULT_THEME, chatDensity: 'relaxed' as const }

    expect(parseThemeString(serializeTheme(theme))?.chatDensity).toBe('relaxed')
  })

  it('rejects an explicit invalid density instead of silently changing the preference', () => {
    const invalid = { ...DEFAULT_THEME, chatDensity: 'oversized' }

    expect(parseThemeString(asThemeString(invalid))).toBeNull()
  })

  it('keeps non-canvas content aligned with the 14 / 15 / 16px chat body choices', () => {
    expect(14 * CHAT_DENSITY_TOKENS.compact.contentScale).toBeCloseTo(14)
    expect(14 * CHAT_DENSITY_TOKENS.comfortable.contentScale).toBeCloseTo(15)
    expect(14 * CHAT_DENSITY_TOKENS.relaxed.contentScale).toBeCloseTo(16)
  })

  it('keeps UI tokens and legacy fixed-size utilities on the same scaling chain', () => {
    const tokensCss = readFileSync(resolve(process.cwd(), 'src/renderer/src/styles/tokens.css'), 'utf8')
    const globalCss = readFileSync(resolve(process.cwd(), 'src/renderer/src/styles/global.css'), 'utf8')

    expect(tokensCss).toContain('--sw-text-base:     calc(var(--sw-text-base-base) * var(--sw-ui-text-scale));')
    expect(globalCss).toContain('font-size: calc(16px * var(--sw-ui-zoom));')
    expect(globalCss).toContain(":root [class~='text-[8px]'] { font-size: calc(8px * var(--sw-ui-text-scale)); }")
    expect(globalCss).toContain(":root [class~='text-[12px]'] { font-size: calc(12px * var(--sw-ui-text-scale)); }")
    expect(globalCss).toContain(":root [class~='text-[34px]'] { font-size: calc(34px * var(--sw-ui-text-scale)); }")
  })
})

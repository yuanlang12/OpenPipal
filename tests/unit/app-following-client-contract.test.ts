import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  parseAppFollowingUpdateResult,
  parseAppListUpdateResult,
  parseAppSettingsState
} from '../../src/shared/app-following-contract'

describe('app-following client contract', () => {
  it('accepts only complete settings and matching successful mutations', () => {
    expect(parseAppSettingsState({
      enabled: false,
      detected: ['Notion'],
      disabled: ['Xcode'],
      browsers: ['Safari']
    })).toEqual({
      enabled: false,
      detected: ['Notion'],
      disabled: ['Xcode'],
      browsers: ['Safari'],
      // labels 是后加的：老服务端不带就是空表（Windows 上才会有 exe 名 → 显示名的条目）
      labels: {}
    })
    expect(() => parseAppSettingsState({ enabled: 'false', detected: [], disabled: [], browsers: [] }))
      .toThrow('response is invalid')
    expect(parseAppFollowingUpdateResult({ ok: true, enabled: false }, false))
      .toEqual({ ok: true, enabled: false })
    expect(() => parseAppFollowingUpdateResult({ ok: false, enabled: false }, false))
      .toThrow('response is invalid')
    expect(() => parseAppFollowingUpdateResult({ ok: true, enabled: true }, false))
      .toThrow('response is invalid')
    expect(parseAppListUpdateResult({ ok: true })).toEqual({ ok: true })
    expect(() => parseAppListUpdateResult({ ok: false })).toThrow('response is invalid')
  })

  it('guards initialization with loading and an epoch so an old GET cannot overwrite a user action', () => {
    const source = readFileSync(resolve('src/renderer/src/components/AppSettings.tsx'), 'utf8')

    expect(source).toContain('const [loading, setLoading] = useState(true)')
    expect(source).toContain('const epoch = ++settingsEpoch.current')
    expect(source).toContain('if (settingsEpoch.current !== epoch) return')
    expect(source).toContain('disabled={loading || saving}')
    expect(source).toContain('setFollowingEnabled(previousEnabled)')
    expect(source).toContain("setFollowingError('save')")
  })
})

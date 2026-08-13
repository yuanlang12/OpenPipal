import { describe, expect, it } from 'vitest'
import { changeMainLocale, initializeMainI18n, mainError } from '../../src/main/main-i18n'
import { renderDisplayError, toDisplayError } from '../../src/renderer/src/utils/mainError'
import { APP_I18N_RESOURCES } from '../../src/shared/i18n/resources'

/** 渲染层的 t()：直接查目录，模拟 i18next 的插值 */
function translator(locale: 'zh-CN' | 'en') {
  return (key: string, values?: Record<string, unknown>): string => {
    const leaf = key
      .split('.')
      .reduce<unknown>((v, s) => (v && typeof v === 'object' ? (v as any)[s] : undefined), APP_I18N_RESOURCES[locale])
    if (typeof leaf !== 'string') return key
    return leaf.replace(/{{\s*([^}\s]+)\s*}}/g, (ph, name: string) =>
      values?.[name] === undefined ? ph : String(values[name])
    )
  }
}

describe('main failure copy crosses the IPC boundary as a key', () => {
  it('renders the same failure in whichever language the UI is showing', async () => {
    await initializeMainI18n('zh-CN')
    const failure = mainError('toolsHub.skills.errors.githubStatus', { status: 503 })

    // Main 侧就地渲染（日志/兜底）跟随 Main 语言
    expect(failure.error).toBe('下载失败：GitHub 返回状态码 503')
    // key 与参数是语言中立的，渲染层据此重译
    expect(failure.errorKey).toBe('toolsHub.skills.errors.githubStatus')

    const display = toDisplayError({ ok: false, ...failure } as never)
    expect(renderDisplayError(translator('zh-CN'), display)).toBe('下载失败：GitHub 返回状态码 503')
    expect(renderDisplayError(translator('en'), display)).toBe('Download failed: GitHub returned status 503')

    await changeMainLocale('en')
    expect(mainError('toolsHub.skills.errors.githubStatus', { status: 503 }).error).toBe(
      'Download failed: GitHub returned status 503'
    )
    await changeMainLocale('zh-CN')
  })

  it('passes foreign text through untranslated so gateway evidence survives', () => {
    const display = toDisplayError({ error: 'ECONNRESET from 10.0.0.4' })
    expect(display).toEqual({ raw: 'ECONNRESET from 10.0.0.4' })
    expect(renderDisplayError(translator('en'), display)).toBe('ECONNRESET from 10.0.0.4')
    expect(renderDisplayError(translator('zh-CN'), display)).toBe('ECONNRESET from 10.0.0.4')
  })

  it('falls back to the caller-supplied key when the failure carries nothing', () => {
    const display = toDisplayError(undefined, 'toolsHub.skills.importFailed')
    expect(renderDisplayError(translator('en'), display)).toBe('Import failed')
    expect(renderDisplayError(translator('zh-CN'), display)).toBe('导入失败')
  })
})

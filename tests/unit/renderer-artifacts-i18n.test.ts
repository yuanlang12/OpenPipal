import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createRendererI18n } from '../../src/renderer/src/i18n'
import { getArtifactExportOptions } from '../../src/renderer/src/components/workspace/tabs/artifactExportOptions'
import { parseSelfCheckVerdict } from '../../src/renderer/src/chat/selfCheck'

const read = (path: string): string => readFileSync(resolve(path), 'utf8')

const MIGRATED_FILES = [
  'src/renderer/src/components/workspace/tabs/ArtifactTab.tsx',
  'src/renderer/src/components/workspace/tabs/artifactExportOptions.ts',
  'src/renderer/src/components/artifacts/CodePreview.tsx',
  'src/renderer/src/components/SelfCheckPreview.tsx',
  'src/renderer/src/components/ArtifactPanel.tsx',
]

describe('artifact shell i18n', () => {
  it('serves matching English and Chinese product copy', async () => {
    const english = await createRendererI18n('en')
    const chinese = await createRendererI18n('zh-CN')

    expect(english.t('artifacts.shell.actions.preview')).toBe('Preview')
    expect(english.t('artifacts.selfCheck.checking')).toBe('Checking this draft for issues…')
    expect(english.t('artifacts.invalidContent.title')).toBe('This artifact is no longer available')
    expect(chinese.t('artifacts.shell.actions.preview')).toBe('预览')
    expect(chinese.t('artifacts.selfCheck.checking')).toBe('正在检查这一稿有没有问题…')
    expect(chinese.t('artifacts.invalidContent.title')).toBe('此产物内容已失效')
    expect(english.t('artifacts.shell.generating')).toBe('Generating…')
    expect(chinese.t('artifacts.shell.generating')).toBe('生成中…')
  })

  it('localizes export labels without changing protocol IDs or source extensions', async () => {
    const i18n = await createRendererI18n('en')
    const t = i18n.getFixedT('en')
    const dc = getArtifactExportOptions(t, {
      type: 'html',
      isDcArtifact: true,
      isAnimationDc: true,
      isDeckDc: true,
    })
    expect(dc.map(option => option.key)).toEqual([
      'project-zip',
      'standalone-html',
      'pdf',
      'mp4',
      'pptx',
      'handoff',
    ])
    expect(dc[0].label).toBe('Project package .zip')

    const source = getArtifactExportOptions(t, {
      type: 'code',
      language: 'user-lang.raw',
      isDcArtifact: false,
      isAnimationDc: false,
      isDeckDc: false,
    })
    expect(source).toEqual([{
      key: 'source',
      label: 'Source file .user-lang.raw',
      desc: 'Export the original source file',
    }])
  })

  it('keeps titles, paths, errors, language IDs, and unknown model verdicts verbatim', async () => {
    const i18n = await createRendererI18n('en')
    const rawTitle = '用户标题 / RAW title'
    const rawPath = '/用户/RAW/path.dc.html'
    const rawError = '模型错误 그대로'

    expect(i18n.t('artifacts.invalidContent.regenerate', { title: rawTitle })).toContain(rawTitle)
    expect(i18n.t('artifacts.shell.export.successPdf', { path: rawPath })).toContain(rawPath)
    expect(i18n.t('artifacts.shell.export.failed', { error: rawError })).toContain(rawError)
    expect(parseSelfCheckVerdict(rawError)).toEqual({ ok: null, kind: 'raw', label: rawError })
  })

  it('routes only OpenPipal shell copy through i18n', () => {
    const source = MIGRATED_FILES.map(read).join('\n')
    expect(source).toContain('useTranslation()')
    expect(source).toContain('{title}')
    expect(source).toContain('data.title')
    expect(source).toContain('data.content')
    expect(source).toContain('(data as any).language')
    expect(source).toContain("toDisplayError(res, 'artifacts.shell.export.unknownError')")
    expect(source).toContain('verdict.label')

    expect(source).not.toMatch(/\bt\(\s*(?:title|content|language|artifactId|data\.title|data\.content|data\.id|res\?\.error|verdict\.label)\b/)
    expect(source).toContain('self-check-neutral-icon')
    expect(source).toContain("verdict?.kind === 'raw'")
    expect(source).toContain("title || t('artifacts.shell.generating')")
  })

  it('defines every static artifact key used by the migrated surfaces', async () => {
    const i18n = await createRendererI18n('en')
    const source = MIGRATED_FILES.map(read).join('\n')
    const keys = [...source.matchAll(/\bt\('((?:artifacts|common)\.[^']+)'/g)].map(match => match[1])

    expect(keys.length).toBeGreaterThan(10)
    for (const key of new Set(keys)) expect(i18n.exists(key)).toBe(true)
  })
})

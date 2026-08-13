import type { TFunction } from 'i18next'

export interface ArtifactExportOption {
  key: string
  label: string
  desc: string
}

/** Product copy changes with locale; export protocol IDs never do. */
export function getArtifactExportOptions(
  t: TFunction,
  input: {
    type: string
    language?: string
    isDcArtifact: boolean
    isAnimationDc: boolean
    isDeckDc: boolean
  }
): ArtifactExportOption[] {
  const { type, language, isDcArtifact, isAnimationDc, isDeckDc } = input
  if (isDcArtifact) {
    return [
      { key: 'project-zip', label: t('artifacts.shell.export.formats.projectZip.label'), desc: t('artifacts.shell.export.formats.projectZip.desc') },
      { key: 'standalone-html', label: t('artifacts.shell.export.formats.standaloneHtml.label'), desc: t('artifacts.shell.export.formats.standaloneHtml.desc') },
      { key: 'pdf', label: 'PDF', desc: t('artifacts.shell.export.formats.currentPdf.desc') },
      ...(isAnimationDc
        ? [{ key: 'mp4', label: t('artifacts.shell.export.formats.mp4.label'), desc: t('artifacts.shell.export.formats.mp4.desc') }]
        : []),
      ...(isDeckDc
        ? [{ key: 'pptx', label: t('artifacts.shell.export.formats.pptx.label'), desc: t('artifacts.shell.export.formats.pptx.desc') }]
        : []),
      { key: 'handoff', label: t('artifacts.shell.export.formats.handoff.label'), desc: t('artifacts.shell.export.formats.handoff.desc') },
    ]
  }
  if (type === 'document' || type === 'markdown') {
    return [
      { key: 'pdf', label: 'PDF', desc: t('artifacts.shell.export.formats.documentPdf.desc') },
      { key: 'source', label: 'Markdown .md', desc: t('artifacts.shell.export.formats.source.desc') },
    ]
  }
  if (type === 'design-system') {
    return [{ key: 'ds-zip', label: t('artifacts.shell.export.formats.designSystemZip.label'), desc: t('artifacts.shell.export.formats.designSystemZip.desc') }]
  }
  const extension = ({ svg: 'svg', html: 'html', canvas: 'json', code: language || 'txt' } as Record<string, string>)[type] || 'txt'
  return [{
    key: 'source',
    label: t('artifacts.shell.export.formats.source.label', { extension }),
    desc: t('artifacts.shell.export.formats.source.desc'),
  }]
}

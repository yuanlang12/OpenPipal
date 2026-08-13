import type { TFunction } from 'i18next'
import type { WorkspaceTab, WorkspaceTabKind } from '../../stores/workspaceStore'

const OUTPUT_TYPE_KEYS: Record<string, string> = {
  html: 'shell.workspace.outputTypes.html',
  svg: 'shell.workspace.outputTypes.svg',
  code: 'shell.workspace.outputTypes.code',
  markdown: 'shell.workspace.outputTypes.markdown',
  md: 'shell.workspace.outputTypes.markdown',
  document: 'shell.workspace.outputTypes.document',
  canvas: 'shell.workspace.outputTypes.canvas',
  'design-system': 'shell.workspace.outputTypes.designSystem',
  file: 'shell.workspace.outputTypes.file',
}

const STATIC_OUTPUT_TYPE_LABELS: Record<string, string> = {
  pdf: 'PDF',
  ppt: 'PPT',
  pptx: 'PPTX',
  zip: 'ZIP',
  csv: 'CSV',
  json: 'JSON',
}

const RENDERER_NAME_KEYS: Partial<Record<WorkspaceTabKind, string>> = {
  visualizer: 'shell.workspace.rendererNames.visualizer',
  task: 'shell.workspace.rendererNames.task',
}

/** Translate only stable OpenPipal protocol ids; unknown extension/plugin ids remain unchanged. */
export function workspaceOutputTypeLabel(type: string, t: TFunction): string {
  const normalized = type.toLowerCase()
  const key = OUTPUT_TYPE_KEYS[normalized]
  return key ? t(key) : (STATIC_OUTPUT_TYPE_LABELS[normalized] || type)
}

export function workspaceRendererName(kind: WorkspaceTabKind, t: TFunction): string {
  const key = RENDERER_NAME_KEYS[kind]
  return key ? t(key) : kind
}

export function workspaceTabTitle(tab: Pick<WorkspaceTab, 'title' | 'titleKey' | 'titleParams'>, t: TFunction): string {
  if (tab.title) return tab.title
  if (tab.titleKey) return t(tab.titleKey, tab.titleParams)
  return t('shell.workspace.untitledTab')
}

export function artifactTabTitleDescriptor(artifact: {
  type: string
  title: string
  titleKey?: string
}): { title: string; titleKey?: string } {
  const productTitleKey = artifact.type === 'todos'
    ? 'runtimeChrome.artifacts.todosTitle'
    : artifact.type === 'goal'
      ? 'runtimeChrome.artifacts.goalTitle'
      : artifact.titleKey
  if (productTitleKey) return { title: '', titleKey: productTitleKey }
  return artifact.title
    ? { title: artifact.title }
    : { title: '', titleKey: 'shell.workspace.fallback.untitledArtifact' }
}

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createRendererI18n } from '../../src/renderer/src/i18n'
import {
  workspaceOutputTypeLabel,
  workspaceRendererName,
  workspaceTabTitle,
} from '../../src/renderer/src/components/workspace/workspaceLabels'

const WORKSPACE_FILES = [
  'src/renderer/src/components/workspace/WorkspaceEmptyState.tsx',
  'src/renderer/src/components/workspace/ResizeHandle.tsx',
  'src/renderer/src/components/workspace/WorkspaceSidebar.tsx',
  'src/renderer/src/components/workspace/WorkspaceTabHost.tsx',
  'src/renderer/src/components/workspace/FilesPanel.tsx',
  'src/renderer/src/components/workspace/SourcesPanel.tsx',
  'src/renderer/src/components/workspace/sections/OutputsSection.tsx',
  'src/renderer/src/components/workspace/sections/TasksSection.tsx',
  'src/renderer/src/components/workspace/sections/SourcesSection.tsx',
  'src/renderer/src/components/workspace/tabs/FileTab.tsx',
  'src/renderer/src/components/workspace/tabs/PreviewTab.tsx',
  'src/renderer/src/components/workspace/workspaceEntries.ts',
]

const read = (path: string): string => readFileSync(resolve(path), 'utf8')

function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
}

describe('renderer workspace i18n', () => {
  it('serves localized Workspace, file, preview, and source-library chrome', async () => {
    const en = await createRendererI18n('en')
    const zh = await createRendererI18n('zh-CN')

    expect(en.t('shell.workspace.sections.outputs')).toBe('Outputs')
    expect(en.t('shell.workspace.files.folderItems', { count: 2 })).toBe('2 items')
    expect(en.t('shell.workspace.files.truncated')).toBe('… (truncated)')
    expect(en.t('shell.workspace.filePreview.unsupported')).toContain('not available')
    expect(en.t('shell.workspace.preview.openExternal')).toBe('Open in default browser')
    expect(en.t('shell.workspace.sourceLibrary.status.ingesting')).toBe('Processing')
    expect(zh.t('shell.workspace.sourceLibrary.count', { count: 2 })).toBe('我的资料 · 2 个')
  })

  it('localizes stable protocol labels and preserves unknown ids', async () => {
    const en = await createRendererI18n('en')
    const zh = await createRendererI18n('zh-CN')

    expect(workspaceOutputTypeLabel('design-system', en.getFixedT('en'))).toBe('Design system')
    expect(workspaceOutputTypeLabel('design-system', zh.getFixedT('zh-CN'))).toBe('设计系统')
    expect(workspaceOutputTypeLabel('custom-plugin-format', en.getFixedT('en'))).toBe('custom-plugin-format')
    expect(workspaceRendererName('visualizer', zh.getFixedT('zh-CN'))).toBe('可视化')
  })

  it('removes migrated hard-coded Chinese chrome while preserving source comments', () => {
    const source = stripComments(WORKSPACE_FILES.map(read).join('\n'))
    const migratedLiterals = [
      '当前会话还没有输出',
      '未命名任务',
      '当前对话还没有来源',
      '拖拽调整列宽',
      '收起文件夹',
      '这个文件类型还不支持预览',
      '在系统浏览器中打开',
      '把你想搞懂的资料丢进来',
      '松手把资料加进来',
      '渲染器即将在后续阶段启用',
    ]

    for (const literal of migratedLiterals) expect(source).not.toContain(literal)
  })

  it('keeps user and filesystem content outside translation calls', () => {
    const filesPanel = read('src/renderer/src/components/workspace/FilesPanel.tsx')
    const sourcesPanel = read('src/renderer/src/components/workspace/SourcesPanel.tsx')
    const outputs = read('src/renderer/src/components/workspace/sections/OutputsSection.tsx')
    const fileTab = read('src/renderer/src/components/workspace/tabs/FileTab.tsx')
    const tabHost = read('src/renderer/src/components/workspace/WorkspaceTabHost.tsx')

    expect(filesPanel).toContain('{node.name}')
    expect(sourcesPanel).toContain('{source.title}')
    expect(sourcesPanel).toContain('{source.summary}')
    expect(outputs).toContain('workspaceOutputTypeLabel(output.type, t)')
    expect(fileTab).toContain('{state.error}')
    expect(tabHost).toContain('workspaceRendererName(tab.kind, t)')
  })

  it('stores translation descriptors instead of translated generated tab titles', () => {
    const store = read('src/renderer/src/stores/workspaceStore.ts')
    const sources = read('src/renderer/src/components/workspace/sections/SourcesSection.tsx')
    const tasks = read('src/renderer/src/components/workspace/sections/TasksSection.tsx')
    const panel = read('src/renderer/src/components/workspace/WorkspacePanel.tsx')

    expect(store).toContain('titleKey?: string')
    expect(store).toContain('titleParams?: Record<string, string | number>')
    expect(sources).toContain('titleKey: source.labelKey')
    expect(sources).toContain('resolveWorkspaceEntryLabel(source, t)')
    expect(tasks).toContain("titleKey: 'shell.workspace.fallback.untitledTask'")
    expect(panel).toContain('workspaceTabTitle(tab, t)')
  })

  it('re-resolves generated tab titles from the active locale', async () => {
    const en = await createRendererI18n('en')
    const zh = await createRendererI18n('zh-CN')
    const tab = { title: '', titleKey: 'shell.workspace.fallback.image', titleParams: { count: 2 } }

    expect(workspaceTabTitle(tab, zh.getFixedT('zh-CN'))).toBe('图片 2')
    expect(workspaceTabTitle(tab, en.getFixedT('en'))).toBe('Image 2')
    expect(workspaceTabTitle({ title: '用户标题' }, en.getFixedT('en'))).toBe('用户标题')
  })
})

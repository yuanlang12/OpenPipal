import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createRendererI18n } from '../../src/renderer/src/i18n'

const VIEW_PATH = 'src/renderer/src/components/artifacts/DesignSystemView.tsx'
const GALLERY_PATH = 'src/renderer/src/components/artifacts/DesignSystemGallery.tsx'
const FILES_PATH = 'src/renderer/src/components/artifacts/DesignSystemFiles.tsx'

const read = (path: string): string => readFileSync(resolve(path), 'utf8')

function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
}

describe('renderer design-system browser i18n', () => {
  it('serves matching English and Chinese view, review, and file chrome', async () => {
    const english = await createRendererI18n('en')
    const chinese = await createRendererI18n('zh-CN')

    expect(english.t('designSystemBrowser.view.gallery')).toBe('Gallery view')
    expect(english.t('designSystemBrowser.view.fileCount', { count: 1 })).toBe('1 file')
    expect(english.t('designSystemBrowser.view.fileCount', { count: 3 })).toBe('3 files')
    expect(english.t('designSystemBrowser.gallery.review.send')).toBe('Send feedback to Agent')
    expect(english.t('designSystemBrowser.files.sections.style')).toBe('Stylesheets')
    expect(english.t('designSystemBrowser.files.truncated')).toContain('first 200 KB')
    expect(chinese.t('designSystemBrowser.view.gallery')).toBe('画廊视图')
    expect(chinese.t('designSystemBrowser.gallery.guidelines')).toBe('规范文档')
    expect(chinese.t('designSystemBrowser.files.actions.reveal')).toBe('在访达中显示')
  })

  it('keeps manifest and review content raw while localizing only OpenPipal chrome', () => {
    const source = [VIEW_PATH, GALLERY_PATH, FILES_PATH].map(read).join('\n')
    const gallery = read(GALLERY_PATH)
    const files = read(FILES_PATH)

    expect(gallery).toContain('{manifest.title || manifest.name}')
    expect(gallery).toContain('{manifest.description}')
    expect(gallery).toContain('{manifest.path}')
    expect(gallery).toContain('{section.group}')
    expect(gallery).toContain('{card.name}')
    expect(gallery).toContain('{card.subtitle}')
    expect(gallery).toContain('{kit.label}')
    expect(gallery).toContain('<Markdown content={readmeText} />')
    expect(files).toContain('{node.name}')
    expect(files).toContain('{node.rel}')
    expect(files).toContain('{text}')
    expect(source).not.toMatch(/\bt\(\s*(?:manifest\.|section\.group|card\.|kit\.|readmeText|node\.|text\b)/)
  })

  it('preserves the Chinese Agent feedback protocol byte-for-byte', () => {
    const gallery = read(GALLERY_PATH)

    expect(gallery).toContain('`【设计系统评审反馈 · ${manifest.name}】`')
    expect(gallery).toContain("`✅ 已确认 (${ups.length})：${ups.map(i => i.label).join('、')}`")
    expect(gallery).toContain("`❌ 待修改 (${downs.length})：`")
    expect(gallery).toContain("'未写具体意见，请自查这张卡的问题'")
    expect(gallery).toContain("`⏸ 尚未评审 (${pendings.length})：${pendings.map(i => i.label).join('、')}`")
    expect(gallery).toContain('请只修改被踩项对应的源文件（已确认项不要动）')
    expect(gallery).toContain('以上评审已完成，被确认的卡片视为定稿，不要再改动')
  })

  it('uses locale-aware non-mutating sorting and shared date and size formatters', () => {
    const view = read(VIEW_PATH)
    const files = read(FILES_PATH)

    expect(view).toContain("new Intl.Collator(locale, { numeric: true, sensitivity: 'base' })")
    expect(view).toContain('const modified = (b.mtime || 0) - (a.mtime || 0)')
    expect(view).toContain('modified || collator.compare(a.rel, b.rel)')
    expect(files).toContain('function sortFileTree(nodes: DsFileNode[], collator: Intl.Collator)')
    expect(files).toContain('.map(node => ({')
    expect(files).toContain('children: node.children ? sortFileTree(node.children, collator) : undefined')
    expect(files).toContain('const sortedFiles = useMemo(() => sortFileTree(files, collator), [files, collator])')
    expect(files).toContain('formatRelativeTime(n.mtime, locale)')
    expect(files).toContain('formatLocaleDateTime(node.mtime, locale)')
    expect(files).toContain('formatByteSize(node.size, locale)')
    expect(files).not.toContain("localeCompare(b.rel, 'zh')")
    expect(read(GALLERY_PATH)).not.toMatch(/manifest\.(?:groups|kits)\.sort\s*\(/)
  })

  it('preserves unknown file extensions as raw technical labels', () => {
    const files = read(FILES_PATH)

    expect(files).toContain("const ext = (name.split('.').pop() || '').toUpperCase()")
    expect(files).toContain("if (ext && ext !== name.toUpperCase()) return ext")
    expect(files).toContain('fileKindLabel(n.name, k, t)')
    expect(files).toContain('fileKindLabel(node.name, meta, t)')
  })

  it('shows truncation outside raw content and exposes expanded state and icon labels', () => {
    const view = read(VIEW_PATH)
    const gallery = read(GALLERY_PATH)
    const files = read(FILES_PATH)
    const visibleSource = stripComments(`${view}\n${gallery}\n${files}`)

    expect(files).toContain('const value = truncated ? result.data.slice(0, 200_000) : result.data')
    expect(files).toContain('data-testid="ds-files-truncated"')
    expect(files).toContain("t('designSystemBrowser.files.truncated')")
    expect(files).not.toContain("result.data.slice(0, 200_000) +")
    expect(view).toContain('aria-expanded={menuOpen}')
    expect(view).not.toContain('role="menu"')
    expect(view).not.toContain('aria-haspopup="menu"')
    expect(view).toContain('aria-pressed={view === opt.key}')
    expect(files).toContain('aria-expanded={open}')
    expect(gallery).toContain("aria-label={t('designSystemBrowser.gallery.review.approveAction')}")
    expect(gallery).toContain("aria-label={t('designSystemBrowser.gallery.review.reviseAction')}")
    expect(visibleSource).toContain('flex-wrap')
  })
})

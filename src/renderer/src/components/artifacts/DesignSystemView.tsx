/**
 * DesignSystemView —— 设计系统产物的外壳：一条「全部文件 ⌄」工具条 + 两种视图
 *
 * 对标官方 Claude Design 顶栏的 All files 下拉：下拉里既能切视图，也能直接跳到某个页面。
 *  - 画廊视图（默认）：现有卡墙 + 逐卡评审闭环，一行不动
 *  - 全部文件：Finder 式文件浏览（DesignSystemFiles）
 *
 * manifest 在这里拉一次供下拉与文件视图共用；画廊仍自取自用（保持它的独立加载态，
 * 不为了省一次目录读盘去改一个已交付且带评审闭环的组件）。
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronDown, Check, FileCode2, LayoutGrid, Files } from 'lucide-react'
import { DesignSystemGallery } from './DesignSystemGallery'
import { DesignSystemFiles, type DsFileNode } from './DesignSystemFiles'
import { formatRelativeTime } from '../../i18n/formatters'

interface DsManifestLite {
  name: string
  path: string
  files?: DsFileNode[]
}

type DsView = 'gallery' | 'files'

/** 摊平出所有 html 页面（下拉的快捷跳转项），按修改时间新→旧 */
function collectPages(nodes: DsFileNode[], collator: Intl.Collator): DsFileNode[] {
  const out: DsFileNode[] = []
  const walk = (list: DsFileNode[]): void => {
    for (const n of list) {
      if (n.kind === 'dir') walk(n.children || [])
      else if (/\.html?$/i.test(n.name)) out.push(n)
    }
  }
  walk(nodes)
  return out.sort((a, b) => {
    const modified = (b.mtime || 0) - (a.mtime || 0)
    return modified || collator.compare(a.rel, b.rel)
  })
}

export function DesignSystemView({ name }: { name: string }): JSX.Element {
  const { t, i18n } = useTranslation()
  const locale = i18n.resolvedLanguage || i18n.language
  const [view, setView] = useState<DsView>('gallery')
  const [menuOpen, setMenuOpen] = useState(false)
  const [manifest, setManifest] = useState<DsManifestLite | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const menuRef = useRef<HTMLDivElement>(null)

  // 切换设计系统时回到默认视图，别把上一套的选中文件带过来
  useEffect(() => {
    setView('gallery')
    setSelected(null)
    setManifest(null)
    let cancelled = false
    const fn = (window.api as any)?.getDesignSystemManifest
    if (typeof fn !== 'function') return
    Promise.resolve(fn(name))
      .then((m: DsManifestLite | null) => { if (!cancelled && m && typeof m === 'object') setManifest(m) })
      .catch(() => { /* 静默：下拉降级为只有视图切换 */ })
    return () => { cancelled = true }
  }, [name])

  // 点空白处关下拉
  useEffect(() => {
    if (!menuOpen) return
    const onDown = (e: MouseEvent): void => {
      if (!menuRef.current?.contains(e.target as Node)) setMenuOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [menuOpen])

  const files = manifest?.files || []
  const collator = useMemo(
    () => new Intl.Collator(locale, { numeric: true, sensitivity: 'base' }),
    [locale]
  )
  const pages = useMemo(() => collectPages(files, collator).slice(0, 6), [files, collator])
  const fileCount = useMemo(() => {
    let n = 0
    const walk = (list: DsFileNode[]): void => { for (const e of list) { if (e.kind === 'dir') walk(e.children || []); else n++ } }
    walk(files)
    return n
  }, [files])

  const gotoPage = (rel: string): void => {
    setSelected(rel)
    setView('files')
    setMenuOpen(false)
  }

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      {/* 工具条：视图切换 + 页面快捷跳转 */}
      <div className="min-h-8 shrink-0 flex flex-wrap items-center justify-between gap-1 px-2.5 py-1 border-b border-surface-100 bg-surface-0 dark:bg-surface-50">
        <div className="relative" ref={menuRef}>
          <button
            data-testid="ds-view-menu-btn"
            onClick={() => setMenuOpen(o => !o)}
            aria-expanded={menuOpen}
            aria-label={t('designSystemBrowser.view.menuLabel')}
            className="h-6 px-2 rounded-md flex items-center gap-1 text-[11px] font-medium text-surface-700 bg-surface-50 dark:bg-surface-50/60 hover:bg-surface-100 transition-colors"
          >
            {view === 'gallery' ? <LayoutGrid size={11} /> : <Files size={11} />}
            {view === 'gallery'
              ? t('designSystemBrowser.view.gallery')
              : t('designSystemBrowser.view.allFiles')}
            <ChevronDown size={11} className={`transition-transform ${menuOpen ? 'rotate-180' : ''}`} />
          </button>

          {menuOpen && (
            <div
              data-testid="ds-view-menu"
              className="op-menu absolute left-0 top-7 z-30 w-60 py-1.5"
            >
              {([
                {
                  key: 'gallery' as DsView,
                  label: t('designSystemBrowser.view.gallery'),
                  desc: t('designSystemBrowser.view.galleryDescription')
                },
                {
                  key: 'files' as DsView,
                  label: t('designSystemBrowser.view.allFiles'),
                  desc: t('designSystemBrowser.view.allFilesDescription')
                }
              ]).map(opt => (
                <button
                  key={opt.key}
                  data-testid={`ds-view-opt-${opt.key}`}
                  aria-pressed={view === opt.key}
                  onClick={() => { setView(opt.key); setMenuOpen(false) }}
                  className="w-full px-2.5 py-1.5 flex items-center gap-2 text-left hover:bg-surface-50 transition-colors"
                >
                  <Check size={12} className={view === opt.key ? 'text-brand-500' : 'text-transparent'} />
                  <span className="min-w-0 flex-1">
                    <span className="block text-[11.5px] text-surface-800">{opt.label}</span>
                    <span className="block text-[10px] text-surface-400">{opt.desc}</span>
                  </span>
                </button>
              ))}

              {pages.length > 0 && (
                <>
                  <div className="mt-1 pt-1.5 px-2.5 border-t border-surface-100 text-[10px] font-medium uppercase tracking-wide text-surface-400">
                    {t('designSystemBrowser.view.pages')}
                  </div>
                  {pages.map(p => (
                    <button
                      key={p.rel}
                      data-testid="ds-view-page"
                      onClick={() => gotoPage(p.rel)}
                      className="w-full px-2.5 py-1.5 flex items-center gap-2 text-left hover:bg-surface-50 transition-colors"
                    >
                      <FileCode2 size={12} className="shrink-0 text-surface-400" />
                      <span className="min-w-0 flex-1">
                        <span className="block text-[11.5px] text-surface-800 truncate">{p.name}</span>
                        <span className="block text-[10px] text-surface-400 truncate">
                          {p.rel.includes('/')
                            ? p.rel.slice(0, p.rel.lastIndexOf('/'))
                            : t('designSystemBrowser.view.rootDirectory')}
                          {p.mtime ? ` · ${formatRelativeTime(p.mtime, locale)}` : ''}
                        </span>
                      </span>
                    </button>
                  ))}
                </>
              )}
            </div>
          )}
        </div>

        {view === 'files' && fileCount > 0 && (
          <span className="text-[10.5px] text-surface-400 shrink-0">
            {t('designSystemBrowser.view.fileCount', { count: fileCount })}
          </span>
        )}
      </div>

      {view === 'gallery' ? (
        <DesignSystemGallery name={name} />
      ) : (
        <DesignSystemFiles
          name={name}
          rootPath={manifest?.path || ''}
          files={files}
          selected={selected}
          onSelect={setSelected}
        />
      )}
    </div>
  )
}

/**
 * DesignSystemFiles —— 设计系统「全部文件」视图（对标官方 Claude Design 的 Finder 式文件浏览）
 *
 * 数据来自 manifest.files（main 侧 scanDsFiles 如实扫盘，不套画廊那套卡片排除规则），
 * 页面 iframe 走 127.0.0.1:3031 静态伺服；文本/图片通过受控 window.api 读取，
 * 避免跨源 fetch，也不把任意本机路径暴露给 renderer。
 * 只读：改稿走对话，这里刻意不做编辑/删除入口（与角色档案预览同一纪律）。
 *
 * 版式随容器宽度切换：≥560px 左右分栏（列表 + 详情），窄于此走推进式（点文件进详情，可返回）——
 * workspace 侧栏默认 480px、最窄能拖到 320px，硬塞分栏两边都读不了。
 */

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { TFunction } from 'i18next'
import { useTranslation } from 'react-i18next'
import {
  ChevronRight, Folder, FileCode2, FileText, Image as ImageIcon, Braces, Type as TypeIcon,
  File, ExternalLink, ArrowLeft, FolderOpen
} from 'lucide-react'
import { Markdown } from '../shared/Markdown'
import { formatByteSize, formatLocaleDateTime, formatRelativeTime } from '../../i18n/formatters'
import { designSystemResourceUrl, getDesignSystemResourceBaseUrl } from '../../utils/designSystemResourceUrl'

export interface DsFileNode {
  name: string
  rel: string
  kind: 'dir' | 'file'
  size?: number
  mtime?: number
  children?: DsFileNode[]
}

const SPLIT_MIN_WIDTH = 560

type FileKind = 'page' | 'style' | 'script' | 'doc' | 'image' | 'font' | 'data' | 'other'

/** 扩展名 → 稳定类型；界面标签由当前语言资源提供。 */
function fileKind(name: string): FileKind {
  const ext = (name.split('.').pop() || '').toLowerCase()
  if (ext === 'html' || ext === 'htm') return 'page'
  if (ext === 'css') return 'style'
  if (['js', 'mjs', 'cjs', 'jsx', 'ts', 'tsx'].includes(ext)) return 'script'
  if (ext === 'md') return 'doc'
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'avif'].includes(ext)) return 'image'
  if (['woff', 'woff2', 'ttf', 'otf'].includes(ext)) return 'font'
  if (ext === 'json') return 'data'
  return 'other'
}

/** 已知类型走产品翻译；未知类型保留用户文件的真实扩展名（如 WASM）。 */
function fileKindLabel(name: string, kind: FileKind, t: TFunction): string {
  if (kind === 'other') {
    const ext = (name.split('.').pop() || '').toUpperCase()
    if (ext && ext !== name.toUpperCase()) return ext
  }
  return t(`designSystemBrowser.files.kinds.${kind}`)
}

function KindIcon({ kind, className }: { kind: FileKind; className: string }): JSX.Element {
  switch (kind) {
    case 'page': return <FileCode2 className={className} strokeWidth={1.75} />
    case 'style': return <Braces className={className} strokeWidth={1.75} />
    case 'script': return <FileCode2 className={className} strokeWidth={1.75} />
    case 'doc': return <FileText className={className} strokeWidth={1.75} />
    case 'image': return <ImageIcon className={className} strokeWidth={1.75} />
    case 'font': return <TypeIcon className={className} strokeWidth={1.75} />
    default: return <File className={className} strokeWidth={1.75} />
  }
}

/** 顶层分节：文件夹优先，其余按类型归堆（与截图原版的 FOLDERS / PAGES / STYLESHEETS / SCRIPTS 同构） */
const SECTION_ORDER: Array<FileKind | 'dir'> = [
  'dir', 'page', 'style', 'script', 'doc', 'image', 'font', 'data', 'other'
]

/** 递归排序克隆：永不修改 manifest.files 或它的 children 数组。 */
function sortFileTree(nodes: DsFileNode[], collator: Intl.Collator): DsFileNode[] {
  return nodes
    .map(node => ({
      ...node,
      children: node.children ? sortFileTree(node.children, collator) : undefined
    }))
    .sort((left, right) => collator.compare(left.name, right.name) || collator.compare(left.rel, right.rel))
}

/** 深度优先找节点（rel 全路径唯一） */
function findNode(nodes: DsFileNode[], rel: string): DsFileNode | null {
  for (const n of nodes) {
    if (n.rel === rel) return n
    if (n.children) {
      const hit = findNode(n.children, rel)
      if (hit) return hit
    }
  }
  return null
}

/** 首个可预览文件：优先顶层页面 → 任意页面 → 任意文件（进来就有东西看，不给空详情） */
function firstPreviewable(nodes: DsFileNode[]): string | null {
  const topPage = nodes.find(n => n.kind === 'file' && fileKind(n.name) === 'page')
  if (topPage) return topPage.rel
  let anyFile: string | null = null
  const walk = (list: DsFileNode[]): string | null => {
    for (const n of list) {
      if (n.kind === 'file') {
        if (fileKind(n.name) === 'page') return n.rel
        if (!anyFile) anyFile = n.rel
      } else if (n.children) {
        const hit = walk(n.children)
        if (hit) return hit
      }
    }
    return null
  }
  return walk(nodes) || anyFile
}

export function DesignSystemFiles({
  name,
  rootPath,
  files,
  selected,
  onSelect
}: {
  name: string
  rootPath: string
  files: DsFileNode[]
  selected: string | null
  onSelect: (rel: string | null) => void
}): JSX.Element {
  const { t, i18n } = useTranslation()
  const locale = i18n.resolvedLanguage || i18n.language
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [text, setText] = useState<string | null>(null)
  const [textTruncated, setTextTruncated] = useState(false)
  const [imageSrc, setImageSrc] = useState<string | null>(null)
  const [previewFailed, setPreviewFailed] = useState(false)
  const [resourceBase, setResourceBase] = useState<string | null>(null)
  const [wide, setWide] = useState(true)
  const hostRef = useRef<HTMLDivElement>(null)
  const collator = useMemo(
    () => new Intl.Collator(locale, { numeric: true, sensitivity: 'base' }),
    [locale]
  )
  const sortedFiles = useMemo(() => sortFileTree(files, collator), [files, collator])

  useEffect(() => {
    let cancelled = false
    const loadCapability = (): void => {
      getDesignSystemResourceBaseUrl(name)
        .then(base => { if (!cancelled) setResourceBase(base) })
        .catch(() => { if (!cancelled) setResourceBase(null) })
    }
    loadCapability()
    window.addEventListener('openpipal-browser-session-rotated', loadCapability)
    return () => {
      cancelled = true
      window.removeEventListener('openpipal-browser-session-rotated', loadCapability)
    }
  }, [name])

  // 容器宽度决定分栏/推进式；ResizeObserver 而非窗口宽度——侧栏可拖宽、study 模式又是整窗
  useLayoutEffect(() => {
    const el = hostRef.current
    if (!el) return
    const apply = (w: number): void => setWide(w >= SPLIT_MIN_WIDTH)
    apply(el.getBoundingClientRect().width)
    const ro = new ResizeObserver(entries => { for (const e of entries) apply(e.contentRect.width) })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // 分栏版进来就选中首个可预览文件；窄版保持列表态（推进式的第一屏是列表）
  useEffect(() => {
    if (wide && !selected) {
      const first = firstPreviewable(sortedFiles)
      if (first) onSelect(first)
    }
  }, [wide, selected, sortedFiles, onSelect])

  // 选中项的祖先目录自动展开——否则从下拉跳到某个深层文件时，列表里根本看不见被选中的行。
  // 页面除外：它在「页面」分节里本来就摊平可见，再展开一次只会把文件夹区撑成几十行，
  // 把"页面"分节挤到屏幕外（实测 crema-design 的 preview 一展开就是 21 行）。
  useEffect(() => {
    if (!selected || !selected.includes('/')) return
    if (fileKind(selected.split('/').pop() || '') === 'page') return
    const segs = selected.split('/')
    setExpanded(prev => {
      const next = new Set(prev)
      let acc = ''
      for (let i = 0; i < segs.length - 1; i++) {
        acc = acc ? `${acc}/${segs[i]}` : segs[i]
        next.add(acc)
      }
      return next
    })
  }, [selected])

  const node = selected ? findNode(sortedFiles, selected) : null
  const meta = node ? fileKind(node.name) : null
  const isText = meta ? ['style', 'script', 'doc', 'data'].includes(meta) : false
  const selectedRel = node?.rel
  const selectedKind = meta

  // 文本/图片通过同一条受控资源 API 读取；页面 iframe 仍直接导航静态 route。
  useEffect(() => {
    setText(null)
    setTextTruncated(false)
    setImageSrc(null)
    setPreviewFailed(false)
    const isImage = selectedKind === 'image'
    if (!selectedRel || (!isText && !isImage)) return
    const readResource = window.api?.readDesignSystemResource
    if (typeof readResource !== 'function') {
      setPreviewFailed(true)
      return
    }
    let cancelled = false
    Promise.resolve(readResource(name, selectedRel))
      .then((result: { ok?: boolean; kind?: string; data?: string }) => {
        if (cancelled) return
        if (!result?.ok || typeof result.data !== 'string') {
          setPreviewFailed(true)
          return
        }
        if (isText && result.kind === 'text') {
          const truncated = result.data.length > 200_000
          const value = truncated ? result.data.slice(0, 200_000) : result.data
          setText(value)
          setTextTruncated(truncated)
          return
        }
        if (isImage && result.kind === 'data-url') {
          setImageSrc(result.data)
          return
        }
        setPreviewFailed(true)
      })
      .catch(() => { if (!cancelled) setPreviewFailed(true) })
    return () => { cancelled = true }
  }, [selectedRel, isText, selectedKind, name])

  /**
   * 「页面」分节跨层收集（其余分节仍按顶层分组）。
   * 设计系统的预览卡按技能规定放在 preview/ guidelines/ components/ 里，顶层通常一张都没有——
   * 只按顶层分组的话，打开一套 21 张卡的系统，「页面」那栏是空的，得逐个展开文件夹才找得到。
   * 页面是这里最主要的看点，值得像智能文件夹一样直接摊平（代价是它在所属文件夹里会再出现一次）。
   * 与顶栏下拉的页面列表同一口径——两处曾经不一致，是实现遗漏。
   */
  const allPages = useMemo(() => {
    const out: DsFileNode[] = []
    const walk = (list: DsFileNode[]): void => {
      for (const n of list) {
        if (n.kind === 'dir') walk(n.children || [])
        else if (fileKind(n.name) === 'page') out.push(n)
      }
    }
    walk(sortedFiles)
    // 按路径排序而非时间：同一目录的卡挨在一起更好翻（下拉那份按时间是"跳最近改的"，用途不同）
    return out.sort((a, b) => collator.compare(a.rel, b.rel))
  }, [sortedFiles, collator])

  const sections = useMemo(() => {
    const bucket = new Map<string, DsFileNode[]>()
    for (const n of sortedFiles) {
      const key = n.kind === 'dir' ? 'dir' : fileKind(n.name)
      if (key === 'page') continue // 页面统一由 allPages 摊平供给
      if (!bucket.has(key)) bucket.set(key, [])
      bucket.get(key)!.push(n)
    }
    bucket.set('page', allPages)
    return SECTION_ORDER
      .map(key => ({ key, items: bucket.get(key) || [] }))
      .filter(section => section.items.length > 0)
  }, [sortedFiles, allPages])

  const toggleDir = (rel: string): void =>
    setExpanded(prev => {
      const next = new Set(prev)
      if (next.has(rel)) next.delete(rel)
      else next.add(rel)
      return next
    })

  const openExternally = (): void => {
    if (!node) return
    const api = (window as any).api
    if (typeof api?.openFile === 'function') void api.openFile(`${rootPath}/${node.rel}`)
    else if (resourceBase) window.open(designSystemResourceUrl(resourceBase, name, node.rel), '_blank', 'noopener,noreferrer')
  }

  const revealInFinder = (): void => {
    if (!node) return
    void (window as any).api?.revealFile?.(`${rootPath}/${node.rel}`)
  }

  // ---- 行渲染（文件夹递归） ----
  // subtitleOverride：摊平的页面行用它显示所在文件夹（否则一排"页面"看不出谁在哪）
  const renderRow = (n: DsFileNode, depth: number, subtitleOverride?: string): JSX.Element => {
    const pad = 10 + depth * 14
    if (n.kind === 'dir') {
      const open = expanded.has(n.rel)
      const count = n.children?.length ?? 0
      return (
        <div key={n.rel}>
          <button
            data-testid="ds-files-dir"
            onClick={() => toggleDir(n.rel)}
            aria-expanded={open}
            style={{ paddingLeft: pad }}
            className="w-full flex items-center gap-2 py-1.5 pr-3 text-left hover:bg-surface-100 transition-colors"
          >
            <ChevronRight className={`w-3 h-3 shrink-0 text-surface-400 transition-transform ${open ? 'rotate-90' : ''}`} />
            <Folder className="w-4 h-4 shrink-0 text-brand-500" strokeWidth={1.75} />
            <span className="min-w-0 flex-1">
              <span className="block text-[12.5px] text-surface-800 truncate">{n.name}</span>
              <span className="block text-[10.5px] text-surface-400">
                {t('designSystemBrowser.files.folder')}
                {' · '}
                {count
                  ? t('designSystemBrowser.files.itemCount', { count })
                  : t('designSystemBrowser.files.emptyFolder')}
              </span>
            </span>
            <span className="text-[10.5px] text-surface-300 shrink-0">—</span>
          </button>
          {open && (n.children || []).map(c => renderRow(c, depth + 1))}
        </div>
      )
    }
    const k = fileKind(n.name)
    const isSel = n.rel === selected
    return (
      <button
        key={n.rel}
        data-testid="ds-files-row"
        onClick={() => onSelect(n.rel)}
        style={{ paddingLeft: pad + 14 }}
        // 刻意不加 transition-colors：选中态是「底色 + 文字色」同时反转，
        // 过渡期会出现半秒的白字白底（实测截图可见），选中必须瞬时生效
        className={`w-full flex items-center gap-2 py-1.5 pr-3 text-left ${
          isSel
            ? 'bg-brand-500 text-ink-on-accent'
            : 'hover:bg-surface-100 text-surface-800'
        }`}
      >
        <KindIcon kind={k} className={`w-4 h-4 shrink-0 ${isSel ? 'text-white/90' : 'text-surface-400'}`} />
        <span className="min-w-0 flex-1">
          <span className="block text-[12.5px] truncate">{n.name}</span>
          <span className={`block text-[10.5px] truncate ${isSel ? 'text-white/70' : 'text-surface-400'}`}>
            {subtitleOverride || fileKindLabel(n.name, k, t)}
          </span>
        </span>
        <span
          title={n.mtime ? formatLocaleDateTime(n.mtime, locale) : undefined}
          className={`text-[10.5px] shrink-0 ${isSel ? 'text-white/70' : 'text-surface-400'}`}
        >
          {n.mtime ? formatRelativeTime(n.mtime, locale) : '—'}
        </span>
      </button>
    )
  }

  const list = (
    <div data-testid="ds-files-list" className="overflow-y-auto min-h-0 flex-1">
      {sections.length === 0 && (
        <p className="px-4 py-6 text-xs text-surface-400">
          {t('designSystemBrowser.files.emptySystem')}
        </p>
      )}
      {sections.map(s => (
        <section key={s.key} data-testid="ds-files-section">
          <div className="px-3 py-1.5 flex items-center justify-between text-[10px] font-medium uppercase tracking-wide text-surface-400 bg-surface-50 dark:bg-surface-50/60 border-y border-surface-100">
            <span>{t(`designSystemBrowser.files.sections.${s.key}`)}</span>
            <span className="tabular-nums">{s.items.length}</span>
          </div>
          {s.items.map(n =>
            // 页面是摊平的：副标题改显所在文件夹，缩进归零（它不属于这一层的目录树）
            s.key === 'page'
              ? renderRow(
                n,
                0,
                n.rel.includes('/')
                  ? n.rel.slice(0, n.rel.lastIndexOf('/'))
                  : t('designSystemBrowser.view.rootDirectory')
              )
              : renderRow(n, 0)
          )}
        </section>
      ))}
    </div>
  )

  const detail = (
    <div data-testid="ds-files-detail" className="flex-1 min-h-0 overflow-y-auto">
      {!node ? (
        <div className="h-full flex items-center justify-center text-xs text-surface-400">
          {t('designSystemBrowser.files.selectFile')}
        </div>
      ) : (
        // 分栏版撑满右栏（页面预览吃掉剩余高度，元信息贴底，Finder 式）；窄版按内容自然高
        <div className={`p-4 ${wide ? 'h-full flex flex-col' : ''}`}>
          {!wide && (
            <button
              data-testid="ds-files-back"
              onClick={() => onSelect(null)}
              className="mb-3 inline-flex items-center gap-1 text-[11px] text-surface-500 hover:text-surface-700"
            >
              <ArrowLeft size={12} /> {t('designSystemBrowser.files.actions.back')}
            </button>
          )}

          {/* 预览区：页面走 iframe（与画廊同一条静态伺服），图片直显，文本类给正文/源码 */}
          {meta === 'page' && resourceBase && (
            <iframe
              data-testid="ds-files-preview-frame"
              src={designSystemResourceUrl(resourceBase, name, node.rel)}
              title={node.name}
              loading="lazy"
              sandbox="allow-scripts"
              referrerPolicy="no-referrer"
              className={`w-full bg-white rounded-lg border border-surface-200 dark:border-surface-200 ${
                wide ? 'flex-1 min-h-[260px]' : 'h-[320px]'
              }`}
            />
          )}
          {meta === 'page' && !resourceBase && (
            <div className={`w-full rounded-lg border border-surface-200 dark:border-surface-200 bg-surface-50 dark:bg-surface-0 ${wide ? 'flex-1 min-h-[260px]' : 'h-[320px]'}`} />
          )}
          {meta === 'image' && imageSrc && (
            <img
              src={imageSrc}
              alt={node.name}
              className="max-w-full rounded-lg border border-surface-200 bg-white"
            />
          )}
          {textTruncated && (
            <div
              data-testid="ds-files-truncated"
              className="mb-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-[11px] text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200"
            >
              {t('designSystemBrowser.files.truncated')}
            </div>
          )}
          {meta === 'doc' && text !== null && (
            <div className={`prose-light max-w-none ${wide ? 'flex-1 min-h-0 overflow-auto' : ''}`}>
              <Markdown content={text} />
            </div>
          )}
          {isText && meta !== 'doc' && text !== null && (
            <pre className={`p-3 rounded-lg border border-surface-200 dark:border-surface-200 bg-surface-50 dark:bg-surface-0 text-[11px] font-mono leading-relaxed text-surface-700 dark:text-surface-300 whitespace-pre-wrap break-all ${
              wide ? 'flex-1 min-h-0 overflow-auto' : 'max-h-[420px] overflow-auto'
            }`}>
              {text}
            </pre>
          )}
          {(previewFailed || (!isText && meta !== 'page' && meta !== 'image')) && (
            <div className="px-3 py-6 rounded-lg border border-dashed border-surface-200 text-center text-[11px] text-surface-400">
              {t('designSystemBrowser.files.unsupportedPreview')}
            </div>
          )}

          {/* 元信息 + 打开入口（对标截图的 Open / Modified · 大小 · 类型） */}
          <div className="mt-3 text-center shrink-0">
            <div className="flex flex-wrap items-center justify-center gap-2">
              <button
                data-testid="ds-files-open"
                onClick={openExternally}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md border border-surface-200 text-[11px] text-surface-700 hover:bg-surface-50 transition-colors"
              >
                <ExternalLink size={12} /> {t('designSystemBrowser.files.actions.open')}
              </button>
              {typeof (window as any).api?.revealFile === 'function' && (
                <button
                  data-testid="ds-files-reveal"
                  onClick={revealInFinder}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md border border-surface-200 text-[11px] text-surface-700 hover:bg-surface-50 transition-colors"
                >
                  <FolderOpen size={12} /> {t('designSystemBrowser.files.actions.reveal')}
                </button>
              )}
            </div>
            <div className="mt-2.5 text-[13px] font-medium text-surface-800 break-all">{node.name}</div>
            <div className="text-[11px] text-surface-500">
              {meta ? fileKindLabel(node.name, meta, t) : null}
            </div>
            <div className="mt-1 text-[10.5px] text-surface-400">
              {[
                node.mtime
                  ? t('designSystemBrowser.files.modified', {
                    time: formatLocaleDateTime(node.mtime, locale)
                  })
                  : null,
                node.size !== undefined ? formatByteSize(node.size, locale) : null,
                (node.name.split('.').pop() || '').toUpperCase() || null
              ]
                .filter(Boolean)
                .join(' · ')}
            </div>
            <div className="mt-1 text-[10px] font-mono text-surface-300 break-all">{node.rel}</div>
          </div>
        </div>
      )}
    </div>
  )

  return (
    <div ref={hostRef} data-testid="ds-files" className="flex-1 min-h-0 flex bg-surface-0 dark:bg-surface-50">
      {wide ? (
        <>
          <div className="w-[248px] shrink-0 border-r border-surface-100 flex flex-col min-h-0">{list}</div>
          {detail}
        </>
      ) : selected ? (
        detail
      ) : (
        <div className="flex-1 min-h-0 flex flex-col">{list}</div>
      )}
    </div>
  )
}

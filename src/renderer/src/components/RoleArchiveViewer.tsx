/**
 * 教学风格内容预览——preflow「教学风格」tab 行点击打开（全屏 overlay 的内容区）。
 *
 * 左右分栏（Finder/IDE 式）：左侧常驻目录树（文件夹可折叠、默认全展开），
 * 右侧内容区——默认风格概览（风格.md），点树里哪个文件就展示哪个。
 * md 渲染 / 图片直预览 / 其他类型给文件信息；正文里的相对 .md 链接点击 = 树内选中。
 * 内容只读；外层提供「整理或修改」，把变更带回 Teacher Agent 对话并重新确认。
 */
import { useEffect, useState, type MouseEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { toDisplayError, renderDisplayError } from '../utils/mainError'
import { ChevronRight, Folder, FileText, Image as ImageIcon, File, BookOpen } from 'lucide-react'
import { Markdown } from './shared/Markdown'
import { prettyDocName, resolveFileDisplayLabel } from '../chat/fileDisplay'

interface TreeEntry { name: string; kind: 'dir' | 'file'; sizeBytes?: number; children?: TreeEntry[] }

const IMG_RE = /\.(png|jpe?g|gif|webp|svg)$/i
const MD_RE = /\.md$/i

/** 剥 frontmatter——首个 --- 块是给索引/注入用的元数据，不是给老师看的正文 */
function stripFrontmatter(s: string): string {
  return s.replace(/^---\n[\s\S]*?\n---\n+/, '')
}

/** 相对链接解析：基于当前文件所在目录处理 ./ 与 ../；越出档案根返回 null（不允许翻到档案外） */
export function resolveArchiveRel(currentRel: string, href: string): string | null {
  const segs = currentRel.split('/').slice(0, -1)
  for (const part of href.split('/')) {
    if (!part || part === '.') continue
    if (part === '..') { if (segs.length === 0) return null; segs.pop(); continue }
    segs.push(part)
  }
  return segs.join('/') || null
}

function fmtSize(n?: number): string {
  if (!n && n !== 0) return ''
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`
  return `${(n / 1048576).toFixed(1)} MB`
}

function rawErrorDetail(value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') return undefined
  return value instanceof Error ? value.message : String(value)
}

function firstFile(entries: TreeEntry[], prefix = ''): string | null {
  for (const entry of entries) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.kind === 'file') return rel
    const nested = firstFile(entry.children || [], rel)
    if (nested) return nested
  }
  return null
}

export function RoleArchiveViewer({ rootPath, initialFile = '风格.md' }: { rootPath: string; initialFile?: string }) {
  const { t } = useTranslation()
  const [tree, setTree] = useState<TreeEntry[] | null>(null)
  const [selected, setSelected] = useState(initialFile)   // 相对档案根
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())  // 收起的文件夹（默认全展开）
  const [docText, setDocText] = useState<string | null>(null)
  const [docImg, setDocImg] = useState<string | null>(null)
  // 原始 API 错误保持 raw；无 detail 时仅在渲染阶段使用当前语言的 fallback。
  const [error, setError] = useState<{ detail?: string } | null>(null)

  useEffect(() => {
    let cancelled = false
    setTree(null)
    setSelected(initialFile)
    ;(window.api as any)?.listRoleSystemTree?.(rootPath)
      .then((t: TreeEntry[]) => {
        if (cancelled || !Array.isArray(t)) return
        setTree(t)
        const rootFiles = new Set(t.filter(e => e.kind === 'file').map(e => e.name))
        if (rootFiles.has(initialFile)) setSelected(initialFile)
        else if (rootFiles.has('风格.md')) setSelected('风格.md')
        else if (rootFiles.has('SKILL.md')) setSelected('SKILL.md')
        else setSelected(firstFile(t) || '')
      })
      .catch(() => { if (!cancelled) setTree([]) })
    return () => { cancelled = true }
  }, [rootPath, initialFile])

  // 选中文件加载：md 读文本，图片读 base64，其他类型不读（右侧给文件信息）
  const isImg = IMG_RE.test(selected)
  const isMd = MD_RE.test(selected)
  useEffect(() => {
    setDocText(null); setDocImg(null); setError(null)
    if (!selected || (!isImg && !isMd)) return
    let cancelled = false
    ;(window.api as any)?.readFileForPreview?.(`${rootPath}/${selected}`, isImg ? 'base64' : 'text')
      .then((r: { ok?: boolean; data?: unknown; error?: string; errorKey?: string; errorParams?: Record<string, unknown> } | undefined) => {
        if (cancelled) return
        if (!r?.ok || typeof r.data !== 'string') {
          const detail = renderDisplayError(t, toDisplayError(r)) || rawErrorDetail(r?.error)
          setError(detail ? { detail } : {})
          return
        }
        if (isImg) setDocImg(r.data)
        else setDocText(stripFrontmatter(r.data))
      })
      .catch((e: unknown) => {
        if (!cancelled) {
          const detail = rawErrorDetail(e)
          setError(detail ? { detail } : {})
        }
      })
    return () => { cancelled = true }
  }, [rootPath, selected, isImg, isMd])

  // 捕获阶段拦截 md 正文里的链接：相对 .md 链接 = 树内选中；外链不接管
  const handleClickCapture = (e: MouseEvent): void => {
    const a = (e.target as HTMLElement).closest?.('a')
    if (!a) return
    let href = a.getAttribute('href') || ''
    if (/^[a-z][a-z0-9+.-]*:/i.test(href)) return
    e.preventDefault()
    e.stopPropagation()
    // react-markdown 会把中文文件名百分号编码（01-硬约束.md → 01-%E7%A1%AC….md）——读盘前必须解回来
    try { href = decodeURIComponent(href) } catch { /* 非法编码就按原样试 */ }
    if (!MD_RE.test(href)) return
    const next = resolveArchiveRel(selected, href)
    if (next) setSelected(next)
  }

  const toggleDir = (rel: string): void =>
    setCollapsed(prev => {
      const next = new Set(prev)
      if (next.has(rel)) next.delete(rel)
      else next.add(rel)
      return next
    })

  const selectedEntry = ((): TreeEntry | null => {
    let list = tree || []
    let found: TreeEntry | null = null
    for (const seg of selected.split('/')) {
      found = list.find(e => e.name === seg) || null
      if (!found) return null
      list = found.children || []
    }
    return found
  })()

  // ---- 左侧目录树（递归） ----
  const renderNode = (e: TreeEntry, parentRel: string, depth: number) => {
    const rel = parentRel ? `${parentRel}/${e.name}` : e.name
    if (e.kind === 'dir') {
      const isCollapsed = collapsed.has(rel)
      const toggleLabel = t(isCollapsed ? 'chat.roleArchive.expandFolder' : 'chat.roleArchive.collapseFolder', {
        name: e.name,
      })
      return (
        <div key={rel}>
          <button
            data-testid="archive-tree-dir"
            onClick={() => toggleDir(rel)}
            title={toggleLabel}
            aria-label={toggleLabel}
            aria-expanded={!isCollapsed}
            className="w-full flex items-center gap-1.5 py-1.5 pr-2 rounded-md text-left hover:bg-[#F1EDE3] dark:hover:bg-surface-100 transition-colors"
            style={{ paddingLeft: 8 + depth * 14 }}
          >
            <ChevronRight className={`w-3 h-3 text-[#B5AF9E] shrink-0 transition-transform ${isCollapsed ? '' : 'rotate-90'}`} />
            <Folder className="w-3.5 h-3.5 text-[#6F864F] shrink-0" strokeWidth={1.75} />
            <span className="text-[12.5px] text-ink-primary dark:text-surface-700 truncate">{e.name}</span>
          </button>
          {!isCollapsed && (e.children || []).map(c => renderNode(c, rel, depth + 1))}
        </div>
      )
    }
    const isSel = rel === selected
    const isMain = rel === '风格.md' || rel === 'SKILL.md'
    return (
      <button
        key={rel}
        data-testid="archive-tree-file"
        onClick={() => setSelected(rel)}
        title={t('chat.roleArchive.openFile', { name: e.name })}
        aria-current={isSel ? 'true' : undefined}
        className={`w-full flex items-center gap-1.5 py-1.5 pr-2 rounded-md text-left transition-colors ${
          isSel ? 'bg-[#EAEFDF] dark:bg-surface-100 text-[#3D4A2A] dark:text-surface-700' : 'hover:bg-[#F1EDE3] dark:hover:bg-surface-100 text-ink-primary dark:text-surface-700'
        }`}
        style={{ paddingLeft: 8 + depth * 14 + 14 }}
      >
        {isMain ? <BookOpen className="w-3.5 h-3.5 text-[#6F864F] shrink-0" strokeWidth={1.75} />
          : IMG_RE.test(e.name) ? <ImageIcon className="w-3.5 h-3.5 text-[#B08968] shrink-0" strokeWidth={1.75} />
          : MD_RE.test(e.name) ? <FileText className="w-3.5 h-3.5 text-ink-tertiary shrink-0" strokeWidth={1.75} />
          : <File className="w-3.5 h-3.5 text-[#B5AF9E] shrink-0" strokeWidth={1.75} />}
        <span className="text-[12.5px] truncate">{resolveFileDisplayLabel(prettyDocName(e.name), t)}</span>
      </button>
    )
  }

  return (
    <div className="flex h-full min-h-0 w-full" data-testid="archive-viewer">
      {/* 左：目录树。风格.md 是默认页并置顶；旧 SKILL.md 仅兼容展示 */}
      <div className="w-[240px] shrink-0 border-r border-[#EDEAE0] dark:border-surface-100 overflow-y-auto px-2 py-3" data-testid="archive-tree">
        {tree !== null && tree.length === 0 && (
          <p className="px-2 text-[12px] text-[#B5AF9E]">{t('chat.roleArchive.empty')}</p>
        )}
        {(tree || [])
          .slice()
          .sort((a, b) => {
            const rank = (name: string): number => name === '风格.md' ? 2 : name === 'SKILL.md' ? 1 : 0
            return rank(b.name) - rank(a.name)
          })
          .map(e => renderNode(e, '', 0))}
      </div>

      {/* 右：内容区（默认档案总览） */}
      <div className="flex-1 overflow-y-auto min-h-0" data-testid="archive-content">
        <div className="max-w-[680px] mx-auto px-8 py-6">
          <div className="text-[12px] text-[#B5AF9E] mb-3">
            {selected === '风格.md'
              ? t('chat.roleArchive.personalReference')
              : selected === 'SKILL.md'
                ? t('chat.roleArchive.legacyOverview')
                : resolveFileDisplayLabel(prettyDocName(selected.split('/').pop() || selected), t)}
          </div>
          {error && <p className="text-[13px] text-red-400">{error.detail || t('chat.roleArchive.readFailed')}</p>}
          {docText !== null && (
            // prose-light = 聊天正文同一套 markdown 版式（表格边框/标题层级/列表行距），不裸奔
            <div onClickCapture={handleClickCapture} className="prose-light">
              <Markdown content={docText} />
            </div>
          )}
          {docImg !== null && (
            <img
              src={`data:image/${(selected.split('.').pop() || 'png').replace('jpg', 'jpeg').replace('svg', 'svg+xml')};base64,${docImg}`}
              alt={selected}
              className="max-w-full rounded-lg border border-[#EDEAE0] dark:border-surface-100"
            />
          )}
          {!isMd && !isImg && (
            <div className="text-[13px] text-ink-tertiary">
              <p className="mb-1">{t('chat.roleArchive.unsupported')}</p>
              <p className="text-[12px] text-[#B5AF9E]">{selected}{selectedEntry?.sizeBytes !== undefined ? ` · ${fmtSize(selectedEntry.sizeBytes)}` : ''}</p>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

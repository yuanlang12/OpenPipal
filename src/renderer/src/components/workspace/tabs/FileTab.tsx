import { useEffect, useState, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { toDisplayError, renderDisplayError } from '../../../utils/mainError'
import { Folder, ExternalLink, Loader2, AlertCircle } from 'lucide-react'
import { Markdown } from '../../shared/Markdown'

interface FileTabProps {
  filePath: string
}

type PreviewKind = 'text' | 'markdown' | 'image' | 'pdf' | 'csv' | 'json' | 'unsupported'

function kindFor(ext: string): PreviewKind {
  if (['md', 'markdown'].includes(ext)) return 'markdown'
  if (['txt', 'log'].includes(ext)) return 'text'
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp'].includes(ext)) return 'image'
  if (['pdf'].includes(ext)) return 'pdf'
  if (['csv'].includes(ext)) return 'csv'
  if (['json'].includes(ext)) return 'json'
  if (['js', 'ts', 'jsx', 'tsx', 'py', 'html', 'css', 'sh', 'yaml', 'yml', 'toml'].includes(ext)) return 'text'
  return 'unsupported'
}

function mimeFor(ext: string): string {
  switch (ext) {
    case 'png': return 'image/png'
    case 'jpg':
    case 'jpeg': return 'image/jpeg'
    case 'gif': return 'image/gif'
    case 'webp': return 'image/webp'
    case 'svg': return 'image/svg+xml'
    case 'bmp': return 'image/bmp'
    case 'pdf': return 'application/pdf'
    default: return 'application/octet-stream'
  }
}

function CsvTable({ text }: { text: string }) {
  const { t } = useTranslation()
  const rows = useMemo(() => {
    return text.split(/\r?\n/).filter(Boolean).slice(0, 500).map(line => {
      // 简易 CSV parser — 不处理引号转义（phase 4 先 good-enough）
      return line.split(',')
    })
  }, [text])
  if (rows.length === 0) return <div className="p-4 text-surface-400 text-sm">{t('shell.workspace.filePreview.emptyTable')}</div>
  const [head, ...body] = rows
  return (
    <div className="flex-1 overflow-auto p-2">
      <table className="text-xs border-collapse w-full">
        <thead className="sticky top-0 bg-surface-50">
          <tr>
            {head.map((c, i) => (
              <th key={i} className="px-2 py-1.5 border border-surface-200 text-left font-medium text-surface-700">{c}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {body.map((r, i) => (
            <tr key={i} className="hover:bg-surface-50 dark:hover:bg-surface-50/40">
              {r.map((c, j) => (
                <td key={j} className="px-2 py-1 border border-surface-200 text-surface-600">{c}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length >= 500 && (
        <div className="text-[11px] text-surface-400 mt-2 px-2">{t('shell.workspace.filePreview.firstRowsOnly', { count: 500 })}</div>
      )}
    </div>
  )
}

/**
 * 文件 tab 渲染器 —— 按扩展名派发到合适的 viewer。
 * 未支持的类型降级展示文件信息 + "系统应用打开" / "Finder 显示" 操作。
 */
export function FileTab({ filePath }: FileTabProps) {
  const { t } = useTranslation()
  const ext = useMemo(() => {
    const dot = filePath.lastIndexOf('.')
    return dot >= 0 ? filePath.slice(dot + 1).toLowerCase() : ''
  }, [filePath])
  const kind = kindFor(ext)

  const [state, setState] = useState<{
    loading: boolean
    failed?: boolean
    errorKind?: 'readFailed' | 'unknownError'
    error?: string
    text?: string
    base64?: string
    size?: number
  }>({ loading: true })

  useEffect(() => {
    let cancelled = false
    async function load() {
      setState({ loading: true })
      const api = (window as any).api
      const mode = (kind === 'image' || kind === 'pdf') ? 'base64' : 'text'
      if (kind === 'unsupported') {
        setState({ loading: false })
        return
      }
      try {
        const res = await api?.readFileForPreview?.(filePath, mode)
        if (cancelled) return
        if (!res?.ok) {
          setState({
            loading: false,
            failed: true,
            errorKind: 'readFailed',
            error: renderDisplayError(t, toDisplayError(res)) || undefined
          })
          return
        }
        setState({
          loading: false,
          text: mode === 'text' ? res.data : undefined,
          base64: mode === 'base64' ? res.data : undefined,
          size: res.size
        })
      } catch (err: any) {
        if (!cancelled) setState({ loading: false, failed: true, errorKind: 'unknownError', error: err.message })
      }
    }
    load()
    return () => { cancelled = true }
  }, [filePath, kind])

  const fileName = filePath.split('/').pop() || filePath

  const handleReveal = () => (window as any).api?.revealFile?.(filePath)
  const handleOpen = () => (window as any).api?.openFile?.(filePath)
  const localizedError = t(`shell.workspace.filePreview.${state.errorKind || 'unknownError'}`)

  return (
    <div className="flex-1 flex flex-col min-h-0">
      <div className="h-8 shrink-0 flex items-center gap-2 px-2.5 border-b border-surface-100 bg-surface-0 dark:bg-surface-50">
        <span className="text-xs text-surface-600 truncate flex-1" title={filePath}>{fileName}</span>
        <button onClick={handleReveal} className="h-6 px-1.5 rounded flex items-center gap-1 text-[11px] text-surface-500 hover:bg-surface-100" title={t('shell.workspace.filePreview.revealInFinder')}>
          <Folder size={11} /> {t('shell.workspace.filePreview.finder')}
        </button>
        <button onClick={handleOpen} className="h-6 px-1.5 rounded flex items-center gap-1 text-[11px] text-surface-500 hover:bg-surface-100" title={t('shell.workspace.filePreview.openDefaultTitle')}>
          <ExternalLink size={11} /> {t('shell.workspace.filePreview.open')}
        </button>
      </div>

      {state.loading && (
        <div className="flex-1 flex items-center justify-center text-surface-400 text-xs gap-2">
          <Loader2 size={14} className="animate-spin" /> {t('shell.workspace.filePreview.loading')}
        </div>
      )}

      {!state.loading && state.failed && (
        <div className="flex-1 flex flex-col items-center justify-center text-surface-500 text-xs gap-3 px-6">
          <AlertCircle size={20} className="text-rose-400" />
          <div className="text-center leading-relaxed">
            <div>{localizedError}</div>
            {state.error && state.error !== localizedError && (
              <div className="mt-1 text-[11px] opacity-70 break-words">{state.error}</div>
            )}
            <div className="mt-2 opacity-70">{t('shell.workspace.filePreview.openHint')}</div>
          </div>
          <button onClick={handleOpen} className="px-3 py-1 rounded bg-brand-50 dark:bg-brand-900/30 text-brand-600 dark:text-brand-300 text-xs hover:bg-brand-100 dark:hover:bg-brand-900/50">
            {t('shell.workspace.filePreview.openDefault')}
          </button>
        </div>
      )}

      {!state.loading && !state.failed && kind === 'markdown' && (
        <div className="flex-1 overflow-auto p-4 prose-light">
          <Markdown content={state.text || ''} />
        </div>
      )}

      {!state.loading && !state.failed && kind === 'text' && (
        <pre className="flex-1 overflow-auto p-4 text-xs font-mono text-surface-700 bg-surface-50 whitespace-pre-wrap break-all leading-relaxed">
          {state.text}
        </pre>
      )}

      {!state.loading && !state.failed && kind === 'json' && (
        <pre className="flex-1 overflow-auto p-4 text-xs font-mono text-surface-700 bg-surface-50 whitespace-pre-wrap leading-relaxed">
          {(() => {
            try { return JSON.stringify(JSON.parse(state.text || ''), null, 2) } catch { return state.text }
          })()}
        </pre>
      )}

      {!state.loading && !state.failed && kind === 'csv' && (
        <CsvTable text={state.text || ''} />
      )}

      {!state.loading && !state.failed && kind === 'image' && (
        <div className="flex-1 overflow-auto flex items-center justify-center bg-surface-50 p-4">
          <img
            src={`data:${mimeFor(ext)};base64,${state.base64}`}
            alt={fileName}
            className="max-w-full max-h-full object-contain"
          />
        </div>
      )}

      {!state.loading && !state.failed && kind === 'pdf' && (
        <iframe
          src={`data:application/pdf;base64,${state.base64}`}
          className="flex-1 w-full border-0"
          title={fileName}
        />
      )}

      {!state.loading && kind === 'unsupported' && (
        <div className="flex-1 flex flex-col items-center justify-center text-surface-500 text-xs gap-3 px-6">
          <div className="text-surface-400 text-sm">{t('shell.workspace.filePreview.unsupported')}</div>
          <div className="text-[11px] opacity-80">.{ext} · {fileName}</div>
          <div className="flex flex-wrap justify-center gap-2">
            <button onClick={handleReveal} className="px-3 py-1 rounded bg-surface-100 text-surface-700 text-xs hover:bg-surface-200">
              {t('shell.workspace.filePreview.revealInFinder')}
            </button>
            <button onClick={handleOpen} className="px-3 py-1 rounded bg-brand-50 dark:bg-brand-900/30 text-brand-600 dark:text-brand-300 text-xs hover:bg-brand-100 dark:hover:bg-brand-900/50">
              {t('shell.workspace.filePreview.openDefault')}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

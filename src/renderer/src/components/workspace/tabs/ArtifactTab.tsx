import { useArtifactStore, type Artifact } from '../../../stores/artifactStore'
import { useChatStore } from '../../../stores/chatStore'
import { useAppStore } from '../../../stores/appStore'
import { HtmlPreview } from '../../artifacts/HtmlPreview'
import { CodePreview } from '../../artifacts/CodePreview'
import { McpAppPreview } from '../../artifacts/McpAppPreview'
import { stripDcSuffix, isReceiptOnlyContent } from '../../../utils/format'
import { GoalTab } from '../../artifacts/GoalTab'
import { DesignSystemView } from '../../artifacts/DesignSystemView'
import { Markdown } from '../../shared/Markdown'
import { QuestionsV2Panel } from '../../QuestionsV2Panel'
import { useState, useRef, useEffect, useMemo, lazy, Suspense, type ChangeEvent } from 'react'
import { Eye, Code2, Loader2, FileText, Download, Share2, Circle, CircleDot, CheckCircle2, ListTodo } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { toDisplayError, renderDisplayError } from '../../../utils/mainError'
import { isDcHtml, looksLikeAnimationDc, looksLikeDeckDc } from '../../artifacts/dcRuntime'
import { getArtifactExportOptions } from './artifactExportOptions'

// 六种 artifact 类型里只有 canvas 需要画布引擎——懒加载，首次打开 canvas artifact 才拉取该 chunk
const CanvasArtifact = lazy(() =>
  import('../../artifacts/CanvasArtifact').then(m => ({ default: m.CanvasArtifact }))
)

type ViewMode = 'preview' | 'code'

// looksLikeAnimationDc / looksLikeDeckDc 已收口到 artifacts/dcRuntime.ts（自检预览卡也要用同一组
// 正则挑设备外框，别再各处抄一份）

/**
 * questions 类型 artifact 的渲染器——读 pendingQuestionsV2 的 artifactId 判断是否已回答。
 * streaming=true 时是流式生成中的临时预览稿:跳过 answered 判断,渐进渲染已成型的问题,提交禁用。
 */
function QuestionsArtifactView({ artifactId, fallbackTitle, content, streaming }: { artifactId: string; fallbackTitle?: string; content: string; streaming?: boolean }) {
  const { t } = useTranslation()
  const pending = useChatStore(s => s.pendingQuestionsV2)
  const submitQuestionsV2 = useChatStore(s => s.submitQuestionsV2)
  const currentRole = useAppStore(s => s.currentRole)

  // 定稿态才做「已提交」判断;流式预览稿(pending 尚未设置)直接进入渐进渲染
  if (!streaming) {
    const answered = !pending || pending.artifactId !== artifactId
    if (answered) {
      return <div className="flex-1 flex items-center justify-center text-xs text-surface-400">{t('artifacts.shell.questionsSubmitted')}</div>
    }
  }

  let payload: { title: string; questions: any[] } = { title: fallbackTitle || '', questions: [] }
  try {
    const parsed = JSON.parse(content)
    if (parsed && typeof parsed === 'object') {
      payload = {
        title: parsed.title || fallbackTitle || '',
        questions: Array.isArray(parsed.questions) ? parsed.questions : []
      }
    }
  } catch { /* 异常 content 降级为空问题 */ }

  return (
    <QuestionsV2Panel
      title={payload.title}
      questions={payload.questions}
      streaming={streaming}
      onSubmit={(answers, images, files) => submitQuestionsV2(answers, currentRole?.name || 'learner', images, files)}
    />
  )
}

/**
 * todos 勾选清单渲染 —— update_todos 工具全量替换语义,content=JSON.stringify({todos})。
 * pending ○ / in_progress ◐ / completed ●,复用现有卡片样式 token,inline 渲染不新建组件文件。
 */
function TodosArtifactView({ content }: { content: string }) {
  const { t } = useTranslation()
  let todos: Array<{ content: string; status: string }> = []
  try {
    const parsed = JSON.parse(content || '{}')
    if (Array.isArray(parsed?.todos)) todos = parsed.todos
  } catch { /* 异常 content 降级为空清单 */ }

  const done = todos.filter(t => t.status === 'completed').length
  return (
    <div data-testid="artifact-todos" className="flex-1 overflow-auto p-4">
      <div className="mb-3 flex items-center gap-1.5 text-[11px] text-surface-400">
        <ListTodo size={12} /> {t('artifacts.shell.todos.progress', { done, total: todos.length })}
      </div>
      {todos.length === 0 ? (
        <div className="text-xs text-surface-400">{t('artifacts.shell.todos.empty')}</div>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {todos.map((t, i) => {
            const st = t.status
            const Icon = st === 'completed' ? CheckCircle2 : st === 'in_progress' ? CircleDot : Circle
            const iconCls = st === 'completed'
              ? 'text-emerald-500'
              : st === 'in_progress' ? 'text-brand-500' : 'text-surface-300'
            return (
              <li key={i} className="flex items-start gap-2 rounded-md px-2 py-1.5 bg-surface-50 dark:bg-surface-50/60">
                <Icon size={15} className={`mt-0.5 shrink-0 ${iconCls}`} />
                <span className={[
                  'text-xs leading-relaxed',
                  st === 'completed' ? 'line-through text-surface-400' : 'text-surface-700',
                  st === 'in_progress' ? 'font-medium' : ''
                ].join(' ')}>
                  {t.content}
                </span>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}

/** markdown/document 源码可编辑器 —— 本地 state + 防抖保存,切 artifact 时按 id 重置 */
function MarkdownSourceEditor({ artifactId, content, onSave }: { artifactId: string; content: string; onSave: (c: string) => void }) {
  const { t } = useTranslation()
  const [val, setVal] = useState(content)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => { setVal(content) }, [artifactId]) // eslint-disable-line react-hooks/exhaustive-deps
  const onChange = (e: ChangeEvent<HTMLTextAreaElement>) => {
    const v = e.target.value
    setVal(v)
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => onSave(v), 500)
  }
  return (
    <textarea
      value={val}
      onChange={onChange}
      spellCheck={false}
      placeholder={t('artifacts.shell.markdownSourcePlaceholder')}
      className="flex-1 overflow-auto p-4 text-xs font-mono text-surface-700 bg-surface-50 outline-none resize-none leading-relaxed"
    />
  )
}

/** code 产物流式生成中的占位卡——原始源码不可读也不必看，只给"在长"的感知 + 尾部几行代码打个样 */
function CodeStreamingCard({ content, language, title }: { content: string; language?: string; title: string }) {
  const { t } = useTranslation()
  const lines = content.split('\n')
  const kb = new TextEncoder().encode(content).length / 1024
  const tail = lines.slice(-6).join('\n')
  return (
    <div data-testid="code-streaming-card" className="flex-1 overflow-auto p-4">
      <div className="max-w-xl mx-auto rounded-lg border border-surface-150 dark:border-surface-100 bg-surface-50 dark:bg-surface-50/60 p-4 flex flex-col gap-3">
        <div className="flex items-center gap-2">
          <FileText size={14} className="text-brand-500 shrink-0" />
          <span className="text-[13px] font-medium text-surface-700 truncate flex-1">
            {title || t('artifacts.shell.generating')}
          </span>
          <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-surface-200 text-surface-500 shrink-0">
            {(language || 'code').toUpperCase()}
          </span>
        </div>
        <div className="flex items-center gap-1.5 text-[11px] text-surface-400">
          <Loader2 size={11} className="animate-spin text-brand-500" />
          {t('artifacts.shell.codeStreaming.progress', { lines: lines.length, size: kb.toFixed(1) })}
        </div>
        <pre className="text-[10px] font-mono text-surface-400 overflow-hidden whitespace-pre-wrap break-all leading-relaxed max-h-28">
          {tail}
        </pre>
        <div className="text-[11px] text-surface-400 leading-relaxed">
          {t('artifacts.shell.codeStreaming.description')}
        </div>
      </div>
    </div>
  )
}

// jsx 场景形状识别：动画引擎的标志性 API/组件，或 language 显式标注为 jsx
const SCENE_SHAPE_RE = /\b(useSprite|useTime)\s*\(|<Stage[\s>]/

/** 解析 `Object.assign(window, {...})` 花括号内的逗号分隔标识符；`Key: Value` 重命名形式取左键名 */
function parseAssignEntries(inner: string): string[] {
  return inner
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const renamed = /^([A-Za-z_$][\w$]*)\s*:/.exec(s)
      if (renamed) return renamed[1]
      const bare = /^([A-Za-z_$][\w$]*)/.exec(s)
      return bare ? bare[1] : null
    })
    .filter((s): s is string => !!s)
}

const SCENE_EXPORT_RE = /Object\.assign\(\s*window\s*,\s*\{([\s\S]*?)\}\s*\)/g

/** 从场景 jsx 源码里收集所有 `Object.assign(window, {...})` 暴露的组件名；默认根 = 最后一次出现里的最后一个标识符 */
function extractSceneExports(content: string): { names: string[]; defaultRoot: string } | null {
  SCENE_EXPORT_RE.lastIndex = 0
  const all: string[] = []
  let lastGroup: string[] = []
  let m: RegExpExecArray | null
  while ((m = SCENE_EXPORT_RE.exec(content)) !== null) {
    const names = parseAssignEntries(m[1])
    if (names.length) { all.push(...names); lastGroup = names }
  }
  if (!all.length) return null
  const seen = new Set<string>()
  const uniqNames = all.filter((n) => (seen.has(n) ? false : (seen.add(n), true)))
  return { names: uniqNames, defaultRoot: lastGroup[lastGroup.length - 1] }
}

/**
 * 合成最小 dc 薄壳，把场景 jsx 挂到 x-import 上——结构照抄 dc-render.spec.ts 的 MINI_ANIM
 * （已验证可渲染的动画薄壳模板）。from 链引用会话 sidecar 的编译 compiled.js，走 HtmlPreview
 * 现成的 inlineDcArtifactSiblings → loadCompiledArtifact IPC 管线，零新增。
 * 默认自动生成的 artifact id 本身就以 "artifact-" 开头（见 pi-tools.ts `artifact-${Date.now()}`），
 * 这里判断一次避免把前缀重复拼接成 "artifact-artifact-…"。
 */
function buildSceneShellHtml(rootName: string, artifactId: string): string {
  const fromId = /^artifact-/.test(artifactId) ? artifactId : `artifact-${artifactId}`
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><script src="./support.js"></script></head><body>
<x-dc><helmet><style>body{margin:0}</style></helmet>
<x-import component-from-global-scope="${rootName}" from="./animations.jsx ./${fromId}.jsx" width="1280" height="720" hint-size="100%,100%"></x-import>
</x-dc></body></html>`
}

/** jsx 场景合成预览：完成态场景 jsx 装进最小动画薄壳渲染，而不是滚原始代码。>1 个导出时给根组件切换 chips */
function SceneSynthPreview({ artifactId, exportNames, defaultRoot }: { artifactId: string; exportNames: string[]; defaultRoot: string }) {
  const { t } = useTranslation()
  const [root, setRoot] = useState(defaultRoot)
  useEffect(() => { setRoot(defaultRoot) }, [artifactId, defaultRoot])
  const shell = useMemo(() => buildSceneShellHtml(root, artifactId), [root, artifactId])
  return (
    <div className="flex-1 min-h-0 flex flex-col">
      {exportNames.length > 1 && (
        <div className="shrink-0 flex items-center gap-1 px-2 py-1 border-b border-surface-100 bg-surface-50/60">
          <span className="text-[10px] text-surface-400 mr-0.5">{t('artifacts.shell.scene.rootComponent')}</span>
          {exportNames.map((name) => (
            <button
              key={name}
              data-testid="scene-root-chip"
              onClick={() => setRoot(name)}
              className={[
                'h-5 px-2 rounded text-[11px] transition-colors',
                name === root
                  ? 'bg-brand-500 text-ink-on-accent'
                  : 'text-surface-500 hover:bg-surface-100'
              ].join(' ')}
            >
              {name}
            </button>
          ))}
          <div className="flex-1" />
          <span className="text-[10px] text-surface-400">{t('artifacts.shell.scene.previewHint')}</span>
        </div>
      )}
      <HtmlPreview content={shell} />
    </div>
  )
}

/**
 * Artifact 渲染 tab —— 复用 ArtifactPanel 内的 HtmlPreview/CodePreview/Markdown 渲染器。
 * artifactId === 'streaming' 时读取 streamingArtifact（流式生成中）。
 * artifactId 为真实 id 时从 artifacts 列表匹配。
 */
export function ArtifactTab({ artifactId }: { artifactId: string }) {
  const { t } = useTranslation()
  const artifacts = useArtifactStore(s => s.artifacts)
  const streaming = useArtifactStore(s => s.streamingArtifact)
  const [viewMode, setViewMode] = useState<ViewMode>('preview')
  const [exportMsg, setExportMsg] = useState<string | null>(null)
  // 导出弹窗：格式选择 + 目录（默认 ~/Downloads，用户改过就记住）
  const [exportOpen, setExportOpen] = useState(false)
  const [exportDir, setExportDir] = useState('')
  const [exportFmt, setExportFmt] = useState('')
  const [exporting, setExporting] = useState(false)
  // mp4 导出：逐帧进度（时长自动读取动画真实时长，见 dc-video-export.ts DOM 真值决策，无需用户输入）
  const [exportProgress, setExportProgress] = useState<{ done: number; total: number } | null>(null)
  // HtmlPreview 工具组（Reload/Tweaks/Comment）portal 到头行左侧，与 分享/预览/源码 同行
  const [previewToolbarHost, setPreviewToolbarHost] = useState<HTMLDivElement | null>(null)

  useEffect(() => {
    const api = (window as any).api
    if (!api?.onExportProgress) return
    const unsub = api.onExportProgress((p: { done: number; total: number }) => setExportProgress(p))
    return () => { try { unsub?.() } catch { /* ignore */ } }
  }, [])

  // Phase 5 Tweaks：iframe 里 tweak:set-keys 触发 → 合并后的新内容落盘
  // 不更新 artifactStore 避免 React 重渲染导致 iframe reload；切 tab 时会从磁盘 rehydrate
  const handleTweakEdit = async (aid: string, newContent: string): Promise<void> => {
    const saveApi = (window as any).api?.saveArtifact
    const convId = useChatStore.getState().activeConversationId
    const artifact = useArtifactStore.getState().artifacts.find(a => a.id === aid)
    if (!saveApi || !convId || !artifact) return
    try {
      await saveApi(convId, {
        id: artifact.id,
        type: artifact.type,
        title: artifact.title,
        content: newContent,
        language: (artifact as any).language
      })
    } catch (err) {
      console.warn('[Tweaks] 保存失败:', err)
    }
  }
  const codeRef = useRef<HTMLPreElement>(null)

  const { data, isStreaming } = useMemo(() => {
    if (artifactId === 'streaming' && streaming) {
      return { data: streaming, isStreaming: true }
    }
    const a = artifacts.find(x => x.id === artifactId)
    return { data: a || null, isStreaming: false }
  }, [artifactId, artifacts, streaming])

  useEffect(() => {
    if (viewMode === 'code' && codeRef.current) {
      codeRef.current.scrollTop = codeRef.current.scrollHeight
    }
  }, [data?.content, viewMode])

  if (!data) {
    return (
      <div className="flex-1 flex items-center justify-center text-surface-400 text-xs">
        {t('artifacts.shell.cleared')}
      </div>
    )
  }

  // markdown/document 源码可编辑(html 等仍走 iframe tweak 路径,不在此列)
  const editable = !isStreaming && (data.type === 'markdown' || data.type === 'document')

  // 设计系统画廊：只读展示，隐藏 预览/源码 切换并强制走 preview 渲染分支
  const isDesignSystem = data.type === 'design-system'

  // DC 设计交付物：导出为离线自足文件夹（会话内全部 dc artifact 一起装配）
  const isDcArtifact = !isStreaming && (data.type === 'html' || !data.type) && isDcHtml(data.content || '')
  const handleExport = async (): Promise<void> => {
    const all = useArtifactStore.getState().artifacts
      .filter(a => (a.type === 'html' || !a.type) && isDcHtml(a.content || ''))
      .map(a => ({ title: a.title || a.id, content: a.content || '', artifactId: a.id }))
    const projectName = (data.title || 'design').replace(/\.dc\.html?$/i, '').replace(/\.html?$/i, '') || 'design'
    const api = (window as any).api
    if (!api?.exportDcArtifacts) { setExportMsg(t('artifacts.shell.export.unavailable')); return }
    const res = await api.exportDcArtifacts(projectName, all)
    setExportMsg(res?.ok
      ? t('artifacts.shell.export.successFiles', { count: res.files?.length ?? 0, path: res.dir })
      : t('artifacts.shell.export.failed', { error: renderDisplayError(t, toDisplayError(res, 'artifacts.shell.export.unknownError')) }))
    setTimeout(() => setExportMsg(null), 8000)
  }
  // PDF 直出：复用 render_artifact 隐藏窗口装配 → printToPDF → ~/.openpipal/outputs/
  const handleExportPdf = async (): Promise<void> => {
    const api = (window as any).api
    if (!api?.exportArtifactPdf) { setExportMsg(t('artifacts.shell.export.pdfUnavailable')); return }
    const res = await api.exportArtifactPdf(data.title || data.id, data.content || '')
    setExportMsg(res?.ok
      ? t('artifacts.shell.export.successPdf', { path: res.path })
      : t('artifacts.shell.export.failed', { error: renderDisplayError(t, toDisplayError(res, 'artifacts.shell.export.unknownError')) }))
    setTimeout(() => setExportMsg(null), 8000)
  }
  // 编辑 → 更新 store(预览实时反映)+ 落盘(复用 saveArtifact)
  const handleMarkdownEdit = (newContent: string) => {
    useArtifactStore.getState().addArtifact({ ...data, content: newContent } as Artifact)
    handleTweakEdit(data.id, newContent)
  }

  const flash = (msg: string) => { setExportMsg(msg); setTimeout(() => setExportMsg(null), 8000) }

  // 源文件下载（code/svg/html/canvas）—— renderer 侧 Blob 下载，Electron/浏览器双模可用，无需新 API
  const downloadSource = (filename: string, content: string): void => {
    try {
      const blob = new Blob([content], { type: 'text/plain;charset=utf-8' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = filename
      document.body.appendChild(a)
      a.click()
      a.remove()
      setTimeout(() => URL.revokeObjectURL(url), 1000)
      flash(t('artifacts.shell.export.sourceDownloaded', { filename }))
    } catch (err: any) {
      flash(t('artifacts.shell.export.downloadFailed', { error: err?.message || t('artifacts.shell.export.unknownError') }))
    }
  }

  // 设计系统 → zip 打包分享。renderer 无 os.homedir，从 getMemoryConfig().globalDir
  // (=<home>/.openpipal/memory/global) 派生 .openpipal 基路径拼出 design-systems/<name> 绝对路径
  const shareDesignSystem = async (): Promise<void> => {
    const api = (window as any).api
    if (!api?.exportZip) { flash(t('artifacts.shell.export.zipUnavailable')); return }
    let dsName = ''
    try { const p = JSON.parse(data.content || '{}'); if (p && typeof p.name === 'string') dsName = p.name } catch { /* ignore */ }
    if (!dsName) { flash(t('artifacts.shell.export.invalidDesignSystem')); return }
    if (!api.getMemoryConfig) { flash(t('artifacts.shell.export.browserZipUnsupported')); return }
    let base = ''
    try {
      const cfg = await api.getMemoryConfig()
      const gd: string = cfg?.globalDir || ''
      const idx = gd.indexOf('.openpipal')
      if (idx >= 0) base = gd.slice(0, idx + '.openpipal'.length)
    } catch { /* ignore */ }
    if (!base) { flash(t('artifacts.shell.export.designSystemDirectoryMissing')); return }
    const res = await api.exportZip(`${base}/design-systems/${dsName}`, dsName)
    flash(res?.ok
      ? t('artifacts.shell.export.zipSuccess', { path: res.path })
      : t('artifacts.shell.export.shareFailed', { error: renderDisplayError(t, toDisplayError(res, 'artifacts.shell.export.unknownError')) }))
  }

  // 分享入口：按 artifact 类型路由到对应导出格式，复用 dc-export-msg 提示条回显
  const handleShare = async (): Promise<void> => {
    const type = (data.type || 'html') as string
    if (isDcArtifact) { await handleExport(); return }            // dc 交付物 → 离线文件夹
    if (type === 'document' || type === 'markdown') { await handleExportPdf(); return } // 文档 → PDF
    if (type === 'design-system') { await shareDesignSystem(); return }                 // 设计系统 → zip
    const extMap: Record<string, string> = { svg: 'svg', html: 'html', canvas: 'json', code: (data as any).language || 'txt' }
    if (type in extMap) {                                          // 代码/矢量/HTML/画布 → 下载源文件
      const base = (data.title || data.id).replace(/\.[^.]+$/, '')
      downloadSource(`${base}.${extMap[type]}`, data.content || '')
      return
    }
    flash(t('artifacts.shell.export.unsupportedShare'))
  }

  // questions/todos/goal/mcp-app 无可分享格式；其余类型显示统一"分享"入口
  const canShare = !isStreaming && !new Set(['questions', 'todos', 'goal', 'mcp-app']).has(data.type || 'html')

  // ---- 导出弹窗（对标官方 Claude Design 的 Share→Export：选格式 → 落 Downloads/记住的目录 → 访达显示）----
  const type = (data.type || 'html') as string
  const titleBase = (data.title || data.id).replace(/\.dc\.html?$/i, '').replace(/\.[^.]+$/, '') || 'artifact'
  // 动画 DC：加视频导出卡（逐帧确定性导出，无声）；deck DC：加 PPTX 导出卡（每页整幅截图，不可编辑）
  const isAnimationDc = isDcArtifact && looksLikeAnimationDc(data.content || '')
  const isDeckDc = isDcArtifact && looksLikeDeckDc(data.content || '')
  const exportOptions = getArtifactExportOptions(t, {
    type,
    language: (data as any).language,
    isDcArtifact,
    isAnimationDc,
    isDeckDc,
  })

  const openExport = async (): Promise<void> => {
    const api = (window as any).api
    if (!api?.exportArtifact) { await handleShare(); return } // 浏览器模式无主进程导出——沿用按类型直出
    setExportFmt(exportOptions[0]?.key || '')
    setExportOpen(o => !o)
    try {
      const r = await api.getExportDir?.()
      if (r?.dir) setExportDir(r.dir)
    } catch { /* ignore */ }
  }

  const changeExportDir = async (): Promise<void> => {
    try {
      const r = await (window as any).api?.chooseExportDir?.()
      if (r?.dir) setExportDir(r.dir)
    } catch { /* ignore */ }
  }

  const runExport = async (): Promise<void> => {
    const api = (window as any).api
    if (!api?.exportArtifact || exporting) return
    setExporting(true)
    setExportProgress(null)
    try {
      const fmt = exportFmt || exportOptions[0]?.key
      const req: any = { format: fmt, title: data.title || data.id, content: data.content || '', id: data.id }
      if (fmt === 'project-zip') {
        req.projectName = titleBase
        req.artifacts = useArtifactStore.getState().artifacts
          .filter(a => (a.type === 'html' || !a.type) && isDcHtml(a.content || ''))
          .map(a => ({ title: a.title || a.id, content: a.content || '' }))
      } else if (fmt === 'ds-zip') {
        try { req.dsName = JSON.parse(data.content || '{}')?.name } catch { /* ignore */ }
      } else if (fmt === 'source') {
        const ext = ({ svg: 'svg', html: 'html', canvas: 'json', code: (data as any).language || 'txt', markdown: 'md', document: 'md' } as Record<string, string>)[type] || 'txt'
        req.filename = `${titleBase}.${ext}`
      } else if (fmt === 'mp4') {
        req.fps = 30
      }
      const res = await api.exportArtifact(req)
      flash(res?.ok
        ? t('artifacts.shell.export.successReveal', { filename: (res.path || '').split('/').pop() })
        : t('artifacts.shell.export.failed', { error: renderDisplayError(t, toDisplayError(res, 'artifacts.shell.export.unknownError')) }))
    } finally {
      setExporting(false)
      setExportOpen(false)
      setExportProgress(null)
    }
  }

  return (
    <div className="flex-1 flex flex-col min-h-0">
      <div className="h-8 shrink-0 flex items-center justify-between px-2.5 border-b border-surface-100 bg-surface-0 dark:bg-surface-50">
        {/* 标题不再重复展示（tab 页签已带同名）——左侧让给 HtmlPreview 的工具组 portal 挂载点，
            Reload/Tweaks/Comment 与右侧 分享/预览/源码 合并成一行，省一行高度 */}
        <div className="flex items-center gap-1.5 text-xs text-surface-600 min-w-0">
          {isStreaming && <Loader2 size={11} className="animate-spin text-brand-500 shrink-0" />}
          <div ref={setPreviewToolbarHost} className="flex items-center gap-1.5 min-w-0" />
        </div>
        <div className="relative flex gap-0.5">
          {canShare && (
            <button
              onClick={() => void openExport()}
              data-testid="share-btn"
              title={t('artifacts.shell.shareTitle')}
              className="h-6 px-1.5 rounded flex items-center gap-1 text-[11px] text-surface-400 hover:bg-surface-50 transition-colors"
            >
              <Share2 size={11} /> {t('artifacts.shell.actions.share')}
            </button>
          )}
          {exportOpen && (
            <div
              data-testid="export-popover"
              className="op-menu absolute right-0 top-7 z-30 w-64 p-2"
            >
              <div className="text-[11px] font-medium text-surface-600 px-1 pb-1.5">{t('artifacts.shell.export.title')}</div>
              <div className="flex flex-col gap-1">
                {exportOptions.map(opt => (
                  <button
                    key={opt.key}
                    data-testid={`export-fmt-${opt.key}`}
                    onClick={() => setExportFmt(opt.key)}
                    className={[
                      'text-left px-2 py-1.5 rounded-md border transition-colors',
                      (exportFmt || exportOptions[0]?.key) === opt.key
                        ? 'border-brand-400 bg-brand-50/60 dark:bg-brand-900/20'
                        : 'border-surface-150 dark:border-surface-100 hover:bg-surface-50'
                    ].join(' ')}
                  >
                    <div className="text-[11px] font-medium text-surface-800">{opt.label}</div>
                    <div className="text-[10px] text-surface-400">{opt.desc}</div>
                  </button>
                ))}
              </div>
              {(exportFmt || exportOptions[0]?.key) === 'mp4' && (
                <div data-testid="export-mp4-duration-note" className="mt-2 px-1 text-[10px] text-surface-400">
                  {t('artifacts.shell.export.autoDuration')}
                </div>
              )}
              <div className="flex items-center gap-1 mt-2 px-1">
                <span className="text-[10px] text-surface-400 shrink-0">{t('artifacts.shell.export.saveTo')}</span>
                <span className="text-[10px] text-surface-600 truncate flex-1" title={exportDir}>
                  {exportDir.replace(/^\/Users\/[^/]+/, '~') || '~/Downloads'}
                </span>
                <button
                  onClick={() => void changeExportDir()}
                  data-testid="export-change-dir"
                  className="text-[10px] text-brand-600 dark:text-brand-400 hover:underline shrink-0"
                >
                  {t('artifacts.shell.actions.change')}
                </button>
              </div>
              <button
                onClick={() => void runExport()}
                disabled={exporting}
                data-testid="export-download-btn"
                className="mt-2 w-full h-7 rounded-md bg-surface-900 dark:bg-surface-700 text-white dark:text-surface-700 text-[11px] font-medium flex items-center justify-center gap-1 hover:opacity-90 disabled:opacity-50 transition-opacity"
              >
                <Download size={11} /> {exporting
                  ? (exportProgress
                      ? t('artifacts.shell.export.exportingProgress', { progress: Math.round((exportProgress.done / exportProgress.total) * 100) })
                      : t('artifacts.shell.export.exporting'))
                  : t('artifacts.shell.actions.download')}
              </button>
            </div>
          )}
          {!isDesignSystem && (
            <>
              <button
                onClick={() => setViewMode('preview')}
                className={[
                  'h-6 px-1.5 rounded flex items-center gap-1 text-[11px] transition-colors',
                  viewMode === 'preview'
                    ? 'bg-surface-100 text-surface-800'
                    : 'text-surface-400 hover:bg-surface-50'
                ].join(' ')}
              >
                <Eye size={11} /> {t('artifacts.shell.actions.preview')}
              </button>
              <button
                onClick={() => setViewMode('code')}
                className={[
                  'h-6 px-1.5 rounded flex items-center gap-1 text-[11px] transition-colors',
                  viewMode === 'code'
                    ? 'bg-surface-100 text-surface-800'
                    : 'text-surface-400 hover:bg-surface-50'
                ].join(' ')}
              >
                <Code2 size={11} /> {editable ? t('artifacts.shell.actions.edit') : t('artifacts.shell.actions.source')}
              </button>
            </>
          )}
        </div>
      </div>
      {exportMsg && (
        <div data-testid="dc-export-msg" className="shrink-0 px-2.5 py-1 text-[10px] text-brand-600 dark:text-brand-400 bg-brand-50 dark:bg-brand-900/20 border-b border-brand-100 dark:border-brand-800 truncate">
          {exportMsg}
        </div>
      )}

      {viewMode === 'code' && !isDesignSystem ? (
        editable ? (
          <MarkdownSourceEditor artifactId={data.id} content={data.content || ''} onSave={handleMarkdownEdit} />
        ) : (
          <pre
            ref={codeRef}
            className="flex-1 overflow-auto p-4 text-xs font-mono text-surface-700 bg-surface-50 whitespace-pre-wrap break-all leading-relaxed"
          >
            {data.content || ''}
            {isStreaming && <span className="inline-block w-1.5 h-4 bg-brand-500 animate-pulse ml-0.5 align-text-bottom" />}
          </pre>
        )
      ) : (
        <div className="flex-1 min-h-0 flex flex-col">
          {(() => {
            // streaming 刚开始时 type 可能还没赋值 → 默认 html
            const type = (data.type || 'html') as string
            const content = data.content || ''
            // 回执占位守卫：覆盖 html/svg/markdown 等所有分支（code 分支的 CodePreview 另有同款守卫，
            // 因为它还被 ArtifactPanel 复用）
            if (!isStreaming && isReceiptOnlyContent(content)) {
              return (
                <div className="flex-1 flex flex-col items-center justify-center px-6 text-center gap-2">
                  <span className="text-[13px] font-medium text-surface-600">{t('artifacts.invalidContent.title')}</span>
                  <span className="text-[12px] text-surface-400 leading-relaxed">
                    {t('artifacts.invalidContent.description')}
                    <br />{t('artifacts.invalidContent.regenerate', { title: stripDcSuffix(data.title) })}
                  </span>
                </div>
              )
            }
            switch (type) {
              case 'html':
              case 'svg':
                return (
                  <HtmlPreview
                    content={content}
                    streaming={isStreaming}
                    onContentEdit={(newContent) => handleTweakEdit(data.id, newContent)}
                    toolbarHost={previewToolbarHost}
                  />
                )
              case 'code': {
                const language = (data as any).language as string | undefined
                // 流式期间原始代码不可读也不必看——用生成进度卡代替全屏滚代码
                if (isStreaming) {
                  return <CodeStreamingCard content={content} language={language} title={data.title} />
                }
                // 完成态：动画场景 jsx（useSprite/useTime/<Stage> 或 language=jsx）尝试合成薄壳直接渲染预览，
                // 解析不到导出组件则回退原样源码视图（普通 python/ts 等代码走这条，行为不变）
                const looksScene = SCENE_SHAPE_RE.test(content) || (language || '').toLowerCase() === 'jsx'
                const sceneExports = looksScene ? extractSceneExports(content) : null
                if (sceneExports) {
                  return <SceneSynthPreview artifactId={data.id} exportNames={sceneExports.names} defaultRoot={sceneExports.defaultRoot} />
                }
                return <CodePreview content={content} language={language} title={data.title} />
              }
              case 'markdown':
                return (
                  <div className="flex-1 overflow-auto p-4 prose-light">
                    <Markdown content={content} />
                  </div>
                )
              case 'document':
                // 占位：文档类 artifact（未来接富文本编辑器/结构化文档渲染）
                // 降级显示 content 作为 markdown，保证内容不丢
                return (
                  <div className="flex-1 flex flex-col min-h-0">
                    <div className="shrink-0 px-4 py-2 text-[11px] text-amber-600 dark:text-amber-400 bg-amber-50 dark:bg-amber-900/20 border-b border-amber-200 dark:border-amber-800 flex items-center gap-1.5">
                      <FileText size={12} /> {t('artifacts.shell.documentFallback')}
                    </div>
                    <div className="flex-1 overflow-auto p-4 prose-light">
                      <Markdown content={content} />
                    </div>
                  </div>
                )
              case 'questions':
                return <QuestionsArtifactView
                  artifactId={data.id}
                  fallbackTitle={data.titleKey ? t(data.titleKey) : data.title}
                  content={content}
                  streaming={isStreaming}
                />
              case 'todos':
                return <TodosArtifactView content={content} />
              case 'mcp-app':
                return <McpAppPreview content={content} />
              case 'canvas':
                return (
                  <Suspense
                    fallback={
                      <div className="flex-1 min-h-0 relative overflow-hidden flex items-center justify-center">
                        <Loader2 size={20} className="animate-spin text-brand-500" />
                      </div>
                    }
                  >
                    <CanvasArtifact
                      artifactId={data.id}
                      content={content}
                      onSave={handleTweakEdit}
                    />
                  </Suspense>
                )
              case 'goal':
                return <GoalTab content={content} />
              case 'design-system': {
                // content = JSON.stringify({ name })；parse 失败/无 name → 占位错误
                let dsName = ''
                try {
                  const parsed = JSON.parse(content || '{}')
                  if (parsed && typeof parsed.name === 'string') dsName = parsed.name
                } catch { /* 降级为空 name */ }
                if (!dsName) {
                  return <div className="flex-1 flex items-center justify-center text-xs text-surface-400">{t('artifacts.shell.designSystemInvalid')}</div>
                }
                return <DesignSystemView name={dsName} />
              }
              default:
                return <div className="p-4 text-surface-400 text-sm">{t('artifacts.shell.unsupportedType', { type })}</div>
            }
          })()}
        </div>
      )}
    </div>
  )
}

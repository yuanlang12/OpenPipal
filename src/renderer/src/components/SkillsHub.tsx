import { useState, useEffect, useMemo, useCallback, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { Search, ArrowLeft, FileText, Code, Zap, ExternalLink, FolderOpen, File, Image, Download, X, GitBranch, Trash2 } from 'lucide-react'
import { Markdown } from './shared/Markdown'
import { toDisplayError, type DisplayError } from '../utils/mainError'

/** 技能来源 —— main 侧 skills:list / skills:get-details 新增字段，标记 optional 以兼容尚未补齐该字段的返回值 */
type SkillSource = 'builtin' | 'user' | 'plugin' | 'mcp'

export interface SkillMeta { name: string; description: string; category?: string; dir: string; builtIn: boolean; enabled: boolean; mcpServer?: string; pluginName?: string; source?: SkillSource }

interface SkillFileNode {
  path: string
  name: string
  size: number
  content?: string
  isBinary?: boolean
}

interface SkillDetails {
  name: string
  description: string
  dir: string
  builtIn: boolean
  enabled: boolean
  mcpServer?: string
  pluginName?: string
  source?: SkillSource
  files: SkillFileNode[]
}

/** 技能来源判定 —— 优先用 source 字段，缺失时（如 getSkillDetails 尚未补齐）退回旧启发式 */
function skillOrigin(s: { source?: SkillSource; builtIn?: boolean; mcpServer?: string; pluginName?: string }): SkillSource {
  if (s.source) return s.source
  if (s.builtIn) return 'builtin'
  if (s.pluginName) return 'plugin'
  if (s.mcpServer) return 'mcp'
  return 'user'
}

// ======== 导入技能 ========

type ImportSourcePayload = { type: 'folder'; path: string } | { type: 'github'; url: string }
type ImportConflict = 'none' | 'user' | 'builtin' | 'plugin' | 'mcp'
interface ImportCandidate { name: string; description: string; conflict: ImportConflict }
type ImportScanResult =
  | { ok: true; scanId: string; candidates: ImportCandidate[] }
  | { ok: false; error: string }
type ImportApplyResult =
  | { ok: true; installed: string[]; skipped: string[] }
  | { ok: false; error: string }

// 根据文件扩展名选择渲染方式
function getFileLanguage(filename: string): string | null {
  const ext = filename.slice(filename.lastIndexOf('.')).toLowerCase()
  const map: Record<string, string> = {
    '.py': 'python', '.js': 'javascript', '.ts': 'typescript',
    '.json': 'json', '.yaml': 'yaml', '.yml': 'yaml',
    '.sh': 'bash', '.css': 'css', '.html': 'html',
    '.toml': 'toml', '.cfg': 'ini', '.ini': 'ini'
  }
  return map[ext] || null
}

function isMarkdownFile(filename: string): boolean {
  return filename.endsWith('.md') || filename.endsWith('.txt')
}

// 把 flat 文件列表按目录分组
function groupFilesByDir(files: SkillFileNode[]): { dir: string; files: SkillFileNode[] }[] {
  const groups = new Map<string, SkillFileNode[]>()
  for (const f of files) {
    const slash = f.path.lastIndexOf('/')
    const dir = slash >= 0 ? f.path.slice(0, slash) : ''
    if (!groups.has(dir)) groups.set(dir, [])
    groups.get(dir)!.push(f)
  }
  // 根目录在最前，其余按目录名排序
  const sorted = Array.from(groups.entries()).sort((a, b) => {
    if (a[0] === '') return -1
    if (b[0] === '') return 1
    return a[0].localeCompare(b[0])
  })
  return sorted.map(([dir, files]) => ({ dir, files }))
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

// ======== 主组件 ========

export function SkillsHub() {
  const { t } = useTranslation()
  const [skills, setSkills] = useState<SkillMeta[]>([])
  const [search, setSearch] = useState('')
  const [loading, setLoading] = useState(true)
  const [selectedSkill, setSelectedSkill] = useState<string | null>(null)
  const [showImport, setShowImport] = useState(false)
  const [confirmDeleteName, setConfirmDeleteName] = useState<string | null>(null)
  const [feedback, setFeedback] = useState<{ key?: string; values?: Record<string, unknown>; raw?: string; kind: 'success' | 'error' } | null>(null)
  const feedbackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const flashFeedback = useCallback((message: { key?: string; values?: Record<string, unknown>; raw?: string }, kind: 'success' | 'error' = 'success') => {
    setFeedback({ ...message, kind })
    if (feedbackTimerRef.current) clearTimeout(feedbackTimerRef.current)
    feedbackTimerRef.current = setTimeout(() => setFeedback(null), 3000)
  }, [])
  useEffect(() => () => { if (feedbackTimerRef.current) clearTimeout(feedbackTimerRef.current) }, [])

  const refreshSkills = useCallback(async () => {
    const list: SkillMeta[] = await window.api.listSkills()
    setSkills(list)
  }, [])

  useEffect(() => { refreshSkills().then(() => setLoading(false)).catch(() => setLoading(false)) }, [refreshSkills])

  const toggleSkill = async (name: string, currentEnabled: boolean) => {
    await window.api.setSkillDisabled(name, currentEnabled)
    await refreshSkills()
  }

  const handleDelete = useCallback(async (name: string): Promise<{ ok: boolean; error?: string }> => {
    const res = await window.api.deleteSkill(name)
    setConfirmDeleteName(null)
    if (res.ok) {
      await refreshSkills()
      flashFeedback({ key: 'toolsHub.skills.deleted', values: { name } })
    } else {
      flashFeedback(toDisplayError(res, 'toolsHub.skills.deleteFailed'), 'error')
    }
    return res
  }, [refreshSkills, flashFeedback])

  const handleImported = useCallback(async (installed: string[], skipped: string[]) => {
    setShowImport(false)
    await refreshSkills()
    flashFeedback({
      key: skipped.length > 0 ? 'toolsHub.skills.importedWithSkipped' : 'toolsHub.skills.imported',
      values: { installedCount: installed.length, skippedCount: skipped.length },
    })
  }, [refreshSkills, flashFeedback])

  const filtered = useMemo(() =>
    skills.filter(s => s.name.toLowerCase().includes(search.toLowerCase()) || s.description.toLowerCase().includes(search.toLowerCase())),
    [skills, search]
  )

  // 详情视图
  if (selectedSkill) {
    return <SkillDetailView name={selectedSkill} onBack={() => setSelectedSkill(null)} onToggle={toggleSkill} onDelete={handleDelete} />
  }

  // 列表视图
  return (
    <div className="space-y-4">
      <div className="flex flex-col sm:flex-row sm:items-center gap-2">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-surface-300" />
          <input type="text" placeholder={t('toolsHub.skills.searchPlaceholder')} aria-label={t('toolsHub.skills.searchLabel')} value={search} onChange={e => setSearch(e.target.value)}
            className="w-full pl-10 pr-4 py-2.5 rounded-md bg-surface-0 dark:bg-surface-50 border border-surface-100 text-[13px] text-surface-600 placeholder:text-surface-300 focus:outline-none focus:border-brand-300 focus:ring-1 focus:ring-brand-100 transition-colors" />
        </div>
        <button onClick={() => setShowImport(true)}
          className="shrink-0 flex items-center gap-1.5 px-3 py-2.5 rounded-md border border-surface-100 text-[12px] font-medium text-surface-500 hover:border-brand-200 dark:hover:border-brand-700 hover:text-brand-600 dark:hover:text-brand-400 transition-colors">
          <Download className="w-3.5 h-3.5" />
          {t('toolsHub.skills.import')}
        </button>
      </div>

      {feedback && (
        <div role="status" className={`px-3 py-2 rounded-md text-[12px] break-words ${feedback.kind === 'error' ? 'bg-red-50 dark:bg-red-900/20 text-red-600 dark:text-red-300' : 'bg-brand-50 dark:bg-brand-900/20 text-brand-600 dark:text-brand-300'}`}>
          {feedback.raw || (feedback.key ? t(feedback.key, feedback.values) : '')}
        </div>
      )}

      <div className="flex items-center gap-3 text-[11px] text-surface-400">
        <span>{t('toolsHub.skills.totalCount', { count: skills.length })}</span>
        <span>·</span>
        <span>{t('toolsHub.skills.enabledCount', { count: skills.filter(s => s.enabled).length })}</span>
      </div>

      {loading ? (
        <div className="py-16 text-center text-surface-300 text-[13px]">{t('common.status.loading')}</div>
      ) : filtered.length === 0 ? (
        <div className="py-16 text-center text-surface-300 text-[13px]">{t('toolsHub.skills.noMatches')}</div>
      ) : (
        <div className="space-y-2">
          {filtered.map(skill => {
            const origin = skillOrigin(skill)
            return (
            <div key={skill.name}
              className="flex flex-wrap items-center gap-4 p-4 rounded-lg border border-surface-100 hover:border-brand-200 dark:hover:border-brand-700 transition-colors group">
              <button onClick={() => setSelectedSkill(skill.name)} className="flex-1 min-w-0 text-left rounded focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-300">
                <span className="flex items-center gap-2">
                  <span className="text-[13px] font-semibold text-surface-700 truncate" title={skill.name}>{skill.name}</span>
                  {origin === 'builtin' ? (
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-surface-100 text-surface-400">{t('toolsHub.badges.builtIn')}</span>
                  ) : origin === 'plugin' ? (
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-brand-50 dark:bg-brand-900/30 text-brand-600 dark:text-brand-300 truncate max-w-full" title={t('toolsHub.skills.pluginOriginTitle', { name: skill.pluginName })}>
                      {t('toolsHub.badges.pluginWithName', { name: skill.pluginName })}
                    </span>
                  ) : origin === 'mcp' ? (
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-brand-50 dark:bg-brand-900/30 text-brand-600 dark:text-brand-300 truncate max-w-full" title={t('toolsHub.skills.mcpOriginTitle', { name: skill.mcpServer })}>
                      {t('toolsHub.badges.mcpWithName', { name: skill.mcpServer })}
                    </span>
                  ) : (
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-surface-50 text-surface-400 border border-surface-100">{t('toolsHub.badges.custom')}</span>
                  )}
                </span>
                {skill.description && <span className="block text-[12px] text-surface-400 line-clamp-2 mt-0.5">{skill.description}</span>}
              </button>
              {origin === 'user' && (
                confirmDeleteName === skill.name ? (
                  <div className="flex items-center gap-1.5 shrink-0" onClick={e => e.stopPropagation()}>
                    <span className="text-[11px] text-surface-400">{t('common.confirmDelete')}</span>
                    <button onClick={() => handleDelete(skill.name)} className="text-[11px] text-red-500 hover:text-red-600 font-medium">{t('common.actions.delete')}</button>
                    <button onClick={() => setConfirmDeleteName(null)} className="text-[11px] text-surface-400 hover:text-surface-600">{t('common.actions.cancel')}</button>
                  </div>
                ) : (
                  <button onClick={(e) => { e.stopPropagation(); setConfirmDeleteName(skill.name); setTimeout(() => setConfirmDeleteName(n => n === skill.name ? null : n), 4000) }}
                    className="shrink-0 p-1.5 rounded hover:bg-surface-100 transition-colors" title={t('toolsHub.skills.deleteNamed', { name: skill.name })}>
                    <Trash2 className="w-3.5 h-3.5 text-surface-300 hover:text-red-400" />
                  </button>
                )
              )}
              <button onClick={(e) => { e.stopPropagation(); toggleSkill(skill.name, skill.enabled) }}
                role="switch" aria-checked={skill.enabled} aria-label={t('toolsHub.skills.toggleNamed', { name: skill.name })}
                className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full transition-colors duration-200 ${skill.enabled ? 'bg-brand-500' : 'bg-surface-200'}`}>
                <span className={`pointer-events-none inline-block h-5 w-5 mt-0.5 transform rounded-full bg-white shadow transition duration-200 ${skill.enabled ? 'translate-x-[22px]' : 'translate-x-0.5'}`} />
              </button>
            </div>
            )
          })}
        </div>
      )}

      <div className="mt-4 p-4 rounded-lg bg-surface-50 border border-surface-100">
        <p className="text-[11px] text-surface-400 leading-relaxed">
          {t('toolsHub.skills.infoPrefix')} <code className="px-1 py-0.5 bg-surface-100 rounded text-brand-600 text-[10px] break-all">~/.openpipal/skills/</code> {t('toolsHub.skills.infoSuffix')}
        </p>
      </div>

      {showImport && <ImportSkillsModal onClose={() => setShowImport(false)} onImported={handleImported} />}
    </div>
  )
}

// ======== 导入技能弹层 ========

function ImportSkillsModal({ onClose, onImported }: {
  onClose: () => void
  onImported: (installed: string[], skipped: string[]) => void
}) {
  const { t } = useTranslation()
  const [step, setStep] = useState<'source' | 'candidates'>('source')
  const [githubMode, setGithubMode] = useState(false)
  const [githubUrl, setGithubUrl] = useState('')
  const [scanning, setScanning] = useState(false)
  const [applying, setApplying] = useState(false)
  const [error, setError] = useState<DisplayError | null>(null)
  const [scanId, setScanId] = useState<string | null>(null)
  const [candidates, setCandidates] = useState<ImportCandidate[]>([])
  const [selected, setSelected] = useState<Set<string>>(new Set())

  const runScan = useCallback(async (source: ImportSourcePayload) => {
    setScanning(true)
    setError(null)
    try {
      const res: ImportScanResult = await window.api.importScanSkills(source)
      if (res.ok) {
        setScanId(res.scanId)
        setCandidates(res.candidates)
        setSelected(new Set(res.candidates.filter(c => c.conflict !== 'builtin').map(c => c.name)))
        setStep('candidates')
      } else {
        setError(toDisplayError(res, 'toolsHub.skills.scanFailed'))
      }
    } catch (e) {
      setError(e instanceof Error ? { raw: e.message } : { key: 'toolsHub.skills.scanFailed' })
    } finally {
      setScanning(false)
    }
  }, [])

  const handlePickFolder = useCallback(async () => {
    const path = await window.api.selectDirectory()
    if (!path) return
    await runScan({ type: 'folder', path })
  }, [runScan])

  const handleGithubConfirm = useCallback(async () => {
    const url = githubUrl.trim()
    if (!url) return
    await runScan({ type: 'github', url })
  }, [githubUrl, runScan])

  const toggle = useCallback((name: string) => {
    setSelected(prev => {
      const next = new Set(prev)
      if (next.has(name)) next.delete(name)
      else next.add(name)
      return next
    })
  }, [])

  const handleApply = useCallback(async () => {
    if (!scanId) return
    const names = candidates.filter(c => selected.has(c.name)).map(c => c.name)
    if (names.length === 0) return
    const overwrite = candidates.some(c => selected.has(c.name) && c.conflict === 'user')
    setApplying(true)
    setError(null)
    try {
      const res: ImportApplyResult = await window.api.importApplySkills({ scanId, names, overwrite })
      if (res.ok) {
        onImported(res.installed, res.skipped)
      } else {
        setError(toDisplayError(res, 'toolsHub.skills.importFailed'))
      }
    } catch (e) {
      setError(e instanceof Error ? { raw: e.message } : { key: 'toolsHub.skills.importFailed' })
    } finally {
      setApplying(false)
    }
  }, [scanId, candidates, selected, onImported])

  const busy = scanning || applying

  return (
    <div className="fixed inset-0 z-[60] bg-black/40 dark:bg-black/60 flex items-center justify-center p-4" onClick={() => !busy && onClose()}>
      <div role="dialog" aria-modal="true" aria-labelledby="import-skills-title" className="bg-surface-0 dark:bg-surface-50 rounded-xl shadow-2xl border border-surface-100 w-full max-w-[440px] max-h-[80vh] flex flex-col overflow-hidden animate-fade-in" onClick={e => e.stopPropagation()}>
        <div className="px-4 py-3 border-b border-surface-100 flex items-center justify-between shrink-0">
          <h3 id="import-skills-title" className="text-[13px] font-semibold text-surface-700">
            {step === 'source' ? t('toolsHub.skills.import') : t('toolsHub.skills.selectToImport')}
          </h3>
          <button aria-label={t('common.actions.close')} onClick={onClose} disabled={busy} className="p-1 rounded hover:bg-surface-100 disabled:opacity-40 transition-colors">
            <X className="w-4 h-4 text-surface-400" />
          </button>
        </div>

        <div className="px-4 py-3 overflow-y-auto flex-1">
          {step === 'source' ? (
            <div className="space-y-2">
              <button onClick={handlePickFolder} disabled={busy}
                className="w-full flex items-center gap-2.5 px-3 py-2.5 rounded-lg border border-surface-100 hover:border-brand-200 dark:hover:border-brand-700 text-[12px] text-surface-600 disabled:opacity-50 transition-colors">
                <FolderOpen className="w-4 h-4 text-surface-400 shrink-0" />
                {t('toolsHub.skills.fromLocalFolder')}
              </button>

              {!githubMode ? (
                <button onClick={() => setGithubMode(true)} disabled={busy}
                  className="w-full flex items-center gap-2.5 px-3 py-2.5 rounded-lg border border-surface-100 hover:border-brand-200 dark:hover:border-brand-700 text-[12px] text-surface-600 disabled:opacity-50 transition-colors">
                  <GitBranch className="w-4 h-4 text-surface-400 shrink-0" />
                  {t('toolsHub.skills.fromGithub')}
                </button>
              ) : (
                <div className="p-3 rounded-lg border border-surface-100 space-y-2">
                  <input value={githubUrl} onChange={e => setGithubUrl(e.target.value)} disabled={busy} autoFocus
                    placeholder="https://github.com/anthropics/skills"
                    className="w-full px-3 py-1.5 text-[12px] rounded-md border border-surface-200 bg-white dark:bg-surface-0 text-surface-700 placeholder:text-surface-300 focus:outline-none focus:border-brand-400 focus:ring-1 focus:ring-brand-100 disabled:opacity-50" />
                  <div className="flex gap-2">
                    <button onClick={handleGithubConfirm} disabled={busy || !githubUrl.trim()}
                      className="flex-1 px-3 py-1.5 text-[12px] font-medium rounded-md bg-brand-500 hover:bg-brand-600 text-ink-on-accent disabled:opacity-50 transition-colors">
                      {scanning ? t('toolsHub.skills.scanning') : t('common.actions.confirm')}
                    </button>
                    <button onClick={() => { setGithubMode(false); setGithubUrl('') }} disabled={busy}
                      className="px-3 py-1.5 text-[12px] rounded-md border border-surface-200 text-surface-500 hover:bg-surface-50 disabled:opacity-50 transition-colors">
                      {t('common.actions.cancel')}
                    </button>
                  </div>
                </div>
              )}

              {scanning && !githubMode && <p className="text-[11px] text-surface-400">{t('toolsHub.skills.scanning')}</p>}
              {error && <p role="alert" className="text-[11px] text-red-500 whitespace-pre-wrap leading-relaxed break-words">{error.raw || (error.key ? t(error.key, error.values) : '')}</p>}
            </div>
          ) : (
            <div className="space-y-2">
              {candidates.length === 0 ? (
                <p className="text-[12px] text-surface-400 text-center py-6">{t('toolsHub.skills.noImportCandidates')}</p>
              ) : candidates.map(c => {
                const disabled = c.conflict === 'builtin'
                return (
                  <label key={c.name}
                    className={`flex items-start gap-2.5 p-2.5 rounded-lg border border-surface-100 dark:border-surface-100 transition-colors ${disabled ? 'opacity-50' : 'cursor-pointer hover:border-brand-200 dark:hover:border-brand-700'}`}>
                    <input type="checkbox" checked={selected.has(c.name)} disabled={disabled} onChange={() => toggle(c.name)}
                      className="sw-checkbox mt-0.5" />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="min-w-0 break-all text-[12px] font-medium text-surface-700">{c.name}</span>
                        {c.conflict === 'builtin' && <span className="text-[10px] text-surface-400">{t('toolsHub.skills.conflicts.builtIn')}</span>}
                        {c.conflict === 'user' && <span className="text-[10px] text-amber-600 dark:text-amber-400">{t('toolsHub.skills.conflicts.user')}</span>}
                        {c.conflict === 'plugin' && <span className="text-[10px] text-amber-600 dark:text-amber-400">{t('toolsHub.skills.conflicts.plugin')}</span>}
                        {c.conflict === 'mcp' && <span className="text-[10px] text-surface-400">{t('toolsHub.skills.conflicts.mcp')}</span>}
                      </div>
                      {c.description && <p className="text-[11px] text-surface-400 mt-0.5 line-clamp-2">{c.description}</p>}
                    </div>
                  </label>
                )
              })}
              {error && <p role="alert" className="text-[11px] text-red-500 whitespace-pre-wrap leading-relaxed break-words">{error.raw || (error.key ? t(error.key, error.values) : '')}</p>}
            </div>
          )}
        </div>

        {step === 'candidates' && (
          <div className="px-4 py-3 border-t border-surface-100 flex items-center gap-2 shrink-0">
            <button onClick={() => { setStep('source'); setError(null) }} disabled={applying}
              className="px-3 py-1.5 text-[12px] rounded-md border border-surface-200 text-surface-500 hover:bg-surface-50 disabled:opacity-50 transition-colors">
              {t('common.actions.back')}
            </button>
            <button onClick={handleApply} disabled={applying || selected.size === 0}
              className="flex-1 px-3 py-1.5 text-[12px] font-medium rounded-md bg-brand-500 hover:bg-brand-600 text-ink-on-accent disabled:opacity-50 transition-colors">
              {applying ? t('toolsHub.skills.importing') : t('toolsHub.skills.importSelected', { count: selected.size })}
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

// ======== 详情视图 ========

function SkillDetailView({ name, onBack, onToggle, onDelete }: {
  name: string
  onBack: () => void
  onToggle: (name: string, enabled: boolean) => Promise<void>
  onDelete: (name: string) => Promise<{ ok: boolean; error?: string }>
}) {
  const { t } = useTranslation()
  const [details, setDetails] = useState<SkillDetails | null>(null)
  const [loading, setLoading] = useState(true)
  const [selectedFile, setSelectedFile] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)

  useEffect(() => {
    setLoading(true)
    setSelectedFile(null)
    window.api.getSkillDetails?.(name)
      .then((d: SkillDetails | null) => {
        setDetails(d)
        // 默认选中 SKILL.md
        if (d?.files.some(f => f.path === 'SKILL.md')) setSelectedFile('SKILL.md')
        setLoading(false)
      })
      .catch(() => setLoading(false))
  }, [name])

  const handleToggle = useCallback(async () => {
    if (!details) return
    await onToggle(details.name, details.enabled)
    // 刷新 enabled 状态
    const updated = await window.api.getSkillDetails?.(name)
    if (updated) setDetails(updated)
  }, [details, name, onToggle])

  const handleReveal = useCallback(async () => {
    if (!details?.dir) return
    await window.api.revealFile?.(details.dir)
  }, [details])

  const handleDeleteClick = useCallback(async () => {
    if (!details) return
    const res = await onDelete(details.name)
    if (res.ok) onBack()
    else setConfirmDelete(false)
  }, [details, onDelete, onBack])

  if (loading) return <div className="py-16 text-center text-surface-300 text-[13px]">{t('common.status.loading')}</div>
  if (!details) return <div className="py-16 text-center text-surface-300 text-[13px]">{t('toolsHub.skills.notFound')}</div>

  const groups = groupFilesByDir(details.files)
  const selectedNode = details.files.find(f => f.path === selectedFile)
  const origin = skillOrigin(details)

  return (
    <div className="space-y-0">
      {/* 头部：返回 + 技能名 + 开关 */}
      <div className="flex flex-wrap items-center gap-3 mb-4">
        <button onClick={onBack} className="p-1.5 rounded hover:bg-surface-100 transition-colors" title={t('toolsHub.skills.backToList')}>
          <ArrowLeft className="w-4 h-4 text-surface-400" />
        </button>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <Zap className="w-4 h-4 text-brand-500" />
            <h3 className="text-[14px] font-semibold text-surface-700 truncate" title={details.name}>{details.name}</h3>
            {origin === 'builtin' ? (
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-surface-100 text-surface-400">{t('toolsHub.badges.builtIn')}</span>
            ) : origin === 'plugin' ? (
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-brand-50 dark:bg-brand-900/30 text-brand-600 dark:text-brand-300 truncate max-w-full" title={t('toolsHub.skills.providedByPlugin', { name: details.pluginName })}>
                {t('toolsHub.badges.pluginWithName', { name: details.pluginName })}
              </span>
            ) : origin === 'mcp' ? (
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-brand-50 dark:bg-brand-900/30 text-brand-600 dark:text-brand-300 truncate max-w-full" title={t('toolsHub.skills.providedByMcp', { name: details.mcpServer })}>
                {t('toolsHub.badges.mcpWithName', { name: details.mcpServer })}
              </span>
            ) : (
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-surface-50 text-surface-400 border border-surface-100">{t('toolsHub.badges.custom')}</span>
            )}
          </div>
          <p className="text-[11px] text-surface-400 line-clamp-2 mt-0.5">{details.description}</p>
        </div>
        {origin === 'user' && (
          confirmDelete ? (
            <div className="flex items-center gap-1.5 shrink-0">
              <span className="text-[11px] text-surface-400">{t('common.confirmDelete')}</span>
              <button onClick={handleDeleteClick} className="text-[11px] text-red-500 hover:text-red-600 font-medium">{t('common.actions.delete')}</button>
              <button onClick={() => setConfirmDelete(false)} className="text-[11px] text-surface-400 hover:text-surface-600">{t('common.actions.cancel')}</button>
            </div>
          ) : (
            <button onClick={() => { setConfirmDelete(true); setTimeout(() => setConfirmDelete(false), 4000) }}
              className="p-1.5 rounded hover:bg-surface-100 transition-colors" title={t('toolsHub.skills.deleteNamed', { name: details.name })}>
              <Trash2 className="w-3.5 h-3.5 text-surface-400 hover:text-red-400" />
            </button>
          )
        )}
        <button onClick={handleReveal} className="p-1.5 rounded hover:bg-surface-100 transition-colors" title={t('toolsHub.skills.openInFinder')}>
          <ExternalLink className="w-3.5 h-3.5 text-surface-400" />
        </button>
        <button onClick={handleToggle}
          role="switch" aria-checked={details.enabled} aria-label={t('toolsHub.skills.toggleNamed', { name: details.name })}
          className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full transition-colors duration-200 ${details.enabled ? 'bg-brand-500' : 'bg-surface-200'}`}>
          <span className={`pointer-events-none inline-block h-5 w-5 mt-0.5 transform rounded-full bg-white shadow transition duration-200 ${details.enabled ? 'translate-x-[22px]' : 'translate-x-0.5'}`} />
        </button>
      </div>

      {/* 文件树 */}
      <div className="rounded-lg border border-surface-100 overflow-hidden">
        <div className="px-3 py-2 bg-surface-50 border-b border-surface-100 flex items-center justify-between">
          <span className="text-[11px] font-medium text-surface-500">
            {t('toolsHub.skills.fileCount', { count: details.files.length })}
          </span>
          <span className="text-[10px] text-surface-300 font-mono truncate max-w-[60%]" title={details.dir}>
            {details.dir?.replace(/^.*\/(resources|\.openpipal)\//, '$1/')}
          </span>
        </div>
        <div className="max-h-56 overflow-y-auto">
          {groups.map(({ dir, files }) => (
            <div key={dir || '__root'}>
              {dir && (
                <div className="px-3 py-1 flex items-center gap-1.5 text-[10px] text-surface-300 font-medium bg-surface-50/50">
                  <FolderOpen className="w-3 h-3" />
                  {dir}/
                </div>
              )}
              {files.map(f => (
                <button key={f.path} onClick={() => setSelectedFile(f.path)}
                  aria-current={selectedFile === f.path ? 'true' : undefined}
                  className={`w-full flex items-center gap-1.5 px-3 py-1.5 text-[11px] transition-colors text-left ${
                    dir ? 'pl-6' : ''
                  } ${
                    selectedFile === f.path
                      ? 'bg-brand-50 dark:bg-brand-900/20 text-brand-600 dark:text-brand-400'
                      : 'text-surface-500 hover:bg-surface-50 dark:hover:bg-surface-50/50'
                  }`}>
                  {f.isBinary
                    ? <Image className="w-3 h-3 shrink-0 opacity-60" />
                    : isMarkdownFile(f.name)
                      ? <FileText className="w-3 h-3 shrink-0 opacity-60" />
                      : <Code className="w-3 h-3 shrink-0 opacity-60" />
                  }
                  <span className="truncate font-mono flex-1">{f.name}</span>
                  <span className="text-[9px] text-surface-300 shrink-0">{formatSize(f.size)}</span>
                </button>
              ))}
            </div>
          ))}
        </div>
      </div>

      {/* 文件内容预览 */}
      <div className="mt-3 rounded-lg border border-surface-100 overflow-hidden">
        {selectedNode ? (
          <>
            <div className="flex items-center gap-1.5 px-3 py-2 bg-surface-50 border-b border-surface-100">
              <File className="w-3 h-3 text-surface-400" />
              <span className="flex-1 min-w-0 truncate text-[11px] font-mono text-surface-500" title={selectedNode.path}>{selectedNode.path}</span>
            </div>
            <div className="p-3 max-h-[50vh] overflow-y-auto">
              {selectedNode.isBinary ? (
                <p className="text-[11px] text-surface-300 italic">{t('toolsHub.skills.binaryFile', { size: formatSize(selectedNode.size) })}</p>
              ) : isMarkdownFile(selectedNode.name) ? (
                <div className="prose-light text-[12px] [&_h1]:text-[14px] [&_h2]:text-[13px] [&_h3]:text-[12px] [&_p]:text-[12px]">
                  <Markdown content={selectedNode.content || ''} />
                </div>
              ) : (
                <pre className="text-[11px] leading-relaxed font-mono text-surface-600 whitespace-pre-wrap break-words overflow-x-auto">
                  <code>{selectedNode.content || ''}</code>
                </pre>
              )}
            </div>
          </>
        ) : (
          <p className="text-[11px] text-surface-300 text-center py-8">
            {t('toolsHub.skills.selectFileHint')}
          </p>
        )}
      </div>
    </div>
  )
}

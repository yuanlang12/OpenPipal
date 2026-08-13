/**
 * MemorySettings — 全局记忆管理面板
 * 设置页的"记忆"tab，展示/管理 ~/.openpipal/memory/global/ 下的记忆文件。
 */

import { useState, useEffect, useCallback } from 'react'
import { Trash2, RefreshCw, ChevronDown, ChevronRight, FolderOpen } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { formatLocaleDate, formatRelativeTime } from '../i18n/formatters'

interface MemoryHeader {
  filename: string
  filePath: string
  mtimeMs: number
  name: string | null
  description: string | null
  type: string | undefined
}

interface MemoryFile {
  name: string
  description: string
  type: string
  scope: string
  content: string
  filename: string
  created: string
  updated: string
}

const TYPE_LABELS: Record<string, { labelKey: string; color: string }> = {
  user: { labelKey: 'settings.memory.types.user', color: 'bg-blue-50 text-blue-600 dark:bg-blue-900/30 dark:text-blue-400' },
  feedback: { labelKey: 'settings.memory.types.feedback', color: 'bg-amber-50 text-amber-600 dark:bg-amber-900/30 dark:text-amber-400' },
  project: { labelKey: 'settings.memory.types.project', color: 'bg-emerald-50 text-emerald-600 dark:bg-emerald-900/30 dark:text-emerald-400' },
  reference: { labelKey: 'settings.memory.types.reference', color: 'bg-purple-50 text-purple-600 dark:bg-purple-900/30 dark:text-purple-400' },
}

type DreamResult =
  | { kind: 'applied'; count: number; summary: string }
  | { kind: 'clean' }
  | { kind: 'error' }

export function MemorySettings() {
  const { t, i18n } = useTranslation()
  const locale = i18n.resolvedLanguage || i18n.language
  const [memories, setMemories] = useState<MemoryHeader[]>([])
  const [archived, setArchived] = useState<MemoryHeader[]>([])
  const [showArchived, setShowArchived] = useState(false)
  const [expandedFile, setExpandedFile] = useState<string | null>(null)
  const [expandedContent, setExpandedContent] = useState<MemoryFile | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)
  const [autoEnabled, setAutoEnabled] = useState(true)
  const [globalDir, setGlobalDir] = useState('')
  const [dreaming, setDreaming] = useState(false)
  const [dreamResult, setDreamResult] = useState<DreamResult | null>(null)
  const [loading, setLoading] = useState(true)

  const loadMemories = useCallback(async () => {
    setLoading(true)
    try {
      const [list, config, arch] = await Promise.all([
        window.api.listGlobalMemories(),
        window.api.getMemoryConfig(),
        window.api.listArchivedMemories?.() ?? []
      ])
      setMemories(list || [])
      setArchived(arch || [])
      setAutoEnabled(config.autoMemoryEnabled)
      setGlobalDir(config.globalDir)
    } catch (err) {
      console.warn('[MemorySettings] 加载失败:', err)
    }
    setLoading(false)
  }, [])

  useEffect(() => { loadMemories() }, [loadMemories])

  const handleExpand = useCallback(async (header: MemoryHeader) => {
    if (expandedFile === header.filePath) {
      setExpandedFile(null)
      setExpandedContent(null)
      return
    }
    setExpandedFile(header.filePath)
    try {
      const mem = await window.api.readMemory(header.filePath)
      setExpandedContent(mem)
    } catch {
      setExpandedContent(null)
    }
  }, [expandedFile])

  const handleDelete = useCallback(async (filePath: string) => {
    await window.api.deleteMemory(filePath)
    setConfirmDelete(null)
    setExpandedFile(null)
    setExpandedContent(null)
    loadMemories()
  }, [loadMemories])

  const handleRestore = useCallback(async (filePath: string) => {
    await window.api.restoreMemory?.(filePath)
    loadMemories()
  }, [loadMemories])

  const handleToggleAuto = useCallback(async () => {
    const newVal = !autoEnabled
    setAutoEnabled(newVal)
    await window.api.setMemoryConfig(newVal)
  }, [autoEnabled])

  const handleDream = useCallback(async () => {
    setDreaming(true)
    setDreamResult(null)
    try {
      const result = await window.api.forceDream()
      setDreamResult(
        result.actionsApplied > 0
          ? { kind: 'applied', count: result.actionsApplied, summary: result.summary }
          : { kind: 'clean' }
      )
      loadMemories()
    } catch {
      setDreamResult({ kind: 'error' })
    }
    setDreaming(false)
  }, [loadMemories])

  return (
    <div className="max-w-2xl">
      <h2 className="text-lg font-bold text-surface-700 tracking-tight mb-4">{t('settings.memory.title')}</h2>

      {/* 自动记忆开关 */}
      <div className="flex items-center justify-between mb-6 p-3 rounded-lg bg-surface-50 border border-surface-100">
        <div>
          <p className="text-[13px] font-medium text-surface-700">{t('settings.memory.auto.title')}</p>
          <p className="text-[11px] text-surface-400 mt-0.5">{t('settings.memory.auto.description')}</p>
        </div>
        <button
          onClick={handleToggleAuto}
          role="switch"
          aria-checked={autoEnabled}
          aria-label={t('settings.memory.auto.title')}
          className={`relative shrink-0 w-11 h-6 rounded-full transition-colors ${
            autoEnabled ? 'bg-brand-500' : 'bg-surface-200'
          }`}
        >
          <div className={`absolute top-0.5 w-5 h-5 rounded-full bg-white shadow transition-transform ${
            autoEnabled ? 'translate-x-5' : 'translate-x-0.5'
          }`} />
        </button>
      </div>

      {/* 记忆列表标题 */}
      <div className="flex items-center justify-between mb-3">
        <p className="text-[13px] font-medium text-surface-600">
          {t('settings.memory.globalCount', { count: memories.length })}
        </p>
        <button
          onClick={handleDream}
          disabled={dreaming}
          className="flex items-center gap-1.5 px-3 py-1.5 text-[12px] font-medium text-brand-600 dark:text-brand-400 bg-brand-50 dark:bg-brand-900/20 rounded-md hover:bg-brand-100 dark:hover:bg-brand-900/40 transition-colors disabled:opacity-50"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${dreaming ? 'animate-spin' : ''}`} />
          {dreaming ? t('settings.memory.dream.organizing') : t('settings.memory.dream.organizeNow')}
        </button>
      </div>

      {/* Dream 结果提示 */}
      {dreamResult && (
        <div className="mb-3 px-3 py-2 text-[12px] text-brand-600 dark:text-brand-400 bg-brand-50/60 dark:bg-brand-900/20 rounded-md border border-brand-100/50 dark:border-brand-800/40">
          {dreamResult.kind === 'applied'
            ? t('settings.memory.dream.applied', {
                count: dreamResult.count,
                summary: dreamResult.summary,
              })
            : dreamResult.kind === 'clean'
              ? t('settings.memory.dream.clean')
              : t('settings.memory.dream.error')}
        </div>
      )}

      {/* 记忆列表 */}
      {loading ? (
        <div className="py-8 text-center text-[12px] text-surface-300">{t('settings.memory.loading')}</div>
      ) : memories.length === 0 ? (
        <div className="py-8 text-center">
          <p className="text-[12px] text-surface-300">{t('settings.memory.empty.title')}</p>
          <p className="text-[11px] text-surface-300 mt-1">
            {t('settings.memory.empty.description')}
          </p>
        </div>
      ) : (
        <div className="border border-surface-100 rounded-lg overflow-hidden divide-y divide-surface-100">
          {memories.map(mem => {
            const isExpanded = expandedFile === mem.filePath
            const typeInfo = TYPE_LABELS[mem.type || '']
            const typeLabel = typeInfo ? t(typeInfo.labelKey) : mem.type || '?'
            const typeColor = typeInfo?.color || 'bg-surface-100 text-surface-500'

            return (
              <div key={mem.filePath}>
                <button
                  onClick={() => handleExpand(mem)}
                  className="group w-full text-left px-3 py-2.5 hover:bg-surface-50 dark:hover:bg-surface-50/50 transition-colors"
                >
                  <div className="flex items-center gap-2">
                    {isExpanded
                      ? <ChevronDown className="w-3.5 h-3.5 text-surface-400 shrink-0" />
                      : <ChevronRight className="w-3.5 h-3.5 text-surface-400 shrink-0" />
                    }
                    <span className="text-[13px] text-surface-700 truncate flex-1">
                      {mem.name || mem.filename}
                    </span>
                    <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded ${typeColor}`}>
                      {typeLabel}
                    </span>
                    <span className="text-[10px] text-surface-300 shrink-0 whitespace-nowrap text-right">
                      {formatRelativeTime(mem.mtimeMs, locale)}
                    </span>
                    {/* 删除按钮 */}
                    <div className="opacity-0 group-hover:opacity-100 transition-opacity shrink-0 ml-1">
                      {confirmDelete === mem.filePath ? (
                        <span
                          onClick={(e) => { e.stopPropagation(); handleDelete(mem.filePath) }}
                          className="text-[10px] text-red-500 hover:text-red-600 cursor-pointer px-1"
                        >
                          {t('settings.memory.confirmDelete')}
                        </span>
                      ) : (
                        <Trash2
                          className="w-3.5 h-3.5 text-surface-300 hover:text-red-400 cursor-pointer"
                          onClick={(e) => {
                            e.stopPropagation()
                            setConfirmDelete(mem.filePath)
                            setTimeout(() => setConfirmDelete(null), 3000)
                          }}
                        />
                      )}
                    </div>
                  </div>
                  {mem.description && (
                    <p className="text-[11px] text-surface-400 mt-0.5 pl-[22px] truncate">
                      {mem.description}
                    </p>
                  )}
                </button>

                {/* 展开内容 */}
                {isExpanded && expandedContent && (
                  <div className="px-4 py-3 bg-surface-50/50 border-t border-surface-100">
                    <pre className="text-[12px] text-surface-600 whitespace-pre-wrap leading-relaxed font-sans">
                      {expandedContent.content}
                    </pre>
                    <div className="mt-2 flex items-center gap-3 text-[10px] text-surface-300">
                      <span>{t('settings.memory.created', {
                        date: formatLocaleDate(expandedContent.created, locale),
                      })}</span>
                      <span>{t('settings.memory.updated', {
                        date: formatLocaleDate(expandedContent.updated, locale),
                      })}</span>
                      <span>{expandedContent.filename}</span>
                    </div>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}

      {/* 已归档记忆 */}
      {archived.length > 0 && (
        <div className="mt-4">
          <button
            onClick={() => setShowArchived(v => !v)}
            className="w-full text-left"
          >
            <div className="flex items-center gap-2">
              {showArchived
                ? <ChevronDown className="w-3.5 h-3.5 text-surface-400 shrink-0" />
                : <ChevronRight className="w-3.5 h-3.5 text-surface-400 shrink-0" />
              }
              <span className="text-[13px] font-medium text-surface-500">
                {t('settings.memory.archived.count', { count: archived.length })}
              </span>
            </div>
            <p className="text-[11px] text-surface-300 mt-0.5 pl-[22px]">
              {t('settings.memory.archived.description')}
            </p>
          </button>

          {showArchived && (
            <div className="mt-2 border border-surface-100 rounded-lg overflow-hidden divide-y divide-surface-100">
              {archived.map(mem => {
                const typeInfo = TYPE_LABELS[mem.type || '']
                const typeLabel = typeInfo ? t(typeInfo.labelKey) : mem.type || '?'
                const typeColor = typeInfo?.color || 'bg-surface-100 text-surface-500'
                return (
                  <div key={mem.filePath} className="flex items-center gap-2 px-3 py-2.5">
                    <span className="text-[13px] text-surface-500 truncate flex-1">
                      {mem.name || mem.filename}
                    </span>
                    <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded ${typeColor}`}>
                      {typeLabel}
                    </span>
                    <span className="text-[10px] text-surface-300 shrink-0 whitespace-nowrap text-right">
                      {formatRelativeTime(mem.mtimeMs, locale)}
                    </span>
                    <button
                      onClick={() => handleRestore(mem.filePath)}
                      className="text-[11px] text-brand-600 dark:text-brand-400 hover:text-brand-700 dark:hover:text-brand-300 shrink-0 ml-1"
                    >
                      {t('settings.memory.archived.restore')}
                    </button>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      )}

      {/* 存储路径 */}
      {globalDir && (
        <div className="mt-4 flex items-center gap-1.5 text-[11px] text-surface-300">
          <FolderOpen className="w-3.5 h-3.5" />
          <span className="font-mono">{globalDir.replace(/^\/Users\/[^/]+/, '~')}</span>
        </div>
      )}
    </div>
  )
}

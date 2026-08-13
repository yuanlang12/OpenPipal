import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import { X, FolderOpen, Folder, ChevronRight, ChevronDown, FileText, FileSpreadsheet, FilePieChart, Image as ImageIcon, FileCode2, FileJson, RefreshCw } from 'lucide-react'
import { useChatStore } from '../../stores/chatStore'
import { useWorkspaceStore } from '../../stores/workspaceStore'
import { ResizeHandle } from './ResizeHandle'

interface TreeNode {
  name: string
  path: string
  kind: 'file' | 'folder'
  size?: number
  mtime?: number
  ext?: string
  children?: TreeNode[]
  truncated?: boolean
}

function iconForExt(ext?: string) {
  if (!ext) return FileText
  if (['md', 'txt'].includes(ext)) return FileText
  if (['csv', 'xlsx', 'xls'].includes(ext)) return FileSpreadsheet
  if (['pptx', 'ppt', 'key'].includes(ext)) return FilePieChart
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'].includes(ext)) return ImageIcon
  if (['json'].includes(ext)) return FileJson
  if (['js', 'ts', 'jsx', 'tsx', 'py', 'html', 'css', 'sh'].includes(ext)) return FileCode2
  return FileText
}

function fmtSize(b?: number) {
  if (b == null) return ''
  if (b < 1024) return `${b}B`
  if (b < 1048576) return `${(b / 1024).toFixed(1)}KB`
  return `${(b / 1048576).toFixed(1)}MB`
}

function countFiles(node: TreeNode): number {
  if (node.kind === 'file') return 1
  return (node.children || []).reduce((sum, c) => sum + countFiles(c), 0)
}

function treeNodeName(node: TreeNode, t: TFunction): string {
  const normalizedPath = node.path.replace(/\\/g, '/')
  return normalizedPath.endsWith('/.openpipal/workspace/assets')
    ? t('shell.workspace.files.assetsLibrary')
    : node.name
}

/**
 * 单个节点递归渲染 —— folder 可展开/折叠，file 点击打开预览 tab。
 */
function TreeRow({
  node,
  depth,
  expandedPaths,
  toggle,
  t,
}: {
  node: TreeNode
  depth: number
  expandedPaths: Set<string>
  toggle: (path: string) => void
  t: TFunction
}) {
  if (node.kind === 'folder') {
    const expanded = expandedPaths.has(node.path)
    const Chevron = expanded ? ChevronDown : ChevronRight
    const children = node.children || []
    const childCount = children.length
    const displayName = treeNodeName(node, t)
    return (
      <>
        <button
          onClick={() => toggle(node.path)}
          className="w-full flex items-center gap-1 py-1 text-left text-[12px] text-surface-700 hover:bg-surface-100 dark:hover:bg-surface-100/50 transition-colors group"
          style={{ paddingLeft: `${8 + depth * 12}px`, paddingRight: 8 }}
          title={`${node.path}  ·  ${t('shell.workspace.files.folderItems', { count: childCount })}`}
        >
          <Chevron size={11} className="shrink-0 opacity-60" />
          <Folder size={13} className="shrink-0 text-surface-400 group-hover:text-brand-500 transition-colors" />
          <span className="truncate flex-1">{displayName}</span>
          {childCount > 0 && (
            <span className="text-[10px] text-surface-400 shrink-0">{childCount}</span>
          )}
        </button>
        {expanded && children.map(c => (
          <TreeRow key={c.path} node={c} depth={depth + 1} expandedPaths={expandedPaths} toggle={toggle} t={t} />
        ))}
      </>
    )
  }
  // file
  if (node.truncated) {
    return (
      <div
        className="py-1 text-[11px] text-surface-400 italic"
        style={{ paddingLeft: `${8 + depth * 12 + 12}px` }}
      >
        {t('shell.workspace.files.truncated')}
      </div>
    )
  }
  const Icon = iconForExt(node.ext)
  return (
    <button
      onClick={() => useWorkspaceStore.getState().openTab({
        kind: 'file',
        title: node.name,
        filePath: node.path
      })}
      className="w-full flex items-center gap-1.5 py-1 text-left text-[12px] text-surface-700 hover:bg-surface-100 dark:hover:bg-surface-100/50 transition-colors group"
      style={{ paddingLeft: `${8 + depth * 12 + 12}px`, paddingRight: 8 }}
      title={`${node.path}\n${fmtSize(node.size)}`}
    >
      <Icon size={13} className="shrink-0 text-surface-400 group-hover:text-brand-500 transition-colors" />
      <span className="truncate flex-1">{node.name}</span>
    </button>
  )
}

/**
 * Files Panel —— 独立右侧面板，Agent 文件夹浏览器。
 *
 * Agent 会话：root = ~/.openpipal/agents/{id}/（agent.md / me.md / memory/ / outputs/ / skills/ / tools/ / workspace/）。
 * 全局会话：root = ~/.openpipal/memory/（仅对话历史等用户可见记忆，不暴露系统 Agent 的 prompt/配置）。
 *
 * 默认顶层直接子目录折叠，用户点击展开。
 * 点击文件 → 在 Preview Panel 开 tab。
 * 左边缘 ResizeHandle 支持拖拽调整列宽。
 */
export function FilesPanel() {
  const { t } = useTranslation()
  const filesWidth = useWorkspaceStore(s => s.filesWidth)
  const setFilesWidth = useWorkspaceStore(s => s.setFilesWidth)
  const setFilesPanelOpen = useWorkspaceStore(s => s.setFilesPanelOpen)
  const workspaceId = useChatStore(s => s.activeWorkspaceId)

  const [tree, setTree] = useState<TreeNode | null>(null)
  const [loading, setLoading] = useState(false)
  const [reloadTick, setReloadTick] = useState(0)
  // 默认根目录展开，子目录折叠。拿到 tree 时用 path 填充
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(new Set())

  useEffect(() => {
    let cancelled = false
    const dirKey = `tree:${workspaceId || ''}`
    const api = (window as any).api
    async function load() {
      setLoading(true)
      try {
        const t: TreeNode | null = await api?.getAgentTree?.(workspaceId || undefined)
        if (!cancelled) {
          setTree(t)
          if (t && expandedPaths.size === 0) {
            // 首次加载：展开 root，子目录折叠
            setExpandedPaths(new Set([t.path]))
          }
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    load()
    // 主进程 fs.watch 推送 —— 目录变化即时刷新，取代原来的 8s 定时轮询
    // （手动点刷新按钮触发的 reloadTick 变化也会走这个 effect，watch-stop/start 幂等重开一次，无副作用）
    api?.watchWorkspaceStart?.(dirKey)
    const unsubscribe = api?.onWorkspaceChanged?.((dir: string) => {
      if (dir === dirKey) load()
    })
    // fs.watch 有平台性怪癖（原子写/网络卷等场景可能漏事件），保留低频兜底轮询
    const timer = setInterval(load, 60000)
    return () => {
      cancelled = true
      clearInterval(timer)
      unsubscribe?.()
      api?.watchWorkspaceStop?.(dirKey)
    }
    // 只在 workspaceId 切换或手动 reload 时重新拉；expandedPaths 变化不应触发重拉
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId, reloadTick])

  const toggle = useCallback((p: string) => {
    setExpandedPaths(prev => {
      const next = new Set(prev)
      if (next.has(p)) next.delete(p); else next.add(p)
      return next
    })
  }, [])

  const totalFiles = useMemo(() => tree ? countFiles(tree) : 0, [tree])

  return (
    <div
      className="relative shrink-0 flex flex-col border-l border-surface-100 bg-surface-0 dark:bg-surface-50"
      style={{ width: filesWidth }}
    >
      <ResizeHandle side="left" getWidth={() => useWorkspaceStore.getState().filesWidth} setWidth={setFilesWidth} />

      <div className="h-10 shrink-0 flex items-center px-3 border-b border-surface-100">
        <div className="flex items-center gap-1.5 text-xs font-medium text-surface-600">
          <FolderOpen size={13} className="opacity-70" />
          <span>{t('shell.workspace.files.all')}</span>
          {totalFiles > 0 && (
            <span className="text-[10px] px-1.5 h-4 flex items-center rounded bg-surface-100 text-surface-500">
              {totalFiles}
            </span>
          )}
        </div>
        <button
          onClick={() => setReloadTick(t => t + 1)}
          className="ml-auto p-1 rounded-md text-surface-400 hover:text-surface-700 hover:bg-surface-100 dark:hover:bg-surface-100/60 transition-colors"
          title={t('shell.workspace.files.refresh')}
        >
          <RefreshCw size={12} className={loading ? 'animate-spin' : ''} />
        </button>
        <button
          onClick={() => setFilesPanelOpen(false)}
          className="p-1 rounded-md text-surface-400 hover:text-surface-700 hover:bg-surface-100 dark:hover:bg-surface-100/60 transition-colors"
          title={t('shell.workspace.files.collapse')}
        >
          <X size={13} />
        </button>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto scrollbar-thin py-1">
        {loading && !tree ? (
          <div className="px-3 py-2 text-[11px] text-surface-400">{t('shell.workspace.files.loading')}</div>
        ) : !tree ? (
          <div className="px-3 py-3 text-[11px] text-surface-400 leading-relaxed">
            {workspaceId ? t('shell.workspace.files.agentDirectoryMissing') : t('shell.workspace.files.noMemory')}<br />
            <span className="opacity-70">
              {workspaceId ? t('shell.workspace.files.agentFilesHint') : t('shell.workspace.files.globalMemoryHint')}
            </span>
          </div>
        ) : (
          (tree.children || []).map(c => (
            <TreeRow key={c.path} node={c} depth={0} expandedPaths={expandedPaths} toggle={toggle} t={t} />
          ))
        )}
      </div>
    </div>
  )
}

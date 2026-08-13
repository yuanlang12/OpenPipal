import { useWorkspaceStore } from '../stores/workspaceStore'

/**
 * 统一入口：把链接/文件路径"在 workspace 中预览"。
 *
 * 根据 target 自动判断 tab 类型：
 *   - http(s):// → preview tab（iframe）
 *   - file:// 或绝对路径 → file tab（按扩展名分发）
 *   - 相对路径或奇怪的字符串 → 交给系统默认应用打开
 */
export function openInWorkspace(target: string, options?: { title?: string; fallbackExternal?: boolean }): boolean {
  if (!target) return false
  const { openTab } = useWorkspaceStore.getState()
  const { title, fallbackExternal = true } = options || {}

  // HTTP(S) URL
  if (/^https?:\/\//i.test(target)) {
    openTab({ kind: 'preview', title: title || target, url: target })
    return true
  }

  // file:// URL
  if (/^file:\/\//i.test(target)) {
    const p = target.replace(/^file:\/\//i, '')
    openTab({ kind: 'file', title: title || p.split('/').pop() || p, filePath: p })
    return true
  }

  // 绝对路径（Unix）
  if (target.startsWith('/') && !target.includes('://')) {
    openTab({ kind: 'file', title: title || target.split('/').pop() || target, filePath: target })
    return true
  }

  // ~/... 展开由主进程 realpath 处理
  if (target.startsWith('~/')) {
    openTab({ kind: 'file', title: title || target.split('/').pop() || target, filePath: target })
    return true
  }

  // Unknown/active schemes are neither workspace files nor safe OS paths.
  // Do not pass javascript:, data:, custom protocols, or similar values to
  // Electron. Relative paths intentionally continue to the existing fallback.
  if (/^[a-z][a-z0-9+.-]*:/i.test(target)) return false

  // 未能识别，降级到系统默认应用
  if (fallbackExternal) {
    ;(window as any).api?.openFile?.(target)
  }
  return false
}

/**
 * 便捷包装：在 MessageBubble 等处把 URL/文件路径渲染成"可点击"行为。
 */
export function handleLinkClick(e: React.MouseEvent<HTMLAnchorElement>, href: string) {
  // Markdown content is model-controlled. Always cancel browser-default
  // navigation before routing the target through explicit product policy.
  e.preventDefault()
  const isExternal = /^https?:\/\//i.test(href)
  // 修饰键：用户显式要"在系统浏览器打开"
  if (e.metaKey || e.ctrlKey) {
    if (isExternal) {
      ;(window as any).api?.openFile?.(href)
      return
    }
  }
  // 默认：在 workspace 打开
  openInWorkspace(href)
}

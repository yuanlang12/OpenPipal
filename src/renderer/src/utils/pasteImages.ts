/**
 * 粘贴图片的共享处理——三个输入面（聊天 InputBar / 欢迎页 / 角色前置页）同一套行为：
 * 1. DataTransfer 在事件回调让出主线程后即失效（getAsFile 开始返回 null）——必须同步快照完
 *    所有 item 再做异步处理；preventDefault 也必须在同步阶段决定。
 * 2. macOS 兜底：截图预览/微信等来源的图片常只有 TIFF flavor，DOM 剪贴板整个看不见
 *    （items 里既无 image 也无 text）——问主进程 NSPasteboard 取图。只在 DOM 粘贴完全
 *    无事可做时启用，不与文本/文件粘贴抢行为。
 */

interface PasteLikeEvent {
  clipboardData: DataTransfer | null
  preventDefault: () => void
}

export function extractPastedImages(
  e: PasteLikeEvent,
  addImage: (base64: string) => void,
  opts?: {
    /** 提供时非图片文件也接管（按真实路径处理）；不提供则文件项走浏览器默认行为 */
    onFilePath?: (path: string) => void
  }
): void {
  const items = e.clipboardData?.items
  if (!items) return

  let hasText = false
  const imageFiles: File[] = []
  const otherFiles: File[] = []
  for (const item of Array.from(items)) {
    if (item.kind === 'string' && item.type === 'text/plain') {
      hasText = true
    } else if (item.type.startsWith('image/')) {
      const f = item.getAsFile()
      if (f) imageFiles.push(f)
    } else if (item.kind === 'file' && opts?.onFilePath) {
      const f = item.getAsFile()
      if (f) otherFiles.push(f)
    }
  }
  if (imageFiles.length || otherFiles.length) e.preventDefault()

  for (const f of imageFiles) {
    const reader = new FileReader()
    reader.onload = () => addImage((reader.result as string).split(',')[1])
    reader.readAsDataURL(f)
  }
  for (const f of otherFiles) {
    // Electron 32+ 移除了 File.path——真实路径走 preload 的 webUtils；旧字段兜底 legacy
    const filePath = (window.api as any).getPathForFile?.(f) ?? (f as any).path
    if (filePath) opts!.onFilePath!(filePath)
  }

  if (!imageFiles.length && !otherFiles.length && !hasText) {
    ;(window.api as any).readClipboardImage?.().then((b64: string | null) => {
      if (b64) addImage(b64)
    }).catch(() => {})
  }
}

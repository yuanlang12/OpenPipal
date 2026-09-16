/**
 * 拖文件进窗口（所有者 2026-09-15）：整个界面都认拖拽，对话区亮一圈提示色，松手就进输入框——等同于点 + 上传。
 *
 * 一个窗口一份拖拽状态，document 级监听，不靠每块区域各自接 dragover（以前只有输入框那一小条接，
 * 落在消息列上什么都不发生）：
 *   - 只认带文件的拖拽（拖选中的文字不算）
 *   - 进出计数：拖过子元素会连发 dragleave / dragenter，计数归零才算离开窗口
 *   - 松手落在窗口任何地方都收；别的落区（资料面板、问答附件框）自己 preventDefault + stopPropagation，到不了这里
 *   - 浏览器默认的"打开文件"由主进程 will-navigate 拦掉，这里只管把文件送进输入面
 */
import { useEffect, useLayoutEffect, useRef, useSyncExternalStore } from 'react'
import { useTranslation } from 'react-i18next'

let dragging = false
const subscribers = new Set<() => void>()
function setDragging(next: boolean): void {
  if (dragging === next) return
  dragging = next
  subscribers.forEach(fn => fn())
}
const subscribe = (fn: () => void): (() => void) => { subscribers.add(fn); return () => { subscribers.delete(fn) } }

/** 正在往窗口里拖文件（输入面据此亮边、对话区据此盖提示层） */
export function useWindowFileDragging(): boolean {
  return useSyncExternalStore(subscribe, () => dragging)
}

const hasFiles = (dt: DataTransfer | null): boolean => !!dt && Array.from(dt.types).includes('Files')

export interface DroppedFileSink {
  /** 有真实路径的文件（桌面端 webUtils）：走与 + 上传同一条进料（图片内联 / 其余挂附件） */
  onFilePath: (path: string) => void
  /** 拿不到路径（浏览器模式）的图片：base64 内联；浏览器模式收不了别的文件 */
  onImage: (base64: string) => void
}

function deliver(file: File, sink: DroppedFileSink): void {
  // Electron 32+ 移除了 File.path——真实路径走 preload 的 webUtils；旧字段兜底 legacy
  const filePath = ((window.api as any).getPathForFile?.(file) ?? (file as any).path) as string | undefined
  if (filePath) {
    sink.onFilePath(filePath)
  } else if (file.type.startsWith('image/')) {
    const reader = new FileReader()
    reader.onload = () => sink.onImage((reader.result as string).split(',')[1])
    reader.readAsDataURL(file)
  }
}

/** 挂在当前输入面（对话页 InputBar / 欢迎页）上：整窗接拖放，文件送进这个输入面 */
export function useWindowFileDrop(sink: DroppedFileSink): void {
  const sinkRef = useRef(sink)
  useLayoutEffect(() => { sinkRef.current = sink }) // 提交后再换：渲染中途写 ref 会留下被丢弃那次渲染的闭包
  useEffect(() => {
    let depth = 0
    const reset = (): void => { depth = 0; setDragging(false) }
    const enter = (e: DragEvent): void => {
      if (!hasFiles(e.dataTransfer)) return
      e.preventDefault()
      depth++
      setDragging(true)
    }
    const over = (e: DragEvent): void => {
      if (!hasFiles(e.dataTransfer)) return
      e.preventDefault()
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'
      setDragging(true) // 计数偶尔失准（跨 iframe / 落区吞了事件）时靠持续的 dragover 纠回来
    }
    const leave = (e: DragEvent): void => {
      if (!hasFiles(e.dataTransfer)) return
      depth = Math.max(0, depth - 1)
      if (depth === 0) setDragging(false)
    }
    const drop = (e: DragEvent): void => {
      // 松手了就先灭：落在别的落区（它 preventDefault 但没 stopPropagation）也算这次拖拽结束，不然提示层挂着不走
      const claimedElsewhere = e.defaultPrevented
      reset()
      if (!hasFiles(e.dataTransfer) || claimedElsewhere) return
      e.preventDefault()
      // 同步取完 File 引用再异步处理（DataTransfer 在让出主线程后失效）
      for (const file of Array.from(e.dataTransfer?.files ?? [])) deliver(file, sinkRef.current)
    }
    document.addEventListener('dragenter', enter)
    document.addEventListener('dragover', over)
    document.addEventListener('dragleave', leave)
    document.addEventListener('drop', drop)
    document.addEventListener('dragend', reset)
    return () => {
      document.removeEventListener('dragenter', enter)
      document.removeEventListener('dragover', over)
      document.removeEventListener('dragleave', leave)
      document.removeEventListener('drop', drop)
      document.removeEventListener('dragend', reset)
      reset()
    }
  }, [])
}

/** 对话区那圈提示色：盖在消息列 + 输入区上，不吃事件（松手仍落到 document 的监听） */
export function FileDropHighlight(): React.JSX.Element | null {
  const { t } = useTranslation()
  const active = useWindowFileDragging()
  if (!active) return null
  return (
    <div
      data-testid="file-drop-highlight"
      aria-hidden
      className="pointer-events-none absolute inset-2 z-40 flex items-center justify-center rounded-2xl border-2 border-dashed border-brand-400 bg-brand-50/40 dark:bg-brand-900/15"
    >
      <span className="px-3 py-1.5 rounded-full bg-surface-0/90 dark:bg-surface-50/90 text-[12px] text-brand-600 dark:text-brand-400 shadow-sm">
        {t('chat.input.dropFiles')}
      </span>
    </div>
  )
}

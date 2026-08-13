import { useCallback, useRef } from 'react'
import { useTranslation } from 'react-i18next'

/**
 * 面板列宽拖拽手柄 —— 放在目标面板的左或右边缘。
 *
 * 用 Pointer Capture 而非 document 监听：捕获后所有 pointer 事件路由回手柄本身，
 * 指针滑过 iframe（artifact 预览）也不会丢事件。修复两个实测症状：
 * - 在预览区上方松手 → mouseup 被 iframe 吞掉 → 拖拽"粘连"，要再点一下才停
 * - 往预览区方向回拖 → mousemove 进 iframe 停止派发 → 手感"拖不动"
 * 双保险：拖拽期间 body 挂 sw-split-dragging，全局 CSS 把 iframe pointer-events 关掉。
 */
export function ResizeHandle({
  side,
  getWidth,
  setWidth
}: {
  /** 手柄挂在目标面板的哪一边。'left' 用于右侧面板（向左拖变宽），'right' 用于左侧面板。 */
  side: 'left' | 'right'
  getWidth: () => number
  setWidth: (w: number) => void
}) {
  const { t } = useTranslation()
  const dragRef = useRef<{ startX: number; startW: number } | null>(null)

  const endDrag = useCallback((el: HTMLElement, pointerId: number) => {
    if (!dragRef.current) return
    dragRef.current = null
    try { el.releasePointerCapture(pointerId) } catch { /* 已释放 */ }
    document.body.style.cursor = ''
    document.body.style.userSelect = ''
    document.body.classList.remove('sw-split-dragging')
  }, [])

  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      e.preventDefault()
      dragRef.current = { startX: e.clientX, startW: getWidth() }
      e.currentTarget.setPointerCapture(e.pointerId)
      document.body.style.cursor = 'col-resize'
      document.body.style.userSelect = 'none'
      document.body.classList.add('sw-split-dragging')
    },
    [getWidth]
  )

  const onPointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!dragRef.current) return
      const dx = e.clientX - dragRef.current.startX
      const newW = side === 'left' ? dragRef.current.startW - dx : dragRef.current.startW + dx
      setWidth(newW)
    },
    [side, setWidth]
  )

  const onPointerEnd = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => endDrag(e.currentTarget, e.pointerId),
    [endDrag]
  )

  return (
    <div
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerEnd}
      onPointerCancel={onPointerEnd}
      onLostPointerCapture={onPointerEnd}
      aria-label={t('shell.workspace.resizeColumn')}
      role="separator"
      className={[
        'absolute top-0 bottom-0 w-1.5 z-20 cursor-col-resize group touch-none',
        side === 'left' ? '-left-0.5' : '-right-0.5'
      ].join(' ')}
    >
      <div className="absolute inset-y-0 left-1/2 -translate-x-1/2 w-px bg-transparent group-hover:bg-brand-400 group-active:bg-brand-500 transition-colors" />
    </div>
  )
}

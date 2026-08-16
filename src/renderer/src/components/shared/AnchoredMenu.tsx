import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from 'react'
import { createPortal } from 'react-dom'

/**
 * 锚定浮层：挂到 body 上、按触发元素的实时位置算 fixed 坐标。
 *
 * 为什么不能继续用 `absolute`：
 * 1. 设置面板正文是 `flex-1 overflow-y-auto`（SettingsPanel），absolute 浮层会被
 *    这个滚动容器裁掉——模型框滚到面板下半部分时下拉只剩半截；
 * 2. 原生 <select> 更糟：macOS 把它渲染成系统菜单并把「当前选中项」对齐到触发框，
 *    34 个服务商时菜单会整体往上顶出窗口，且不受任何 CSS 控制。
 *
 * 方向策略：默认向下；只有「下方装不下最小高度、且上方比下方宽裕」时才翻上去。
 * 两侧都按可用空间夹取，锚点被滚出视口时整体收起——脱离 absolute 就得自己还上这笔账。
 *
 * 键盘：原生 <select> 白送的上下键 + 回车也得自己还。浮层内带 [data-menu-item] 的元素
 * 参与滚动焦点，Esc 关闭；ARIA 由这里统一挂，调用方不用各挂一遍。
 */

const GAP = 4
/** 离视口边缘留的余量，避免贴边 */
const MARGIN = 8
/** 低于这个高度的浮层没有使用价值，宁可翻向另一侧 */
const MIN_HEIGHT = 160
const MAX_HEIGHT = 320

interface AnchoredMenuProps {
  anchorRef: RefObject<HTMLElement | null>
  open: boolean
  onClose: () => void
  children: ReactNode
  testId?: string
}

export function AnchoredMenu({
  anchorRef,
  open,
  onClose,
  children,
  testId
}: AnchoredMenuProps): React.JSX.Element | null {
  const menuRef = useRef<HTMLDivElement>(null)
  const [box, setBox] = useState<CSSProperties | null>(null)
  // 调用方传的都是内联箭头，进 deps 会让菜单开着时每次父组件渲染都拆装一遍 document 监听
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose

  useLayoutEffect(() => {
    if (!open) {
      setBox(null)
      return
    }
    const place = (): void => {
      const anchor = anchorRef.current
      if (!anchor) return
      const rect = anchor.getBoundingClientRect()
      // 触发元素被滚出视口后浮层就该消失：它已经没有可指向的锚了
      if (rect.bottom < 0 || rect.top > window.innerHeight) {
        onCloseRef.current()
        return
      }
      const below = window.innerHeight - rect.bottom - GAP - MARGIN
      const above = rect.top - GAP - MARGIN
      const flipUp = below < MIN_HEIGHT && above > below
      const space = flipUp ? above : below
      // maxHeight 只是上限，浮层实际高度由内容决定。所以向上展开时必须用 bottom 钉住
      // 下边缘——按 top = rect.top - height 算的话，内容不够高时浮层会浮在半空、
      // 和输入框断开一大截（截图 06 抓到过）
      const maxHeight = Math.min(MAX_HEIGHT, Math.max(80, space))
      const width = Math.max(rect.width, 180)
      const next: CSSProperties = {
        left: Math.max(MARGIN, Math.min(rect.left, window.innerWidth - width - MARGIN)),
        ...(flipUp
          ? { bottom: Math.max(MARGIN, window.innerHeight - rect.top + GAP) }
          : { top: Math.max(MARGIN, rect.bottom + GAP) }),
        width,
        maxHeight
      }
      // 每帧都换一个新对象的话，锚点根本没动也会重渲染整张列表，
      // 下一帧的 getBoundingClientRect 又被迫同步重排——滚动时的典型抖动源
      setBox((prev) =>
        prev &&
        prev.left === next.left && prev.top === next.top && prev.bottom === next.bottom &&
        prev.width === next.width && prev.maxHeight === next.maxHeight
          ? prev
          : next
      )
    }
    place()
    // 面板滚动时跟随（capture 才能收到内层滚动容器的事件）；浮层自己滚不算，
    // 那时锚点根本没动，重新量一遍纯属白干
    const onScroll = (e: Event): void => {
      if (!menuRef.current?.contains(e.target as Node)) place()
    }
    window.addEventListener('scroll', onScroll, true)
    window.addEventListener('resize', place)
    return () => {
      window.removeEventListener('scroll', onScroll, true)
      window.removeEventListener('resize', place)
    }
  }, [open, anchorRef])

  useEffect(() => {
    if (!open) return
    const onPointerDown = (e: MouseEvent): void => {
      const target = e.target as Node
      if (menuRef.current?.contains(target)) return
      // 触发元素自己由调用方负责 toggle，这里放行避免「关了又开」
      if (anchorRef.current?.contains(target)) return
      onCloseRef.current()
    }
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        onCloseRef.current()
        return
      }
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
      const items = Array.from(menuRef.current?.querySelectorAll<HTMLElement>('[data-menu-item]') || [])
      if (items.length === 0) return
      e.preventDefault()
      const at = items.indexOf(document.activeElement as HTMLElement)
      const step = e.key === 'ArrowDown' ? 1 : -1
      items[at < 0 ? (step > 0 ? 0 : items.length - 1) : (at + step + items.length) % items.length].focus()
    }
    document.addEventListener('mousedown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('mousedown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open, anchorRef])

  if (!open || !box) return null

  return createPortal(
    <div
      ref={menuRef}
      role="listbox"
      data-testid={testId}
      className="op-menu overflow-y-auto"
      style={{ position: 'fixed', zIndex: 60, ...box }}
    >
      {children}
    </div>,
    document.body
  )
}

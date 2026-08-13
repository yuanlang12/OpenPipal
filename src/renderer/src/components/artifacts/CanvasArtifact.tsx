import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Eraser, Pencil, RotateCcw, Redo2, Trash2, Undo2 } from 'lucide-react'
import { CanvasEngine, type CanvasTool } from '../../utils/canvasEngine'
import { useCaveStateMachine } from '../../hooks/useCaveStateMachine'
import { useAppStore } from '../../stores/appStore'
import { CanvasOrb } from './CanvasOrb'

interface CanvasArtifactProps {
  artifactId: string
  content: string
  onSave: (artifactId: string, newContent: string) => Promise<void>
}

const SAVE_DEBOUNCE_MS = 600

const COLORS = [
  { key: 'ink', value: '#1f2937' },
  { key: 'red', value: '#ef4444' },
  { key: 'blue', value: '#3b82f6' },
  { key: 'green', value: '#22c55e' },
  { key: 'amber', value: '#f59e0b' }
] as const

const SIZES = [
  { key: 'thin', value: 3 },
  { key: 'medium', value: 6 },
  { key: 'thick', value: 12 }
] as const

/**
 * 手写画布 —— 引擎见 utils/canvasEngine.ts（perfect-freehand + 自研薄壳）。
 *
 * 画布面固定纸白，不跟随应用深浅色：手写隐喻要纸感，且与导出给视觉模型的白底一致，
 * 学生看到的和 AI 看到的是同一张图。工具条自身跟随主题。
 */
export function CanvasArtifact({ artifactId, content, onSave }: CanvasArtifactProps) {
  const { t } = useTranslation()

  // 引擎实例只跟 artifactId 绑定:换 artifact 才重建,避免 content 流式更新时擦掉学生输入
  const { engine, legacy } = useMemo(
    () => CanvasEngine.fromContent(content),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [artifactId]
  )

  const canvasRef = useRef<HTMLCanvasElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const frameRef = useRef<number | null>(null)
  const gestureRef = useRef<{ mode: 'draw' | 'erase' | 'pan'; lastX: number; lastY: number } | null>(null)

  const [tool, setTool] = useState<CanvasTool>('pen')
  const [color, setColor] = useState<string>(COLORS[0].value)
  const [size, setSize] = useState<number>(SIZES[1].value)
  const [history, setHistory] = useState({ canUndo: false, canRedo: false })

  const roleName = useAppStore(s => s.currentRole?.name || 'learner')
  const getEngine = useCallback((): CanvasEngine | null => engine, [engine])
  useCaveStateMachine(engine, { artifactId, roleName, getEngine })

  /** 合帧重绘：指针移动每帧最多画一次，避免高频事件压垮渲染 */
  const scheduleRender = useCallback(() => {
    if (frameRef.current !== null) return
    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = null
      const canvas = canvasRef.current
      const ctx = canvas?.getContext('2d')
      if (!canvas || !ctx) return
      const dpr = window.devicePixelRatio || 1
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      engine.render(ctx, canvas.width / dpr, canvas.height / dpr)
    })
  }, [engine])

  // 尺寸自适应（含 DPR）：容器变化即重设位图尺寸并重绘
  useEffect(() => {
    const canvas = canvasRef.current
    const container = containerRef.current
    if (!canvas || !container) return
    const resize = (): void => {
      const rect = container.getBoundingClientRect()
      const dpr = window.devicePixelRatio || 1
      canvas.width = Math.max(1, Math.round(rect.width * dpr))
      canvas.height = Math.max(1, Math.round(rect.height * dpr))
      canvas.style.width = `${rect.width}px`
      canvas.style.height = `${rect.height}px`
      scheduleRender()
    }
    resize()
    const observer = new ResizeObserver(resize)
    observer.observe(container)
    return () => observer.disconnect()
  }, [scheduleRender])

  // 引擎变更 → 节流保存 + 刷新撤销/重做可用态
  useEffect(() => {
    const unsub = engine.subscribe(() => {
      setHistory({ canUndo: engine.canUndo(), canRedo: engine.canRedo() })
      scheduleRender()
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
      saveTimerRef.current = setTimeout(() => {
        try {
          void onSave(artifactId, engine.toJSON())
        } catch (err) {
          console.warn('[CanvasArtifact] 保存失败:', err)
        }
      }, SAVE_DEBOUNCE_MS)
    })
    return () => {
      unsub()
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current)
    }
  }, [engine, artifactId, onSave, scheduleRender])

  const pointerPos = (e: React.PointerEvent<HTMLCanvasElement>): { x: number; y: number } => {
    const rect = e.currentTarget.getBoundingClientRect()
    return { x: e.clientX - rect.left, y: e.clientY - rect.top }
  }

  const handlePointerDown = (e: React.PointerEvent<HTMLCanvasElement>): void => {
    e.currentTarget.setPointerCapture(e.pointerId)
    const { x, y } = pointerPos(e)
    // 中键/空格态 → 平移；其余按当前工具
    const panning = e.button === 1 || e.shiftKey
    if (panning) {
      gestureRef.current = { mode: 'pan', lastX: x, lastY: y }
      return
    }
    const doc = engine.toDocumentPoint(x, y)
    if (tool === 'eraser') {
      gestureRef.current = { mode: 'erase', lastX: x, lastY: y }
      engine.eraseAt(doc.x, doc.y)
      return
    }
    gestureRef.current = { mode: 'draw', lastX: x, lastY: y }
    engine.beginStroke(doc.x, doc.y, e.pressure || 0.5, color, size)
    scheduleRender()
  }

  const handlePointerMove = (e: React.PointerEvent<HTMLCanvasElement>): void => {
    const gesture = gestureRef.current
    if (!gesture) return
    const { x, y } = pointerPos(e)
    if (gesture.mode === 'pan') {
      engine.panBy(x - gesture.lastX, y - gesture.lastY)
      gesture.lastX = x
      gesture.lastY = y
      scheduleRender()
      return
    }
    const doc = engine.toDocumentPoint(x, y)
    if (gesture.mode === 'erase') engine.eraseAt(doc.x, doc.y)
    else engine.extendStroke(doc.x, doc.y, e.pressure || 0.5)
    scheduleRender()
  }

  const handlePointerUp = (e: React.PointerEvent<HTMLCanvasElement>): void => {
    const gesture = gestureRef.current
    gestureRef.current = null
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId)
    // 收笔才落库并触发保存；擦除/平移在过程中已各自处理
    if (gesture?.mode === 'draw') engine.endStroke()
    scheduleRender()
  }

  const handleWheel = (e: React.WheelEvent<HTMLCanvasElement>): void => {
    const rect = e.currentTarget.getBoundingClientRect()
    engine.zoomAt(e.clientX - rect.left, e.clientY - rect.top, e.deltaY < 0 ? 1.1 : 1 / 1.1)
    scheduleRender()
  }

  const toolButton = (active: boolean): string =>
    `h-7 w-7 flex items-center justify-center rounded-md transition-colors ${
      active
        ? 'bg-brand-500 text-ink-on-accent'
        : 'text-surface-500 hover:bg-surface-100'
    }`

  return (
    <div className="flex-1 min-h-0 relative overflow-hidden" ref={containerRef}>
      <canvas
        ref={canvasRef}
        className="absolute inset-0 bg-white touch-none"
        style={{ cursor: tool === 'eraser' ? 'cell' : 'crosshair' }}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        onWheel={handleWheel}
      />

      <div className="absolute left-3 top-3 z-10 flex items-center gap-1 rounded-lg border border-surface-200 bg-white/95 dark:bg-surface-0/95 px-1.5 py-1 shadow-sm backdrop-blur">
        <button type="button" className={toolButton(tool === 'pen')} title={t('artifacts.whiteboard.tools.pen')} aria-label={t('artifacts.whiteboard.tools.pen')} onClick={() => setTool('pen')}>
          <Pencil className="h-3.5 w-3.5" />
        </button>
        <button type="button" className={toolButton(tool === 'eraser')} title={t('artifacts.whiteboard.tools.eraser')} aria-label={t('artifacts.whiteboard.tools.eraser')} onClick={() => setTool('eraser')}>
          <Eraser className="h-3.5 w-3.5" />
        </button>

        <span className="mx-0.5 h-4 w-px bg-surface-200" />

        {COLORS.map(entry => (
          <button
            key={entry.key}
            type="button"
            title={t(`artifacts.whiteboard.colors.${entry.key}`)}
            aria-label={t(`artifacts.whiteboard.colors.${entry.key}`)}
            aria-pressed={color === entry.value}
            onClick={() => { setColor(entry.value); setTool('pen') }}
            className={`h-5 w-5 rounded-full border-2 transition-transform ${
              color === entry.value ? 'border-surface-400 scale-110' : 'border-transparent'
            }`}
            style={{ backgroundColor: entry.value }}
          />
        ))}

        <span className="mx-0.5 h-4 w-px bg-surface-200" />

        {SIZES.map(entry => (
          <button
            key={entry.key}
            type="button"
            title={t(`artifacts.whiteboard.sizes.${entry.key}`)}
            aria-label={t(`artifacts.whiteboard.sizes.${entry.key}`)}
            aria-pressed={size === entry.value}
            onClick={() => setSize(entry.value)}
            className={`h-7 w-6 flex items-center justify-center rounded-md transition-colors ${
              size === entry.value ? 'bg-surface-100' : 'hover:bg-surface-100'
            }`}
          >
            <span className="rounded-full bg-surface-600 dark:bg-surface-200" style={{ width: entry.value, height: entry.value }} />
          </button>
        ))}

        <span className="mx-0.5 h-4 w-px bg-surface-200" />

        <button type="button" className={`${toolButton(false)} disabled:opacity-30`} disabled={!history.canUndo} title={t('artifacts.whiteboard.tools.undo')} aria-label={t('artifacts.whiteboard.tools.undo')} onClick={() => engine.undo()}>
          <Undo2 className="h-3.5 w-3.5" />
        </button>
        <button type="button" className={`${toolButton(false)} disabled:opacity-30`} disabled={!history.canRedo} title={t('artifacts.whiteboard.tools.redo')} aria-label={t('artifacts.whiteboard.tools.redo')} onClick={() => engine.redo()}>
          <Redo2 className="h-3.5 w-3.5" />
        </button>
        <button type="button" className={toolButton(false)} title={t('artifacts.whiteboard.tools.resetView')} aria-label={t('artifacts.whiteboard.tools.resetView')} onClick={() => { engine.resetViewport(); scheduleRender() }}>
          <RotateCcw className="h-3.5 w-3.5" />
        </button>
        <button type="button" className={toolButton(false)} title={t('artifacts.whiteboard.tools.clear')} aria-label={t('artifacts.whiteboard.tools.clear')} onClick={() => engine.clear()}>
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </div>

      {legacy && (
        <div className="absolute left-1/2 top-3 z-10 -translate-x-1/2 rounded-md border border-amber-200 bg-amber-50 px-3 py-1.5 text-[11px] text-amber-700 shadow-sm dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200">
          {t('artifacts.whiteboard.legacyNotice')}
        </div>
      )}

      <CanvasOrb getEngine={getEngine} />
    </div>
  )
}

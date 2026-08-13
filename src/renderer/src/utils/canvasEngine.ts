import { getStroke } from 'perfect-freehand'

/**
 * 画布引擎 —— 手写白板的全部状态与几何，替代 tldraw（非 OSI 许可，不可随开源分发）。
 *
 * 只做产品真正用到的事：自由笔迹、整笔擦除、撤销/重做、平移缩放、序列化、PNG 导出。
 * 不做图形库/绑定/多人协作/富文本——原先 tldraw 提供但产品从未使用。
 * 笔迹轮廓仍由 perfect-freehand 计算（MIT，与 tldraw 画笔同一算法），手感不变。
 *
 * 本文件不在模块层触碰 DOM：渲染接收调用方给的 2D context，因此纯逻辑可在 Node 下单测。
 */

export interface StrokePoint {
  x: number
  y: number
  /** 压感 0–1；鼠标恒为 0.5 */
  p: number
}

export interface Stroke {
  id: string
  color: string
  size: number
  points: StrokePoint[]
}

export interface CanvasDocument {
  version: 1
  strokes: Stroke[]
}

export interface Viewport {
  x: number
  y: number
  zoom: number
}

export interface Bounds {
  minX: number
  minY: number
  maxX: number
  maxY: number
}

const DOC_VERSION = 1 as const

/** perfect-freehand 参数：与 tldraw draw 形状同口径，保证换引擎后笔迹观感一致 */
const STROKE_OPTIONS = {
  thinning: 0.5,
  smoothing: 0.5,
  streamline: 0.5,
  simulatePressure: true
}

export function createEmptyDocument(): CanvasDocument {
  return { version: DOC_VERSION, strokes: [] }
}

/**
 * 旧 tldraw 快照识别：它的顶层是 { store: {...}, schema: {...} }。
 * 识别出来只为给用户一句解释，不做保真导入——AI 从不写该格式，存量均为人工短期数据。
 */
export function isLegacyTldrawSnapshot(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  return typeof record.store === 'object' && record.store !== null && 'schema' in record
}

export interface ParseResult {
  doc: CanvasDocument
  legacy: boolean
}

/** 宽容解析：空/坏内容一律回落空文档，绝不抛错（画布不能因为坏数据打不开） */
export function parseCanvasDocument(content: string): ParseResult {
  const trimmed = (content || '').trim()
  if (!trimmed || trimmed === '{}') return { doc: createEmptyDocument(), legacy: false }
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    return { doc: createEmptyDocument(), legacy: false }
  }
  if (isLegacyTldrawSnapshot(parsed)) return { doc: createEmptyDocument(), legacy: true }
  const record = parsed as Partial<CanvasDocument>
  if (!record || !Array.isArray(record.strokes)) return { doc: createEmptyDocument(), legacy: false }
  const strokes: Stroke[] = []
  for (const raw of record.strokes) {
    if (!raw || !Array.isArray(raw.points) || raw.points.length === 0) continue
    strokes.push({
      id: String(raw.id ?? `s${strokes.length + 1}`),
      color: typeof raw.color === 'string' ? raw.color : '#1f2937',
      size: typeof raw.size === 'number' && raw.size > 0 ? raw.size : 4,
      points: raw.points
        .filter(pt => pt && typeof pt.x === 'number' && typeof pt.y === 'number')
        .map(pt => ({ x: pt.x, y: pt.y, p: typeof pt.p === 'number' ? pt.p : 0.5 }))
    })
  }
  return { doc: { version: DOC_VERSION, strokes: strokes.filter(s => s.points.length > 0) }, legacy: false }
}

/**
 * 笔迹外轮廓（perfect-freehand）——渲染、包围盒、导出共用一份几何。
 *
 * complete=true 必须传给已收笔的笔迹：streamline 平滑会让轮廓滞后于输入点，
 * 不声明收笔的话末端会短一截（抬笔处画不到）。绘制中的那一笔才用 false。
 */
export function strokeOutline(stroke: Stroke, complete = true): number[][] {
  return getStroke(
    stroke.points.map(pt => [pt.x, pt.y, pt.p]),
    { ...STROKE_OPTIONS, size: stroke.size, last: complete }
  )
}

function distanceToSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax
  const dy = by - ay
  const lengthSq = dx * dx + dy * dy
  if (lengthSq === 0) return Math.hypot(px - ax, py - ay)
  let t = ((px - ax) * dx + (py - ay) * dy) / lengthSq
  t = Math.max(0, Math.min(1, t))
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy))
}

/** 点到笔迹中线的最短距离；单点笔迹按点距算 */
export function distanceToStroke(stroke: Stroke, x: number, y: number): number {
  const points = stroke.points
  if (points.length === 1) return Math.hypot(x - points[0].x, y - points[0].y)
  let best = Number.POSITIVE_INFINITY
  for (let i = 1; i < points.length; i++) {
    const d = distanceToSegment(x, y, points[i - 1].x, points[i - 1].y, points[i].x, points[i].y)
    if (d < best) best = d
  }
  return best
}

export function documentBounds(doc: CanvasDocument): Bounds | null {
  let minX = Number.POSITIVE_INFINITY
  let minY = Number.POSITIVE_INFINITY
  let maxX = Number.NEGATIVE_INFINITY
  let maxY = Number.NEGATIVE_INFINITY
  let seen = false
  for (const stroke of doc.strokes) {
    for (const [x, y] of strokeOutline(stroke)) {
      seen = true
      if (x < minX) minX = x
      if (y < minY) minY = y
      if (x > maxX) maxX = x
      if (y > maxY) maxY = y
    }
  }
  return seen ? { minX, minY, maxX, maxY } : null
}

export type CanvasTool = 'pen' | 'eraser'

/**
 * 引擎实例：一个 artifact 一个。变更通知只在「用户真正改了文档」时触发，
 * 与旧实现 store.listen({source:'user'}) 的语义一致（保存节流与 Cave 观察都依赖它）。
 */
export class CanvasEngine {
  private strokes: Stroke[]
  private undoStack: Stroke[][] = []
  private redoStack: Stroke[][] = []
  private listeners = new Set<() => void>()
  private idSeq = 0
  private drawing: Stroke | null = null

  viewport: Viewport = { x: 0, y: 0, zoom: 1 }

  constructor(doc: CanvasDocument = createEmptyDocument()) {
    this.strokes = doc.strokes.map(s => ({ ...s, points: [...s.points] }))
    this.idSeq = this.strokes.length
  }

  static fromContent(content: string): { engine: CanvasEngine; legacy: boolean } {
    const { doc, legacy } = parseCanvasDocument(content)
    return { engine: new CanvasEngine(doc), legacy }
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  private emit(): void {
    this.listeners.forEach(listener => listener())
  }

  private pushUndo(): void {
    this.undoStack.push(this.strokes.map(s => ({ ...s, points: [...s.points] })))
    if (this.undoStack.length > 100) this.undoStack.shift()
    this.redoStack = []
  }

  getDocument(): CanvasDocument {
    return { version: DOC_VERSION, strokes: this.strokes.map(s => ({ ...s, points: [...s.points] })) }
  }

  toJSON(): string {
    return JSON.stringify(this.getDocument())
  }

  getStrokeIds(): string[] {
    return this.strokes.map(s => s.id)
  }

  getStrokeCount(): number {
    return this.strokes.length
  }

  isEmpty(): boolean {
    return this.strokes.length === 0
  }

  getBounds(): Bounds | null {
    return documentBounds(this.getDocument())
  }

  // ---- 绘制 ----

  beginStroke(x: number, y: number, pressure: number, color: string, size: number): void {
    this.drawing = {
      id: `s${++this.idSeq}`,
      color,
      size,
      points: [{ x, y, p: pressure }]
    }
  }

  extendStroke(x: number, y: number, pressure: number): void {
    if (!this.drawing) return
    this.drawing.points.push({ x, y, p: pressure })
  }

  /** 收笔：入栈一次撤销点并落库。返回是否真的产生了一笔 */
  endStroke(): boolean {
    const stroke = this.drawing
    this.drawing = null
    if (!stroke || stroke.points.length === 0) return false
    this.pushUndo()
    this.strokes.push(stroke)
    this.emit()
    return true
  }

  /** 正在绘制但尚未落库的笔迹（渲染用，不进文档、不触发保存） */
  getPendingStroke(): Stroke | null {
    return this.drawing
  }

  // ---- 擦除 ----

  /** 整笔擦除：命中最上层笔迹即删。返回是否删掉了东西 */
  eraseAt(x: number, y: number, radius = 6): boolean {
    for (let i = this.strokes.length - 1; i >= 0; i--) {
      const stroke = this.strokes[i]
      if (distanceToStroke(stroke, x, y) <= stroke.size / 2 + radius) {
        this.pushUndo()
        this.strokes.splice(i, 1)
        this.emit()
        return true
      }
    }
    return false
  }

  // ---- 历史 ----

  canUndo(): boolean { return this.undoStack.length > 0 }
  canRedo(): boolean { return this.redoStack.length > 0 }

  undo(): boolean {
    const previous = this.undoStack.pop()
    if (!previous) return false
    this.redoStack.push(this.strokes)
    this.strokes = previous
    this.emit()
    return true
  }

  redo(): boolean {
    const next = this.redoStack.pop()
    if (!next) return false
    this.undoStack.push(this.strokes)
    this.strokes = next
    this.emit()
    return true
  }

  clear(): boolean {
    if (this.strokes.length === 0) return false
    this.pushUndo()
    this.strokes = []
    this.emit()
    return true
  }

  // ---- 视口 ----

  /** 屏幕坐标 → 文档坐标 */
  toDocumentPoint(screenX: number, screenY: number): { x: number; y: number } {
    return {
      x: (screenX - this.viewport.x) / this.viewport.zoom,
      y: (screenY - this.viewport.y) / this.viewport.zoom
    }
  }

  panBy(dx: number, dy: number): void {
    this.viewport = { ...this.viewport, x: this.viewport.x + dx, y: this.viewport.y + dy }
  }

  /** 以某个屏幕点为锚缩放，保证锚点下的内容不跑 */
  zoomAt(screenX: number, screenY: number, factor: number): void {
    const next = Math.min(8, Math.max(0.1, this.viewport.zoom * factor))
    const scale = next / this.viewport.zoom
    this.viewport = {
      zoom: next,
      x: screenX - (screenX - this.viewport.x) * scale,
      y: screenY - (screenY - this.viewport.y) * scale
    }
  }

  resetViewport(): void {
    this.viewport = { x: 0, y: 0, zoom: 1 }
  }

  // ---- 渲染 ----

  /**
   * 把一组笔迹画进 2D context。调用方负责已设置好变换（视口或导出偏移）。
   * 单独抽出来是因为导出走离屏 canvas，与交互渲染共用同一套几何。
   */
  static paintStrokes(ctx: CanvasRenderingContext2D, strokes: Stroke[], complete = true): void {
    for (const stroke of strokes) {
      const outline = strokeOutline(stroke, complete)
      if (outline.length === 0) continue
      ctx.fillStyle = stroke.color
      ctx.beginPath()
      ctx.moveTo(outline[0][0], outline[0][1])
      for (let i = 1; i < outline.length; i++) ctx.lineTo(outline[i][0], outline[i][1])
      ctx.closePath()
      ctx.fill()
    }
  }

  /** 交互渲染：清屏 → 应用视口 → 画已落库笔迹 + 正在画的那笔 */
  render(ctx: CanvasRenderingContext2D, width: number, height: number): void {
    ctx.save()
    ctx.clearRect(0, 0, width, height)
    ctx.translate(this.viewport.x, this.viewport.y)
    ctx.scale(this.viewport.zoom, this.viewport.zoom)
    CanvasEngine.paintStrokes(ctx, this.strokes)
    if (this.drawing) CanvasEngine.paintStrokes(ctx, [this.drawing], false)
    ctx.restore()
  }
}

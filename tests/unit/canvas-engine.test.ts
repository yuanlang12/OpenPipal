/**
 * 画布引擎契约锁（替代 tldraw 后的唯一自动化安全网）。
 * 重点钉死持久化往返、擦除命中、撤销/重做，以及"空画布不出图"这条被
 * CanvasOrb 与 Cave 观察共同依赖的契约。
 */
import { describe, expect, it } from 'vitest'
import {
  CanvasEngine,
  createEmptyDocument,
  distanceToStroke,
  documentBounds,
  isLegacyTldrawSnapshot,
  parseCanvasDocument,
  strokeOutline
} from '../../src/renderer/src/utils/canvasEngine'

function drawLine(engine: CanvasEngine, x1: number, y1: number, x2: number, y2: number, color = '#111827'): void {
  engine.beginStroke(x1, y1, 0.5, color, 4)
  engine.extendStroke((x1 + x2) / 2, (y1 + y2) / 2, 0.5)
  engine.extendStroke(x2, y2, 0.5)
  engine.endStroke()
}

describe('文档解析', () => {
  it('空内容与 "{}" 回落空文档（create_artifact 建 canvas 时固定写 "{}"）', () => {
    for (const content of ['', '   ', '{}']) {
      const { doc, legacy } = parseCanvasDocument(content)
      expect(doc.strokes).toEqual([])
      expect(legacy).toBe(false)
    }
  })

  it('坏 JSON 不抛错，回落空文档', () => {
    expect(() => parseCanvasDocument('{not json')).not.toThrow()
    expect(parseCanvasDocument('{not json').doc.strokes).toEqual([])
  })

  it('识别旧 tldraw 快照并标记 legacy，不当作笔迹读', () => {
    const snapshot = JSON.stringify({ store: { 'shape:x': { typeName: 'shape' } }, schema: { schemaVersion: 2 } })
    expect(isLegacyTldrawSnapshot(JSON.parse(snapshot))).toBe(true)
    const { doc, legacy } = parseCanvasDocument(snapshot)
    expect(legacy).toBe(true)
    expect(doc.strokes).toEqual([])
  })

  it('丢弃无点笔迹并补齐缺省字段', () => {
    const { doc } = parseCanvasDocument(JSON.stringify({
      version: 1,
      strokes: [
        { id: 'a', points: [] },
        { id: 'b', points: [{ x: 1, y: 2 }] }
      ]
    }))
    expect(doc.strokes).toHaveLength(1)
    expect(doc.strokes[0].id).toBe('b')
    expect(doc.strokes[0].points[0].p).toBe(0.5)
    expect(doc.strokes[0].size).toBeGreaterThan(0)
  })
})

describe('持久化往返', () => {
  it('画 → 存 → 读回，笔数与坐标一致', () => {
    const engine = new CanvasEngine()
    drawLine(engine, 0, 0, 10, 10)
    drawLine(engine, 20, 20, 30, 30, '#ef4444')
    const json = engine.toJSON()

    const restored = new CanvasEngine(parseCanvasDocument(json).doc)
    expect(restored.getStrokeCount()).toBe(2)
    expect(restored.toJSON()).toBe(json)
    expect(restored.getDocument().strokes[1].color).toBe('#ef4444')
  })

  it('getDocument 返回拷贝，外部改动不会污染引擎', () => {
    const engine = new CanvasEngine()
    drawLine(engine, 0, 0, 5, 5)
    const doc = engine.getDocument()
    doc.strokes[0].points.push({ x: 999, y: 999, p: 1 })
    expect(engine.getDocument().strokes[0].points).toHaveLength(3)
  })
})

describe('绘制与擦除', () => {
  it('未收笔的笔迹不进文档、不通知订阅者（保存只在收笔后触发）', () => {
    const engine = new CanvasEngine()
    let changes = 0
    engine.subscribe(() => { changes++ })

    engine.beginStroke(0, 0, 0.5, '#000', 4)
    engine.extendStroke(5, 5, 0.5)
    expect(engine.getStrokeCount()).toBe(0)
    expect(changes).toBe(0)
    expect(engine.getPendingStroke()?.points).toHaveLength(2)

    expect(engine.endStroke()).toBe(true)
    expect(engine.getStrokeCount()).toBe(1)
    expect(changes).toBe(1)
  })

  it('擦除命中笔迹本体，未命中处不误删', () => {
    const engine = new CanvasEngine()
    drawLine(engine, 0, 0, 100, 0)
    expect(distanceToStroke(engine.getDocument().strokes[0], 50, 0)).toBeLessThan(1)

    expect(engine.eraseAt(500, 500)).toBe(false)
    expect(engine.getStrokeCount()).toBe(1)
    expect(engine.eraseAt(50, 0)).toBe(true)
    expect(engine.getStrokeCount()).toBe(0)
  })

  it('后画的笔迹先被擦（命中取最上层）', () => {
    const engine = new CanvasEngine()
    drawLine(engine, 0, 0, 100, 0, '#111111')
    drawLine(engine, 0, 0, 100, 0, '#222222')
    engine.eraseAt(50, 0)
    expect(engine.getDocument().strokes[0].color).toBe('#111111')
  })
})

describe('撤销与重做', () => {
  it('撤销回到上一状态，重做恢复', () => {
    const engine = new CanvasEngine()
    drawLine(engine, 0, 0, 10, 10)
    drawLine(engine, 20, 20, 30, 30)
    expect(engine.getStrokeCount()).toBe(2)

    expect(engine.undo()).toBe(true)
    expect(engine.getStrokeCount()).toBe(1)
    expect(engine.redo()).toBe(true)
    expect(engine.getStrokeCount()).toBe(2)
  })

  it('擦除可撤销', () => {
    const engine = new CanvasEngine()
    drawLine(engine, 0, 0, 100, 0)
    engine.eraseAt(50, 0)
    expect(engine.getStrokeCount()).toBe(0)
    engine.undo()
    expect(engine.getStrokeCount()).toBe(1)
  })

  it('空栈时不炸且不误报', () => {
    const engine = new CanvasEngine()
    expect(engine.canUndo()).toBe(false)
    expect(engine.undo()).toBe(false)
    expect(engine.redo()).toBe(false)
  })

  it('新动作清空重做栈', () => {
    const engine = new CanvasEngine()
    drawLine(engine, 0, 0, 10, 10)
    engine.undo()
    expect(engine.canRedo()).toBe(true)
    drawLine(engine, 50, 50, 60, 60)
    expect(engine.canRedo()).toBe(false)
  })
})

describe('包围盒与空画布契约', () => {
  it('空画布无包围盒——导出据此返回 null，不发空白 PNG', () => {
    expect(documentBounds(createEmptyDocument())).toBeNull()
    expect(new CanvasEngine().isEmpty()).toBe(true)
  })

  it('包围盒覆盖整笔——收笔的笔迹必须画到抬笔点（last 语义）', () => {
    const engine = new CanvasEngine()
    drawLine(engine, 10, 10, 50, 50)
    const bounds = engine.getBounds()
    expect(bounds).not.toBeNull()
    expect(bounds!.minX).toBeLessThanOrEqual(10)
    expect(bounds!.maxX).toBeGreaterThanOrEqual(50)
  })

  it('未收笔时轮廓滞后于输入，收笔后补齐到末点', () => {
    const engine = new CanvasEngine()
    engine.beginStroke(10, 10, 0.5, '#000', 4)
    engine.extendStroke(30, 30, 0.5)
    engine.extendStroke(50, 50, 0.5)
    const pending = engine.getPendingStroke()!
    const lagging = Math.max(...strokeOutline(pending, false).map(([x]) => x))
    const settled = Math.max(...strokeOutline(pending, true).map(([x]) => x))
    expect(settled).toBeGreaterThan(lagging)
  })
})

describe('视口', () => {
  it('屏幕坐标按视口换算回文档坐标', () => {
    const engine = new CanvasEngine()
    engine.panBy(100, 50)
    expect(engine.toDocumentPoint(150, 100)).toEqual({ x: 50, y: 50 })
  })

  it('以锚点缩放时锚点下的文档坐标不变', () => {
    const engine = new CanvasEngine()
    const before = engine.toDocumentPoint(200, 200)
    engine.zoomAt(200, 200, 2)
    const after = engine.toDocumentPoint(200, 200)
    expect(after.x).toBeCloseTo(before.x, 6)
    expect(after.y).toBeCloseTo(before.y, 6)
    expect(engine.viewport.zoom).toBe(2)
  })

  it('缩放钳制在 0.1–8 之间', () => {
    const engine = new CanvasEngine()
    for (let i = 0; i < 20; i++) engine.zoomAt(0, 0, 2)
    expect(engine.viewport.zoom).toBe(8)
    for (let i = 0; i < 40; i++) engine.zoomAt(0, 0, 0.5)
    expect(engine.viewport.zoom).toBe(0.1)
  })
})

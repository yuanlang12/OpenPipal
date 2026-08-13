import { CanvasEngine } from './canvasEngine'

/** 导出留白，与旧实现保持一致（padding:16），避免笔迹贴边 */
const EXPORT_PADDING = 16

/** Blob → 纯 base64(无 data: 前缀,符合 OpenPipal images[] 约定,见 InputBar.tsx:151) */
export async function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onloadend = () => {
      const dataUrl = reader.result as string
      resolve((dataUrl || '').split(',')[1] || '')
    }
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(blob)
  })
}

function canvasToBlob(canvas: HTMLCanvasElement): Promise<Blob | null> {
  return new Promise(resolve => canvas.toBlob(resolve, 'image/png'))
}

/**
 * 把画布全部笔迹渲染成 PNG → base64;失败返回 null,调用方降级为纯文本。
 * 复用于 useCaveStateMachine 的周期性观察 + CanvasOrb 的学生主动求助两条路径。
 *
 * 空画布必须返回 null 而不是一张白图：两条调用路径都靠它避免把空白图片喂给视觉模型。
 */
export async function exportCanvasSnapshot(engine: CanvasEngine): Promise<string | null> {
  try {
    const bounds = engine.getBounds()
    if (!bounds) return null

    const width = Math.max(1, Math.ceil(bounds.maxX - bounds.minX) + EXPORT_PADDING * 2)
    const height = Math.max(1, Math.ceil(bounds.maxY - bounds.minY) + EXPORT_PADDING * 2)
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const ctx = canvas.getContext('2d')
    if (!ctx) return null

    // 白底：导出给视觉模型看，透明底在多数渲染器里会变黑
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, width, height)
    ctx.translate(EXPORT_PADDING - bounds.minX, EXPORT_PADDING - bounds.minY)
    CanvasEngine.paintStrokes(ctx, engine.getDocument().strokes)

    const blob = await canvasToBlob(canvas)
    if (!blob) return null
    return await blobToBase64(blob)
  } catch (err) {
    console.warn('[Canvas] 画布快照失败:', err)
    return null
  }
}

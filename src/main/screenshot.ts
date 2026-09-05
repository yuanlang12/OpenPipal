import { execFile } from 'child_process'
import { promisify } from 'util'
import { tmpdir } from 'os'
import { join } from 'path'
import { unlink, readFile } from 'fs/promises'
import { randomUUID } from 'crypto'
import { getTrackedBounds, getTrackedWindow, getAppWindowIdByBounds } from './window-tracker'

const execFileAsync = promisify(execFile)

const MAX_SCREENSHOT_WIDTH = 1920

/** 一个 Electron desktopCapturer 的窗口源；Windows 上 id 形如 `window:<HWND>:0` */
export interface CapturerWindowSource {
  id: string
  name: string
}

/**
 * 在 desktopCapturer 的窗口源里找正在跟随的那个：先按 HWND 精确匹配 id，再退回按标题匹配
 * （标题会变，HWND 不会；两者都对不上就当窗口已经没了）。纯函数，好测。
 */
export function pickWindowSource<T extends CapturerWindowSource>(
  sources: T[],
  tracked: { handle: string; title: string }
): T | null {
  const byHandle = sources.find(source => source.id === `window:${tracked.handle}:0`)
  if (byHandle) return byHandle
  if (tracked.title) {
    const byTitle = sources.find(source => source.name === tracked.title)
    if (byTitle) return byTitle
  }
  return null
}

// Windows：Electron 自带的 desktopCapturer 能按窗口抓图，不需要系统权限也不需要外部命令。
// 缩略图尺寸按窗口的物理像素给，拿到的就是原分辨率；再压到 1920 宽、JPEG 80，与 macOS 那条路同一口径。
async function captureTargetWindowWin32(): Promise<string | null> {
  const tracked = getTrackedWindow()
  const bounds = getTrackedBounds()
  if (!tracked || !bounds) return null
  const { desktopCapturer, screen } = await import('electron')
  const physical = screen.dipToScreenRect(null, bounds)
  const sources = await desktopCapturer.getSources({
    types: ['window'],
    thumbnailSize: { width: Math.max(1, physical.width), height: Math.max(1, physical.height) },
    fetchWindowIcons: false
  })
  const source = pickWindowSource(sources, tracked)
  if (!source || source.thumbnail.isEmpty()) return null
  let image = source.thumbnail
  if (image.getSize().width > MAX_SCREENSHOT_WIDTH) {
    image = image.resize({ width: MAX_SCREENSHOT_WIDTH })
  }
  return image.toJPEG(80).toString('base64')
}

export async function captureTargetWindow(): Promise<string | null> {
  if (process.platform === 'win32') {
    try {
      return await captureTargetWindowWin32()
    } catch (err) {
      console.error('Screenshot failed:', err)
      return null
    }
  }
  // screencapture + CGWindowList 只有 macOS
  if (process.platform !== 'darwin') return null
  const bounds = getTrackedBounds()
  if (!bounds) return null

  const windowId = await getAppWindowIdByBounds('', bounds)
  if (!windowId) return null

  const tmpPath = join(tmpdir(), `openpipal-screenshot-${randomUUID()}.png`)

  try {
    await execFileAsync('screencapture', [
      `-l${windowId}`,
      '-x',
      '-o',
      '-t',
      'png',
      tmpPath
    ])

    const sharp = require('sharp')
    const compressed = await sharp(tmpPath)
      .resize({ width: MAX_SCREENSHOT_WIDTH, withoutEnlargement: true })
      .jpeg({ quality: 80 })
      .toBuffer()

    return compressed.toString('base64')
  } catch (err) {
    console.error('Screenshot failed:', err)
    return null
  } finally {
    try {
      await unlink(tmpPath)
    } catch {}
  }
}

export async function checkScreenCapturePermission(): Promise<boolean> {
  if (process.platform !== 'darwin') return true // 其他平台没有「屏幕录制」授权这个概念
  try {
    const tmpPath = join(tmpdir(), `openpipal-perm-check-${randomUUID()}.png`)
    await execFileAsync('screencapture', ['-x', '-t', 'png', tmpPath])
    const data = await readFile(tmpPath)
    await unlink(tmpPath).catch(() => {})
    return data.length > 0
  } catch {
    return false
  }
}

import { execFile } from 'child_process'
import { promisify } from 'util'
import { tmpdir } from 'os'
import { join } from 'path'
import { unlink, readFile } from 'fs/promises'
import { randomUUID } from 'crypto'
import { getTrackedBounds, getAppWindowIdByBounds } from './window-tracker'

const execFileAsync = promisify(execFile)

export async function captureTargetWindow(): Promise<string | null> {
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
      .resize({ width: 1920, withoutEnlargement: true })
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

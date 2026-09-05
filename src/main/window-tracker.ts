import { BrowserWindow, screen, shell } from 'electron'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { getTargetConfig, TargetAppConfig } from './app-config'
import { isExtensionActive } from './browser-context-store'
import { loadConfig } from './config-manager'
import { tMain } from './main-i18n'
import type { SupportedLocale } from '../shared/i18n/contract'
import { getLocaleState } from './locale-manager'
import { renderBrowserNotificationHtml } from './browser-notification-html'
import { isAppFollowingEnabled } from './app-follow-settings'
import { disposeWin32ForegroundHelper } from './win32-foreground'

export { renderBrowserNotificationHtml } from './browser-notification-html'

const execFileAsync = promisify(execFile)
const AI_WINDOW_WIDTH = 400
const AI_WINDOW_WIDTH_UNDOCKED = 1280
const UNDOCK_THRESHOLD = 50 // 拔出判定阈值（px）
const ORB_SIZE = 72 // 悬浮球窗口尺寸（方形容器，内部渲染圆形）
const ORB_MARGIN = 20 // 悬浮球距离屏幕边缘的边距

// 浏览器提示浮窗：每次启动最多弹一次
let browserNotificationShown = false
let promptWindow: BrowserWindow | null = null
let promptBrowserName: string | null = null

export function refreshBrowserNotificationLocale(locale: SupportedLocale): void {
  if (!promptWindow || promptWindow.isDestroyed() || !promptBrowserName) return
  const html = renderBrowserNotificationHtml(promptBrowserName, locale, tMain)
  void promptWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`)
    .catch((error) => console.warn('[Locale] browser prompt refresh failed:', error))
}

function showBrowserNotification(browserName: string) {
  if (browserNotificationShown || promptWindow) return

  // 插件已安装且活跃 → 不弹提醒
  if (isExtensionActive()) {
    console.log('[OpenPipal] 浏览器插件已活跃，跳过提醒')
    return
  }

  browserNotificationShown = true
  promptBrowserName = browserName

  const cursorPoint = screen.getCursorScreenPoint()
  const display = screen.getDisplayNearestPoint(cursorPoint)
  const { x: dx, y: dy, width: dw } = display.workArea
  const winW = 360, winH = 160

  promptWindow = new BrowserWindow({
    width: winW,
    height: winH,
    x: dx + dw - winW - 16,
    y: dy + 12,
    frame: false,
    alwaysOnTop: true,
    resizable: false,
    skipTaskbar: true,
    transparent: true,
    hasShadow: true,
    webPreferences: { nodeIntegration: false, contextIsolation: true }
  })

  const html = renderBrowserNotificationHtml(browserName, getLocaleState().locale, tMain)

  void promptWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`)
    .catch((error) => console.warn('[Locale] initial browser prompt load failed:', error))

  promptWindow.webContents.on('will-navigate', (_e, url) => {
    if (url.includes('install-extension')) {
      // 跳到 GitHub Releases 最新版,用户在那里下载 openpipal-extension.zip + 解压安装
      shell.openExternal('https://github.com/yuanlang12/OpenPipal/releases/latest')
      promptWindow?.close()
    }
  })

  promptWindow.on('closed', () => {
    promptWindow = null
    promptBrowserName = null
  })

  // 10 秒后自动关闭
  setTimeout(() => { promptWindow?.close() }, 10000)

  console.log(`[OpenPipal] 浏览器提示浮窗: ${browserName}`)
}

export interface TargetAppStatus {
  connected: boolean
  appName?: string
  windowTitle?: string
  /** 前台应用是否处于 macOS 原生全屏（独立 Space）— 用于 Orb 悬浮球模式触发 */
  isFullscreen?: boolean
}

type StatusCallback = (status: TargetAppStatus) => void
type AppChangedCallback = (appName: string, config: TargetAppConfig) => void

let trackingInterval: ReturnType<typeof setInterval> | null = null
let lastBoundsStr = ''
let statusCallback: StatusCallback | null = null
let appChangedCallback: AppChangedCallback | null = null
let lastConnected = false
// 上一次上报的 fullscreen 状态 — 用于检测 ClassIn 切全屏/退全屏的时刻
// 初始 null 表示"从未上报"，第一次必定触发一次回调
let lastFullscreen: boolean | null = null

// 当前追踪的目标进程名 — 启动时为空哨兵，等 detector tick 拿到真实前台应用再绑定。
// 历史上这里硬编码 'ClassIn'，是 OpenPipal 早期专为 ClassIn 设计的尾巴；产品泛化后
// 如果用户禁用了所有应用，detector 永远返回 null，currentProcessName 卡在 ClassIn 不变，
// 表现为"明明 ClassIn 没开，OpenPipal 却挂靠到一个 ClassIn 幽灵窗口"。空字符串是"未挂靠"
// 的合法初始态——detector 拿到任何非禁用前台应用时会自动通过 setTargetProcess 绑定。
let currentProcessName = ''
let currentConfig: TargetAppConfig = getTargetConfig(currentProcessName)

// 当前追踪的窗口 bounds（用于截图时匹配）
let trackedBounds: { x: number; y: number; width: number; height: number } | null = null
// Windows：当前追踪窗口的句柄与进程（截图按 HWND 找 desktopCapturer 源，粘贴按它提前台）；macOS 为 null
let trackedWindow: { handle: string; pid: number; title: string } | null = null

// 拔出/独立模式
let isUndocked = false
let isAutoMoving = false  // 标记：代码正在移动窗口（区分用户拖拽）
let expectedBounds: { x: number; y: number; width: number; height: number } | null = null
let undockedFromApp: string | null = null  // 脱出时的前台应用，避免同应用下反复回归

// FullScreenAuxiliary 动态开关：仅当挂靠目标真全屏（AXFullScreen）时才让窗口浮于
// 全屏 Space 之上；平时保持普通窗口行为，否则 app 无法成为前台应用（菜单栏不显示 OpenPipal）。
let fsAuxOn: boolean | null = null
function applyFullscreenAux(win: BrowserWindow, on: boolean): void {
  // Space / FullScreenAuxiliary 是 macOS 概念，其他平台这个调用没有意义
  if (process.platform !== 'darwin') return
  if (fsAuxOn === on) return
  fsAuxOn = on
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: on })
  console.log(`[OpenPipal] FullScreenAuxiliary ${on ? 'ON（目标全屏）' : 'OFF（普通窗口，可成为前台）'}`)
}

export function getTrackedBounds() {
  return trackedBounds
}

/** Windows 专用：正在跟随的窗口句柄；macOS 或未连上时 null */
export function getTrackedWindow(): { handle: string; pid: number; title: string } | null {
  return trackedWindow
}

export function getCurrentProcessName(): string {
  return currentProcessName
}

export function getCurrentConfig(): TargetAppConfig {
  return currentConfig
}

/**
 * 是否**真的**挂靠在某个前台应用上 —— 「能不能把该应用的信息交给模型」的唯一判据。
 *
 * 三件事必须同时成立,缺一不可:
 *   1. 全局跟随开关开着(用户明确同意 OpenPipal 观察前台应用)
 *   2. tracker 确实连上了目标
 *   3. 目标有名字(空 processName 是「未挂靠」的合法初始态)
 *
 * 为什么不能只看 lastConnected:跟随关掉后轮询就停了,lastConnected 会停在最后
 * 一次的值上,于是「关了开关却仍然报得出应用名」。开关必须是第一道门。
 */
export function isDockedToTargetApp(): boolean {
  if (!isAppFollowingEnabled()) return false
  if (!lastConnected) return false
  return (currentConfig.displayName || currentProcessName).trim() !== ''
}

/** Phase 6d：pi-tool get_environment 用，暴露当前"挂靠模式"决策所需的状态 */
export function getEnvironmentSnapshot(): {
  mode: 'orb' | 'docked' | 'undocked'
  foregroundApp: string
  isFullscreen: boolean
  connected: boolean
} {
  // 未挂靠时不透出任何前台应用信息:模式如实报 undocked(独立窗口),应用名给空串。
  // 之前无条件返回 currentConfig.displayName,等于跟随开关关着也能被工具问出
  // 用户正在用什么应用。
  if (!isDockedToTargetApp()) {
    return { mode: 'undocked', foregroundApp: '', isFullscreen: false, connected: false }
  }
  const isFullscreen = lastFullscreen === true
  const mode = isUndocked ? 'undocked' : isFullscreen ? 'orb' : 'docked'
  return {
    mode,
    foregroundApp: currentConfig.displayName || currentProcessName,
    isFullscreen,
    connected: lastConnected
  }
}

export function setTargetProcess(processName: string, displayName?: string): void {
  if (processName === currentProcessName) return
  currentProcessName = processName
  currentConfig = getTargetConfig(processName, displayName)
  // 重置 bounds 追踪状态
  lastBoundsStr = ''
  trackedBounds = null
  trackedWindow = null
  lastConnected = false
  lastFullscreen = null
}

// 用 CGWindowList 按 bounds 匹配找到对应的窗口 ID（不依赖 owner name，兼容所有应用）
export async function getAppWindowIdByBounds(
  _processName: string,
  targetBounds: { x: number; y: number; width: number; height: number }
): Promise<number | null> {
  if (process.platform !== 'darwin') return null // CGWindowList + swift 只有 macOS 有
  try {
    const { stdout } = await execFileAsync('swift', [
      '-e',
      `
import CoreGraphics
let tx = ${targetBounds.x}, ty = ${targetBounds.y}
let tw = ${targetBounds.width}, th = ${targetBounds.height}
if let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly], kCGNullWindowID) as? [[String: Any]] {
  for w in list {
    guard let layer = w[kCGWindowLayer as String] as? Int, layer == 0 else { continue }
    if let b = w[kCGWindowBounds as String] as? [String: Any],
       let bx = b["X"] as? Int, let by = b["Y"] as? Int,
       let bw = b["Width"] as? Int, let bh = b["Height"] as? Int {
      if abs(bx - tx) <= 2 && abs(by - ty) <= 2 && abs(bw - tw) <= 2 && abs(bh - th) <= 2 {
        if let id = w[kCGWindowNumber as String] as? Int {
          print(id)
          break
        }
      }
    }
  }
}
`
    ])
    const id = parseInt(stdout.trim(), 10)
    return isNaN(id) ? null : id
  } catch {
    return null
  }
}

// 检测"有效全屏"：ClassIn 这类自绘 maximize 不会触发 AXFullScreen，
// 但窗口已覆盖 workArea 或 display，同样会遮挡 OpenPipal 侧栏。
// 三种情形任一命中即视为有效全屏：① AXFullScreen=true；② 覆盖 workArea（menubar 仍可见的 maximize）；③ 覆盖整个 display（自绘覆盖 menubar）
function isEffectivelyFullscreen(appBounds: {
  x: number
  y: number
  width: number
  height: number
  isFullscreen: boolean
}): boolean {
  if (appBounds.isFullscreen) return true
  const display = screen.getDisplayMatching({
    x: appBounds.x,
    y: appBounds.y,
    width: appBounds.width,
    height: appBounds.height
  })
  const slop = 4
  const covers = (ref: { x: number; y: number; width: number; height: number }) =>
    Math.abs(appBounds.x - ref.x) <= slop &&
    Math.abs(appBounds.y - ref.y) <= slop &&
    Math.abs(appBounds.width - ref.width) <= slop &&
    Math.abs(appBounds.height - ref.height) <= slop
  return covers(display.workArea) || covers(display.bounds)
}

// 悬浮球位置：目标应用所在 display 的 workArea 右下角（留 margin 避免贴边）
// workArea 已经排除了 menubar / dock 占用区，哪怕 ClassIn 自绘覆盖也安全
function calculateOrbBounds(appBounds: {
  x: number; y: number; width: number; height: number
}): { x: number; y: number; width: number; height: number } {
  const display = screen.getDisplayMatching({
    x: appBounds.x,
    y: appBounds.y,
    width: appBounds.width,
    height: appBounds.height
  })
  const wa = display.workArea
  return {
    x: wa.x + wa.width - ORB_SIZE - ORB_MARGIN,
    y: wa.y + wa.height - ORB_SIZE - ORB_MARGIN,
    width: ORB_SIZE,
    height: ORB_SIZE
  }
}

function calculateBounds(targetBounds: {
  x: number
  y: number
  width: number
  height: number
}): { x: number; y: number; width: number; height: number } {
  const display = screen.getDisplayMatching({
    x: targetBounds.x,
    y: targetBounds.y,
    width: targetBounds.width,
    height: targetBounds.height
  })
  const workArea = display.workArea
  const screenRight = workArea.x + workArea.width

  // 优先放右侧
  let x = targetBounds.x + targetBounds.width

  if (x + AI_WINDOW_WIDTH > screenRight) {
    // 右侧放不下：尝试左侧
    const leftX = targetBounds.x - AI_WINDOW_WIDTH
    if (leftX >= workArea.x) {
      x = leftX
    } else {
      // 左右都放不下（应用接近全屏）：贴在屏幕右边缘内侧
      x = screenRight - AI_WINDOW_WIDTH
    }
  }

  return {
    x,
    y: targetBounds.y,
    width: AI_WINDOW_WIDTH,
    height: targetBounds.height
  }
}

export function onStatusChange(callback: StatusCallback): void {
  statusCallback = callback
}

export function onAppChanged(callback: AppChangedCallback): void {
  appChangedCallback = callback
}

export function startTracking(aiWindow: BrowserWindow): void {
  if (trackingInterval) return
  if (process.platform !== 'darwin' && process.platform !== 'win32') {
    // 前台窗口数据源只有 macOS（osascript）与 Windows（PowerShell 探针，见 win32-foreground.ts）两份。
    // 别的平台不起轮询，否则每秒一次 ENOENT。
    console.log('[OpenPipal] 应用跟随在当前平台暂不可用，跳过轮询')
    return
  }

  let polling = false
  const POLL_INTERVAL = 1000

  // 监听用户拖拽结束：检测是否拔出
  aiWindow.on('moved', () => {
    if (isAutoMoving || !expectedBounds) return
    // orb 模式下拖动只是重新定位，不视为"拔出"（下一次轮询会把它弹回右下角）
    if (lastFullscreen) return
    // moved 事件在拖拽结束时触发（不是拖拽过程中）
    const actual = aiWindow.getBounds()
    const dx = Math.abs(actual.x - expectedBounds.x)
    const dy = Math.abs(actual.y - expectedBounds.y)
    if (dx > UNDOCK_THRESHOLD || dy > UNDOCK_THRESHOLD) {
      if (!isUndocked) {
        isUndocked = true
        undockedFromApp = currentProcessName  // 记住脱出时的前台应用
        isAutoMoving = true
        aiWindow.setBounds({
          x: actual.x,
          y: actual.y,
          width: AI_WINDOW_WIDTH_UNDOCKED,
          height: actual.height
        })
        setTimeout(() => { isAutoMoving = false }, 300)
        statusCallback?.({ connected: false, appName: '独立模式' })
        applyFullscreenAux(aiWindow, false)
        console.log('[OpenPipal] 拔出 → 独立模式')
      }
    }
  })

  console.log(`[OpenPipal] 跟踪已启动，轮询间隔 ${POLL_INTERVAL}ms`)

  trackingInterval = setInterval(async () => {
    if (polling) return
    // A global pause means no app-following work at all. In particular, do
    // not invoke System Events merely to refresh the detected-app list: that
    // would still trigger macOS Accessibility/Automation permission prompts
    // even though OpenPipal cannot move or notify about the foreground app.
    // The environment switch is intentionally only an opt-out: it lets an
    // isolated QA launch exercise chat without asking macOS for Accessibility
    // permission before the Settings UI is available. Normal product state is
    // still governed by the persisted global setting above.
    if (process.env.OPENPIPAL_DISABLE_APP_TRACKING === '1' || !isAppFollowingEnabled()) return
    polling = true

    try {
      const { getFrontmostApp } = await import('./app-detector')
      const frontApp = await getFrontmostApp()

      // 前台是 OpenPipal 自己 / 被禁用应用 / 系统进程时，frontApp === null。
      // 老逻辑会落到 line 436 用 currentProcessName 继续查老应用 bounds 强行 setBounds，
      // 导致用户在 OpenPipal 上拖拽时窗口反复被吸回挂靠位（变成 400px 窄条）。
      // 用户在 OpenPipal 上交互时不需要持续跟随老挂靠对象 — 跟随逻辑等下次切回真应用再恢复。
      if (!frontApp) return

      if (frontApp) {
        // 浏览器：不跟随，弹通知引导安装插件
        if (frontApp.isBrowser) {
          if (currentProcessName !== frontApp.processName) {
            currentProcessName = frontApp.processName
            statusCallback?.({ connected: false, appName: frontApp.appName })
            showBrowserNotification(frontApp.appName)
          }
          return
        }

        // 独立模式下，切换到另一个非浏览器应用 → 回归跟随
        // 同一个应用下不回归，避免拖拽后立刻被吸回
        if (isUndocked && frontApp.processName !== undockedFromApp) {
          isUndocked = false
          undockedFromApp = null
          lastBoundsStr = ''
          if (frontApp.processName !== currentProcessName) {
            setTargetProcess(frontApp.processName, frontApp.appName)
            appChangedCallback?.(frontApp.appName, currentConfig)
          }
          statusCallback?.({ connected: true, appName: currentConfig.displayName, windowTitle: currentConfig.displayName })
          isAutoMoving = true
          aiWindow.setBounds({ ...aiWindow.getBounds(), width: AI_WINDOW_WIDTH })
          setTimeout(() => { isAutoMoving = false }, 300)
          console.log('[OpenPipal] 回归跟随模式')
          lastConnected = true
        } else if (frontApp.processName !== currentProcessName) {
          const oldProcess = currentProcessName
          setTargetProcess(frontApp.processName, frontApp.appName)
          appChangedCallback?.(frontApp.appName, currentConfig)
          statusCallback?.({ connected: false, appName: currentConfig.displayName })
          console.log(`[OpenPipal] Target switched: ${oldProcess} → ${frontApp.processName}`)
        }
      }

      // 独立模式下不跟随
      if (isUndocked) return

      // bounds 已随 getFrontmostApp 合并 osascript 一起拿回（frontApp.processName 此刻必等于
      // currentProcessName，见 setTargetProcess 分支），不再需要单独 spawn 第二个 osascript 进程
      const appBounds = frontApp.bounds

      if (!appBounds || appBounds.width === 0) {
        if (lastConnected) {
          lastConnected = false
          lastFullscreen = null
          trackedBounds = null
          trackedWindow = null
          statusCallback?.({ connected: false, appName: currentConfig.displayName })
          applyFullscreenAux(aiWindow, false)
        }
        return
      }

      trackedBounds = appBounds
      trackedWindow = frontApp.windowHandle
        ? { handle: frontApp.windowHandle, pid: frontApp.pid ?? 0, title: frontApp.windowTitle ?? '' }
        : null
      applyFullscreenAux(aiWindow, appBounds.isFullscreen === true)
      // Orb 模式(前台 app 全屏时主窗口缩成 72×72 圆球)已彻底移除——
      // 始终保持 dock 模式,前台 app 全屏时 openpipal 仍以原 dock 尺寸贴边。
      // 旧逻辑保留在 isEffectivelyFullscreen / calculateOrbBounds 里作为死代码,
      // 等后续清理。renderer 侧 OrbView 短路也已移除。
      const isFs = false

      // 首次连接 OR fullscreen 翻转 → 重新上报 status（Phase 2 会用 isFullscreen 触发 orb 切换）
      if (!lastConnected || lastFullscreen !== isFs) {
        if (!lastConnected) console.log(`[OpenPipal] Connected to ${currentProcessName}, fullscreen=${isFs} (AX=${appBounds.isFullscreen}, covers=${isFs && !appBounds.isFullscreen})`)
        else console.log(`[OpenPipal] Fullscreen changed: ${lastFullscreen} → ${isFs}`)
        lastConnected = true
        lastFullscreen = isFs
        statusCallback?.({
          connected: true,
          appName: currentConfig.displayName,
          windowTitle: currentConfig.displayName,
          isFullscreen: isFs
        })
      }

      // Phase 2：fullscreen 下变身 orb（72×72 右下角），否则沿用原 dock bounds
      const newBounds = isFs ? calculateOrbBounds(appBounds) : calculateBounds(appBounds)
      const boundsStr = JSON.stringify(newBounds)
      if (boundsStr !== lastBoundsStr) {
        lastBoundsStr = boundsStr
        expectedBounds = newBounds
        isAutoMoving = true
        aiWindow.setBounds(newBounds)
        // 透明窗的投影是从 alpha mask 推导出来的,macOS 会缓存它;跟随过程中边界不断变,
        // 缓存不失效就会在新位置留下旧形状的残影。Electron 没有 invalidateShadow,
        // 翻一下 hasShadow 是通行的强制重算手法。
        if (process.platform === 'darwin' && aiWindow.hasShadow()) { aiWindow.setHasShadow(false); aiWindow.setHasShadow(true) }
        // 读回实际 bounds，确认 macOS 没有 clamp 到更大尺寸（minWidth/minHeight 常见陷阱）
        const actualBounds = aiWindow.getBounds()
        const clamped =
          actualBounds.width !== newBounds.width || actualBounds.height !== newBounds.height
        console.log(
          `[OpenPipal] setBounds want=${newBounds.width}x${newBounds.height}@(${newBounds.x},${newBounds.y}) actual=${actualBounds.width}x${actualBounds.height}@(${actualBounds.x},${actualBounds.y})${clamped ? ' CLAMPED!' : ''}`
        )
        setTimeout(() => { isAutoMoving = false }, 500)
      }
      // 更新 expectedBounds（即使位置没变也要记录）
      expectedBounds = newBounds
    } finally {
      polling = false
    }
  }, POLL_INTERVAL)
}

export function stopTracking(): void {
  if (trackingInterval) {
    clearInterval(trackingInterval)
    trackingInterval = null
  }
  // Windows 的探针是长驻子进程，轮询停了它也该收掉；macOS 上从未起过，是 no-op
  disposeWin32ForegroundHelper()
}

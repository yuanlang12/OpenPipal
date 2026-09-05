import { execFile } from 'child_process'
import { promisify } from 'util'
import { addDetectedApp, isAppFollowingEnabled, shouldFollowDetectedApp } from './app-follow-settings'
import { resolveWindowsTargetKey } from './app-config'
import {
  classifyWin32Window,
  getForegroundWindowWin32,
  win32WindowToAppBounds,
  type Rectangle
} from './win32-foreground'

const execFileAsync = promisify(execFile)

// 排除列表：OpenPipal 自身、系统应用（macOS 进程名；Windows 的对应清单在 win32-foreground.ts）
const IGNORED_APPS = new Set([
  'OpenPipal',
  'Electron',
  'Finder',
  'SystemUIServer',
  'Spotlight',
  'Control Center',
  'WindowServer',
  'Dock',
  'loginwindow',
  'NotificationCenter',
  'AirPlayUIAgent'
])

// 浏览器列表：检测到时不跟随，而是提示安装插件（macOS 进程名；Windows 的 exe 名见 BROWSER_WIN32_PROCESSES）
export const BROWSER_APPS = new Set([
  'Google Chrome',
  'Arc',
  'Safari',
  'Firefox',
  'Microsoft Edge',
  'Brave Browser',
  'Opera',
  'Chromium'
])

// 日志降噪：仅在应用切换时输出
let lastLoggedApp = ''

// 前台进程"最大有效窗口"的 bounds + AXFullScreen 状态
export interface AppBoundsInfo {
  x: number
  y: number
  width: number
  height: number
  isFullscreen: boolean
}

export interface FrontmostAppInfo {
  processName: string
  appName: string
  isBrowser?: boolean
  /** 该进程当前窗口的 bounds；取不到窗口/属性时为 null（不影响 processName 的可靠性） */
  bounds: AppBoundsInfo | null
  /** Windows：前台窗口的 HWND（十进制字符串），截图与粘贴按它找窗口；macOS 不带 */
  windowHandle?: string
  /** Windows：前台窗口所属进程 id */
  pid?: number
  /** Windows：前台窗口标题 */
  windowTitle?: string
}

// 解析合并 AppleScript 返回的 bounds 分段："x,y,w,h,fullscreen" 或 "ERR"
function parseBoundsPart(part: string): AppBoundsInfo | null {
  if (!part || part === 'ERR') return null
  const segs = part.split(',')
  const [x, y, w, h] = segs.slice(0, 4).map(Number)
  if (isNaN(x) || isNaN(y) || isNaN(w) || isNaN(h)) return null
  const isFullscreen = segs[4]?.trim().toLowerCase() === 'true'
  return { x, y, width: w, height: h, isFullscreen }
}

interface DetectedCandidate {
  processName: string
  appName: string
  isBrowser: boolean
  bounds: AppBoundsInfo | null
  /** Windows 专属附加信息；macOS 传空对象，返回值就与历史形状逐字段相同 */
  extras?: Pick<FrontmostAppInfo, 'windowHandle' | 'pid' | 'windowTitle'>
}

/**
 * 两个平台共用的"要不要跟随它"闸门：记录检测到的应用 → 浏览器只在总开关开着时上报（不贴靠）
 * → 逐应用禁用 → 切换日志。数据源（osascript / PowerShell 探针）各自负责把前台窗口变成候选。
 */
function applyFollowGate(candidate: DetectedCandidate): FrontmostAppInfo | null {
  const { processName, appName, extras = {} } = candidate
  // 键与显示名不同（Windows：WINWORD / Microsoft Word）时把名字一并记下，设置页照名字显示
  if (appName !== processName) addDetectedApp(processName, appName)
  else addDetectedApp(processName)
  if (candidate.isBrowser) {
    // 总开关暂停时浏览器也不得进入 window-tracker，避免插件提示等跟随副作用。
    if (!isAppFollowingEnabled()) return null
    // 浏览器不跟随贴靠，bounds 用不上——JS 侧直接丢弃（排除清单本身仍只活在这里，不进 AppleScript）
    return { processName, appName, isBrowser: true, bounds: null, ...extras } as FrontmostAppInfo
  }
  // 即使全局暂停也保留检测记录；恢复后用户仍可沿用逐应用设置。
  if (!shouldFollowDetectedApp(processName)) {
    return null
  }
  // 仅在应用切换时输出日志
  if (processName !== lastLoggedApp) {
    console.log(`[AppDetector] 前台切换: ${processName}${appName !== processName ? `（${appName}）` : ''}`)
    lastLoggedApp = processName
  }
  return { processName, appName, bounds: candidate.bounds, ...extras }
}

// 单次 osascript 拿全：frontmost 进程名 + 该进程窗口 bounds/AXFullScreen。
// 原来是两个独立 spawn（本文件取名 + window-tracker.getAppBoundsViaAS 再取 bounds），
// 每 tick 两个进程；合并后同一个 tell 块内先定位 frontProc，再直接取它的 windows，
// 免去按名字二次查找的开销，也天然保证 bounds 一定属于同一个进程。
// bounds 计算整体包一层 try：算不出时返回 "ERR"，绝不能因此丢掉 procName。
async function getFrontmostAppDarwin(): Promise<FrontmostAppInfo | null> {
  const { stdout } = await execFileAsync('osascript', [
    '-e',
    `
tell application "System Events"
  set frontProc to first application process whose frontmost is true
  set procName to name of frontProc
  set boundsPart to "ERR"
  try
    set winList to windows of frontProc
    repeat with w in winList
      set winSize to size of w
      set ww to item 1 of winSize
      set wh to item 2 of winSize
      if ww > 100 and wh > 100 then
        set winPos to position of w
        set fs to "false"
        try
          set fs to (value of attribute "AXFullScreen" of w) as text
        end try
        set boundsPart to (item 1 of winPos as text) & "," & (item 2 of winPos as text) & "," & (ww as text) & "," & (wh as text) & "," & fs
        exit repeat
      end if
    end repeat
  end try
  return procName & "|" & boundsPart
end tell
`
  ], { timeout: 3000 })
  const raw = stdout.trim()
  // lastIndexOf:进程名本身可能含 '|'(如 'App | Beta'),boundsPart 构造上不含 '|',末位分隔符才是真界
  const sepIdx = raw.lastIndexOf('|')
  const processName = sepIdx === -1 ? raw : raw.slice(0, sepIdx)
  const boundsPart = sepIdx === -1 ? '' : raw.slice(sepIdx + 1)
  if (!processName || IGNORED_APPS.has(processName)) {
    return null
  }
  return applyFollowGate({
    processName,
    appName: processName,
    isBrowser: BROWSER_APPS.has(processName),
    bounds: parseBoundsPart(boundsPart)
  })
}

/**
 * Win32 物理像素 → Electron 的 DIP 坐标（跟随逻辑与 BrowserWindow.setBounds 都按 DIP 算）。
 * electron 按需引入：这个模块也在单测里跑，那里没有 Electron。
 */
async function win32AppBounds(snapshot: NonNullable<Awaited<ReturnType<typeof getForegroundWindowWin32>>>): Promise<AppBoundsInfo | null> {
  const { screen } = await import('electron')
  return win32WindowToAppBounds(
    snapshot,
    (physical: Rectangle) => screen.screenToDipRect(null, physical),
    (dip: Rectangle) => screen.getDisplayMatching(dip).bounds
  )
}

// Windows：长驻 PowerShell 探针报前台窗口（HWND / 进程 / 标题 / 物理像素矩形），
// 这里换成 DIP、分出"OpenPipal 自己 / 系统壳 / 浏览器 / 应用"，再过同一道跟随闸门。
async function getFrontmostAppWin32(): Promise<FrontmostAppInfo | null> {
  const snapshot = await getForegroundWindowWin32()
  if (!snapshot) return null
  const classified = classifyWin32Window(snapshot, process.pid, resolveWindowsTargetKey)
  if (classified.kind === 'self' || classified.kind === 'shell') return null
  const bounds = classified.kind === 'browser' ? null : await win32AppBounds(snapshot)
  return applyFollowGate({
    processName: classified.processName,
    appName: classified.appName,
    isBrowser: classified.kind === 'browser',
    bounds,
    extras: { windowHandle: snapshot.hwnd, pid: snapshot.pid, windowTitle: snapshot.title }
  })
}

export async function getFrontmostApp(): Promise<FrontmostAppInfo | null> {
  try {
    if (process.platform === 'darwin') return await getFrontmostAppDarwin()
    if (process.platform === 'win32') return await getFrontmostAppWin32()
    return null
  } catch (err: any) {
    console.error(`[AppDetector] 错误:`, err.message?.substring(0, 100))
    return null
  }
}

import { execFile } from 'child_process'
import { promisify } from 'util'
import { addDetectedApp, isAppFollowingEnabled, shouldFollowDetectedApp } from './app-follow-settings'

const execFileAsync = promisify(execFile)

// 排除列表：OpenPipal 自身、系统应用
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

// 浏览器列表：检测到时不跟随，而是提示安装插件
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

// 单次 osascript 拿全：frontmost 进程名 + 该进程窗口 bounds/AXFullScreen。
// 原来是两个独立 spawn（本文件取名 + window-tracker.getAppBoundsViaAS 再取 bounds），
// 每 tick 两个进程；合并后同一个 tell 块内先定位 frontProc，再直接取它的 windows，
// 免去按名字二次查找的开销，也天然保证 bounds 一定属于同一个进程。
// bounds 计算整体包一层 try：算不出时返回 "ERR"，绝不能因此丢掉 procName。
export async function getFrontmostApp(): Promise<FrontmostAppInfo | null> {
  try {
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
    addDetectedApp(processName)
    if (BROWSER_APPS.has(processName)) {
      // 总开关暂停时浏览器也不得进入 window-tracker，避免插件提示等跟随副作用。
      if (!isAppFollowingEnabled()) return null
      // 浏览器不跟随贴靠，bounds 用不上——JS 侧直接丢弃（排除清单本身仍只活在这里，不进 AppleScript）
      return { processName, appName: processName, isBrowser: true, bounds: null } as FrontmostAppInfo
    }
    // 即使全局暂停也保留检测记录；恢复后用户仍可沿用逐应用设置。
    if (!shouldFollowDetectedApp(processName)) {
      return null
    }
    // 仅在应用切换时输出日志
    if (processName !== lastLoggedApp) {
      console.log(`[AppDetector] 前台切换: ${processName}`)
      lastLoggedApp = processName
    }
    return { processName, appName: processName, bounds: parseBoundsPart(boundsPart) }
  } catch (err: any) {
    console.error(`[AppDetector] 错误:`, err.message?.substring(0, 100))
    return null
  }
}

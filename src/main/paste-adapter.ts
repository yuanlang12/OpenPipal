/**
 * Paste Adapter — 把内容写入当前挂靠的前台应用
 *
 * 抽取自 ipc-handlers.ts 的 `paste-to-target` 逻辑，通用化作为：
 *   - 手动按钮（PasteButton）的后端
 *   - `present_to_user` pi-tool 的后端（Phase 6d）
 *
 * 机制（text）：
 *   1. markdown → HTML（marked）
 *   2. Electron clipboard.write({ text, html })——多格式剪贴板，receiving app 自动选最佳
 *   3. AppleScript 聚焦前台应用 + 模拟 Cmd+V
 *
 * 支持任何非 OpenPipal 应用——ClassIn 黑板 / Keynote / 文档 / 聊天输入框均通用
 */
import { clipboard } from 'electron'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { marked } from 'marked'
import { getCurrentProcessName, getTrackedWindow } from './window-tracker'
import { pasteIntoWindowWin32 } from './win32-foreground'

const execFileAsync = promisify(execFile)

export interface PasteResult {
  success: boolean
  targetApp?: string
  error?: string
}

/**
 * 把 markdown/文本内容粘贴到当前挂靠的前台应用
 */
export async function pasteTextToActiveApp(text: string): Promise<PasteResult> {
  if (!text || !text.trim()) {
    return { success: false, error: '内容为空' }
  }

  const processName = getCurrentProcessName()
  if (!processName) {
    return { success: false, error: '未检测到挂靠的目标应用' }
  }
  if (process.platform === 'win32') {
    // Windows：同一个 PowerShell 探针把目标窗口提到前台再按 Ctrl+V（见 win32-foreground.ts 的 Do-Paste）
    const tracked = getTrackedWindow()
    if (!tracked) {
      return { success: false, error: '未检测到挂靠的目标窗口' }
    }
    try {
      const html = await marked(text)
      clipboard.write({ text, html })
      const result = await pasteIntoWindowWin32(tracked.handle, tracked.pid)
      return result.ok
        ? { success: true, targetApp: processName }
        : { success: false, error: result.error || '粘贴失败' }
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) }
    }
  }
  if (process.platform !== 'darwin') {
    return { success: false, error: '当前平台暂不支持粘贴到前台应用' }
  }

  try {
    // 同时写 text + html —— receiving app 根据自身支持选格式
    // ClassIn 聊天框吃 html（带格式），Keynote 文本框吃纯 text
    const html = await marked(text)
    clipboard.write({ text, html })

    // AppleScript 触发 Cmd+V
    //   - set frontmost：把目标窗口提到最前（焦点必须先落到它身上）
    //   - delay 0.15：给系统 focus 切换留足时间，过短会 keystroke 丢到 OpenPipal 自己
    await execFileAsync('osascript', [
      '-e',
      `
tell application "System Events"
  if exists process "${processName}" then
    set frontmost of process "${processName}" to true
    delay 0.15
    keystroke "v" using command down
  end if
end tell
`
    ])

    return { success: true, targetApp: processName }
  } catch (err: any) {
    return { success: false, error: err.message }
  }
}

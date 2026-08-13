import { execFile } from 'child_process'
import { promisify } from 'util'

const execFileAsync = promisify(execFile)

export interface AppContext {
  appName: string
  windowTitle: string
  selectedText: string
}

// 先找出目标应用（排除 Electron/OpenPipal），然后读取它的 accessibility 数据
// 全部在一个 JXA 调用中完成，避免多次 osascript 调用
const JXA_SCRIPT = `
(function() {
  var ignore = ["Electron", "OpenPipal", "Finder", "SystemUIServer", "Dock", "Spotlight", "Control Center", "WindowServer"];
  var se = Application("System Events");
  var allProcs = se.applicationProcesses.whose({visible: true});
  var targetName = "";

  // 策略1: 找最近激活的非 OpenPipal 应用（通过 window 顺序）
  try {
    var frontProc = se.applicationProcesses.whose({frontmost: true})[0];
    var fn = frontProc.name();
    if (ignore.indexOf(fn) === -1) {
      targetName = fn;
    }
  } catch(e) {}

  // 策略2: 如果 frontmost 是 Electron，找所有可见进程中有窗口的
  if (!targetName) {
    try {
      for (var i = 0; i < allProcs.length; i++) {
        try {
          var pn = allProcs[i].name();
          if (ignore.indexOf(pn) !== -1) continue;
          var wins = allProcs[i].windows();
          if (wins.length > 0) {
            targetName = pn;
            break;
          }
        } catch(e) {}
      }
    } catch(e) {}
  }

  if (!targetName) return JSON.stringify({app:"",window:"",role:"",selected:"",value:""});

  var res = {app: targetName, window: "", role: "", selected: "", value: ""};
  try {
    var p = se.processes[targetName];
    try { res.window = p.windows[0].title(); } catch(e) {}
    try {
      var fe = p.focusedUIElement;
      res.role = fe.role();
    } catch(e) {}
    try {
      var fe = p.focusedUIElement;
      var sel = fe.selectedText();
      if (sel) res.selected = sel.toString().substring(0, 1000);
    } catch(e) {}
    if (!res.selected) {
      try {
        var fe = p.focusedUIElement;
        var v = fe.value();
        if (v) res.value = v.toString().substring(0, 500);
      } catch(e) {}
    }
  } catch(e) {}
  return JSON.stringify(res);
})()
`

export async function getActiveContext(): Promise<AppContext | null> {
  try {
    console.log('[AX] 开始读取...')
    const { stdout } = await execFileAsync('osascript', ['-l', 'JavaScript', '-e', JXA_SCRIPT], {
      timeout: 4000
    })
    const raw = stdout.trim()
    console.log('[AX] 原始输出:', raw.substring(0, 200))
    const parsed = JSON.parse(raw)

    return {
      appName: parsed.app || '',
      windowTitle: parsed.window || '',
      selectedText: parsed.selected || parsed.value || ''
    }
  } catch (err: any) {
    console.error('[AX] 失败:', err.message?.substring(0, 150))
    return null
  }
}

export function formatContext(ctx: AppContext): string {
  const parts: string[] = []
  if (ctx.appName) parts.push(`应用: ${ctx.appName}`)
  if (ctx.windowTitle) parts.push(`窗口: ${ctx.windowTitle}`)
  if (ctx.selectedText) parts.push(`选中文本: ${ctx.selectedText}`)
  return parts.join('\n')
}

/**
 * Windows 前台窗口探针（第 3 段）。macOS 上没有 PowerShell 也没有 Win32，所以这里钉的是能在
 * 这台机器上验证的全部：脚本文本的几条硬约束、回复解析、窗口分类、DPI 换算，以及"一行进一行出"
 * 协议客户端——后者用一个 node 假探针顶替 PowerShell，验证串行排队、超时重起、致命退出停用。
 * 真正的 Win32 行为等虚拟机。
 */
import { afterEach, describe, expect, it } from 'vitest'
import {
  BROWSER_WIN32_PROCESSES,
  LineProtocolHelper,
  WIN32_FOREGROUND_SCRIPT,
  classifyWin32Window,
  encodePowerShellCommand,
  parseForegroundReply,
  win32WindowToAppBounds,
  type Win32ForegroundSnapshot
} from '../../src/main/win32-foreground'

function snapshot(overrides: Partial<Win32ForegroundSnapshot> = {}): Win32ForegroundSnapshot {
  return {
    hwnd: '132530',
    pid: 4242,
    processName: 'WINWORD',
    exePath: 'C:\\Program Files\\Microsoft Office\\root\\Office16\\WINWORD.EXE',
    description: 'Microsoft Word',
    title: '报告.docx - Word',
    className: 'OpusApp',
    uwpHost: false,
    left: 100,
    top: 80,
    right: 1700,
    bottom: 1000,
    minimized: false,
    maximized: false,
    ...overrides
  }
}

describe('探针脚本文本', () => {
  it('编译一段 P/Invoke、设 UTF-8、按行读 stdin、Add-Type 失败以 2 退出', () => {
    expect(WIN32_FOREGROUND_SCRIPT).toContain('Add-Type -TypeDefinition $src')
    expect(WIN32_FOREGROUND_SCRIPT).toContain('[Console]::OutputEncoding = [System.Text.Encoding]::UTF8')
    expect(WIN32_FOREGROUND_SCRIPT).toContain('[Console]::In.ReadLine()')
    expect(WIN32_FOREGROUND_SCRIPT).toMatch(/"fatal":true.*\n\s*\$Out\.Flush\(\)\n\s*exit 2/)
    expect(WIN32_FOREGROUND_SCRIPT).toContain('DwmGetWindowAttribute(h, 9')
  })

  it('不给 PowerShell 的自动变量 $pid 赋值（那是当前进程 id，赋值会静默失效）', () => {
    expect(WIN32_FOREGROUND_SCRIPT).not.toMatch(/\$pid\s*=/)
  })

  it('-EncodedCommand 用 UTF-16LE base64，且长度在命令行上限之内', () => {
    const encoded = encodePowerShellCommand('Write-Output hi')
    expect(Buffer.from(encoded, 'base64').toString('utf16le')).toBe('Write-Output hi')
    expect(encodePowerShellCommand(WIN32_FOREGROUND_SCRIPT).length).toBeLessThan(30000)
  })
})

describe('parseForegroundReply', () => {
  it('把探针的 JSON 变成快照，缺省字段给安全默认值', () => {
    const parsed = parseForegroundReply(JSON.stringify({
      ok: true,
      window: { hwnd: '99', pid: 7, processName: 'Code', title: 'x', left: 0, top: 0, right: 800, bottom: 600 }
    }))
    expect(parsed).toMatchObject({ hwnd: '99', pid: 7, processName: 'Code', exePath: null, description: null, minimized: false })
  })

  it.each([
    ['坏 JSON', 'not json'],
    ['ok=false', '{"ok":false,"error":"x"}'],
    ['没有前台窗口', '{"ok":true,"window":null}'],
    ['缺矩形', '{"ok":true,"window":{"hwnd":"1","left":0}}'],
    ['hwnd 不是字符串', '{"ok":true,"window":{"hwnd":1,"left":0,"top":0,"right":1,"bottom":1}}']
  ])('%s → null', (_name, line) => {
    expect(parseForegroundReply(line)).toBeNull()
  })

  it('空白的 description 视为没有', () => {
    const parsed = parseForegroundReply(JSON.stringify({
      ok: true,
      window: { hwnd: '1', pid: 1, processName: 'x', description: '   ', left: 0, top: 0, right: 1, bottom: 1 }
    }))
    expect(parsed?.description).toBeNull()
  })
})

describe('classifyWin32Window', () => {
  it('OpenPipal 自己的窗口（同 pid）→ self', () => {
    expect(classifyWin32Window(snapshot({ pid: 1000, processName: 'OpenPipal' }), 1000).kind).toBe('self')
    expect(classifyWin32Window(snapshot({ pid: 1000, processName: 'Code' }), 1000).kind).toBe('self')
  })

  it('系统壳：搜索、开始菜单、锁屏、输入法、没解析出应用的 UWP 外壳 → shell', () => {
    for (const name of ['SearchHost', 'StartMenuExperienceHost', 'LockApp', 'TextInputHost', 'ApplicationFrameHost']) {
      expect(classifyWin32Window(snapshot({ processName: name }), 1).kind).toBe('shell')
    }
    expect(classifyWin32Window(snapshot({ processName: '' }), 1).kind).toBe('shell')
  })

  it('explorer 按窗口类分：桌面 / 任务栏是壳，文件资源管理器是应用', () => {
    expect(classifyWin32Window(snapshot({ processName: 'explorer', className: 'Progman' }), 1).kind).toBe('shell')
    expect(classifyWin32Window(snapshot({ processName: 'explorer', className: 'Shell_TrayWnd' }), 1).kind).toBe('shell')
    const files = classifyWin32Window(snapshot({ processName: 'explorer', className: 'CabinetWClass', description: 'Windows Explorer' }), 1)
    expect(files.kind).toBe('app')
    expect(files.appName).toBe('Windows Explorer')
  })

  it('浏览器 exe → browser，显示名取版本信息', () => {
    const chrome = classifyWin32Window(snapshot({ processName: 'chrome', description: 'Google Chrome' }), 1)
    expect(chrome).toEqual({ kind: 'browser', processName: 'chrome', appName: 'Google Chrome' })
    expect(classifyWin32Window(snapshot({ processName: 'msedge', description: null }), 1).appName).toBe('msedge')
    expect(BROWSER_WIN32_PROCESSES.has('firefox')).toBe(true)
  })

  it('普通应用：processName 是 exe 主文件名（经别名表），appName 是版本信息里的描述', () => {
    const word = classifyWin32Window(snapshot(), 1)
    expect(word).toEqual({ kind: 'app', processName: 'WINWORD', appName: 'Microsoft Word' })
    const wps = classifyWin32Window(snapshot({ processName: 'wps', description: 'WPS 文字' }), 1, (exe) => (exe === 'wps' ? 'wpsoffice' : exe))
    expect(wps).toEqual({ kind: 'app', processName: 'wpsoffice', appName: 'WPS 文字' })
  })
})

describe('win32WindowToAppBounds', () => {
  const dipHalf = (r: { x: number; y: number; width: number; height: number }) => ({
    x: r.x / 2, y: r.y / 2, width: r.width / 2, height: r.height / 2
  })
  const display = () => ({ x: 0, y: 0, width: 1920, height: 1080 })

  it('物理像素经注入的换算变成 DIP，右/下边换成宽/高', () => {
    expect(win32WindowToAppBounds(snapshot(), dipHalf, display)).toEqual({
      x: 50, y: 40, width: 800, height: 460, isFullscreen: false
    })
  })

  it('最小化或过小的窗口不算（与 macOS 跳过 <100px 小弹窗一致）', () => {
    expect(win32WindowToAppBounds(snapshot({ minimized: true }), dipHalf, display)).toBeNull()
    expect(win32WindowToAppBounds(snapshot({ left: 0, top: 0, right: 80, bottom: 600 }), dipHalf, display)).toBeNull()
  })

  it('盖满整个显示器（差 2px 以内）算全屏', () => {
    const covering = snapshot({ left: 0, top: 0, right: 3840, bottom: 2160 })
    expect(win32WindowToAppBounds(covering, dipHalf, display)?.isFullscreen).toBe(true)
    const almost = snapshot({ left: 0, top: 0, right: 3840, bottom: 2100 })
    expect(win32WindowToAppBounds(almost, dipHalf, display)?.isFullscreen).toBe(false)
  })
})

/** 用 node 顶替 PowerShell 的假探针：同一套"一行命令 / 一行 JSON"协议 */
const FAKE_PROBE = String.raw`
const rl = require('readline').createInterface({ input: process.stdin })
const fg = process.argv[1] || '{"ok":true,"window":null}'
rl.on('line', (raw) => {
  const line = raw.trim()
  if (line === 'quit') process.exit(0)
  if (line === 'fg') return void process.stdout.write(fg + '\n')
  if (line === 'ping') return void process.stdout.write('{"ok":true}\n')
  if (line.startsWith('echo ')) return void process.stdout.write(JSON.stringify({ echo: line.slice(5) }) + '\n')
  if (line === 'slow') return
  if (line === 'die') process.exit(1)
  process.stdout.write('{"ok":false,"error":"unknown command"}\n')
})
`
const FATAL_PROBE = String.raw`process.stdout.write('{"ok":false,"fatal":true,"error":"Add-Type failed"}\n'); process.exit(2)`

describe('LineProtocolHelper（用 node 假探针验协议）', () => {
  const helpers: LineProtocolHelper[] = []
  function makeHelper(script: string, options: Partial<{ requestTimeoutMs: number; maxConsecutiveFailures: number }> = {}, fgJson?: string) {
    const helper = new LineProtocolHelper(
      async () => ({ executable: process.execPath, args: ['-e', script, ...(fgJson ? [fgJson] : [])] }),
      { requestTimeoutMs: options.requestTimeoutMs ?? 2000, maxConsecutiveFailures: options.maxConsecutiveFailures ?? 3 }
    )
    helpers.push(helper)
    return helper
  }
  afterEach(() => {
    while (helpers.length) helpers.pop()!.dispose()
  })

  it('请求按序答复，并发发出的几条各拿到自己的回复', async () => {
    const helper = makeHelper(FAKE_PROBE)
    expect(await helper.request('ping')).toBe('{"ok":true}')
    const replies = await Promise.all([helper.request('echo a'), helper.request('echo b'), helper.request('echo c')])
    expect(replies).toEqual(['{"echo":"a"}', '{"echo":"b"}', '{"echo":"c"}'])
  })

  it('fg 的回复经 parseForegroundReply 变成快照', async () => {
    const fg = JSON.stringify({ ok: true, window: { hwnd: '7', pid: 3, processName: 'notepad', title: 'x', left: 0, top: 0, right: 640, bottom: 480 } })
    const helper = makeHelper(FAKE_PROBE, {}, fg)
    const reply = await helper.request('fg')
    expect(parseForegroundReply(reply!)).toMatchObject({ hwnd: '7', processName: 'notepad' })
  })

  it('超时判 null 并重起探针；探针中途退出时排队的请求也判 null，下一次自动重起', async () => {
    const helper = makeHelper(FAKE_PROBE, { requestTimeoutMs: 300, maxConsecutiveFailures: 5 })
    expect(await helper.request('slow')).toBeNull()
    expect(await helper.request('ping')).toBe('{"ok":true}')
    expect(await helper.request('die')).toBeNull()
    expect(await helper.request('ping')).toBe('{"ok":true}')
    expect(helper.isDisabled).toBe(false)
  })

  it('连续失败到上限就停用，之后的请求立刻返回 null', async () => {
    const helper = makeHelper(FAKE_PROBE, { requestTimeoutMs: 200, maxConsecutiveFailures: 2 })
    expect(await helper.request('slow')).toBeNull()
    expect(await helper.request('slow')).toBeNull()
    expect(helper.isDisabled).toBe(true)
    expect(await helper.request('ping')).toBeNull()
  })

  it('探针以 2 退出（Add-Type 编不过）→ 永久停用，不再重试', async () => {
    const helper = makeHelper(FATAL_PROBE)
    expect(await helper.request('fg')).toBeNull()
    expect(helper.isDisabled).toBe(true)
  })

  it('找不到 PowerShell → 直接停用', async () => {
    const helper = new LineProtocolHelper(async () => null, { requestTimeoutMs: 500, maxConsecutiveFailures: 3 })
    helpers.push(helper)
    expect(await helper.request('ping')).toBeNull()
    expect(helper.isDisabled).toBe(true)
  })
})

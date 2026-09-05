/**
 * Windows 前台窗口数据源（对应 macOS 的 osascript / System Events）。
 *
 * 为什么是一个长驻的 PowerShell 进程而不是 FFI：我们在 Mac 上给 x64 与 arm64 两种 Windows 打包，
 * 任何原生模块（koffi 3 装机时才下载当前平台的预编译、get-windows 的 Windows 绑定要现场编译）
 * 在这条打包链上都拿不到 Windows 二进制；PowerShell 每台 Windows 都有，x64/arm64 一视同仁。
 * 与 macOS 那边"每秒起一个 osascript"不同，这里只起一次：脚本里 Add-Type 编译一段 P/Invoke
 * 要一两秒，之后每次查询是进程内一次 Win32 调用，走 stdin 一行命令 / stdout 一行 JSON。
 *
 * 纯函数（脚本文本、回复解析、窗口分类、坐标换算）都单独导出，好在 macOS 上写单测；
 * 真正碰 Electron 的 DPI 换算留给调用方注入。
 */
import type { ChildProcess } from 'child_process'

/** 探针一次回报的原始窗口信息（坐标是物理像素，未做 DPI 换算） */
export interface Win32ForegroundSnapshot {
  /** HWND 的十进制字符串（Electron desktopCapturer 的 window source id 形如 `window:<hwnd>:0`） */
  hwnd: string
  pid: number
  /** exe 主文件名，不带 .exe（Get-Process 的 ProcessName） */
  processName: string
  exePath: string | null
  /** exe 版本信息里的 FileDescription（"Microsoft Word"、"Visual Studio Code"），拿不到为 null */
  description: string | null
  title: string
  className: string
  /** 前台是 UWP 的 ApplicationFrameHost 时，pid/processName 是否已换成里面真正的应用 */
  uwpHost: boolean
  left: number
  top: number
  right: number
  bottom: number
  minimized: boolean
  maximized: boolean
}

/**
 * 探针脚本。一行命令进、一行 JSON 出：
 *   fg                     → {"ok":true,"window":{...}} / {"ok":true,"window":null}
 *   paste <hwnd> <pid>     → {"ok":true} / {"ok":false,"error":"..."}
 *   ping                   → {"ok":true}
 *   quit                   → 退出
 * Add-Type 编不过（受限语言模式等）时打一条 fatal 并以 2 退出，Node 侧据此不再重试。
 * 注意 `$pid` 是 PowerShell 的自动变量（当前进程 id），脚本里一律用 $procId。
 */
export const WIN32_FOREGROUND_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
[Console]::InputEncoding = [System.Text.Encoding]::UTF8
$Out = [Console]::Out

$src = @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class OpFg {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr hWnd, StringBuilder text, int max);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassNameW(IntPtr hWnd, StringBuilder text, int max);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsZoomed(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr FindWindowExW(IntPtr parent, IntPtr after, string cls, string title);
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
  [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr hWnd, int attr, out RECT rect, int size);
  public static string Text(IntPtr h) { var sb = new StringBuilder(512); GetWindowTextW(h, sb, sb.Capacity); return sb.ToString(); }
  public static string Cls(IntPtr h) { var sb = new StringBuilder(256); GetClassNameW(h, sb, sb.Capacity); return sb.ToString(); }
  public static long Pid(IntPtr h) { uint p; GetWindowThreadProcessId(h, out p); return p; }
  // DWMWA_EXTENDED_FRAME_BOUNDS(9)：可见边框，不含 Win10+ 那圈看不见的调整边；拿不到再退回 GetWindowRect
  public static int[] Rect(IntPtr h) { RECT r; if (DwmGetWindowAttribute(h, 9, out r, Marshal.SizeOf(typeof(RECT))) != 0) { GetWindowRect(h, out r); } return new int[] { r.Left, r.Top, r.Right, r.Bottom }; }
  // 先敲一下 Alt 再 SetForegroundWindow：Windows 只允许"刚有输入"的进程抢前台，这是通行的解法
  public static void Activate(IntPtr h) { keybd_event(0x12, 0, 0, UIntPtr.Zero); keybd_event(0x12, 0, 2, UIntPtr.Zero); SetForegroundWindow(h); }
}
'@

try {
  Add-Type -TypeDefinition $src -Language CSharp
} catch {
  $Out.WriteLine('{"ok":false,"fatal":true,"error":' + (ConvertTo-Json ([string]$_.Exception.Message) -Compress) + '}')
  $Out.Flush()
  exit 2
}
$sendKeysReady = $false
try { Add-Type -AssemblyName System.Windows.Forms; $sendKeysReady = $true } catch { }

$procCache = @{}
function Get-ProcInfo([int64]$procId) {
  if ($procCache.Count -gt 200) { $procCache.Clear() }
  if ($procCache.ContainsKey($procId)) { return $procCache[$procId] }
  $name = ''; $path = $null; $desc = $null
  try {
    $p = Get-Process -Id $procId -ErrorAction Stop
    $name = $p.ProcessName
    try { $path = $p.Path } catch { }
    if ($path) { try { $desc = [System.Diagnostics.FileVersionInfo]::GetVersionInfo($path).FileDescription } catch { } }
  } catch { }
  $info = @{ name = $name; path = $path; desc = $desc }
  $procCache[$procId] = $info
  return $info
}

function Get-Fg {
  $h = [OpFg]::GetForegroundWindow()
  if ($h -eq [IntPtr]::Zero) { return '{"ok":true,"window":null}' }
  $cls = [OpFg]::Cls($h)
  $procId = [OpFg]::Pid($h)
  $uwp = $false
  if ($cls -eq 'ApplicationFrameWindow') {
    $core = [OpFg]::FindWindowExW($h, [IntPtr]::Zero, 'Windows.UI.Core.CoreWindow', $null)
    if ($core -ne [IntPtr]::Zero) { $procId = [OpFg]::Pid($core); $uwp = $true }
  }
  $pi = Get-ProcInfo $procId
  $r = [OpFg]::Rect($h)
  $win = [ordered]@{
    hwnd = $h.ToInt64().ToString()
    pid = $procId
    processName = $pi.name
    exePath = $pi.path
    description = $pi.desc
    title = [OpFg]::Text($h)
    className = $cls
    uwpHost = $uwp
    left = $r[0]; top = $r[1]; right = $r[2]; bottom = $r[3]
    minimized = [bool][OpFg]::IsIconic($h)
    maximized = [bool][OpFg]::IsZoomed($h)
  }
  return (ConvertTo-Json ([ordered]@{ ok = $true; window = $win }) -Compress -Depth 3)
}

function Do-Paste([string]$hwndText, [int64]$targetPid) {
  if (-not $sendKeysReady) { return '{"ok":false,"error":"System.Windows.Forms unavailable"}' }
  $h = [IntPtr][int64]$hwndText
  [OpFg]::Activate($h)
  Start-Sleep -Milliseconds 120
  if ([OpFg]::GetForegroundWindow() -ne $h -and $targetPid -gt 0) {
    try { $sh = New-Object -ComObject WScript.Shell; [void]$sh.AppActivate([int]$targetPid); Start-Sleep -Milliseconds 120 } catch { }
  }
  if ([OpFg]::Pid([OpFg]::GetForegroundWindow()) -ne $targetPid) {
    return '{"ok":false,"error":"target window did not come to the foreground"}'
  }
  [System.Windows.Forms.SendKeys]::SendWait('^v')
  return '{"ok":true}'
}

while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  $line = $line.Trim()
  if ($line.Length -eq 0) { continue }
  if ($line -eq 'quit') { break }
  $reply = '{"ok":false,"error":"unknown command"}'
  try {
    if ($line -eq 'fg') { $reply = Get-Fg }
    elseif ($line -eq 'ping') { $reply = '{"ok":true}' }
    elseif ($line.StartsWith('paste ')) { $parts = $line.Split(' '); $reply = Do-Paste $parts[1] ([int64]$parts[2]) }
  } catch {
    $reply = '{"ok":false,"error":' + (ConvertTo-Json ([string]$_.Exception.Message) -Compress) + '}'
  }
  $Out.WriteLine($reply)
  $Out.Flush()
}
`.trim()

/** PowerShell 的 -EncodedCommand 要 UTF-16LE 的 base64 */
export function encodePowerShellCommand(script: string): string {
  return Buffer.from(script, 'utf16le').toString('base64')
}

export interface LineHelperLaunch {
  executable: string
  args: string[]
}

export interface LineHelperOptions {
  /** 单次请求的等待上限；超时视为探针卡死，杀掉重起 */
  requestTimeoutMs: number
  /** 连续起不来 / 连续超时几次后停手，别每秒都去拉一个起不来的进程 */
  maxConsecutiveFailures: number
  log?: (message: string) => void
}

/**
 * "一行进一行出"的长驻子进程客户端。请求串行排队（探针按序答复），超时或进程退出就把
 * 排队的请求都判成 null 并重起；探针以 2 退出（fatal）就永久停用。
 * 用 spawn 工厂注入是为了在 macOS 上拿一个 node 假探针测协议。
 */
export class LineProtocolHelper {
  private child: ChildProcess | null = null
  private starting: Promise<ChildProcess | null> | null = null
  private pending: Array<{ resolve: (line: string | null) => void; timer: ReturnType<typeof setTimeout> }> = []
  private disabled = false
  private consecutiveFailures = 0
  private stderrTail = ''

  constructor(
    private readonly launch: () => Promise<LineHelperLaunch | null>,
    private readonly options: LineHelperOptions
  ) {}

  get isDisabled(): boolean {
    return this.disabled
  }

  async request(line: string): Promise<string | null> {
    if (this.disabled) return null
    const child = await this.ensureStarted()
    if (!child || !child.stdin || child.stdin.destroyed) return null
    return new Promise<string | null>((resolve) => {
      const timer = setTimeout(() => {
        this.options.log?.(`[Win32Probe] 请求超时（${this.options.requestTimeoutMs}ms），重起探针`)
        this.failAll(true)
      }, this.options.requestTimeoutMs)
      this.pending.push({ resolve, timer })
      child.stdin!.write(`${line}\n`, (error) => {
        if (error) {
          this.options.log?.(`[Win32Probe] 写入失败: ${error.message}`)
          this.failAll(true)
        }
      })
    })
  }

  dispose(): void {
    const child = this.child
    this.child = null
    this.failAll(false)
    if (child) {
      try { child.stdin?.write('quit\n') } catch { /* 已经退出 */ }
      try { child.stdin?.end() } catch { /* 已经退出 */ }
      setTimeout(() => { try { child.kill() } catch { /* 已经退出 */ } }, 500).unref()
    }
  }

  private async ensureStarted(): Promise<ChildProcess | null> {
    if (this.child) return this.child
    if (!this.starting) {
      this.starting = this.start().finally(() => { this.starting = null })
    }
    return this.starting
  }

  private async start(): Promise<ChildProcess | null> {
    const launch = await this.launch()
    if (!launch) {
      this.disabled = true
      this.options.log?.('[Win32Probe] 找不到 PowerShell，应用跟随不可用')
      return null
    }
    const { spawn } = await import('child_process')
    const { createInterface } = await import('readline')
    let child: ChildProcess
    try {
      child = spawn(launch.executable, launch.args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    } catch (error) {
      this.noteFailure(`spawn 失败: ${(error as Error).message}`)
      return null
    }
    this.child = child
    this.stderrTail = ''
    createInterface({ input: child.stdout! }).on('line', (line) => this.onLine(line))
    // 探针刚退出我们还在往 stdin 写会得到 EPIPE；不接这个事件它就是一个未处理异常
    child.stdin?.on('error', (error) => {
      this.options.log?.(`[Win32Probe] stdin 出错: ${error.message}`)
      this.failAll(false)
    })
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (chunk: string) => {
      this.stderrTail = (this.stderrTail + chunk).slice(-2000)
    })
    child.once('error', (error) => {
      if (this.child !== child) return
      this.child = null
      this.noteFailure(`探针进程出错: ${error.message}`)
      this.failAll(false)
    })
    child.once('exit', (code) => {
      if (this.child !== child) return
      this.child = null
      if (code === 2) {
        // 脚本自己判定的致命错误（Add-Type 编不过）：重试也是同一结果
        this.disabled = true
        this.options.log?.(`[Win32Probe] 探针无法初始化，应用跟随不可用${this.stderrTail ? `: ${this.stderrTail.trim()}` : ''}`)
      } else if (this.pending.length > 0) {
        this.noteFailure(`探针退出（code=${code}）`)
      }
      this.failAll(false)
    })
    return child
  }

  private onLine(line: string): void {
    // 脚本初始化失败的那一行不是对任何请求的答复：记下原因、停用，排队的请求由随后的 exit 判 null
    if (line.includes('"fatal":true')) {
      this.disabled = true
      this.options.log?.(`[Win32Probe] 探针无法初始化，应用跟随不可用: ${line}`)
      return
    }
    const head = this.pending.shift()
    if (!head) return
    clearTimeout(head.timer)
    this.consecutiveFailures = 0
    head.resolve(line)
  }

  private noteFailure(message: string): void {
    this.consecutiveFailures += 1
    this.options.log?.(`[Win32Probe] ${message}（第 ${this.consecutiveFailures} 次）`)
    if (this.consecutiveFailures >= this.options.maxConsecutiveFailures) {
      this.disabled = true
      this.options.log?.('[Win32Probe] 连续失败，停止重试；重新打开应用跟随可再试')
    }
  }

  /** 把排队中的请求都判 null；kill=true 时同时杀掉当前子进程（超时 / 写入失败） */
  private failAll(kill: boolean): void {
    const pending = this.pending
    this.pending = []
    for (const item of pending) {
      clearTimeout(item.timer)
      item.resolve(null)
    }
    if (kill && this.child) {
      const child = this.child
      this.child = null
      this.noteFailure('探针无响应，已终止')
      try { child.kill() } catch { /* 已经退出 */ }
    }
  }
}

/** 解析探针对 `fg` 的答复；形状不对一律当"没有前台窗口" */
export function parseForegroundReply(line: string): Win32ForegroundSnapshot | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object') return null
  const reply = parsed as { ok?: unknown; window?: unknown }
  if (reply.ok !== true || !reply.window || typeof reply.window !== 'object') return null
  const w = reply.window as Record<string, unknown>
  const num = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : NaN)
  const rect = [num(w.left), num(w.top), num(w.right), num(w.bottom)]
  if (typeof w.hwnd !== 'string' || !w.hwnd || rect.some(Number.isNaN)) return null
  return {
    hwnd: w.hwnd,
    pid: Number.isFinite(num(w.pid)) ? num(w.pid) : 0,
    processName: typeof w.processName === 'string' ? w.processName : '',
    exePath: typeof w.exePath === 'string' && w.exePath ? w.exePath : null,
    description: typeof w.description === 'string' && w.description.trim() ? w.description.trim() : null,
    title: typeof w.title === 'string' ? w.title : '',
    className: typeof w.className === 'string' ? w.className : '',
    uwpHost: w.uwpHost === true,
    left: rect[0],
    top: rect[1],
    right: rect[2],
    bottom: rect[3],
    minimized: w.minimized === true,
    maximized: w.maximized === true
  }
}

/**
 * 系统壳与输入法这类不该当"用户正在用的应用"的进程（exe 主文件名，小写）。
 * explorer 单独处理：桌面 / 任务栏 / 开始按钮是它的窗口，但文件资源管理器也是它——按窗口类分。
 */
const IGNORED_WIN32_PROCESSES = new Set([
  'searchhost', 'searchapp', 'searchui',
  'startmenuexperiencehost', 'shellexperiencehost',
  'lockapp', 'logonui',
  'textinputhost', 'ctfmon',
  'securityhealthsystray', 'screenclippinghost',
  'widgets', 'systemsettings',
  'applicationframehost'   // UWP 外壳：没能解析出里面的应用时不算
])
const EXPLORER_SHELL_CLASSES = new Set(['progman', 'workerw', 'shell_traywnd', 'shell_secondarytraywnd', 'button'])

/** 浏览器 exe（小写，不带 .exe）——检测到时不跟随，改提示装插件（与 macOS 的 BROWSER_APPS 同义） */
export const BROWSER_WIN32_PROCESSES = new Set([
  'chrome', 'msedge', 'firefox', 'brave', 'opera', 'opera_gx', 'arc', 'chromium', 'vivaldi', 'iexplore'
])

export type Win32WindowKind = 'self' | 'shell' | 'browser' | 'app'

export interface Win32WindowClassification {
  kind: Win32WindowKind
  /** 设置项与 getTargetConfig 用的稳定键：exe 主文件名（可能经别名表换成内置 target 的键） */
  processName: string
  /** 给人看的名字：版本信息里的 FileDescription，没有就用 exe 主文件名 */
  appName: string
}

/**
 * 前台窗口是谁的：OpenPipal 自己 / 系统壳 / 浏览器 / 普通应用。
 * `resolveKey` 由调用方注入别名表（wps.exe → wpsoffice 这类内置 target 的键）。
 */
export function classifyWin32Window(
  snapshot: Win32ForegroundSnapshot,
  ownPid: number,
  resolveKey: (exeBaseName: string) => string = (name) => name
): Win32WindowClassification {
  const exe = snapshot.processName.trim()
  const lower = exe.toLowerCase()
  const appName = snapshot.description || exe
  if (snapshot.pid === ownPid || lower === 'openpipal' || lower === 'electron') {
    return { kind: 'self', processName: exe, appName }
  }
  if (!exe || IGNORED_WIN32_PROCESSES.has(lower)) {
    return { kind: 'shell', processName: exe, appName }
  }
  if (lower === 'explorer' && EXPLORER_SHELL_CLASSES.has(snapshot.className.toLowerCase())) {
    return { kind: 'shell', processName: exe, appName }
  }
  if (BROWSER_WIN32_PROCESSES.has(lower)) {
    return { kind: 'browser', processName: exe, appName }
  }
  return { kind: 'app', processName: resolveKey(exe), appName }
}

export interface Rectangle { x: number; y: number; width: number; height: number }

/**
 * 物理像素的窗口矩形 → 跟随逻辑要的 bounds（DIP）+ 是否盖满整个显示器。
 * `toDip` 与 `displayBoundsFor` 由调用方注入（Electron 的 screen.screenToDipRect / getDisplayMatching），
 * 这样纯函数部分能在 macOS 上测。最小化或过小（<100px，和 macOS 那边跳过小弹窗的阈值一致）返回 null。
 */
export function win32WindowToAppBounds(
  snapshot: Win32ForegroundSnapshot,
  toDip: (physical: Rectangle) => Rectangle,
  displayBoundsFor: (dip: Rectangle) => Rectangle
): { x: number; y: number; width: number; height: number; isFullscreen: boolean } | null {
  if (snapshot.minimized) return null
  const physical: Rectangle = {
    x: snapshot.left,
    y: snapshot.top,
    width: snapshot.right - snapshot.left,
    height: snapshot.bottom - snapshot.top
  }
  if (physical.width < 100 || physical.height < 100) return null
  const dip = toDip(physical)
  const display = displayBoundsFor(dip)
  const slop = 2
  const isFullscreen =
    Math.abs(dip.x - display.x) <= slop &&
    Math.abs(dip.y - display.y) <= slop &&
    Math.abs(dip.width - display.width) <= slop &&
    Math.abs(dip.height - display.height) <= slop
  return { x: dip.x, y: dip.y, width: dip.width, height: dip.height, isFullscreen }
}

// ---- 进程级单例：一个探针服务整个应用 ----

let helper: LineProtocolHelper | null = null

function getHelper(): LineProtocolHelper {
  if (!helper) {
    helper = new LineProtocolHelper(
      async () => {
        const { findPowerShellExecutable } = await import('./openpipal-execution-env')
        const executable = await findPowerShellExecutable(process.env)
        if (!executable) return null
        return {
          executable,
          args: ['-NoProfile', '-NonInteractive', '-NoLogo', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encodePowerShellCommand(WIN32_FOREGROUND_SCRIPT)]
        }
      },
      { requestTimeoutMs: 4000, maxConsecutiveFailures: 3, log: (message) => console.warn(message) }
    )
  }
  return helper
}

/** 当前前台窗口（物理像素坐标）；探针不可用或没有前台窗口时 null */
export async function getForegroundWindowWin32(): Promise<Win32ForegroundSnapshot | null> {
  const reply = await getHelper().request('fg')
  return reply ? parseForegroundReply(reply) : null
}

/** 把目标窗口提到前台并按 Ctrl+V（剪贴板由调用方先写好） */
export async function pasteIntoWindowWin32(hwnd: string, pid: number): Promise<{ ok: boolean; error?: string }> {
  if (!/^\d+$/.test(hwnd)) return { ok: false, error: `invalid window handle: ${hwnd}` }
  const reply = await getHelper().request(`paste ${hwnd} ${Math.max(0, Math.floor(pid))}`)
  if (!reply) return { ok: false, error: 'PowerShell 探针不可用' }
  try {
    const parsed = JSON.parse(reply)
    return parsed?.ok === true ? { ok: true } : { ok: false, error: String(parsed?.error || 'paste failed') }
  } catch {
    return { ok: false, error: 'unexpected probe reply' }
  }
}

/** 退出 / 停止跟随时收掉探针进程；从未起过就是 no-op */
export function disposeWin32ForegroundHelper(): void {
  helper?.dispose()
  helper = null
}

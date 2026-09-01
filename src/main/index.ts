// ⚠️ 必须是第一个 import：ESM 的 import 是提升的，写在别的 import 之后再调用函数就晚了
// （那时其它模块的顶层代码早已跑完）。这里靠"副作用 import + 模块求值即安装"抢在最前面，
// 启动阶段的日志才进得了文件——而启动阶段恰恰最容易出事。
import './main-log'
import './env'
import { app, BrowserWindow, Tray, Menu, nativeImage, shell, ipcMain, screen } from 'electron'
import { loadConfig, saveConfig } from './config-manager'
import { join } from 'path'
import { mkdirSync, existsSync } from 'fs'
import { homedir } from 'os'
import { is } from '@electron-toolkit/utils'
import { startTracking, stopTracking, onStatusChange, onAppChanged, refreshBrowserNotificationLocale } from './window-tracker'
import { registerIpcHandlers, sendInlinePermissionRequest, resolveInlinePermission } from './ipc-handlers'
import { initMcpServers, shutdownMcp, onMcpServersUpdated } from './mcp-manager'
import { shutdownOAuth } from './mcp-oauth'
import { initSkills, reloadSkills, preloadSkillEngine } from './skill-manager'
import { initSubagents, preloadSubagentEngine } from './subagent-manager'
import { initializeOptionalStartupCapability } from './startup-capability-readiness'
import { initRoles, switchRole, getAllRoles, getCurrentRole, RoleConfig, getDisabledApps, getDetectedApps, isAppFollowingEnabled, setAppFollowingEnabled, setDisabledApps } from './role-manager'
import { migrateLegacyTemplates } from './agent-template-manager'
import { migrateLegacyWorkspaces, ensureAgentOutputsDirs } from './agent-workspace-store'
import { gcArtifactDebris } from './artifact-store'
import { BROWSER_APPS } from './app-detector'
import { startHttpServer, setInlinePermissionResolver } from './http-server'
import { initSandbox, resetSandbox } from './sandbox-manager'
import { applyLoginShellPath } from './login-shell-path'
import { initializeSecurityStorage, setInlinePermissionSender } from './pi-security'
import { initMemoryExtractor } from './memory-extractor'
import { initMemoryDreamer, setDreamStatusCallback } from './memory-dreamer'
import { migrateJsonlToMarkdown, ensureMemoryDir, getGlobalMemoryDir } from './memory-store'
import { initScheduler, shutdownScheduler } from './scheduler'
import { getLocaleState, onLocaleChanged, refreshSystemLocale } from './locale-manager'
import { changeMainLocale, initializeMainI18n, tMain } from './main-i18n'
import { createLatestLocaleApplier } from './locale-apply-queue'
import { DATA_DIR_NAME, dataPath, getOpenPipalHome } from './data-root'
import { safeExternalHttpUrl } from './external-navigation-policy'
import { drainConversationService, initializeConversationService } from './conversation-service'
import { shutdownDurableVoiceSession } from './durable-voice-session'

// Release/real-device QA must never borrow the operator's real OpenPipal data.
// Release/real-device QA must never borrow the operator's real OpenPipal data.
//
// 隔离必须是**完整**的,不能只覆盖 dataPath 一条路:仓库里有一大批模块直接调
// os.homedir()（pi-security 的文件访问白名单根、sandbox-manager 的沙箱根、
// openpipal-execution-env 的 `~` 展开、memory-dreamer、ipc-handlers 等）。
// 只改写 app.setPath('home') 对它们无效 —— Electron 的 app.getPath('home') 和
// Node 的 os.homedir() 是两条独立的解析路径。
//
// 所以这里直接把 process.env.HOME 设成隔离根:POSIX 上 os.homedir() 优先读 $HOME,
// 一次赋值就让**所有** homedir 消费者落到同一个根。
// 之前的写法是要求调用方自己保证 HOME 与本变量一致、不一致就抛错;那把「保持同步」
// 的责任推给了人,而人只要漏设一个,QA agent 就能读写操作者的真实 home 且毫无提示。
// 确定性归代码:能由程序保证的一致性,不要做成人肉契约。
const isolatedHome = process.env.OPENPIPAL_ISOLATED_HOME?.trim()
if (isolatedHome) {
  // 解析与校验只有一处实现:data-root 的 getOpenPipalHome()
  const resolvedIsolatedHome = getOpenPipalHome()
  const isolatedUserData = join(resolvedIsolatedHome, DATA_DIR_NAME, 'electron-user-data')
  mkdirSync(isolatedUserData, { recursive: true })
  // 必须先于任何 os.homedir() 消费者求值 —— 本文件是主进程入口,且 env/main-log
  // 之外的模块都在其后 import。
  process.env.HOME = resolvedIsolatedHome
  app.setPath('home', resolvedIsolatedHome)
  app.setPath('userData', isolatedUserData)
  if (homedir() !== resolvedIsolatedHome) {
    // fail closed:平台不认 $HOME 时宁可不启动,也不要跑在半隔离状态下
    throw new Error(
      `OPENPIPAL_ISOLATED_HOME could not be enforced: os.homedir()=${homedir()} != ${resolvedIsolatedHome}`
    )
  }
  console.log(`[QA] isolated OpenPipal home: ${resolvedIsolatedHome}`)
}

let mainWindow: BrowserWindow | null = null
let tray: Tray | null = null
let isQuitting = false  // 真正退出 flag（区分"关窗"和"Cmd+Q"）
let quitCleanupStarted = false
let quitCleanupFinished = false
let refreshTrayMenu: (() => void) | null = null  // createTray 会往这里写引用,供 applyAlwaysOnTop 刷新 checkbox
let disposeLocaleListener: (() => void) | null = null
const applyLocaleState = createLatestLocaleApplier<ReturnType<typeof getLocaleState>>({
  apply: async (state) => changeMainLocale(state.locale),
  publish: (state) => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send('locale:changed', state)
    }
    tray?.setToolTip(tMain('shell.tray.tooltip'))
    refreshTrayMenu?.()
    refreshBrowserNotificationLocale(state.locale)
  },
  onError: (error) => console.warn('[Locale] failed to update native UI:', error)
})

/**
 * 按 enabled 应用窗口置顶状态。true=screen-saver 层级覆盖全屏 app,false=普通窗口。
 * 同时把状态写入 config.json 以便下次启动还原。由 tray 菜单 / Settings / 启动时调用。
 */
function applyAlwaysOnTop(enabled: boolean): void {
  if (!mainWindow || mainWindow.isDestroyed()) return
  if (enabled) {
    mainWindow.setAlwaysOnTop(true, 'screen-saver')
  } else {
    mainWindow.setAlwaysOnTop(false)
  }
  const cfg = loadConfig()
  if (cfg.alwaysOnTop !== enabled) {
    cfg.alwaysOnTop = enabled
    saveConfig(cfg)
  }
  refreshTrayMenu?.()
}

// 暴露给 IPC handlers / renderer 用的 getter / setter
export function isAlwaysOnTopEnabled(): boolean {
  return mainWindow?.isAlwaysOnTop() ?? false
}
export function setAlwaysOnTopEnabled(enabled: boolean): void {
  applyAlwaysOnTop(enabled)
}

// 诊断开关（默认关，零成本）：OPENPIPAL_TRACE_IPC=1 启用 IPC 通道级追踪。
// 主线程冻结时，日志里最后一条没有 [IPC<<] 配对的 [IPC>>] 就是挂起的通道——
// esbuild 打包冻死实案中 6 秒内锁定 artifact:load-compiled（见 debugging-discipline.md）。
if (process.env.OPENPIPAL_TRACE_IPC === '1') {
  const origHandle = ipcMain.handle.bind(ipcMain)
  ;(ipcMain as any).handle = (channel: string, fn: (...args: any[]) => any) =>
    origHandle(channel, async (...args: any[]) => {
      console.log(`[IPC>>] ${channel}`)
      try { return await fn(...args) } finally { console.log(`[IPC<<] ${channel}`) }
    })
  const origOn = ipcMain.on.bind(ipcMain)
  ;(ipcMain as any).on = (channel: string, fn: (...args: any[]) => any) =>
    origOn(channel, (...args: any[]) => {
      console.log(`[IPC-on>>] ${channel}`)
      try { return fn(...args) } finally { console.log(`[IPC-on<<] ${channel}`) }
    })
}

// IPC 只注册一次，通过 getter 获取当前窗口
registerIpcHandlers(() => mainWindow)

// 初始化记忆系统 + 全局工作目录
ensureMemoryDir(getGlobalMemoryDir())
const globalWorkspace = dataPath('workspace')
if (!existsSync(globalWorkspace)) mkdirSync(globalWorkspace, { recursive: true })
initMemoryExtractor()
initMemoryDreamer()
// evolver-agent 静态 import 会把 pi-agent-core + createCodingTools 全链拉进 entry chunk,
// 动态加载:seed(拷贝 bundled 目录)仍在启动即完成,只是不占首屏解析
void import('./evolver-agent').then((m) => m.initEvolver()).catch((e) => console.warn('[Evolver] init 失败:', e?.message))

// CLI 探测缓存预热：execFileSync 串行探 20+ 命令要 ~2.7s，挂在系统提示词装配路径上，
// 不预热的话这笔账由"启动后第一条消息"付——主线程冻住、光标转圈。放到启动空闲期并行做完。
void import('./cli-registry').then((m) => m.warmCliCache()).catch((e) => console.warn('[CLI] 预热失败:', e?.message))

// 一次性迁移旧 JSONL 记忆
try {
  const { hasRole, role } = initRoles()
  if (hasRole && role) {
    const { migrated } = migrateJsonlToMarkdown(role.name)
    if (migrated > 0) console.log(`[Memory] 已迁移 ${migrated} 条旧记忆`)
  }
} catch { /* 迁移失败不影响启动 */ }

// 角色相关 IPC
ipcMain.handle('role:get-all', () => getAllRoles())
ipcMain.handle('role:get-current', () => getCurrentRole())
ipcMain.handle('role:switch', (_event, roleName: string) => {
  const role = switchRole(roleName)
  return role
})
// 设置相关 IPC
ipcMain.handle('settings:get-apps', () => ({
  enabled: isAppFollowingEnabled(),
  detected: getDetectedApps(),
  disabled: getDisabledApps(),
  browsers: Array.from(BROWSER_APPS)
}))
ipcMain.handle('settings:set-disabled-apps', (_event, apps: string[]) => {
  if (!Array.isArray(apps) || !apps.every(appName => typeof appName === 'string')) {
    throw new TypeError('Disabled apps must be an array of strings')
  }
  setDisabledApps(apps)
  return { ok: true }
})
ipcMain.handle('settings:set-app-following-enabled', (_event, enabled: boolean) => {
  if (typeof enabled !== 'boolean') throw new TypeError('App following enabled must be a boolean')
  setAppFollowingEnabled(enabled)
  return { ok: true, enabled }
})

ipcMain.handle('role:get-init-state', () => {
  const { hasRole, role } = initRoles()
  return { hasRole, role }
})

// 本地 STT（whisper.cpp）IPC — Phase 3/4
ipcMain.handle('stt:check', async () => {
  const { checkSTT } = await import('./whisper-stt')
  return checkSTT()
})
ipcMain.handle('stt:transcribe', async (_e, wavBytes: ArrayBuffer) => {
  const { transcribeWav } = await import('./whisper-stt')
  return transcribeWav(wavBytes)
})

// Presenter Window IPC — Phase 6c（renderer × 按钮 / Esc 关闭）
import('./presenter-window').then(({ registerPresenterIpc }) => registerPresenterIpc())

function createWindow(): void {
  // 启动默认铺满工作区(用户要求)。窗口跟随/orb 模式接管后会按各自逻辑 setBounds,
  // 这里只决定"没有跟随目标时"的初始形态。用 workArea 而非 bounds:避开菜单栏/Dock。
  const workArea = screen.getPrimaryDisplay().workArea
  mainWindow = new BrowserWindow({
    x: workArea.x,
    y: workArea.y,
    width: workArea.width,
    height: workArea.height,
    // Orb 模式需要 setBounds(72×72)，最小尺寸必须 ≤ 72 否则 macOS 会拒绝并把窗口卡在 480×400
    minWidth: 64,
    minHeight: 64,
    // 透明无边框：docked 模式靠 App.tsx 的 bg 填充
    // 代价：没有原生 traffic lights（改用 Tray / Cmd+Q / Cmd+W 关闭）
    transparent: true,
    frame: false,
    // 一块浮着的玻璃必须有影子,否则它只是「贴」在桌面上。
    // 之前关掉是为了 orb 模式(72px 圆球外面套一圈方影子很难看),
    // 而 orb 已在 window-tracker 里彻底移除,可以开回来。
    hasShadow: true,
    // macOS 原生毛玻璃材质。backdrop-filter 只能采样页面自己的像素,采不到桌面 ——
    // 想让 chrome 真的磨砂透出背后的桌面/前台应用,只有挂 NSVisualEffectView 这一条路。
    // visualEffectState:'active' 让材质在窗口失焦时依然保持点亮:OpenPipal 常年
    // 贴在别的应用旁边,失焦是常态,不能一没焦点就糊成一块死灰。
    vibrancy: 'under-window',
    visualEffectState: 'active',
    alwaysOnTop: false,
    skipTaskbar: false,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
      // 启用 <webview> 标签：PreviewTab 用它替代 iframe，绕开 X-Frame-Options 限制
      // 让 YouTube/B站/X 等带反内嵌策略的站点在 OpenPipal 内可正常浏览
      webviewTag: true
    }
  })

  // visibleOnFullScreen 常开会给窗口挂 FullScreenAuxiliary 行为，代价是 app 永远无法
  // 成为前台应用（菜单栏永远显示别人的名字）。对照实验隔离出它是唯一致因（transparent 无罪）。
  // 默认关；挂靠目标真全屏时由 window-tracker.applyFullscreenAux 动态开。
  mainWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: false })
  // 置顶行为由用户配置 — 默认关,用户按需在 tray 菜单或 Settings 里开。
  // 开启后用 'screen-saver' 层级穿透 ClassIn maximize / macOS 全屏 Space(但不压系统模态)
  applyAlwaysOnTop(loadConfig().alwaysOnTop === true)

  // 关闭按钮 → 隐藏窗口（后台常驻）；真退出走 Cmd+Q / Tray 菜单 (isQuitting=true)
  mainWindow.on('close', (e) => {
    if (!isQuitting) {
      e.preventDefault()
      mainWindow?.hide()
    }
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    const externalUrl = safeExternalHttpUrl(details.url)
    if (externalUrl) void shell.openExternal(externalUrl)
    return { action: 'deny' }
  })

  // The main renderer owns a preload bridge, so page/user-initiated top-frame
  // navigation must never replace it with Markdown- or page-controlled content.
  // Programmatic loadURL/loadFile calls do not emit will-navigate.
  mainWindow.webContents.on('will-navigate', (event, url) => {
    event.preventDefault()
    const externalUrl = safeExternalHttpUrl(url)
    if (externalUrl) void shell.openExternal(externalUrl)
  })

  onStatusChange((status) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('target:status', status)
      console.log(`[main] IPC target:status sent: isFullscreen=${status.isFullscreen}, connected=${status.connected}`)
    }
  })

  onAppChanged((appName, config) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('target:app-changed', appName, config.displayName)
    }
  })

  // MCP server 渐进就绪推送：窗口解锁后连接在后台并行进行，每个 server 连接完成(成败都算)推一次最新列表
  onMcpServersUpdated((status) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('mcp:servers-updated', status)
    }
  })

  // 捕获渲染进程的 console 输出到主进程日志
  mainWindow.webContents.on('console-message', ({ level, message, lineNumber, sourceId }) => {
    if (level === 'warning' || level === 'error') {
      console.log(`[Renderer ${level === 'error' ? 'ERROR' : 'WARN'}] ${message} (${sourceId}:${lineNumber})`)
    }
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
    mainWindow.webContents.openDevTools({ mode: 'detach' })
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }

  startTracking(mainWindow)

  // 设置内联权限发送器（会话流模式）
  setInlinePermissionSender(sendInlinePermissionRequest, () => mainWindow)
  // 浏览器 POST /api/permission 的回传走桌面同一个 resolver
  setInlinePermissionResolver(resolveInlinePermission)

  // Dreamer 状态通知 → renderer
  setDreamStatusCallback((status, detail) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('dream:status', { status, detail })
    }
  })
}

app.whenReady().then(async () => {
  // 双击图标启动时 PATH 只有 launchd 那四项，编码助手的 bash 与 stdio MCP 都会找不到
  // node / npm / npx —— 详见 login-shell-path.ts。**不 await**：探针要起一个登录 shell
  // （本机空载 0.78s，机器忙时可能走到第二档，最坏十几秒），拖首屏不值得。
  // 它领先整条启动链，两个消费方都在其后：MCP 在下面显式等它，bash 工具还要等
  // 窗口 + 用户发话 + 模型回合，比这久得多。
  const loginShellPathReady = applyLoginShellPath().then((report) => {
    if (report.applied) console.log(`[PATH] 补上登录 shell 的目录 ${report.added.length} 个`)
    return report
  }).catch(() => ({ applied: false, added: [] }))
  // 升级后立即修复历史 audit.log 的文件权限；不等待下一次工具调用。
  // 失败时保持 fail-closed 的写入行为，并避免读取或打印日志内容。
  if (!initializeSecurityStorage()) {
    console.warn('[Security] audit.log 权限初始化失败；审计写入将保持安全失败')
  }

  // 在任何窗口或原生菜单出现前锁定首屏语言，避免英文系统先闪中文再切换。
  const initialLocale = getLocaleState()
  await initializeMainI18n(initialLocale.locale)
  disposeLocaleListener = onLocaleChanged((state) => {
    void applyLocaleState(state)
  })
  app.on('browser-window-focus', () => { refreshSystemLocale() })

  // 路径迁移（幂等）：必须在 initRoles 之前，顺序很重要 —
  //   1. 先把 agents/*.json（旧 templates）搬到 agent-templates/，腾出 agents/ 目录
  //   2. 再把 workspaces/ 搬到 agents/（现在目录已清空）
  migrateLegacyTemplates()
  migrateLegacyWorkspaces()
  ensureAgentOutputsDirs()
  // 一次性清扫 artifact 磁盘垃圾：ephemeral 过程物 sidecar（todos-*/questions-*/goal-*.json，
  // 改为不落盘之前的历史遗留）+ 孪生 .txt 副本（缺 language 误落盘，与强类型文件字节相同）
  try {
    const gc = gcArtifactDebris()
    if (gc.removedEphemeral > 0 || gc.removedTwins > 0) {
      console.log(`[Artifact] 启动 GC：清理 ephemeral sidecar ${gc.removedEphemeral} 个，孪生 .txt ${gc.removedTwins} 个`)
    }
  } catch (err: any) {
    console.warn('[Artifact] 启动 GC 失败:', err?.message)
  }

  initRoles()
  // 沙箱要在 PATH 里找 ripgrep（`/opt/homebrew/bin/rg`，不在 launchd 那份里），找不到就整段
  // 降级成应用层安全模型。2026-08-25 实测双击启动的时间线：沙箱 0.386s 就跑完了，而 PATH 探针
  // 0.554s 才回来 —— 不等这一下，等于一个安全边界被无声地关掉。
  // 但也不能无限等：探针最坏要走到第二档，把首屏卡住十几秒比沙箱降级更糟，所以封顶 2s
  // （超时就维持今天的行为，不会更坏）。
  await Promise.race([loginShellPathReady, new Promise((r) => setTimeout(r, 2000))])
  await initSandbox() // OS 级沙箱（失败时 graceful fallback）——本地快，且 _enabled 门闩要求先于任何 bash 执行
  // 技能/子 Agent 是首轮 prompt 的能力边界，必须先完成默认禁用配置迁移与扫描。
  // 若放到 createWindow 后的后台链，极快的首轮对话会把“配置尚不存在”误当成全部启用。
  // 每类能力内部保持 preload → init；两类互不牵连地并行收敛。
  // 即使动态导入拒绝，另一类仍会就绪，并且最终会继续创建窗口。
  await Promise.all([
    initializeOptionalStartupCapability('技能', preloadSkillEngine, initSkills),
    initializeOptionalStartupCapability('子 Agent ', preloadSubagentEngine, initSubagents)
  ])
  // 新会话默认进入 Pi JSONL；已有 JSON 会话继续原地读取，不做启动时批量改写。
  // 出现兼容问题时可用 OPENPIPAL_SESSION_STORE=legacy-json 整体回退新建路径。
  await initializeConversationService({
    newSessionStorage: process.env.OPENPIPAL_SESSION_STORE?.trim().toLowerCase() === 'legacy-json'
      ? 'legacy-json'
      : 'pi-jsonl-v4'
  })
  createWindow()
  createTray()

  // MCP 连接 / HTTP server / 调度器不阻塞首屏，放后台跑。基础技能目录已在上方就绪；
  // MCP server 连接完成后再把其 suggested skills 合并进现有目录。
  void (async () => {
    // stdio MCP server 的命令常写成 `npx`，PATH 没补齐就直接连不上
    await loginShellPathReady
    await initMcpServers()
    // MCP server 可能提供 suggested skills(resources 里的 skill:// URI),
    // 连接完成后重新扫描让它们并入 piSkills
    reloadSkills()
    startHttpServer()
    initScheduler(() => mainWindow)
  })().catch((err) => {
    console.error('[Startup] 后台初始化链失败:', err)
  })

  app.on('activate', () => {
    refreshSystemLocale()
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow()
    } else if (mainWindow && !mainWindow.isVisible()) {
      mainWindow.show()
    }
  })
})

// macOS: 关窗只是隐藏，保持 app 常驻以便调度器继续跑 + Tray 可见
// 其他平台: 关窗仍然退出（Windows/Linux 通常期望这种行为）
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    isQuitting = true
    app.quit()
  }
})

// 真正退出时清理（Cmd+Q / Tray 菜单 / app.quit()）
app.on('before-quit', (e) => {
  if (quitCleanupFinished) return
  e.preventDefault()
  isQuitting = true
  if (quitCleanupStarted) return
  quitCleanupStarted = true

  void (async () => {
    console.log('[App] 开始退出清理...')
    disposeLocaleListener?.()
    disposeLocaleListener = null
    stopTracking()
    shutdownScheduler()
    // 先停语音输入与工具流，再等待 renderer 把最后一段逐字稿写入会话。
    // 这一步必须在会话 store drain 之前，否则退出时最后一句可能只留在内存。
    await shutdownDurableVoiceSession().catch((error) => {
      console.warn('[Voice] 退出前收口失败:', error)
    })
    // 会话追加写先于 MCP/沙箱退出完成；设置上限避免损坏磁盘或网络盘让应用永远退不掉。
    let drainTimer: NodeJS.Timeout | undefined
    await Promise.race([
      drainConversationService(),
      new Promise<void>((resolve) => {
        drainTimer = setTimeout(() => {
          console.warn('[Conversation] 退出前等待落盘超过 5 秒，继续其余清理')
          resolve()
        }, 5_000)
      })
    ]).catch((error) => console.warn('[Conversation] 退出落盘失败:', error))
    if (drainTimer) clearTimeout(drainTimer)
    await shutdownMcp()
    shutdownOAuth()
    await resetSandbox()
    quitCleanupFinished = true
    console.log('[App] 清理完成，退出')
    app.quit()
  })()
})

function createTray(): void {
  // 官方 mark 的 template 版（纯黑+透明,文件名 Template 结尾 → 自动适配菜单栏深浅色）
  // 重新生成: node scripts/render-tray-icon.cjs
  const iconPath = app.isPackaged
    ? join(process.resourcesPath, 'tray/openpipalTemplate.png')
    : join(__dirname, '../../resources/tray/openpipalTemplate.png')
  const icon = nativeImage.createFromPath(iconPath)
  // 图缺失时回落到旧的文字符号,保证 Tray 永远可见可点
  tray = new Tray(icon)
  if (icon.isEmpty()) tray.setTitle('◉')
  tray.setToolTip(tMain('shell.tray.tooltip'))

  const updateMenu = (): void => {
    // 当前置顶状态(screen-saver 层级 = true,normal 层级 = false)
    const isOnTop = mainWindow?.isAlwaysOnTop() ?? false
    const contextMenu = Menu.buildFromTemplate([
      {
        label: tMain('shell.tray.showMainWindow'),
        click: () => {
          if (!mainWindow || mainWindow.isDestroyed()) {
            createWindow()
          } else {
            mainWindow.show()
            mainWindow.focus()
          }
        }
      },
      { type: 'separator' },
      {
        // 置顶开关(持久化到 config.alwaysOnTop)
        // 关 = 普通窗口层级,截图工具可自由选区;开 = screen-saver 覆盖 ClassIn 全屏
        label: tMain('shell.tray.alwaysOnTop'),
        type: 'checkbox',
        checked: isOnTop,
        click: () => applyAlwaysOnTop(!isOnTop)
      },
      { type: 'separator' },
      {
        label: tMain('shell.tray.runningInBackground'),
        enabled: false
      },
      { type: 'separator' },
      {
        label: tMain('shell.tray.quit'),
        click: () => {
          isQuitting = true
          app.quit()
        }
      }
    ])
    tray?.setContextMenu(contextMenu)
  }

  // 左键点击 → 显示/聚焦主窗口（macOS 习惯）
  tray.on('click', () => {
    if (!mainWindow || mainWindow.isDestroyed()) {
      createWindow()
    } else if (mainWindow.isVisible() && mainWindow.isFocused()) {
      mainWindow.hide()
    } else {
      mainWindow.show()
      mainWindow.focus()
    }
  })

  updateMenu()
  refreshTrayMenu = updateMenu  // 让 applyAlwaysOnTop 能触发菜单刷新
}

/**
 * PresenterWindow — 动态内容（Artifact / HTML / 可交互可视化）的独立展示窗口
 *
 * 触发条件：AI 调用 pi-tool `present_to_user(content, kind='interactive')`
 * 定位：屏幕中央，600×450，frameless transparent，always-on-top（screen-saver 层级）
 *       —— 复用主窗口"浮在全屏应用之上"的同一套配置
 * 渲染：复用主 renderer 入口（index.html?view=presenter），分流到 PresenterView 组件
 * 单实例：连续调用 openPresenter() 只替换内容，不新开窗口
 */
import { BrowserWindow, ipcMain, screen, type IpcMainEvent } from 'electron'
import { join } from 'path'
import { is } from '@electron-toolkit/utils'

let presenterWindow: BrowserWindow | null = null
let pendingContent: { html: string; title?: string } | null = null
let currentContent: { html: string; title?: string } | null = null
let presenterReady = false

const PRESENTER_WIDTH = 600
const PRESENTER_HEIGHT = 450

/**
 * 打开 Presenter（或用新内容替换已有 Presenter）
 * html 是已经生成好的 visualizer HTML 字符串；title 显示在顶部（可选）
 */
export function openPresenter(html: string, title?: string): void {
  if (presenterWindow && !presenterWindow.isDestroyed()) {
    // 始终保留最新内容；renderer 尚未 ready（首次加载或导航中）时不提前发送。
    currentContent = { html, title }
    pendingContent = currentContent
    if (presenterReady) {
      presenterWindow.webContents.send('presenter:set-content', pendingContent)
      pendingContent = null
    }
    presenterWindow.show()
    presenterWindow.focus()
    return
  }

  // 新建：位置放在光标所在显示器的正中
  const cursor = screen.getCursorScreenPoint()
  const display = screen.getDisplayNearestPoint(cursor)
  const { x: dx, y: dy, width: dw, height: dh } = display.workArea

  const window = new BrowserWindow({
    width: PRESENTER_WIDTH,
    height: PRESENTER_HEIGHT,
    x: dx + Math.round((dw - PRESENTER_WIDTH) / 2),
    y: dy + Math.round((dh - PRESENTER_HEIGHT) / 2),
    minWidth: 320,
    minHeight: 240,
    transparent: true,
    frame: false,
    hasShadow: true,
    resizable: true,
    skipTaskbar: true,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })
  presenterWindow = window
  presenterReady = false

  // 承载 AI 生成的 HTML：一律拒绝新开窗口（与主窗口同口径，主窗口另有 openExternal 转交逻辑）
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))

  window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  window.setAlwaysOnTop(true, 'screen-saver')

  currentContent = { html, title }
  pendingContent = currentContent

  // 导航或 reload 会销毁 renderer 监听器；等待新的 presenter:ready 再发送。
  window.webContents.on('did-start-loading', () => {
    if (presenterWindow === window) {
      presenterReady = false
      // Renderer reload 会丢失内存和 IPC 监听器；下一次 ready 必须重放当前内容。
      pendingContent = currentContent
    }
  })

  window.on('closed', () => {
    // closePresenter() 后可能立刻创建新窗口，旧窗口的 closed 不得清空新窗口状态。
    if (presenterWindow === window) {
      presenterWindow = null
      pendingContent = null
      currentContent = null
      presenterReady = false
    }
  })

  // 加载 renderer，URL 加 view=presenter 查询参数让 main.tsx 分流到 PresenterView
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    window.loadURL(`${process.env['ELECTRON_RENDERER_URL']}?view=presenter`)
  } else {
    window.loadFile(join(__dirname, '../renderer/index.html'), {
      search: 'view=presenter'
    })
  }
}

export function closePresenter(): void {
  const window = presenterWindow
  presenterWindow = null
  pendingContent = null
  currentContent = null
  presenterReady = false
  if (window && !window.isDestroyed()) {
    window.close()
  }
}

export function hasOpenPresenter(): boolean {
  return presenterWindow !== null && !presenterWindow.isDestroyed()
}

/**
 * 注册 renderer → main 的 IPC（在 renderer 的关闭按钮 / Esc 会调用）
 */
export function registerPresenterIpc(): void {
  ipcMain.on('presenter:close', (event: IpcMainEvent) => {
    const window = presenterWindow
    if (!window || window.isDestroyed() || event.sender !== window.webContents) return
    closePresenter()
  })
  ipcMain.on('presenter:ready', (event: IpcMainEvent) => {
    const window = presenterWindow
    if (!window || window.isDestroyed() || event.sender !== window.webContents) return

    presenterReady = true
    if (pendingContent) {
      window.webContents.send('presenter:set-content', pendingContent)
      pendingContent = null
    }
  })
}

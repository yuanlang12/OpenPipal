/**
 * DC 隐藏窗口截图共享层 —— 从 dc-video-export.ts 抽出的纯 CDP 工具函数，MP4/PPTX 导出共用。
 *
 * 抽取原则：逐行搬运，不顺手改进（dc-video-export.ts 刚经历多轮修复稳定下来）。这里只放两边都要用的
 * 机制性原语（求值/轮询/隐藏滚动条/仿真视口/clip 取整）；业务语义（自适应收敛判定、播放条高度补偿、
 * 逐帧 seek 时间轴等）留在各自的导出器里，不塞进共享层。
 *
 * 真机验证过的关键顺序（写在这里防止下次重构时被打乱）：BrowserWindow.loadURL 必须先 await 完成，
 * 再 attach CDP debugger + Page.enable —— 顺序反过来会导致 Page.enable 无限期挂起（无报错、无超时，
 * CPU 占用趋近于零），2026-07-09 pptx 导出选型阶段真机复现过。
 */

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Runtime.evaluate 封装：exceptionDetails 不会 reject，必须显式检查，否则错误会静默变成 undefined。 */
export async function evalChecked(
  dbg: Electron.Debugger,
  expression: string,
  opts: Record<string, unknown> = {}
): Promise<any> {
  const res: any = await dbg.sendCommand('Runtime.evaluate', {
    expression,
    returnByValue: true,
    ...opts
  })
  if (res?.exceptionDetails) {
    const ex = res.exceptionDetails
    const msg = ex.exception?.description || ex.text || JSON.stringify(ex)
    throw new Error(msg)
  }
  return res?.result?.value
}

/**
 * 轮询等一个布尔表达式在页面里变真，返回是否在超时前达成（不抛错——调用方按自己的语义决定超时后
 * 是致命错误还是放行继续）。dc-video-export.ts 的 waitForCanvasReady/waitForFontsInlined 都是这个
 * 轮询循环的薄包装，行为通过它们自己的抛错/放行分支保留，不在这里做决定。
 */
export async function pollUntil(
  dbg: Electron.Debugger,
  boolExpression: string,
  timeoutMs: number,
  pollMs = 100
): Promise<boolean> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const ready = await evalChecked(dbg, boolExpression).catch(() => false)
    if (ready) return true
    await sleep(pollMs)
  }
  return false
}

/**
 * 截图场景永不该有滚动条——CDP 层直接隐藏，再注入 overflow:hidden 兜底样式双保险（任何内容溢出都
 * 不再产生滚动条）。真机故障实证：导出窗口里出现过占布局空间的经典滚动条，把引擎自适应压到 0.979。
 * Emulation.setScrollbarsHidden 是实验性命令，个别 Electron 版本缺失时靠下面的 CSS 兜底。
 */
export async function hideScrollbarsAndOverflow(dbg: Electron.Debugger): Promise<void> {
  try {
    await dbg.sendCommand('Emulation.setScrollbarsHidden', { hidden: true })
  } catch {
    /* 实验性命令，个别 Electron 版本缺失时靠下面的 CSS 兜底 */
  }
  await evalChecked(
    dbg,
    `(() => { const s = document.createElement('style'); s.textContent = 'html,body{margin:0!important;overflow:hidden!important}'; document.head.appendChild(s); return true; })()`
  )
}

/** CDP 仿真视口尺寸，与隐藏窗口的物理尺寸解耦——舞台大于当前屏幕分辨率时 macOS 会 clamp 隐藏窗口
 *  的实际尺寸，靠这个 override 绕开。deviceScaleFactor 默认 2：2x 超采样截图，画质更锐。 */
export async function setDeviceMetricsOverride(
  dbg: Electron.Debugger,
  width: number,
  height: number,
  deviceScaleFactor = 2
): Promise<void> {
  await dbg.sendCommand('Emulation.setDeviceMetricsOverride', {
    width,
    height,
    deviceScaleFactor,
    mobile: false
  })
}

export interface ClipRect {
  x: number
  y: number
  width: number
  height: number
}

/**
 * DOMRect → CDP captureScreenshot 的整数 clip 区域。rect 可能带小数（半像素越界会截进画布外的背景，
 * 缩放归一后变成贴边灰线/白线）——向内取整到完全落在画布内的整像素，最多牺牲边缘 1px 内容。
 * 与 dc-video-export.ts 原先内联在 exportArtifactMp4 主体里的 clipX/clipY/clipW/clipH 计算逐行一致。
 */
export function clipFromRect(rect: ClipRect): ClipRect {
  const clipX = Math.max(0, Math.ceil(rect.x))
  const clipY = Math.max(0, Math.ceil(rect.y))
  const clipW = Math.floor(rect.x + rect.width) - clipX
  const clipH = Math.floor(rect.y + rect.height) - clipY
  return { x: clipX, y: clipY, width: clipW, height: clipH }
}

/**
 * 整页内容尺寸的 DOM 真值——CDP Page.getLayoutMetrics 的 cssContentSize（css px，与
 * getBoundingClientRect 同一坐标系），不是猜测视口/窗口尺寸。供 handoff 导出的"静态页整页
 * 截图"用：配合 captureBeyondViewport:true 截出完整内容，不受当前视口裁切。
 *
 * ⚠️ 已知局限：body 设了 overflow:hidden 时（dc 单屏设计的常见写法，防止出现滚动条），
 * cssContentSize 恒等于当前视口尺寸，不是真实画布尺寸——overflow:hidden 只是不产生滚动条/
 * 不可视化溢出，不代表内容不存在。这种场景改用 getDocumentScrollSize（scrollWidth/Height
 * 不受 overflow:hidden 影响，真机验证过：1920x1080 固定画布 + body overflow:hidden，
 * getLayoutMetrics 报回 1600x1000 视口尺寸，scrollWidth/Height 才报回真实的 1920x1080）。
 */
export async function getLayoutContentSize(dbg: Electron.Debugger): Promise<{ width: number; height: number }> {
  const metrics: any = await dbg.sendCommand('Page.getLayoutMetrics')
  const cs = metrics?.cssContentSize || metrics?.contentSize
  const width = Math.ceil(cs?.width || 0)
  const height = Math.ceil(cs?.height || 0)
  return { width, height }
}

/**
 * 整页内容尺寸的 DOM 真值（第二版，overflow:hidden 免疫）：document.documentElement /
 * body 的 scrollWidth/scrollHeight 取两者较大值——这是 CSSOM 标准定义的"内容真实延展尺寸"，
 * 祖先 overflow:hidden 只影响是否出滚动条/是否可视化裁切，不影响这个测量值。
 * 与 getLayoutContentSize 取两者较大值使用：谁测得更大就更接近真实画布（后者在无 overflow
 * 裁切的普通页面/canvas 画板场景已验证可靠，前者补上 overflow:hidden 单屏设计这个盲区）。
 */
export async function getDocumentScrollSize(dbg: Electron.Debugger): Promise<{ width: number; height: number }> {
  const raw = await evalChecked(
    dbg,
    `(() => {
      const de = document.documentElement, b = document.body;
      return {
        width: Math.max(de ? de.scrollWidth : 0, b ? b.scrollWidth : 0),
        height: Math.max(de ? de.scrollHeight : 0, b ? b.scrollHeight : 0)
      };
    })()`
  )
  return { width: Math.ceil(raw?.width || 0), height: Math.ceil(raw?.height || 0) }
}

/**
 * DC 动画导出 MP4 —— 确定性逐帧导出（不做实时录屏）。
 *
 * 核心机制：resources/dc-runtime 的动画运行时（Stage 组件）内置了视频导出协议——画布元素带
 * data-om-exportable-video-with-duration-secs 属性标记可截图元素，并监听
 * 'data-om-seek-to-time-frame' CustomEvent（挂在该元素本身，detail.time 为秒）：收到后
 * 暂停播放并把播放头精确定位到该时间戳。导出器逐帧 dispatch 这个事件驱动 React 渲染到精确的
 * t=i/fps，再用 CDP Page.captureScreenshot 对该元素做 clip 截图（只截画布本身，不含底部
 * 播放条/黑色 letterbox），彻底避开 capturePage() 截整个隐藏窗口带来的播放条+黑边问题。
 * 选择器只认协议属性、不限定标签名（自研运行时的画布是普通元素，旧产物的 svg 画布同样命中）。
 *
 * 舞台真实尺寸以从画布元素读到的 width/height 属性（引擎从 Stage props 写入，不是解析
 * content 猜出来的）为唯一真值。拿到真值后用 CDP Emulation.setDeviceMetricsOverride 把
 * 视口仿真到 stageWidth x (stageHeight+160)（160 = 播放条/剪辑轨的下沿预算，见 setViewport），
 * 与隐藏窗口的物理尺寸解耦——舞台大于当前屏幕分辨率时 macOS 会 clamp 隐藏窗口的实际尺寸，
 * 若仍靠物理窗口撑视口，引擎的自适应缩放会被压到 <1，画布缩小后再被 clip
 * 截图放大就会糊。override 后轮询等引擎 ResizeObserver 结算到 scale≈1（±2px 容差），
 * 超时直接中止导出而不是带着错误缩放值继续跑完整条流水线却不报错。
 *
 * 时间线完全由 seek 事件驱动（非虚拟时钟、非真实时钟录制），每帧独立精确对应 t=i/fps，不存在
 * 相位漂移。每次 seek 后用双 requestAnimationFrame 确保 React 提交 + 合成绘制完成后才截图。
 *
 * 装配复用 dc-export.ts 的 assembleOfflineDc（headless 内联 + React vendor 内联，断网可开，
 * 杜绝 unpkg CDN 的网络不确定性）。
 *
 * 时长同样以 DOM 为唯一真值：画布元素的 data-om-exportable-video-with-duration-secs 属性
 * 是引擎已经解析好的真实秒数（哪怕源码写的是 duration={DURATION} 变量引用，也已经被引擎求值成
 * 具体数字写在这里）——不再靠源码正则猜 duration={N}/"N"/:N（猜不到变量引用，会静默落错误兜底）。
 * opts.durationSec 变成可选、仅用于向后兼容显式截取场景（如自动化冒烟测试固定跑 N 秒）；不传时
 * 优先读 DOM 真值，再退到 15s 兜底。
 *
 * 编码走系统 ffmpeg（探测顺序：/opt/homebrew/bin → /usr/local/bin → PATH），并用 -vf scale
 * 把截图归一到舞台原生分辨率的就近偶数（libx264+yuv420p 硬性要求，奇数尺寸舞台会编码失败；
 * 视口 deviceScaleFactor=1 时截图本就是 1:1，scale 基本是 no-op 兜底）。对齐 dc-export.ts
 * exportZip 用系统 /usr/bin/zip 的模式——不引入新 npm 依赖。
 */
import fs from 'fs'
import path from 'path'
import { homedir } from 'os'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { assembleOfflineDc, sanitizeName } from './dc-export'
import { evalChecked, pollUntil, hideScrollbarsAndOverflow, setDeviceMetricsOverride, clipFromRect, sleep } from './dc-capture'
import { mainError, tMain } from './main-i18n'
import { dataPath } from './data-root'

const execFileAsync = promisify(execFile)
const OUTPUTS_ROOT = dataPath('outputs')

export interface Mp4ExportResult {
  ok: boolean
  path?: string
  error?: string
}

function resolveFfmpegBin(): string {
  for (const c of ['/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg']) {
    if (fs.existsSync(c)) return c
  }
  return 'ffmpeg' // PATH 兜底，execFile 若 ENOENT 统一转成"未安装"的中文错误
}

/**
 * Stage 尺寸 heuristic：content 里第一个 width=/height=（HTML 属性 "N"/'N' 或 JSX 花括号 {N} 皆可）。
 * ⚠️ 不可信——仅用于创建隐藏窗口的初值猜测（正则会无声匹配到非像素值，例如
 * `width="100%"` 的 "100"）。真正的舞台尺寸以导出后从 DOM 读到的画布 width/height
 * 属性为准（见 readDomStageSize），后续视口/clip/ffmpeg 归一一律用 DOM 值。
 */
function parseStageSize(content: string): { width: number; height: number } {
  const firstNum = (re: RegExp): number | null => {
    const m = re.exec(content)
    if (!m) return null
    const n = parseInt(m[1], 10)
    return Number.isFinite(n) && n > 0 ? n : null
  }
  const width = firstNum(/\bwidth=["']?\{?(\d+)\}?["']?/i) ?? 1280
  const height = firstNum(/\bheight=["']?\{?(\d+)\}?["']?/i) ?? 720
  return { width, height }
}

/**
 * 导出目标画布的定位式。**只认协议属性，不限定标签名**——自研运行时的画布是普通元素，
 * foreignObject 那套（字体不继承、尺寸怪癖）在"对活页面做像素捕获"的路线上零收益。
 * 属性名不动（协议标识符照搬），所以旧产物里的 svg 画布同样命中这条选择器。
 */
export const CANVAS_SELECTOR = "document.querySelector('[data-om-exportable-video-with-duration-secs]')"

/** 轮询等导出目标画布出现（引擎 React 挂载完成的标志），超时报中文错误。 */
export async function waitForCanvasReady(dbg: Electron.Debugger, timeoutMs: number): Promise<void> {
  const ready = await pollUntil(dbg, `!!${CANVAS_SELECTOR}`, timeoutMs)
  if (!ready) throw new Error(tMain('artifacts.shell.export.errors.canvasNotReady'))
}

/** 轮询等引擎置位字体就绪（data-om-fonts-inlined）；超时不阻塞，直接放行继续导出。 */
export async function waitForFontsInlined(dbg: Electron.Debugger, timeoutMs: number): Promise<void> {
  await pollUntil(dbg, `!!(${CANVAS_SELECTOR}?.getAttribute('data-om-fonts-inlined'))`, timeoutMs)
}

/**
 * 舞台真实尺寸的唯一来源：画布元素上引擎从 Stage props 写入的 width/height 数字属性
 * （非 CSS 尺寸，不受当前缩放影响）。parseStageSize 的正则解析只是创建隐藏窗口的初值猜测，
 * 不可信——读不到或非正数一律返回 null，交给调用方判定为致命错误而不是静默用错误值继续。
 */
export async function readDomStageSize(dbg: Electron.Debugger): Promise<{ width: number; height: number } | null> {
  const raw = await evalChecked(
    dbg,
    `(() => { const el = ${CANVAS_SELECTOR}; if (!el) return null; return { width: el.getAttribute('width'), height: el.getAttribute('height') }; })()`
  )
  if (!raw) return null
  const width = Math.round(parseFloat(raw.width))
  const height = Math.round(parseFloat(raw.height))
  if (!Number.isFinite(width) || width <= 0 || !Number.isFinite(height) || height <= 0) return null
  return { width, height }
}

/**
 * 视频时长的唯一来源：画布元素上 data-om-exportable-video-with-duration-secs 属性——引擎
 * （Stage 组件）已经把 duration prop 解析成具体秒数字符串写在这里，哪怕源码写的是
 * duration={DURATION} 变量引用也已被引擎求值，比源码正则猜测可靠。允许小数秒（不 round——时长
 * 语义是精确截取到某个时间点，不是取整）。读不到或非正数一律返回 null。
 */
export async function readDomDurationSec(dbg: Electron.Debugger): Promise<number | null> {
  const raw = await evalChecked(
    dbg,
    `(() => { const el = ${CANVAS_SELECTOR}; return el ? el.getAttribute('data-om-exportable-video-with-duration-secs') : null; })()`
  )
  if (raw == null) return null
  const n = parseFloat(raw)
  return Number.isFinite(n) && n > 0 ? n : null
}

/**
 * 用 CDP 仿真视口尺寸，与隐藏窗口的物理尺寸解耦——舞台大于当前屏幕分辨率时，macOS 会 clamp
 * 隐藏 BrowserWindow 的实际尺寸，导致引擎自适应缩小画布（scale<1）再被 clip 截图放大而糊片。
 * deviceScaleFactor 固定 2：2x 超采样截图，ffmpeg 下采样归一后线条更锐。
 */
export async function setViewport(dbg: Electron.Debugger, stageWidth: number, stageHeight: number): Promise<void> {
  // 真机故障（1253x705 = 两个方向各被啃 15px）实证：导出窗口里出现过占布局空间的经典
  // 滚动条，把引擎自适应压到 0.979。截图场景滚动条永远不该存在——共享层双保险处理
  // （CDP 隐藏 + overflow:hidden 兜底样式），见 dc-capture.ts hideScrollbarsAndOverflow。
  await hideScrollbarsAndOverflow(dbg)
  await setDeviceMetricsOverride(
    dbg,
    stageWidth,
    // +160：给播放条留的下沿预算。曾经是 +60（播放条 45px = 44 + 1px borderTop + 余量），
    // 2026-08-15 播放条升级成剪辑台后，展开态是「控制行 44 + 轨道行 40」= 84px
    // （1px 上边框走 border-box，含在 44 里），
    // 60 已经不够——不够的后果不是难看而是**导出中止**：视口被啃到 stageHeight 以下，
    // 引擎自适应把画布压成 scale<1，waitForAutofitSettled 的 ±2px 断言直接判失败。
    // 预留多给不花任何代价（画布 scale 封顶 1、截图按画布矩形 clip，多出来的只是 letterbox），
    // 所以直接给到远离边界的 160，而不是贴着 85 再算余量。
    stageHeight + 160,
    // 2 = 2x 超采样抗锯齿。实测（240 帧对照：dsf2+png 24.3s / dsf1+png 25.5s /
    // dsf1+jpeg 25.3s）每帧 ~105ms 是固定延迟主导（双 rAF + CDP 往返 + 合成器读回），
    // 与像素量/编码格式无关——降采样不省时间，超采样画质等于白拿，保留 2。
    2
  )
}

/**
 * 轮询等引擎 autofit 在视口 override 后结算（override 触发 ResizeObserver 重算，需要时间）：
 * 反复量画布元素的 getBoundingClientRect，直到实测尺寸收敛到舞台尺寸（±2px 容差）。
 * 返回 settled=false 时调用方必须中止导出——这是跨步骤不变量断言，防止"错误的一致性"
 * （视口/clip/ffmpeg 全部忠实执行同一个错误缩放值，却因为没有报错而被误当作导出成功）。
 */
export async function waitForAutofitSettled(
  dbg: Electron.Debugger,
  stageWidth: number,
  stageHeight: number,
  timeoutMs: number
): Promise<{ settled: boolean; rect: { x: number; y: number; width: number; height: number }; env: string }> {
  const start = Date.now()
  let rect = { x: 0, y: 0, width: 0, height: 0 }
  let env = ''
  while (Date.now() - start < timeoutMs) {
    // env 一并采集：失败时报错信息自带环境证据（视口/文档客户区/滚动尺寸），
    // 下次真机故障不用再猜是滚动条、缩放还是溢出。
    const m = await evalChecked(
      dbg,
      `(() => { const el = ${CANVAS_SELECTOR}; const r = el.getBoundingClientRect(); const d = document.documentElement;
        return { x: r.x, y: r.y, width: r.width, height: r.height,
                 env: 'inner ' + window.innerWidth + 'x' + window.innerHeight + ' client ' + d.clientWidth + 'x' + d.clientHeight + ' scroll ' + d.scrollWidth + 'x' + d.scrollHeight }; })()`
    )
    env = m.env
    rect = { x: m.x, y: m.y, width: m.width, height: m.height }
    if (Math.abs(rect.width - stageWidth) < 2 && Math.abs(rect.height - stageHeight) < 2) {
      return { settled: true, rect, env }
    }
    await sleep(100)
  }
  return { settled: false, rect, env }
}

export async function exportArtifactMp4(
  title: string,
  content: string,
  artifactId: string | undefined,
  opts: { durationSec?: number; fps?: number },
  targetDir?: string,
  onProgress?: (done: number, total: number) => void
): Promise<Mp4ExportResult> {
  const { app, BrowserWindow } = require('electron')
  if (!BrowserWindow) return { ok: false, ...mainError('artifacts.shell.export.errors.noBrowserWindow') }

  const fps = Math.max(1, Math.min(60, Math.round(opts.fps || 30)))

  let html: string
  let width: number, height: number
  try {
    html = assembleOfflineDc(content, artifactId)
    ;({ width, height } = parseStageSize(content))
  } catch (err: any) {
    return { ok: false, ...mainError('artifacts.shell.export.errors.assembleFailed', { detail: err?.message || String(err) }) }
  }

  const frameDir = path.join(app.getPath('temp'), `openpipal-mp4-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
  fs.mkdirSync(frameDir, { recursive: true })

  let win: Electron.BrowserWindow | null = null
  try {
    win = new BrowserWindow({
      show: false,
      useContentSize: true,
      width,
      // +160：Stage 组件为播放条/剪辑轨预留的高度。这里的 width/height 只是 parseStageSize 的
      // heuristic 初值——用来开一个大致合适的隐藏窗口。真实舞台尺寸稍后从 DOM 读出，
      // 再用 CDP Emulation.setDeviceMetricsOverride 仿真视口，与本窗口的物理尺寸解耦，
      // 不受 macOS 屏幕 clamp 影响，无需在这里保证精确。
      height: height + 160,
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        // 隐藏窗口默认会节流 rAF/timer——逐帧导出要等 rAF 落地，节流会直接卡死等待
        backgroundThrottling: false
      }
    })
    const w = win! // win 刚构造完成，非空；finally 里会重新判空清理
    await w.loadURL('data:text/html;base64,' + Buffer.from(html, 'utf8').toString('base64'))

    const dbg = w.webContents.debugger
    try {
      dbg.attach('1.3')
    } catch (err: any) {
      return { ok: false, ...mainError('artifacts.shell.export.errors.cdpAttachFailed', { detail: err?.message || String(err) }) }
    }
    await dbg.sendCommand('Page.enable')

    // 等导出目标画布出现，再等一次双 rAF 让 React effects（字体置位等）落定。
    await waitForCanvasReady(dbg, 8000)
    await evalChecked(
      dbg,
      `new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`,
      { awaitPromise: true }
    )
    // 字体内联是可选的画质保证，不是必要前置条件——超时也继续，不阻塞整段导出。
    await waitForFontsInlined(dbg, 3000)

    // 舞台真实尺寸以 DOM 为唯一真值——parseStageSize 的正则猜测可能读到非像素值
    // （如 width="100%" 的 "100"），此处覆盖 width/height，后续视口/clip/ffmpeg 归一
    // 全部改用这个值。
    const domSize = await readDomStageSize(dbg)
    if (!domSize) throw new Error(tMain('artifacts.shell.export.errors.stageSizeUnreadable'))
    width = domSize.width
    height = domSize.height

    // 时长决策：opts.durationSec 显式传入且 >0 时优先（向后兼容"截取前 N 秒"场景，如自动化
    // 冒烟测试固定跑几秒）→ 否则用 DOM 真值（引擎已解析好的真实秒数）→ 都没有兜底 15s。
    // clamp [1, 300] 是防呆上限，不是精度截断——DOM 真值超过 5 分钟也按 300s 导出。
    const domDurationSec = await readDomDurationSec(dbg)
    const rawDurationSec = opts.durationSec && opts.durationSec > 0 ? opts.durationSec : (domDurationSec ?? 15)
    const durationSec = Math.max(1, Math.min(300, rawDurationSec))
    const totalFrames = Math.round(durationSec * fps)

    // 视口用 CDP 仿真而非物理窗口尺寸：舞台若大于当前屏幕分辨率，macOS 会 clamp 隐藏
    // BrowserWindow 的实际尺寸，导致引擎自适应缩小画布（scale<1），clip 截图再被 ffmpeg
    // 放大归一就会糊。override 后引擎的 ResizeObserver 需要时间重算，所以后面要轮询等结算。
    await setViewport(dbg, width, height)
    const settleResult = await waitForAutofitSettled(dbg, width, height, 3000)
    if (!settleResult.settled) {
      throw new Error(
        `画布未达到原生分辨率（期望 ${width}x${height}，实测 ${Math.round(settleResult.rect.width)}x${Math.round(settleResult.rect.height)}；${settleResult.env}），导出中止`
      )
    }
    const rect = settleResult.rect
    // rect 可能带小数（引擎按 44px 预留播放条，实际渲染 45px 含 borderTop，720 塞进 719
    // 居中后 y=-0.5）：clip 半像素越界会截进画布外的深色舞台背景/视口外白色，缩放归一后
    // 变成贴边灰线。向内取整到完全落在画布内的整像素，最多牺牲边缘 1px 内容（见
    // dc-capture.ts clipFromRect）。
    const { x: clipX, y: clipY, width: clipW, height: clipH } = clipFromRect(rect)
    if (clipW < 2 || clipH < 2) throw new Error(tMain('artifacts.shell.export.errors.canvasClipInvalid', { detail: JSON.stringify(rect) }))

    for (let i = 0; i < totalFrames; i++) {
      const t = (i / fps).toFixed(6)
      // seek 事件挂在画布元素本身（canvasRef），必须 dispatch 到同一个元素，打到
      // window/document 上收不到。双 rAF 确保 React 提交 + 合成绘制完成后才 resolve，
      // 这样第 i 帧就是精确的 t=i/fps 秒，不存在相位漂移。
      await evalChecked(
        dbg,
        `(() => new Promise((resolve, reject) => {
          try {
            const el = ${CANVAS_SELECTOR};
            if (!el) { reject(new Error('canvas missing')); return; }
            el.dispatchEvent(new CustomEvent('data-om-seek-to-time-frame', { detail: { time: ${t} } }));
            requestAnimationFrame(() => requestAnimationFrame(() => resolve(true)));
          } catch (e) { reject(e); }
        }))()`,
        { awaitPromise: true }
      )

      const shot: any = await dbg.sendCommand('Page.captureScreenshot', {
        format: 'png',
        clip: { x: clipX, y: clipY, width: clipW, height: clipH, scale: 1 },
        // 帧序列场景编码速度优先于压缩率（临时帧落盘后即进 ffmpeg，体积无所谓）
        optimizeForSpeed: true
      })
      fs.writeFileSync(path.join(frameDir, `frame${String(i).padStart(5, '0')}.png`), Buffer.from(shot.data, 'base64'))
      if ((i + 1) % 10 === 0 || i === totalFrames - 1) onProgress?.(i + 1, totalFrames)
    }
  } catch (err: any) {
    console.error('[dc-video-export] 帧渲染异常', err)
    try { fs.rmSync(frameDir, { recursive: true, force: true }) } catch { /* ignore */ }
    return { ok: false, ...mainError('artifacts.shell.export.errors.renderFailed', { detail: err?.message || String(err) }) }
  } finally {
    try {
      if (win && !win.isDestroyed() && win.webContents.debugger.isAttached()) win.webContents.debugger.detach()
    } catch { /* ignore */ }
    try { win?.destroy() } catch { /* ignore */ }
  }

  const outRoot = targetDir || OUTPUTS_ROOT
  fs.mkdirSync(outRoot, { recursive: true })
  // title 常带 .dc.html/.html/.md 后缀（源自 artifact 文件名），去掉避免产出
  // "xxx.dc.html.mp4" 这种双后缀文件名。对齐 dc-export.ts exportStandaloneHtml 的同款处理。
  const baseName = sanitizeName(title).replace(/\.dc\.html?$/i, '').replace(/\.html?$/i, '').replace(/\.md$/i, '')
  const outPath = path.join(outRoot, `${baseName || 'design'}.mp4`)
  const ffmpegBin = resolveFfmpegBin()
  // Retina 屏下 CDP 截图可能是 2x 像素；-vf scale 归一回舞台原生分辨率，同时把宽高
  // 就近取偶——libx264+yuv420p 要求偶数尺寸，舞台若是奇数尺寸会直接编码失败。
  const scaleW = Math.round(width / 2) * 2
  const scaleH = Math.round(height / 2) * 2
  try {
    await execFileAsync(ffmpegBin, [
      '-y',
      '-framerate', String(fps),
      '-i', path.join(frameDir, 'frame%05d.png'),
      '-vf', `scale=${scaleW}:${scaleH}`,
      '-c:v', 'libx264',
      '-pix_fmt', 'yuv420p',
      '-movflags', '+faststart',
      outPath
    ])
  } catch (err: any) {
    console.error('[dc-video-export] ffmpeg 编码异常', err)
    try { fs.rmSync(frameDir, { recursive: true, force: true }) } catch { /* ignore */ }
    if (err?.code === 'ENOENT') return { ok: false, ...mainError('artifacts.shell.export.errors.ffmpegMissing') }
    return { ok: false, ...mainError('artifacts.shell.export.errors.ffmpegFailed', { detail: err?.message || String(err) }) }
  }
  try { fs.rmSync(frameDir, { recursive: true, force: true }) } catch { /* ignore */ }
  return { ok: true, path: outPath }
}

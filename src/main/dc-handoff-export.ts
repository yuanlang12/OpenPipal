/**
 * Handoff to Code Agent 交接包导出 —— 对标官方 Claude Design 的 "Handoff to Claude Code"，
 * 但通用化、不绑定任何目标框架/工具（用户明确要求：任意 coding agent——Claude Code/Cursor/
 * Codex……都能拿去实现，不是"生成 Claude Code 专用 prompt"）。
 *
 * 产出物（zip 内）：
 *   handoff-<sanitize后的标题>/
 *   ├─ HANDOFF.md   给 coding agent 的实现说明（确定性模板渲染，不调模型）
 *   ├─ design/      原始源文件：.dc.html + 全部场景 sidecar（复用 dc-export.ts 的 sibling 收集逻辑）
 *   ├─ reference/   视觉基准截图（高清 PNG，01-<屏名>.png 递增）
 *   └─ tokens.json  机器可读设计事实（颜色/字体/字号，DOM getComputedStyle 遍历所得）
 *
 * 三类 dc 的 reference/ 截图策略（全部复用既有捕获管线，不重写）：
 *   - deck（deck-stage）：逐页截图，复用 dc-pptx-export.ts 抽出的 captureDeckStageFrames
 *     （与 PPTX 导出同一条翻页+截图路径，pptx 冒烟不变量同时守卫这段逻辑）。
 *   - 动画（animations Stage）：复用 dc-video-export.ts 的 seek 协议原语，均匀采样 6 帧
 *     （t=0 到 DOM 真值时长，含首尾），比逐帧 mp4 导出轻量得多。
 *   - 静态页/画布：canvas 模式（含 [data-screen-label]）逐 frame clip 截图；否则整页一张
 *     （CDP Page.getLayoutMetrics 的 cssContentSize 与 scrollWidth/Height 两种 DOM 真值取
 *     较大者 + captureBeyondViewport，兜住 body overflow:hidden 单屏设计的测量盲区，见
 *     dc-capture.ts getLayoutContentSize/getDocumentScrollSize 注释）。
 *
 * 分类优先级 deck > animation > canvas > page：多方向对比稿里每个方向若各自嵌入独立动画
 * （animation-basics 技能的三方向 canvas 对比稿）会同时命中 animation 特征和 canvas 结构，
 * 此时按 animation 处理（采样第一个 Stage 的关键帧）——已知的行为边界，非该场景的主线用法。
 */
import fs from 'fs'
import path from 'path'
import { homedir } from 'os'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { assembleOfflineDc, sanitizeName, dcRuntimeDir, prepareDcForExport, artifactSourceDir } from './dc-export'
import { collectSidecarNames, readSidecarFiles, injectSidecarData } from './dc-headless'
import {
  evalChecked,
  pollUntil,
  hideScrollbarsAndOverflow,
  setDeviceMetricsOverride,
  clipFromRect,
  getLayoutContentSize,
  getDocumentScrollSize
} from './dc-capture'
import { captureDeckStageFrames } from './dc-pptx-export'
import {
  CANVAS_SELECTOR,
  waitForCanvasReady,
  waitForFontsInlined,
  readDomStageSize,
  readDomDurationSec,
  setViewport,
  waitForAutofitSettled
} from './dc-video-export'
import { PAGE_TEXT_SUMMARY_JS } from './dc-text-summary'
import { looksLikeDeckDc, looksLikeAnimationDc } from './export-artifact-validate'
import { mainError, tMain } from './main-i18n'
import { dataPath } from './data-root'

const execFileAsync = promisify(execFile)
const OUTPUTS_ROOT = dataPath('outputs')

// ============================================================================
// 纯函数面（可单测，零 electron 依赖）
// ============================================================================

export type HandoffDcType = 'deck' | 'animation' | 'canvas' | 'page'

export interface HandoffScreen {
  index: number // 1-based，reference/ 文件名的序号来源（不是 label 里可能带的编号）
  label: string // 已 sanitize 的展示名
  fileName: string // 如 "01-Title.png"
  textSummary: string
}

export interface RawTally {
  value: string
  count: number
}

export interface TokenColorEntry {
  hex: string
  count: number
}
export interface TokenTextEntry {
  value: string
  count: number
}

export interface TokensSummary {
  colors: TokenColorEntry[]
  fontFamilies: TokenTextEntry[]
  fontWeights: TokenTextEntry[]
  fontSizes: TokenTextEntry[]
}

export interface HandoffMeta {
  title: string
  dcType: HandoffDcType
  stageWidth: number
  stageHeight: number
  pageCount?: number
  durationSec?: number
  generatedAt: string // ISO
  designFiles: string[] // design/ 下的相对路径清单
}

/** 屏名 sanitize：去掉 deck-stage 自动加的 "01 " 编号前缀（reference/ 文件名自己控制序号，
 *  避免和 label 里的编号重复），清洗文件名非法字符，空值兜底 screen-N。 */
export function sanitizeScreenLabel(raw: string | null | undefined, fallbackIndex: number): string {
  let s = (raw || '').trim()
  s = s.replace(/^\d+\s+/, '') // "01 Title" -> "Title"（deck-stage 自动编号前缀）
  s = s.replace(/\s+/g, ' ').trim()
  if (!s) return `screen-${fallbackIndex}`
  return s
}

/** 文件名安全化：非法字符替换为 '-'，压缩空白，封顶 48 字符防超长路径。 */
export function filenameSafe(s: string): string {
  const cleaned = s
    .replace(/[\\/:*?"<>|\x00-\x1f]/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
  return (cleaned || 'screen').slice(0, 48)
}

export function buildScreenFileName(index: number, label: string): string {
  return `${String(index).padStart(2, '0')}-${filenameSafe(label)}.png`
}

/** count 降序排序 + 封顶（tokens 各类目上限 24 条防表格爆炸）。 */
export function capAndSortTally(entries: RawTally[], limit = 24): RawTally[] {
  return [...entries].sort((a, b) => b.count - a.count).slice(0, limit)
}

/** rgb()/rgba() 字符串 → #rrggbb；透明色（alpha=0）视为非 token 返回 null。 */
export function rgbStringToHex(rgb: string): string | null {
  const m = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+))?\)$/i.exec((rgb || '').trim())
  if (!m) return null
  const a = m[4] !== undefined ? parseFloat(m[4]) : 1
  if (!Number.isFinite(a) || a <= 0) return null
  const toHex = (n: string): string => Math.max(0, Math.min(255, parseInt(n, 10))).toString(16).padStart(2, '0')
  return `#${toHex(m[1])}${toHex(m[2])}${toHex(m[3])}`
}

/** 原始 rgb 字符串计数 → 按 hex 归并去重（不同 rgb 写法可能映射同一 hex）→ 排序封顶。 */
export function summarizeColorTallies(raw: RawTally[], limit = 24): TokenColorEntry[] {
  const byHex = new Map<string, number>()
  for (const { value, count } of raw) {
    const hex = rgbStringToHex(value)
    if (!hex) continue
    byHex.set(hex, (byHex.get(hex) || 0) + count)
  }
  return capAndSortTally(
    Array.from(byHex, ([hex, count]) => ({ value: hex, count })),
    limit
  ).map((e) => ({ hex: e.value, count: e.count }))
}

export function summarizeTextTallies(raw: RawTally[], limit = 24): TokenTextEntry[] {
  return capAndSortTally(raw, limit).map((e) => ({ value: e.value, count: e.count }))
}

const DC_TYPE_LABEL: Record<HandoffDcType, string> = {
  deck: '幻灯片（deck）',
  animation: '动画（animation）',
  canvas: '多方向画板（canvas）',
  page: '静态页（page）'
}

function mdEscapeCell(s: string): string {
  return s.replace(/\|/g, '\\|')
}

/** HANDOFF.md 确定性模板渲染（不调模型）：概要 + 逐屏结构 + 设计 tokens + 源文件导读 + 实现指引。 */
export function buildHandoffMd(meta: HandoffMeta, screens: HandoffScreen[], tokens: TokensSummary): string {
  const lines: string[] = []
  lines.push(`# ${meta.title} —— Handoff to Code Agent`)
  lines.push('')
  lines.push('## 1. 概要')
  lines.push('')
  lines.push(`- 标题：${meta.title}`)
  lines.push(`- 类型：${DC_TYPE_LABEL[meta.dcType]}`)
  lines.push(`- 舞台尺寸：${meta.stageWidth} x ${meta.stageHeight}`)
  if (meta.dcType === 'deck') lines.push(`- 页数：${meta.pageCount ?? screens.length}`)
  if (meta.dcType === 'animation') lines.push(`- 时长：${(meta.durationSec ?? 0).toFixed(1)}s`)
  lines.push(`- 生成时间：${meta.generatedAt}`)
  lines.push(`- 来源：OpenPipal（design 角色 export_artifact 交接包）`)
  lines.push('')
  lines.push('## 2. 逐屏结构')
  lines.push('')
  if (!screens.length) {
    lines.push('（未能提取到屏幕结构，请直接参考 design/ 源文件。）')
  }
  for (const s of screens) {
    lines.push(`### ${String(s.index).padStart(2, '0')} · ${s.label}`)
    lines.push('')
    lines.push(`![${s.label}](reference/${s.fileName})`)
    lines.push('')
    lines.push(s.textSummary ? s.textSummary : '（无可提取文本）')
    lines.push('')
  }
  lines.push('## 3. 设计 tokens')
  lines.push('')
  lines.push('机器可读版本同步存于 `tokens.json`（与下表同一份数据）。')
  lines.push('')
  lines.push('### 颜色（按出现频次排序）')
  lines.push('')
  if (tokens.colors.length) {
    lines.push('| 颜色 | 出现次数 |')
    lines.push('|---|---|')
    for (const c of tokens.colors) lines.push(`| \`${c.hex}\` | ${c.count} |`)
  } else {
    lines.push('（未提取到颜色 token）')
  }
  lines.push('')
  lines.push('### 字体族')
  lines.push('')
  if (tokens.fontFamilies.length) {
    lines.push('| 字体族 | 出现次数 |')
    lines.push('|---|---|')
    for (const f of tokens.fontFamilies) lines.push(`| ${mdEscapeCell(f.value)} | ${f.count} |`)
  } else {
    lines.push('（未提取到字体 token）')
  }
  lines.push('')
  lines.push('### 字重')
  lines.push('')
  if (tokens.fontWeights.length) {
    lines.push('| 字重 | 出现次数 |')
    lines.push('|---|---|')
    for (const f of tokens.fontWeights) lines.push(`| ${mdEscapeCell(f.value)} | ${f.count} |`)
  } else {
    lines.push('（未提取到字重 token）')
  }
  lines.push('')
  lines.push('### 字号')
  lines.push('')
  if (tokens.fontSizes.length) {
    lines.push('| 字号 | 出现次数 |')
    lines.push('|---|---|')
    for (const f of tokens.fontSizes) lines.push(`| ${mdEscapeCell(f.value)} | ${f.count} |`)
  } else {
    lines.push('（未提取到字号 token）')
  }
  lines.push('')
  lines.push('## 4. 源文件导读')
  lines.push('')
  for (const f of meta.designFiles) {
    lines.push(`- \`design/${f}\` — ${describeDesignFile(f)}`)
  }
  lines.push('')
  lines.push('**dc 格式速读**（OpenPipal 的 Design Component 格式，不必逐字复刻）：`<x-dc>` 包裹的模板由 `support.js` 运行时驱动、首个流式字符就开始渲染；`<x-import from="./xxx.js">` 挂载预制件（`deck-stage.js` 幻灯片舞台 / `animations.js` 动画时间线引擎）或场景 sidecar；`<helmet>` 段放 `@font-face`/`@keyframes` 等全局样式与 `design_doc_mode` 元信息；参数化交互写在 `<script type="text/x-dc" data-props="...">` 的 DCLogic 子类里。源文件是给你读懂设计意图（结构/状态/动效时序）的——完全可以用目标技术栈重新实现，不必保留这套模板语法。')
  lines.push('')
  lines.push('## 5. 实现指引')
  lines.push('')
  lines.push('- `reference/` 里的截图是**视觉权威**——像素级还原以这些图为准，design/ 源文件是理解结构和逻辑的补充')
  lines.push('- 技术栈由实现方自选，不绑定任何框架/工具')
  lines.push('- 动效/交互语义以 design/ 源文件为准（reference/ 截图对动画只是关键帧定格，看不出运动细节）')
  lines.push('- 实现完成后建议逐屏与 reference/ 截图比对，确认视觉还原度')
  lines.push('')
  return lines.join('\n')
}

function describeDesignFile(fileName: string): string {
  if (/\.dc\.html?$/i.test(fileName)) return '设计源文件（OpenPipal Design Component 格式）'
  if (fileName === 'support.js') return 'dc 运行时（冻结 ABI，无需改动，仅供读参考）'
  if (fileName.startsWith('vendor/')) return 'React 18 UMD 运行时依赖'
  if (fileName === 'deck-stage.js') return '幻灯片舞台预制件'
  if (fileName === 'animations.js') return '动画时间线引擎预制件'
  if (fileName === 'ios-frame.js') return 'iOS 设备外框预制件（动态岛/状态栏/Home Indicator）'
  if (fileName === 'android-frame.js') return 'Android 设备外框预制件（Material 3 状态栏/手势导航）'
  if (fileName === 'image-slot.js') return '可替换图片位预制件'
  if (fileName === 'doc-page.js') return '分页文档预制件'
  if (/\.compiled\.js$/i.test(fileName) || /\.jsx?$/i.test(fileName)) return '场景 sidecar（deck/animation 引用的额外场景文件）'
  return '随包依赖文件'
}

export interface TokensJsonPayload {
  title: string
  generatedAt: string
  colors: TokenColorEntry[]
  fonts: TokenTextEntry[]
  fontWeights: TokenTextEntry[]
  fontSizes: TokenTextEntry[]
}

export function buildTokensJsonPayload(title: string, generatedAt: string, tokens: TokensSummary): TokensJsonPayload {
  return {
    title,
    generatedAt,
    colors: tokens.colors,
    fonts: tokens.fontFamilies,
    fontWeights: tokens.fontWeights,
    fontSizes: tokens.fontSizes
  }
}

/** design_doc_mode=canvas 判定：与 support.js 内 DESIGN_DOC_MODE_RE 同一组正则，别让两处漂移。 */
export function isCanvasModeDc(content: string): boolean {
  return /<meta\b[^>]*\bname\s*=\s*["']design_doc_mode["'][^>]*\b(?:content|value)\s*=\s*["'](\w+)["']/i.exec(content)?.[1] === 'canvas'
}

/** 三类分类（纯函数面）：deck > animation > canvas(regex 预判，DOM 无 [data-screen-label] 时导出阶段仍会降级为 page) > page。 */
export function classifyDcType(content: string): HandoffDcType {
  if (looksLikeDeckDc(content)) return 'deck'
  if (looksLikeAnimationDc(content)) return 'animation'
  if (isCanvasModeDc(content)) return 'canvas'
  return 'page'
}

// ============================================================================
// 浏览器内执行的纯 JS 字符串（PAGE_TEXT_SUMMARY_JS 同款模式：注入隐藏窗口执行）
// ============================================================================

/** canvas/page 通用取景：优先 [data-screen-label]（逐 frame），否则整页一张。
 * 屏名兜底优先级：data-screen-label 属性 > 页内最大字号的标题类文本（h1/h2/h3 或任意元素取
 * computed font-size 最大者的文本）> 调用方兜底 screen-N（在 sanitizeScreenLabel 里做）。
 * 返回 { mode: 'frames'|'page', frames: [{label, x,y,width,height}], pageLabel }（page 模式下
 * frames 为空、pageLabel 是整页兜底标题猜测；尺寸由 Page.getLayoutMetrics 另取，不在这段 JS 里）。
 * 范围锁定 #dc-root（同 dc-text-summary.ts 的做法）。 */
const CANVAS_FRAMES_JS = `(function(){
  function biggestHeadingText(root) {
    var candidates = root.querySelectorAll('h1,h2,h3,h4,[style*="font-size"]');
    var best = null, bestSize = 0;
    for (var i = 0; i < candidates.length; i++) {
      var el = candidates[i];
      var text = (el.innerText !== undefined ? el.innerText : el.textContent || '').replace(/\\s+/g, ' ').trim();
      if (!text || text.length > 60) continue;
      var size = parseFloat(getComputedStyle(el).fontSize) || 0;
      if (size > bestSize) { bestSize = size; best = text; }
    }
    return best;
  }
  var dcRoot = document.getElementById('dc-root');
  var scopeRoot = dcRoot || document.body;
  if (!scopeRoot) return { mode: 'page', frames: [], pageLabel: null };
  var labeled = scopeRoot.querySelectorAll('[data-screen-label]');
  if (labeled.length > 0) {
    var frames = [];
    for (var i = 0; i < labeled.length && frames.length < 60; i++) {
      var el = labeled[i];
      var r = el.getBoundingClientRect();
      if (r.width < 2 || r.height < 2) continue;
      var label = el.getAttribute('data-screen-label') || biggestHeadingText(el);
      frames.push({ label: label, x: r.x, y: r.y, width: r.width, height: r.height });
    }
    return { mode: 'frames', frames: frames, pageLabel: null };
  }
  return { mode: 'page', frames: [], pageLabel: biggestHeadingText(scopeRoot) };
})()`

/** 设计 tokens 原始采样：只遍历可见元素（offsetParent 非 null 或 rect 面积>0），
 * 收集背景色/文字色/边框色/字体族/字重/字号的原始字符串计数——业务判断（rgb→hex/排序/封顶）
 * 留给调用方的纯 TS 函数（summarizeColorTallies/summarizeTextTallies），这里只做采集。
 * 各原始类目采样上限 300 个元素防止超大页面卡死，最终 token 表由调用方封顶 24 条。 */
const TOKENS_RAW_SAMPLE_JS = `(function(){
  var dcRoot = document.getElementById('dc-root');
  var scopeRoot = dcRoot || document.body;
  if (!scopeRoot) return { bg: [], fg: [], border: [], fontFamily: [], fontWeight: [], fontSize: [] };
  var all = scopeRoot.querySelectorAll('*');
  var bg = {}, fg = {}, border = {}, fontFamily = {}, fontWeight = {}, fontSize = {};
  function tally(map, key) { if (!key) return; map[key] = (map[key] || 0) + 1; }
  var n = 0;
  for (var i = 0; i < all.length && n < 300; i++) {
    var el = all[i];
    var rect = el.getBoundingClientRect();
    var visible = el.offsetParent !== null || (rect.width * rect.height) > 0;
    if (!visible) continue;
    n++;
    var cs = getComputedStyle(el);
    if (cs.backgroundColor && cs.backgroundColor !== 'rgba(0, 0, 0, 0)' && cs.backgroundColor !== 'transparent') tally(bg, cs.backgroundColor);
    if (cs.color) tally(fg, cs.color);
    if (cs.borderTopWidth && parseFloat(cs.borderTopWidth) > 0 && cs.borderTopColor) tally(border, cs.borderTopColor);
    if (cs.fontFamily) tally(fontFamily, cs.fontFamily.split(',')[0].replace(/["']/g, '').trim());
    if (cs.fontWeight) tally(fontWeight, cs.fontWeight);
    if (cs.fontSize) tally(fontSize, cs.fontSize);
  }
  function toList(map) { var out = []; for (var k in map) out.push({ value: k, count: map[k] }); return out; }
  return { bg: toList(bg), fg: toList(fg), border: toList(border), fontFamily: toList(fontFamily), fontWeight: toList(fontWeight), fontSize: toList(fontSize) };
})()`

// ============================================================================
// 编排（electron 依赖：隐藏窗口 + CDP，逐条 electron-vite build 校验，真机冒烟见验证报告）
// ============================================================================

export interface HandoffExportResult {
  ok: boolean
  path?: string
  error?: string
  screenshotCount?: number
  fileCount?: number
}

interface CapturedFrame {
  label: string | null
  tmpPngPath: string
  // deck 帧在"该页是 active 页"那一刻现取的文本（见 captureDeckStageFrames 内联注释：deck-stage
  // 用 visibility 隐藏非 active 页，事后统一跑一遍 PAGE_TEXT_SUMMARY_JS 只能拿到最后一页的文本）。
  // 有值就直接用，不再走 resolveTextSummary 的事后关联；animation/canvas/page 场景不填这个字段。
  text?: string
}

async function captureAnimationKeyframes(
  dbg: Electron.Debugger,
  frameDir: string,
  onProgress?: (done: number, total: number) => void
): Promise<{ frames: CapturedFrame[]; width: number; height: number; durationSec: number }> {
  await waitForCanvasReady(dbg, 8000)
  await evalChecked(dbg, `new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))`, { awaitPromise: true })
  await waitForFontsInlined(dbg, 3000)

  const domSize = await readDomStageSize(dbg)
  if (!domSize) throw new Error(tMain('artifacts.shell.export.errors.stageSizeUnreadable'))
  const { width, height } = domSize
  const durationSec = (await readDomDurationSec(dbg)) ?? 15

  await setViewport(dbg, width, height)
  const settle = await waitForAutofitSettled(dbg, width, height, 3000)
  if (!settle.settled) {
    throw new Error(tMain('artifacts.shell.export.errors.resolutionMismatch', { expected: `${width}x${height}`, actual: `${Math.round(settle.rect.width)}x${Math.round(settle.rect.height)}`, env: settle.env }))
  }
  const clip = clipFromRect(settle.rect)
  if (clip.width < 2 || clip.height < 2) throw new Error(tMain('artifacts.shell.export.errors.canvasClipInvalid', { detail: JSON.stringify(settle.rect) }))

  const SAMPLE_COUNT = 6
  const frames: CapturedFrame[] = []
  for (let i = 0; i < SAMPLE_COUNT; i++) {
    const t = ((durationSec * i) / (SAMPLE_COUNT - 1)).toFixed(6)
    await evalChecked(
      dbg,
      `(() => new Promise((resolve, reject) => {
        try {
          const el = ${CANVAS_SELECTOR};
          if (!el) { reject(new Error('canvas missing')); return; }
          el.dispatchEvent(new CustomEvent('openpipal:seek-to-time', { detail: { time: ${t} } }));
          requestAnimationFrame(() => requestAnimationFrame(() => resolve(true)));
        } catch (e) { reject(e); }
      }))()`,
      { awaitPromise: true }
    )
    const shot: any = await dbg.sendCommand('Page.captureScreenshot', {
      format: 'png',
      clip: { ...clip, scale: 1 },
      optimizeForSpeed: true
    })
    const pngPath = path.join(frameDir, `frame${String(i + 1).padStart(3, '0')}.png`)
    fs.writeFileSync(pngPath, Buffer.from(shot.data, 'base64'))
    frames.push({ label: `t${Number(t).toFixed(1)}s`, tmpPngPath: pngPath })
    onProgress?.(i + 1, SAMPLE_COUNT)
  }
  return { frames, width, height, durationSec }
}

async function captureCanvasOrPage(
  dbg: Electron.Debugger,
  frameDir: string,
  onProgress?: (done: number, total: number) => void
): Promise<{ frames: CapturedFrame[]; width: number; height: number; isCanvas: boolean }> {
  await hideScrollbarsAndOverflow(dbg)
  // 基线视口 1920x1200——对齐仓库里 deck/hero 设计画布的默认约定尺寸（1920x1080 起步，留
  // 120px 余量）。canvas/page 场景不存在自适应缩放，正常溢出内容靠 captureBeyondViewport 兜住；
  // 但固定尺寸画布 + body overflow:hidden（常见"居中裁切预览"写法）时，超出画布本身不会体现在
  // scrollWidth/Height 里（overflow:hidden 阻断了向上传播的滚动测量，不是只隐藏滚动条那么简单）
  // ——这种写法下唯一可靠的兜底是基线视口本身要够大，真机验证过 1920x1080 固定画布配这个基线
  // 视口能完整截全（见 dc-capture.ts getLayoutContentSize/getDocumentScrollSize 注释）。
  await setDeviceMetricsOverride(dbg, 1920, 1200, 2)
  await evalChecked(dbg, `new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))`, { awaitPromise: true })

  const result = await evalChecked(dbg, CANVAS_FRAMES_JS)
  const frames: CapturedFrame[] = []

  if (result?.mode === 'frames' && Array.isArray(result.frames) && result.frames.length) {
    const raw = result.frames as Array<{ label: string | null; x: number; y: number; width: number; height: number }>
    for (let i = 0; i < raw.length; i++) {
      const clip = clipFromRect(raw[i])
      if (clip.width < 2 || clip.height < 2) continue
      const shot: any = await dbg.sendCommand('Page.captureScreenshot', {
        format: 'png',
        clip: { ...clip, scale: 1 },
        captureBeyondViewport: true,
        optimizeForSpeed: true
      })
      const pngPath = path.join(frameDir, `frame${String(i + 1).padStart(3, '0')}.png`)
      fs.writeFileSync(pngPath, Buffer.from(shot.data, 'base64'))
      frames.push({ label: raw[i].label, tmpPngPath: pngPath })
      onProgress?.(i + 1, raw.length)
    }
    // 画板整体尺寸仍用 DOM 真值（layout content size）供 HANDOFF.md 概要展示
    const size = await getLayoutContentSize(dbg)
    return { frames, width: size.width, height: size.height, isCanvas: true }
  }

  // 两种测量取较大值：cssContentSize 在普通页面可靠，但 body overflow:hidden（dc 单屏设计
  // 常见写法）会让它恒等于视口尺寸；scrollWidth/Height 不受 overflow:hidden 影响，两者取大
  // 兜住任一方法的盲区（见 dc-capture.ts getLayoutContentSize/getDocumentScrollSize 注释）。
  const [layoutSize, scrollSize] = await Promise.all([getLayoutContentSize(dbg), getDocumentScrollSize(dbg)])
  const size = {
    width: Math.max(layoutSize.width, scrollSize.width),
    height: Math.max(layoutSize.height, scrollSize.height)
  }
  if (size.width < 2 || size.height < 2) throw new Error(tMain('artifacts.shell.export.errors.pageSizeUnreadable'))
  const shot: any = await dbg.sendCommand('Page.captureScreenshot', {
    format: 'png',
    clip: { x: 0, y: 0, width: size.width, height: size.height, scale: 1 },
    captureBeyondViewport: true,
    optimizeForSpeed: true
  })
  const pngPath = path.join(frameDir, `frame001.png`)
  fs.writeFileSync(pngPath, Buffer.from(shot.data, 'base64'))
  frames.push({ label: (result?.pageLabel as string | null | undefined) ?? null, tmpPngPath: pngPath })
  onProgress?.(1, 1)
  return { frames, width: size.width, height: size.height, isCanvas: false }
}

/** design/ 文件夹装配：主 dc 文件 + support.js/vendor + 场景 sidecar，复用 dc-export.ts 的
 * prepareDcForExport（sibling 收集/改写逻辑）与 dcRuntimeDir（runtime 定位），不重复造轮子。 */
function writeDesignFolder(designDir: string, title: string, content: string, sourceDir?: string): string[] {
  fs.mkdirSync(path.join(designDir, 'vendor'), { recursive: true })
  const runtime = dcRuntimeDir()
  fs.copyFileSync(path.join(runtime, 'support.js'), path.join(designDir, 'support.js'))
  for (const f of ['react.production.min.js', 'react-dom.production.min.js']) {
    fs.copyFileSync(path.join(runtime, 'vendor', f), path.join(designDir, 'vendor', f))
  }
  const files = ['support.js', 'vendor/react.production.min.js', 'vendor/react-dom.production.min.js']

  const base = sanitizeName(title).replace(/\.html?$/i, '')
  const dcFileName = /\.dc\.html?$/i.test(base) ? base : `${base}.dc.html`
  const prepared = prepareDcForExport(content)
  let html = prepared.html

  const siblingPaths: string[] = []
  for (const s of prepared.siblings) {
    const src = s.isResource ? path.join(runtime, s.copyFrom) : s.copyFrom
    siblingPaths.push(src)
    try {
      fs.copyFileSync(src, path.join(designDir, s.targetName))
      files.push(s.targetName)
    } catch (err: any) {
      console.warn('[dc-handoff-export] 预制件拷贝失败:', s.targetName, err?.message)
    }
  }

  // 产物 sidecar（image-slot 拖进去的图）随交接包走：与 html 同层落一份（服务式打开走文档相对
  // fetch）+ 内联一份（zip 解开后 file:// 双击也含图）。基名字面量只住在组件源码里，扫描范围
  // 必须覆盖兄弟预制件源码——只扫 content 恒为空。
  if (sourceDir) {
    const scData = readSidecarFiles(
      sourceDir,
      collectSidecarNames(content, ...siblingPaths.map((p) => {
        try { return fs.readFileSync(p, 'utf8') } catch { return '' }
      }))
    )
    for (const scName of Object.keys(scData)) {
      try {
        fs.writeFileSync(path.join(designDir, scName), scData[scName], 'utf8')
        files.push(scName)
      } catch (err: any) {
        console.warn('[dc-handoff-export] sidecar 拷贝失败:', scName, err?.message)
      }
    }
    html = injectSidecarData(html, scData)
  }

  fs.writeFileSync(path.join(designDir, dcFileName), html, 'utf8')
  files.push(dcFileName)
  return files
}

/** 关联截图 label 与 PAGE_TEXT_SUMMARY_JS 抽取的逐屏文本：优先按 label 精确匹配；
 *  只有一条摘要（fallback 兜底态，label=null）时对所有截图复用同一段文本（如动画关键帧场景）。 */
function resolveTextSummary(
  label: string | null,
  summaryFrames: Array<{ label: string | null; text: string }>
): string {
  if (!summaryFrames.length) return ''
  if (label) {
    const hit = summaryFrames.find((f) => f.label === label)
    if (hit) return hit.text
    // deck-stage 的 data-screen-label 带 "01 " 编号前缀，摘要里也是原样——按去前缀后的名字再匹配一次
    const stripped = label.replace(/^\d+\s+/, '')
    const hit2 = summaryFrames.find((f) => (f.label || '').replace(/^\d+\s+/, '') === stripped)
    if (hit2) return hit2.text
  }
  if (summaryFrames.length === 1) return summaryFrames[0].text
  return ''
}

export async function exportArtifactHandoff(
  title: string,
  content: string,
  artifactId: string | undefined,
  targetDir?: string,
  onProgress?: (done: number, total: number) => void
): Promise<HandoffExportResult> {
  const { app, BrowserWindow } = require('electron')
  if (!BrowserWindow) return { ok: false, ...mainError('artifacts.shell.export.errors.noBrowserWindow') }

  let html: string
  try {
    html = assembleOfflineDc(content, artifactId)
  } catch (err: any) {
    return { ok: false, ...mainError('artifacts.shell.export.errors.assembleFailed', { detail: err?.message || String(err) }) }
  }

  const dcType = classifyDcType(content)
  const safeTitle = sanitizeName(title).replace(/\.dc\.html?$/i, '').replace(/\.html?$/i, '') || 'design'
  const tmpRoot = path.join(app.getPath('temp'), `openpipal-handoff-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
  const frameDir = path.join(tmpRoot, 'frames')
  const stageDir = path.join(tmpRoot, `handoff-${safeTitle}`)
  const referenceDir = path.join(stageDir, 'reference')
  const designDir = path.join(stageDir, 'design')
  fs.mkdirSync(frameDir, { recursive: true })
  fs.mkdirSync(referenceDir, { recursive: true })
  fs.mkdirSync(designDir, { recursive: true })

  let win: Electron.BrowserWindow | null = null
  let width = 0
  let height = 0
  let pageCount: number | undefined
  let durationSec: number | undefined
  let finalDcType: HandoffDcType = dcType
  let rawFrames: CapturedFrame[] = []
  let tokens: TokensSummary = { colors: [], fontFamilies: [], fontWeights: [], fontSizes: [] }
  let summaryFrames: Array<{ label: string | null; text: string }> = []

  try {
    win = new BrowserWindow({
      show: false,
      useContentSize: true,
      width: 1920,
      height: 1080,
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false }
    })
    const w = win!
    await w.loadURL('data:text/html;base64,' + Buffer.from(html, 'utf8').toString('base64'))

    const dbg = w.webContents.debugger
    try {
      dbg.attach('1.3')
    } catch (err: any) {
      return { ok: false, ...mainError('artifacts.shell.export.errors.cdpAttachFailed', { detail: err?.message || String(err) }) }
    }
    await dbg.sendCommand('Page.enable')

    if (dcType === 'deck') {
      const capture = await captureDeckStageFrames(dbg, frameDir, 'frame', onProgress)
      width = capture.width
      height = capture.height
      pageCount = capture.frames.length
      rawFrames = capture.frames.map((f) => ({ label: f.screenLabel, tmpPngPath: f.pngPath, text: f.text }))
    } else if (dcType === 'animation') {
      const capture = await captureAnimationKeyframes(dbg, frameDir, onProgress)
      width = capture.width
      height = capture.height
      durationSec = capture.durationSec
      rawFrames = capture.frames
    } else {
      const ready = await pollUntil(dbg, `!!document.getElementById('dc-root')`, 8000)
      if (!ready) throw new Error(tMain('artifacts.shell.export.errors.dcRootMissing'))
      const capture = await captureCanvasOrPage(dbg, frameDir, onProgress)
      width = capture.width
      height = capture.height
      finalDcType = capture.isCanvas ? 'canvas' : 'page'
      rawFrames = capture.frames
    }

    // 页面文本摘要（一次性，与逐屏截图解耦）：deck/canvas 场景所有屏的 data-screen-label 同时
    // 存在于 DOM（deck-stage 在 _collectSlides 时一次性给全部 slide 打标，不只当前 active 那页），
    // 静态页/动画走单条 fallback。
    const summary = await evalChecked(dbg, PAGE_TEXT_SUMMARY_JS).catch(() => null)
    if (summary && Array.isArray(summary.frames)) summaryFrames = summary.frames

    // 设计 tokens：DOM 遍历原始采样（浏览器内），业务判断（hex 转换/排序/封顶）在纯 TS 侧完成
    const rawTokens = await evalChecked(dbg, TOKENS_RAW_SAMPLE_JS).catch(() => null)
    if (rawTokens) {
      tokens = {
        colors: summarizeColorTallies([...(rawTokens.bg || []), ...(rawTokens.border || [])]),
        fontFamilies: summarizeTextTallies(rawTokens.fontFamily || []),
        fontWeights: summarizeTextTallies(rawTokens.fontWeight || []),
        fontSizes: summarizeTextTallies(rawTokens.fontSize || [])
      }
    }
  } catch (err: any) {
    console.error('[dc-handoff-export] 渲染异常', err)
    try {
      fs.rmSync(tmpRoot, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
    return { ok: false, ...mainError('artifacts.shell.export.errors.renderFailed', { detail: err?.message || String(err) }) }
  } finally {
    try {
      if (win && !win.isDestroyed() && win.webContents.debugger.isAttached()) win.webContents.debugger.detach()
    } catch {
      /* ignore */
    }
    try {
      win?.destroy()
    } catch {
      /* ignore */
    }
  }

  // 落 reference/：最终文件名 = 序号 + sanitize 后的屏名；同时装配 HANDOFF.md 需要的 screens 结构
  const screens: HandoffScreen[] = rawFrames.map((f, i) => {
    const index = i + 1
    const label = sanitizeScreenLabel(f.label, index)
    const fileName = buildScreenFileName(index, label)
    fs.copyFileSync(f.tmpPngPath, path.join(referenceDir, fileName))
    const textSummary = f.text !== undefined ? f.text : resolveTextSummary(f.label, summaryFrames)
    return { index, label, fileName, textSummary }
  })

  const designFiles = writeDesignFolder(designDir, title, content, artifactSourceDir(artifactId))

  const generatedAt = new Date().toISOString()
  const meta: HandoffMeta = {
    title,
    dcType: finalDcType,
    stageWidth: width,
    stageHeight: height,
    pageCount,
    durationSec,
    generatedAt,
    designFiles
  }
  fs.writeFileSync(path.join(stageDir, 'HANDOFF.md'), buildHandoffMd(meta, screens, tokens), 'utf8')
  fs.writeFileSync(
    path.join(stageDir, 'tokens.json'),
    JSON.stringify(buildTokensJsonPayload(title, generatedAt, tokens), null, 2),
    'utf8'
  )

  const outRoot = targetDir || OUTPUTS_ROOT
  fs.mkdirSync(outRoot, { recursive: true })
  const outPath = path.join(outRoot, `handoff-${safeTitle}.zip`)
  try {
    if (fs.existsSync(outPath)) fs.unlinkSync(outPath)
  } catch {
    /* ignore */
  }
  try {
    // cwd=stageDir 父目录，"handoff-<title>" 作为唯一参数——包内顶层就是这个文件夹（同
    // dc-export.ts exportZip 的分享打包语义），不引入新 npm 依赖。
    await execFileAsync('zip', ['-r', '-q', outPath, path.basename(stageDir)], {
      cwd: path.dirname(stageDir),
      maxBuffer: 64 * 1024 * 1024
    })
  } catch (err: any) {
    console.error('[dc-handoff-export] zip 打包异常', err)
    try {
      fs.rmSync(tmpRoot, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
    if (err?.code === 'ENOENT') return { ok: false, ...mainError('artifacts.shell.export.errors.zipCommandMissing') }
    return { ok: false, ...mainError('artifacts.shell.export.errors.packFailed', { detail: err?.message || String(err) }) }
  }

  const fileCount = 2 /* HANDOFF.md + tokens.json */ + designFiles.length + screens.length
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true })
  } catch {
    /* ignore */
  }

  return { ok: true, path: outPath, screenshotCount: screens.length, fileCount }
}

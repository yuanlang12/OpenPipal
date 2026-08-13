/**
 * export_artifact 纯函数面：格式门槛判断 + 校验文本格式化。
 *
 * 独立成文件（而不是留在 pi-tools.ts）是因为 pi-tools.ts 的顶层 import 链最终触达
 * electron `app` 单例（web-search.ts → env.ts 的 `app.isPackaged`），vitest node 环境下
 * 直接 import pi-tools.ts 会在模块加载阶段就抛错（同 todos-tool.test.ts 的既有结论）。
 * 这里零 electron 依赖，createExportArtifactTool 调用它，单测也直接 import 它。
 *
 * looksLikeAnimationDc 正则须与 pi-tools.ts 内的同名函数、ArtifactTab.tsx 顶部的同名函数
 * 保持同一组——三处任一改动都要同步，否则"能不能导出 mp4"和"侧栏是否显示 mp4 选项"会不一致。
 * looksLikeDeckDc 同理须与 ArtifactTab.tsx 顶部的同名函数保持同一组（pptx 只有这一处 UI 消费者，
 * 不像 looksLikeAnimationDc 还被 pi-tools.ts 的 create_artifact 动画门闩单独用一份，故只需两处同步）。
 */

export function looksLikeAnimationDc(c: string): boolean {
  return /from="[^"]*animations\.jsx/i.test(c) || /\b(useSprite|useTime)\s*\(/.test(c) || /\bfunction\s+Stage\s*\(/.test(c) || /<Beat[\s/>]/.test(c)
}

/** mp4 格式门槛：只有动画 dc 才能导出视频。返回 null=放行，否则是要回给模型的拒绝文案（不带"已拒绝："前缀，调用方拼）。 */
export function mp4FormatGateMessage(content: string): string | null {
  if (looksLikeAnimationDc(content)) return null
  return '该产物不是动画，无法导出视频；可选格式：pdf（文档/静态页打印）、standalone-html（离线自足单文件）、project-zip（打包分享）。'
}

/** deck（幻灯片舞台）DC 判定：与 ArtifactTab.tsx 顶部同名函数保持同一组正则，别让两处漂移。
 *  <x-import from="./deck-stage.js"> 是技能骨架的标准写法；<deck-stage> 字面量标签兜底手写场景。 */
export function looksLikeDeckDc(c: string): boolean {
  return /from="[^"]*deck-stage\.js/i.test(c) || /<deck-stage[\s>]/i.test(c)
}

/** pptx 格式门槛：只有 deck（幻灯片舞台）dc 才能导出 PPTX 截图版。返回 null=放行，否则是要回给
 *  模型的拒绝文案（不带"已拒绝："前缀，调用方拼）。 */
export function pptxFormatGateMessage(content: string): string | null {
  if (looksLikeDeckDc(content)) return null
  return '该产物不是幻灯片（deck-stage）舞台，无法导出 PPTX；可选格式：pdf（文档/静态页打印）、standalone-html（离线自足单文件）、project-zip（打包分享）。'
}

/** dc 产物判定：与 renderer dcRuntime.ts isDcHtml、dc-export.ts 的同款正则同一组，别让三处漂移。 */
export function isDcContent(c: string): boolean {
  return /<x-dc[\s>]/i.test(c)
}

/** handoff 格式门槛：三类 dc（deck / animation / 静态页与画布）都放行，只挡"根本不是 dc"的产物
 *  （markdown 笔记 / 普通代码片段等）——handoff 的 design/reference/tokens 结构假设内容是 dc。 */
export function handoffFormatGateMessage(content: string): string | null {
  if (isDcContent(content)) return null
  return '该产物不是 Design Component（dc），无法生成交接包；可选格式：pdf（文档/静态页打印）、standalone-html（离线自足单文件）。'
}

/** project-zip 格式门槛：装配（exportDcBundle）依赖 <x-dc> 结构，非 dc 产物（3D 物体、HTML 邮件等
 *  裸 HTML）会穿透到 dc-export.ts 的 <x-dc> 过滤，静默打出空包并误报"没有可导出的 Design Component"，
 *  需要在这一步先说清楚。返回 null=放行，否则是要回给模型的拒绝文案（不带"已拒绝："前缀，调用方拼）。 */
export function projectZipFormatGateMessage(content: string): string | null {
  if (isDcContent(content)) return null
  return '该产物不是 Design Component（dc），project-zip 只打包 dc 产物；可选格式：pdf（文档/静态页打印）、standalone-html（离线自足单文件）。'
}

function fmtBytes(b: number): string {
  if (b < 1024) return `${b}B`
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)}KB`
  return `${(b / (1024 * 1024)).toFixed(1)}MB`
}

/** 文件大小校验：异常小大概率是导出中途失败/空内容，标出来让模型判断要不要重试。 */
export function describeFileSize(sizeBytes: number, minBytes: number): { label: string; suspicious: boolean } {
  const suspicious = sizeBytes < minBytes
  const label = suspicious ? `${fmtBytes(sizeBytes)}（异常小，建议核查产物是否完整）` : fmtBytes(sizeBytes)
  return { label, suspicious }
}

export interface Mp4ProbeData {
  width: number
  height: number
  durationSec: number
  frames: number
}

/** mp4 校验文本：分辨率/时长/帧数/文件大小一次给全，模型据此判断这次导出对不对、要不要重试。 */
export function formatMp4ValidationText(absPath: string, probe: Mp4ProbeData, sizeBytes: number): string {
  // mp4 门槛比文档类更高——几 KB 的"视频"大概率是空画布/坏帧，10KB 内基本不可能是真实短片
  const { label } = describeFileSize(sizeBytes, 10 * 1024)
  return `已导出 mp4：${absPath}（${probe.width}x${probe.height}，${probe.durationSec.toFixed(1)}s，${probe.frames} 帧，${label}）`
}

export interface PptxProbeData {
  pageCount: number
  width: number
  height: number
}

/** pptx 校验文本：页数/分辨率/文件大小一次给全，模型据此判断这次导出对不对、要不要重试。 */
export function formatPptxValidationText(absPath: string, probe: PptxProbeData, sizeBytes: number): string {
  // pptx 门槛比文档类更高——每页至少一张全幅 PNG，几 KB 的"pptx"大概率是空画布/坏帧
  const { label } = describeFileSize(sizeBytes, 10 * 1024)
  return `已导出 pptx：${absPath}（${probe.pageCount} 页，${probe.width}x${probe.height}，${label}）`
}

export interface HandoffProbeData {
  screenshotCount: number
  fileCount: number
}

/** handoff 校验文本：截图数/文件数/包大小一次给全，模型据此判断这次交接包对不对、要不要重试。 */
export function formatHandoffValidationText(absPath: string, probe: HandoffProbeData, sizeBytes: number): string {
  // handoff 门槛比文档类更高——至少含 HANDOFF.md + 1 张截图 + tokens.json，几 KB 大概率是空包
  const { label } = describeFileSize(sizeBytes, 10 * 1024)
  return `已导出交接包：${absPath}（${probe.screenshotCount} 张截图，${probe.fileCount} 个文件，${label}）`
}

/**
 * 各格式的"异常小"阈值：pdf 空白页 printToPDF 就有 ~1KB（真机实测 1026B——动画壳误导出 pdf
 * 就是这个体量），门槛提到 5KB 才能把"空白 PDF"标出来；html/zip 内容自由度大，1KB 起判。
 */
const MIN_BYTES_BY_FORMAT: Record<string, number> = {
  pdf: 5 * 1024,
  'standalone-html': 1024,
  'project-zip': 1024
}

/** pdf / standalone-html / project-zip 共用：文件大小是唯一低成本的证据。 */
export function formatFileValidationText(formatLabel: string, absPath: string, sizeBytes: number): string {
  const { label } = describeFileSize(sizeBytes, MIN_BYTES_BY_FORMAT[formatLabel] ?? 1024)
  return `已导出 ${formatLabel}：${absPath}（${label}）`
}

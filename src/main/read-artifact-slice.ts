/**
 * read_artifact 纯函数面：行范围切片 + 截断规则 + 头部元信息/截断提示格式化。
 *
 * 独立成文件（而不是留在 pi-tools.ts）是因为 pi-tools.ts 的顶层 import 链最终触达
 * electron `app` 单例（web-search.ts → env.ts 的 `app.isPackaged`），vitest node 环境下
 * 直接 import pi-tools.ts 会在模块加载阶段就抛错（同 todos-tool.test.ts / export-artifact-validate.ts
 * 的既有结论）。这里零 electron 依赖，createReadArtifactTool 调用它，单测也直接 import 它。
 */

/** 无 offset/limit 时的默认最大返回行数。 */
export const READ_ARTIFACT_MAX_LINES = 800
/** 单次返回的硬字节上限（无论是否显式传了 offset/limit 都生效）。 */
export const READ_ARTIFACT_MAX_BYTES = 30 * 1024

export interface ArtifactSliceResult {
  /** 切出的原文片段，不带行号前缀——可直接摘取用作 edit_artifact 的 old_string。 */
  content: string
  /** 文件总行数。 */
  totalLines: number
  /** 本次返回的起始行号（1-based）。 */
  startLine: number
  /** 本次返回的结束行号（1-based，含）；未返回任何行时 = startLine - 1。 */
  endLine: number
  /** 是否发生了截断（未达到"应返回"的终点）——决定是否要在文本尾部追加续读提示。 */
  truncated: boolean
}

function byteLen(s: string): number {
  return Buffer.byteLength(s, 'utf8')
}

/**
 * 按 offset/limit 切出原文片段。
 * - 都不传：从头返回，默认上限 {@link READ_ARTIFACT_MAX_LINES} 行，同时受
 *   {@link READ_ARTIFACT_MAX_BYTES} 硬上限保护（先触发者先截断）。
 * - 显式传了 offset 和/或 limit：按给定值切片（offset 默认第 1 行，limit 默认到文件末尾），
 *   仍受 {@link READ_ARTIFACT_MAX_BYTES} 硬上限保护——只有这个字节上限会让"显式请求的范围"
 *   被进一步截短。
 */
export function sliceArtifactContent(content: string, offset?: number, limit?: number): ArtifactSliceResult {
  const lines = content.split('\n')
  const totalLines = lines.length
  const hasExplicitRange = offset != null || limit != null

  const startLine = Math.max(1, Math.floor(offset ?? 1))
  const startIdx = startLine - 1

  if (startIdx >= totalLines) {
    // offset 越界（超出总行数）：无内容可返回，不算"截断"（截断特指内容被砍短，越界是另一回事）。
    return { content: '', totalLines, startLine, endLine: startLine - 1, truncated: false }
  }

  const requestedEndIdx =
    limit != null
      ? Math.min(totalLines, startIdx + Math.max(0, Math.floor(limit)))
      : hasExplicitRange
        ? totalLines
        : Math.min(totalLines, startIdx + READ_ARTIFACT_MAX_LINES)

  let sliceLines = lines.slice(startIdx, requestedEndIdx)
  const requestedLineCount = sliceLines.length

  // 字节硬上限：逐行累加，超出即停——保证任何一次调用都不会超预算。
  if (byteLen(sliceLines.join('\n')) > READ_ARTIFACT_MAX_BYTES) {
    const acc: string[] = []
    for (const line of sliceLines) {
      const next = acc.length ? acc.concat(line) : [line]
      if (byteLen(next.join('\n')) > READ_ARTIFACT_MAX_BYTES) break
      acc.push(line)
    }
    sliceLines = acc
  }

  const returnedLines = sliceLines.length
  const endLine = returnedLines > 0 ? startLine + returnedLines - 1 : startLine - 1
  // 截断 = 字节上限进一步砍短了本该返回的范围，或（仅默认模式下）800 行上限提前截住了文件尾部。
  const cappedByBytes = returnedLines < requestedLineCount
  const cappedByDefaultLineLimit = !hasExplicitRange && requestedEndIdx < totalLines
  const truncated = cappedByBytes || cappedByDefaultLineLimit

  return { content: sliceLines.join('\n'), totalLines, startLine, endLine, truncated }
}

function fmtBytes(b: number): string {
  if (b < 1024) return `${b}B`
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)}KB`
  return `${(b / (1024 * 1024)).toFixed(1)}MB`
}

/** 头部元信息一行：标题 / 文件类型 / 总行数 / 字节大小。 */
export function formatArtifactReadHeader(title: string, fileType: string, totalLines: number, sizeBytes: number): string {
  return `${title} · ${fileType} · 共 ${totalLines} 行 · ${fmtBytes(sizeBytes)}`
}

/** 截断提示：追加在返回内容尾部，告知模型如何继续读取剩余部分。 */
export function formatArtifactTruncationNote(endLine: number, totalLines: number): string {
  return `\n\n（内容过长已截断至第 ${endLine} 行（共 ${totalLines} 行）——用 offset/limit 继续读取）`
}

/** offset 越界提示（没有可读内容时用，别与"截断"混淆）。 */
export function formatArtifactOffsetOutOfRangeNote(offset: number, totalLines: number): string {
  return `offset (${offset}) 超出总行数 ${totalLines}，没有可读内容——从头读或调小 offset 重试。`
}

/**
 * read_artifact 纯函数面（read-artifact-slice.ts）+ 三处登记契约。
 * execute 本体（fs.readFileSync + resolveArtifactId）依赖 pi-tools.ts 的 electron import 链，
 * node 环境不可直接 import（同 todos-tool.test.ts / export-artifact-validate.test.ts 的既有结论）。
 * 这里锁住可被单测覆盖的两个契约面：
 *   ① 切片纯函数逻辑（read-artifact-slice.ts）
 *   ② 三处登记：pi-tools.ts 工具定义（本测试文件不验证，见真机冒烟）/ role-manager COMMON_TOOLS /
 *      pi-security classifyToolRisk
 */
import { describe, it, expect } from 'vitest'
import {
  sliceArtifactContent,
  formatArtifactReadHeader,
  formatArtifactTruncationNote,
  formatArtifactOffsetOutOfRangeNote,
  READ_ARTIFACT_MAX_LINES,
  READ_ARTIFACT_MAX_BYTES
} from '../../src/main/read-artifact-slice'
import { classifyToolRisk } from '../../src/main/pi-security'
import { COMMON_TOOLS } from '../../src/main/role-manager'

function linesOf(n: number, prefix = 'line'): string {
  return Array.from({ length: n }, (_, i) => `${prefix}-${i + 1}`).join('\n')
}

describe('sliceArtifactContent（无 offset/limit —— 默认从头返回）', () => {
  it('短内容全量返回，不截断', () => {
    const content = linesOf(5)
    const r = sliceArtifactContent(content)
    expect(r.content).toBe(content)
    expect(r.totalLines).toBe(5)
    expect(r.startLine).toBe(1)
    expect(r.endLine).toBe(5)
    expect(r.truncated).toBe(false)
  })

  it('超过 800 行 → 截断至第 800 行，truncated=true', () => {
    const content = linesOf(1000)
    const r = sliceArtifactContent(content)
    expect(r.totalLines).toBe(1000)
    expect(r.startLine).toBe(1)
    expect(r.endLine).toBe(READ_ARTIFACT_MAX_LINES)
    expect(r.truncated).toBe(true)
    expect(r.content.split('\n')).toHaveLength(READ_ARTIFACT_MAX_LINES)
    expect(r.content.split('\n')[0]).toBe('line-1')
    expect(r.content.split('\n')[READ_ARTIFACT_MAX_LINES - 1]).toBe(`line-${READ_ARTIFACT_MAX_LINES}`)
  })

  it('恰好 800 行 → 不截断（边界：等于上限不算超限）', () => {
    const content = linesOf(READ_ARTIFACT_MAX_LINES)
    const r = sliceArtifactContent(content)
    expect(r.truncated).toBe(false)
    expect(r.endLine).toBe(READ_ARTIFACT_MAX_LINES)
  })

  it('行数不多但单行超长导致超过 30KB → 按字节截断', () => {
    const bigLine = 'x'.repeat(20 * 1024)
    const content = [bigLine, bigLine, bigLine].join('\n') // 3 行 * 20KB = 60KB > 30KB
    const r = sliceArtifactContent(content)
    expect(r.totalLines).toBe(3)
    expect(r.truncated).toBe(true)
    expect(Buffer.byteLength(r.content, 'utf8')).toBeLessThanOrEqual(READ_ARTIFACT_MAX_BYTES)
    // 第一行 20KB 能放下，第二行会让累计超 30KB → 只返回第 1 行
    expect(r.endLine).toBe(1)
  })

  it('空文件（totalLines=1 的空字符串）→ 返回空内容不截断', () => {
    const r = sliceArtifactContent('')
    expect(r.totalLines).toBe(1)
    expect(r.content).toBe('')
    expect(r.truncated).toBe(false)
  })
})

describe('sliceArtifactContent（显式 offset/limit —— 按传入值切片）', () => {
  it('只传 offset：从该行读到文件末尾', () => {
    const content = linesOf(10)
    const r = sliceArtifactContent(content, 6)
    expect(r.startLine).toBe(6)
    expect(r.endLine).toBe(10)
    expect(r.content).toBe(linesOf(10).split('\n').slice(5).join('\n'))
    expect(r.truncated).toBe(false)
  })

  it('只传 limit：从第 1 行开始读 limit 行', () => {
    const content = linesOf(10)
    const r = sliceArtifactContent(content, undefined, 3)
    expect(r.startLine).toBe(1)
    expect(r.endLine).toBe(3)
    expect(r.truncated).toBe(false)
  })

  it('offset+limit 都传：精确切片', () => {
    const content = linesOf(20)
    const r = sliceArtifactContent(content, 5, 4)
    expect(r.startLine).toBe(5)
    expect(r.endLine).toBe(8)
    expect(r.content).toBe(['line-5', 'line-6', 'line-7', 'line-8'].join('\n'))
    expect(r.truncated).toBe(false)
  })

  it('显式范围不受 800 行默认上限约束（超过 800 行也不算截断）', () => {
    const content = linesOf(2000)
    const r = sliceArtifactContent(content, 1, 1500)
    expect(r.endLine).toBe(1500)
    expect(r.content.split('\n')).toHaveLength(1500)
    // 30KB 字节上限会先触发（1500 行短行数不足以超 30KB，这里验证不受 800 行上限影响）
  })

  it('显式范围仍受 30KB 硬上限保护——请求范围超预算时被截短且标记 truncated', () => {
    const bigLine = 'y'.repeat(20 * 1024)
    const content = [bigLine, bigLine, bigLine, bigLine].join('\n')
    const r = sliceArtifactContent(content, 1, 4) // 显式请求全部 4 行，但字节会超
    expect(r.truncated).toBe(true)
    expect(Buffer.byteLength(r.content, 'utf8')).toBeLessThanOrEqual(READ_ARTIFACT_MAX_BYTES)
  })

  it('limit=0 → 返回空内容，不截断（用户明确要 0 行）', () => {
    const content = linesOf(5)
    const r = sliceArtifactContent(content, 1, 0)
    expect(r.content).toBe('')
    expect(r.truncated).toBe(false)
  })

  it('offset 超出总行数 → 空内容，不算截断（越界不是截断）', () => {
    const content = linesOf(5)
    const r = sliceArtifactContent(content, 100)
    expect(r.content).toBe('')
    expect(r.totalLines).toBe(5)
    expect(r.truncated).toBe(false)
    expect(r.startLine).toBe(100)
    expect(r.endLine).toBe(99)
  })
})

describe('格式化辅助函数', () => {
  it('formatArtifactReadHeader 拼出「标题 · 类型 · 共N行 · 大小」', () => {
    const h = formatArtifactReadHeader('落地页设计.dc.html', 'html', 240, 12345)
    expect(h).toBe('落地页设计.dc.html · html · 共 240 行 · 12.1KB')
  })

  it('formatArtifactTruncationNote 含续读提示文案', () => {
    const note = formatArtifactTruncationNote(800, 1200)
    expect(note).toContain('内容过长已截断至第 800 行（共 1200 行）')
    expect(note).toContain('offset/limit 继续读取')
  })

  it('formatArtifactOffsetOutOfRangeNote 含越界说明', () => {
    const note = formatArtifactOffsetOutOfRangeNote(100, 5)
    expect(note).toContain('100')
    expect(note).toContain('5')
  })
})

describe('三处登记：role-manager / pi-security', () => {
  it('② COMMON_TOOLS 白名单含 read_artifact（否则 AI 收不到工具 schema）', () => {
    expect(COMMON_TOOLS).toContain('read_artifact')
  })

  it('③ classifyToolRisk(read_artifact) → safe（只读工具，不弹确认）', () => {
    const r = classifyToolRisk('read_artifact', { id: 'artifact-123' })
    expect(r.level).toBe('safe')
  })
})

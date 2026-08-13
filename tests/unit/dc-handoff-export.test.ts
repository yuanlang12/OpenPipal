/**
 * Handoff to Code Agent 交接包导出 —— 纯函数面单测（dc-handoff-export.ts）。
 * 电子（BrowserWindow/CDP）依赖的编排本体（exportArtifactHandoff）不在此覆盖——同
 * export-artifact-validate.test.ts 顶部注释的既有结论，electron 依赖走真机冒烟验证。
 * 这里锁住：屏名/文件名 sanitize、tokens 归并排序封顶、rgb→hex、dc 类型分类、
 * HANDOFF.md / tokens.json 的确定性渲染。
 */
import { describe, it, expect } from 'vitest'
import {
  sanitizeScreenLabel,
  filenameSafe,
  buildScreenFileName,
  capAndSortTally,
  rgbStringToHex,
  summarizeColorTallies,
  summarizeTextTallies,
  isCanvasModeDc,
  classifyDcType,
  buildHandoffMd,
  buildTokensJsonPayload,
  type HandoffMeta,
  type HandoffScreen,
  type TokensSummary
} from '../../src/main/dc-handoff-export'

describe('sanitizeScreenLabel（屏名 sanitize）', () => {
  it('去掉 deck-stage 自动编号前缀 "01 "', () => {
    expect(sanitizeScreenLabel('01 Title', 1)).toBe('Title')
    expect(sanitizeScreenLabel('12 Agenda Slide', 12)).toBe('Agenda Slide')
  })

  it('canvas 手写标签原样保留（无数字前缀可去）', () => {
    expect(sanitizeScreenLabel('Direction A', 1)).toBe('Direction A')
  })

  it('空/null → 兜底 screen-N', () => {
    expect(sanitizeScreenLabel(null, 3)).toBe('screen-3')
    expect(sanitizeScreenLabel('', 5)).toBe('screen-5')
    expect(sanitizeScreenLabel('   ', 7)).toBe('screen-7')
  })

  it('压缩内部多余空白', () => {
    expect(sanitizeScreenLabel('Title   With   Spaces', 1)).toBe('Title With Spaces')
  })
})

describe('filenameSafe / buildScreenFileName（文件名安全化）', () => {
  it('非法字符替换为 -，压缩连续 -', () => {
    expect(filenameSafe('a/b:c*d?e')).toBe('a-b-c-d-e')
  })

  it('空格转 -', () => {
    expect(filenameSafe('Direction A')).toBe('Direction-A')
  })

  it('超长文件名封顶 48 字符', () => {
    const long = 'x'.repeat(100)
    expect(filenameSafe(long).length).toBeLessThanOrEqual(48)
  })

  it('空字符串兜底 screen', () => {
    expect(filenameSafe('')).toBe('screen')
  })

  it('buildScreenFileName 格式：两位序号-label.png', () => {
    expect(buildScreenFileName(1, 'Title')).toBe('01-Title.png')
    expect(buildScreenFileName(12, 'Direction A')).toBe('12-Direction-A.png')
  })
})

describe('capAndSortTally（计数排序封顶）', () => {
  it('按 count 降序排序', () => {
    const out = capAndSortTally([
      { value: 'a', count: 1 },
      { value: 'b', count: 5 },
      { value: 'c', count: 3 }
    ])
    expect(out.map((e) => e.value)).toEqual(['b', 'c', 'a'])
  })

  it('封顶 limit 条（默认 24）', () => {
    const entries = Array.from({ length: 30 }, (_, i) => ({ value: `v${i}`, count: i }))
    expect(capAndSortTally(entries).length).toBe(24)
    expect(capAndSortTally(entries, 5).length).toBe(5)
  })
})

describe('rgbStringToHex（颜色转换）', () => {
  it('rgb() 转 #rrggbb', () => {
    expect(rgbStringToHex('rgb(255, 0, 0)')).toBe('#ff0000')
    expect(rgbStringToHex('rgb(0, 128, 255)')).toBe('#0080ff')
  })

  it('rgba() 带 alpha>0 正常转换', () => {
    expect(rgbStringToHex('rgba(20, 30, 40, 0.5)')).toBe('#141e28')
  })

  it('alpha=0（全透明）→ null（不算颜色 token）', () => {
    expect(rgbStringToHex('rgba(0, 0, 0, 0)')).toBeNull()
  })

  it('非法格式 → null', () => {
    expect(rgbStringToHex('transparent')).toBeNull()
    expect(rgbStringToHex('not-a-color')).toBeNull()
    expect(rgbStringToHex('')).toBeNull()
  })
})

describe('summarizeColorTallies（颜色归并排序封顶）', () => {
  it('不同来源但同 hex 的计数合并', () => {
    const out = summarizeColorTallies([
      { value: 'rgb(255, 0, 0)', count: 3 },
      { value: 'rgb(255, 0, 0)', count: 2 },
      { value: 'rgb(0, 0, 0)', count: 1 }
    ])
    expect(out[0]).toEqual({ hex: '#ff0000', count: 5 })
    expect(out[1]).toEqual({ hex: '#000000', count: 1 })
  })

  it('透明色被过滤，不进结果', () => {
    const out = summarizeColorTallies([
      { value: 'rgba(0, 0, 0, 0)', count: 10 },
      { value: 'rgb(1, 2, 3)', count: 1 }
    ])
    expect(out.length).toBe(1)
    expect(out[0].hex).toBe('#010203')
  })

  it('封顶 24 条', () => {
    const raw = Array.from({ length: 30 }, (_, i) => ({ value: `rgb(${i}, ${i}, ${i})`, count: 1 }))
    expect(summarizeColorTallies(raw).length).toBe(24)
  })
})

describe('summarizeTextTallies（字体/字重/字号归并）', () => {
  it('按 count 排序并转换字段名（value/count）', () => {
    const out = summarizeTextTallies([
      { value: 'Inter', count: 2 },
      { value: 'Work Sans', count: 8 }
    ])
    expect(out[0]).toEqual({ value: 'Work Sans', count: 8 })
    expect(out[1]).toEqual({ value: 'Inter', count: 2 })
  })
})

describe('isCanvasModeDc（design_doc_mode=canvas 判定）', () => {
  it('含 design_doc_mode=canvas meta → true', () => {
    expect(isCanvasModeDc('<helmet><meta name="design_doc_mode" content="canvas"></helmet>')).toBe(true)
  })

  it('无该 meta → false', () => {
    expect(isCanvasModeDc('<helmet><style>body{margin:0}</style></helmet>')).toBe(false)
  })

  it('content 值不是 canvas → false', () => {
    expect(isCanvasModeDc('<meta name="design_doc_mode" content="print">')).toBe(false)
  })
})

describe('classifyDcType（三类分类优先级 deck > animation > canvas > page）', () => {
  it('deck-stage 引用 → deck', () => {
    expect(classifyDcType('<x-import from="./deck-stage.js"></x-import>')).toBe('deck')
  })

  it('animations.jsx 引用 → animation', () => {
    expect(classifyDcType('<x-import from="./animations.jsx"></x-import>')).toBe('animation')
  })

  it('design_doc_mode=canvas（非 deck/animation）→ canvas', () => {
    expect(classifyDcType('<meta name="design_doc_mode" content="canvas">')).toBe('canvas')
  })

  it('普通静态内容 → page', () => {
    expect(classifyDcType('<x-dc><div>hello</div></x-dc>')).toBe('page')
  })

  it('deck 优先于 canvas（deck 内容即使意外带 canvas meta 也按 deck 走）', () => {
    const c = '<meta name="design_doc_mode" content="canvas"><x-import from="./deck-stage.js"></x-import>'
    expect(classifyDcType(c)).toBe('deck')
  })
})

describe('buildHandoffMd（确定性 Markdown 渲染）', () => {
  const tokens: TokensSummary = {
    colors: [{ hex: '#111111', count: 10 }],
    fontFamilies: [{ value: 'Work Sans', count: 5 }],
    fontWeights: [{ value: '600', count: 3 }],
    fontSizes: [{ value: '16px', count: 8 }]
  }
  const screens: HandoffScreen[] = [
    { index: 1, label: 'Title', fileName: '01-Title.png', textSummary: 'Hello World' },
    { index: 2, label: 'Agenda', fileName: '02-Agenda.png', textSummary: 'Item 1, Item 2' }
  ]
  const meta: HandoffMeta = {
    title: 'My Deck',
    dcType: 'deck',
    stageWidth: 1920,
    stageHeight: 1080,
    pageCount: 2,
    generatedAt: '2026-07-09T00:00:00.000Z',
    designFiles: ['My Deck.dc.html', 'support.js', 'vendor/react.production.min.js']
  }

  it('概要含标题/类型/尺寸/页数/生成时间', () => {
    const md = buildHandoffMd(meta, screens, tokens)
    expect(md).toContain('My Deck')
    expect(md).toContain('1920 x 1080')
    expect(md).toContain('页数：2')
    expect(md).toContain('2026-07-09T00:00:00.000Z')
  })

  it('逐屏结构含每屏截图相对路径 + 文本摘要', () => {
    const md = buildHandoffMd(meta, screens, tokens)
    expect(md).toContain('reference/01-Title.png')
    expect(md).toContain('reference/02-Agenda.png')
    expect(md).toContain('Hello World')
    expect(md).toContain('Item 1, Item 2')
  })

  it('设计 tokens 表含颜色/字体/字重/字号', () => {
    const md = buildHandoffMd(meta, screens, tokens)
    expect(md).toContain('#111111')
    expect(md).toContain('Work Sans')
    expect(md).toContain('600')
    expect(md).toContain('16px')
  })

  it('源文件导读逐条列出 designFiles 且相对路径以 design/ 开头', () => {
    const md = buildHandoffMd(meta, screens, tokens)
    expect(md).toContain('design/My Deck.dc.html')
    expect(md).toContain('design/support.js')
  })

  it('含实现指引固定文案（截图是视觉权威 / 技术栈自选）', () => {
    const md = buildHandoffMd(meta, screens, tokens)
    expect(md).toContain('视觉权威')
    expect(md).toContain('技术栈由实现方自选')
  })

  it('animation 类型显示时长而非页数', () => {
    const animMeta: HandoffMeta = { ...meta, dcType: 'animation', pageCount: undefined, durationSec: 48 }
    const md = buildHandoffMd(animMeta, screens, tokens)
    expect(md).toContain('时长：48.0s')
    expect(md).not.toContain('页数：')
  })

  it('空 screens 时给出兜底提示而不是空白', () => {
    const md = buildHandoffMd(meta, [], tokens)
    expect(md).toContain('design/ 源文件')
  })
})

describe('buildTokensJsonPayload（tokens.json 结构）', () => {
  it('字段齐全且与传入 tokens 一一对应', () => {
    const tokens: TokensSummary = {
      colors: [{ hex: '#abcdef', count: 2 }],
      fontFamilies: [{ value: 'Manrope', count: 1 }],
      fontWeights: [{ value: '400', count: 4 }],
      fontSizes: [{ value: '14px', count: 6 }]
    }
    const payload = buildTokensJsonPayload('Demo', '2026-07-09T00:00:00.000Z', tokens)
    expect(payload.title).toBe('Demo')
    expect(payload.generatedAt).toBe('2026-07-09T00:00:00.000Z')
    expect(payload.colors).toEqual(tokens.colors)
    expect(payload.fonts).toEqual(tokens.fontFamilies)
    expect(payload.fontWeights).toEqual(tokens.fontWeights)
    expect(payload.fontSizes).toEqual(tokens.fontSizes)
    // JSON 可序列化性
    expect(() => JSON.stringify(payload)).not.toThrow()
  })
})

/**
 * questions_v2 execute 阶段的坏形状规范化（弱模型把问题元素发成纯字符串 / 缺字段对象）。
 *
 * 背景：Pi 框架按 TypeBox schema 在 execute 之前做校验——旧 schema 要求每个问题元素必须是
 * 带 id/kind/title 的对象，弱模型发纯字符串会被框架直接拒绝（"questions.0: must be object"），
 * execute 里原有的兜底代码根本收不到参数。修复：schema 放宽为 Union<对象|字符串> 且对象字段
 * 全 Optional，execute 里用 normalizeQuestionsV2Items 补齐语义默认值。
 *
 * 纯函数、无副作用，验证不依赖 Pi 框架 / Electron。
 */
import { describe, it, expect } from 'vitest'
import { normalizeQuestionsPanelTitle, normalizeQuestionsV2Items } from '../../src/main/pi-event-adapter'
import { questionsPreviewImageUrl } from '../../src/shared/safe-svg'

describe('normalizeQuestionsPanelTitle', () => {
  it('uses an empty marker only for missing/blank defaults and preserves explicit model bytes', () => {
    expect(normalizeQuestionsPanelTitle(undefined)).toBe('')
    expect(normalizeQuestionsPanelTitle('   ')).toBe('')
    expect(normalizeQuestionsPanelTitle('  用户标题  ')).toBe('  用户标题  ')
  })
})

describe('normalizeQuestionsV2Items', () => {
  it('字符串元素被规范化为默认 text-options 结构', () => {
    const result = normalizeQuestionsV2Items(['喜欢暖色还是冷色？', '需要圆角还是直角？'])
    expect(result).toHaveLength(2)
    expect(result[0]).toMatchObject({ kind: 'text-options', title: '喜欢暖色还是冷色？', options: ['是', '否'] })
    expect(result[1]).toMatchObject({ kind: 'text-options', title: '需要圆角还是直角？', options: ['是', '否'] })
    // id 自动生成且不冲突
    expect(result[0].id).not.toBe(result[1].id)
  })

  it('数组被模型序列化成唯一字符串元素时会还原成真实问题', () => {
    const serialized = JSON.stringify([
      { id: 'keep', kind: 'text-options', title: '这条做法代表你吗？', options: ['代表', '不代表'] },
      { id: 'note', kind: 'freeform', title: '需要怎样修改？' }
    ])
    const result = normalizeQuestionsV2Items([serialized])
    expect(result).toHaveLength(2)
    expect(result[0]).toMatchObject({ id: 'keep', title: '这条做法代表你吗？', options: ['代表', '不代表'] })
    expect(result[1]).toMatchObject({ id: 'note', kind: 'freeform', title: '需要怎样修改？' })
  })

  it('损坏的 JSON 数组字符串不会原样暴露给用户', () => {
    const broken = '[{"id":"q1","title":"请写"没有""}]'
    const result = normalizeQuestionsV2Items([broken])
    expect(result).toHaveLength(1)
    expect(result[0].title).toBe('这份分析是否准确表达了你的想法？')
    expect(result[0].title).not.toContain('[{')
    expect(result[0].options).toEqual(['准确，可以继续', '大体对，我想修改', '不准确，请重新分析'])
  })

  it('对象元素缺 id/kind/title/options 时补默认值，已有字段保留', () => {
    const result = normalizeQuestionsV2Items([
      { title: '主色偏好' }, // 缺 id/kind/options
      { id: 'q_custom', kind: 'slider', title: '圆角大小', min: 0, max: 24 } // slider 不需要 options
    ])
    expect(result).toHaveLength(2)
    expect(result[0]).toMatchObject({ kind: 'text-options', title: '主色偏好', options: ['是', '否'] })
    expect(typeof result[0].id).toBe('string')
    // 已有合法字段的对象原样保留，不被覆盖
    expect(result[1]).toMatchObject({ id: 'q_custom', kind: 'slider', title: '圆角大小', min: 0, max: 24 })
    expect(result[1].options).toBeUndefined()
  })

  it('全废输入（空字符串/非法元素）被丢弃，返回空数组供调用方报清晰错误', () => {
    expect(normalizeQuestionsV2Items([])).toEqual([])
    expect(normalizeQuestionsV2Items(['', '   '])).toEqual([])
    expect(normalizeQuestionsV2Items([null, 42, true, []])).toEqual([])
  })

  it('混合坏形状（字符串+对象+垃圾）里能规范化的元素被保留', () => {
    const result = normalizeQuestionsV2Items(['纯字符串问题', { title: '对象问题' }, null, 123])
    expect(result).toHaveLength(2)
    expect(result.map(q => q.title)).toEqual(['纯字符串问题', '对象问题'])
  })

  // ---- options 叶子元素收敛（弱模型把选项发成 {label,value} 对象，React #31 崩溃复现同形状）----

  it('text-options 的 {label,value} 对象元素被收敛为 label 字符串', () => {
    const result = normalizeQuestionsV2Items([
      { kind: 'text-options', title: '选颜色', options: [{ label: 'A', value: 'a' }, { label: 'B', value: 'b' }] }
    ])
    expect(result).toHaveLength(1)
    expect(result[0].options).toEqual(['A', 'B'])
    for (const opt of result[0].options) expect(typeof opt).toBe('string')
  })

  it('text-options 只有 value 没有 label 的对象元素取 value', () => {
    const result = normalizeQuestionsV2Items([
      { kind: 'text-options', title: '选颜色', options: [{ value: 'only-value' }] }
    ])
    expect(result[0].options).toEqual(['only-value'])
  })

  it('text-options 混合字符串+对象元素都被收敛为字符串', () => {
    const result = normalizeQuestionsV2Items([
      { kind: 'text-options', title: '混合', options: ['纯字符串', { label: '对象选项' }, { value: 'v2' }] }
    ])
    expect(result[0].options).toEqual(['纯字符串', '对象选项', 'v2'])
  })

  it('text-options 全部选项无效时回落是/否', () => {
    const result = normalizeQuestionsV2Items([
      { kind: 'text-options', title: '全废', options: [{}, null, ''] }
    ])
    expect(result[0].options).toEqual(['是', '否'])
  })

  it('text-options 的 number 元素被字符串化', () => {
    const result = normalizeQuestionsV2Items([
      { kind: 'text-options', title: '数字选项', options: [1, 2, 3] }
    ])
    expect(result[0].options).toEqual(['1', '2', '3'])
  })

  it('multi-chip 的 {label,value} 对象元素同样被收敛为字符串', () => {
    const result = normalizeQuestionsV2Items([
      { kind: 'multi-chip', title: '多选', options: [{ label: 'X', value: 'x' }, 'Y'] }
    ])
    expect(result[0].options).toEqual(['X', 'Y'])
  })

  it('svg-options 的字符串元素被包装成 {value,label} 对象', () => {
    const result = normalizeQuestionsV2Items([
      { kind: 'svg-options', title: '选图标', options: ['icon-a', 'icon-b'] }
    ])
    expect(result[0].kind).toBe('svg-options')
    expect(result[0].options).toEqual([
      { value: 'icon-a', label: 'icon-a' },
      { value: 'icon-b', label: 'icon-b' }
    ])
  })

  it('svg-options 对象元素无 value 但有 label 时补 value=label', () => {
    const result = normalizeQuestionsV2Items([
      { kind: 'svg-options', title: '选图标', options: [{ label: '圆角', svg: '<svg><rect width="10" height="10"/></svg>' }] }
    ])
    expect(result[0].options).toEqual([{
      label: '圆角',
      svg: '<svg xmlns="http://www.w3.org/2000/svg"><rect width="10" height="10"/></svg>',
      value: '圆角'
    }])
  })

  it('svg-options 丢弃事件处理器、脚本、foreignObject 与主动 URL', () => {
    const result = normalizeQuestionsV2Items([
      {
        kind: 'svg-options',
        title: '选图标',
        options: [{
          value: 'unsafe',
          label: '危险图形',
          extra: '不应穿透',
          svg: '<svg viewBox="0 0 80 56" onload="window.api.getVoiceConfig()"><script>alert(1)</script><foreignObject><iframe srcdoc="<script>alert(2)</script>"></iframe></foreignObject><a href="javascript:alert(3)"><rect width="80" height="56" fill="#123456"/></a><image href="https://attacker.example/pixel"/></svg>'
        }]
      }
    ])

    expect(result[0].options).toHaveLength(1)
    expect(result[0].options[0]).toEqual({
      value: 'unsafe',
      label: '危险图形',
      svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 80 56"><rect width="80" height="56" fill="#123456"/></svg>'
    })
    expect(result[0].options[0].svg).not.toMatch(/onload|script|foreignObject|iframe|javascript:|https:/i)
  })

  it('svg-options 保留安全的色板、形状与文字预览', () => {
    const safeSvg = '<svg viewBox="0 0 80 56" xmlns="http://www.w3.org/2000/svg"><rect width="80" height="56" rx="8" fill="#0F3D2E"/><circle cx="60" cy="18" r="10" fill="rgb(217, 164, 65)"/><text x="8" y="48" font-family="serif" font-size="12">Body &amp; text</text></svg>'
    const result = normalizeQuestionsV2Items([
      { kind: 'svg-options', title: '色板', options: [{ value: 'green', label: '深绿', svg: safeSvg }] }
    ])

    expect(result[0].options).toEqual([{ value: 'green', label: '深绿', svg: safeSvg }])
  })

  it('svg-options 没有可保留的 SVG 元素时只丢预览，选项文字仍在', () => {
    const result = normalizeQuestionsV2Items([
      { kind: 'svg-options', title: '危险图形', options: [{ value: 'x', svg: '<svg><script>alert(1)</script></svg>' }] }
    ])

    expect(result[0].kind).toBe('svg-options')
    expect(result[0].options).toEqual([{ value: 'x' }])
  })

  it('svg-options 全部选项无效时降级为 text-options + 是/否', () => {
    const result = normalizeQuestionsV2Items([
      { kind: 'svg-options', title: '选图标', options: [{}, null] }
    ])
    expect(result[0].kind).toBe('text-options')
    expect(result[0].options).toEqual(['是', '否'])
  })

  // ---- 崩溃复现场景：与实录故障链同形状的 payload 过一遍 normalize，断言输出元素全是字符串 ----
  it('崩溃复现同形状 payload 规范化后 options 元素全部是字符串', () => {
    const result = normalizeQuestionsV2Items([
      { kind: 'text-options', options: [{ label: 'A', value: 'a' }, { label: 'B', value: 'b' }] }
    ])
    expect(result).toHaveLength(1)
    for (const opt of result[0].options) {
      expect(typeof opt).toBe('string')
    }
  })
})

/**
 * 选项预览裂图（真机实测）：风格选项 A 正常、B/C/D 只剩浏览器裂图图标。
 *
 * 实测复核（Chromium 里逐个 <img> 试 onload/onerror）：data:image/svg+xml 是按 XML 文档解析的，
 * 缺 xmlns、文本里裸 & 、标签不闭合/交叉这三类模型常见写法都直接 ERROR；外链 https 在断网 +
 * CSP 的产物沙箱里同样 ERROR。工具提示词里 4 个 SVG 模板只有第 1 个带 xmlns，正是 A 活 B/C/D
 * 死的形状。规范化层的口径：能离线渲染的只有「白名单静态内联 SVG」和「形状合法的 data:image/*」，
 * 其余判无预览；**丢的只是预览，选项文字永远保留**。
 */
describe('questions_v2 选项预览规范化（裂图防线）', () => {
  const previewOf = (svg: unknown): any => normalizeQuestionsV2Items([
    { kind: 'svg-options', title: '风格', options: [{ value: 'a', label: '风格 A', svg }] }
  ])[0].options[0]

  it('缺 xmlns 的内联 SVG 被补上命名空间（img 里才画得出来）', () => {
    const preview = previewOf('<svg viewBox="0 0 80 56"><rect x="8" y="12" width="64" height="32" rx="4" fill="#2A2A2A"/></svg>')
    expect(preview.svg).toBe('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 80 56"><rect x="8" y="12" width="64" height="32" rx="4" fill="#2A2A2A"/></svg>')
  })

  it('文本里的裸 & 被转义，HTML 式未闭合标签被自闭合（都会让 XML 解析失败）', () => {
    const preview = previewOf('<svg viewBox="0 0 80 56"><rect width="80" height="56" fill="#0F3D2E"><text x="8" y="48">Aa & Bb</text></svg>')
    expect(preview.svg).toContain('Aa &amp; Bb')
    expect(preview.svg).toContain('<rect width="80" height="56" fill="#0F3D2E"/>')
    expect(preview.svg?.endsWith('</svg>')).toBe(true)
  })

  it('标签交叉/悬空闭合的畸形 SVG 判无预览，选项文字保留', () => {
    const preview = previewOf('<svg viewBox="0 0 80 56"><g><rect width="10" height="10"/></svg>')
    expect(preview).toEqual({ value: 'a', label: '风格 A' })
  })

  it('http(s) 外链判无预览（产物沙箱断网 + CSP，外链必裂），选项文字保留', () => {
    expect(previewOf('https://cdn.example.com/style-b.png')).toEqual({ value: 'a', label: '风格 A' })
    expect(previewOf('http://example.com/c.svg')).toEqual({ value: 'a', label: '风格 A' })
    expect(previewOf('//example.com/d.png')).toEqual({ value: 'a', label: '风格 A' })
  })

  it('坏 base64 / 非图片 data URI 判无预览，选项文字保留', () => {
    expect(previewOf('data:image/png;base64,!!!not-base64!!!')).toEqual({ value: 'a', label: '风格 A' })
    expect(previewOf('data:image/png;base64,QUJDR')).toEqual({ value: 'a', label: '风格 A' })
    expect(previewOf('data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==')).toEqual({ value: 'a', label: '风格 A' })
    expect(previewOf('data:image/svg+xml;base64,QUJD')).toEqual({ value: 'a', label: '风格 A' })
  })

  it('合法 data URI 保留：raster 原样透传，svg+xml 解码后仍过静态白名单', () => {
    const rasterUri = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg=='
    expect(previewOf(rasterUri).svg).toBe(rasterUri)

    const svgSource = '<svg viewBox="0 0 80 56"><rect width="80" height="56" fill="#0F3D2E"/></svg>'
    const base64Uri = `data:image/svg+xml;base64,${Buffer.from(svgSource, 'utf8').toString('base64')}`
    expect(previewOf(base64Uri).svg).toBe('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 80 56"><rect width="80" height="56" fill="#0F3D2E"/></svg>')

    const percentUri = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svgSource)}`
    expect(previewOf(percentUri).svg).toContain('xmlns="http://www.w3.org/2000/svg"')
  })

  it('data URI 包装不是信任边界：内层脚本/外链同样被剥掉', () => {
    const hostile = '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><script>alert(2)</script><image href="https://attacker.example/p.png"/><rect width="10" height="10"/></svg>'
    const preview = previewOf(`data:image/svg+xml;base64,${Buffer.from(hostile, 'utf8').toString('base64')}`)
    expect(preview.svg).not.toMatch(/onload|script|https:/i)
    expect(preview.svg).toContain('<rect width="10" height="10"/>')
  })

  it('渲染层拿到的永远是 img 可用的 src（data: 开头），无预览时是 null', () => {
    expect(questionsPreviewImageUrl('<svg viewBox="0 0 80 56"><rect width="80" height="56" fill="#0F3D2E"/></svg>'))
      .toBe(`data:image/svg+xml;charset=utf-8,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 80 56"><rect width="80" height="56" fill="#0F3D2E"/></svg>')}`)
    expect(questionsPreviewImageUrl('https://cdn.example.com/a.png')).toBeNull()
    expect(questionsPreviewImageUrl(undefined)).toBeNull()
  })
})

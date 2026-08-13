import { describe, expect, it } from 'vitest'
import { locateElementInSource, mergeStyleIntoTag, styleKeyToCssProp } from '../../src/renderer/src/components/artifacts/tweakDirectWrite'

describe('locateElementInSource', () => {
  it('阶梯 (a)：id 属性在源码唯一命中', () => {
    const source = '<div class="wrap"><p id="hello">Hi</p></div>'
    const loc = locateElementInSource(source, { tagName: 'p', outerHead: '<p id="hello">', text: 'Hi' })
    expect(loc).not.toBeNull()
    expect(source.slice(loc!.tagStart, loc!.tagEnd)).toBe('<p id="hello">')
  })

  it('阶梯 (b)：无 id 时用 outerHead 开标签快照定位', () => {
    const source = '<div class="card"><span class="title big">Hello</span></div>'
    const loc = locateElementInSource(source, { tagName: 'span', outerHead: '<span class="title big">', text: 'Hello' })
    expect(loc).not.toBeNull()
    expect(source.slice(loc!.tagStart, loc!.tagEnd)).toBe('<span class="title big">')
  })

  it('阶梯 (c)：outerHead 不命中（如 DOM 属性由模板插值生成）时回溯到最近的同 tagName 开标签', () => {
    // outerHead 是渲染后 DOM 的快照（含运行时插值出来的 style），源码里只有模板语法，不含该串
    const source = '<div><h2 x-bind:style="theme.h2">Welcome Aboard</h2></div>'
    const loc = locateElementInSource(source, {
      tagName: 'h2',
      outerHead: '<h2 style="color: rgb(10, 20, 30);">',
      text: 'Welcome Aboard'
    })
    expect(loc).not.toBeNull()
    expect(source.slice(loc!.tagStart, loc!.tagEnd)).toBe('<h2 x-bind:style="theme.h2">')
  })

  it('id 在源码中出现两次(重复 id，理论不该但要防御) → (a) 降级，改用 (b) outerHead 命中', () => {
    const source = '<p id="dup">A</p><span id="dup" class="target">B</span>'
    const loc = locateElementInSource(source, {
      tagName: 'span',
      outerHead: '<span id="dup" class="target">',
      text: 'B'
    })
    expect(loc).not.toBeNull()
    expect(source.slice(loc!.tagStart, loc!.tagEnd)).toBe('<span id="dup" class="target">')
  })

  it('outerHead 在源码中出现两次 → 不唯一，降级到文本回溯', () => {
    const source = '<div><b class="x">One</b><b class="x">Two</b></div>'
    const loc = locateElementInSource(source, { tagName: 'b', outerHead: '<b class="x">', text: 'Two' })
    expect(loc).not.toBeNull()
    // 应该经文本回溯命中第二个 <b class="x">（离 "Two" 最近的同 tag 开标签）
    const tag = source.slice(loc!.tagStart, loc!.tagEnd)
    expect(tag).toBe('<b class="x">')
    expect(loc!.tagStart).toBe(source.indexOf('<b class="x">Two'))
  })

  it('文本不唯一 → 全阶梯失败，返回 null（静默降级）', () => {
    const source = '<p>Repeat</p><span>Repeat</span>'
    const loc = locateElementInSource(source, { tagName: 'p', outerHead: '<p class="ghost">', text: 'Repeat' })
    expect(loc).toBeNull()
  })

  it('.dc.html 模板：DOM 属性值是插值结果，源码里根本不存在 → 静默降级 null', () => {
    const source = '<x-dc><div>{{ title }}</div></x-dc>'
    const loc = locateElementInSource(source, {
      tagName: 'div',
      outerHead: '<div data-computed="42">',
      text: 'Resolved Title Text'
    })
    expect(loc).toBeNull()
  })

  it('id 属性名子串误伤防御：data-id 不应被当成 id 命中', () => {
    const source = '<div data-id="hello"></div><p id="hello">Real</p>'
    const loc = locateElementInSource(source, { tagName: 'p', outerHead: '<p id="hello">', text: 'Real' })
    expect(loc).not.toBeNull()
    expect(source.slice(loc!.tagStart, loc!.tagEnd)).toBe('<p id="hello">')
  })
})

describe('mergeStyleIntoTag', () => {
  it('已有 style 属性：解析合并，覆盖同名键，保留其他键', () => {
    const source = '<div style="color: red; font-size: 12px;">Hi</div>'
    const next = mergeStyleIntoTag(source, 0, source.indexOf('>') + 1, { color: 'blue' })
    expect(next).toContain('color: blue')
    expect(next).toContain('font-size: 12px')
    expect(next).not.toContain('color: red')
  })

  it('无 style 属性：新增 style 属性', () => {
    const source = '<div class="card">Hi</div>'
    const tagEnd = source.indexOf('>') + 1
    const next = mergeStyleIntoTag(source, 0, tagEnd, { 'background-color': '#ff0000' })
    expect(next).toContain('class="card"')
    expect(next).toContain('style="background-color: #ff0000"')
  })

  it('单引号 style 属性：保持单引号写回', () => {
    const source = "<span style='color: green'>Hi</span>"
    const tagEnd = source.indexOf('>') + 1
    const next = mergeStyleIntoTag(source, 0, tagEnd, { color: 'purple' })
    expect(next).toContain("style='color: purple'")
  })

  it('多个新增字段一次性合并进已有 style，不影响标签外的其余内容', () => {
    const source = '<p id="x" style="opacity: 1">Body<b>bold</b></p>'
    const tagEnd = source.indexOf('>') + 1
    const next = mergeStyleIntoTag(source, 0, tagEnd, { color: '#000000', 'font-weight': '700' })
    expect(next).toContain('opacity: 1')
    expect(next).toContain('color: #000000')
    expect(next).toContain('font-weight: 700')
    expect(next).toContain('Body<b>bold</b></p>') // 标签外内容原样保留
  })

  it('自闭合标签：新增 style 属性插在 /> 之前', () => {
    const source = '<img src="a.png" />'
    const tagEnd = source.length
    const next = mergeStyleIntoTag(source, 0, tagEnd, { width: '100px' })
    expect(next).toBe('<img src="a.png" style="width: 100px" />')
  })

  it('tagStart/tagEnd 非法或 styleDiff 为空：原样返回，不抛错', () => {
    const source = '<div>Hi</div>'
    expect(mergeStyleIntoTag(source, -1, 5, { color: 'red' })).toBe(source)
    expect(mergeStyleIntoTag(source, 0, 5, {})).toBe(source)
  })
})

describe('styleKeyToCssProp', () => {
  it('camelCase 内联样式 key 转 kebab-case CSS 属性名', () => {
    expect(styleKeyToCssProp('backgroundColor')).toBe('background-color')
    expect(styleKeyToCssProp('fontSize')).toBe('font-size')
    expect(styleKeyToCssProp('color')).toBe('color')
    expect(styleKeyToCssProp('borderRadius')).toBe('border-radius')
  })
})

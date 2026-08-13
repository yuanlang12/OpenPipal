/**
 * DC x-import `from` 链引擎（W2/W3 三处 sibling 消费点共用的纯解析层）：
 * 官方 support.js 把 from 值按空白拆链、顺序 loadExternal；srcdoc/data:/file: 下相对 fetch 不可用，
 * 宿主须"删 from + 按链序预载全局"。引擎只做定位/拆分/全解析才删+有序去重，解析策略由调用方注入。
 */
import { describe, it, expect } from 'vitest'
import { rewriteFromAttrs, injectInlinePreloads } from '../../src/main/dc-siblings'

const resolver = (p: string): { key: string; source: string } | null => {
  const map: Record<string, string> = {
    './animations.jsx': 'ANIM',
    './artifact-1700000000000.jsx': 'SCENE',
    './deck-stage.js': 'DECK',
    './doc-page.js': 'DOCPAGE',
  }
  return map[p] ? { key: p, source: map[p] } : null
}

describe('rewriteFromAttrs from 链引擎', () => {
  it('单路径 from 全解析 → 删 from + 有序收集', () => {
    const { html, ordered } = rewriteFromAttrs('<x-import from="./deck-stage.js"></x-import>', resolver)
    expect(html).not.toContain('from=')
    expect(ordered.map((o) => o.key)).toEqual(['./deck-stage.js'])
  })

  it('链式 from 按序解析（前序 animations 先于场景）——链序硬要求', () => {
    const html = '<x-import component-from-global-scope="Scene" from="./animations.jsx ./artifact-1700000000000.jsx"></x-import>'
    const { html: out, ordered } = rewriteFromAttrs(html, resolver)
    expect(out).not.toContain('from=')
    expect(ordered.map((o) => o.key)).toEqual(['./animations.jsx', './artifact-1700000000000.jsx'])
  })

  it('任一路径不可解析 → 整条 from 原样保留（placeholder 交给 support.js）', () => {
    const html = '<x-import from="./animations.jsx ./unknown.js"></x-import>'
    const { html: out, ordered } = rewriteFromAttrs(html, resolver)
    expect(out).toContain('from="./animations.jsx ./unknown.js"')
    expect(ordered).toEqual([])
  })

  it('去重：多处引用同一 sibling 只收一次，保持首见链序', () => {
    const html = '<x-import from="./animations.jsx ./artifact-1700000000000.jsx"></x-import><x-import from="./animations.jsx"></x-import>'
    const { ordered } = rewriteFromAttrs(html, resolver)
    expect(ordered.map((o) => o.key)).toEqual(['./animations.jsx', './artifact-1700000000000.jsx'])
  })

  it('doc-page.js 作为已知 sibling 被解析删 from', () => {
    const { html, ordered } = rewriteFromAttrs('<x-import from="./doc-page.js"></x-import>', resolver)
    expect(html).not.toContain('from=')
    expect(ordered.map((o) => o.key)).toEqual(['./doc-page.js'])
  })

  it('不匹配的 src（图片 / support）不动', () => {
    const html = '<img src="./photo.png"><script src="./support.js"></script>'
    const { html: out, ordered } = rewriteFromAttrs(html, resolver)
    expect(out).toBe(html)
    expect(ordered).toEqual([])
  })

  it('injectInlinePreloads 内联时转义源码里的 </script', () => {
    const out = injectInlinePreloads('<head></head>', ['var a = "x</script>y"'])
    expect(out).toContain('x<\\/script>y') // 已转义
    expect(out.startsWith('<head><script>')).toBe(true)
  })
})

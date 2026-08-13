import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createRendererI18n } from '../../src/renderer/src/i18n'
import {
  buildHtmlPreviewBridgeScript,
  serializeHtmlPreviewBridgeCopy,
  shouldSkipSelfEditEcho,
} from '../../src/renderer/src/components/artifacts/htmlPreviewBridge'

const read = (path: string): string => readFileSync(resolve(path), 'utf8')
const MIGRATED_FILES = [
  'src/renderer/src/components/artifacts/HtmlPreview.tsx',
  'src/renderer/src/components/artifacts/ElementTweakPanel.tsx',
]

describe('artifact canvas i18n', () => {
  it('serves matching English and Chinese canvas shell copy', async () => {
    const english = await createRendererI18n('en')
    const chinese = await createRendererI18n('zh-CN')

    expect(english.t('artifacts.canvas.toolbar.comment')).toBe('Comment')
    expect(english.t('artifacts.canvas.tweak.textColor')).toBe('Text color')
    expect(chinese.t('artifacts.canvas.toolbar.comment')).toBe('评论')
    expect(chinese.t('artifacts.canvas.tweak.textColor')).toBe('文本颜色')
  })

  it('serializes iframe copy as JSON and escapes script-closing text', () => {
    const malicious = '</script><script>alert(1)</script>'
    const serialized = serializeHtmlPreviewBridgeCopy({ commentOverlay: malicious })
    const script = buildHtmlPreviewBridgeScript(
      '<script>window.copy=__OPENPIPAL_PREVIEW_COPY__;</script>',
      { commentOverlay: malicious }
    )

    expect(serialized).not.toContain('<')
    expect(serialized).toContain('\\u003c/script>')
    expect(JSON.parse(serialized)).toEqual({ commentOverlay: malicious })
    expect(script).not.toContain('</script><script>alert(1)')
    expect(script).toContain('window.copy={"commentOverlay":"\\u003c/script>')
  })

  it('rebuilds injected copy for the active locale', async () => {
    const english = await createRendererI18n('en')
    const chinese = await createRendererI18n('zh-CN')
    const template = '<script>window.copy=__OPENPIPAL_PREVIEW_COPY__;</script>'
    const englishScript = buildHtmlPreviewBridgeScript(template, {
      commentOverlay: english.t('artifacts.canvas.bridge.commentOverlay'),
    })
    const chineseScript = buildHtmlPreviewBridgeScript(template, {
      commentOverlay: chinese.t('artifacts.canvas.bridge.commentOverlay'),
    })

    expect(englishScript).not.toBe(chineseScript)
    expect(englishScript).toContain('Drag to mark')
    expect(chineseScript).toContain('拖拽圈画')
  })

  it('never lets a self-edit echo swallow a locale bridge update', () => {
    expect(shouldSkipSelfEditEcho('same content', 'same content', false)).toBe(true)
    expect(shouldSkipSelfEditEcho('same content', 'same content', true)).toBe(false)
    expect(shouldSkipSelfEditEcho('old content', 'new content', false)).toBe(false)
  })

  it('defines every static canvas key used by the migrated surfaces', async () => {
    const i18n = await createRendererI18n('en')
    const source = MIGRATED_FILES.map(read).join('\n')
    const keys = [...source.matchAll(/\bt\('((?:artifacts\.canvas)\.[^']+)'/g)].map(match => match[1])

    expect(keys.length).toBeGreaterThan(30)
    for (const key of new Set(keys)) expect(i18n.exists(key)).toBe(true)
  })

  it('keeps artifact, DOM, user, and model payloads verbatim', () => {
    const source = MIGRATED_FILES.map(read).join('\n')

    expect(source).toContain('instructionLines.push(`请把该元素文本改为：「${fields.text}」`)')
    expect(source).toContain("instructionLines.push(`请把该元素样式调整为: ${diffs.join('; ')}`)")
    expect(source).toContain("text || '请看圈选截图里红笔圈出的部位'")
    expect(source).toContain('{tagName')
    expect(source).toContain('value={fields.text}')
    expect(source).toContain('value={bubbleInput}')
    expect(source).not.toMatch(/\bt\(\s*(?:fields\.text|bubbleInput|tagName|commentAnchor\.|instructionLines|description)\b/)
    expect(source).toContain('_commentOverlay.textContent = _swCopy.commentOverlay')
    expect(source).not.toContain("_commentOverlay.textContent = '✏️")
  })

  it('allows long English labels to wrap or stay within the viewport', () => {
    const panel = read('src/renderer/src/components/artifacts/ElementTweakPanel.tsx')
    const preview = read('src/renderer/src/components/artifacts/HtmlPreview.tsx')

    expect(panel).toContain('w-full max-w-[340px]')
    expect(panel).toContain('leading-tight break-words')
    expect(preview).toContain('min-w-0 text-[10px]')
    expect(preview).toContain('wrapperW - (MARGIN * 2)')
    expect(preview).toContain('wrapperRectHost.width - 8')
    expect(preview).toContain('wrapperRectHost.width <= 8')
    expect(preview.match(/new ResizeObserver\(recompute\)/g)?.length).toBeGreaterThanOrEqual(2)
  })
})

/**
 * ds-compile —— 设计系统新格式编译器（W4）纯逻辑锁。
 * 覆盖：三件套落盘 / manifest 12 键 / cards 来自 @dsCard + 兜底 / tokens CSS 解析(+@kind other) /
 *      brandFonts 抽首个非系统字族 / namespace 确定性 / bundle format4 头部 + try/catch 隔离 +
 *      组件间 __ds_scope 改写 + window.<ns> 暴露 / bundle 真 eval(window.<ns>.Button 可取且是函数) /
 *      adherence 3 全局规则 + 组件枚举 + x-openpipal。
 *
 * 用临时 fixture（rootDir 覆盖），不依赖 ~/.openpipal，也不碰 ds-manifest 16 测。
 */
import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'

import { compileDesignSystem, deriveNamespace, parseTokens } from '../../src/main/ds-compile'

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'openpipal-ds-compile-'))
const NAME = 'test-kit'
const DIR = path.join(ROOT, NAME)

function seed(rel: string, content: string): void {
  const abs = path.join(DIR, rel)
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, content)
}

seed('SKILL.md', `---\nname: Test Kit\ndescription: A fixture design system\n---\n# Test Kit`)

seed(
  'styles.css',
  `@import './tokens/colors.css';\n@import './tokens/typography.css';\n@import './tokens/motion.css';\n`
)
seed('tokens/colors.css', `:root {\n  --bg-0: #FFFFFF;\n  --accent: #0A0A0A;\n  --accent-fg: #FFFFFF;\n}`)
seed(
  'tokens/typography.css',
  `:root {\n  --font-sans: 'Inter', -apple-system, sans-serif;\n  --font-mono: 'JetBrains Mono', monospace;\n  --text-sm: 0.8125rem;\n}`
)
seed(
  'tokens/motion.css',
  `:root {\n  --duration-fast: 100ms;\n  --ease-out: cubic-bezier(0.16, 1, 0.3, 1); /* @kind other */\n}`
)

// Button 依赖 Icon（测试 sibling 改写）
seed(
  'components/core/Icon.jsx',
  `import React from 'react';\nexport function Icon(props) {\n  return <span data-icon={props.name} />;\n}`
)
seed('components/core/Icon.d.ts', `interface IconProps {\n  name: string;\n  size?: 'sm' | 'md';\n}\nexport function Icon(props: IconProps): JSX.Element;`)
seed(
  'components/core/Button.jsx',
  `import React from 'react';\nimport { Icon } from './Icon.jsx';\nexport function Button(props) {\n  const { variant = 'primary', size = 'md', children, style, ...rest } = props;\n  return <button style={style} {...rest}><Icon name="chevron" />{children}</button>;\n}`
)
seed(
  'components/core/Button.d.ts',
  `import { ReactNode } from 'react';\ninterface ButtonProps {\n  children: ReactNode;\n  variant?: 'primary' | 'secondary' | 'ghost';\n  size?: 'sm' | 'md' | 'lg';\n  loading?: boolean;\n}\nexport function Button(props: ButtonProps): JSX.Element;`
)
seed(
  'components/core/buttons.card.html',
  `<!-- @dsCard group="Components" viewport="700x300" name="Buttons" subtitle="Button variants" -->\n<!DOCTYPE html><html><body>demo</body></html>`
)
seed('guidelines/colors.html', `<style>:root{}</style>`)

const res = compileDesignSystem(NAME, ROOT)
const manifest = JSON.parse(fs.readFileSync(path.join(DIR, '_ds_manifest.json'), 'utf8'))
const bundle = fs.readFileSync(path.join(DIR, '_ds_bundle.js'), 'utf8')
const adherence = JSON.parse(fs.readFileSync(path.join(DIR, '_adherence.oxlintrc.json'), 'utf8'))
const namespace = deriveNamespace(NAME)

describe('compileDesignSystem — 落盘与结果', () => {
  it('ok=true，落盘三件套与本地离线 React 预览运行时', () => {
    expect(res.ok).toBe(true)
    expect(res.errors).toEqual([])
    expect(res.files.some((f) => f.endsWith('_ds_manifest.json'))).toBe(true)
    expect(res.files.some((f) => f.endsWith('_ds_bundle.js'))).toBe(true)
    expect(res.files.some((f) => f.endsWith('_adherence.oxlintrc.json'))).toBe(true)
    expect(res.files.some((f) => f.endsWith('_vendor/react.production.min.js'))).toBe(true)
    expect(res.files.some((f) => f.endsWith('_vendor/react-dom.production.min.js'))).toBe(true)
    expect(fs.statSync(path.join(DIR, '_vendor', 'react.production.min.js')).size).toBeGreaterThan(1_000)
    expect(fs.statSync(path.join(DIR, '_vendor', 'react-dom.production.min.js')).size).toBeGreaterThan(10_000)
  })
  it('无效名 / 不存在返回 ok=false', () => {
    expect(compileDesignSystem('../evil', ROOT).ok).toBe(false)
    expect(compileDesignSystem('nope', ROOT).ok).toBe(false)
  })
  it('拒绝通过编译产物或 _vendor 符号链接覆盖系统外文件', () => {
    const unsafeName = 'unsafe-links'
    const unsafeDir = path.join(ROOT, unsafeName)
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openpipal-ds-compile-outside-'))
    const manifestSentinel = path.join(outsideDir, 'manifest.json')
    const vendorSentinel = path.join(outsideDir, 'react.production.min.js')
    fs.mkdirSync(unsafeDir)
    fs.writeFileSync(path.join(unsafeDir, 'SKILL.md'), '# unsafe fixture')
    fs.writeFileSync(manifestSentinel, 'manifest-secret')
    fs.writeFileSync(vendorSentinel, 'vendor-secret')
    fs.symlinkSync(manifestSentinel, path.join(unsafeDir, '_ds_manifest.json'))
    fs.symlinkSync(outsideDir, path.join(unsafeDir, '_vendor'))

    const unsafe = compileDesignSystem(unsafeName, ROOT)
    expect(unsafe.ok).toBe(false)
    expect(unsafe.errors.join('\n')).toMatch(/_vendor|_ds_manifest/)
    expect(fs.readFileSync(manifestSentinel, 'utf8')).toBe('manifest-secret')
    expect(fs.readFileSync(vendorSentinel, 'utf8')).toBe('vendor-secret')
  })
})

describe('_ds_manifest.json — 官方 12 键', () => {
  it('12 顶层键齐全', () => {
    const keys = Object.keys(manifest).sort()
    expect(keys).toEqual(
      [
        'brandFonts',
        'cards',
        'components',
        'fonts',
        'globalCssPaths',
        'hasThumbnailHtml',
        'namespace',
        'source',
        'startingPoints',
        'templates',
        'themes',
        'tokens'
      ].sort()
    )
    expect(manifest.source).toBe('openpipal')
    expect(manifest.startingPoints).toEqual([])
    expect(manifest.templates).toEqual([])
    expect(manifest.themes).toEqual([])
    expect(manifest.hasThumbnailHtml).toBe(false)
  })
  it('namespace = PascalCase_6hex，确定性可复现', () => {
    expect(manifest.namespace).toBe(namespace)
    expect(namespace).toMatch(/^TestKit_[0-9a-f]{6}$/)
    // 再编译一次 namespace 不变
    const again = JSON.parse(fs.readFileSync(path.join(DIR, '_ds_manifest.json'), 'utf8'))
    expect(deriveNamespace(NAME)).toBe(again.namespace)
  })
  it('components 扫 components/**/*.jsx，name=主导出', () => {
    const byPath = Object.fromEntries(manifest.components.map((c: any) => [c.sourcePath, c.name]))
    expect(byPath['components/core/Button.jsx']).toBe('Button')
    expect(byPath['components/core/Icon.jsx']).toBe('Icon')
  })
  it('cards 来自 @dsCard 头 + 无头兜底', () => {
    const byPath = Object.fromEntries(manifest.cards.map((c: any) => [c.path, c]))
    const btn = byPath['components/core/buttons.card.html']
    expect(btn.group).toBe('Components')
    expect(btn.viewport).toBe('700x300')
    expect(btn.name).toBe('Buttons')
    expect(btn.subtitle).toBe('Button variants')
    const guide = byPath['guidelines/colors.html']
    expect(guide.group).toBe('guidelines')
    expect(guide.name).toBe('Colors')
    expect(guide.viewport).toBe('700x400')
  })
  it('globalCssPaths = styles.css @import 顺序 + 末尾 styles.css', () => {
    expect(manifest.globalCssPaths).toEqual([
      'tokens/colors.css',
      'tokens/typography.css',
      'tokens/motion.css',
      'styles.css'
    ])
  })
  it('tokens 静态解析 --x:y + kind + definedIn + @kind other 旁注', () => {
    const byName = Object.fromEntries(manifest.tokens.map((t: any) => [t.name, t]))
    expect(byName['--accent']).toMatchObject({ value: '#0A0A0A', kind: 'color', definedIn: 'tokens/colors.css' })
    expect(byName['--font-sans'].kind).toBe('font')
    expect(byName['--text-sm'].kind).toBe('font')
    expect(byName['--duration-fast'].kind).toBe('other') // duration 非任何前缀白名单 → other
    expect(byName['--ease-out']).toMatchObject({ kind: 'other', annotation: 'other' })
  })
  it('brandFonts 抽首个非系统字族；fonts(静态 @font-face) 为空', () => {
    const fams = manifest.brandFonts.map((f: any) => f.family).sort()
    expect(fams).toEqual(['Inter', 'JetBrains Mono'])
    const inter = manifest.brandFonts.find((f: any) => f.family === 'Inter')
    expect(inter.tokens).toContain('--font-sans')
    expect(inter.status).toBe('ok')
    expect(inter.path).toBe('tokens/typography.css')
    expect(manifest.fonts).toEqual([])
  })
})

describe('_ds_bundle.js — format 4', () => {
  it('头部 @ds-bundle 元数据：format4 + namespace + sourceHashes', () => {
    const m = bundle.match(/\/\* @ds-bundle:\s*([\s\S]*?)\s*\*\//)
    expect(m).toBeTruthy()
    const meta = JSON.parse(m![1])
    expect(meta.format).toBe(4)
    expect(meta.namespace).toBe(namespace)
    expect(meta.inlinedExternals).toEqual([])
    expect(meta.sourceHashes['components/core/Button.jsx']).toMatch(/^[0-9a-f]{12}$/)
    expect(meta.sourceHashes['components/core/Icon.jsx']).toMatch(/^[0-9a-f]{12}$/)
  })
  it('每文件 try/catch 隔离 + __errors 收集', () => {
    expect(bundle).toContain('__ds_ns.__errors')
    expect(bundle).toContain('catch (e)')
    expect(bundle).toContain('// components/core/Button.jsx')
  })
  it('组件间引用改写为 __ds_scope.Icon（late-binding，序无关）', () => {
    expect(bundle).toContain('__ds_scope.Icon')
  })
  it('末尾把公开组件挂到 window.<namespace>', () => {
    expect(bundle).toContain(`window.${namespace}`)
    expect(bundle).toContain(`__ds_ns.Button = __ds_scope.Button;`)
    expect(bundle).toContain(`__ds_ns.Icon = __ds_scope.Icon;`)
  })
  it('真 eval：React CDN 就绪下 window.<ns>.Button 可取且是函数、可调用', () => {
    const fakeWindow: any = {}
    const React = { createElement: (...a: any[]) => ({ type: a[0], props: a[1], children: a.slice(2) }) }
    // 头部是合法 JS 注释，可直接 eval
    // eslint-disable-next-line no-new-func
    const fn = new Function('window', 'React', bundle)
    fn(fakeWindow, React)
    expect(typeof fakeWindow[namespace].Button).toBe('function')
    expect(typeof fakeWindow[namespace].Icon).toBe('function')
    const el = fakeWindow[namespace].Button({ children: 'ok' })
    expect(el.type).toBe('button')
    expect(fakeWindow[namespace].__errors).toEqual([])
  })
})

describe('_adherence.oxlintrc.json — 官方 oxlint 格式', () => {
  it('plugins + 3 全局禁令（hex/px/字体）全部 warn', () => {
    expect(adherence.plugins).toEqual(['react', 'import'])
    const rs = adherence.rules['no-restricted-syntax']
    expect(rs[0]).toBe('warn')
    const selectors = rs.slice(1).map((r: any) => r.selector)
    expect(selectors.some((s: string) => s.includes('#[0-9a-fA-F]{3,8}'))).toBe(true)
    expect(selectors.some((s: string) => s.includes('\\d+px'))).toBe(true)
    const fontRule = selectors.find((s: string) => s.includes('font-family'))
    expect(fontRule).toContain('Inter')
    expect(fontRule).toContain('JetBrains Mono')
  })
  it('每组件 prop 白名单 selector（含 key|ref|className|style|children 尾巴）', () => {
    const rs = adherence.rules['no-restricted-syntax'].slice(1)
    const btnWhitelist = rs.find(
      (r: any) => r.selector.includes("name.name='Button'") && r.selector.includes('JSXIdentifier[name!=')
    )
    expect(btnWhitelist).toBeTruthy()
    for (const p of ['variant', 'size', 'loading', 'children', 'key', 'ref', 'className', 'style']) {
      expect(btnWhitelist.selector).toContain(p)
    }
  })
  it('枚举值 selector（Button.variant primary|secondary|ghost）', () => {
    const rs = adherence.rules['no-restricted-syntax'].slice(1)
    const en = rs.find(
      (r: any) => r.selector.includes("name.name='Button'") && r.selector.includes("name.name='variant'")
    )
    expect(en.selector).toContain('primary')
    expect(en.selector).toContain('secondary')
    expect(en.selector).toContain('ghost')
  })
  it('x-openpipal 扩展块：token 全集 + kind 映射 + fontFamilies + 组件 props/enums', () => {
    const x = adherence['x-openpipal']
    expect(x.tokens).toContain('--accent')
    expect(x.tokenKinds['--accent']).toBe('color')
    expect(x.fontFamilies).toContain('Inter')
    expect(x.components.Button.props).toContain('variant')
    expect(x.components.Button.enums.variant).toEqual(['primary', 'secondary', 'ghost'])
    expect(x.components.Button.replaces).toEqual([])
  })
  it('overrides：index.js 关闭 no-restricted-imports', () => {
    expect(adherence.overrides[0].files).toEqual(['**/index.js'])
  })
})

describe('parseTokens — 直接单元', () => {
  it('剥非 @kind 注释、保留 @kind 旁注、同名首见为准', () => {
    const toks = parseTokens(
      `:root{\n  --a: #111; /* comment */\n  --b: 4px;\n  --c: linear; /* @kind other */\n}\n:root{ --a: #999; }`,
      'x.css'
    )
    const byName = Object.fromEntries(toks.map((t) => [t.name, t]))
    expect(byName['--a'].value).toBe('#111') // 首见为准
    expect(byName['--a'].kind).toBe('color')
    expect(byName['--b'].kind).toBe('spacing')
    expect(byName['--c']).toMatchObject({ kind: 'other', annotation: 'other' })
  })
})

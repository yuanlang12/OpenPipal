/**
 * 设计系统画廊 manifest 纯逻辑锁（getDesignSystemManifest）。
 * 覆盖:@dsCard 头解析 / 无头兜底分组 / viewport WxH + h 上限 640 /
 *      ui_kits 归集 + 空 ui_kits / README 大小写不敏感 / SKILL.md frontmatter /
 *      排除目录(assets/ui_kits/_ 前缀) / 深度≤3 / name 含 .. 或 / 返回 null。
 *
 * 手法同 artifact-scoping.test.ts:先劫持 HOME 到临时目录,再动态 import role-manager
 * (getDesignSystemsRoot 每次调 homedir() 读 process.env.HOME,故 fixture 落到临时根)。
 */
import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'openpipal-ds-manifest-'))
process.env.HOME = TMP

const DS_ROOT = path.join(TMP, '.openpipal', 'design-systems')

function seed(rel: string, content: string): void {
  const abs = path.join(DS_ROOT, rel)
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, content)
}

// ---- 系统 A「alpha」:全部卡带 @dsCard 头 + SKILL frontmatter + README + ui_kits ----
seed('alpha/SKILL.md', `---
name: Alpha System
description: An alpha design system
---
# Alpha
正文`)
seed('alpha/preview/hero.html',
  '<!-- @dsCard group="Marketing" viewport="800x300" subtitle="Landing hero" name="Hero Banner" -->\n<h1>hero</h1>')
// viewport 高 900 → 应被夹到 640;无 subtitle
seed('alpha/preview/footer.html',
  '<!-- @dsCard group="Marketing" viewport="700x900" name="Footer" -->\n<footer>f</footer>')
seed('alpha/components/button.html',
  "<!-- @dsCard group='Components' name='Button' -->\n<button>b</button>")
seed('alpha/ui_kits/main/index.html', '<html>kit</html>')
seed('alpha/ui_kits/empty-dir/notes.txt', 'no index here') // 无 index.html → 不算 kit
seed('alpha/assets/ignored.html', '<!-- @dsCard group="X" name="Nope" -->') // assets/ 排除
seed('alpha/_private/hidden.html', '<!-- @dsCard group="Y" name="Nope2" -->') // _ 前缀目录排除
seed('alpha/README.md', '# 规范文档')
// 文件浏览器视图（manifest.files）用的散件:样式/脚本/我方记账文件
seed('alpha/styles.css', ':root{--a:1}')
seed('alpha/_ds_bundle.js', 'window.Alpha={}')
seed('alpha/_review.json', '{"updatedAt":0,"cards":{}}')

// ---- 系统 B「beta」:无 @dsCard(兜底) + 无 frontmatter + 空 ui_kits + 无 README ----
seed('beta/SKILL.md', 'no frontmatter here\njust text')
seed('beta/guidelines/colors.html', '<style>:root{}</style>')
seed('beta/guidelines/typography.html', '<style>h1{}</style>')
// 深度:root→components→core→file(dirDepth 2 递归),且 .card.html 双后缀
seed('beta/components/core/card.card.html', '<div class="card"></div>')
fs.mkdirSync(path.join(DS_ROOT, 'beta', 'ui_kits'), { recursive: true }) // 空 ui_kits 目录

const rm = await import('../../src/main/role-manager')
const alpha = rm.getDesignSystemManifest('alpha')!
const beta = rm.getDesignSystemManifest('beta')!

describe('getDesignSystemManifest — 形状与 frontmatter', () => {
  it('alpha:name/title/description/path 来自 SKILL frontmatter', () => {
    expect(alpha).not.toBeNull()
    expect(alpha.name).toBe('alpha')
    expect(alpha.title).toBe('Alpha System')
    expect(alpha.description).toBe('An alpha design system')
    expect(alpha.path.endsWith(`${path.sep}alpha`)).toBe(true)
  })

  it('beta:无 frontmatter → title 回落文件夹名,description 为空', () => {
    expect(beta.title).toBe('beta')
    expect(beta.description).toBeUndefined()
  })
})

describe('getDesignSystemManifest — @dsCard 头解析', () => {
  const marketing = alpha.groups.find(g => g.group === 'Marketing')!
  const components = alpha.groups.find(g => g.group === 'Components')!

  it('group/name/subtitle/viewport 全部取自标签', () => {
    const hero = marketing.cards.find(c => c.rel === 'preview/hero.html')!
    expect(hero.name).toBe('Hero Banner')
    expect(hero.subtitle).toBe('Landing hero')
    expect(hero.group).toBe('Marketing')
    expect(hero.w).toBe(800)
    expect(hero.h).toBe(300)
  })

  it('viewport 高度上限 640(700x900 → 640),无 subtitle 则 undefined', () => {
    const footer = marketing.cards.find(c => c.rel === 'preview/footer.html')!
    expect(footer.w).toBe(700)
    expect(footer.h).toBe(640)
    expect(footer.subtitle).toBeUndefined()
  })

  it('单引号属性同样解析(Components/Button)', () => {
    expect(components.cards.map(c => c.name)).toEqual(['Button'])
  })

  it('组内按文件名排序(footer < hero)', () => {
    expect(marketing.cards.map(c => c.rel)).toEqual(['preview/footer.html', 'preview/hero.html'])
  })

  it('分组归属:标签 group 决定归组,而非目录', () => {
    expect(alpha.groups.map(g => g.group).sort()).toEqual(['Components', 'Marketing'])
  })
})

describe('getDesignSystemManifest — 无标签兜底', () => {
  it('group = 顶层目录名,name = 文件名标题化,w700/h400', () => {
    const g = beta.groups.find(s => s.group === 'guidelines')!
    const colors = g.cards.find(c => c.rel === 'guidelines/colors.html')!
    expect(colors.name).toBe('Colors')
    expect(colors.group).toBe('guidelines')
    expect(colors.w).toBe(700)
    expect(colors.h).toBe(400)
    expect(colors.subtitle).toBeUndefined()
    expect(g.cards.map(c => c.name)).toEqual(['Colors', 'Typography'])
  })

  it('深度≤3 命中 components/core/*.card.html,.card.html 双后缀去净', () => {
    const g = beta.groups.find(s => s.group === 'components')!
    expect(g.cards.map(c => c.rel)).toEqual(['components/core/card.card.html'])
    expect(g.cards[0].name).toBe('Card')
  })
})

describe('getDesignSystemManifest — kits / README / 排除', () => {
  it('ui_kits/<dir>/index.html 归 kits,label = 目录名;无 index.html 的目录跳过', () => {
    expect(alpha.kits).toEqual([{ rel: 'ui_kits/main/index.html', label: 'main' }])
  })

  it('空 ui_kits 目录 → kits 为空数组', () => {
    expect(beta.kits).toEqual([])
  })

  it('README.md 相对路径(大小写不敏感命中)', () => {
    expect(alpha.readme).toBe('README.md')
    expect(beta.readme).toBeUndefined()
  })

  it('排除目录:assets/ 与 _ 前缀目录内的卡不入 manifest,ui_kits 也不当卡', () => {
    const rels = alpha.groups.flatMap(g => g.cards.map(c => c.rel))
    expect(rels.some(r => r.startsWith('assets/'))).toBe(false)
    expect(rels.some(r => r.startsWith('_private/'))).toBe(false)
    expect(rels.some(r => r.startsWith('ui_kits/'))).toBe(false)
    // 排除目录里的卡名不会泄漏进来
    expect(rels.every(r => r === 'preview/hero.html' || r === 'preview/footer.html' || r === 'components/button.html')).toBe(true)
  })
})

describe('getDesignSystemManifest — files 目录树（文件浏览器视图）', () => {
  const top = (m: typeof alpha): Record<string, 'dir' | 'file'> =>
    Object.fromEntries(m.files.map(f => [f.name, f.kind]))

  it('如实反映磁盘:卡片扫描排除的 assets/ui_kits/_ 前缀目录在 files 里仍可见', () => {
    const t = top(alpha)
    expect(t['assets']).toBe('dir')
    expect(t['ui_kits']).toBe('dir')
    expect(t['_private']).toBe('dir')
    expect(t['styles.css']).toBe('file')
    expect(t['_ds_bundle.js']).toBe('file')
  })

  it('我方记账文件 _review.json 不进树（隐藏文件同理）', () => {
    expect(alpha.files.some(f => f.name === '_review.json')).toBe(false)
  })

  it('文件夹排前、组内按名排序，子层递归带 rel 全路径', () => {
    const kinds = alpha.files.map(f => f.kind)
    expect(kinds.indexOf('file')).toBeGreaterThan(kinds.lastIndexOf('dir'))
    const preview = alpha.files.find(f => f.name === 'preview')!
    expect(preview.children!.map(c => c.rel).sort()).toEqual(['preview/footer.html', 'preview/hero.html'])
  })

  it('文件带 size/mtime，目录不带（列表里显示 —）', () => {
    const css = alpha.files.find(f => f.name === 'styles.css')!
    expect(css.size).toBeGreaterThan(0)
    expect(css.mtime).toBeGreaterThan(0)
    const dir = alpha.files.find(f => f.kind === 'dir')!
    expect(dir.size).toBeUndefined()
    expect(dir.mtime).toBeUndefined()
  })
})

describe('getDesignSystemManifest — 非法/缺失 name', () => {
  it('name 含 .. 返回 null(路径穿越防护)', () => {
    expect(rm.getDesignSystemManifest('..')).toBeNull()
    expect(rm.getDesignSystemManifest('../etc')).toBeNull()
    expect(rm.getDesignSystemManifest('foo/../bar')).toBeNull()
  })

  it('name 含 / 或 \\ 返回 null', () => {
    expect(rm.getDesignSystemManifest('a/b')).toBeNull()
    expect(rm.getDesignSystemManifest('a\\b')).toBeNull()
  })

  it('空 name / 不存在的目录返回 null', () => {
    expect(rm.getDesignSystemManifest('')).toBeNull()
    expect(rm.getDesignSystemManifest('no-such-system')).toBeNull()
  })

  it('不跟随指向根外的设计系统目录或评审文件符号链接', () => {
    const outsideDir = path.join(TMP, 'outside-design-system')
    fs.mkdirSync(outsideDir)
    fs.writeFileSync(path.join(outsideDir, 'SKILL.md'), '---\nname: Secret\n---')
    fs.symlinkSync(outsideDir, path.join(DS_ROOT, 'linked-system'))
    expect(rm.getDesignSystemManifest('linked-system')).toBeNull()

    seed('review-link/SKILL.md', '# review')
    const outsideReview = path.join(TMP, 'outside-review.json')
    fs.writeFileSync(outsideReview, JSON.stringify({ secret: true }))
    fs.symlinkSync(outsideReview, path.join(DS_ROOT, 'review-link', '_review.json'))
    expect(rm.getDsReview('review-link')).toBeNull()
    expect(rm.saveDsReview('review-link', { updatedAt: 1, cards: {} })).toBe(false)
    expect(fs.readFileSync(outsideReview, 'utf8')).toContain('secret')
  })

  it('不通过 SKILL 或 ui_kits 符号链接识别和枚举外部设计资源', () => {
    const outsideSkill = path.join(TMP, 'outside-skill.md')
    fs.writeFileSync(outsideSkill, '---\nname: Outside\n---')
    fs.mkdirSync(path.join(DS_ROOT, 'skill-link'))
    fs.symlinkSync(outsideSkill, path.join(DS_ROOT, 'skill-link', 'SKILL.md'))
    expect(rm.listDesignSystems().some((item: { name: string }) => item.name === 'skill-link')).toBe(false)

    seed('kits-link/SKILL.md', '# kits')
    const outsideKits = path.join(TMP, 'outside-kits')
    fs.mkdirSync(path.join(outsideKits, 'secret'), { recursive: true })
    fs.writeFileSync(path.join(outsideKits, 'secret', 'index.html'), '<h1>outside</h1>')
    fs.symlinkSync(outsideKits, path.join(DS_ROOT, 'kits-link', 'ui_kits'))
    expect(rm.getDesignSystemManifest('kits-link')?.kits).toEqual([])
  })
})

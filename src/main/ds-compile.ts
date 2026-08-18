/**
 * ds-compile —— 设计系统新格式编译器（W4，对齐官方 Claude Design Agent 产出）
 *
 * 吃本地 Node 编译优势：官方 agent 在浏览器沙箱靠宿主编译器，我方主进程一条 require
 * 就地编译（esbuild 0.21.5 转 jsx + typescript 5.9.3 解析 .d.ts）。
 *
 * 对一套有 components jsx + .d.ts 的设计系统（现 neutral-modern-ui），best-effort
 * 落盘三件到 ~/.openpipal/design-systems/<name>/：
 *   _ds_manifest.json      官方 12 键机器索引（namespace/components/cards/tokens/brandFonts…）
 *   _ds_bundle.js          format 4 预编译包，挂到 window.<namespace>，React 使用本地 vendor
 *   _vendor/react*.js      随设计系统复制的离线预览运行时（不依赖第三方 CDN）
 *   _adherence.oxlintrc.json  从 .d.ts 生成的 oxlint 约束（落盘保互操作）
 *
 * 三条铁律遵守：不动 role-manager 的 getDesignSystemManifest / DesignSystemManifest（本模块
 * 自带 card 扫描副本，独立类型/函数/文件）；只对有 jsx 组件的系统产出，legacy CSS-first 系统
 * 无 components jsx → components 为空 → 仍写空壳 manifest 但不破坏画廊（画廊走 @dsCard 派生）。
 */
import fs from 'fs'
import path from 'path'
import os from 'os'
import crypto from 'crypto'
import { resolveDesignSystemDirectory } from './design-system-resource'
import { dataPath } from './data-root'

// ---------------------------------------------------------------------------
// 基础
// ---------------------------------------------------------------------------

function defaultDsRoot(): string {
  return dataPath('design-systems')
}

function findPreviewVendorDir(): string | null {
  const candidates = [
    process.resourcesPath ? path.join(process.resourcesPath, 'dc-runtime', 'vendor') : '',
    path.join(process.cwd(), 'resources', 'dc-runtime', 'vendor'),
    path.resolve(__dirname, '../../resources/dc-runtime/vendor'),
  ].filter(Boolean)
  for (const candidate of candidates) {
    if (
      fs.existsSync(path.join(candidate, 'react.production.min.js'))
      && fs.existsSync(path.join(candidate, 'react-dom.production.min.js'))
    ) return candidate
  }
  return null
}

function ensureSafeChildDirectory(root: string, name: string): string {
  const target = path.join(root, name)
  try {
    const info = fs.lstatSync(target)
    if (!info.isDirectory() || info.isSymbolicLink() || fs.realpathSync.native(target) !== target) {
      throw new Error(`${name} is not a safe local directory`)
    }
  } catch (error: any) {
    if (error?.code !== 'ENOENT') throw error
    fs.mkdirSync(target, { mode: 0o700 })
    const created = fs.lstatSync(target)
    if (!created.isDirectory() || created.isSymbolicLink()) throw new Error(`${name} could not be created safely`)
  }
  return target
}

function writeGeneratedFile(parent: string, fileName: string, data: string | Buffer): string {
  if (path.basename(fileName) !== fileName || fileName === '.' || fileName === '..') {
    throw new Error(`unsafe generated file name: ${fileName}`)
  }
  const target = path.join(parent, fileName)
  try {
    const existing = fs.lstatSync(target)
    if (!existing.isFile() || existing.isSymbolicLink()) throw new Error(`${fileName} is not a safe regular file`)
  } catch (error: any) {
    if (error?.code !== 'ENOENT') throw error
  }

  const temp = path.join(parent, `.${fileName}.tmp-${process.pid}-${crypto.randomBytes(8).toString('hex')}`)
  let fd: number | undefined
  try {
    fd = fs.openSync(
      temp,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW || 0),
      0o600,
    )
    if (!fs.fstatSync(fd).isFile()) throw new Error(`temporary ${fileName} is not a regular file`)
    fs.writeFileSync(fd, data)
    fs.fsyncSync(fd)
    fs.closeSync(fd)
    fd = undefined

    // Recheck a pre-existing leaf for a clearer fail-closed error. rename()
    // itself replaces a raced symlink rather than following it, so the atomic
    // step cannot overwrite the symlink target.
    try {
      const current = fs.lstatSync(target)
      if (!current.isFile() || current.isSymbolicLink()) throw new Error(`${fileName} changed to an unsafe file`)
    } catch (error: any) {
      if (error?.code !== 'ENOENT') throw error
    }
    fs.renameSync(temp, target)
    fs.chmodSync(target, 0o600)
    return target
  } finally {
    if (fd !== undefined) fs.closeSync(fd)
    try { fs.unlinkSync(temp) } catch { /* renamed or never created */ }
  }
}

function installPreviewVendor(dir: string): string[] {
  const source = findPreviewVendorDir()
  if (!source) throw new Error('local React preview vendor is unavailable')
  const target = ensureSafeChildDirectory(dir, '_vendor')
  return ['react.production.min.js', 'react-dom.production.min.js'].map((fileName) => {
    return writeGeneratedFile(target, fileName, fs.readFileSync(path.join(source, fileName)))
  })
}

function sha(input: string, len: number): string {
  return crypto.createHash('sha1').update(input).digest('hex').slice(0, len)
}

/** neutral-modern-ui → NeutralModernUi（namespace 前缀，确定性、非 Math.random） */
function pascalCase(name: string): string {
  const parts = name.split(/[^A-Za-z0-9]+/).filter(Boolean)
  const pc = parts.map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join('')
  // 首字符数字 → JS 标识符非法，前缀 Ds
  return /^[A-Za-z_$]/.test(pc) ? pc : `Ds${pc}`
}

/** <PascalCase(name)>_<6hex>，6hex = sha1(name) 前 6 位；同名可复现 */
export function deriveNamespace(name: string): string {
  return `${pascalCase(name)}_${sha(name, 6)}`
}

function reEscape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function toRel(p: string): string {
  return p.split(path.sep).join('/')
}

/** 递归收集匹配后缀的文件（相对 baseDir 的 posix 路径），跳过隐藏/_ 前缀目录 */
function walkFiles(baseDir: string, subDir: string, suffix: string, maxDepth = 6): string[] {
  const out: string[] = []
  const start = subDir ? path.join(baseDir, subDir) : baseDir
  const walk = (abs: string, rel: string, depth: number): void => {
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(abs, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const childRel = rel ? `${rel}/${e.name}` : e.name
      if (e.isDirectory()) {
        if (e.name.startsWith('.') || e.name.startsWith('_') || e.name === 'node_modules') continue
        if (depth < maxDepth) walk(path.join(abs, e.name), childRel, depth + 1)
        continue
      }
      if (e.isFile() && e.name.toLowerCase().endsWith(suffix)) out.push(childRel)
    }
  }
  walk(start, subDir, 0)
  return out.sort()
}

// ---------------------------------------------------------------------------
// @dsCard 卡片扫描（role-manager 逻辑的独立副本；不改 role-manager 导出）
// ---------------------------------------------------------------------------

const DS_EXCLUDE_DIRS = new Set(['ui_kits', 'assets', 'fonts', 'node_modules', 'screenshots', 'shared'])

function readHead(p: string, n = 500): string {
  try {
    const fd = fs.openSync(p, 'r')
    try {
      const buf = Buffer.alloc(n)
      const bytes = fs.readSync(fd, buf, 0, n, 0)
      return buf.subarray(0, bytes).toString('utf8')
    } finally {
      fs.closeSync(fd)
    }
  } catch {
    return ''
  }
}

function parseDsCardHeader(
  head: string
): { group?: string; name?: string; subtitle?: string; w?: number; h?: number } | null {
  const tag = head.match(/<!--\s*@dsCard\b([\s\S]*?)-->/)
  if (!tag) return null
  const body = tag[1]
  const attr = (k: string): string | undefined => {
    const m = body.match(new RegExp(k + '\\s*=\\s*(["\'])(.*?)\\1'))
    return m ? m[2] : undefined
  }
  const out: { group?: string; name?: string; subtitle?: string; w?: number; h?: number } = {
    group: attr('group'),
    name: attr('name'),
    subtitle: attr('subtitle')
  }
  const vp = attr('viewport')
  const vm = vp?.match(/^\s*(\d+)\s*[xX]\s*(\d+)\s*$/)
  if (vm) {
    out.w = parseInt(vm[1], 10)
    out.h = parseInt(vm[2], 10)
  }
  return out
}

function titleizeCardName(fileName: string): string {
  const base = fileName
    .replace(/\.html$/i, '')
    .replace(/\.card$/i, '')
    .replace(/[-_.]+/g, ' ')
    .trim()
  return base.replace(/\b\w/g, (c) => c.toUpperCase())
}

export interface DsManifestCard {
  path: string
  group: string
  viewport: string
  subtitle: string
  name: string
}

/** 扫 <dir> 下 *.html（深度≤3，排除 ui_kits/assets/… 与 _/. 前缀目录），汇编成官方 cards[] */
function assembleCards(dir: string): DsManifestCard[] {
  const cards: DsManifestCard[] = []
  const walk = (absDir: string, relDir: string, dirDepth: number): void => {
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(absDir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const rel = relDir ? `${relDir}/${e.name}` : e.name
      if (e.isDirectory()) {
        if (e.name.startsWith('_') || e.name.startsWith('.') || DS_EXCLUDE_DIRS.has(e.name)) continue
        if (dirDepth < 3) walk(path.join(absDir, e.name), rel, dirDepth + 1)
        continue
      }
      if (!e.isFile() || !e.name.toLowerCase().endsWith('.html')) continue
      const header = parseDsCardHeader(readHead(path.join(absDir, e.name)))
      const topDir = relDir ? relDir.split('/')[0] : 'general'
      const w = header?.w ?? 700
      const h = Math.min(header?.h ?? 400, 640)
      cards.push({
        path: rel,
        group: header?.group || topDir,
        viewport: `${w}x${h}`,
        subtitle: header?.subtitle || '',
        name: header?.name || titleizeCardName(e.name)
      })
    }
  }
  walk(dir, '', 0)
  // ui_kits/<dir>/index.html 也计入 cards（整屏 kit 卡）
  try {
    for (const e of fs.readdirSync(path.join(dir, 'ui_kits'), { withFileTypes: true })) {
      if (!e.isDirectory() || e.name.startsWith('.') || e.name.startsWith('_')) continue
      const idx = path.join(dir, 'ui_kits', e.name, 'index.html')
      if (fs.existsSync(idx)) {
        const header = parseDsCardHeader(readHead(idx))
        const w = header?.w ?? 1360
        const h = Math.min(header?.h ?? 820, 1200)
        cards.push({
          path: `ui_kits/${e.name}/index.html`,
          group: header?.group || 'UI Kits',
          viewport: `${w}x${h}`,
          subtitle: header?.subtitle || '',
          name: header?.name || titleizeCardName(e.name)
        })
      }
    }
  } catch {
    /* 无 ui_kits */
  }
  return cards.sort((a, b) => a.path.localeCompare(b.path))
}

// ---------------------------------------------------------------------------
// CSS token 静态解析
// ---------------------------------------------------------------------------

export type TokenKind = 'color' | 'font' | 'spacing' | 'radius' | 'shadow' | 'other'

export interface DsToken {
  name: string
  value: string
  kind: TokenKind
  definedIn: string
  annotation?: string
}

const COLORISH = /(#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(|oklch\(|oklab\(|lab\(|lch\(|color-mix\()/

/**
 * token 名里的关键词按**连字符段**匹配，不锚定在 `--` 后第一段。
 *
 * 品牌 token 几乎都带命名空间（`--acme-font-body`、`--sw-text-xs`），锚定首段会让它们整批
 * 认不出来——而且是静默的：字体 token 归错类 → 抽不出 brandFonts → 那条「只允许用设计系统字体」
 * 的告警规则根本不生成，作者拿不到任何反馈。shadow/radius 两条本来就有 `\b` 兜底，
 * spacing/font 两条漏了，这里补齐口径。
 */
const SEG = (words: string) => new RegExp(`(^|-)(${words})(-|$)`)
const FONT_SEG = SEG('font|text|leading|tracking|weight|line-height|letter')
const SPACING_SEG = SEG('space|spacing|gap|size|width|height|measure|sidebar|container|topbar|inset|gutter')

function inferKind(name: string, value: string): TokenKind {
  const n = name.toLowerCase().replace(/^--/, '')
  if (/(^|-)shadow(-|$)/.test(n)) return 'shadow'
  if (/(^|-)(radius|corner)(-|$)/.test(n)) return 'radius'
  // 值是色值就是颜色，先于一切名字猜测——值是事实，名字是猜。
  // （否则 `--text-primary: #333` 会因为名字里有 text 被判成 font，这是本次修正前的真实错分。）
  if (COLORISH.test(value)) return 'color'
  // font 排在 spacing 前：`--font-size` 两边都命中，它是字号不是间距
  if (FONT_SEG.test(n)) return 'font'
  if (SPACING_SEG.test(n)) return 'spacing'
  // 无名称提示的纯长度值（4px / 1.5rem …）归 spacing
  if (/^-?\d*\.?\d+(px|rem|em|ch|vh|vw|vmin|vmax)$/.test(value.trim())) return 'spacing'
  if (/color|bg|fg|ink|paper|surface|border|accent|success|error|warning|danger|info|ring|focus|text/.test(n))
    return 'color'
  return 'other'
}

/** 解析 :root { --x: y; } —— 先剥非 @kind 注释（含块内伪声明），再逐 declaration 抓取 */
export function parseTokens(cssText: string, definedIn: string): DsToken[] {
  // 剥掉不是 @kind 的块注释（多行也剥），保留 /* @kind X */ 旁注
  const cleaned = cssText.replace(/\/\*(?!\s*@kind\b)[\s\S]*?\*\//g, '')
  const tokens: DsToken[] = []
  const seen = new Set<string>()
  const re = /(--[A-Za-z0-9-]+)\s*:\s*([^;{}]+?)\s*;(\s*\/\*\s*@kind\s+([A-Za-z0-9-]+)\s*\*\/)?/g
  let m: RegExpExecArray | null
  while ((m = re.exec(cleaned)) !== null) {
    const name = m[1]
    const value = m[2].trim()
    const explicit = m[4] as string | undefined
    // 同名后定义覆盖前定义（CSS 语义）；这里以首次出现为准并跳过重复，避免暗色 :root 覆盖噪音
    if (seen.has(name)) continue
    seen.add(name)
    const kind = (explicit && ['color', 'font', 'spacing', 'radius', 'shadow', 'other'].includes(explicit)
      ? explicit
      : inferKind(name, value)) as TokenKind
    const tok: DsToken = { name, value, kind, definedIn }
    if (explicit) tok.annotation = explicit
    tokens.push(tok)
  }
  return tokens
}

// ---------------------------------------------------------------------------
// 字体
// ---------------------------------------------------------------------------

export interface DsBrandFont {
  family: string
  status: string
  tokens: string[]
  path: string
}

const SYSTEM_FONTS = new Set(
  [
    '-apple-system',
    'blinkmacsystemfont',
    'system-ui',
    'ui-sans-serif',
    'ui-serif',
    'ui-monospace',
    'ui-rounded',
    'segoe ui',
    'roboto',
    'roboto mono',
    'helvetica neue',
    'helvetica',
    'arial',
    'sans-serif',
    'serif',
    'monospace',
    'sf mono',
    'sf pro',
    'menlo',
    'monaco',
    'consolas',
    'courier new',
    'courier',
    'fira code',
    'cascadia code',
    'pingfang sc',
    'microsoft yahei',
    'noto sans',
    'noto serif',
    'emoji'
  ].map((s) => s.toLowerCase())
)

/** 从 font-kind token 抽首个非系统字族 → brandFonts；@font-face 的静态字体 → fonts */
function collectFonts(tokens: DsToken[]): { brandFonts: DsBrandFont[]; fonts: DsBrandFont[] } {
  const byFamily = new Map<string, DsBrandFont>()
  for (const t of tokens) {
    if (t.kind !== 'font') continue
    const quoted = Array.from(t.value.matchAll(/['"]([^'"]+)['"]/g)).map((mm) => mm[1])
    const brand = quoted.find((q) => !SYSTEM_FONTS.has(q.trim().toLowerCase()))
    if (!brand) continue
    const key = brand.trim()
    if (!byFamily.has(key)) byFamily.set(key, { family: key, status: 'ok', tokens: [], path: t.definedIn })
    const entry = byFamily.get(key)!
    if (!entry.tokens.includes(t.name)) entry.tokens.push(t.name)
  }
  return { brandFonts: Array.from(byFamily.values()), fonts: [] }
}

/** 扫 css 里的静态 @font-face → fonts[]（CDN @import 不算，与官方一致） */
function collectFontFaces(cssTexts: { text: string; rel: string }[]): DsBrandFont[] {
  const out: DsBrandFont[] = []
  const seen = new Set<string>()
  for (const { text, rel } of cssTexts) {
    for (const block of Array.from(text.matchAll(/@font-face\s*\{([^}]*)\}/g))) {
      const fam = block[1].match(/font-family\s*:\s*['"]?([^'";]+)['"]?/)
      if (!fam) continue
      const family = fam[1].trim()
      if (seen.has(family)) continue
      seen.add(family)
      out.push({ family, status: 'ok', tokens: [], path: rel })
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// globalCssPaths
// ---------------------------------------------------------------------------

/** styles.css 的 @import 顺序（去 ./，末尾追加 styles.css）；无 styles.css → 枚举 tokens/*.css */
function resolveGlobalCssPaths(dir: string): string[] {
  const stylesPath = path.join(dir, 'styles.css')
  if (fs.existsSync(stylesPath)) {
    let text = ''
    try {
      text = fs.readFileSync(stylesPath, 'utf8')
    } catch {
      /* ignore */
    }
    const paths: string[] = []
    for (const m of Array.from(text.matchAll(/@import\s+(?:url\()?\s*['"]([^'"]+)['"]/g))) {
      const p = m[1].replace(/^\.\//, '')
      if (!paths.includes(p)) paths.push(p)
    }
    paths.push('styles.css')
    return paths
  }
  // 兜底：枚举 tokens/*.css
  return walkFiles(dir, 'tokens', '.css', 2)
}

// ---------------------------------------------------------------------------
// .jsx 组件源改写（供 bundle）
// ---------------------------------------------------------------------------

interface JsxModule {
  src: string // 剥 import/export 后的源
  exportNames: string[] // 具名导出（组件）
  siblingNames: string[] // 从 ./x.jsx 引入的同系统组件本地名
}

function importedLocalNames(clause: string): string[] {
  const names: string[] = []
  // 具名: { A, B as C }
  const braced = clause.match(/\{([^}]*)\}/)
  if (braced) {
    for (const part of braced[1].split(',')) {
      const seg = part.trim()
      if (!seg) continue
      const asMatch = seg.split(/\s+as\s+/)
      names.push((asMatch[1] || asMatch[0]).trim())
    }
  }
  // 默认 / 命名空间: 去掉 { } 段后剩余的首标识符
  const rest = clause.replace(/\{[^}]*\}/, '').replace(/,/g, ' ')
  const ns = rest.match(/\*\s+as\s+([A-Za-z0-9_$]+)/)
  if (ns) names.push(ns[1])
  else {
    const def = rest.trim().match(/^([A-Za-z0-9_$]+)/)
    if (def) names.push(def[1])
  }
  return names.filter(Boolean)
}

function transformComponentSource(source: string): JsxModule {
  const siblingNames: string[] = []
  let src = source
  // import X from 'mod' / import {A} from 'mod' / import * as N from 'mod'
  src = src.replace(/^[ \t]*import\s+([\s\S]*?)\s+from\s*['"]([^'"]+)['"]\s*;?[ \t]*$/gm, (_m, clause, mod) => {
    if (/^react(\/.*)?$/i.test(mod)) return '' // React 外置全局
    if (/^\.\.?\//.test(mod)) {
      for (const n of importedLocalNames(clause)) if (!siblingNames.includes(n)) siblingNames.push(n)
      return ''
    }
    // 其它外部依赖：无法内联，剥掉（best-effort；DS 组件极少见）
    return ''
  })
  // bare import 'x.css'
  src = src.replace(/^[ \t]*import\s*['"][^'"]+['"]\s*;?[ \t]*$/gm, '')

  const exportNames: string[] = []
  src = src.replace(/\bexport\s+default\s+function\s+([A-Za-z0-9_$]+)/g, (_m, n) => {
    exportNames.push(n)
    return `function ${n}`
  })
  src = src.replace(/\bexport\s+(function|const|let|var|class)\s+([A-Za-z0-9_$]+)/g, (_m, kw, n) => {
    exportNames.push(n)
    return `${kw} ${n}`
  })
  src = src.replace(/\bexport\s*\{([^}]*)\}\s*;?/g, (_m, inner: string) => {
    for (const part of inner.split(',')) {
      const nm = part.trim().split(/\s+as\s+/)[0].trim()
      if (nm) exportNames.push(nm)
    }
    return ''
  })

  return {
    src,
    exportNames: Array.from(new Set(exportNames)),
    siblingNames: Array.from(new Set(siblingNames))
  }
}

// ---------------------------------------------------------------------------
// .d.ts 解析（typescript.createSourceFile）
// ---------------------------------------------------------------------------

interface DtsInterface {
  component: string // 组件名（去 Props 后缀）或伪组件（数据形状接口名）
  props: string[]
  enums: { prop: string; values: string[] }[]
}

function parseDts(text: string, fileName: string): DtsInterface[] {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const ts = require('typescript')
  const sf = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true)
  const results: DtsInterface[] = []

  const literalUnionValues = (typeNode: any): string[] | null => {
    if (!typeNode) return null
    const collect = (node: any): string[] | null => {
      if (ts.isLiteralTypeNode(node) && ts.isStringLiteral(node.literal)) return [node.literal.text]
      return null
    }
    if (ts.isUnionTypeNode(typeNode)) {
      const vals: string[] = []
      for (const t of typeNode.types) {
        const v = collect(t)
        if (!v) return null // 非纯字符串字面量联合 → 不算枚举
        vals.push(...v)
      }
      return vals.length ? vals : null
    }
    const single = collect(typeNode)
    return single
  }

  for (const stmt of sf.statements) {
    if (!ts.isInterfaceDeclaration(stmt)) continue
    const ifaceName: string = stmt.name.text
    const component = /Props$/.test(ifaceName) ? ifaceName.replace(/Props$/, '') : ifaceName
    if (!component) continue
    const props: string[] = []
    const enums: { prop: string; values: string[] }[] = []
    for (const member of stmt.members) {
      if (!ts.isPropertySignature(member) || !member.name) continue
      let propName = ''
      if (ts.isIdentifier(member.name)) propName = member.name.text
      else if (ts.isStringLiteral(member.name)) propName = member.name.text
      else continue
      if (!propName || propName.includes('[')) continue
      props.push(propName)
      const vals = literalUnionValues(member.type)
      if (vals && vals.length) enums.push({ prop: propName, values: vals })
    }
    results.push({ component, props, enums })
  }
  return results
}

// ---------------------------------------------------------------------------
// _adherence.oxlintrc.json 组装
// ---------------------------------------------------------------------------

interface AdherenceModel {
  oxlintrc: any
  // 组件/字体结构化模型（随 oxlintrc 的 x-openpipal 字段落盘）
  fontFamilies: string[]
  components: { name: string; props: string[]; enums: { prop: string; values: string[] }[] }[]
}

function buildAdherence(
  dir: string,
  tokens: DsToken[],
  fontFamilies: string[]
): AdherenceModel {
  const dtsFiles = walkFiles(dir, 'components', '.d.ts')
  const compMap = new Map<string, DtsInterface>()
  for (const rel of dtsFiles) {
    let text = ''
    try {
      text = fs.readFileSync(path.join(dir, rel), 'utf8')
    } catch {
      continue
    }
    for (const iface of parseDts(text, rel)) {
      // 同名接口以首见为准
      if (!compMap.has(iface.component)) compMap.set(iface.component, iface)
    }
  }
  const components = Array.from(compMap.values()).sort((a, b) => a.component.localeCompare(b.component))

  const TAIL = ['key', 'ref', 'className', 'style', 'children']

  // no-restricted-syntax: 3 条全局禁令 + 每组件 prop 白名单 + 枚举
  const restrictedSyntax: any[] = ['warn']
  restrictedSyntax.push({
    selector: 'Literal[value=/#[0-9a-fA-F]{3,8}\\b/]',
    message: 'Raw hex color — use a design-system color token via var().'
  })
  restrictedSyntax.push({
    selector: 'Literal[value=/\\b\\d+px\\b/]',
    message: 'Raw px value — use a design-system spacing token via var().'
  })
  if (fontFamilies.length) {
    const alt = fontFamilies.map((f) => reEscape(f)).join('|')
    restrictedSyntax.push({
      selector: `Literal[value=/font-family\\s*:\\s*(?!['"]?(?:${alt}))/i]`,
      message: `Font not provided by the design system. Available: ${fontFamilies.join(', ')}.`
    })
  }
  for (const c of components) {
    const comp = c.component
    const whitelist = [...c.props, ...TAIL]
    restrictedSyntax.push({
      selector: `JSXOpeningElement[name.name='${comp}'] > JSXAttribute > JSXIdentifier[name!=/^(?:${whitelist.join(
        '|'
      )})$/]`,
      message: `<${comp}> doesn't accept that prop. Declared props: ${c.props.join(', ')}.`
    })
    for (const en of c.enums) {
      const alt = en.values.map((v) => reEscape(v)).join('|')
      restrictedSyntax.push({
        selector: `JSXOpeningElement[name.name='${comp}'] > JSXAttribute[name.name='${en.prop}'] > Literal[value!=/^(?:${alt})$/]`,
        message: `<${comp}> ${en.prop} must be one of ${en.values.map((v) => `'${v}'`).join(' | ')}.`
      })
    }
  }

  const componentDirs = Array.from(
    new Set(dtsFiles.map((r) => r.split('/').slice(0, -1).join('/') + '/**'))
  ).sort()

  const tokenNames = tokens.map((t) => t.name)
  const tokenKinds: Record<string, string> = {}
  for (const t of tokens) tokenKinds[t.name] = t.kind
  const xComponents: Record<string, any> = {}
  for (const c of components) {
    const enums: Record<string, string[]> = {}
    for (const en of c.enums) enums[en.prop] = en.values
    xComponents[c.component] = { replaces: [], props: c.props, enums }
  }

  const oxlintrc = {
    plugins: ['react', 'import'],
    rules: {
      'react/forbid-elements': ['warn', { forbid: [] }],
      'no-restricted-imports': [
        'warn',
        {
          patterns: componentDirs.length
            ? [
                {
                  group: componentDirs,
                  message: "Import design-system components from 'index.js', not component internals."
                }
              ]
            : []
        }
      ],
      'no-restricted-syntax': restrictedSyntax
    },
    overrides: [{ files: ['**/index.js'], rules: { 'no-restricted-imports': 'off' } }],
    'x-openpipal': {
      components: xComponents,
      tokens: tokenNames,
      tokenKinds,
      fontFamilies
    }
  }

  return {
    oxlintrc,
    fontFamilies,
    components: components.map((c) => ({ name: c.component, props: c.props, enums: c.enums }))
  }
}

// ---------------------------------------------------------------------------
// 主编译入口
// ---------------------------------------------------------------------------

export interface CompileResult {
  ok: boolean
  files: string[]
  errors: string[]
}

function validName(name: string): boolean {
  return !!name && name !== '.' && !name.includes('/') && !name.includes('\\') && !name.includes('..')
}

/**
 * 编译一套设计系统 → 落盘 _ds_manifest.json / _ds_bundle.js / _adherence.oxlintrc.json。
 * best-effort：单件失败不阻断其余，错误进 errors 回传（含每个 jsx 的 esbuild 语法错，让模型自修）。
 * rootDir 可选（测试用临时 fixture 根）；缺省 ~/.openpipal/design-systems。
 */
export function compileDesignSystem(name: string, rootDir?: string): CompileResult {
  const files: string[] = []
  const errors: string[] = []
  if (!validName(name)) return { ok: false, files, errors: [`invalid design system name: ${name}`] }
  const dir = resolveDesignSystemDirectory(name, { rootDir: rootDir || defaultDsRoot() })
  if (!dir) {
    return { ok: false, files, errors: [`design system not found: ${name}`] }
  }

  const namespace = deriveNamespace(name)

  // Preview HTML runs under a no-network CSP. Always refresh these trusted,
  // local React assets so generated cards and UI kits never depend on a CDN.
  try {
    files.push(...installPreviewVendor(dir))
  } catch (err: any) {
    errors.push(`_vendor: ${err?.message || String(err)}`)
  }

  // ---- 扫组件 jsx（components + ui_kits）----
  const componentJsx = walkFiles(dir, 'components', '.jsx')
  const uiKitJsx = walkFiles(dir, 'ui_kits', '.jsx')
  const allJsx = [...componentJsx, ...uiKitJsx]

  // ---- manifest.components（每个 components/ jsx 一条，name=主导出或文件名）----
  const manifestComponents: { name: string; sourcePath: string }[] = []
  const perFileExports = new Map<string, { exportNames: string[]; siblingNames: string[]; src: string }>()
  for (const rel of allJsx) {
    let source = ''
    try {
      source = fs.readFileSync(path.join(dir, rel), 'utf8')
    } catch {
      continue
    }
    perFileExports.set(rel, transformComponentSource(source))
  }
  for (const rel of componentJsx) {
    const base = rel.split('/').pop()!.replace(/\.jsx$/i, '')
    const exps = perFileExports.get(rel)?.exportNames || []
    const primary = exps.includes(base) ? base : exps[0] || base
    manifestComponents.push({ name: primary, sourcePath: rel })
  }

  // ---- tokens / css ----
  const globalCssPaths = resolveGlobalCssPaths(dir)
  const tokenSources = globalCssPaths.filter((p) => p !== 'styles.css')
  const tokens: DsToken[] = []
  const cssTexts: { text: string; rel: string }[] = []
  for (const rel of tokenSources) {
    try {
      const text = fs.readFileSync(path.join(dir, rel), 'utf8')
      cssTexts.push({ text, rel })
      tokens.push(...parseTokens(text, rel))
    } catch {
      /* 缺文件跳过 */
    }
  }
  const { brandFonts } = collectFonts(tokens)
  const staticFonts = collectFontFaces(cssTexts)
  const fontFamilies = brandFonts.map((f) => f.family).sort()

  // ---- A1: _ds_manifest.json ----
  try {
    const manifest = {
      namespace,
      components: manifestComponents,
      startingPoints: [] as any[],
      cards: assembleCards(dir),
      templates: [] as any[],
      hasThumbnailHtml: fs.existsSync(path.join(dir, 'thumbnail.html')),
      globalCssPaths,
      tokens,
      themes: [] as any[],
      fonts: staticFonts,
      brandFonts,
      source: 'openpipal'
    }
    const p = writeGeneratedFile(dir, '_ds_manifest.json', JSON.stringify(manifest, null, 2))
    files.push(p)
  } catch (err: any) {
    errors.push(`_ds_manifest.json: ${err?.message || String(err)}`)
  }

  // ---- A2: _ds_bundle.js（format 4）----
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const esbuild = require('esbuild')
    const sourceHashes: Record<string, string> = {}
    const blocks: string[] = []
    const publicNames: string[] = []
    const unexposed: string[] = []
    for (const rel of allJsx) {
      const mod = perFileExports.get(rel)
      if (!mod) continue
      let raw = ''
      try {
        raw = fs.readFileSync(path.join(dir, rel), 'utf8')
      } catch {
        continue
      }
      sourceHashes[rel] = sha(raw, 12)
      let js = ''
      try {
        js = esbuild.transformSync(mod.src, { loader: 'jsx' }).code
      } catch (err: any) {
        const msg = (err?.message || String(err)).replace(/\s+/g, ' ').trim().slice(0, 200)
        errors.push(`${rel}: ${msg}`)
        blocks.push(
          `// ${rel} (skipped: compile error)\n__ds_ns.__errors.push({ path: ${JSON.stringify(
            rel
          )}, error: ${JSON.stringify(msg)} });`
        )
        continue
      }
      // 组件间引用 late-binding：<Icon/> → React.createElement(Icon,…) → __ds_scope.Icon（求值时解析，序无关）
      for (const sib of mod.siblingNames) {
        js = js.replace(new RegExp(`(?<![.\\w$])${reEscape(sib)}(?![\\w$])`, 'g'), `__ds_scope.${sib}`)
      }
      const assign = mod.exportNames.length
        ? `Object.assign(__ds_scope, { ${mod.exportNames.join(', ')} });`
        : ''
      blocks.push(
        `// ${rel}\ntry { (function(){\n${js}\n${assign}\n})(); } catch (e) { __ds_ns.__errors.push({ path: ${JSON.stringify(
          rel
        )}, error: String(e && e.message || e) }); }`
      )
      const isPublic = rel.startsWith('components/')
      for (const n of mod.exportNames) {
        if (isPublic) publicNames.push(n)
        else unexposed.push(n)
      }
    }
    const exposeLines = Array.from(new Set(publicNames))
      .map((n) => `__ds_ns.${n} = __ds_scope.${n};`)
      .join('\n')
    const header = `/* @ds-bundle: ${JSON.stringify({
      format: 4,
      namespace,
      components: manifestComponents,
      sourceHashes,
      inlinedExternals: [],
      unexposedExports: Array.from(new Set(unexposed))
    })} */`
    const bundle = `${header}
(function(){
  var __ds_ns = (window.${namespace} = window.${namespace} || {});
  var __ds_scope = {};
  __ds_ns.__errors = __ds_ns.__errors || [];

${blocks.join('\n\n')}

${exposeLines}
})();
`
    const p = writeGeneratedFile(dir, '_ds_bundle.js', bundle)
    files.push(p)
  } catch (err: any) {
    errors.push(`_ds_bundle.js: ${err?.message || String(err)}`)
  }

  // ---- A3: _adherence.oxlintrc.json ----
  try {
    const model = buildAdherence(dir, tokens, fontFamilies)
    const p = writeGeneratedFile(dir, '_adherence.oxlintrc.json', JSON.stringify(model.oxlintrc, null, 2))
    files.push(p)
  } catch (err: any) {
    errors.push(`_adherence.oxlintrc.json: ${err?.message || String(err)}`)
  }

  return { ok: errors.length === 0, files, errors }
}

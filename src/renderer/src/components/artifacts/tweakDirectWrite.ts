/**
 * P1 元素微调面板的"样式直写"确定性阶梯（对标官方：用户就地改样式，宿主确定性写入零 Agent 参与）。
 * 纯函数，不碰 DOM/iframe/React state——HtmlPreview.tsx 负责调用与落盘。
 *
 * 背景：.dc.html 是模板（x-dc 语法 + {{ }} 空穴），iframe 里的 DOM 是渲染结果；DOM 上的属性值
 * 可能在源码里根本不存在（模板插值算出来的）。定位失败因此是常态路径，任何一级不唯一/找不到
 * 都必须静默降级返回 null，不抛错——调用方据此决定是否转成 AI mention 请求兜底。
 */

export interface TweakLocateAnchor {
  /** 元素标签名（小写），用于阶梯 (c) 文本回溯时匹配开标签 */
  tagName: string
  /** 拾取时快照的 outerHTML 开标签串（从 < 到首个 >，截断到 300 字符）——阶梯 (a)(b) 用 */
  outerHead?: string
  /** 用于定位的文本内容（阶梯 (c)）——调用方按"本次 commit 文本是否已直写"决定传旧文本还是新文本 */
  text?: string
}

export interface LocatedTag {
  /** 开标签 '<' 在 source 中的下标 */
  tagStart: number
  /** 开标签结束 '>' 之后一位的下标（source.slice(tagStart, tagEnd) === 完整开标签串） */
  tagEnd: number
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * 从 tagStart（'<' 的位置）开始扫描，找到该开标签真正的结束 '>'（跳过引号内的 '>'，
 * 如 title="a>b"），返回其后一位下标；找不到返回 -1。
 */
function findTagEnd(source: string, tagStart: number): number {
  let quote: string | null = null
  for (let i = tagStart + 1; i < source.length; i++) {
    const c = source[i]
    if (quote) {
      if (c === quote) quote = null
      continue
    }
    if (c === '"' || c === "'") { quote = c; continue }
    if (c === '>') return i + 1
  }
  return -1
}

/**
 * 在整份源码里找 attrName="value"（或单引号）且左边界是空白/标签起始（避免 data-id
 * 之类的属性名把 id 命中成子串），要求全源码唯一命中——否则返回 null（不唯一/未找到）。
 * 返回命中的属性名起始下标（用于回溯定位其所在的开标签）。
 */
function findUniqueAttrOccurrence(source: string, attrName: string, value: string): number | null {
  const re = new RegExp(`(^|[\\s<])${escapeRegExp(attrName)}\\s*=\\s*(["'])${escapeRegExp(value)}\\2`, 'g')
  let match: RegExpExecArray | null
  let idx: number | null = null
  let count = 0
  while ((match = re.exec(source)) !== null) {
    count++
    idx = match.index + match[1].length
    if (count > 1) return null
  }
  return count === 1 ? idx : null
}

/** 由某个属性名在源码中的下标，回溯出它所属开标签的 [tagStart, tagEnd) */
function tagBoundsFromAttrIndex(source: string, attrIdx: number): LocatedTag | null {
  const tagStart = source.lastIndexOf('<', attrIdx)
  if (tagStart === -1) return null
  const tagEnd = findTagEnd(source, tagStart)
  if (tagEnd === -1 || attrIdx >= tagEnd) return null // attrIdx 落在这个标签闭合之后——不属于它，判定失败
  return { tagStart, tagEnd }
}

/** 阶梯 (a)：outerHead 里若带 id 属性，按 id="..." 在全源码唯一命中定位 */
function locateById(source: string, outerHead: string | undefined): LocatedTag | null {
  if (!outerHead) return null
  const idMatch = /\bid\s*=\s*(["'])([^"']*)\1/.exec(outerHead)
  if (!idMatch || !idMatch[2]) return null
  const idx = findUniqueAttrOccurrence(source, 'id', idMatch[2])
  if (idx === null) return null
  return tagBoundsFromAttrIndex(source, idx)
}

/** 阶梯 (b)：outerHead 整串（开标签快照，可能被截断到 300 字符）在源码唯一命中 */
function locateByOuterHead(source: string, outerHead: string | undefined): LocatedTag | null {
  if (!outerHead) return null
  const idx = source.indexOf(outerHead)
  if (idx === -1 || idx !== source.lastIndexOf(outerHead)) return null
  const tagEnd = findTagEnd(source, idx)
  if (tagEnd === -1) return null
  return { tagStart: idx, tagEnd }
}

/** 从 beforeIdx 之前的源码区间里，找最靠近 beforeIdx 的 <tagName（后接空白/斜杠/>，避免 div 误命中 divider） */
function findLastOpenTagBefore(source: string, beforeIdx: number, tagName: string): number | null {
  if (!tagName) return null
  const region = source.slice(0, beforeIdx)
  const re = new RegExp(`<${escapeRegExp(tagName)}(?=[\\s/>])`, 'gi')
  let match: RegExpExecArray | null
  let last: number | null = null
  while ((match = re.exec(region)) !== null) last = match.index
  return last
}

/** 阶梯 (c)：text 在源码唯一命中后，向前回溯最近的同 tagName 开标签 */
function locateByTextBacktrack(source: string, tagName: string, text: string | undefined): LocatedTag | null {
  if (!tagName || !text) return null
  const idx = source.indexOf(text)
  if (idx === -1 || idx !== source.lastIndexOf(text)) return null
  const tagStart = findLastOpenTagBefore(source, idx, tagName)
  if (tagStart === null) return null
  const tagEnd = findTagEnd(source, tagStart)
  if (tagEnd === -1) return null
  return { tagStart, tagEnd }
}

/**
 * 保守阶梯定位：(a) id → (b) outerHead 开标签快照 → (c) 文本回溯。任何一级不唯一/找不到
 * 立刻降级到下一级；全部失败返回 null（调用方据此转 AI mention 兜底，不报错）。
 */
export function locateElementInSource(source: string, anchor: TweakLocateAnchor): LocatedTag | null {
  if (!source) return null
  return locateById(source, anchor.outerHead)
    || locateByOuterHead(source, anchor.outerHead)
    || locateByTextBacktrack(source, anchor.tagName, anchor.text)
}

/** 面板字段的 camelCase 内联样式 key（如 backgroundColor，与 live 预览 el.style[key]=v 用的是同一套）→ 真实 CSS kebab-case 属性名 */
export function styleKeyToCssProp(key: string): string {
  return key.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase()
}

interface StyleDecl { key: string; value: string }

function parseStyleDecls(styleContent: string): StyleDecl[] {
  return styleContent
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((decl) => {
      const idx = decl.indexOf(':')
      if (idx === -1) return { key: decl, value: '' }
      return { key: decl.slice(0, idx).trim(), value: decl.slice(idx + 1).trim() }
    })
}

/** 属性值里若含与外层引号相同的字符，转义成 HTML entity，避免拼出破损的 style="..." */
function escapeForAttr(value: string, quote: string): string {
  return quote === '"' ? value.replace(/"/g, '&quot;') : value.replace(/'/g, '&#39;')
}

function serializeStyleDecls(decls: StyleDecl[], quote: string): string {
  return decls.map((d) => `${escapeForAttr(d.key, quote)}: ${escapeForAttr(d.value, quote)}`).join('; ')
}

/** 单个开标签串内合并 style：已有 style 属性→解析合并去重（同名键覆盖，其余保留）；没有→新增属性 */
function mergeStyleIntoTagString(tag: string, styleDiff: Record<string, string>): string {
  const attrRe = /(\sstyle\s*=\s*)(["'])([\s\S]*?)\2/i
  const m = attrRe.exec(tag)
  if (m) {
    const quote = m[2]
    const decls = parseStyleDecls(m[3])
    for (const [k, v] of Object.entries(styleDiff)) {
      const lower = k.toLowerCase()
      const existingIdx = decls.findIndex((d) => d.key.toLowerCase() === lower)
      if (existingIdx !== -1) decls[existingIdx] = { key: k, value: v }
      else decls.push({ key: k, value: v })
    }
    const nextContent = serializeStyleDecls(decls, quote)
    const replacement = `${m[1]}${quote}${nextContent}${quote}`
    return tag.slice(0, m.index) + replacement + tag.slice(m.index + m[0].length)
  }
  const quote = '"'
  const decls: StyleDecl[] = Object.entries(styleDiff).map(([key, value]) => ({ key, value }))
  const content = serializeStyleDecls(decls, quote)
  return insertNewStyleAttr(tag, content, quote)
}

/**
 * 没有 style 属性时的插入：定位到属性区真正的结尾（吃掉 '>' /（自闭合的）'/>' 前的空白），
 * 避免在原有尾部空白基础上再拼一个前导空格产生双空格；自闭合标签补回单个空格与 '/>' 惯用写法。
 */
function insertNewStyleAttr(tag: string, content: string, quote: string): string {
  const closeIdx = tag.length - 1 // '>' 的下标
  let bodyEnd = closeIdx
  let selfClosing = false
  if (tag[bodyEnd - 1] === '/') { selfClosing = true; bodyEnd -= 1 }
  while (bodyEnd > 0 && /\s/.test(tag[bodyEnd - 1])) bodyEnd -= 1
  const before = tag.slice(0, bodyEnd)
  const tail = selfClosing ? ' />' : '>'
  return `${before} style=${quote}${content}${quote}${tail}`
}

/**
 * 把变更的样式键值对（key 已是 kebab-case CSS 属性名——调用方经 styleKeyToCssProp 转换）
 * 合并进 [tagStart, tagEnd) 这段开标签串的 style="..."，返回合并后的完整 source。
 * tagStart/tagEnd 非法或 styleDiff 为空时原样返回 source（防御性 no-op，不抛错）。
 */
export function mergeStyleIntoTag(source: string, tagStart: number, tagEnd: number, styleDiff: Record<string, string>): string {
  if (tagStart < 0 || tagEnd <= tagStart || tagEnd > source.length) return source
  if (!styleDiff || Object.keys(styleDiff).length === 0) return source
  const tag = source.slice(tagStart, tagEnd)
  const nextTag = mergeStyleIntoTagString(tag, styleDiff)
  return source.slice(0, tagStart) + nextTag + source.slice(tagEnd)
}

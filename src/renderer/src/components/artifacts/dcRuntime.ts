const supportJsRaw = '' // 本发行版不含设计运行时，见 OPEN-SOURCE-CUT.json
const reactUmdRaw = '' // 本发行版不含设计运行时，见 OPEN-SOURCE-CUT.json
const reactDomUmdRaw = '' // 本发行版不含设计运行时，见 OPEN-SOURCE-CUT.json
const deckStageRaw = '' // 本发行版不含设计运行时，见 OPEN-SOURCE-CUT.json
const animationsCompiledRaw = '' // 本发行版不含设计运行时，见 OPEN-SOURCE-CUT.json
const iosFrameCompiledRaw = '' // 本发行版不含设计运行时，见 OPEN-SOURCE-CUT.json
const androidFrameCompiledRaw = '' // 本发行版不含设计运行时，见 OPEN-SOURCE-CUT.json
const imageSlotRaw = '' // 本发行版不含设计运行时，见 OPEN-SOURCE-CUT.json
const docPageRaw = '' // 本发行版不含设计运行时，见 OPEN-SOURCE-CUT.json
const threeDStageRaw = '' // 本发行版不含设计运行时，见 OPEN-SOURCE-CUT.json

/**
 * 非 DC 裸 HTML 的已知预制脚本内联（3D 舞台走 <script type="module" src="./three-d-stage.js">，
 * 不经 x-dc 的 from 机制）。srcdoc 无相对路径可解析——同 support.js 一样宿主内联；
 * inline module 里的裸 'three' 说明符仍由页面 importmap 解析，语义不变。
 * 官方 three-d-stage.js 的 JSDoc 用法示例里字面含 "</script>"（贴的是调用方骨架片段），
 * 内联前必须转义，否则浏览器会在文档注释里就把 <script> 提前判闭，同 KNOWN_SIBLINGS 的既有处理。
 */
export function inlineKnownScriptSiblings(html: string): string {
  return html.replace(
    /<script([^>]*)\bsrc=["'](?:\.\/)?three-d-stage\.js["']([^>]*)>\s*<\/script>/i,
    () => `<script type="module">${threeDStageRaw.replace(/<\/script/g, '<\\/script')}</script>`
  )
}

/**
 * Design Component（.dc.html）支持 — dc 路线 P1
 * 检测 artifact content 是否为 DC 格式，并把 ./support.js 引用替换为内联运行时。
 * srcdoc iframe 没有文件系统，相对引用 ./support.js 永远 404，必须内联。
 * support.js 全文无 "</script" 字面量（已验证），可安全内联。
 */

export function isDcHtml(content: string): boolean {
  return /<x-dc[\s>]/i.test(content)
}

/** 动画 DC 判定：与 main/pi-tools.ts looksLikeAnimationDc 同一组正则，别让两处漂移 */
export function looksLikeAnimationDc(c: string): boolean {
  return /from="[^"]*animations\.jsx/i.test(c) || /\b(useSprite|useTime)\s*\(/.test(c) || /\bfunction\s+Stage\s*\(/.test(c) || /<Beat[\s/>]/.test(c)
}

/** deck（幻灯片舞台）DC 判定：与 main/export-artifact-validate.ts looksLikeDeckDc 同一组正则，别让两处漂移 */
export function looksLikeDeckDc(c: string): boolean {
  return /from="[^"]*deck-stage\.js/i.test(c) || /<deck-stage[\s>]/i.test(c)
}

/** 手机原型判定：产物内部套了 ios-frame 设备外框预制件（renderer 侧展示用，非导出门闩） */
export function looksLikePhoneDc(c: string): boolean {
  return /from="[^"]*ios-frame\.(?:jsx|js)/i.test(c) || /\bIOSDevice\b/.test(c)
}

/** 薄壳 from 链里对**会话内兄弟产物**的引用（./artifact-<id>.jsx|js）——与终态内联同一形状 */
const SIBLING_ARTIFACT_REF_RE = /\.\/(artifact-[A-Za-z0-9_-]+)\.(?:jsx|js)\b/g

/**
 * 收集一份 dc 薄壳引用了哪些会话产物（按出现顺序去重）。
 * 两个消费方共用这一份判定：
 *   · workspace 桥接——被薄壳引用的产物是**素材**，不单独开 tab（装进薄壳一起看）
 *   · 自检卡指纹——薄壳没变但场景 jsx 被改了，画面同样变了，旧结论必须降级
 * 只扫一层：场景 jsx 不会再引用别的会话产物（薄壳才是组装者）。
 */
export function collectDcSiblingArtifactIds(content: string): string[] {
  if (!content) return []
  SIBLING_ARTIFACT_REF_RE.lastIndex = 0
  const out: string[] = []
  const seen = new Set<string>()
  let m: RegExpExecArray | null
  while ((m = SIBLING_ARTIFACT_REF_RE.exec(content)) !== null) {
    if (seen.has(m[1])) continue
    seen.add(m[1])
    out.push(m[1])
  }
  return out
}

/**
 * 场景源码判定：`.jsx` 的 code 产物在本产品里只有一种用途——被薄壳 x-import 进去当素材
 * （宿主会给它预编译 `<id>.compiled.js` 兄弟文件，见 openpipal-product-tools.ts）。
 * 它不是交付物，不该在 workspace 里各占一个 tab 把舞台顶掉。流式期只有 title 可用，
 * 所以 language 与后缀名任一命中即可。
 */
export function isSceneSourceArtifact(a: { type?: string; title?: string; language?: string }): boolean {
  if ((a.type || '') !== 'code') return false
  return (a.language || '').toLowerCase() === 'jsx' || /\.jsx$/i.test((a.title || '').trim())
}

const SUPPORT_SRC_RE = /<script[^>]*\bsrc=["'][^"']*support\.js["'][^>]*>\s*<\/script>/i

function expectedDcGlobals(html: string): string[] {
  return Array.from(html.matchAll(/\bcomponent-from-global-scope="([A-Za-z_$][\w$]*)"/gi))
    .map((match) => match[1])
    .filter((name, index, all) => all.indexOf(name) === index)
}

function dcDependencyGateScript(names: string[]): string {
  if (!names.length) return ''
  return `<script>(function(){var names=${JSON.stringify(names)};window.__openpipalWaitForDcDependencies=function(){return new Promise(function(resolve){var deadline=Date.now()+15000;function ready(){return names.every(function(name){return typeof window[name]!=="undefined"})}function check(){if(ready()){resolve();return}if(Date.now()>=deadline){console.error("[OpenPipal] DC dependencies timed out: "+names.filter(function(name){return typeof window[name]==="undefined"}).join(", "));resolve();return}setTimeout(check,16)}check()})}})();</script>`
}

/**
 * React/ReactDOM UMD（18.3.1，与导出路径同一份 vendor 文件）。
 * 自研 support.js 零 CDN 回退——缺依赖只报错，供给依赖是宿主的责任。预览这条路以前靠运行时
 * 自己去 unpkg 取包（离线不可用、向第三方泄露使用行为、CDN 挂了就白屏），现在与导出/headless
 * 一样由宿主内联。srcdoc 没有可解析的相对路径，只能内联而不是 <script src>。
 */
const REACT_VENDOR_TAGS =
  `<script>${reactUmdRaw.replace(/<\/script/g, '<\\/script')}</script>` +
  `<script>${reactDomUmdRaw.replace(/<\/script/g, '<\\/script')}</script>`

export function inlineDcRuntime(html: string): string {
  // 自研 support.js 直接内联，宿主不再对它做字符串手术：
  // - 自取源码（fetch(location.href)）已废除——运行时只从本文档 DOM 取模板，srcdoc/file: 都不需要网络；
  // - 依赖门闩由运行时自己 await window.__openpipalWaitForDcDependencies（下方 dcDependencyGateScript
  //   注入），不必再改写它的 boot 链。
  // vendor 排在 support.js 之前：运行时启动时 window.React 必须已经在场。
  const vendor = html.includes('vendor/react.production.min.js') ? '' : REACT_VENDOR_TAGS
  const inline = `${vendor}<script>${supportJsRaw}</script>`
  if (SUPPORT_SRC_RE.test(html)) {
    return html.replace(SUPPORT_SRC_RE, () => inline)
  }
  // 模型漏写了 support.js 引用：注入到 <head>（运行时必须先于 <x-dc> 解析加载）
  if (/<head[^>]*>/i.test(html)) {
    return html.replace(/<head[^>]*>/i, (m) => m + inline)
  }
  return inline + html
}

/**
 * 已知运行时兄弟文件（deck-stage / animations 预制件）：srcdoc 里 x-import 的
 * fetch(相对路径) 不可用（file:// 同理），统一"预载全局 + 去 from"——
 * component-from-global-scope 在全局已在场时无需加载文件。
 * animations 用 esbuild 预编译版（原始 .jsx 需 Babel，离线/无网不可依赖）。
 */
const KNOWN_SIBLINGS: { key: string; fromRe: RegExp; source: string }[] = [
  { key: 'deck-stage.js', fromRe: /\s(?:from|src|import)="\.\/deck-stage\.js"/g, source: deckStageRaw },
  { key: 'animations', fromRe: /\s(?:from|src|import)="\.\/animations\.(?:jsx|js)"/g, source: animationsCompiledRaw },
  { key: 'ios-frame', fromRe: /\s(?:from|src|import)="\.\/ios-frame\.(?:jsx|js)"/g, source: iosFrameCompiledRaw },
  { key: 'android-frame', fromRe: /\s(?:from|src|import)="\.\/android-frame\.(?:jsx|js)"/g, source: androidFrameCompiledRaw },
  // image-slot.js：doc-page 同型的零依赖自注册 Web Component（helmet <script src> 加载）
  { key: 'image-slot.js', fromRe: /\s(?:from|src|import)="\.\/image-slot\.js"/g, source: imageSlotRaw },
  // doc-page.js：零依赖自注册 Web Component（无需 React/Babel/poll 包装）。源码 JSDoc 含 </script 字面量，
  // 内联时统一走下方 .replace(/<\/script/g,…) 转义路径。
  { key: 'doc-page.js', fromRe: /\s(?:from|src|import)="\.\/doc-page\.js"/g, source: docPageRaw },
]

/** 流式预载的载荷：送给 support.js 的 __dcUpdate(root, 'preload', {key, code}, true) */
export interface DcSiblingPreload {
  key: string
  code: string
}

/** 已知运行时兄弟件总数——泵送方据此早退（全送完就别再每帧白跑这几条正则） */
export const KNOWN_SIBLING_COUNT = KNOWN_SIBLINGS.length

/**
 * 流式预载扫描：累积文本里首次出现某个**已知运行时兄弟件的完整引用**时把它的源码交出来，
 * 由泵送方经 __dcUpdate(kind='preload') 送进活文档。
 * 与 inlineDcSiblings 共用同一份 KNOWN_SIBLINGS（不另抄一组正则，免得两处漂移）。
 *
 * **安全边界（硬约束）**：只认宿主打包内置的这几个预制件。会话内 ./artifact-*.jsx 链式
 * sidecar 永远不走这条路——它们要经 IPC 取编译产物、走既有 assembleDoc 门闩，那条路径不动。
 */
export function scanKnownSiblingPreloads(text: string, sent?: ReadonlySet<string> | null): DcSiblingPreload[] {
  const out: DcSiblingPreload[] = []
  if (!text) return out
  for (const s of KNOWN_SIBLINGS) {
    if (sent && sent.has(s.key)) continue
    s.fromRe.lastIndex = 0 // 共享的 g 正则，用前必须复位（同 inlineDcSiblings 的既有处理）
    if (s.fromRe.test(text)) out.push({ key: s.key, code: s.source })
  }
  return out
}

/** 流式期间用的同步版：只解析单路径的已知运行时兄弟（deck-stage/animations/doc-page）。
 *  链式 from（含 ./artifact-<id>.jsx）不匹配 → 留给 support.js 显示 placeholder（可接受）。 */
export function inlineDcSiblings(html: string): string {
  let out = html
  for (const s of KNOWN_SIBLINGS) {
    s.fromRe.lastIndex = 0
    if (!s.fromRe.test(out)) continue
    s.fromRe.lastIndex = 0
    out = out.replace(s.fromRe, '')
    const tag = `<script>${s.source.replace(/<\/script/g, '<\\/script')}</script>`
    out = /<head[^>]*>/i.test(out) ? out.replace(/<head[^>]*>/i, (m) => m + tag) : tag + out
  }
  // 链式场景引用要等 IPC 异步解析，但同步首帧绝不能把它交给 srcdoc iframe 自己 fetch：
  // sandbox iframe 的 origin 是 null，必然形成 CORS 红屏。先移除 from，异步 assembleDoc
  // 数毫秒后会用真正的 compiled sidecar 整页升级；data 属性只用于诊断，不参与运行时加载。
  let pendingArtifactChain = false
  out = out.replace(FROM_ATTR_RE, (full, value: string) => {
    if (!/(?:^|\s)\.\/artifact-[A-Za-z0-9_-]+\.(?:jsx|js)(?:\s|$)/.test(value)) return full
    pendingArtifactChain = true
    return ` data-openpipal-pending-from="${value.replace(/&/g, '&amp;').replace(/"/g, '&quot;')}"`
  })
  // 同步首帧还没有 IPC sidecar，不能让 support.js 先拿 undefined 组件启动并制造
  // React #130 红屏；先挂同一依赖门闩，数毫秒后 assembleDoc 的完整文档会替换本页。
  if (pendingArtifactChain) {
    const gate = dcDependencyGateScript(expectedDcGlobals(html))
    if (gate) out = /<head[^>]*>/i.test(out) ? out.replace(/<head[^>]*>/i, (h) => h + gate) : gate + out
  }
  return out
}

// 终态用的完整 from 引擎（含链式 from + 会话 sidecar 场景）。官方 support.js 把 from 值按空白拆成
// 链式 url 顺序 loadExternal；srcdoc 下相对 fetch 不可用，须"删 from + 按链序预载全局"。
const FROM_ATTR_RE = /\s(?:from|src|import)="([^"]*)"/gi

function resolveKnownRaw(p: string): { key: string; source: string } | null {
  if (/^\.\/deck-stage\.js$/.test(p)) return { key: 'deck-stage.js', source: deckStageRaw }
  if (/^\.\/animations\.(?:jsx|js)$/.test(p)) return { key: 'animations', source: animationsCompiledRaw }
  if (/^\.\/ios-frame\.(?:jsx|js)$/.test(p)) return { key: 'ios-frame', source: iosFrameCompiledRaw }
  if (/^\.\/android-frame\.(?:jsx|js)$/.test(p)) return { key: 'android-frame', source: androidFrameCompiledRaw }
  if (/^\.\/image-slot\.js$/.test(p)) return { key: 'image-slot.js', source: imageSlotRaw }
  if (/^\.\/doc-page\.js$/.test(p)) return { key: 'doc-page.js', source: docPageRaw }
  return null
}

/**
 * 终态内联：把 from 链里的兄弟预制件全部解析、删 from、按链序预载全局。
 * - 已知运行时（deck-stage/animations/doc-page）：编译期 ?raw
 * - 会话内 ./artifact-<id>.jsx → <id>.compiled.js（.js 原文件直用）：走 IPC artifact:load-compiled
 * 只有一条 from 里**每个**路径都解析成功才动它（否则原样保留，避免误删 support/图片等 src）。
 */
/** 匹配文档里对会话 uploads 资源的相对引用（官方粘贴图形状：uploads/pasted-<ts>-<i>.png） */
const UPLOAD_REF_RE = /(src|href)=(["'])(?:\.\/)?uploads\/([A-Za-z0-9._-]+)\2/g

/**
 * 会话 uploads 图片 → data URI 内联。srcdoc iframe 没有可解析相对路径的 base，
 * 磁盘上的 uploads/ 引用在预览里必然裂图——与 x-import 兄弟内联同一思路：宿主读盘、终态内联。
 * 导出/headless 各有自己的处理（拷目录 / data URI），这里只管 srcdoc 预览。
 */
export async function inlineUploadedImages(html: string, conversationId?: string | null): Promise<string> {
  if (!conversationId || !/uploads\//.test(html)) return html
  const names = new Set<string>()
  UPLOAD_REF_RE.lastIndex = 0
  let um: RegExpExecArray | null
  while ((um = UPLOAD_REF_RE.exec(html)) !== null) names.add(um[3])
  if (!names.size) return html
  // 各资源互不依赖——并行 IPC,免多图串行往返(评审:可并行却串行)
  const dataUris = new Map<string, string>()
  await Promise.all(Array.from(names).map(async (name) => {
    try {
      const asset = await (window as any).api?.readUploadAsset?.(conversationId, name)
      if (asset?.base64) dataUris.set(name, `data:${asset.mime};base64,${asset.base64}`)
    } catch { /* 单个资源失败保留原引用（裂图可见，比整体失败可诊断） */ }
  }))
  if (!dataUris.size) return html
  UPLOAD_REF_RE.lastIndex = 0
  return html.replace(UPLOAD_REF_RE, (m, attr, q, name) =>
    dataUris.has(name) ? `${attr}=${q}${dataUris.get(name)}${q}` : m)
}

export async function inlineDcArtifactSiblings(html: string, conversationId?: string | null): Promise<string> {
  html = await inlineUploadedImages(html, conversationId)
  const attrs: RegExpExecArray[] = []
  FROM_ATTR_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = FROM_ATTR_RE.exec(html)) !== null) attrs.push(m)
  if (!attrs.length) return html
  const removeRanges: Array<[number, number]> = []
  const ordered: { key: string; source: string }[] = []
  const seen = new Set<string>()
  const unresolved: string[] = []
  for (const a of attrs) {
    const value = a[1].trim()
    const paths = value ? value.split(/\s+/) : []
    if (!paths.length) continue
    const resolved: { key: string; source: string }[] = []
    const missing: string[] = []
    let allOk = true
    let isDcSiblingChain = true
    for (const p of paths) {
      let r = resolveKnownRaw(p)
      if (!r) {
        const am = /^\.\/(artifact-[A-Za-z0-9_-]+)\.(?:jsx|js)$/.exec(p)
        if (am && conversationId) {
          const text = await (window as any).api?.loadCompiledArtifact?.(conversationId, am[1])
          if (typeof text === 'string' && text) r = { key: am[1], source: text }
        }
        if (!am) isDcSiblingChain = false
      }
      if (!r) { allOk = false; missing.push(p); continue }
      resolved.push(r)
    }
    // 已识别的 DC sibling 链即使缺文件，也要删掉 from，禁止退化成 null-origin iframe fetch。
    // 其它未知 src/import 仍原样保留，避免误伤图片或业务脚本。
    if (!allOk && !isDcSiblingChain) continue
    unresolved.push(...missing)
    removeRanges.push([a.index, a.index + a[0].length])
    for (const r of resolved) { if (!seen.has(r.key)) { seen.add(r.key); ordered.push(r) } }
  }
  if (!removeRanges.length) return html
  let out = html
  for (let i = removeRanges.length - 1; i >= 0; i--) out = out.slice(0, removeRanges[i][0]) + out.slice(removeRanges[i][1])
  const dependencyGate = dcDependencyGateScript(expectedDcGlobals(html))
  const diagnostic = unresolved.length
    ? `<script>console.error(${JSON.stringify(`[OpenPipal] DC sibling 未解析，已阻止 iframe 相对 fetch: ${Array.from(new Set(unresolved)).join(', ')}`)})</script>`
    : ''
  const tags = dependencyGate + ordered.map((o) => `<script>${o.source.replace(/<\/script/g, '<\\/script')}</script>`).join('') + diagnostic
  return /<head[^>]*>/i.test(out) ? out.replace(/<head[^>]*>/i, (h) => h + tags) : tags + out
}

// ---- P2: data-props 参数面板 ----

/** __dc_booted 上报的单个 prop 描述子（官方 dc 教学 L69 的字段集） */
export interface DcPropMeta {
  editor: 'text' | 'color' | 'int' | 'float' | 'boolean' | 'enum' | null
  default?: any
  options?: string[]
  min?: number
  max?: number
  step?: number
  tsType?: string
}

/** 过滤出可出面板的 props（editor 非 null 才渲染控件） */
export function editableDcProps(propsMeta: Record<string, any> | null | undefined): Record<string, DcPropMeta> | null {
  if (!propsMeta || typeof propsMeta !== 'object') return null
  const out: Record<string, DcPropMeta> = {}
  for (const [k, v] of Object.entries(propsMeta)) {
    if (v && typeof v === 'object' && (v as any).editor) out[k] = v as DcPropMeta
  }
  return Object.keys(out).length ? out : null
}

/**
 * 用户调整的 prop 值持久化在 <script data-dc-script> 标签的 data-prop-overrides 属性里。
 * support.js 的 parseDataProps 只读 data-props，多出的属性对运行时透明；
 * 重开会话时由父侧在 __dc_booted 后读出并经 dc:set-props 重放。
 */
const DC_SCRIPT_TAG_RE = /<script\b[^>]*\bdata-dc-script\b[^>]*>/i
const OVERRIDES_ATTR_RE = /\sdata-prop-overrides="([^"]*)"/i

export function readDcPropOverrides(content: string): Record<string, any> | null {
  const tag = content.match(DC_SCRIPT_TAG_RE)?.[0]
  if (!tag) return null
  const m = tag.match(OVERRIDES_ATTR_RE)
  if (!m) return null
  try {
    const json = m[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&')
    const obj = JSON.parse(json)
    return obj && typeof obj === 'object' && !Array.isArray(obj) ? obj : null
  } catch {
    return null
  }
}

export function writeDcPropOverrides(content: string, overrides: Record<string, any>): string {
  const m = content.match(DC_SCRIPT_TAG_RE)
  if (!m) return content
  const tag = m[0]
  const json = JSON.stringify(overrides).replace(/&/g, '&amp;').replace(/"/g, '&quot;')
  const attr = ` data-prop-overrides="${json}"`
  const newTag = OVERRIDES_ATTR_RE.test(tag)
    ? tag.replace(OVERRIDES_ATTR_RE, attr)
    : tag.replace(/>$/, `${attr}>`)
  return content.replace(tag, newTag)
}

// ---- 时间轴剪辑表（EDL）----

/**
 * 用户在播放条上改的倍速/删除段，落在产物 html 自身的一个全局脚本里：
 *   `<script data-openpipal-edl>window.__openpipalEdl=[{"s":0,"e":4,"speed":1}, …]</script>`
 *
 * 为什么必须落在**产物内容**里而不是 localStorage：srcdoc iframe 的 origin 是 null，
 * 存储读写直接抛；而且导出（逐帧 mp4 / 交接包 / 自检三帧）走的是主进程另开的窗口，
 * 只认产物内容本身。写进内容 = 预览、导出、自检看到同一份剪辑。
 * 运行时把这个全局当权威输入（在场就不读 localStorage），见 animations-timeline-addendum.md §2.5。
 */
export interface DcEdlSegment { s: number; e: number; speed: number }

const EDL_SCRIPT_RE = /<script\s+data-openpipal-edl>[\s\S]*?<\/script>/i

function sanitizeEdl(value: unknown): DcEdlSegment[] | null {
  if (!Array.isArray(value) || value.length === 0) return null
  const out: DcEdlSegment[] = []
  for (const item of value) {
    if (!item || typeof item !== 'object') return null
    const { s, e, speed } = item as Record<string, unknown>
    if (typeof s !== 'number' || typeof e !== 'number' || typeof speed !== 'number') return null
    if (!isFinite(s) || !isFinite(e) || !isFinite(speed) || e <= s || speed < 0) return null
    out.push({ s, e, speed })
  }
  return out
}

export function readDcEdl(content: string): DcEdlSegment[] | null {
  const tag = content.match(EDL_SCRIPT_RE)?.[0]
  if (!tag) return null
  const json = tag.slice(tag.indexOf('>') + 1, tag.lastIndexOf('<')).replace(/^\s*window\.__openpipalEdl\s*=\s*/, '')
  try {
    return sanitizeEdl(JSON.parse(json))
  } catch {
    return null
  }
}

/**
 * 幂等写入：已有块整块替换，没有就插在 <head> 之后（没 head 就插最前）。
 * 非法表、以及**恒等表（全速 1 = 没有编辑，"重置全部编辑"发出的正是它）** → 移除块，
 * 让产物回到"从没被剪过"的样子，而不是留一张说了等于没说的表。
 */
export function writeDcEdl(content: string, edl: DcEdlSegment[] | null): string {
  const parsed = edl ? sanitizeEdl(edl) : null
  const clean = parsed && parsed.some(seg => seg.speed !== 1) ? parsed : null
  const stripped = content.replace(EDL_SCRIPT_RE, '')
  if (!clean) return stripped
  // 纯数字 JSON，不可能出现 </script 字面量；不做转义是有意的（保持可读）
  const block = `<script data-openpipal-edl>window.__openpipalEdl=${JSON.stringify(clean)}</script>`
  return /<head[^>]*>/i.test(stripped)
    ? stripped.replace(/<head[^>]*>/i, (h) => h + block)
    : block + stripped
}

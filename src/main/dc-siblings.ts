/**
 * DC x-import 兄弟预制件的 `from` 属性改写引擎（纯函数，无 electron/node/vite 依赖，可单测）。
 *
 * 官方 support.js（walkXImport）把 `from`/`src`/`import` 属性值按空白拆成链式 url 列表并**按序**
 * loadExternal（前序先求值），组件由最后一个 url + `component-from-global-scope` 全局名解析。
 * 但 srcdoc / data:URL / file:// 下相对 fetch 不可用，宿主必须"删 from + 按链序预载全局脚本"——
 * 全局在场时 support.js 无需再 fetch（`from` 已删则 urls=[]，直接走 resolveExternalGlobal）。
 *
 * 本引擎只做：定位每个 from/src/import 属性 → 拆分路径 → **全部**可解析才删掉该属性并按链序收集
 * 解析结果（按 key 去重）。是否可解析、解析成什么由调用方注入的 resolve 决定：
 *   - render_artifact 隐藏窗口 / 导出：从磁盘读兄弟文件
 *   - renderer 终态：编译期 ?raw + IPC 取会话 sidecar
 * 收集结果由调用方决定内联 <script>（headless/renderer）还是 <script src> + 拷贝（导出）。
 *
 * 安全：只有一条 from 里**每个**路径都能 resolve 才动它——`<img src="./x.png">`、`from="{{…}}"`、
 * `<script src="./support.js">` 这类混入的 src/from 不满足"全部可解析"，原样保留。
 */

const FROM_ATTR_RE = /\s(?:from|src|import)="([^"]*)"/gi

export function rewriteFromAttrs<T extends { key: string }>(
  html: string,
  resolve: (relPath: string) => T | null
): { html: string; ordered: T[] } {
  const removeRanges: Array<[number, number]> = []
  const ordered: T[] = []
  const seen = new Set<string>()
  FROM_ATTR_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = FROM_ATTR_RE.exec(html)) !== null) {
    const value = m[1].trim()
    const paths = value ? value.split(/\s+/) : []
    if (!paths.length) continue
    const resolved: T[] = []
    let allOk = true
    for (const p of paths) {
      const r = resolve(p)
      if (!r) { allOk = false; break }
      resolved.push(r)
    }
    if (!allOk) continue
    removeRanges.push([m.index, m.index + m[0].length])
    for (const r of resolved) {
      if (!seen.has(r.key)) { seen.add(r.key); ordered.push(r) }
    }
  }
  if (!removeRanges.length) return { html, ordered: [] }
  // 从后往前删，避免前面的删除让后面的 index 失效
  let out = html
  for (let i = removeRanges.length - 1; i >= 0; i--) {
    out = out.slice(0, removeRanges[i][0]) + out.slice(removeRanges[i][1])
  }
  return { html: out, ordered }
}

/** 把源码列表逐个包成内联 <script> 注入 <head>（含 </script 转义，无 <head> 则前置） */
export function injectInlinePreloads(html: string, scripts: string[]): string {
  if (!scripts.length) return html
  const tags = scripts.map((s) => `<script>${s.replace(/<\/script/g, '<\\/script')}</script>`).join('')
  return /<head[^>]*>/i.test(html) ? html.replace(/<head[^>]*>/i, (h) => h + tags) : tags + html
}

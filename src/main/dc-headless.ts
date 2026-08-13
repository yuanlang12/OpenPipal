/**
 * DC headless 内联装配 —— main 侧等价于渲染端的 dc 变换：把 x-import 兄弟预制件与 support.js
 * 内联进单文档，供 data:URL 隐藏窗口渲染（srcdoc / data:URL / file:// 下相对引用不可解析）。
 *
 * render_artifact（隐藏窗口自检，pi-tools.ts）、exportArtifactPdf/exportStandaloneHtml（dc-export.ts）、
 * exportArtifactMp4（dc-video-export.ts）共用同一装配，抽到独立模块以免 dc-export ↔ pi-tools 成环
 * （pi-tools 是重量级聚合模块）。
 *
 * baseDir = dc.html 所在目录（id 模式的 sidecar 父目录），用于把 x-import 链里的 ./artifact-<id>.jsx
 * 解析到同目录的 <id>.compiled.js（.js 原文件直用）。doc-page.js 是零依赖自注册 Web Component。
 *
 * 内联脚本（vendor/引擎/support.js）统一挪到 </body> 前（而非 prepend 进 <head>）——
 * 2026-07 mp4 导出验收实测发现：support.js/deck-stage.js 源码里自带含 "<x-dc>" 字面量的错误
 * 文案（如 "has no <x-dc> block — not a Design Component."）。若这些内联脚本排在真实 <x-dc>
 * 标签**之前**，boot() 里 `fetch(location.href)+parseDcText` 的自举二次解析会把该字面量误判成
 * "开始标签"，`lastIndexOf("</x-dc>")` 又找到真结束标签，两者之间一大段引擎源码被当成模板塞进
 * 渲染，页面显示乱码（PDF/独立 HTML/mp4 导出、render_artifact 自检共用此装配，均受影响）。
 * 挪到真实 <x-dc> 标签之后即可让自举解析优先命中真标签，规避该决 fragment。
 */
import fs from 'fs'
import path from 'path'
import { rewriteFromAttrs } from './dc-siblings'
import { compileJsxArtifact } from './artifact-store'
import { MIME_BY_EXT } from './chat-uploads'

/** 把脚本插到 </body> 前（无 </body> 则整篇追加）；沿用 injectInlinePreloads 的转义规则。 */
function injectBeforeBodyEnd(html: string, scripts: string[]): string {
  if (!scripts.length) return html
  const tags = scripts.map((s) => `<script>${s.replace(/<\/script/g, '<\\/script')}</script>`).join('')
  return /<\/body>/i.test(html) ? html.replace(/<\/body>/i, (b) => tags + b) : html + tags
}

/** prescripts：需排在兄弟预制件之前执行的内联脚本源码（如 React vendor），供 assembleOfflineDc 传入。 */
export function inlineDcForHeadless(content: string, baseDir?: string, prescripts: string[] = []): string {
  const { app } = require('electron')
  const runtimeDir = app.isPackaged
    ? path.join(process.resourcesPath, 'dc-runtime')
    : path.join(app.getAppPath(), 'resources', 'dc-runtime')
  const readRt = (f: string): string | null => {
    try { return fs.readFileSync(path.join(runtimeDir, f), 'utf8') } catch { return null }
  }
  const readSidecar = (id: string, ext: string): string | null => {
    if (!baseDir) return null
    const compiled = path.join(baseDir, `${id}.compiled.js`)
    const plain = path.join(baseDir, `${id}.js`)
    const jsxSrc = path.join(baseDir, `${id}.jsx`)
    try {
      if (ext === 'jsx') {
        // 自愈（Workstream B2，与 artifact-store.loadCompiledArtifact 同一策略）：源文件比 compiled
        // 新，或 compiled 缺失 → 当场重编译回写，别让"谁写了源文件"决定预览新旧
        if (fs.existsSync(jsxSrc)) {
          const srcMtime = fs.statSync(jsxSrc).mtimeMs
          const compiledMtime = fs.existsSync(compiled) ? fs.statSync(compiled).mtimeMs : -1
          if (srcMtime > compiledMtime) {
            const res = compileJsxArtifact(fs.readFileSync(jsxSrc, 'utf8'))
            if (res.js) {
              try { fs.writeFileSync(compiled, res.js, 'utf8') } catch {}
              return res.js
            }
            console.warn('[dc-headless] compiled 自愈编译失败，回退旧 compiled:', res.error)
          }
        }
        if (fs.existsSync(compiled)) return fs.readFileSync(compiled, 'utf8')
      }
      if (fs.existsSync(plain)) return fs.readFileSync(plain, 'utf8')
      if (fs.existsSync(compiled)) return fs.readFileSync(compiled, 'utf8')
    } catch {}
    return null
  }
  const resolve = (p: string): { key: string; source: string } | null => {
    let s: string | null = null
    if (/^\.\/deck-stage\.js$/.test(p)) { s = readRt('deck-stage.js'); return s ? { key: 'deck-stage.js', source: s } : null }
    if (/^\.\/animations\.(?:jsx|js)$/.test(p)) { s = readRt('animations.compiled.js'); return s ? { key: 'animations', source: s } : null }
    if (/^\.\/ios-frame\.(?:jsx|js)$/.test(p)) { s = readRt('ios-frame.compiled.js'); return s ? { key: 'ios-frame', source: s } : null }
    if (/^\.\/android-frame\.(?:jsx|js)$/.test(p)) { s = readRt('android-frame.compiled.js'); return s ? { key: 'android-frame', source: s } : null }
    if (/^\.\/image-slot\.js$/.test(p)) { s = readRt('image-slot.js'); return s ? { key: 'image-slot.js', source: s } : null }
    if (/^\.\/doc-page\.js$/.test(p)) { s = readRt('doc-page.js'); return s ? { key: 'doc-page.js', source: s } : null }
    const am = /^\.\/(artifact-[A-Za-z0-9_-]+)\.(jsx|js)$/.exec(p)
    if (am) { s = readSidecar(am[1], am[2]); return s ? { key: am[1], source: s } : null }
    return null
  }
  // 3D 舞台预制脚本内联（裸 HTML 路径，不经 x-dc from 机制）：headless/导出没有相对路径可解析。
  // 官方 three-d-stage.js 的 JSDoc 用法示例字面含 "</script>"，内联前必须转义（同下方 KNOWN_SIBLINGS 处理）。
  const threeDStage = readRt('three-d-stage.js')
  if (threeDStage && /three-d-stage\.js/.test(content)) {
    content = content.replace(
      /<script([^>]*)\bsrc=["'](?:\.\/)?three-d-stage\.js["']([^>]*)>\s*<\/script>/i,
      () => `<script type="module">${threeDStage.replace(/<\/script/g, '<\\/script')}</script>`
    )
  }
  // 会话 uploads 图片 → data URI（离线自足：PDF/MP4/独立 HTML 的产物没有相对路径可解析的 base）。
  // 在原始 content 上先做——同下方 from 重写一样，避免误扫内联后 JS 字面量。
  if (baseDir && /uploads\//.test(content)) {
    content = content.replace(/(src|href)=(["'])(?:\.\/)?uploads\/([A-Za-z0-9._-]+)\2/g, (m, attr, q, name) => {
      const mime = MIME_BY_EXT[path.extname(name).toLowerCase()]
      if (!mime || name !== path.basename(name)) return m
      try {
        const b64 = fs.readFileSync(path.join(baseDir!, 'uploads', name)).toString('base64')
        return `${attr}=${q}data:${mime};base64,${b64}${q}`
      } catch { return m }
    })
  }
  // 产物 sidecar(*.state.json)水合——image-slot 拖图状态在 PDF/MP4/独立 HTML 里继续可见。
  // 注入数据 + fetch 垫片(headless 页面没有 BRIDGE_SCRIPT,自带一份;file///data URL 下相对 fetch 必败)。
  if (baseDir) {
    const scNames = Array.from(new Set(content.match(/[A-Za-z0-9._-]+\.state\.json/g) || [])).slice(0, 4)
    const scData: Record<string, string> = {}
    for (const n of scNames) {
      if (n !== path.basename(n)) continue
      try { scData[n] = fs.readFileSync(path.join(baseDir, n), 'utf8') } catch { /* 缺失=空槽 */ }
    }
    if (Object.keys(scData).length) {
      const shim =
        `<script>window.__openpipalSidecarData=${JSON.stringify(scData).replace(/</g, '\\u003c')};` +
        `(function(){var f=window.fetch?window.fetch.bind(window):null;window.fetch=function(i,o){try{` +
        `var u=typeof i==='string'?i:((i&&i.url)||'');if(/^[A-Za-z0-9._-]+\\.state\\.json$/.test(u)){` +
        `var d=(window.__openpipalSidecarData||{})[u];return Promise.resolve(new Response(d!=null?d:'',` +
        `{status:d!=null?200:404,headers:{'Content-Type':'application/json'}}))}}catch(_){}` +
        `return f?f(i,o):Promise.reject(new TypeError('no fetch'))};})();</script>`
      content = /<head[^>]*>/i.test(content) ? content.replace(/<head[^>]*>/i, (m) => m + shim) : shim + content
    }
  }
  // 先在原始 content 上删 from + 收集链序（避免扫到 support.js 内联后 JS 里的 src="…" 字面量）
  const { html: stripped, ordered } = rewriteFromAttrs(content, resolve)
  let out = injectBeforeBodyEnd(stripped, [...prescripts, ...ordered.map((o) => o.source)])
  // 再内联 support.js（同样挪到 body 末尾，紧跟兄弟预制件之后，见文件头注释）
  const supportRe = /<script[^>]*\bsrc=["'][^"']*support\.js["'][^>]*>\s*<\/script>/i
  const supportSrc = readRt('support.js')
  if (supportSrc && supportRe.test(out)) {
    out = out.replace(supportRe, '')
    out = injectBeforeBodyEnd(out, [supportSrc])
  }
  return out
}

/**
 * DC 设计交付物导出装配器 —— dc 路线 P5
 *
 * 把会话内的 .dc.html artifact 装配成离线自足的文件夹：
 *   ~/.openpipal/outputs/<project>/
 *   ├── <Title>.dc.html      （注入本地 React vendor 引用 + 调参重放脚本）
 *   ├── support.js           （dc 运行时，冻结 ABI）
 *   └── vendor/react*.js     （18.3.1 UMD，预注入后 support.js 跳过 unpkg CDN → 断网可开）
 *
 * 渲染端经 IPC artifact:export-dc / HTTP POST /api/artifact/export-dc 调用，
 * artifacts 由渲染端 artifactStore 提供（title + content），main 只做确定性装配。
 */

import fs from 'fs'
import path from 'path'
import { homedir } from 'os'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { app } from 'electron'
import { rewriteFromAttrs } from './dc-siblings'
import { inlineDcForHeadless } from './dc-headless'
import { findArtifactFileById } from './artifact-store'
import { mainError } from './main-i18n'
import { dataPath, getDataRoot } from './data-root'

const OUTPUTS_ROOT = dataPath('outputs')

export function dcRuntimeDir(): string {
  if (app.isPackaged) return path.join(process.resourcesPath, 'dc-runtime')
  return path.join(app.getAppPath(), 'resources', 'dc-runtime')
}

export interface DcExportItem {
  title: string
  content: string
  /** 可选：产物 id——用于定位其会话目录，把文档引用的 uploads/ 图片随包拷出（官方 zip 同形状） */
  artifactId?: string
}

export interface DcExportResult {
  ok: boolean
  dir?: string
  files?: string[]
  error?: string
}

export function sanitizeName(name: string): string {
  const cleaned = name.replace(/[\\/:*?"<>|\x00-\x1f]/g, ' ').replace(/\s+/g, ' ').trim()
  return cleaned || 'design'
}

function ensureDcFilename(title: string): string {
  const base = sanitizeName(title)
  if (/\.dc\.html?$/i.test(base)) return base
  return `${base.replace(/\.html?$/i, '')}.dc.html`
}

const VENDOR_TAGS =
  '<script src="./vendor/react.production.min.js"></script>\n<script src="./vendor/react-dom.production.min.js"></script>\n'

// 调参重放：data-prop-overrides 是宿主内的用户调整记录，导出后由这段脚本在 boot 后回放
const REPLAY_SCRIPT = `<script>/* openpipal export: replay saved tweaks */(function(){
  function apply(){
    var s=document.querySelector('script[data-dc-script]'); if(!s) return true;
    var raw=s.getAttribute('data-prop-overrides'); if(!raw) return true;
    if(!(window.__dcSetProps&&window.__dcRootName)) return false;
    try{ window.__dcSetProps(window.__dcRootName(), JSON.parse(raw)); }catch(e){}
    return true;
  }
  var n=0, t=setInterval(function(){ if(apply()||++n>100) clearInterval(t); }, 50);
})();</script>`

const SUPPORT_TAG_RE = /<script[^>]*\bsrc=["'][^"']*support\.js["'][^>]*>\s*<\/script>/i

/**
 * 导出时随包拷贝的兄弟预制件。file:// 下 x-import 的 fetch 不可用 → 去 from + <script src> 预载全局。
 * - isResource：从 resources/dc-runtime 拷（copyFrom = runtime 内文件名）
 * - 否则：从会话 sidecar 拷（copyFrom = 绝对路径），保持导出目录离线自足
 */
interface ExportSibling { key: string; targetName: string; copyFrom: string; isResource: boolean }

function resolveExportSibling(p: string): ExportSibling | null {
  if (/^\.\/deck-stage\.js$/.test(p)) return { key: 'deck-stage.js', targetName: 'deck-stage.js', copyFrom: 'deck-stage.js', isResource: true }
  // animations.js 用预编译版（原始 .jsx 依赖 CDN Babel，离线不可用）
  if (/^\.\/animations\.(?:jsx|js)$/.test(p)) return { key: 'animations', targetName: 'animations.js', copyFrom: 'animations.compiled.js', isResource: true }
  // ios/android-frame 同款：导出带预编译版，离线免 Babel
  if (/^\.\/ios-frame\.(?:jsx|js)$/.test(p)) return { key: 'ios-frame', targetName: 'ios-frame.js', copyFrom: 'ios-frame.compiled.js', isResource: true }
  if (/^\.\/android-frame\.(?:jsx|js)$/.test(p)) return { key: 'android-frame', targetName: 'android-frame.js', copyFrom: 'android-frame.compiled.js', isResource: true }
  if (/^\.\/image-slot\.js$/.test(p)) return { key: 'image-slot.js', targetName: 'image-slot.js', copyFrom: 'image-slot.js', isResource: true }
  if (/^\.\/doc-page\.js$/.test(p)) return { key: 'doc-page.js', targetName: 'doc-page.js', copyFrom: 'doc-page.js', isResource: true }
  const am = /^\.\/(artifact-[A-Za-z0-9_-]+)\.(jsx|js)$/.exec(p)
  if (am) {
    const id = am[1]
    const primary = findArtifactFileById(id) // id 全局唯一：定位主产物文件，取其父目录的 sidecar
    if (primary) {
      const dir = path.dirname(primary)
      const compiled = path.join(dir, `${id}.compiled.js`)
      const plain = path.join(dir, `${id}.js`)
      if (am[2] === 'jsx' && fs.existsSync(compiled)) return { key: id, targetName: `${id}.compiled.js`, copyFrom: compiled, isResource: false }
      if (fs.existsSync(plain)) return { key: id, targetName: `${id}.js`, copyFrom: plain, isResource: false }
      if (fs.existsSync(compiled)) return { key: id, targetName: `${id}.compiled.js`, copyFrom: compiled, isResource: false }
    }
  }
  return null
}

/** artifactId → 其所在会话目录（uploads/sidecar 定位共用）；找不到返回 undefined。 */
function artifactSourceDir(artifactId?: string): string | undefined {
  if (!artifactId) return undefined
  const f = findArtifactFileById(artifactId)
  return f ? path.dirname(f) : undefined
}

/** 单文件改写：support.js 引用前插 vendor + 兄弟预制件预载、后插调参重放脚本。返回需随包拷贝的预制件清单。 */
export function prepareDcForExport(content: string): { html: string; siblings: ExportSibling[] } {
  const { html: stripped, ordered } = rewriteFromAttrs(content, resolveExportSibling)
  let out = stripped
  if (out.includes('vendor/react.production.min.js')) return { html: out, siblings: ordered }
  const m = out.match(SUPPORT_TAG_RE)
  if (!m) return { html: out, siblings: ordered }
  const siblingTags = ordered.map((s) => `<script src="./${s.targetName}"></script>\n`).join('')
  out = out.replace(SUPPORT_TAG_RE, () => `${VENDOR_TAGS}${siblingTags}${m[0]}\n${REPLAY_SCRIPT}`)
  return { html: out, siblings: ordered }
}

export function exportDcBundle(projectName: string, artifacts: DcExportItem[]): DcExportResult {
  try {
    const dcItems = artifacts.filter((a) => /<x-dc[\s>]/i.test(a.content || ''))
    if (!dcItems.length) return { ok: false, ...mainError('artifacts.shell.export.errors.noDcItems') }

    const dir = path.join(OUTPUTS_ROOT, sanitizeName(projectName))
    fs.mkdirSync(path.join(dir, 'vendor'), { recursive: true })

    const runtime = dcRuntimeDir()
    fs.copyFileSync(path.join(runtime, 'support.js'), path.join(dir, 'support.js'))
    for (const f of ['react.production.min.js', 'react-dom.production.min.js']) {
      fs.copyFileSync(path.join(runtime, 'vendor', f), path.join(dir, 'vendor', f))
    }

    const files: string[] = ['support.js', 'vendor/react.production.min.js', 'vendor/react-dom.production.min.js']
    const used = new Set<string>()
    const copied = new Set<string>()
    for (const item of dcItems) {
      let name = ensureDcFilename(item.title)
      let i = 2
      while (used.has(name)) name = ensureDcFilename(`${item.title} ${i++}`)
      used.add(name)
      const prepared = prepareDcForExport(item.content)
      fs.writeFileSync(path.join(dir, name), prepared.html, 'utf8')
      files.push(name)
      // 兄弟预制件拷贝：resource 从 runtime 拷、artifact sidecar 从绝对路径拷（去重 by targetName）
      for (const s of prepared.siblings) {
        if (copied.has(s.targetName)) continue
        copied.add(s.targetName)
        const src = s.isResource ? path.join(runtime, s.copyFrom) : s.copyFrom
        try {
          fs.copyFileSync(src, path.join(dir, s.targetName))
          files.push(s.targetName)
        } catch (err: any) {
          console.warn('[dc-export] 预制件拷贝失败:', s.targetName, err?.message)
        }
      }
      // sidecar(*.state.json)随包携带——image-slot 拖图状态在导出目录里与 html 同层(官方同形状,
      // 组件读取是文档相对 fetch,服务式打开即可见)
      const scDir = /\.state\.json/.test(item.content) ? artifactSourceDir(item.artifactId) : undefined
      if (scDir) {
        const scRefs = new Set<string>()
        for (const m of Array.from(item.content.matchAll(/([A-Za-z0-9._-]+\.state\.json)/g))) scRefs.add(m[1])
        for (const name of Array.from(scRefs)) {
          if (name !== path.basename(name) || copied.has(name)) continue
          copied.add(name)
          try {
            fs.copyFileSync(path.join(scDir, name), path.join(dir, name))
            files.push(name)
          } catch { /* 会话里从没拖过图 → 无 sidecar,正常 */ }
        }
      }
      // uploads/ 随包携带（官方 zip 同形状）：文档相对引用的粘贴图从产物所在会话目录拷出
      const srcDir = /uploads\//.test(item.content) ? artifactSourceDir(item.artifactId) : undefined
      if (srcDir) {
        const refs = new Set<string>()
        for (const m of Array.from(item.content.matchAll(/["'](?:\.\/)?uploads\/([A-Za-z0-9._-]+)["']/g))) refs.add(m[1])
        for (const name of Array.from(refs)) {
          const target = `uploads/${name}`
          if (copied.has(target)) continue
          copied.add(target)
          try {
            fs.mkdirSync(path.join(dir, 'uploads'), { recursive: true })
            fs.copyFileSync(path.join(srcDir, 'uploads', name), path.join(dir, target))
            files.push(target)
          } catch (err: any) {
            console.warn('[dc-export] uploads 拷贝失败:', name, err?.message)
          }
        }
      }
    }
    return { ok: true, dir, files }
  } catch (err: any) {
    return { ok: false, error: err?.message || 'export failed' }
  }
}

export interface PdfExportResult {
  ok: boolean
  path?: string
  error?: string
}

/**
 * PDF 直出（W3 条款3）：复用 render_artifact 的隐藏窗口装配（inlineDcForHeadless + data:URL），
 * 用 Chromium printToPDF 落 ~/.openpipal/outputs/<安全化标题>.pdf。用户侧分享动作，不是 pi-tool。
 *
 * doc-page 文档在 connectedCallback 往 document.head 注入 @page，data:URL 即可让 preferCSSPageSize 生效
 * （无需 file://）。文档路线无 sibling，inlineDcForHeadless(content) 不带 baseDir 亦可（doc-page.js 从 runtime 内联）。
 * 安全：只写 outputs/，sanitizeName 去掉分隔符/控制字符防路径穿越。
 */
export async function exportArtifactPdf(title: string, content: string, targetDir?: string, artifactId?: string): Promise<PdfExportResult> {
  try {
    const { BrowserWindow } = require('electron')
    if (!BrowserWindow) return { ok: false, ...mainError('artifacts.shell.export.errors.noBrowserWindow') }
    // baseDir 供 uploads/ 相对图内联成 data URI（headless 无相对路径可解析的 base）
    const html = inlineDcForHeadless(content, artifactSourceDir(artifactId))
    const win = new BrowserWindow({
      show: false, width: 1024, height: 1400,
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false }
    })
    let pdfBuf: Buffer | null = null
    let error: string | undefined
    try {
      await win.loadURL('data:text/html;base64,' + Buffer.from(html, 'utf8').toString('base64'))
      // 字体就绪 + 双 rAF（保证布局/分页测量稳定），3s 兜底避免死等
      await win.webContents
        .executeJavaScript(
          `new Promise(function(resolve){var done=false;var fin=function(){if(done)return;done=true;resolve(true)};var t=setTimeout(fin,3000);var raf=function(){requestAnimationFrame(function(){requestAnimationFrame(function(){clearTimeout(t);fin()})})};if(document.fonts&&document.fonts.ready){document.fonts.ready.then(raf)}else{raf()}})`
        )
        .catch(() => {})
      pdfBuf = await win.webContents.printToPDF({ printBackground: true, preferCSSPageSize: true })
    } catch (err: any) {
      error = err?.message || String(err)
    } finally {
      win.destroy()
    }
    if (!pdfBuf || !pdfBuf.length) return { ok: false, ...(error ? { error } : mainError('artifacts.shell.export.errors.pdfEmpty')) }
    const outRoot = targetDir || OUTPUTS_ROOT
    fs.mkdirSync(outRoot, { recursive: true })
    const outPath = path.join(outRoot, `${sanitizeName(title)}.pdf`)
    fs.writeFileSync(outPath, pdfBuf)
    return { ok: true, path: outPath }
  } catch (err: any) {
    return { ok: false, error: err?.message || 'export failed' }
  }
}

/**
 * 离线自足装配（PDF 落盘 / MP4 隐藏窗口渲染共用）：headless 内联（x-import 链 + support.js 内联）
 * + React vendor 直接内联进 <head>（support.js 检测到 window.React 就跳过 unpkg CDN）
 * + 调参重放脚本（用户在宿主里调过的参数原样生效）。
 * 供 exportStandaloneHtml（落盘）与 exportArtifactMp4（dc-video-export.ts，隐藏窗口逐帧截图）共用，避免复制粘贴。
 */
export function assembleOfflineDc(content: string, artifactId?: string): string {
  const baseDir = artifactSourceDir(artifactId)
  const isDc = /<x-dc[\s>]/i.test(content)
  // vendor 源码作为 prescripts 传给 inlineDcForHeadless——排在兄弟预制件/support.js 之前、
  // 统一挪到 </body> 前（而非各自散落插入 <head>），规避自举 fetch 误判真实 <x-dc> 标签见该函数注释
  let vendorSrcs: string[] = []
  if (isDc) {
    const runtime = dcRuntimeDir()
    const readVendor = (f: string): string => fs.readFileSync(path.join(runtime, 'vendor', f), 'utf8')
    vendorSrcs = [readVendor('react.production.min.js'), readVendor('react-dom.production.min.js')]
  }
  let html = inlineDcForHeadless(content, baseDir, vendorSrcs)
  if (isDc) {
    html = html.replace(/<\/html>\s*$/i, `${REPLAY_SCRIPT}\n</html>`)
  }
  return html
}

/**
 * 独立 HTML 导出：单文件、断网可开。装配复用 assembleOfflineDc。
 */
export function exportStandaloneHtml(
  title: string,
  content: string,
  artifactId?: string,
  targetDir?: string
): PdfExportResult {
  try {
    const html = assembleOfflineDc(content, artifactId)
    const outRoot = targetDir || OUTPUTS_ROOT
    fs.mkdirSync(outRoot, { recursive: true })
    const base = sanitizeName(title).replace(/\.dc\.html?$/i, '').replace(/\.html?$/i, '')
    const outPath = path.join(outRoot, `${base || 'design'}.html`)
    fs.writeFileSync(outPath, html, 'utf8')
    return { ok: true, path: outPath }
  } catch (err: any) {
    return { ok: false, error: err?.message || 'export failed' }
  }
}

const execFileAsync = promisify(execFile)

export interface ZipExportResult {
  ok: boolean
  path?: string
  error?: string
}

/**
 * 分享打包（W5 条款C）：把一个产物文件夹（设计系统 / dc 交付文件夹 / outputs 子目录）
 * 用系统 `zip` 命令打成单文件 zip 落 ~/.openpipal/outputs/<safeName>.zip，方便一键分享。
 *
 * 不新增 npm 依赖——用 macOS 自带 /usr/bin/zip。cwd 设为 sourceDir 的父目录后
 * `zip -r -q <out> <basename>`，让包内路径为相对 <basename>/… 而非绝对路径。
 *
 * 安全：sourceDir resolve 后必须落在白名单三根（design-systems / conversations/artifacts /
 * outputs）之内，否则拒绝——防止把任意目录（如 ~/.ssh）打进用户可分享的包。
 * outName 经 sanitizeName 去分隔符/控制字符，且最终 outPath 的父目录必须恰是 OUTPUTS_ROOT（防路径穿越）。
 */
function zipWhitelistRoots(): string[] {
  const base = getDataRoot()
  return [
    path.join(base, 'design-systems'),
    path.join(base, 'conversations', 'artifacts'),
    path.join(base, 'outputs')
  ]
}

function isInWhitelist(resolved: string): boolean {
  return zipWhitelistRoots().some((root) => resolved === root || resolved.startsWith(root + path.sep))
}

export async function exportZip(sourceDir: string, outName: string, targetDir?: string): Promise<ZipExportResult> {
  try {
    if (!sourceDir || typeof sourceDir !== 'string') return { ok: false, ...mainError('artifacts.shell.export.errors.sourceDirRequired') }
    const resolved = path.resolve(sourceDir)
    if (!isInWhitelist(resolved)) return { ok: false, ...mainError('artifacts.shell.export.errors.sourceDirNotAllowed') }
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
      return { ok: false, ...mainError('artifacts.shell.export.errors.sourceDirMissing') }
    }

    const safe = sanitizeName(outName)
    const outRoot = targetDir || OUTPUTS_ROOT
    fs.mkdirSync(outRoot, { recursive: true })
    const outPath = path.join(outRoot, `${safe}.zip`)
    // 双保险防穿越：sanitize 后 outPath 的父目录必须恰是输出根
    if (path.dirname(outPath) !== outRoot) return { ok: false, ...mainError('artifacts.shell.export.errors.badOutputName') }

    // zip -r 对已存在的包是追加而非覆盖，先删旧包保证幂等
    try {
      if (fs.existsSync(outPath)) fs.unlinkSync(outPath)
    } catch {
      /* ignore */
    }

    const parent = path.dirname(resolved)
    const basename = path.basename(resolved)
    // cwd=父目录 → 包内为 <basename>/… 相对路径，不泄露绝对路径
    await execFileAsync('zip', ['-r', '-q', outPath, basename], {
      cwd: parent,
      maxBuffer: 64 * 1024 * 1024
    })

    if (!fs.existsSync(outPath) || fs.statSync(outPath).size === 0) {
      return { ok: false, ...mainError('artifacts.shell.export.errors.zipEmpty') }
    }
    return { ok: true, path: outPath }
  } catch (err: any) {
    return { ok: false, error: err?.message || 'zip failed' }
  }
}

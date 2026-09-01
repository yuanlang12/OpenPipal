/**
 * Artifact 磁盘持久化
 *
 * 存储位置：~/.openpipal/conversations/artifacts/<conversationId>/<artifactId>.<ext>
 *
 * 与 conversation-store 的关系：
 * - 会话文件（conversations/<id>.json）只存消息和 artifactRef（小元数据）
 * - artifact content 作为 sidecar 独立存盘——不进 agent prompt context，也不让 conversations/*.json 膨胀
 *
 * 生命周期：
 * - agent 创建 artifact → saveArtifact() → 返回 ArtifactRef（可随消息持久化）
 * - 切回历史会话 → loadArtifact(ref) → 重新填充 artifactStore
 * - 删除会话 → deleteArtifactsForConversation() 清空对应目录
 */

import fs from 'fs'
import path from 'path'
import { homedir } from 'os'
import {
  getConversationMessages,
  listConversations,
  peekConversationMessages,
} from './conversation-service'
import { dataPath } from './data-root'

/**
 * ⚠️ esbuild 保持运行时懒 require，且正式包依赖两条打包配置，勿动：
 * 1) esbuild/typescript 必须在 dependencies（曾在 devDependencies → 装机版 asar 不含
 *    node_modules/esbuild → 每次 jsx 编译死于 Cannot find module，dev 下无法复现）；
 * 2) electron-builder.yml asarUnpack esbuild + @esbuild —— 其同步 API 用
 *    `new Worker(__filename)` 自举并 spawn 平台二进制，worker_threads 与 exec
 *    都要求真实文件路径，asar 内路径两者皆崩。
 * 历史实案（devDependencies 年代）：顶层 import 会被打进 out/main bundle，
 * __filename 指向应用 bundle → worker 启动即崩 → 主线程 Atomics.wait 永挂
 * （整窗冻结、Cmd+Q 无效、主线程 100% 采样停在 __psynch_cvwait）。
 * ds-compile.ts 同款写法，改法保持一致。
 */
// eslint-disable-next-line @typescript-eslint/no-var-requires
const loadEsbuild = (): typeof import('esbuild') => require('esbuild')

const ARTIFACTS_ROOT = dataPath('conversations', 'artifacts')

const SAFE_STORAGE_COMPONENT_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,159}$/
const NO_FOLLOW = fs.constants.O_NOFOLLOW || 0

function isSafeStorageComponent(value: unknown): value is string {
  return typeof value === 'string' && SAFE_STORAGE_COMPONENT_RE.test(value)
}

function assertSafeStorageComponent(value: unknown, label: string): asserts value is string {
  if (!isSafeStorageComponent(value)) {
    throw new Error(`${label} 格式无效`)
  }
}

function isPathInside(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(root + path.sep)
}

/**
 * Artifact 根目录可以位于用户自己配置的符号链接后，但所有后续判断统一使用它的真实路径。
 * 会话子目录本身不能是符号链接，否则一个看似合法的 conversationId 可把读写重定向到别处。
 */
function resolveArtifactsRoot(create: boolean): string | null {
  try {
    if (create) fs.mkdirSync(ARTIFACTS_ROOT, { recursive: true, mode: 0o700 })
    const info = fs.lstatSync(ARTIFACTS_ROOT)
    if (!info.isDirectory() && !info.isSymbolicLink()) return null
    const real = fs.realpathSync(ARTIFACTS_ROOT)
    if (!fs.statSync(real).isDirectory()) return null
    return real
  } catch {
    return null
  }
}

function resolveConversationDir(conversationId: string, create: boolean): string | null {
  if (!isSafeStorageComponent(conversationId)) return null
  const root = resolveArtifactsRoot(create)
  if (!root) return null
  const logical = path.join(ARTIFACTS_ROOT, conversationId)
  try {
    if (create && !fs.existsSync(logical)) fs.mkdirSync(logical, { mode: 0o700 })
    const info = fs.lstatSync(logical)
    if (!info.isDirectory() || info.isSymbolicLink()) return null
    const real = fs.realpathSync(logical)
    const expected = path.join(root, conversationId)
    if (real !== expected || !isPathInside(root, real)) return null
    return real
  } catch {
    return null
  }
}

function resolveExistingConversationDirPath(dir: string): string | null {
  const root = resolveArtifactsRoot(false)
  if (!root) return null
  try {
    const info = fs.lstatSync(dir)
    if (!info.isDirectory() || info.isSymbolicLink()) return null
    const real = fs.realpathSync(dir)
    const relative = path.relative(root, real)
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || relative.includes(path.sep)) return null
    if (!isSafeStorageComponent(relative)) return null
    return real
  } catch {
    return null
  }
}

function secureArtifactLeafPath(dir: string, fileName: string): string {
  if (!fileName || fileName === '.' || fileName === '..' || path.basename(fileName) !== fileName) {
    throw new Error('artifact 文件名格式无效')
  }
  const candidate = path.join(dir, fileName)
  if (!isPathInside(dir, candidate)) throw new Error('artifact 路径越界')
  return candidate
}

function writeUtf8ArtifactFile(dir: string, fileName: string, content: string): void {
  const filePath = secureArtifactLeafPath(dir, fileName)
  try {
    const existing = fs.lstatSync(filePath)
    if (existing.isSymbolicLink() || !existing.isFile()) throw new Error('目标不是普通文件')
  } catch (err: any) {
    if (err?.code !== 'ENOENT') throw err
  }

  const fd = fs.openSync(
    filePath,
    fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC | NO_FOLLOW,
    0o600
  )
  try {
    if (!fs.fstatSync(fd).isFile()) throw new Error('目标不是普通文件')
    fs.fchmodSync(fd, 0o600)
    fs.writeFileSync(fd, content, 'utf8')
  } finally {
    fs.closeSync(fd)
  }
}

function readUtf8ArtifactFile(dir: string, fileName: string): string | null {
  const filePath = secureArtifactLeafPath(dir, fileName)
  let fd: number | undefined
  try {
    const info = fs.lstatSync(filePath)
    if (info.isSymbolicLink() || !info.isFile()) return null
    const real = fs.realpathSync(filePath)
    if (!isPathInside(dir, real) || path.dirname(real) !== dir) return null
    fd = fs.openSync(real, fs.constants.O_RDONLY | NO_FOLLOW)
    if (!fs.fstatSync(fd).isFile()) return null
    return fs.readFileSync(fd, 'utf8')
  } catch {
    return null
  } finally {
    if (fd !== undefined) fs.closeSync(fd)
  }
}

export interface ArtifactRef {
  id: string
  type: string
  title: string
  path: string      // 绝对路径
  language?: string // code 类型才用
}

export interface ArtifactData {
  id: string
  type: string
  title: string
  content: string
  language?: string
}

// ephemeral 过程物：判据——用户会带走/回看/迭代的才是「产物」；这些是过程 UI 载体（todos/questions
// 是任务态/一次性问答，goal/mcp-app 走各自的持久化通道），复用 artifact 管道做传输渲染，但不落盘/
// 不进历史产物列表/不进模型 session-artifacts 清单/不参与去重去命名冲突。复用管道 ≠ 同等待遇。
export const EPHEMERAL_ARTIFACT_TYPES = new Set(['todos', 'questions', 'goal', 'mcp-app'])

function extForType(type: string, language?: string): string {
  switch (type) {
    case 'html':      return 'html'
    case 'svg':       return 'svg'
    case 'markdown':  return 'md'
    case 'document':  return 'md'
    case 'canvas':    return 'json'
    case 'questions': return 'json'
    case 'todos':     return 'json'
    case 'design-system': return 'json'
    case 'code':      return safeExtFromLang(language)
    default:          return 'txt'
  }
}

function safeExtFromLang(lang?: string): string {
  if (!lang) return 'txt'
  const l = lang.toLowerCase()
  const table: Record<string, string> = {
    javascript: 'js', typescript: 'ts', python: 'py', ruby: 'rb', go: 'go',
    rust: 'rs', java: 'java', kotlin: 'kt', swift: 'swift', sh: 'sh', bash: 'sh',
    html: 'html', css: 'css', json: 'json', yaml: 'yml', toml: 'toml', sql: 'sql',
    tsx: 'tsx', jsx: 'jsx', markdown: 'md'
  }
  return table[l] || l.replace(/[^a-z0-9]/g, '').slice(0, 6) || 'txt'
}

/** 磁盘文件名 → 粗粒度 artifact type（latch 同 type 比较 + registry 重建 legacy 记录共用；与 extForType 反向） */
export function coarseTypeFromFile(file: string): string {
  const f = file.toLowerCase()
  if (f.endsWith('.html') || f.endsWith('.htm')) return 'html'
  if (f.endsWith('.svg')) return 'svg'
  if (f.endsWith('.md') || f.endsWith('.markdown')) return 'markdown'
  if (f.endsWith('.json')) return 'canvas'
  return 'code'
}

/** 标题相似判定（归一后 equal / 子串 ≥6）——create 门闩与 registry 按标题解析共用同一阈值，避免两处漂移 */
export function titlesSimilar(a: string, b: string): boolean {
  return !!a && !!b && (a === b || (a.length >= 6 && b.includes(a)) || (b.length >= 6 && a.includes(b)))
}

function ensureDir(convId: string): string {
  assertSafeStorageComponent(convId, 'conversationId')
  const dir = resolveConversationDir(convId, true)
  if (!dir) throw new Error('artifact 会话目录不安全或不可用')
  return dir
}

// ---- jsx 场景预编译（W2：文件夹型动画产物）----
// 场景文件 = create_artifact(type='code', language='jsx')。主进程存盘时用 esbuild JS API
// 同步产出 <id>.compiled.js（同目录 sibling），供 dc 薄壳的 x-import 链式引用（srcdoc/data:/file:
// 下相对 fetch 不可用，宿主必须"删 from + 预载全局"）。原始 .jsx 需 CDN Babel，离线不可依赖。

const JSX_GATE_BASE = 'window.React&&window.ReactDOM'
// Sidecar wrapper recipe version. Historical builds used a DOMContentLoaded-only wrapper,
// which could evaluate a scene before animations.jsx had exposed Stage/Sprite. mtime cannot
// detect that stale runtime shape, so every generated sidecar carries a recipe marker and
// loadCompiledArtifact self-heals marker-less legacy files on first preview.
const JSX_COMPILED_RECIPE_MARKER = '/* openpipal-jsx-compiled:v2 */'

export function isCompilableJsx(type?: string, language?: string): boolean {
  return type === 'code' && String(language || '').toLowerCase() === 'jsx'
}

/**
 * 弱模型经常把文件名写成 `scene.jsx`，却漏掉可选的 language 字段。标题里的显式扩展名
 * 是比猜源码更可靠的信号：保存前统一补齐，避免 code artifact 落成 `.txt` 后丢失编译链。
 */
export function normalizeArtifactLanguage(artifact: Pick<ArtifactData, 'type' | 'title' | 'language'>): string | undefined {
  if (artifact.language) return artifact.language
  if (artifact.type !== 'code') return undefined
  const m = String(artifact.title || '').trim().match(/\.([A-Za-z0-9]+)$/)
  if (!m) return undefined
  const ext = m[1].toLowerCase()
  const byExt: Record<string, string> = {
    jsx: 'jsx', tsx: 'tsx', js: 'javascript', ts: 'typescript', py: 'python',
    rb: 'ruby', rs: 'rust', kt: 'kotlin', sh: 'bash', yml: 'yaml', md: 'markdown'
  }
  return byExt[ext]
}

/** 历史 `.txt` 自愈只接纳强 JSX 场景形状，避免把普通文本误编译成 JavaScript。 */
function looksLikeLegacyJsxScene(source: string): boolean {
  return /<(?:Stage|Beat|Sprite|[A-Z][A-Za-z0-9_]*)[\s/>]/.test(source) &&
    (/\bObject\.assign\(\s*window\b/.test(source) || /\bwindow\.[A-Z][A-Za-z0-9_]*\s*=/.test(source))
}

/**
 * 场景是否依赖 animations 链的全局（Stage 屏障）：引用 Stage 但不自定义时，poll 门闩追加
 * window.Stage —— animations.compiled.js 的 __run 用一条 Object.assign(window,{…Stage…}) 原子暴露
 * 全部动画原语，故 window.Stage 在场即整条链在场，"场景求值时前序全局必须已在场"得到保证。
 */
function needsStageGate(src: string): boolean {
  if (!/\bStage\b/.test(src)) return false
  // 场景自身定义/导出 Stage 时不能自等（否则 15s 死等）——排除 animations 式自暴露
  if (/window\.Stage\s*=/.test(src)) return false
  if (/Object\.assign\(\s*window[^)]*\bStage\b/.test(src)) return false
  return true
}

function compiledBoot(gate: string): string {
  return `if(${gate}){__run()}else{var __t=setInterval(function(){if(${gate}){clearInterval(__t);__run()}},30);setTimeout(function(){clearInterval(__t)},15000)}`
}

/**
 * 早期 sidecar 已经把多段场景分别编成合法 IIFE，只是启动条件错误。此类文件无需再解析
 * 原始 JSX，直接把 DOMContentLoaded boot 升级为 React/Stage 门闩，既保留历史可执行字节，
 * 也避开多场景源文件里的重复 const 声明。
 */
function upgradeLegacyCompiledRecipe(compiled: string, source: string): string | null {
  if (!compiled.includes('var __run=function()')) return null
  const legacyBoot = /if\s*\(\s*document\.readyState\s*===\s*['"]loading['"]\s*\)\s*document\.addEventListener\(\s*['"]DOMContentLoaded['"]\s*,\s*__run\s*\)\s*;\s*else\s*__run\(\)\s*;/
  if (!legacyBoot.test(compiled)) return null
  const gate = needsStageGate(source) ? `${JSX_GATE_BASE}&&window.Stage` : JSX_GATE_BASE
  return `${JSX_COMPILED_RECIPE_MARKER}\n${compiled.replace(legacyBoot, compiledBoot(gate))}`
}

/**
 * 模型偶尔把多个独立场景顺序追加进一个 JSX artifact。每段都以简单的
 * Object.assign(window,{...}) 自注册结束；整文件 transform 会因重复 const/function 失败，
 * 但逐段 transform 与浏览器原本的多个 script 语义一致。
 */
function splitRegisteredJsxScenes(source: string): string[] {
  const endRe = /Object\.assign\(\s*window\s*,\s*\{[^{}]*\}\s*\)\s*;?/g
  const ends: number[] = []
  let match: RegExpExecArray | null
  while ((match = endRe.exec(source)) !== null) ends.push(match.index + match[0].length)
  if (ends.length < 2) return []
  const parts: string[] = []
  let start = 0
  for (const end of ends) {
    const part = source.slice(start, end).trim()
    if (part) parts.push(part)
    start = end
  }
  const tail = source.slice(start).trim()
  if (tail && parts.length) parts[parts.length - 1] += `\n${tail}`
  return parts.length >= 2 ? parts : []
}

/**
 * jsx → 浏览器可跑 IIFE：esbuild transformSync(loader:'jsx', format:'iife')，外包 React 就绪
 * poll 门闩（沿用冻结的 animations.compiled.js 字节配方）。编译失败回传 { error } 不抛，
 * 让工具层把错误交给模型自修。
 */
export function compileJsxArtifact(source: string): { js?: string; error?: string } {
  let body: string
  const esbuild = loadEsbuild()
  try {
    body = esbuild.transformSync(source, { loader: 'jsx', format: 'iife' }).code
  } catch (err: any) {
    const parts = splitRegisteredJsxScenes(source)
    if (!parts.length) {
      const msg = err?.message || String(err)
      return { error: msg.replace(/\s+/g, ' ').trim().slice(0, 300) }
    }
    try {
      body = parts.map((part) => esbuild.transformSync(part, { loader: 'jsx', format: 'iife' }).code).join('\n')
    } catch (segmentErr: any) {
      const msg = segmentErr?.message || String(segmentErr)
      return { error: msg.replace(/\s+/g, ' ').trim().slice(0, 300) }
    }
  }
  const gate = needsStageGate(source) ? `${JSX_GATE_BASE}&&window.Stage` : JSX_GATE_BASE
  const js =
    `${JSX_COMPILED_RECIPE_MARKER}\n(function(){var __run=function(){\n${body}\n};` +
    `${compiledBoot(gate)}})();`
  return { js }
}

/** 编译并写 <id>.compiled.js；失败时删掉陈旧产物并回传错误（best-effort，不抛） */
export function writeCompiledSidecar(dir: string, artifactId: string, source: string): string | null {
  if (!isSafeStorageComponent(artifactId)) return 'artifactId 格式无效'
  const safeDir = resolveExistingConversationDirPath(dir)
  if (!safeDir) return 'artifact 会话目录不安全或不可用'
  const outName = `${artifactId}.compiled.js`
  const res = compileJsxArtifact(source)
  if (res.error) {
    try {
      const out = secureArtifactLeafPath(safeDir, outName)
      const info = fs.lstatSync(out)
      if (info.isFile() && !info.isSymbolicLink()) fs.rmSync(out)
    } catch {}
    return res.error
  }
  try { writeUtf8ArtifactFile(safeDir, outName, res.js || '') } catch (err: any) {
    return err?.message || 'write compiled failed'
  }
  return null
}

/**
 * dc 薄壳的 x-import 链引用 ./artifact-<id>.jsx → 解析同目录 <id>.compiled.js 文本；
 * ./artifact-<id>.js（未编译普通 js 产物）直接返回 <id>.js 原文。renderer 经 IPC 调用。
 */
export function loadCompiledArtifact(conversationId: string, artifactId: string): string | null {
  if (!isSafeStorageComponent(conversationId) || !artifactId) return null
  if (!/^artifact-[A-Za-z0-9_-]+$/.test(artifactId)) return null // 防路径穿越
  const dir = resolveConversationDir(conversationId, false)
  if (!dir) return null
  const compiledName = `${artifactId}.compiled.js`
  const plainName = `${artifactId}.js`
  const jsxName = `${artifactId}.jsx`
  const legacyName = `${artifactId}.txt`
  try {
    // 自愈（Workstream B2）：源 .jsx 比 compiled 新、compiled 缺失，或 sidecar 仍是旧 recipe
    // （历史 DOMContentLoaded-only wrapper 会在 Stage 就绪前捕获 undefined）→ 当场重编译回写。
    // 别让"谁写了源文件"或旧编译配方决定预览新旧。
    const jsxSource = readUtf8ArtifactFile(dir, jsxName)
    if (jsxSource !== null) {
      const jsxSrc = secureArtifactLeafPath(dir, jsxName)
      const compiled = secureArtifactLeafPath(dir, compiledName)
      const srcMtime = fs.statSync(jsxSrc).mtimeMs
      const compiledText = readUtf8ArtifactFile(dir, compiledName) || ''
      const compiledMtime = compiledText ? fs.statSync(compiled).mtimeMs : -1
      const staleRecipe = !compiledText.includes(JSX_COMPILED_RECIPE_MARKER)
      const source = jsxSource
      if (staleRecipe && srcMtime <= compiledMtime) {
        const upgraded = upgradeLegacyCompiledRecipe(compiledText, source)
        if (upgraded) {
          try { writeUtf8ArtifactFile(dir, compiledName, upgraded) } catch { /* 本次仍直接返回升级文本；下次可重试回写 */ }
          return upgraded
        }
      }
      if (srcMtime > compiledMtime || staleRecipe) {
        const res = compileJsxArtifact(source)
        if (res.js) {
          try { writeUtf8ArtifactFile(dir, compiledName, res.js) } catch {}
          return res.js
        }
        console.warn('[artifact-store] compiled 自愈编译失败，回退旧 compiled:', res.error)
      }
    }
    const compiledText = readUtf8ArtifactFile(dir, compiledName)
    if (compiledText !== null) return compiledText
    const plainText = readUtf8ArtifactFile(dir, plainName)
    if (plainText !== null) return plainText
    // 2026-07 之前 language 可选，标题虽是 .jsx 仍会落成 .txt。只对强场景形状做一次
    // 编译迁移：保留原 .txt 兼容旧 ref，同时补写 .jsx + compiled，之后预览走正常宿主内联链。
    const legacyText = readUtf8ArtifactFile(dir, legacyName)
    if (legacyText !== null) {
      const source = legacyText
      if (looksLikeLegacyJsxScene(source)) {
        const res = compileJsxArtifact(source)
        if (res.js) {
          try {
            writeUtf8ArtifactFile(dir, jsxName, source)
            writeUtf8ArtifactFile(dir, compiledName, res.js)
          } catch {
            // 只影响自愈文件回写；已编译文本仍可直接返回给本次预览。
          }
          return res.js
        }
        console.warn('[artifact-store] legacy .txt JSX 自愈编译失败:', res.error)
      }
    }
  } catch {}
  return null
}

export function saveArtifact(conversationId: string, artifact: ArtifactData): ArtifactRef {
  assertSafeStorageComponent(conversationId, 'conversationId')
  assertSafeStorageComponent(artifact?.id, 'artifactId')
  const language = normalizeArtifactLanguage(artifact)
  // ephemeral 类型不落盘——返回不含真实路径的 ref（path 留空，调用方已按"无 path 则跳过"处理）
  if (EPHEMERAL_ARTIFACT_TYPES.has(artifact.type)) {
    return { id: artifact.id, type: artifact.type, title: artifact.title, path: '', language }
  }
  const dir = ensureDir(conversationId)
  const ext = extForType(artifact.type, language)
  const filename = `${artifact.id}.${ext}`
  const filePath = secureArtifactLeafPath(dir, filename)
  writeUtf8ArtifactFile(dir, filename, artifact.content || '')
  // jsx 场景：同步产出编译 sidecar（best-effort，编译失败不阻塞保存）
  if (isCompilableJsx(artifact.type, language)) {
    writeCompiledSidecar(dir, artifact.id, artifact.content || '')
  }
  return {
    id: artifact.id,
    type: artifact.type,
    title: artifact.title,
    path: filePath,
    language
  }
}

function resolveArtifactRef(
  ref: ArtifactRef,
  expectedConversationId?: string
): { dir: string; fileName: string } | null {
  if (!ref?.path || !isSafeStorageComponent(ref.id)) return null
  if (expectedConversationId !== undefined && !isSafeStorageComponent(expectedConversationId)) return null
  const root = resolveArtifactsRoot(false)
  if (!root) return null
  try {
    const info = fs.lstatSync(ref.path)
    if (!info.isFile() || info.isSymbolicLink()) return null
    const real = fs.realpathSync(ref.path)
    if (!isPathInside(root, real)) return null
    const relative = path.relative(root, real)
    const parts = relative.split(path.sep)
    if (parts.length !== 2) return null
    const [conversationId, fileName] = parts
    if (!isSafeStorageComponent(conversationId)) return null
    if (expectedConversationId !== undefined && conversationId !== expectedConversationId) return null
    if (!fileName.startsWith(`${ref.id}.`) || fileName.endsWith('.compiled.js')) return null
    const dir = resolveConversationDir(conversationId, false)
    if (!dir || path.dirname(real) !== dir) return null
    return { dir, fileName }
  } catch {
    return null
  }
}

export function loadArtifact(ref: ArtifactRef, expectedConversationId?: string): ArtifactData | null {
  const target = resolveArtifactRef(ref, expectedConversationId)
  if (!target) {
    if (ref?.path) console.warn('[artifact-store] 拒绝加载越权或无效路径:', ref.path)
    return null
  }
  try {
    const content = readUtf8ArtifactFile(target.dir, target.fileName)
    if (content === null) return null
    return {
      id: ref.id,
      type: ref.type,
      title: ref.title,
      content,
      language: ref.language
    }
  } catch (err: any) {
    // ENOENT 是常态：ephemeral sidecar 被启动 GC 清掉后，旧会话重开按 artifactRef 加载会
    // 必然踩到——静默降级，不刷屏；其它错误（权限/损坏等）保持原样打印，方便定位真实问题。
    if (err?.code !== 'ENOENT') {
      console.warn('[artifact-store] 加载失败:', ref.path, err?.message)
    }
    return null
  }
}

export function updateArtifact(ref: ArtifactRef, newContent: string): void {
  const target = resolveArtifactRef(ref)
  if (!target) return
  try {
    writeUtf8ArtifactFile(target.dir, target.fileName, newContent)
    if (isCompilableJsx(ref.type, ref.language)) {
      writeCompiledSidecar(target.dir, ref.id, newContent)
    }
  } catch (err: any) {
    console.warn('[artifact-store] 更新失败:', ref.path, err?.message)
  }
}

/** 标题归一化（比对同名重建用）：去扩展名、只留字母数字和 CJK、小写 */
export function normalizeArtifactTitle(title: string): string {
  return String(title || '')
    .toLowerCase()
    .replace(/\.dc\.html?$|\.(html?|md|svg|json|jsx|js)$/i, '')
    .replace(/[^a-z0-9一-鿿]+/g, '')
}

/**
 * create_artifact 相近标题门闩的纯判定（W2 收窄：仅同 type 之间比较——html 薄壳与 code 场景
 * 同名可共存，html+html 相近仍拦）。返回命中的既有产物（取最后一个）或 null。
 */
export function findSimilarArtifact(
  wantedTitle: string,
  newType: string,
  entries: { id: string; title: string; type: string }[]
): { id: string; title: string } | null {
  const wanted = normalizeArtifactTitle(wantedTitle)
  if (!wanted) return null
  // 含"包含"关系：实测模型会加后缀绕过纯同名（「落地页」→「落地页 · 深色高级风」）
  const hit = entries
    .filter((e) => e.type === newType && titlesSimilar(normalizeArtifactTitle(e.title), wanted))
    .pop()
  return hit ? { id: hit.id, title: hit.title } : null
}

export interface ConversationArtifactEntry {
  id: string
  title: string
  file: string
  /** 文件 mtime(毫秒)。磁盘层面的"最后真实修改时间"——真实 edit 才会变,叙述式声明不会 */
  mtimeMs?: number
}

/**
 * 当前会话的 artifact 清单——磁盘 sidecar 目录是事实来源（跨重启有效，天然按会话隔离）。
 * title 从会话 JSON 的 artifactRef 补齐（sidecar 文件名只有 id）。
 * 实测教训（2026-07-03）：曾用进程级全局缓存充当"本会话清单"，把别的会话的 artifact
 * 列给模型 → 模型 render 了别人的产物、按错误结论推倒重做出重复 artifact。
 */
export function listConversationArtifacts(conversationId: string): ConversationArtifactEntry[] {
  const dir = resolveConversationDir(conversationId, false)
  if (!dir) return []
  let files: string[]
  try { files = fs.readdirSync(dir) } catch { return [] }
  const titles = new Map<string, string>()
  for (const m of peekConversationMessages(conversationId)) {
    const ref = m.artifactRef
    if (ref?.id) titles.set(ref.id, ref.title || '')
  }
  const byId = new Map<string, ConversationArtifactEntry>()
  for (const f of files.sort()) {
    if (!f.startsWith('artifact-')) continue
    if (f.endsWith('.compiled.js')) continue // jsx 编译 sidecar，不是独立产物
    const id = f.replace(/\.[^.]+$/, '')
    const existing = byId.get(id)
    // 孪生文件兜底：同 id 若已有强类型扩展记录（.jsx/.html/.svg/.md 等），字典序排后面的 .txt
    // 不应覆盖它——历史遗留（缺 language 误落成 .txt）会让 byId 指错文件（编辑到 .txt 而非 .jsx）。
    // .txt 只在没有其它候选时才采用。
    if (existing && !existing.file.endsWith('.txt') && f.endsWith('.txt')) continue
    const full = path.join(dir, f)
    let mtimeMs: number | undefined
    try { mtimeMs = fs.statSync(full).mtimeMs } catch { /* 文件竞态删除,清单里不带时间即可 */ }
    byId.set(id, { id, title: titles.get(id) || '', file: full, mtimeMs })
  }
  return Array.from(byId.values())
}

/** 按 artifact id 全局查找 sidecar 文件（仅限拿不到 convId 的调用方兜底——能拿到时必须用会话内清单，避免跨会话编错文件） */
export function findArtifactFileById(artifactId: string): string | null {
  if (!isSafeStorageComponent(artifactId)) return null
  const root = resolveArtifactsRoot(false)
  if (!root) return null
  // id 含时间戳全局唯一；目录数量 = 会话数，线性扫可接受
  for (const conv of fs.readdirSync(root)) {
    const dir = resolveConversationDir(conv, false)
    if (!dir) continue
    let files: string[]
    try { files = fs.readdirSync(dir) } catch { continue }
    // 排除 <id>.compiled.js sidecar——始终返回主产物文件（.jsx/.js/.html…）
    const hit = files.find(f => f.startsWith(artifactId + '.') && !f.endsWith('.compiled.js'))
    if (hit) return path.join(dir, hit)
  }
  return null
}

export interface ArtifactHistoryEntry {
  id: string
  type: string
  title: string
  conversationId: string
  conversationTitle: string
  updatedAt: number
  /** render_artifact 自检截图缩成的 JPEG dataURL（截图不存在则无） */
  thumbnail?: string
}

/**
 * 历史产物枚举（首屏产物列表用）——只扫消息里的 artifactRef 元数据，不读 content。
 * 会话按 updatedAt 降序，同 id 多次迭代取最后一次的 ref（title 最新）。
 */
export async function listArtifactHistory(opts?: { role?: string; limit?: number }): Promise<ArtifactHistoryEntry[]> {
  const role = opts?.role
  const limit = opts?.limit ?? 24
  const out: ArtifactHistoryEntry[] = []
  const seen = new Set<string>()
  for (const conv of await listConversations()) {
    if (role && conv.role !== role) continue
    const msgs = await getConversationMessages(conv.id)
    for (let i = msgs.length - 1; i >= 0; i--) {
      const ref = msgs[i].artifactRef
      if (!ref?.id || seen.has(ref.id)) continue
      // ephemeral 过程物（todos/questions/goal/mcp-app）不进历史产物列表——即使按 id 前缀等
      // 手段已无法从磁盘扩展名判定，仍能靠 ref.type 精确过滤（存量垃圾走 5 的启动 GC 单独清）
      if (EPHEMERAL_ARTIFACT_TYPES.has(ref.type)) continue
      seen.add(ref.id)
      out.push({
        id: ref.id,
        type: ref.type,
        title: ref.title,
        conversationId: conv.id,
        conversationTitle: conv.title,
        updatedAt: conv.updatedAt,
        thumbnail: selfCheckThumbnail(ref.id)
      })
    }
    if (out.length >= limit) break
  }
  return out.slice(0, limit)
}

// 缩略图缓存：nativeImage 解码+缩放开销大且每次打开前置页都会全量调用，按截图 mtime 失效
// 无界增长防护：上限 200 条，插入超限删最老——Map 天然按插入序，够用（非严格 LRU）。
const thumbCache = new Map<string, { mtimeMs: number; dataUrl: string | undefined }>()
const THUMB_CACHE_MAX = 200

/** 会话删除时同步清理（配合 artifact-registry 的 registry.delete）。未知 id 是 no-op。 */
export function evictThumbCache(artifactId: string): void {
  thumbCache.delete(artifactId)
}

function selfCheckThumbnail(artifactId: string): string | undefined {
  if (!isSafeStorageComponent(artifactId)) return undefined
  const shot = dataPath('outputs', '.self-check', `${artifactId}.png`)
  let mtimeMs: number
  try { mtimeMs = fs.statSync(shot).mtimeMs } catch { return undefined }
  const hit = thumbCache.get(artifactId)
  if (hit && hit.mtimeMs === mtimeMs) return hit.dataUrl
  let dataUrl: string | undefined
  try {
    const { nativeImage } = require('electron')
    const img = nativeImage.createFromPath(shot)
    dataUrl = img.isEmpty() ? undefined : 'data:image/jpeg;base64,' + img.resize({ width: 320 }).toJPEG(70).toString('base64')
  } catch {
    dataUrl = undefined
  }
  thumbCache.set(artifactId, { mtimeMs, dataUrl })
  if (thumbCache.size > THUMB_CACHE_MAX) {
    const oldest = thumbCache.keys().next().value
    if (oldest !== undefined) thumbCache.delete(oldest)
  }
  return dataUrl
}

export function deleteArtifactsForConversation(conversationId: string): void {
  const dir = resolveConversationDir(conversationId, false)
  if (!dir) return
  try {
    fs.rmSync(dir, { recursive: true, force: true })
  } catch (err: any) {
    console.warn('[artifact-store] 清理会话 artifact 目录失败:', dir, err?.message)
  }
}

// ephemeral 类型改为不落盘（见上 saveArtifact）之前，todos/questions 曾被写成 <prefix>-*.json
// 长期滞留磁盘（从未真正进模型清单/历史列表——todos 因不带 artifactRef、questions 现按 A4 类型
// 过滤，二者磁盘 sidecar 也因 id 前缀非 'artifact-' 天然不出现在 listConversationArtifacts）。
// goal 从不经 saveArtifact（走 conversationConfig），此处一并匹配纯防御，实测无命中。
const EPHEMERAL_DEBRIS_RE = /^(?:todos|questions|goal)-.*\.json$/

/**
 * 启动一次性 GC（best-effort，不抛）：
 * 1. 清理历史遗留的 ephemeral 过程物 sidecar（上面三个前缀的 .json）。
 * 2. 清理"孪生 .txt"——曾因缺 language 误把 jsx/其它强类型产物落成 <id>.txt，与同 id 强类型
 *    文件字节相同时可安全删除（避免 listConversationArtifacts 字典序覆盖指错文件）。
 * 只删匹配已知前缀/孪生判据的文件，不碰其它内容。
 */
export function gcArtifactDebris(): { removedEphemeral: number; removedTwins: number } {
  let removedEphemeral = 0
  let removedTwins = 0
  let convDirs: string[]
  try { convDirs = fs.readdirSync(ARTIFACTS_ROOT) } catch { return { removedEphemeral, removedTwins } }
  for (const conv of convDirs) {
    const dir = resolveConversationDir(conv, false)
    if (!dir) continue
    let files: string[]
    try { files = fs.readdirSync(dir) } catch { continue }
    for (const f of files) {
      if (!EPHEMERAL_DEBRIS_RE.test(f)) continue
      try { fs.unlinkSync(path.join(dir, f)); removedEphemeral++ } catch {}
    }
    let remaining: string[]
    try { remaining = fs.readdirSync(dir) } catch { continue }
    for (const f of remaining) {
      if (!f.endsWith('.txt')) continue
      const id = f.replace(/\.txt$/, '')
      const twin = remaining.find((g) => g !== f && g.startsWith(id + '.') && !g.endsWith('.compiled.js'))
      if (!twin) continue
      try {
        const a = fs.readFileSync(path.join(dir, f))
        const b = fs.readFileSync(path.join(dir, twin))
        if (a.equals(b)) { fs.unlinkSync(path.join(dir, f)); removedTwins++ }
      } catch {}
    }
  }
  return { removedEphemeral, removedTwins }
}

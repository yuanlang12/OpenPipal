/**
 * 随消息图片落盘（对齐官方 Claude Design 的 uploads/ 形状，2026-07-22）：
 * 粘贴/发送的图片除了作为视觉输入进模型，还存一份到本会话 artifacts/<convId>/uploads/
 * `pasted-<ts>-<i>.png`（官方同款命名）。价值：
 *  - 模型拿到确定的文件路径（随消息注入），dc 文档配图用相对路径 `uploads/…` 直接引用；
 *  - 消除"模型在磁盘上找图"这个动作本身（实案：找不到粘贴图 → find 全盘扫描 → TCC 连环弹窗）；
 *  - 与 artifact 同目录 → 导出交付物时随包携带，形状与官方 zip 一致。
 *
 * 此处的目录来自 IPC/HTTP 会话 id，不能把“只做 basename 检查”当成存储边界：
 * 根目录、会话目录、uploads 目录和叶子文件都要拒绝软链接，并且每次 I/O 都 no-follow。
 */
import fs from 'fs'
import path from 'path'
import { homedir } from 'os'
import { randomBytes } from 'crypto'
import { isSafeConversationStorageId } from './attachment-store'
import { dataPath } from './data-root'

const NO_FOLLOW = fs.constants.O_NOFOLLOW || 0

function artifactsRootPath(): string {
  return dataPath('conversations', 'artifacts')
}

function isPathInside(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(root + path.sep)
}

/** Resolve the exact canonical artifacts root; do not permit the root itself to be a symlink. */
function resolveArtifactsRoot(create: boolean): string | null {
  const logical = artifactsRootPath()
  try {
    if (create) fs.mkdirSync(logical, { recursive: true, mode: 0o700 })
    const info = fs.lstatSync(logical)
    if (!info.isDirectory() || info.isSymbolicLink()) return null
    const real = fs.realpathSync(logical)
    // `os.tmpdir()` can itself pass through a macOS /var → /private/var alias
    // in tests. The root is our boundary, so canonicalize that alias but reject
    // a symlink at the root component itself (checked by lstat above).
    return fs.statSync(real).isDirectory() ? real : null
  } catch {
    return null
  }
}

/** Resolve a conversation directory below the canonical root, never through a symlink. */
function resolveConversationArtifactsDir(conversationId: string, create: boolean): string | null {
  if (!isSafeConversationStorageId(conversationId)) return null
  const root = resolveArtifactsRoot(create)
  if (!root) return null
  const dir = path.join(root, conversationId)
  if (!isPathInside(root, dir) || path.dirname(dir) !== root) return null
  try {
    if (create) fs.mkdirSync(dir, { recursive: false, mode: 0o700 })
    const info = fs.lstatSync(dir)
    if (!info.isDirectory() || info.isSymbolicLink()) return null
    const real = fs.realpathSync(dir)
    return real === dir && isPathInside(root, real) ? real : null
  } catch (error) {
    // mkdirSync(dir, { recursive: false }) is expected to report EEXIST for an
    // existing safe directory. Re-check it, but never recover from other errors.
    if (!create || (error as NodeJS.ErrnoException)?.code !== 'EEXIST') return null
    try {
      const info = fs.lstatSync(dir)
      if (!info.isDirectory() || info.isSymbolicLink()) return null
      const real = fs.realpathSync(dir)
      return real === dir && isPathInside(root, real) ? real : null
    } catch {
      return null
    }
  }
}

function resolveUploadsDir(conversationId: string, create: boolean): string | null {
  const conversationDir = resolveConversationArtifactsDir(conversationId, create)
  if (!conversationDir) return null
  const dir = path.join(conversationDir, 'uploads')
  try {
    if (create) fs.mkdirSync(dir, { recursive: false, mode: 0o700 })
    const info = fs.lstatSync(dir)
    if (!info.isDirectory() || info.isSymbolicLink()) return null
    const real = fs.realpathSync(dir)
    return real === dir && isPathInside(conversationDir, real) ? real : null
  } catch (error) {
    if (!create || (error as NodeJS.ErrnoException)?.code !== 'EEXIST') return null
    try {
      const info = fs.lstatSync(dir)
      if (!info.isDirectory() || info.isSymbolicLink()) return null
      const real = fs.realpathSync(dir)
      return real === dir && isPathInside(conversationDir, real) ? real : null
    } catch {
      return null
    }
  }
}

/** A leaf must be one literal direct child, never a dot-segment or sibling prefix. */
function resolveLeaf(dir: string, name: string, mustExist: boolean): string | null {
  if (!name || name === '.' || name === '..' || path.basename(name) !== name) return null
  const candidate = path.join(dir, name)
  if (!isPathInside(dir, candidate) || path.dirname(candidate) !== dir) return null
  if (!mustExist) return candidate
  try {
    const info = fs.lstatSync(candidate)
    if (!info.isFile() || info.isSymbolicLink()) return null
    const real = fs.realpathSync(candidate)
    return real === candidate && isPathInside(dir, real) ? real : null
  } catch {
    return null
  }
}

function existingLeafIsSafe(file: string): boolean {
  try {
    const info = fs.lstatSync(file)
    return info.isFile() && !info.isSymbolicLink()
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code === 'ENOENT'
  }
}

/** Atomic, no-follow replacement so a pre-existing symlink is never followed. */
function writeSafeFile(dir: string, name: string, content: string | Buffer): boolean {
  if (!NO_FOLLOW) return false
  const target = resolveLeaf(dir, name, false)
  if (!target || !existingLeafIsSafe(target)) return false
  const temporaryName = `.openpipal-write-${randomBytes(16).toString('hex')}.tmp`
  const temporary = resolveLeaf(dir, temporaryName, false)
  if (!temporary) return false

  let fd: number | undefined
  try {
    fd = fs.openSync(
      temporary,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | NO_FOLLOW,
      0o600
    )
    if (!fs.fstatSync(fd).isFile()) return false
    fs.fchmodSync(fd, 0o600)
    fs.writeFileSync(fd, content)
    fs.fsyncSync(fd)
    fs.closeSync(fd)
    fd = undefined

    // Do not silently replace an attacker-provided link. If a race replaces it
    // after this check, rename replaces the link itself rather than following it.
    if (!existingLeafIsSafe(target)) return false
    fs.renameSync(temporary, target)
    return true
  } catch (err: any) {
    console.warn('[ChatUploads] 文件落盘失败:', name, err?.message)
    return false
  } finally {
    if (fd !== undefined) fs.closeSync(fd)
    try { fs.unlinkSync(temporary) } catch { /* rename succeeded or creation failed */ }
  }
}

function readSafeFile(dir: string, name: string): Buffer | null {
  if (!NO_FOLLOW) return null
  const target = resolveLeaf(dir, name, true)
  if (!target) return null
  let fd: number | undefined
  try {
    fd = fs.openSync(target, fs.constants.O_RDONLY | NO_FOLLOW)
    if (!fs.fstatSync(fd).isFile()) return null
    return fs.readFileSync(fd)
  } catch {
    return null
  } finally {
    if (fd !== undefined) fs.closeSync(fd)
  }
}

/**
 * 把 base64 图片批量落盘，返回相对路径（`uploads/pasted-<ts>-<i>.png`）。
 * 单张写失败跳过不阻塞其余；非法会话 id 返回空数组。
 */
export function persistChatImages(conversationId: string, images: string[], nowMs = Date.now()): string[] {
  if (!isSafeConversationStorageId(conversationId) || !Array.isArray(images) || images.length === 0) return []
  const dir = resolveUploadsDir(conversationId, true)
  if (!dir) return []
  const rels: string[] = []
  images.forEach((b64, i) => {
    const name = `pasted-${nowMs}-${i}.png`
    if (writeSafeFile(dir, name, Buffer.from(b64, 'base64'))) rels.push(`uploads/${name}`)
  })
  return rels
}

export const MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.gif': 'image/gif', '.svg': 'image/svg+xml'
}

/**
 * 读取会话 uploads 下的单个资源（srcdoc 预览内联成 data URI 用）。
 * 只接受纯文件名（basename），杜绝路径穿越；未知扩展名/不存在返回 null。
 */
export function readUploadAsset(conversationId: string, name: string): { base64: string; mime: string } | null {
  if (!isSafeConversationStorageId(conversationId)) return null
  if (!name || name !== path.basename(name) || name.startsWith('.')) return null
  const mime = MIME_BY_EXT[path.extname(name).toLowerCase()]
  if (!mime) return null
  const dir = resolveUploadsDir(conversationId, false)
  if (!dir) return null
  const buf = readSafeFile(dir, name)
  return buf ? { base64: buf.toString('base64'), mime } : null
}

/** 会话 uploads 目录的绝对路径（消息注入提示 / 导出拷贝共用）。 */
export function conversationUploadsDir(conversationId: string): string {
  // This is a prompt/export hint rather than an I/O capability. Still reject an
  // unsafe id so it never materializes a path outside the OpenPipal storage tree.
  return isSafeConversationStorageId(conversationId)
    ? path.join(artifactsRootPath(), conversationId, 'uploads')
    : ''
}

// ── 产物 sidecar（*.state.json）读写——image-slot / design-canvas 这类可编辑预制件的持久化契约 ──
// 组件在 iframe 里经 window.openpipal.writeFile 提交整文件替换、经 fetch 读回；
// 宿主职责：只放行 *.state.json 基名、落到产物所在会话目录（与 dc.html/uploads 同层）。
const SIDECAR_NAME_RE = /^[A-Za-z0-9._-]+\.state\.json$/
// image-slot 把图片按 ≤1200px WebP dataURL 内嵌进 state 本体（单槽 ~150-300KB）——给足余量
const SIDECAR_MAX_BYTES = 20 * 1024 * 1024

export function writeArtifactSidecar(conversationId: string, name: string, content: string): boolean {
  if (!isSafeConversationStorageId(conversationId)) return false
  if (!name || name !== path.basename(name) || !SIDECAR_NAME_RE.test(name)) return false
  if (typeof content !== 'string' || Buffer.byteLength(content, 'utf8') > SIDECAR_MAX_BYTES) return false
  try { JSON.parse(content) } catch { return false } // 契约就是 JSON 状态文件,拒绝任意字节
  const dir = resolveConversationArtifactsDir(conversationId, true)
  return !!dir && writeSafeFile(dir, name, content)
}

export function readArtifactSidecar(conversationId: string, name: string): string | null {
  if (!isSafeConversationStorageId(conversationId)) return null
  if (!name || name !== path.basename(name) || !SIDECAR_NAME_RE.test(name)) return null
  const dir = resolveConversationArtifactsDir(conversationId, false)
  const content = dir ? readSafeFile(dir, name) : null
  return content ? content.toString('utf8') : null
}

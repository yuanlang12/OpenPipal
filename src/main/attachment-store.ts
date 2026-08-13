/**
 * 消息附件卸载存储 —— 工具截图(png)与 MCP App 渲染载荷(json)的 sidecar。
 *
 * 动机：这两类载荷动辄 MB 级（实测单会话 mcpAppPayload 3.16MB/92% 占比、截图 50-88%），
 * 内联在 conversation.json 里会让每次防抖落盘全文件重写、切会话全量 parse。
 * 卸载到会话 artifacts 目录的 attachments/ 子目录，消息里只留 ref（纯文件名）。
 *
 * 独立成模块的原因：conversation-store（读侧重内联）与 artifact-store（互相有依赖）都要用，
 * 放任一边都会形成 import 环。
 *
 * 命名约定：不带 artifact- 前缀 + 独立子目录 —— listConversationArtifacts 只认根目录的
 * artifact-* 文件，附件不会混进模型可见的 session-artifacts 清单。
 */
import fs from 'fs'
import path from 'path'
import { homedir } from 'os'
import { dataPath } from './data-root'

const ARTIFACTS_ROOT = dataPath('conversations', 'artifacts')
const SAFE_CONVERSATION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,159}$/
const SAFE_ATTACHMENT_REF_RE = /^[A-Za-z0-9_.-]{1,200}$/
const NO_FOLLOW = fs.constants.O_NOFOLLOW || 0

export type AttachmentKind = 'screenshot' | 'mcpapp'

/**
 * Conversation ids become directory and file-name components in several stores.
 * Keep this validator independent of whether an id currently exists: generated
 * UUIDs and the historical alphanumeric/hyphen ids are accepted, separators,
 * dot-segments, percent escapes and unbounded names are not.
 */
export function isSafeConversationStorageId(value: unknown): value is string {
  return typeof value === 'string' && SAFE_CONVERSATION_ID_RE.test(value)
}

function isPathInside(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(root + path.sep)
}

function resolveArtifactsRoot(create: boolean): string | null {
  try {
    if (create) fs.mkdirSync(ARTIFACTS_ROOT, { recursive: true, mode: 0o700 })
    const info = fs.lstatSync(ARTIFACTS_ROOT)
    if (!info.isDirectory() && !info.isSymbolicLink()) return null
    const real = fs.realpathSync(ARTIFACTS_ROOT)
    return fs.statSync(real).isDirectory() ? real : null
  } catch {
    return null
  }
}

/** Resolve the exact non-symlink attachments directory below the canonical root. */
function resolveAttachmentsDir(conversationId: string, create: boolean): string | null {
  if (!isSafeConversationStorageId(conversationId)) return null
  const root = resolveArtifactsRoot(create)
  if (!root) return null

  const logicalConversationDir = path.join(ARTIFACTS_ROOT, conversationId)
  const logicalAttachmentsDir = path.join(logicalConversationDir, 'attachments')
  try {
    if (create && !fs.existsSync(logicalConversationDir)) fs.mkdirSync(logicalConversationDir, { mode: 0o700 })
    const conversationInfo = fs.lstatSync(logicalConversationDir)
    if (!conversationInfo.isDirectory() || conversationInfo.isSymbolicLink()) return null
    const realConversationDir = fs.realpathSync(logicalConversationDir)
    if (realConversationDir !== path.join(root, conversationId) || !isPathInside(root, realConversationDir)) return null

    if (create && !fs.existsSync(logicalAttachmentsDir)) fs.mkdirSync(logicalAttachmentsDir, { mode: 0o700 })
    const attachmentsInfo = fs.lstatSync(logicalAttachmentsDir)
    if (!attachmentsInfo.isDirectory() || attachmentsInfo.isSymbolicLink()) return null
    const realAttachmentsDir = fs.realpathSync(logicalAttachmentsDir)
    if (realAttachmentsDir !== path.join(realConversationDir, 'attachments')) return null
    return realAttachmentsDir
  } catch {
    return null
  }
}

function resolveAttachmentLeaf(dir: string, ref: string, mustExist: boolean): string | null {
  if (
    !SAFE_ATTACHMENT_REF_RE.test(ref) ||
    ref === '.' ||
    ref === '..' ||
    ref.includes('..') ||
    path.basename(ref) !== ref
  ) return null
  const candidate = path.join(dir, ref)
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

/**
 * 写入附件，返回 ref（attachments/ 下的纯文件名）；失败返回 null（调用方保持内联，行为不降级）。
 * screenshot 传原始 base64，落盘解码为二进制 png（省去 4/3 的 base64 膨胀）；mcpapp 传 JSON 字符串。
 */
export function saveConversationAttachment(
  conversationId: string,
  messageId: string,
  kind: AttachmentKind,
  content: string
): string | null {
  if (!isSafeConversationStorageId(conversationId) || !messageId || !content) return null
  if (kind !== 'screenshot' && kind !== 'mcpapp') return null
  let fd: number | undefined
  try {
    const dir = resolveAttachmentsDir(conversationId, true)
    if (!dir) return null
    const safeId = messageId
      .replace(/[^\w.-]+/g, '_')
      .replace(/^\.+/, '_')
      .slice(0, 160) || 'message'
    const ref = kind === 'screenshot' ? `${safeId}.png` : `${safeId}.mcpapp.json`
    const full = resolveAttachmentLeaf(dir, ref, false)
    if (!full) return null
    try {
      const existing = fs.lstatSync(full)
      if (!existing.isFile() || existing.isSymbolicLink()) return null
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') return null
    }
    fd = fs.openSync(
      full,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC | NO_FOLLOW,
      0o600
    )
    if (!fs.fstatSync(fd).isFile()) return null
    fs.fchmodSync(fd, 0o600)
    if (kind === 'screenshot') fs.writeFileSync(fd, Buffer.from(content, 'base64'))
    else fs.writeFileSync(fd, content, 'utf8')
    return ref
  } catch (err) {
    console.warn('[attachment-store] 附件卸载失败:', err)
    return null
  } finally {
    if (fd !== undefined) fs.closeSync(fd)
  }
}

/** 按 ref 读回附件：png 返回 base64（供 data URL），json 返回原文。ref 只接受纯文件名（防目录穿越）。 */
export function loadConversationAttachment(conversationId: string, ref: string): string | null {
  if (!isSafeConversationStorageId(conversationId) || !ref) return null
  let fd: number | undefined
  try {
    const dir = resolveAttachmentsDir(conversationId, false)
    if (!dir) return null
    const full = resolveAttachmentLeaf(dir, ref, true)
    if (!full) return null
    fd = fs.openSync(full, fs.constants.O_RDONLY | NO_FOLLOW)
    if (!fs.fstatSync(fd).isFile()) return null
    return ref.endsWith('.png') ? fs.readFileSync(fd).toString('base64') : fs.readFileSync(fd, 'utf8')
  } catch {
    return null
  } finally {
    if (fd !== undefined) fs.closeSync(fd)
  }
}
